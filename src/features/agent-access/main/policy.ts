// Whether agent access is on: the person's preference, unless a machine policy file decides.
import { readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export type PolicyDecision = 'enabled' | 'disabled'

export interface AgentAccessState {
  enabled: boolean
  /** Set when a policy file decides (the Preferences switch is then read-only). */
  policy: PolicyDecision | null
}

/** Where an administrator puts the machine policy file. */
export function machinePolicyFile(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'win32')
    return win32.join(env.ProgramData || 'C:\\ProgramData', 'Fartcrobat', 'policy.json')
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

/**
 * The policy that applies. The machine file comes first so that a person cannot override their
 * administrator with FARTCROBAT_POLICY_FILE, which only exists for tests.
 */
export function currentPolicy(
  machineFile: string,
  env: NodeJS.ProcessEnv = process.env
): PolicyDecision | null {
  const machine = readPolicy(machineFile)
  if (machine) return machine
  return env.FARTCROBAT_POLICY_FILE ? readPolicy(env.FARTCROBAT_POLICY_FILE) : null
}

export function agentAccessState(
  preference: boolean | undefined,
  policy: PolicyDecision | null
): AgentAccessState {
  return { enabled: policy ? policy === 'enabled' : preference !== false, policy }
}
