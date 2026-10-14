// Starting Fartcrobat when an AI app calls a tool while it is not running.
import { execFile, spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { AGENT_DIR, APP_FILE } from '@shared/agent/protocol'

export interface LaunchTarget {
  executable: string
  args: string[]
}

export interface LaunchedApp {
  pid: number | undefined
  /** Settles when the started process exits: a second instance hands over to the running one and exits with 0. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/**
 * electron-builder's NSIS installer records the install folder under HKCU (or HKLM for an install
 * for everyone) in `Software\<GUID>`, the GUID being UUID v5 of the appId (org.fartcrobat.app).
 */
const WINDOWS_INSTALL_KEY = 'Software\\bd977413-7ee9-5f76-80a8-7e980aa59bd1'
const WINDOWS_EXE = 'Fartcrobat.exe'
const PRODUCT = 'Fartcrobat'

/** The executable and arguments in app.json, which the app rewrites on every start. */
export function parseAppInfo(value: unknown): LaunchTarget | null {
  if (!value || typeof value !== 'object') return null
  const { executable, args } = value as { executable?: unknown; args?: unknown }
  if (typeof executable !== 'string' || !executable) return null
  if (args !== undefined && (!Array.isArray(args) || !args.every((a) => typeof a === 'string'))) return null
  return { executable, args: (args as string[] | undefined) ?? [] }
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

/**
 * How to start the app: app.json when the app has run before (and the executable is still there),
 * else the installed copy. Null when there is nothing to start.
 */
export async function findApp(
  userData: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): Promise<LaunchTarget | null> {
  const info = await readAppInfo(userData, platform)
  if (info && (await exists(info.executable))) return info
  // A separate profile (development, tests) only starts what it recorded itself.
  if (env.FARTCROBAT_USER_DATA) return null
  const registered =
    platform === 'win32' ? await Promise.all([regInstallLocation('HKCU'), regInstallLocation('HKLM')]) : []
  for (const exe of installCandidates(platform, env, home, registered))
    if (await exists(exe)) return { executable: exe, args: [] }
  return null
}

/**
 * Starts the app on its own: detached, so it keeps running when the AI app stops this helper, and
 * with a visible window. (On Windows, Node-based AI apps keep only their direct children in their
 * kill-on-close job, so the app does not close with the AI app either.)
 */
export function startApp(target: LaunchTarget, env: NodeJS.ProcessEnv = process.env): Promise<LaunchedApp> {
  return new Promise((resolve, reject) => {
    const child = spawn(target.executable, target.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env
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
