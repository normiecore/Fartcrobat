import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeMac, isNonce, verifyMac } from './auth'
import { launchInfo } from './endpoint'
import { WINDOWS_POLICY_VALUES, parseRegQuery, readMachinePolicy, windowsPolicy, type RunFile } from '@main/policy'
import { agentAccessState, currentPolicy, machinePolicy, machinePolicyFile, readPolicy } from './policy'

describe('agent access policy', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fc-agent-policy-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const policy = (name: string, content: string) => {
    const file = join(dir, name)
    writeFileSync(file, content)
    return file
  }

  it('reads the machine policy file', () => {
    expect(readPolicy(join(dir, 'missing.json'))).toBeNull()
    expect(readPolicy(policy('on.json', '{"agentAccess":{"enabled":true}}'))).toBe('enabled')
    expect(readPolicy(policy('off.json', '\uFEFF{"agentAccess":{"enabled":false}}'))).toBe('disabled')
    expect(readPolicy(policy('other.json', '{"somethingElse":1}'))).toBeNull()
    // An administrator's mistake turns agent access off rather than on.
    expect(readPolicy(policy('broken.json', '{"agentAccess":'))).toBe('disabled')
    expect(readPolicy(policy('string.json', '{"agentAccess":{"enabled":"yes"}}'))).toBe('disabled')
  })

  it('lets a policy file beat the preference', () => {
    expect(agentAccessState(true, null)).toEqual({ enabled: true, policy: null })
    expect(agentAccessState(undefined, null)).toEqual({ enabled: true, policy: null })
    expect(agentAccessState(false, null)).toEqual({ enabled: false, policy: null })
    expect(agentAccessState(true, 'disabled')).toEqual({ enabled: false, policy: 'disabled' })
    expect(agentAccessState(false, 'enabled')).toEqual({ enabled: true, policy: 'enabled' })
  })

  it('prefers the machine policy to the file FARTCROBAT_POLICY_FILE names', async () => {
    const on = policy('on.json', '{"agentAccess":{"enabled":true}}')
    const off = policy('off.json', '{"agentAccess":{"enabled":false}}')
    const missing = join(dir, 'missing.json')
    const machine = (file: string) => machinePolicy('linux', {}, file)
    expect(currentPolicy(await machine(missing), {})).toBeNull()
    expect(currentPolicy(await machine(missing), { FARTCROBAT_POLICY_FILE: off })).toBe('disabled')
    expect(currentPolicy(await machine(off), { FARTCROBAT_POLICY_FILE: on })).toBe('disabled')
    expect(currentPolicy(await machine(on), { FARTCROBAT_POLICY_FILE: off })).toBe('enabled')
  })

  it('reads each section on its own (agent access and remembered passwords share the policy)', async () => {
    const both = policy('both.json', '{"agentAccess":{"enabled":true},"rememberPasswords":{"enabled":false}}')
    expect(readPolicy(both)).toBe('enabled')
    expect(readPolicy(both, 'rememberPasswords')).toBe('disabled')
    const agentOnly = policy('agent.json', '{"agentAccess":{"enabled":false}}')
    expect(readPolicy(agentOnly, 'rememberPasswords')).toBeNull()
    expect(readPolicy(policy('broken.json', '{'), 'rememberPasswords')).toBe('disabled')
    // Sections fall back to FARTCROBAT_POLICY_FILE one by one.
    expect(await readMachinePolicy({ file: agentOnly, env: { FARTCROBAT_POLICY_FILE: both } })).toEqual({
      agentAccess: 'disabled',
      rememberPasswords: 'disabled',
      autoUpdate: null
    })
    expect(await readMachinePolicy({ file: join(dir, 'missing.json'), env: {} })).toEqual({
      agentAccess: null,
      rememberPasswords: null,
      autoUpdate: null
    })
  })

  it('keeps a broken policy file apart from an explicit "enabled": false', async () => {
    // A typo in a file about agent access only: every section fails closed, but readMachinePolicy
    // says 'invalid', so remembering is turned off without wiping saved passwords.
    const typo = policy('typo.json', '{"agentAccess":{"enabled":false},}')
    expect(readPolicy(typo)).toBe('disabled')
    expect(readPolicy(typo, 'rememberPasswords')).toBe('disabled')
    expect(await readMachinePolicy({ file: typo, env: {} })).toEqual({
      agentAccess: 'invalid',
      rememberPasswords: 'invalid',
      autoUpdate: 'invalid'
    })
    const notBoolean = policy('no.json', '{"rememberPasswords":{"enabled":"no"}}')
    expect(readPolicy(notBoolean, 'rememberPasswords')).toBe('disabled')
    expect(await readMachinePolicy({ file: notBoolean, env: {} })).toEqual({
      agentAccess: null,
      rememberPasswords: 'invalid',
      autoUpdate: null
    })
    // A file that exists but cannot be read (here a folder: EISDIR).
    expect(currentPolicy(await machinePolicy('linux', {}, dir), {})).toBe('disabled')
    expect(await readMachinePolicy({ file: dir, env: {} })).toEqual({
      agentAccess: 'invalid',
      rememberPasswords: 'invalid',
      autoUpdate: 'invalid'
    })
    // Only an explicit false reads as 'disabled'.
    const off = policy('off.json', '\uFEFF{"rememberPasswords":{"enabled":false}}')
    expect((await readMachinePolicy({ file: off, env: {} })).rememberPasswords).toBe('disabled')
    // A broken machine file still beats FARTCROBAT_POLICY_FILE; a broken test file is invalid too.
    const on = policy('on.json', '{"rememberPasswords":{"enabled":true}}')
    expect((await readMachinePolicy({ file: typo, env: { FARTCROBAT_POLICY_FILE: on } })).rememberPasswords).toBe('invalid')
    expect(
      (await readMachinePolicy({ file: join(dir, 'missing.json'), env: { FARTCROBAT_POLICY_FILE: typo } })).rememberPasswords
    ).toBe('invalid')
  })

  it('knows where macOS and Linux keep the machine policy file, and that Windows has none', () => {
    expect(machinePolicyFile('darwin')).toBe('/Library/Application Support/Fartcrobat/policy.json')
    expect(machinePolicyFile('linux')).toBe('/etc/fartcrobat/policy.json')
    // A file under ProgramData could be planted by any user, or redirected with %ProgramData%.
    expect(machinePolicyFile('win32')).toBeNull()
  })

  it('reads the Windows policy from HKLM with reg.exe', async () => {
    const calls: { file: string; args: string[] }[] = []
    const reg =
      (err: (Error & { code?: unknown }) | null, stdout = ''): RunFile =>
      (file, args, done) => {
        calls.push({ file, args })
        done(err, stdout)
      }
    const out = (...values: string[]) =>
      `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Fartcrobat\r\n${values.map((v) => `    ${v}\r\n`).join('')}\r\n`
    expect(await windowsPolicy({ SystemRoot: 'D:\\Win' }, reg(null, out('AgentAccess    REG_DWORD    0x1')))).toEqual({
      agentAccess: 'enabled',
      rememberPasswords: null,
      autoUpdate: null
    })
    expect(calls[0]).toEqual({ file: 'D:\\Win\\System32\\reg.exe', args: ['query', 'HKLM\\SOFTWARE\\Policies\\Fartcrobat'] })
    expect(
      await windowsPolicy({}, reg(null, out('AgentAccess    REG_DWORD    0x0', 'RememberPasswords    REG_DWORD    0x0')))
    ).toEqual({ agentAccess: 'disabled', rememberPasswords: 'disabled', autoUpdate: null })
    expect(calls[1].file).toBe('C:\\Windows\\System32\\reg.exe')
    // Not set: the preference decides.
    expect(await windowsPolicy({}, reg(Object.assign(new Error('not found'), { code: 1 })))).toEqual({
      agentAccess: null,
      rememberPasswords: null,
      autoUpdate: null
    })
    expect(await windowsPolicy({}, reg(Object.assign(new Error('spawn'), { code: 'ENOENT' })))).toEqual({
      agentAccess: null,
      rememberPasswords: null,
      autoUpdate: null
    })
    // Set to something it cannot read, or the query failed otherwise: invalid, which turns the
    // setting off without wiping saved passwords.
    expect(await windowsPolicy({}, reg(null, out('RememberPasswords    REG_SZ    yes')))).toEqual({
      agentAccess: null,
      rememberPasswords: 'invalid',
      autoUpdate: null
    })
    expect(await windowsPolicy({}, reg(Object.assign(new Error('timed out'), { code: null })))).toEqual({
      agentAccess: 'invalid',
      rememberPasswords: 'invalid',
      autoUpdate: 'invalid'
    })
    expect(parseRegQuery('    agentaccess    REG_DWORD    0x00000001', 'agentAccess')).toBe('enabled')
    expect(parseRegQuery('    RememberPasswords    REG_DWORD    0x2', 'rememberPasswords')).toBe('invalid')
    expect(parseRegQuery('    RememberPasswordsX    REG_DWORD    0x1', 'rememberPasswords')).toBeNull()
    expect(parseRegQuery('', 'agentAccess')).toBeNull()
  })

  it('reads the update policy (autoUpdate) like the other sections', async () => {
    const off = policy('updates-off.json', '{"autoUpdate":{"enabled":false}}')
    const on = policy('updates-on.json', '{"autoUpdate":{"enabled":true}}')
    expect(readPolicy(off, 'autoUpdate')).toBe('disabled')
    expect(readPolicy(on, 'autoUpdate')).toBe('enabled')
    // The other settings are not affected.
    expect(readPolicy(off)).toBeNull()
    expect(readPolicy(off, 'rememberPasswords')).toBeNull()
    expect(readPolicy(policy('agent.json', '{"agentAccess":{"enabled":false}}'), 'autoUpdate')).toBeNull()
    // Mistakes turn checking off (no checks at all, manual ones included).
    expect(readPolicy(policy('bad.json', '{"autoUpdate":true}'), 'autoUpdate')).toBe('disabled')
    expect((await readMachinePolicy({ file: policy('bad2.json', '{"autoUpdate":{"enabled":1}}'), env: {} })).autoUpdate).toBe('invalid')
    // FARTCROBAT_POLICY_FILE only fills in what the machine leaves unset.
    expect((await readMachinePolicy({ file: join(dir, 'missing.json'), env: { FARTCROBAT_POLICY_FILE: off } })).autoUpdate).toBe('disabled')
    expect((await readMachinePolicy({ file: on, env: { FARTCROBAT_POLICY_FILE: off } })).autoUpdate).toBe('enabled')
    // Windows: the REG_DWORD AutoUpdate under HKLM\SOFTWARE\Policies\Fartcrobat.
    expect(WINDOWS_POLICY_VALUES.autoUpdate).toBe('AutoUpdate')
    expect(parseRegQuery('    AutoUpdate    REG_DWORD    0x0', 'autoUpdate')).toBe('disabled')
    expect(parseRegQuery('    AutoUpdate    REG_DWORD    0x1', 'autoUpdate')).toBe('enabled')
    expect(parseRegQuery('    AutoUpdate    REG_SZ    1', 'autoUpdate')).toBe('invalid')
    const reg: RunFile = (_file, _args, done) => done(null, '\r\n    AgentAccess    REG_DWORD    0x1\r\n    AutoUpdate    REG_DWORD    0x0\r\n')
    expect(await windowsPolicy({}, reg)).toEqual({ agentAccess: 'enabled', rememberPasswords: null, autoUpdate: 'disabled' })
  })
})

describe('agent handshake helpers', () => {
  const token = 'ab'.repeat(32)
  const nonce = 'cd'.repeat(32)

  it('MACs the role and nonce with the token as written in endpoint.json', () => {
    const expected = createHmac('sha256', token).update(`server:${nonce}`).digest('hex')
    expect(computeMac(token, 'server', nonce)).toBe(expected)
    expect(verifyMac(token, 'server', nonce, expected)).toBe(true)
    expect(verifyMac(token, 'server', nonce, expected.toUpperCase())).toBe(true)
    expect(verifyMac(token, 'client', nonce, expected)).toBe(false)
    expect(verifyMac('ef'.repeat(32), 'server', nonce, expected)).toBe(false)
    expect(verifyMac(token, 'server', nonce, expected.slice(2))).toBe(false)
    expect(verifyMac(token, 'server', nonce, 123)).toBe(false)
  })

  it('accepts 32-byte hex nonces only', () => {
    expect(isNonce(nonce)).toBe(true)
    expect(isNonce(nonce.slice(1))).toBe(false)
    expect(isNonce('zz'.repeat(32))).toBe(false)
  })

  it('starts an AppImage again from its file, not from its temporary mount', () => {
    const mount = '/tmp/.mount_FartcrAb12'
    const own = { APPIMAGE: '/home/me/Apps/Fartcrobat.AppImage', APPDIR: mount }
    expect(
      launchInfo(`${mount}/fartcrobat`, true, `${mount}/resources/app.asar`, '1.2.3', own).executable
    ).toBe('/home/me/Apps/Fartcrobat.AppImage')
    expect(
      launchInfo(`${mount}/fartcrobat`, true, '', '1.2.3', { ...own, APPDIR: `${mount}/` }).executable
    ).toBe('/home/me/Apps/Fartcrobat.AppImage')
    // Inherited from an AppImage that started this copy (an AI app): not this app's file.
    const inherited = { APPIMAGE: '/home/me/Claude.AppImage', APPDIR: '/tmp/.mount_ClaudeX' }
    expect(launchInfo('/opt/Fartcrobat/fartcrobat', true, '', '1.2.3', inherited).executable).toBe(
      '/opt/Fartcrobat/fartcrobat'
    )
    expect(
      launchInfo('/repo/node_modules/electron/dist/electron', false, '/repo', '1.2.3', own).executable
    ).toBe('/repo/node_modules/electron/dist/electron')
  })

  it('tells the shim how to start the app', () => {
    expect(
      launchInfo('/opt/Fartcrobat/fartcrobat', true, '/opt/Fartcrobat/resources/app.asar', '1.2.3', {})
    ).toEqual({
      executable: '/opt/Fartcrobat/fartcrobat',
      args: [],
      appVersion: '1.2.3'
    })
    expect(launchInfo('/repo/node_modules/electron/dist/electron', false, '/repo', '1.2.3', {})).toEqual({
      executable: '/repo/node_modules/electron/dist/electron',
      args: ['/repo'],
      appVersion: '1.2.3'
    })
  })
})
