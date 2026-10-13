/**
 * Finds LibreOffice and converts Office files to PDF with it. Plain Node (no Electron), so the
 * conversion can be tested on its own.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface LibreOfficeInfo {
  path: string
  version: string | null
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform === 'win32') return true
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Places LibreOffice is usually installed, for a platform, in the order they are tried. */
export function candidatePaths(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  const names = platform === 'win32' ? ['soffice.exe', 'soffice.com'] : ['soffice', 'libreoffice']
  // On the PATH first: that is what the user runs.
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue
    for (const n of names) out.push(join(dir, n))
  }
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432, 'C:\\Program Files', 'C:\\Program Files (x86)']
    for (const root of roots) if (root) out.push(`${root}\\LibreOffice\\program\\soffice.exe`)
    if (env.LOCALAPPDATA) out.push(`${env.LOCALAPPDATA}\\Programs\\LibreOffice\\program\\soffice.exe`)
  } else if (platform === 'darwin') {
    out.push('/Applications/LibreOffice.app/Contents/MacOS/soffice')
    if (env.HOME) out.push(`${env.HOME}/Applications/LibreOffice.app/Contents/MacOS/soffice`)
    out.push('/opt/homebrew/bin/soffice', '/usr/local/bin/soffice')
  } else {
    out.push(
      '/usr/bin/soffice',
      '/usr/bin/libreoffice',
      '/usr/lib/libreoffice/program/soffice',
      '/usr/lib64/libreoffice/program/soffice',
      '/usr/local/bin/soffice',
      '/opt/libreoffice/program/soffice'
    )
    // Versioned installs from libreoffice.org: /opt/libreoffice24.8/program/soffice
    try {
      for (const d of readdirSync('/opt')) if (/^libreoffice/i.test(d)) out.push(`/opt/${d}/program/soffice`)
    } catch {}
    out.push('/snap/bin/libreoffice', '/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice')
    if (env.HOME) out.push(`${env.HOME}/.local/share/flatpak/exports/bin/org.libreoffice.LibreOffice`)
  }
  return [...new Set(out)]
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
        if (e.killed || e.signal === 'SIGTERM') reject(new Error('LibreOffice did not finish in time'))
        else reject(Object.assign(new Error(String(stderr || e.message).trim() || 'LibreOffice failed'), { cause: err }))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

/** "LibreOffice 24.8.4.2 480(Build:2)" -> "24.8.4.2", or null when it cannot be read. */
export async function libreOfficeVersion(path: string, timeoutMs = 30000): Promise<string | null> {
  try {
    const { stdout } = await run(path, ['--version'], timeoutMs)
    const m = /(LibreOffice|OpenOffice)[^\d]*(\d+(\.\d+)+)/i.exec(stdout)
    return m ? m[2] : stdout.trim().split('\n')[0] || null
  } catch {
    return null
  }
}

/**
 * Finds LibreOffice: the path from Preferences when it is set and works, otherwise the PATH and
 * the standard install folders. Returns null when it is not installed.
 */
export async function findLibreOffice(preferred?: string, opts: { version?: boolean } = {}): Promise<LibreOfficeInfo | null> {
  const tried = new Set<string>()
  const candidates = [...(preferred?.trim() ? [preferred.trim()] : []), ...candidatePaths()]
  for (const path of candidates) {
    if (tried.has(path)) continue
    tried.add(path)
    if (!isExecutable(path)) continue
    return { path, version: opts.version === false ? null : await libreOfficeVersion(path) }
  }
  return null
}

/** Formats LibreOffice converts better than the built-in importer (or at all). */
export const LIBREOFFICE_EXTENSIONS = ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp']

/**
 * Converts a file to PDF with LibreOffice and returns the PDF bytes. A private user profile is
 * used, so this works while LibreOffice is open with the user's own profile.
 */
export async function convertWithLibreOffice(
  soffice: string,
  file: string,
  opts: { profileDir?: string; timeoutMs?: number } = {}
): Promise<Uint8Array> {
  if (!existsSync(file)) throw new Error(`${basename(file)} does not exist`)
  const work = mkdtempSync(join(tmpdir(), 'fartcrobat-convert-'))
  const profile = opts.profileDir ?? join(work, 'profile')
  try {
    const outDir = join(work, 'out')
    await run(
      soffice,
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--invisible',
        '--norestore',
        '--nolockcheck',
        '--nodefault',
        '--nofirststartwizard',
        '--convert-to',
        'pdf',
        '--outdir',
        outDir,
        file
      ],
      opts.timeoutMs ?? 180000
    )
    const expected = join(outDir, basename(file, extname(file)) + '.pdf')
    let pdf = existsSync(expected) ? expected : null
    if (!pdf && existsSync(outDir)) {
      const found = readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.pdf'))
      if (found) pdf = join(outDir, found)
    }
    if (!pdf) throw new Error(`LibreOffice could not convert ${basename(file)}`)
    return new Uint8Array(readFileSync(pdf))
  } finally {
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {}
  }
}
