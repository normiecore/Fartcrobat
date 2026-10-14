// Linux AppImages: whether this process runs from one, and from which file.
import { realpathSync } from 'node:fs'

/**
 * The .AppImage file this process runs from, or null. The AppImage runtime mounts the image at a
 * temporary folder (APPDIR) and sets APPIMAGE to the file. Every program an AppImage starts
 * inherits both (an AI app that starts Fartcrobat through the agent shim, a PDF opened from an
 * AppImage app through xdg-open), so they only belong to this process when execPath is inside
 * APPDIR. `realpath` resolves APPDIR when it lies under a linked folder (execPath is resolved).
 */
export function appImageFile(
  execPath: string,
  env: NodeJS.ProcessEnv,
  realpath: (path: string) => string | null = resolvedPath
): string | null {
  const { APPIMAGE, APPDIR } = env
  if (!APPIMAGE || !APPDIR) return null
  const inside = (dir: string) => {
    const base = dir.replace(/\/+$/, '')
    return base !== '' && execPath.startsWith(base + '/')
  }
  if (inside(APPDIR)) return APPIMAGE
  const real = realpath(APPDIR)
  return real && inside(real) ? APPIMAGE : null
}

function resolvedPath(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}
