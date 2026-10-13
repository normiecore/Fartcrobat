import { statSync } from 'node:fs'
import { extname, resolve } from 'node:path'

const OPENABLE = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tif', '.tiff', '.webp', '.xps', '.oxps', '.epub', '.mobi',
  '.fb2', '.cbz', '.svg', '.txt', '.docx', '.xlsx', '.pptx', '.html', '.htm', '.xhtml'
])

/**
 * Files to open from a command line: existing files of a supported type, as absolute paths.
 * Relative paths are resolved against `cwd`, the directory the command was run in (for a second
 * launch that is the second process's directory, not this one's).
 */
export function filesFromArgv(argv: string[], cwd: string): string[] {
  return argv
    .slice(1)
    .filter((a) => !a.startsWith('-') && OPENABLE.has(extname(a).toLowerCase()))
    .map((a) => resolve(cwd, a))
    .filter((a) => {
      try {
        return statSync(a).isFile()
      } catch {
        return false
      }
    })
}
