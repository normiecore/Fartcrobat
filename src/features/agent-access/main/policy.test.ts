import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeMac, isNonce, verifyMac } from './auth'
import { launchInfo } from './endpoint'
import { readMachinePolicy } from '@main/policy'
import { agentAccessState, currentPolicy, machinePolicyFile, readPolicy } from './policy'

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

  it('prefers the machine file to the one FARTCROBAT_POLICY_FILE names', () => {
    const on = policy('on.json', '{"agentAccess":{"enabled":true}}')
    const off = policy('off.json', '{"agentAccess":{"enabled":false}}')
    const missing = join(dir, 'missing.json')
    expect(currentPolicy(missing, {})).toBeNull()
    expect(currentPolicy(missing, { FARTCROBAT_POLICY_FILE: off })).toBe('disabled')
    expect(currentPolicy(off, { FARTCROBAT_POLICY_FILE: on })).toBe('disabled')
    expect(currentPolicy(on, { FARTCROBAT_POLICY_FILE: off })).toBe('enabled')
  })

  it('reads each section on its own (agent access and remembered passwords share the file)', () => {
    const both = policy('both.json', '{"agentAccess":{"enabled":true},"rememberPasswords":{"enabled":false}}')
    expect(readPolicy(both)).toBe('enabled')
    expect(readPolicy(both, 'rememberPasswords')).toBe('disabled')
    const agentOnly = policy('agent.json', '{"agentAccess":{"enabled":false}}')
    expect(readPolicy(agentOnly, 'rememberPasswords')).toBeNull()
    expect(readPolicy(policy('broken.json', '{'), 'rememberPasswords')).toBe('disabled')
    // Sections fall back to FARTCROBAT_POLICY_FILE one by one.
    expect(readMachinePolicy({ file: agentOnly, env: { FARTCROBAT_POLICY_FILE: both } })).toEqual({
      agentAccess: 'disabled',
      rememberPasswords: 'disabled'
    })
    expect(readMachinePolicy({ file: join(dir, 'missing.json'), env: {} })).toEqual({ agentAccess: null, rememberPasswords: null })
  })

  it('keeps a broken policy file apart from an explicit "enabled": false', () => {
    // A typo in a file about agent access only: every section fails closed, but readMachinePolicy
    // says 'invalid', so remembering is turned off without wiping saved passwords.
    const typo = policy('typo.json', '{"agentAccess":{"enabled":false},}')
    expect(readPolicy(typo)).toBe('disabled')
    expect(readPolicy(typo, 'rememberPasswords')).toBe('disabled')
    expect(currentPolicy(typo, {}, 'rememberPasswords')).toBe('disabled')
    expect(readMachinePolicy({ file: typo, env: {} })).toEqual({ agentAccess: 'invalid', rememberPasswords: 'invalid' })
    const notBoolean = policy('no.json', '{"rememberPasswords":{"enabled":"no"}}')
    expect(readPolicy(notBoolean, 'rememberPasswords')).toBe('disabled')
    expect(readMachinePolicy({ file: notBoolean, env: {} })).toEqual({ agentAccess: null, rememberPasswords: 'invalid' })
    // A file that exists but cannot be read (here a folder: EISDIR).
    expect(currentPolicy(dir, {})).toBe('disabled')
    expect(readMachinePolicy({ file: dir, env: {} })).toEqual({ agentAccess: 'invalid', rememberPasswords: 'invalid' })
    // Only an explicit false reads as 'disabled'.
    const off = policy('off.json', '\uFEFF{"rememberPasswords":{"enabled":false}}')
    expect(readMachinePolicy({ file: off, env: {} }).rememberPasswords).toBe('disabled')
    // A broken machine file still beats FARTCROBAT_POLICY_FILE; a broken test file is invalid too.
    const on = policy('on.json', '{"rememberPasswords":{"enabled":true}}')
    expect(readMachinePolicy({ file: typo, env: { FARTCROBAT_POLICY_FILE: on } }).rememberPasswords).toBe('invalid')
    expect(readMachinePolicy({ file: join(dir, 'missing.json'), env: { FARTCROBAT_POLICY_FILE: typo } }).rememberPasswords).toBe('invalid')
  })

  it('knows where each system keeps the machine policy', () => {
    expect(machinePolicyFile('win32', { ProgramData: 'D:\\ProgramData' })).toBe(
      'D:\\ProgramData\\Fartcrobat\\policy.json'
    )
    expect(machinePolicyFile('win32', {})).toBe('C:\\ProgramData\\Fartcrobat\\policy.json')
    expect(machinePolicyFile('darwin', {})).toBe('/Library/Application Support/Fartcrobat/policy.json')
    expect(machinePolicyFile('linux', {})).toBe('/etc/fartcrobat/policy.json')
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

  it('tells the shim how to start the app', () => {
    expect(
      launchInfo('/opt/Fartcrobat/fartcrobat', true, '/opt/Fartcrobat/resources/app.asar', '1.2.3')
    ).toEqual({
      executable: '/opt/Fartcrobat/fartcrobat',
      args: [],
      appVersion: '1.2.3'
    })
    expect(launchInfo('/repo/node_modules/electron/dist/electron', false, '/repo', '1.2.3')).toEqual({
      executable: '/repo/node_modules/electron/dist/electron',
      args: ['/repo'],
      appVersion: '1.2.3'
    })
  })
})
