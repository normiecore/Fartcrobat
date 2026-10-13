/**
 * PDF file specification strings use "/" separators and write Windows drives as "/C/dir/file".
 * Links store paths in that form; the UI converts them back to native paths on Windows.
 */

/** Native path -> PDF file specification string. */
export function pathToFileSpec(path: string): string {
  const win = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (win) return `/${win[1]}/${win[2].replace(/\\/g, '/')}`
  return path.replace(/\\/g, '/')
}

/** PDF file specification string -> native path (drive letters only on Windows). */
export function fileSpecToPath(spec: string, windows: boolean): string {
  if (!windows) return spec
  const win = /^\/([A-Za-z])\/(.*)$/.exec(spec)
  if (win) return `${win[1]}:\\${win[2].replace(/\//g, '\\')}`
  return spec.replace(/\//g, '\\')
}

/** True for absolute native paths (POSIX or Windows). */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}
