// Update rehearsal for the Windows installer (README.md), run by .github/workflows/update-rehearsal.yml
// on a windows-latest runner: the released installer of the previous version, installed silently
// per user or per machine, updates the app from a fake GitHub (fake-github.mjs) to a build of the
// next version. One scenario per job (REHEARSAL_SCENARIO), each on a fresh runner.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkFromHelpMenu, describe, downloadUpdate, env, HERE, shot, startFakeGitHub, updateCard, version, type FakeGitHub } from './common'

const WORK = env('REHEARSAL_WORK')
const OLD = env('REHEARSAL_OLD')
const NEW = env('REHEARSAL_NEW')
const SCOPE = env('REHEARSAL_SCOPE') as 'user' | 'machine'
const SCENARIO = env('REHEARSAL_SCENARIO') as 'restart' | 'later' | 'policy'
const RELEASES = join(WORK, 'releases')
const OUT = join(WORK, 'out')
const UNINSTALL = `${SCOPE === 'machine' ? 'HKLM' : 'HKCU'}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`
const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Fartcrobat'

test.skip(process.platform !== 'win32', 'Windows only')
test.setTimeout(15 * 60_000)

let gh: FakeGitHub
test.beforeAll(async () => {
  mkdirSync(OUT, { recursive: true })
  gh = await startFakeGitHub({
    releases: RELEASES,
    latest: `v${NEW}`,
    cert: join(WORK, 'tls', 'server.pem'),
    key: join(WORK, 'tls', 'server.key'),
    log: join(OUT, 'requests.jsonl')
  })
  install()
})
test.afterAll(() => {
  gh?.stop()
  killApps()
})

/** The released installer of OLD, run silently as an administrator deploying it would. */
function install() {
  const installer = join(RELEASES, `v${OLD}`, `Fartcrobat-Setup-${OLD}.exe`)
  execFileSync(installer, SCOPE === 'machine' ? ['/S', '/allusers'] : ['/S'], { stdio: 'inherit', timeout: 10 * 60_000 })
  // The installer may start the app when it finishes; the scenarios start it themselves.
  killApps()
  const found = installed()
  if (found?.version !== OLD) throw new Error(`The ${OLD} installer left ${JSON.stringify(found)}`)
}

/** Fartcrobat's entry under Programs and Features for this scope: where it is and which version. */
function installed(): { location: string; version: string } | null {
  const query = (args: string[]) => {
    try {
      return execFileSync('reg', ['query', ...args], { encoding: 'utf8' })
    } catch {
      return ''
    }
  }
  // The keys with "Fartcrobat" in their data, then each key's values.
  const keys = query([UNINSTALL, '/s', '/f', 'Fartcrobat', '/d'])
    .split(/\r?\n/)
    .filter((l) => l.startsWith('HKEY_'))
  for (const key of keys) {
    const values = query([key])
    const value = (name: string) => new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(values)?.[1]?.trim()
    if (!/^Fartcrobat\b/.test(value('DisplayName') ?? '')) continue
    const location = value('InstallLocation')?.replace(/^"|"$/g, '')
    const ver = value('DisplayVersion')
    if (location && ver) return { location, version: ver }
  }
  return null
}

function exe(): string {
  const found = installed()
  if (!found) throw new Error('Fartcrobat is not installed')
  return join(found.location, 'Fartcrobat.exe')
}

function running(): number {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Fartcrobat.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    return out.split(/\r?\n/).filter((l) => l.startsWith('"Fartcrobat.exe"')).length
  } catch {
    return 0
  }
}

function killApps() {
  try {
    execFileSync('taskkill', ['/F', '/T', '/IM', 'Fartcrobat.exe'], { stdio: 'ignore' })
  } catch {}
}

/**
 * Starts the installed app as the Start menu would, but through the fake GitHub: Chromium on
 * Windows takes its proxy from the system settings, which the runner itself needs, so the proxy
 * comes on the command line. The update's own restart does not pass it on (it then reaches the
 * real github.com, which only matters to its next check).
 */
async function startApp(): Promise<{ app: ElectronApplication; page: Page; proc: ChildProcess }> {
  const app = await electron.launch({ executablePath: exe(), args: [`--proxy-server=${gh.proxy}`], timeout: 120_000 })
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForSelector('.shell', { timeout: 120_000 })
  return { app, page, proc: app.process() }
}

async function waitForExit(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()))
}

async function report() {
  const reqs = await gh.requests()
  writeFileSync(join(OUT, `${SCOPE}-${SCENARIO}-requests.txt`), describe(reqs).join('\n') + '\n')
  const parts = reqs.filter((r) => r.host === 'release-assets.githubusercontent.com' && /\.exe$/.test(r.path ?? ''))
  writeFileSync(
    join(OUT, `${SCOPE}-${SCENARIO}-download.txt`),
    `${[...new Set(parts.map((r) => r.path?.split('/').pop()))].join(', ')}: ${parts.length} requests, ` +
      `${parts.reduce((n, r) => n + (r.bytes ?? 0), 0)} bytes, statuses ${[...new Set(parts.map((r) => r.status))].join(',')}\n`
  )
  return reqs
}

test(`${SCOPE}: Restart now asks about unsaved changes, then installs ${NEW} and starts it`, async () => {
  test.skip(SCENARIO !== 'restart')
  const { app, page, proc } = await startApp()
  expect(await version(app)).toBe(OLD)
  await checkFromHelpMenu(page)
  await downloadUpdate(page, NEW)
  await shot(page, `${SCOPE}-ready`)

  const document = join(WORK, 'notes.pdf')
  if (!existsSync(document)) copyFileSync(join(HERE, '..', 'fixtures', 'text.pdf'), document)
  await page.evaluate((p) => (window as any).__fartcrobat.openPaths([p]), document)
  await page.waitForSelector('.viewer-page canvas')
  await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().core.doc.markDirty())
  const card = updateCard(page)
  await card.getByRole('button', { name: 'Restart now' }).click()
  const ask = page.getByRole('dialog', { name: 'Save changes?' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(card).toContainText(`Fartcrobat ${NEW} is ready to install.`)
  expect(installed()?.version).toBe(OLD)

  await card.getByRole('button', { name: 'Restart now' }).click()
  await ask.getByRole('button', { name: "Don't Save" }).click()
  await waitForExit(proc)
  await expect.poll(() => installed()?.version, { timeout: 10 * 60_000, intervals: [2000] }).toBe(NEW)
  await expect.poll(running, { timeout: 120_000 }).toBeGreaterThan(0)
  await new Promise((r) => setTimeout(r, 5000))
  expect(running()).toBeGreaterThan(0)
  killApps()

  const reqs = await report()
  expect(reqs.filter((r) => r.refused && /github/.test(r.host ?? ''))).toEqual([])
  expect(reqs.some((r) => r.path?.endsWith(`/releases/download/v${NEW}/latest.yml`))).toBe(true)

  const again = await startApp()
  try {
    expect(await version(again.app)).toBe(NEW)
    await checkFromHelpMenu(again.page)
    await expect(again.page.locator('.toast', { hasText: /up to date/i })).toBeVisible({ timeout: 60_000 })
    await shot(again.page, `${SCOPE}-new-up-to-date`)
  } finally {
    await again.app.close().catch(() => {})
    killApps()
  }
})

test(`${SCOPE}: Later installs ${NEW} when Fartcrobat quits, without starting it`, async () => {
  test.skip(SCENARIO !== 'later')
  const { app, page, proc } = await startApp()
  await checkFromHelpMenu(page)
  await downloadUpdate(page, NEW)
  await updateCard(page).getByRole('button', { name: 'Later' }).click()
  await expect(updateCard(page)).toBeHidden()
  await app.close()
  await waitForExit(proc)
  await expect.poll(() => installed()?.version, { timeout: 10 * 60_000, intervals: [2000] }).toBe(NEW)
  await new Promise((r) => setTimeout(r, 10_000))
  expect(running()).toBe(0)
  await report()
})

test(`${SCOPE}: AutoUpdate=0 under ${POLICY_KEY}: no request reaches GitHub`, async () => {
  test.skip(SCENARIO !== 'policy')
  execFileSync('reg', ['add', POLICY_KEY, '/v', 'AutoUpdate', '/t', 'REG_DWORD', '/d', '0', '/f'], { stdio: 'inherit' })
  try {
    const { app, page } = await startApp()
    await checkFromHelpMenu(page)
    await expect(page.locator('.toast', { hasText: 'Updates are managed by your organization.' })).toBeVisible()
    await shot(page, `${SCOPE}-policy`)
    await new Promise((r) => setTimeout(r, 40_000))
    await app.close().catch(() => {})
    const reqs = await report()
    expect(reqs.filter((r) => r.host === 'github.com' || r.host === 'release-assets.githubusercontent.com')).toEqual([])
  } finally {
    execFileSync('reg', ['delete', POLICY_KEY, '/f'], { stdio: 'ignore' })
  }
})
