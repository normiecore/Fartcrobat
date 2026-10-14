// Whether agent access is on: the person's preference, unless a machine policy decides.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export type PolicyDecision = 'enabled' | 'disabled'

export interface AgentAccessState {
  enabled: boolean
  /** Set when a machine policy decides (the Preferences switch is then read-only). */
  policy: PolicyDecision | null
}

/**
 * Where an administrator puts the machine policy file on macOS and Linux, folders only an
 * administrator can write. Null on Windows, which uses the registry (see windowsPolicy): any user
 * may create folders in ProgramData, and %ProgramData% can be redirected per account.
 */
export function machinePolicyFile(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === 'win32') return null
  if (platform === 'darwin') return '/Library/Application Support/Fartcrobat/policy.json'
  return posix.join('/etc', 'fartcrobat', 'policy.json')
}

/**
 * Reads `{ "agentAccess": { "enabled": true | false } }`. Null when there is no file or it says
 * nothing about agent access. A file that exists but cannot be read or understood turns agent
 * access off: an administrator's typo must not switch it on.
 */
export function readPolicy(file: string): PolicyDecision | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : 'disabled'
  }
  let policy: unknown
  try {
    policy = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return 'disabled'
  }
  if (!policy || typeof policy !== 'object' || !('agentAccess' in policy)) return null
  const section = (policy as { agentAccess: unknown }).agentAccess
  const enabled =
    section && typeof section === 'object' ? (section as { enabled?: unknown }).enabled : undefined
  return enabled === true ? 'enabled' : 'disabled'
}

/** The Windows policy: a REG_DWORD named AgentAccess, 1 for on and anything else for off. */
export const WINDOWS_POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Fartcrobat'
export const WINDOWS_POLICY_VALUE = 'AgentAccess'

/** What `reg query <key> /v AgentAccess` printed, as a decision. */
export function parseRegQuery(stdout: string): PolicyDecision {
  const m = /^\s*AgentAccess\s+REG_DWORD\s+0x([0-9a-f]+)\s*$/im.exec(stdout)
  return m && parseInt(m[1], 16) === 1 ? 'enabled' : 'disabled'
}

export type RunFile = (
  file: string,
  args: string[],
  done: (err: (Error & { code?: unknown }) | null, stdout: string) => void
) => void

const runFile: RunFile = (file, args, done) =>
  void execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => done(err, String(stdout)))

/**
 * Reads the policy from HKLM, which only administrators (and Group Policy or Intune) can write.
 * Null when it is not set, or reg.exe cannot be started. Anything else that goes wrong turns agent
 * access off, as an unreadable policy file does.
 */
export function windowsPolicy(
  env: NodeJS.ProcessEnv = process.env,
  run: RunFile = runFile
): Promise<PolicyDecision | null> {
  const reg = win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
  return new Promise((resolve) => {
    run(reg, ['query', WINDOWS_POLICY_KEY, '/v', WINDOWS_POLICY_VALUE], (err, stdout) => {
      if (!err) return resolve(parseRegQuery(stdout))
      // reg.exe exits with 1 when the key or the value does not exist.
      if (err.code === 1 || err.code === 'ENOENT') return resolve(null)
      resolve('disabled')
    })
  })
}

/** The machine's policy: the registry on Windows, else the policy file (`file` replaces it in tests). */
export async function machinePolicy(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  file?: string
): Promise<PolicyDecision | null> {
  if (file !== undefined) return readPolicy(file)
  const machineFile = machinePolicyFile(platform)
  return machineFile ? readPolicy(machineFile) : windowsPolicy(env)
}

/**
 * The policy that applies. The machine's comes first: FARTCROBAT_POLICY_FILE only exists for tests
 * and never overrides what an administrator set.
 */
export function currentPolicy(
  machine: PolicyDecision | null,
  env: NodeJS.ProcessEnv = process.env
): PolicyDecision | null {
  if (machine) return machine
  return env.FARTCROBAT_POLICY_FILE ? readPolicy(env.FARTCROBAT_POLICY_FILE) : null
}

export function agentAccessState(
  preference: boolean | undefined,
  policy: PolicyDecision | null
): AgentAccessState {
  return { enabled: policy ? policy === 'enabled' : preference !== false, policy }
}
