// The app's version when it runs unpackaged (npm run dev, tests).
import { join } from 'node:path'

/**
 * The version of an unpackaged build. app.getVersion() reads package.json in the app's folder,
 * and test runs start out/main/index.js, which has none (Electron then says "0.0"): look for
 * Fartcrobat's package.json a level or two up instead. Null when there is none.
 */
export function unpackagedVersion(appPath: string, readFile: (path: string) => string): string | null {
  for (const dir of [appPath, join(appPath, '..'), join(appPath, '..', '..')]) {
    try {
      const pkg = JSON.parse(readFile(join(dir, 'package.json'))) as { name?: unknown; version?: unknown }
      if (pkg.name === 'fartcrobat' && typeof pkg.version === 'string') return pkg.version
    } catch {}
  }
  return null
}
