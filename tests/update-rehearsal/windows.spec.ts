// Update rehearsal for the Windows installer (README.md), run by .github/workflows/update-rehearsal.yml
// on a windows-latest runner: the released installer of the previous version, installed silently
// per user or per machine, updates the app from a fake GitHub (fake-github.mjs) to a build of the
// next version. One scenario per job (REHEARSAL_SCENARIO), each on a fresh runner.
// REHEARSAL_INSTALLER picks the installer that was run: x64 (the file people download), or
// combined, the installer for both processors that 0.2.0 also shipped.
// The old version may be called Fartcrobat and the new one Inkmoor (names.mjs): the update keeps the
// install folder, the Programs and Features entry (the same NSIS GUID) and the userData folder, and
// replaces Fartcrobat.exe with Inkmoor.exe in that folder.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import {
  ALL_NAMES,
  cardText,
  checkFromHelpMenu,
  contactsOnlyGitHub,
  describe,
  downloadSummary,
  downloadUpdate,
  env,
  expectUpdatesManaged,
  HERE,
  openUnsavedDocument,
  otherHosts,
  otherHostsAfter,
  productFor,
  shot,
  startFakeGitHub,
  updateCard,
  userDataPath,
  version,
  type FakeGitHub
} from './common'

const WORK = env('REHEARSAL_WORK')
const OLD = env('REHEARSAL_OLD')
const NEW = env('REHEARSAL_NEW')
const SCOPE = env('REHEARSAL_SCOPE') as 'user' | 'machine'
const SCENARIO = env('REHEARSAL_SCENARIO') as 'restart' | 'later' | 'policy'
const INSTALLER = (process.env.REHEARSAL_INSTALLER ?? 'x64') as 'x64' | 'combined'
/** The names of the installed release and of the build it updates to (names.mjs). */
const OLD_NAMES = productFor(OLD)
const NEW_NAMES = productFor(NEW)
const RELEASES = join(WORK, 'releases')
const INSTALLER_FILE = join(RELEASES, `v${OLD}`, INSTALLER === 'x64' ? OLD_NAMES.winSetupX64 : OLD_NAMES.winSetupCombined)
const NAME = `${SCOPE}-${SCENARIO}-${INSTALLER}`
const OUT = join(WORK, 'out')
const ROOT = SCOPE === 'machine' ? 'HKLM' : 'HKCU'
const uninstallKey = (root: string) => `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall`

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
  // Not execFileSync: a per-machine install takes long enough that blocking would starve the hook's timers.
  await promisify(execFile)(INSTALLER_FILE, SCOPE === 'machine' ? ['/S', '/allusers'] : ['/S'], { timeout: 10 * 60_000 })
  await expect
    .poll(() => installed()?.version, { timeout: 120_000, intervals: [1000] })
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

/** The Programs and Features keys that mention either name, in both scopes (for error messages). */
function uninstallEntries(): string {
  return ['HKCU', 'HKLM']
    .map((root) => {
      const found = ALL_NAMES.map((name) => reg([uninstallKey(root), '/s', '/f', name]).trim()).filter(Boolean)
      return found.join('\n') || `${root}: none`
    })
    .join('\n')
}

interface Entry {
  root: string
  key: string
  displayName: string
  location: string
  version: string
}

/**
 * The app's entries under Programs and Features, under either name, in both scopes (or in `roots`):
 * where each install is and which version. electron-builder keeps InstallLocation in its own key
 * (Software\<app GUID>), so the folder comes from the uninstaller's path, which is in it.
 */
function entries(roots = ['HKCU', 'HKLM']): Entry[] {
  const found: Entry[] = []
  for (const root of roots) {
    // The keys with either name in their data, then each key's values.
    const keys = new Set(
      ALL_NAMES.flatMap((name) => reg([uninstallKey(root), '/s', '/f', name, '/d']).split(/\r?\n/)).filter((l) => l.startsWith('HKEY_'))
    )
    for (const key of keys) {
      const values = reg([key])
      const value = (name: string) => new RegExp(`^\\s+${name}\\s+REG_\\w+\\s+(.*)$`, 'm').exec(values)?.[1]?.trim()
      const displayName = value('DisplayName') ?? ''
      if (!ALL_NAMES.some((name) => new RegExp(`^${name}\\b`).test(displayName))) continue
      const uninstaller = /^"([^"]+)"/.exec(value('UninstallString') ?? '')?.[1]
      const ver = value('DisplayVersion')
      if (uninstaller && ver) found.push({ root, key, displayName, location: dirname(uninstaller), version: ver })
    }
  }
  return found
}

/** The app's entry for this scope. */
function installed(): Entry | null {
  return entries([ROOT])[0] ?? null
}

/** The installed executable: Fartcrobat.exe or Inkmoor.exe, by the installed version, in the install folder. */
function exe(): string {
  const found = installed()
  if (!found) throw new Error('The app is not installed')
  return join(found.location, productFor(found.version).winExe)
}

/**
 * After the update: one entry in Programs and Features, for NEW under its name, in the same scope
 * and folder as the install it replaced, and the folder holds the new executable instead of the old.
 */
function expectUpdatedInPlace(before: Entry) {
  const after = entries()
  expect(after.length, `Programs and Features after the update:\n${uninstallEntries()}`).toBe(1)
  expect(after[0].root).toBe(before.root)
  expect(after[0].key).toBe(before.key)
  expect(after[0].version).toBe(NEW)
  expect(after[0].displayName).toMatch(new RegExp(`^${NEW_NAMES.name}\\b`))
  expect(after[0].location.toLowerCase()).toBe(before.location.toLowerCase())
  expect(existsSync(join(before.location, NEW_NAMES.winExe)), `${NEW_NAMES.winExe} in ${before.location}`).toBe(true)
  if (OLD_NAMES.winExe !== NEW_NAMES.winExe)
    expect(existsSync(join(before.location, OLD_NAMES.winExe)), `${OLD_NAMES.winExe} left in ${before.location}`).toBe(false)
}

/** How many processes of one executable (Fartcrobat.exe, Inkmoor.exe) are running. */
function running(image: string): number {
  try {
    const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' })
    return out.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(`"${image.toLowerCase()}"`)).length
  } catch {
    return 0
  }
}

/** Processes of the app under either name. */
const runningAny = () => ALL_NAMES.reduce((n, name) => n + running(`${name}.exe`), 0)

function killApps() {
  for (const name of ALL_NAMES)
    try {
      execFileSync('taskkill', ['/F', '/T', '/IM', `${name}.exe`], { stdio: 'ignore' })
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
  const before = installed()!
  const { app, page, proc } = await startApp()
  expect(await version(app)).toBe(OLD)
  const userData = await userDataPath(app)
  await checkFromHelpMenu(page)
  // The old app's card, in its own name, about the new version.
  await downloadUpdate(page, OLD, NEW)
  await shot(page, `${NAME}-ready`)

  const document = join(WORK, 'notes.pdf')
  if (!existsSync(document)) copyFileSync(join(HERE, '..', 'fixtures', 'text.pdf'), document)
  await openUnsavedDocument(page, OLD, document)
  const card = updateCard(page)
  await card.getByRole('button', { name: 'Restart now' }).click()
  const ask = page.getByRole('dialog', { name: 'Save changes?' })
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(card).toContainText(cardText(OLD, NEW, 'ready'))
  expect(installed()?.version).toBe(OLD)

  await card.getByRole('button', { name: 'Restart now' }).click()
  await ask.getByRole('button', { name: "Don't Save" }).click()
  await waitForExit(proc)
  await expect.poll(() => installed()?.version, { timeout: 10 * 60_000, intervals: [2000] }).toBe(NEW)
  // The installer starts the new executable, from the same folder.
  await expect.poll(() => running(NEW_NAMES.winExe), { timeout: 120_000 }).toBeGreaterThan(0)
  await new Promise((r) => setTimeout(r, 5000))
  expect(running(NEW_NAMES.winExe)).toBeGreaterThan(0)
  killApps()
  expectUpdatedInPlace(before)

  const { reqs, download } = await report()
  const others = otherHosts(reqs)
  console.log(`${OLD} contacted besides GitHub: ${others.join(', ') || 'nothing'}`)
  expect(others.filter((h) => /github/.test(h))).toEqual([])
  if (contactsOnlyGitHub(OLD)) expect(others).toEqual([])
  expect(reqs.some((r) => r.path?.endsWith(`/releases/download/v${NEW}/latest.yml`))).toBe(true)
  expect(download.text).toContain(`${NEW_NAMES.winSetupX64}:`)
  if (INSTALLER === 'x64') expect(download.differential, download.text).toBe(true)

  // The new version: NEW, in the old userData folder (settings kept), up to date, and asking nobody but GitHub.
  const fromNew = (await gh.requests()).length
  const startedAt = Date.now()
  const again = await startApp()
  try {
    expect(await version(again.app)).toBe(NEW)
    expect(await userDataPath(again.app)).toBe(userData)
    await checkFromHelpMenu(again.page)
    await expect(again.page.locator('.toast', { hasText: /up to date/i })).toBeVisible({ timeout: 60_000 })
    await shot(again.page, `${NAME}-new-up-to-date`)
    expect(await otherHostsAfter(gh, fromNew, startedAt), `${NEW} contacted hosts other than GitHub`).toEqual([])
  } finally {
    await again.app.close().catch(() => {})
    killApps()
  }

  // A policy deployed for the old version, under its name, still applies to the new one.
  const policyKeys = [...new Set([OLD_NAMES.winPolicyKey, NEW_NAMES.winPolicyKey])]
  execFileSync('reg', ['add', OLD_NAMES.winPolicyKey, '/v', 'AutoUpdate', '/t', 'REG_DWORD', '/d', '0', '/f'], { stdio: 'inherit' })
  try {
    const managed = await startApp()
    try {
      await expectUpdatesManaged(managed.page)
      await shot(managed.page, `${NAME}-new-old-policy`)
    } finally {
      await managed.app.close().catch(() => {})
    }
  } finally {
    for (const key of policyKeys) execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore' })
    killApps()
  }
})

test(`${SCOPE}, ${INSTALLER} installer: Later installs ${NEW} when the app quits, without starting it`, async () => {
  test.skip(SCENARIO !== 'later')
  const before = installed()!
  const { app, page, proc } = await startApp()
  await checkFromHelpMenu(page)
  await downloadUpdate(page, OLD, NEW)
  await updateCard(page).getByRole('button', { name: 'Later' }).click()
  await expect(updateCard(page)).toBeHidden()
  await app.close()
  await waitForExit(proc)
  await expect.poll(() => installed()?.version, { timeout: 10 * 60_000, intervals: [2000] }).toBe(NEW)
  await new Promise((r) => setTimeout(r, 10_000))
  expect(runningAny()).toBe(0)
  expectUpdatedInPlace(before)
  await report()
})

test(`${SCOPE}, ${INSTALLER} installer: AutoUpdate=0 under ${OLD_NAMES.winPolicyKey}: no request reaches GitHub`, async () => {
  test.skip(SCENARIO !== 'policy')
  execFileSync('reg', ['add', OLD_NAMES.winPolicyKey, '/v', 'AutoUpdate', '/t', 'REG_DWORD', '/d', '0', '/f'], { stdio: 'inherit' })
  try {
    const { app, page } = await startApp()
    await expectUpdatesManaged(page)
    await shot(page, `${NAME}`)
    await new Promise((r) => setTimeout(r, 40_000))
    await app.close().catch(() => {})
    const { reqs } = await report()
    expect(reqs.filter((r) => r.host === 'github.com' || r.host === 'release-assets.githubusercontent.com')).toEqual([])
  } finally {
    execFileSync('reg', ['delete', OLD_NAMES.winPolicyKey, '/f'], { stdio: 'ignore' })
  }
})
