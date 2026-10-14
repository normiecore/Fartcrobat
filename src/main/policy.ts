// The machine policy file: settings an administrator decides for everyone on this computer.
import { readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export type PolicyDecision = 'enabled' | 'disabled'

/** The settings a policy file can decide, each `{ "enabled": true | false }`. */
export type PolicySection = 'agentAccess' | 'rememberPasswords'

export type MachinePolicy = Record<PolicySection, PolicyDecision | null>

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
 * Reads `{ "<section>": { "enabled": true | false } }`. Null when there is no file or it says
 * nothing about that section. A file that exists but cannot be read or understood turns the
 * section off: an administrator's typo must not switch anything on.
 */
export function readPolicy(file: string, section: PolicySection = 'agentAccess'): PolicyDecision | null {
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
  if (!policy || typeof policy !== 'object' || !(section in policy)) return null
  const value = (policy as Record<string, unknown>)[section]
  const enabled = value && typeof value === 'object' ? (value as { enabled?: unknown }).enabled : undefined
  return enabled === true ? 'enabled' : 'disabled'
}

/**
 * The policy that applies to `section`. The machine file comes first so that a person cannot
 * override their administrator with FARTCROBAT_POLICY_FILE, which only exists for tests.
 */
export function currentPolicy(
  machineFile: string,
  env: NodeJS.ProcessEnv = process.env,
  section: PolicySection = 'agentAccess'
): PolicyDecision | null {
  const machine = readPolicy(machineFile, section)
  if (machine) return machine
  return env.FARTCROBAT_POLICY_FILE ? readPolicy(env.FARTCROBAT_POLICY_FILE, section) : null
}

/** Every section of the policy that applies on this computer. */
export function readMachinePolicy(
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; file?: string } = {}
): MachinePolicy {
  const env = opts.env ?? process.env
  const file = opts.file ?? machinePolicyFile(opts.platform, env)
  return {
    agentAccess: currentPolicy(file, env, 'agentAccess'),
    rememberPasswords: currentPolicy(file, env, 'rememberPasswords')
  }
}
