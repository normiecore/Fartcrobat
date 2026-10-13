import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, relative, resolve, isAbsolute } from 'node:path'

const PREFIX = 'fartcrobat-'
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

/** Makes a file name safe on every platform (no folders, no reserved names or characters). */
export function safeFileName(name: string, fallback = 'attachment'): string {
  let n = String(name ?? '').split(/[\\/]/).pop() ?? ''
  n = n.replace(/[\p{Cc}<>:"|?*]/gu, '_').replace(/[. ]+$/, '').trim()
  if (!n || n === '.' || n === '..') n = fallback
  if (RESERVED_WINDOWS_NAMES.test(n)) n = '_' + n
  if (n.length > 180) {
    const dot = n.lastIndexOf('.')
    const ext = dot > 0 && n.length - dot <= 16 ? n.slice(dot) : ''
    n = n.slice(0, 180 - ext.length) + ext
  }
  return n
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Private temporary files for one app session: one folder only the current user can read
 * (mode 0700, random name) under the system temp folder, removed when the app quits. Folders a
 * crashed session left behind are removed on the next start.
 */
export class TempFiles {
  private rootDir: string | null = null

  constructor(
    private readonly base: string,
    private readonly pid = process.pid
  ) {}

  /** The session folder, created on first use. */
  root(): string {
    if (!this.rootDir) {
      this.rootDir = mkdtempSync(join(this.base, `${PREFIX}${this.pid}-`))
      chmodSync(this.rootDir, 0o700)
    }
    return this.rootDir
  }

  /** A new private folder inside the session folder. */
  newDir(prefix = 'tmp-'): string {
    const dir = mkdtempSync(join(this.root(), prefix))
    chmodSync(dir, 0o700)
    return dir
  }

  /** A path for a file called `name` (made safe) in its own new folder, so names never collide. */
  pathFor(name: string): string {
    return join(this.newDir('f-'), safeFileName(name))
  }

  /** Whether `path` is inside the session folder. */
  contains(path: string): boolean {
    if (!this.rootDir) return false
    const rel = relative(this.rootDir, resolve(path))
    return !!rel && !rel.startsWith('..') && !isAbsolute(rel)
  }

  /** Removes one folder created by newDir(). */
  removeDir(dir: string) {
    if (!this.contains(dir)) return
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }

  /** Removes the session folder and everything in it. */
  cleanup() {
    if (!this.rootDir) return
    try {
      rmSync(this.rootDir, { recursive: true, force: true })
    } catch {}
    this.rootDir = null
  }

  /**
   * Removes temporary files and folders left by Fartcrobat sessions that are no longer running
   * (this naming scheme and the older fartcrobat-<pid>-<name> / fartcrobat-print-<pid>-<n>).
   * Only entries owned by the current user are touched. Returns the removed paths.
   */
  static sweepStale(base: string, isAlive: (pid: number) => boolean = pidAlive): string[] {
    const removed: string[] = []
    let names: string[]
    try {
      names = readdirSync(base)
    } catch {
      return removed
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    for (const name of names) {
      const m = /^fartcrobat-(?:print-)?(\d+)-/.exec(name)
      if (!m) continue
      const pid = Number(m[1])
      if (pid === process.pid || isAlive(pid)) continue
      const full = join(base, name)
      try {
        if (uid !== null && statSync(full).uid !== uid) continue
        rmSync(full, { recursive: true, force: true })
        removed.push(full)
      } catch {}
    }
    return removed
  }
}
