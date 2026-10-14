// The machine policy file: settings an administrator decides for everyone on this computer.
import { readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'

export type PolicyDecision = 'enabled' | 'disabled'

/**
 * What the file says about a section before failing closed. 'invalid': the file exists but cannot
 * be read or parsed, or the section is not `{ "enabled": true | false }`.
 */
export type PolicyReading = PolicyDecision | 'invalid'

/** The settings a policy file can decide, each `{ "enabled": true | false }`. */
export type PolicySection = 'agentAccess' | 'rememberPasswords'

/** Raw readings: 'invalid' keeps a broken file apart from an explicit `"enabled": false`. */
export type MachinePolicy = Record<PolicySection, PolicyReading | null>

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

/** Reads one section. Null when there is no file or it says nothing about that section. */
function readSection(file: string, section: PolicySection): PolicyReading | null {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ENOENT' || code === 'ENOTDIR' ? null : 'invalid'
  }
  let policy: unknown
  try {
    policy = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return 'invalid'
  }
  if (!policy || typeof policy !== 'object' || !(section in policy)) return null
  const value = (policy as Record<string, unknown>)[section]
  const enabled = value && typeof value === 'object' ? (value as { enabled?: unknown }).enabled : undefined
  return enabled === true ? 'enabled' : enabled === false ? 'disabled' : 'invalid'
}

/** An administrator's typo must not switch anything on. */
const failClosed = (r: PolicyReading | null): PolicyDecision | null => (r === 'invalid' ? 'disabled' : r)

/**
 * Reads `{ "<section>": { "enabled": true | false } }`. Null when there is no file or it says
 * nothing about that section. A file that exists but cannot be read or understood turns the
 * section off: an administrator's typo must not switch anything on.
 */
export function readPolicy(file: string, section: PolicySection = 'agentAccess'): PolicyDecision | null {
  return failClosed(readSection(file, section))
}

/**
 * The machine file comes first so that a person cannot override their administrator with
 * FARTCROBAT_POLICY_FILE, which only exists for tests.
 */
function currentReading(machineFile: string, env: NodeJS.ProcessEnv, section: PolicySection): PolicyReading | null {
  const machine = readSection(machineFile, section)
  if (machine) return machine
  return env.FARTCROBAT_POLICY_FILE ? readSection(env.FARTCROBAT_POLICY_FILE, section) : null
}

/** The policy that applies to `section`, failing closed (see `readPolicy`). */
export function currentPolicy(
  machineFile: string,
  env: NodeJS.ProcessEnv = process.env,
  section: PolicySection = 'agentAccess'
): PolicyDecision | null {
  return failClosed(currentReading(machineFile, env, section))
}

/**
 * What the policy that applies on this computer says about each section, without failing closed:
 * callers treat 'invalid' as off, but only an explicit 'disabled' may do anything that cannot be
 * undone (such as wiping saved passwords).
 */
export function readMachinePolicy(
  opts: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; file?: string } = {}
): MachinePolicy {
  const env = opts.env ?? process.env
  const file = opts.file ?? machinePolicyFile(opts.platform, env)
  return {
    agentAccess: currentReading(file, env, 'agentAccess'),
    rememberPasswords: currentReading(file, env, 'rememberPasswords')
  }
}
