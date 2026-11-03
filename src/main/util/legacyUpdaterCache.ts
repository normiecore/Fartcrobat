// The download cache of the updater from before the rename (src/shared/identity.ts). electron-updater
// names its cache folder after package.json's name, so 0.2 and 0.3 downloaded into
// `fartcrobat-updater` and 0.4 uses `inkmoor-updater`. Nothing reads the old one again.
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { LEGACY, PRODUCT_NAME } from '@shared/identity'

/** The cache folder electron-updater uses on each system (electron-updater's getAppCacheDir). */
export function updaterCacheBase(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'win32') return env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')
  if (platform === 'darwin') return posix.join(home, 'Library', 'Caches')
  return env.XDG_CACHE_HOME || posix.join(home, '.cache')
}

/** The old updater cache folder, or null when the app has not been renamed. */
export function legacyUpdaterCacheDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  current: string = PRODUCT_NAME
): string | null {
  const legacy = `${LEGACY.productName.toLowerCase()}-updater`
  if (legacy === `${current.toLowerCase()}-updater`) return null
  return (platform === 'win32' ? win32 : posix).join(updaterCacheBase(platform, env, home), legacy)
}

/** Removes the old updater cache, if any. Never throws. */
export function removeLegacyUpdaterCache(): void {
  const dir = legacyUpdaterCacheDir()
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 2 })
  } catch {}
}
