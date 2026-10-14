// This app's version, as About, Preferences > Updates and the update check show it.
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { unpackagedVersion } from './util/appVersion'

let cached: string | null = null

/**
 * app.getVersion() in installed copies. Unpackaged runs (npm run dev, tests) start out/main, which
 * has no package.json, so Electron says "0.0" there: they read Fartcrobat's package.json instead.
 */
export function appVersion(): string {
  cached ??=
    (!app.isPackaged && unpackagedVersion(app.getAppPath(), (path) => readFileSync(path, 'utf8'))) ||
    app.getVersion()
  return cached
}
