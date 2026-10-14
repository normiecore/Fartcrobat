import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeMac, isNonce, verifyMac } from './auth'
import { launchInfo } from './endpoint'
import {
  agentAccessState,
  currentPolicy,
  machinePolicy,
  machinePolicyFile,
  parseRegQuery,
  readPolicy,
  windowsPolicy,
  type RunFile
} from './policy'

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
    const out = (type: string, value: string) =>
      `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Fartcrobat\r\n    AgentAccess    ${type}    ${value}\r\n\r\n`
    expect(await windowsPolicy({ SystemRoot: 'D:\\Win' }, reg(null, out('REG_DWORD', '0x1')))).toBe('enabled')
    expect(calls[0]).toEqual({
      file: 'D:\\Win\\System32\\reg.exe',
      args: ['query', 'HKLM\\SOFTWARE\\Policies\\Fartcrobat', '/v', 'AgentAccess']
    })
    expect(await windowsPolicy({}, reg(null, out('REG_DWORD', '0x0')))).toBe('disabled')
    expect(calls[1].file).toBe('C:\\Windows\\System32\\reg.exe')
    // Not set: the preference decides.
    expect(await windowsPolicy({}, reg(Object.assign(new Error('not found'), { code: 1 })))).toBeNull()
    expect(await windowsPolicy({}, reg(Object.assign(new Error('spawn'), { code: 'ENOENT' })))).toBeNull()
    // Set to something it cannot read, or the query failed otherwise: off.
    expect(await windowsPolicy({}, reg(null, out('REG_SZ', 'yes')))).toBe('disabled')
    expect(await windowsPolicy({}, reg(Object.assign(new Error('timed out'), { code: null })))).toBe(
      'disabled'
    )
    expect(parseRegQuery('    agentaccess    REG_DWORD    0x00000001')).toBe('enabled')
    expect(parseRegQuery('')).toBe('disabled')
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
