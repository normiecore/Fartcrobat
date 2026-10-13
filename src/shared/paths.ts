// File path helpers that work the same in the renderer (no Node) and the main process.

/**
 * Removes "." and ".." segments and repeated separators so two spellings of one file compare
 * equal ("/a/./b.pdf" and "/a//b.pdf" are "/a/b.pdf"). Windows paths (a drive letter or a
 * \\server\share prefix) keep backslashes; elsewhere a backslash is part of a file name.
 */
export function normalizePath(path: string): string {
  const unc = /^\\\\[^\\/]/.test(path)
  const drive = /^[a-zA-Z]:(?=[\\/]|$)/.exec(path)?.[0]
  const windows = unc || !!drive
  const sep = windows ? '\\' : '/'
  const absolute = windows || path.startsWith('/')
  const out: string[] = []
  for (const part of (drive ? path.slice(2) : path).split(windows ? /[\\/]+/ : /\/+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') {
        out.pop()
        continue
      }
      if (absolute) continue // nothing above the root
    }
    out.push(part)
  }
  const body = out.join(sep)
  if (unc) return sep + sep + body
  if (drive) return drive + sep + body
  return (absolute ? '/' : '') + body
}

/**
 * A key that identifies a file for comparisons: the normalized path, case-folded on platforms
 * whose file systems ignore case by default (Windows, macOS).
 */
export function pathKey(path: string, platform: string): string {
  const p = normalizePath(path)
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p
}
