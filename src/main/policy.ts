// The machine policy: settings an administrator decides for everyone on this computer. Windows keeps
// it in the registry, macOS and Linux in a file only an administrator can write.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { NAMES, productNames, type Names } from '@shared/identity'
import { regExe } from '@shared/winSystem'

export type PolicyDecision = 'enabled' | 'disabled'

/**
 * What the policy says about a setting before failing closed. 'invalid': the policy exists but
 * cannot be read or understood (a broken file, a section that is not `{ "enabled": true | false }`,
 * a registry value that is not a REG_DWORD 0 or 1).
 */
export type PolicyReading = PolicyDecision | 'invalid'

/**
 * The settings a policy can decide. 'autoUpdate': checking GitHub for new releases (off: no checks
 * at all, manual ones included; on: automatic checks whatever the preference says).
 */
export type PolicySection = 'agentAccess' | 'rememberPasswords' | 'autoUpdate'

export const POLICY_SECTIONS: readonly PolicySection[] = ['agentAccess', 'rememberPasswords', 'autoUpdate']

/** Raw readings: 'invalid' keeps a broken policy apart from an explicit off. */
export type MachinePolicy = Record<PolicySection, PolicyReading | null>

/** A reading for every section, from `read(section)`. */
const bySection = (read: (section: PolicySection) => PolicyReading | null): MachinePolicy =>
  Object.fromEntries(POLICY_SECTIONS.map((section) => [section, read(section)])) as MachinePolicy

const allOf = (reading: PolicyReading | null): MachinePolicy => bySection(() => reading)

/** The policy file for one product name (see machinePolicyFiles). */
function policyFileFor(name: string, platform: NodeJS.Platform): string {
  if (platform === 'darwin') return posix.join('/Library/Application Support', name, 'policy.json')
  return posix.join('/etc', name.toLowerCase(), 'policy.json')
}

/**
 * Where an administrator puts the machine policy file on macOS and Linux, folders only an
 * administrator can write: the location under the current name first, then the one from before a
 * rename (src/shared/identity.ts), which is still read so deployed policies keep applying. Empty
 * on Windows, which uses the registry (see windowsPolicy): any user may create folders in
 * ProgramData, and %ProgramData% can be redirected per account.
 */
export function machinePolicyFiles(platform: NodeJS.Platform = process.platform, names: Names = NAMES): string[] {
  if (platform === 'win32') return []
  return [...new Set(productNames(names).map((name) => policyFileFor(name, platform)))]
}

/** The policy file under the current name (the one to document), or null on Windows. */
export function machinePolicyFile(platform: NodeJS.Platform = process.platform): string | null {
  return machinePolicyFiles(platform)[0] ?? null
}

/**
 * Policies from several locations, most important first: for each setting the first location that
 * says anything about it decides (an unreadable one included, which fails closed).
 */
export function firstSaying(readings: MachinePolicy[]): MachinePolicy {
  return bySection((section) => readings.map((r) => r[section]).find((r) => r !== null) ?? null)
}

/**
 * Reads `{ "<section>": { "enabled": true | false } }` from a policy file, each section on its own.
 * Null for a section when there is no file or it says nothing about that section.
 */
export function readPolicyFile(file: string): MachinePolicy {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    return allOf(code === 'ENOENT' || code === 'ENOTDIR' ? null : 'invalid')
  }
  let policy: unknown
  try {
    policy = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return allOf('invalid')
  }
  const section = (name: PolicySection): PolicyReading | null => {
    if (!policy || typeof policy !== 'object' || !(name in policy)) return null
    const value = (policy as Record<string, unknown>)[name]
    const enabled = value && typeof value === 'object' ? (value as { enabled?: unknown }).enabled : undefined
    return enabled === true ? 'enabled' : enabled === false ? 'disabled' : 'invalid'
  }
  return bySection(section)
}

/** An administrator's typo must not switch anything on. */
export const failClosed = (r: PolicyReading | null): PolicyDecision | null => (r === 'invalid' ? 'disabled' : r)

/**
 * One section of a policy file, failing closed: null when there is no file or it says nothing about
 * that section; a file that exists but cannot be read or understood turns the section off.
 */
export function readPolicy(file: string, section: PolicySection = 'agentAccess'): PolicyDecision | null {
  return failClosed(readPolicyFile(file)[section])
}

// ---- Windows ------------------------------------------------------------------------------

/** The registry key for one product name. */
export const windowsPolicyKey = (name: string): string => `HKLM\\SOFTWARE\\Policies\\${name}`

/** Written by Group Policy or Intune; only administrators can change it. */
export const WINDOWS_POLICY_KEY = windowsPolicyKey(NAMES.current)

/** The key under the current name, then the one from before a rename (still read). */
export const windowsPolicyKeys = (names: Names = NAMES): string[] => productNames(names).map(windowsPolicyKey)

/** A REG_DWORD per setting: 1 is on, 0 is off. */
export const WINDOWS_POLICY_VALUES: Record<PolicySection, string> = {
  agentAccess: 'AgentAccess',
  rememberPasswords: 'RememberPasswords',
  autoUpdate: 'AutoUpdate'
}

/** What `reg query <key>` printed about one setting. Null when the value is not there. */
export function parseRegQuery(stdout: string, section: PolicySection): PolicyReading | null {
  const name = WINDOWS_POLICY_VALUES[section]
  const m = new RegExp(`^\\s*${name}\\s+(REG_\\w+)\\s+(.*?)\\s*$`, 'im').exec(stdout)
  if (!m) return null
  const value = m[1].toUpperCase() === 'REG_DWORD' ? /^0x([0-9a-f]+)$/i.exec(m[2]) : null
  if (!value) return 'invalid'
  const n = parseInt(value[1], 16)
  return n === 1 ? 'enabled' : n === 0 ? 'disabled' : 'invalid'
}

export type RunFile = (
  file: string,
  args: string[],
  done: (err: (Error & { code?: unknown }) | null, stdout: string) => void
) => void

const runFile: RunFile = (file, args, done) =>
  void execFile(file, args, { timeout: 5000, windowsHide: true }, (err, stdout) => done(err, String(stdout)))

/**
 * Reads the policy from HKLM with reg.exe. Null for every setting when the key does not exist or
 * reg.exe cannot be started. Any other failure reads as 'invalid', as an unreadable file does.
 */
export function windowsPolicy(
  env: NodeJS.ProcessEnv = process.env,
  run: RunFile = runFile,
  key: string = WINDOWS_POLICY_KEY
): Promise<MachinePolicy> {
  const reg = regExe(env)
  return new Promise((resolve) => {
    run(reg, ['query', key], (err, stdout) => {
      if (!err) return resolve(bySection((section) => parseRegQuery(stdout, section)))
      // reg.exe exits with 1 when the key does not exist.
      resolve(allOf(err.code === 1 || err.code === 'ENOENT' ? null : 'invalid'))
    })
  })
}

// ---- what applies -------------------------------------------------------------------------

export interface PolicyOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Replaces the machine policy with this file (tests). */
  file?: string
  run?: RunFile
  /** The product names whose locations are read (tests try a rename with them). */
  names?: Names
}

/**
 * The machine's own policy: the registry on Windows, else the policy file; under the current name
 * and the one from before a rename, the current one deciding each setting it mentions.
 */
export async function machineReadings(opts: PolicyOptions = {}): Promise<MachinePolicy> {
  if (opts.file !== undefined) return readPolicyFile(opts.file)
  const platform = opts.platform ?? process.platform
  if (platform !== 'win32') return firstSaying(machinePolicyFiles(platform, opts.names).map(readPolicyFile))
  const keys = windowsPolicyKeys(opts.names)
  return firstSaying(await Promise.all(keys.map((key) => windowsPolicy(opts.env, opts.run, key))))
}

/**
 * Fills in what the machine policy leaves unset from INKMOOR_POLICY_FILE, setting by setting.
 * The machine comes first so that a person cannot override their administrator with that
 * variable, which only exists for tests.
 */
export function withTestPolicy(machine: MachinePolicy, env: NodeJS.ProcessEnv = process.env): MachinePolicy {
  const test = env.INKMOOR_POLICY_FILE ? readPolicyFile(env.INKMOOR_POLICY_FILE) : allOf(null)
  return bySection((section) => machine[section] ?? test[section])
}

/**
 * What the policy that applies on this computer says about each setting, without failing closed:
 * callers treat 'invalid' as off, but only an explicit 'disabled' may do anything that cannot be
 * undone (such as wiping saved passwords).
 */
export async function readMachinePolicy(opts: PolicyOptions = {}): Promise<MachinePolicy> {
  return withTestPolicy(await machineReadings(opts), opts.env ?? process.env)
}
