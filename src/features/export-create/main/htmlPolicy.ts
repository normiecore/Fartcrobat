/**
 * Which URLs the hidden HTML-to-PDF window may load. Pure Node so it can be unit-tested.
 *
 * Only files in the folder of the HTML file (and its subfolders) and inline data are allowed:
 * no other host, no network or UNC share, nothing outside that folder (symbolic links are
 * resolved first), no browser-internal pages, and the page itself cannot navigate anywhere else.
 */
import { realpathSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface HtmlLoadPolicy {
  /** The file: URL of the HTML file, the only page the window may show. */
  readonly pageUrl: string
  /** True when a sub-resource (image, style sheet, font, frame) may be loaded. */
  allowsResource(url: string): boolean
  /** True when the main frame may load this URL (only the page itself). */
  allowsNavigation(url: string): boolean
}

type Platform = 'win32' | 'posix'

const pathFor = (platform: Platform) => (platform === 'win32' ? win32 : posix)

function realpath(p: string, platform: Platform): string {
  // Only resolve links for paths of this computer (unit tests pass Windows paths on Linux).
  if ((platform === 'win32') !== (process.platform === 'win32')) return p
  try {
    return realpathSync.native(p)
  } catch {
    return p
  }
}

/** Path of a file: URL on this computer, or null for a URL with a host or a UNC path. */
function localPath(url: URL, platform: Platform): string | null {
  if (url.protocol !== 'file:') return null
  if (url.hostname !== '') return null
  let p: string
  try {
    p = fileURLToPath(url, { windows: platform === 'win32' })
  } catch {
    return null
  }
  // UNC paths (\\server\share, \\?\UNC\..., //server/share) reach other computers.
  if (/^[\\/]{2}/.test(p)) return null
  if (platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(p)) return null
  const P = pathFor(platform)
  if (!P.isAbsolute(p)) return null
  return P.resolve(p)
}

function inside(child: string, root: string, platform: Platform): boolean {
  const P = pathFor(platform)
  const a = platform === 'win32' ? child.toLowerCase() : child
  const b = platform === 'win32' ? root.toLowerCase() : root
  const rel = P.relative(b, a)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + P.sep) && !P.isAbsolute(rel))
}

export function htmlLoadPolicy(
  htmlPath: string,
  platform: Platform = process.platform === 'win32' ? 'win32' : 'posix'
): HtmlLoadPolicy {
  const P = pathFor(platform)
  const file = P.resolve(htmlPath)
  const pageUrl = pathToFileURL(file, { windows: platform === 'win32' }).toString()
  const root = P.dirname(file)
  const realRoot = realpath(root, platform)
  const same = (a: string, b: string) => (platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)

  const pathOf = (raw: string): string | null => {
    try {
      return localPath(new URL(raw), platform)
    } catch {
      return null
    }
  }

  const allowsFile = (raw: string): boolean => {
    const p = pathOf(raw)
    if (!p) return false
    if (!inside(p, root, platform)) return false
    // A symbolic link inside the folder may point anywhere: check where it really goes.
    return inside(realpath(p, platform), realRoot, platform)
  }

  return {
    pageUrl,
    allowsResource(raw) {
      if (raw === 'about:blank') return true
      if (/^(data|blob):/i.test(raw)) return true
      if (/^file:/i.test(raw)) return allowsFile(raw)
      return false
    },
    allowsNavigation(raw) {
      // Compared as paths: Chromium and Node may percent-encode the same path differently.
      const p = /^file:/i.test(raw) ? pathOf(raw) : null
      return p !== null && same(p, file)
    }
  }
}
