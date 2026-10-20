// Update rehearsal for the installs that tell people about a new version but do not install it
// (README.md): the Mac app from the released .dmg (until releases are Developer ID signed) and the
// Linux .deb. The released app, installed for real, finds the next version on a fake GitHub
// (fake-github.mjs); Download opens that release's page, where the person downloads the new file;
// the machine policy turns it all off. Run by .github/workflows/update-rehearsal.yml (jobs mac and
// deb), which install the app and trust the test certificate first.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkFromHelpMenu, contactsOnlyGitHub, describe, env, otherHosts, shot, startFakeGitHub, updateCard, version, type FakeGitHub } from './common'

const WORK = env('REHEARSAL_WORK')
const OLD = env('REHEARSAL_OLD')
const NEW = env('REHEARSAL_NEW')
/** The installed app: /Applications/Fartcrobat.app/Contents/MacOS/Fartcrobat or /opt/Fartcrobat/fartcrobat. */
const EXE = env('REHEARSAL_EXE')
const KIND = env('REHEARSAL_KIND') as 'mac' | 'deb'
const POLICY = KIND === 'mac' ? '/Library/Application Support/Fartcrobat/policy.json' : '/etc/fartcrobat/policy.json'
const RELEASES = join(WORK, 'releases')
const OUT = join(WORK, 'out')
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

/** Writes (or with null, deletes) a file only an administrator may change. The runners have sudo without a password. */
function asAdministrator(file: string, text: string | null) {
  const root = process.getuid?.() === 0
  const run = (cmd: string, args: string[], input?: string) =>
    execFileSync(root ? cmd : 'sudo', root ? args : ['-n', cmd, ...args], { input, stdio: ['pipe', 'ignore', 'inherit'] })
  if (text === null) return run('rm', ['-f', file])
  run('mkdir', ['-p', dirname(file)])
  run('tee', [file], text)
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
    await expect(card).toContainText(`Fartcrobat ${NEW} is available.`, { timeout: 60_000 })
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
    await checkFromHelpMenu(page)
    await expect(page.locator('.toast', { hasText: 'Updates are managed by your organization.' })).toBeVisible()
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
