// Update rehearsal for the Windows installer (README.md), run by .github/workflows/update-rehearsal.yml
// on a windows-latest runner: the released installer of the previous version, installed silently
// per user or per machine, updates the app from a fake GitHub (fake-github.mjs) to a build of the
// next version. One scenario per job (REHEARSAL_SCENARIO), each on a fresh runner.
// REHEARSAL_INSTALLER picks the installer that was run: x64 (the file people download), or
// combined, the installer for both processors that 0.2.0 also shipped.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { checkFromHelpMenu, describe, downloadSummary, downloadUpdate, env, HERE, shot, startFakeGitHub, updateCard, version, type FakeGitHub } from './common'

const WORK = env('REHEARSAL_WORK')
const OLD = env('REHEARSAL_OLD')
const NEW = env('REHEARSAL_NEW')
const SCOPE = env('REHEARSAL_SCOPE') as 'user' | 'machine'
const SCENARIO = env('REHEARSAL_SCENARIO') as 'restart' | 'later' | 'policy'
const INSTALLER = (process.env.REHEARSAL_INSTALLER ?? 'x64') as 'x64' | 'combined'
const RELEASES = join(WORK, 'releases')
const INSTALLER_FILE = join(RELEASES, `v${OLD}`, INSTALLER === 'x64' ? `Fartcrobat-Setup-${OLD}-x64.exe` : `Fartcrobat-Setup-${OLD}.exe`)
const NAME = `${SCOPE}-${SCENARIO}-${INSTALLER}`
const OUT = join(WORK, 'out')
const UNINSTALL = `${SCOPE === 'machine' ? 'HKLM' : 'HKCU'}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`
const POLICY_KEY = 'HKLM\\SOFTWARE\\Policies\\Fartcrobat'

test.skip(process.platform !== 'win32', 'Windows only')
test.skip(process.platform === 'win32' && !existsSync(INSTALLER_FILE), `${OLD} has no ${INSTALLER} installer`)
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
  await install()
})
test.afterAll(() => {
  gh?.stop()
  killApps()
})

/** The released installer of OLD, run silently as an administrator deploying it would. */
async function install() {
  execFileSync(INSTALLER_FILE, SCOPE === 'machine' ? ['/S', '/allusers'] : ['/S'], { stdio: 'inherit', timeout: 10 * 60_000 })
  await expect
    .poll(() => installed()?.version, { timeout: 60_000 })
    .toBe(OLD)
    .catch((err: Error) => {
      throw new Error(`The ${OLD} installer left no entry for this scope:\n${uninstallEntries()}\n\n${err.message}`)
    })
  // The installer may start the app when it finishes; the scenarios start it themselves.
  killApps()
}

function reg(args: string[]): string {
  try {
    return execFileSync('reg', ['query', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

/** The Programs and Features entries that mention Fartcrobat, in both scopes (for error messages). */
function uninstallEntries(): string {
  return ['HKCU', 'HKLM']
    .map((root) => reg([`${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`, '/s', '/f', 'Fartcrobat']).trim() || `${root}: none`)
    .join('\n')
}

/**
 * Fartcrobat's entry under Programs and Features for this scope: where it is and which version.
 * electron-builder keeps InstallLocation in its own key (Software\<app GUID>), so the folder comes
 * from the uninstaller's path, which is in it.
 */
function installed(): { location: string; version: string } | null {
  // The keys with "Fartcrobat" in their data, then each key's values.
  const keys = reg([UNINSTALL, '/s', '/f', 'Fartcrobat', '/d'])
    .split(/\r?\n/)
    .filter((l) => l.startsWith('HKEY_'))
  for (const key of keys) {
    const values = reg([key])
    const value = (name: string) => new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(values)?.[1]?.trim()
    if (!/^Fartcrobat\b/.test(value('DisplayName') ?? '')) continue
    const uninstaller = /^"([^"]+)"/.exec(value('UninstallString') ?? '')?.[1]
    const ver = value('DisplayVersion')
    if (uninstaller && ver) return { location: dirname(uninstaller), version: ver }
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

/**
 * Writes what the app asked the fake GitHub, and how it downloaded the installer. An install keeps
 * the installer it ran for the next update's differential download, but the updater picks the x64
 * installer and its blockmap: an install made with the combined installer gets a full download
 * once (README.md).
 */
async function report() {
  const reqs = await gh.requests()
  writeFileSync(join(OUT, `${NAME}-requests.txt`), describe(reqs).join('\n') + '\n')
  const download = downloadSummary(reqs.filter((r) => r.host === 'release-assets.githubusercontent.com' && /\.exe$/.test(r.path ?? '')))
  writeFileSync(join(OUT, `${NAME}-download.txt`), download.text + '\n')
  console.log(`Download: ${download.text}`)
  return { reqs, download }
}

test(`${SCOPE}, ${INSTALLER} installer: Restart now asks about unsaved changes, then installs ${NEW} and starts it`, async () => {
  test.skip(SCENARIO !== 'restart')
  const { app, page, proc } = await startApp()
  expect(await version(app)).toBe(OLD)
  await checkFromHelpMenu(page)
  await downloadUpdate(page, NEW)
  await shot(page, `${NAME}-ready`)

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

  const { reqs, download } = await report()
  expect(reqs.filter((r) => r.refused && /github/.test(r.host ?? ''))).toEqual([])
  expect(reqs.some((r) => r.path?.endsWith(`/releases/download/v${NEW}/latest.yml`))).toBe(true)
  expect(download.text).toContain(`Fartcrobat-Setup-${NEW}-x64.exe:`)
  if (INSTALLER === 'x64') expect(download.differential, download.text).toBe(true)

  const again = await startApp()
  try {
    expect(await version(again.app)).toBe(NEW)
    await checkFromHelpMenu(again.page)
    await expect(again.page.locator('.toast', { hasText: /up to date/i })).toBeVisible({ timeout: 60_000 })
    await shot(again.page, `${NAME}-new-up-to-date`)
  } finally {
    await again.app.close().catch(() => {})
    killApps()
  }
})

test(`${SCOPE}, ${INSTALLER} installer: Later installs ${NEW} when Fartcrobat quits, without starting it`, async () => {
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

test(`${SCOPE}, ${INSTALLER} installer: AutoUpdate=0 under ${POLICY_KEY}: no request reaches GitHub`, async () => {
  test.skip(SCENARIO !== 'policy')
  execFileSync('reg', ['add', POLICY_KEY, '/v', 'AutoUpdate', '/t', 'REG_DWORD', '/d', '0', '/f'], { stdio: 'inherit' })
  try {
    const { app, page } = await startApp()
    await checkFromHelpMenu(page)
    await expect(page.locator('.toast', { hasText: 'Updates are managed by your organization.' })).toBeVisible()
    await shot(page, `${NAME}`)
    await new Promise((r) => setTimeout(r, 40_000))
    await app.close().catch(() => {})
    const { reqs } = await report()
    expect(reqs.filter((r) => r.host === 'github.com' || r.host === 'release-assets.githubusercontent.com')).toEqual([])
  } finally {
    execFileSync('reg', ['delete', POLICY_KEY, '/f'], { stdio: 'ignore' })
  }
})
