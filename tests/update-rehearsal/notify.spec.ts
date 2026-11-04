// Update rehearsal for the installs that tell people about a new version but do not install it
// (README.md): the Mac app from the released .dmg (until releases are Developer ID signed) and the
// Linux .deb. The released app, installed for real, finds the next version on a fake GitHub
// (fake-github.mjs); Download opens that release's page, where the person downloads the new file;
// the machine policy turns it all off. Run by .github/workflows/update-rehearsal.yml (jobs mac and
// deb), which install the app and trust the test certificate first. Only the old version runs here,
// under the name it was released with (names.mjs); deb-upgrade.spec.ts starts the new .deb after
// the job installs it over the old one.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  asAdministrator,
  cardText,
  checkFromHelpMenu,
  contactsOnlyGitHub,
  describe,
  env,
  expectUpdatesManaged,
  otherHosts,
  productFor,
  shot,
  startFakeGitHub,
  updateCard,
  version,
  type FakeGitHub
} from './common'

const WORK = env('REHEARSAL_WORK')
const OLD = env('REHEARSAL_OLD')
const NEW = env('REHEARSAL_NEW')
const KIND = env('REHEARSAL_KIND') as 'mac' | 'deb'
/** The names the old version was released with. */
const OLD_NAMES = productFor(OLD)
/** The installed app (/Applications/<name>.app/Contents/MacOS/<name>, /opt/<name>/<name in lower case>), unless REHEARSAL_EXE says. */
const EXE = process.env.REHEARSAL_EXE || (KIND === 'mac' ? OLD_NAMES.macExe : OLD_NAMES.debExe)
const POLICY = KIND === 'mac' ? OLD_NAMES.macPolicy : OLD_NAMES.linuxPolicy
const RELEASES = join(WORK, 'releases')
const OUT = join(WORK, 'out')
/** The repository keeps its name whatever the app is called (src/shared/identity.ts). */
const RELEASE_PAGE = `https://github.com/normiecore/Fartcrobat/releases/tag/v${NEW}`

test.describe.configure({ mode: 'serial' })
test.setTimeout(5 * 60_000)

let gh: FakeGitHub
test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  // The release only has to exist: nothing is downloaded from it.
  mkdirSync(join(RELEASES, `v${NEW}`), { recursive: true })
  gh = await startFakeGitHub({
    releases: RELEASES,
    latest: `v${NEW}`,
    cert: join(WORK, 'tls', 'server.pem'),
    key: join(WORK, 'tls', 'server.key'),
    log: join(OUT, `${KIND}-requests.jsonl`)
  })
})
test.afterAll(() => gh?.stop())

/** Started as people start it: with Chromium's sandbox (Playwright turns it off on Linux by default). */
async function startApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: EXE, args: [`--proxy-server=${gh.proxy}`], chromiumSandbox: true, timeout: 120_000 })
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForSelector('.shell', { timeout: 120_000 })
  return { app, page }
}

/** Writes the requests of one scenario (from its first) to out/ and returns them. */
async function report(name: string, from: number) {
  const reqs = (await gh.requests()).slice(from)
  writeFileSync(join(OUT, `${KIND}-${name}-requests.txt`), describe(reqs).join('\n') + '\n')
  return reqs
}

test(`${KIND}: ${OLD} finds ${NEW}, and Download opens its release page`, async () => {
  const before = (await gh.requests()).length
  const { app, page } = await startApp()
  try {
    expect(await version(app)).toBe(OLD)
    // Where Download goes, without starting a browser on the runner.
    await app.evaluate(({ shell }) => {
      const opened: string[] = []
      ;(globalThis as { rehearsalOpened?: string[] }).rehearsalOpened = opened
      shell.openExternal = async (url: string) => {
        opened.push(url)
      }
    })
    await checkFromHelpMenu(page)
    const card = updateCard(page)
    // The old app's card, in its own name, about the new version.
    await expect(card).toContainText(cardText(OLD, NEW, 'available'), { timeout: 60_000 })
    await expect(card).toContainText('Opens the download page on GitHub.')
    await shot(page, `${KIND}-available`)
    await card.getByRole('button', { name: 'Download' }).click()
    await expect.poll(() => app.evaluate(() => (globalThis as { rehearsalOpened?: string[] }).rehearsalOpened)).toEqual([RELEASE_PAGE])
  } finally {
    await app.close().catch(() => {})
  }
  const reqs = await report('notify', before)
  const others = otherHosts(reqs)
  console.log(`${OLD} contacted besides GitHub: ${others.join(', ') || 'nothing'}`)
  expect(others.filter((h) => /github/.test(h))).toEqual([])
  if (contactsOnlyGitHub(OLD)) expect(others).toEqual([])
  // Found through github.com's latest-release redirect; nothing was downloaded.
  expect(reqs.some((r) => r.host === 'github.com' && r.path === '/normiecore/Fartcrobat/releases/latest')).toBe(true)
  expect(reqs.filter((r) => r.host === 'release-assets.githubusercontent.com' || /\/releases\/download\//.test(r.path ?? ''))).toEqual([])
})

test(`${KIND}: autoUpdate off in ${POLICY}: no request reaches GitHub`, async () => {
  asAdministrator(POLICY, JSON.stringify({ autoUpdate: { enabled: false } }))
  const before = (await gh.requests()).length
  try {
    const { app, page } = await startApp()
    await expectUpdatesManaged(page)
    await shot(page, `${KIND}-policy`)
    // Past the automatic check, which comes 30 s after start.
    await new Promise((r) => setTimeout(r, 40_000))
    await app.close().catch(() => {})
    const reqs = await report('policy-off', before)
    expect(reqs.filter((r) => r.host === 'github.com' || r.host === 'release-assets.githubusercontent.com')).toEqual([])
  } finally {
    asAdministrator(POLICY, null)
  }
})
