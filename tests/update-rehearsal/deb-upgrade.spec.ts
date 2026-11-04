// Update rehearsal for the Ubuntu .deb after the person installs the new version's file over the old
// one (README.md): `apt install ./<new .deb>` upgrades the one package in place, also across the
// rename (the package keeps its name, `fartcrobat`; the app moves from /opt/Fartcrobat to
// /opt/Inkmoor, names.mjs). Run by the deb job of .github/workflows/update-rehearsal.yml after
// notify.spec.ts has run the old version as this user and the job has installed the new .deb and
// checked the package. Checks that the new version starts with Chromium's sandbox where AppArmor
// limits user namespaces (through the profile the new package installs), keeps the old version's
// userData folder, and still follows a policy written for the old version.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  asAdministrator,
  checkFromHelpMenu,
  describe,
  env,
  expectUpdatesManaged,
  otherHostsAfter,
  productFor,
  shot,
  startFakeGitHub,
  userDataPath,
  version,
  type FakeGitHub
} from './common'

const WORK = env('REHEARSAL_WORK')
const OLD = env('REHEARSAL_OLD')
const NEW = env('REHEARSAL_NEW')
const OLD_NAMES = productFor(OLD)
const NEW_NAMES = productFor(NEW)
const RELEASES = join(WORK, 'releases')
const OUT = join(WORK, 'out')
const POLICIES = [...new Set([OLD_NAMES.linuxPolicy, NEW_NAMES.linuxPolicy])]

test.skip(process.platform !== 'linux', 'Linux only')
test.describe.configure({ mode: 'serial' })
test.setTimeout(5 * 60_000)

let gh: FakeGitHub
test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(join(RELEASES, `v${NEW}`), { recursive: true })
  gh = await startFakeGitHub({
    releases: RELEASES,
    latest: `v${NEW}`,
    cert: join(WORK, 'tls', 'server.pem'),
    key: join(WORK, 'tls', 'server.key'),
    log: join(OUT, 'deb-upgraded-requests.jsonl')
  })
})
test.afterAll(() => gh?.stop())

/** The new version, from where the new package put it, started as people start it (with Chromium's sandbox). */
async function startApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: NEW_NAMES.debExe, args: [`--proxy-server=${gh.proxy}`], chromiumSandbox: true, timeout: 120_000 })
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForSelector('.shell', { timeout: 120_000 })
  return { app, page }
}

test(`deb: ${NEW}, installed over ${OLD}, starts in ${OLD}'s userData folder and is up to date`, async () => {
  const from = (await gh.requests()).length
  const startedAt = Date.now()
  const { app, page } = await startApp()
  try {
    expect(await version(app)).toBe(NEW)
    // notify.spec.ts started the old version as this user, which made its folder.
    expect(await userDataPath(app)).toBe(join(homedir(), '.config', OLD_NAMES.userData))
    if (NEW_NAMES.userData !== OLD_NAMES.userData) expect(existsSync(join(homedir(), '.config', NEW_NAMES.userData))).toBe(false)
    await checkFromHelpMenu(page)
    await expect(page.locator('.toast', { hasText: /up to date/i })).toBeVisible({ timeout: 60_000 })
    await shot(page, 'deb-upgraded-up-to-date')
    expect(await otherHostsAfter(gh, from, startedAt), `${NEW} contacted hosts other than GitHub`).toEqual([])
  } finally {
    await app.close().catch(() => {})
    writeFileSync(join(OUT, 'deb-upgraded-requests.txt'), describe(await gh.requests()).join('\n') + '\n')
  }
})

test(`deb: a policy written for ${OLD} (${OLD_NAMES.linuxPolicy}) still applies to ${NEW}`, async () => {
  asAdministrator(OLD_NAMES.linuxPolicy, JSON.stringify({ autoUpdate: { enabled: false } }))
  try {
    const { app, page } = await startApp()
    try {
      await expectUpdatesManaged(page)
      await shot(page, 'deb-upgraded-old-policy')
    } finally {
      await app.close().catch(() => {})
    }
  } finally {
    for (const file of POLICIES) asAdministrator(file, null)
  }
})
