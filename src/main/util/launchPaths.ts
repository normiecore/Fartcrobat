import { statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * File types Fartcrobat opens from the command line, the OS ("Open with", Finder, a second
 * launch) and drag and drop onto the Dock icon. MuPDF opens most of them directly; Office and
 * OpenDocument files go through the LibreOffice converter when a feature registers one (the
 * renderer explains what to install when it cannot open a file).
 */
export const OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.xps', '.oxps', '.epub', '.mobi',
  '.fb2', '.cbz', '.svg', '.txt', '.html', '.htm', '.xhtml',
  '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt', '.odt', '.ods', '.odp', '.odg', '.rtf', '.csv'
])

/**
 * Turns one launch argument into an absolute path: `file://` URIs (xdg-open, desktop files with
 * %U) become paths and relative paths are resolved against the launching process's working
 * directory. Returns null for anything that is not a path.
 */
export function normalizeLaunchArg(arg: string, cwd: string): string | null {
  if (!arg || arg.startsWith('-')) return null
  let p = arg
  if (/^file:/i.test(p)) {
    try {
      p = fileURLToPath(p)
    } catch {
      return null
    }
  } else if (/^[a-z][a-z0-9+.-]+:\/\//i.test(p)) {
    return null // http://, mailto: and other URLs are not files
  }
  return isAbsolute(p) ? resolve(p) : resolve(cwd, p)
}

function isOpenableFile(path: string): boolean {
  if (!OPENABLE_EXTENSIONS.has(extname(path).toLowerCase())) return false
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Files to open from a process's argv. `skip` is how many leading entries are the executable
 * (and, when running unpackaged, the app script): 1 for a packaged app, 2 under `electron .`.
 */
export function filesFromArgv(argv: readonly string[], cwd: string, skip = 1): string[] {
  const out: string[] = []
  for (const arg of argv.slice(skip)) {
    const p = normalizeLaunchArg(arg, cwd)
    if (p && isOpenableFile(p) && !out.includes(p)) out.push(p)
  }
  return out
}

/** Normalises a path the OS handed over directly (macOS open-file), keeping only openable files. */
export function openableFile(path: string, cwd: string): string | null {
  const p = normalizeLaunchArg(path, cwd)
  return p && isOpenableFile(p) ? p : null
}
