// Starting Fartcrobat when an AI app calls a tool while it is not running.
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { AGENT_DIR, APP_FILE } from '@shared/agent/protocol'

export interface LaunchTarget {
  executable: string
  args: string[]
  /** app.json's record of whether agent access is on (false: the app would refuse). Missing: unknown. */
  enabled?: boolean
}

export interface LaunchedApp {
  /** The started process, when the shim started the app itself. */
  pid: number | undefined
  /**
   * Settles when the started process exits: a second instance hands over to the running one and
   * exits with 0. Never settles when another program (WMI, LaunchServices) started the app.
   */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/**
 * electron-builder's NSIS installer records the install folder under HKCU (or HKLM for an install
 * for everyone) in `Software\<GUID>`, the GUID being UUID v5 of the appId (org.fartcrobat.app).
 */
const WINDOWS_INSTALL_KEY = 'Software\\bd977413-7ee9-5f76-80a8-7e980aa59bd1'
const WINDOWS_EXE = 'Fartcrobat.exe'
const PRODUCT = 'Fartcrobat'
/**
 * How long the shim waits for PowerShell or `open` to say whether they started the app. One still
 * at it then (a slow machine, a Gatekeeper prompt) may yet start it, so it is left to finish.
 */
const LAUNCHER_TIMEOUT_MS = 15_000

/** The executable and arguments in app.json, which the app rewrites on every start. */
export function parseAppInfo(value: unknown): LaunchTarget | null {
  if (!value || typeof value !== 'object') return null
  const { executable, args, enabled } = value as { executable?: unknown; args?: unknown; enabled?: unknown }
  if (typeof executable !== 'string' || !executable) return null
  if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))) return null
  return {
    executable,
    args: (args as string[] | undefined) ?? [],
    ...(typeof enabled === 'boolean' ? { enabled } : {})
  }
}

export async function readAppInfo(
  userData: string,
  platform: NodeJS.Platform = process.platform
): Promise<LaunchTarget | null> {
  const path = platform === 'win32' ? win32 : posix
  try {
    return parseAppInfo(JSON.parse(await readFile(path.join(userData, AGENT_DIR, APP_FILE), 'utf8')))
  } catch {
    return null
  }
}

/** The InstallLocation value in `reg query` output. */
export function parseRegQuery(output: string): string | null {
  const m = /^\s*InstallLocation\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(output)
  return m ? m[1] : null
}

function regInstallLocation(root: 'HKCU' | 'HKLM'): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'reg',
      ['query', `${root}\\${WINDOWS_INSTALL_KEY}`, '/v', 'InstallLocation'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => resolve(err ? null : parseRegQuery(String(stdout)))
    )
  })
}

/**
 * Where Fartcrobat.exe may be on Windows, most likely first: the folders the installer recorded,
 * then its defaults (per user: %LOCALAPPDATA%\Programs\Fartcrobat; for everyone: Program Files).
 */
export function windowsInstallCandidates(env: NodeJS.ProcessEnv, registered: (string | null)[]): string[] {
  const dirs = registered.filter((d): d is string => !!d)
  const localAppData =
    env.LOCALAPPDATA || (env.USERPROFILE && win32.join(env.USERPROFILE, 'AppData', 'Local'))
  if (localAppData) dirs.push(win32.join(localAppData, 'Programs', PRODUCT))
  for (const programFiles of [env.ProgramW6432, env.ProgramFiles, env.PROGRAMFILES])
    if (programFiles) dirs.push(win32.join(programFiles, PRODUCT))
  return [...new Set(dirs.map((d) => win32.join(d, WINDOWS_EXE)))]
}

/** Where the installers put the executable, most likely first. */
export function installCandidates(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home: string,
  registered: (string | null)[] = []
): string[] {
  if (platform === 'win32') return windowsInstallCandidates(env, registered)
  if (platform === 'darwin')
    return [
      `/Applications/${PRODUCT}.app/Contents/MacOS/${PRODUCT}`,
      posix.join(home, `Applications/${PRODUCT}.app/Contents/MacOS/${PRODUCT}`)
    ]
  // The .deb package; AppImages can be anywhere and are found through app.json only.
  return [`/opt/${PRODUCT}/fartcrobat`]
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

const APP_NAME = 'Fartcrobat'

/** Electron's usual userData folder for Fartcrobat, whatever FARTCROBAT_USER_DATA says. */
export function defaultUserDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), APP_NAME)
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', APP_NAME)
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), APP_NAME)
}

/**
 * FARTCROBAT_USER_DATA names a separate profile (development, tests). The Connect ChatGPT Desktop
 * setup names the usual folder as well, because ChatGPT passes servers only some of the
 * environment (XDG_CONFIG_HOME, for one): that is not a separate profile, and the app starts as
 * for the Claude extension.
 */
export function separateProfile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): boolean {
  const named = env.FARTCROBAT_USER_DATA
  if (!named) return false
  const usual = defaultUserDataDir(env, platform, home)
  if (platform === 'win32') return win32.resolve(named).toLowerCase() !== win32.resolve(usual).toLowerCase()
  return posix.resolve(named) !== posix.resolve(usual)
}

/**
 * How to start the app: app.json when the app has run before (and the executable is still there),
 * else the installed copy. Null when there is nothing to start. An app.json that says agent access
 * is off comes back as it is, so the shim can say so without starting anything.
 */
export async function findApp(
  userData: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): Promise<LaunchTarget | null> {
  const info = await readAppInfo(userData, platform)
  if (info && (info.enabled === false || (await exists(info.executable)))) return info
  // A separate profile (development, tests) only starts what it recorded itself.
  if (separateProfile(env, platform, home)) return null
  const registered =
    platform === 'win32' ? await Promise.all([regInstallLocation('HKCU'), regInstallLocation('HKLM')]) : []
  for (const exe of installCandidates(platform, env, home, registered))
    if (await exists(exe)) return { executable: exe, args: [] }
  return null
}

export type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

export interface StartOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** Starts processes (tests replace it). */
  spawn?: Spawn
  log?: (message: string) => void
  launcherTimeoutMs?: number
}

/** How startApp starts the app: see startApp. */
export type LaunchMethod = 'wmi' | 'launch-services' | 'direct'

/** The .app bundle a macOS executable is in, or null. */
export function macBundle(executable: string): string | null {
  return /^(\/.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(executable)?.[1] ?? null
}

export function launchMethod(
  target: LaunchTarget,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  home: string = homedir()
): LaunchMethod {
  // A separate profile (development, tests) is named in the environment, and only a direct start
  // passes that on: WMI and LaunchServices give the app the person's usual environment.
  if (separateProfile(env, platform, home)) return 'direct'
  if (platform === 'win32') return 'wmi'
  if (platform === 'darwin' && !target.args.length && macBundle(target.executable)) return 'launch-services'
  return 'direct'
}

/** One argument as the Microsoft C runtime (and CommandLineToArgvW) reads it back. */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg
  let quoted = '"'
  let backslashes = 0
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    // Backslashes are literal unless a quotation mark follows them.
    quoted += '\\'.repeat(ch === '"' ? backslashes * 2 + 1 : backslashes) + ch
    backslashes = 0
  }
  return quoted + '\\'.repeat(backslashes * 2) + '"'
}

/**
 * The command line that starts the target on Windows. The program name is always quoted, and
 * Windows reads it up to the next quotation mark without escapes, so it cannot contain one (no
 * Windows path does).
 */
export function windowsCommandLine(target: LaunchTarget): string {
  if (target.executable.includes('"')) throw new Error('the program path contains a quotation mark')
  return [`"${target.executable}"`, ...target.args.map(quoteWindowsArg)].join(' ')
}

/**
 * Starts the command line in FARTCROBAT_LAUNCH_COMMAND, in the folder in FARTCROBAT_LAUNCH_DIR,
 * through WMI, and exits with WMI's answer (0: started). Both come from the environment and are
 * never pasted into the script, so nothing in a path can change what PowerShell runs.
 */
export const WMI_LAUNCH_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:FARTCROBAT_LAUNCH_COMMAND; CurrentDirectory = $env:FARTCROBAT_LAUNCH_DIR }',
  'exit [int]$r.ReturnValue'
].join('; ')

/** A program that starts the app and exits with 0 once it has. */
export interface Launcher {
  command: string
  args: string[]
  options: SpawnOptions
}

export function wmiLauncher(target: LaunchTarget, env: NodeJS.ProcessEnv): Launcher {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows'
  return {
    command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-Command', WMI_LAUNCH_SCRIPT],
    options: {
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...env,
        FARTCROBAT_LAUNCH_COMMAND: windowsCommandLine(target),
        FARTCROBAT_LAUNCH_DIR: win32.dirname(target.executable)
      }
    }
  }
}

export function launchServicesLauncher(target: LaunchTarget, env: NodeJS.ProcessEnv): Launcher {
  const bundle = macBundle(target.executable)
  if (!bundle) throw new Error('the program is not inside an .app bundle')
  // -a with the bundle's path, not -b with its id, which could pick another copy (a mounted DMG).
  return { command: '/usr/bin/open', args: ['-a', bundle], options: { stdio: 'ignore', env } }
}

type LauncherOutcome = 'started' | 'pending' | { failed: string }

/** Runs a launcher: whether it started the app, is still at it after `timeoutMs`, or failed. */
function runLauncher(run: Spawn, launcher: Launcher, timeoutMs: number): Promise<LauncherOutcome> {
  return new Promise((resolve) => {
    const child = run(launcher.command, launcher.args, launcher.options)
    const timer = setTimeout(() => resolve('pending'), timeoutMs)
    child.once('error', (err) => {
      clearTimeout(timer)
      resolve({ failed: err.message })
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve(code === 0 ? 'started' : { failed: signal ?? `exit code ${code}` })
    })
  })
}

/** Starts the executable as a detached child of this helper. */
function spawnDirect(
  run: Spawn,
  target: LaunchTarget,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): Promise<LaunchedApp> {
  const appEnv = { ...env }
  // Set when the AI app runs this helper with its own Electron as Node: Fartcrobat would start as
  // plain Node too, and exit at once.
  delete appEnv.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const child = run(target.executable, target.args, {
      // Its own folder, as from the Start menu: on Windows a program's working folder cannot be
      // removed while it runs, and this one may be the AI app's.
      cwd: (platform === 'win32' ? win32 : posix).dirname(target.executable),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: appEnv
    })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.once('exit', (code, signal) => done({ code, signal }))
    )
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve({ pid: child.pid, exited })
    })
  })
}

/**
 * Starts the app on its own, with a visible window, so that it keeps running when the AI app stops
 * this helper and behaves as if the person had started it:
 * - On Windows through WMI, so the app is not a descendant of the AI app. Claude Desktop is an MSIX
 *   package, and Windows redirects its descendants' writes to AppData into a private copy, which
 *   would split the app's settings (agent access among them), endpoint.json and audit log from the
 *   real ones. Being outside the AI app's job object, the app does not close with it either.
 * - On macOS through LaunchServices (`open -a`), so macOS asks for file access in Fartcrobat's own
 *   name rather than the AI app's, and brings the app to the front.
 * Otherwise, or when that fails, as a detached child.
 */
export async function startApp(target: LaunchTarget, opts: StartOptions = {}): Promise<LaunchedApp> {
  const env = opts.env ?? process.env
  const platform = opts.platform ?? process.platform
  const run = opts.spawn ?? spawn
  const method = launchMethod(target, env, platform)
  if (method !== 'direct') {
    const name = method === 'wmi' ? 'WMI' : 'LaunchServices'
    const timeoutMs = opts.launcherTimeoutMs ?? LAUNCHER_TIMEOUT_MS
    let outcome: LauncherOutcome
    try {
      const launcher = method === 'wmi' ? wmiLauncher(target, env) : launchServicesLauncher(target, env)
      outcome = await runLauncher(run, launcher, timeoutMs)
    } catch (err) {
      outcome = { failed: err instanceof Error ? err.message : String(err) }
    }
    if (typeof outcome === 'string') {
      opts.log?.(
        outcome === 'started'
          ? `Started Fartcrobat through ${name}.`
          : `${name} has not finished starting Fartcrobat after ${timeoutMs / 1000} seconds; waiting for it.`
      )
      // The launcher's exit says nothing about the app: only a fresh endpoint.json does.
      return { pid: undefined, exited: new Promise(() => {}) }
    }
    opts.log?.(`Could not start Fartcrobat through ${name} (${outcome.failed}); starting it directly.`)
  }
  return spawnDirect(run, target, env, platform)
}
