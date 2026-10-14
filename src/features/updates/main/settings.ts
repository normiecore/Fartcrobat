// What this installation can do with an update (docs/features/updates.md, U2), and the switches
// tests use. Every FARTCROBAT_UPDATE_* / FARTCROBAT_FAKE_UPDATER variable is ignored by packaged
// builds, so nobody can point an installed copy at another server or another installer.
import { join } from 'node:path'
import { UPDATE_FIRST_CHECK_DELAY_MS, type UpdateCapability } from '@shared/updates'
import { RELEASES_BASE, trimBase } from './release'

/**
 * macOS installs an update only when it is signed with the same Developer ID as the running app
 * (Squirrel.Mac). Releases are ad-hoc signed today, so macOS only says that a new version exists.
 * Set to true once releases are signed with a Developer ID.
 */
export const MAC_INSTALLS_UPDATES = false

export interface InstallFacts {
  platform: NodeJS.Platform
  isPackaged: boolean
  env: NodeJS.ProcessEnv
  /** resources/app-update.yml exists (electron-builder writes it when publishing is configured). */
  hasUpdateConfig: boolean
}

/**
 * 'install' for the Windows installer and Linux AppImages (and the fake updater in unpackaged
 * test builds); 'notify' for everything else: macOS until it is signed, .deb (installing needs a
 * password prompt), .tar.gz (nothing can update it), and unpackaged runs.
 */
export function updateCapability(facts: InstallFacts): UpdateCapability {
  if (!facts.isPackaged) return facts.env.FARTCROBAT_FAKE_UPDATER ? 'install' : 'notify'
  if (!facts.hasUpdateConfig) return 'notify'
  switch (facts.platform) {
    case 'win32':
      return 'install'
    case 'linux':
      // Set by the AppImage runtime; .deb and .tar.gz installs don't have it.
      return facts.env.APPIMAGE ? 'install' : 'notify'
    case 'darwin':
      return MAC_INSTALLS_UPDATES ? 'install' : 'notify'
    default:
      return 'notify'
  }
}

export interface UpdateSettings {
  /** Where releases are looked up: github.com, or a local server in tests. */
  base: string
  /** The replacement base of an unpackaged test build (openReleasePage accepts it too), else null. */
  testBase: string | null
  /** Whether automatic checks may run at all (the preference and the policy still decide). */
  autoChecks: boolean
  firstCheckDelayMs: number
  /** The fake updater's settings file (unpackaged builds only), else null. */
  fakeUpdaterFile: string | null
}

/**
 * Packaged builds: github.com, automatic checks allowed, the real delay. Unpackaged builds (npm run
 * dev, tests): automatic checks only with FARTCROBAT_UPDATE_CHECKS=1, and the test variables apply.
 */
export function updateSettings(isPackaged: boolean, env: NodeJS.ProcessEnv): UpdateSettings {
  if (isPackaged)
    return {
      base: RELEASES_BASE,
      testBase: null,
      autoChecks: true,
      firstCheckDelayMs: UPDATE_FIRST_CHECK_DELAY_MS,
      fakeUpdaterFile: null
    }
  const testBase = httpUrl(env.FARTCROBAT_UPDATE_URL)
  const delay = Number(env.FARTCROBAT_UPDATE_FIRST_CHECK_MS)
  return {
    base: testBase ?? RELEASES_BASE,
    testBase,
    autoChecks: env.FARTCROBAT_UPDATE_CHECKS === '1',
    firstCheckDelayMs:
      env.FARTCROBAT_UPDATE_FIRST_CHECK_MS && Number.isFinite(delay) && delay >= 0
        ? delay
        : UPDATE_FIRST_CHECK_DELAY_MS,
    fakeUpdaterFile: env.FARTCROBAT_FAKE_UPDATER || null
  }
}

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

function httpUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return /^https?:$/.test(url.protocol) ? trimBase(url.href) : null
  } catch {
    return null
  }
}
