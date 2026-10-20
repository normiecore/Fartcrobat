// Update rehearsal for the Linux AppImage (README.md): the released AppImage of the previous
// version, installed in a test user's home, updates itself from a fake GitHub (fake-github.mjs) to
// a build of the next version. Run through linux.sh, which prepares the user, the releases and the
// test certificate, and sets the REHEARSAL_* variables.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync, type ChildProcess } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkFromHelpMenu,
  contactsOnlyGitHub,
  describe,
  downloadSummary,
  downloadUpdate,
  HERE,
  env,
  otherHosts,
  otherHostsAfter,
  sha512,
  shot,
  startFakeGitHub,
  updateCard,
  version,
  ymlSha512,
  type FakeGitHub
} from './common'

const WORK = env('REHEARSAL_WORK')
const USER = env('REHEARSAL_USER')
const HOME = env('REHEARSAL_HOME')
const OLD = env('REHEARSAL_OLD')
const NEW = env('REHEARSAL_NEW')
/** Where the person keeps the AppImage, and the released file of the old version. */
const INSTALLED = join(HOME, 'Applications', 'Fartcrobat-x86_64.AppImage')
const RELEASES = join(WORK, 'releases')
const OLD_APPIMAGE = join(RELEASES, `v${OLD}`, 'Fartcrobat-x86_64.AppImage')
const NEW_SHA = ymlSha512(join(RELEASES, `v${NEW}`, 'latest-linux.yml'))
const DOCUMENT = join(HOME, 'rehearsal', 'notes.pdf')
const POLICY = '/etc/fartcrobat/policy.json'

test.describe.configure({ mode: 'serial' })
test.setTimeout(8 * 60_000)

let gh: FakeGitHub
test.beforeAll(async () => {
  gh = await startFakeGitHub({
    releases: RELEASES,
    latest: `v${NEW}`,
    cert: join(WORK, 'tls', 'server.pem'),
    key: join(WORK, 'tls', 'server.key'),
    log: join(WORK, 'requests.jsonl')
  })
})
test.afterAll(() => gh?.stop())

/** The person's machine before each scenario: the old AppImage, no settings, no update cache, nothing running. */
function freshInstall() {
  killApps()
  mkdirSync(join(HOME, 'Applications'), { recursive: true })
  copyFileSync(OLD_APPIMAGE, INSTALLED)
  chmodSync(INSTALLED, 0o755)
  for (const dir of ['.config/Fartcrobat', '.cache/fartcrobat-updater']) rmSync(join(HOME, dir), { recursive: true, force: true })
  mkdirSync(join(HOME, 'rehearsal'), { recursive: true })
  copyFileSync(join(HERE, '..', 'fixtures', 'text.pdf'), DOCUMENT)
  execFileSync('chown', ['-R', `${USER}:${USER}`, join(HOME, 'Applications'), join(HOME, 'rehearsal')])
  rmSync(POLICY, { force: true })
}

function killApps() {
  try {
    execFileSync('pkill', ['-KILL', '-u', USER], { stdio: 'ignore' })
  } catch {}
}

/** The test user's Fartcrobat processes: pid and command line. */
function appProcesses(): { pid: number; args: string }[] {
  let out = ''
  try {
    out = execFileSync('ps', ['-u', USER, '-o', 'pid=,args='], { encoding: 'utf8' })
  } catch {}
  return out
    .split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => !!m && /appimage_extracted_|Fartcrobat-x86_64\.AppImage/.test(m[2]))
    .map((m) => ({ pid: Number(m[1]), args: m[2] }))
}

/**
 * Starts the installed AppImage as the test user, as from a desktop: no extra flags, a clean
 * environment, the proxy (which the update's relaunch inherits) pointing at the fake GitHub.
 */
async function startApp(): Promise<{ app: ElectronApplication; page: Page; proc: ChildProcess }> {
  const launcher = join(WORK, 'launch-as-user.sh')
  writeFileSync(
    launcher,
    [
      '#!/bin/sh',
      `exec runuser -u ${USER} -- env -i HOME=${HOME} USER=${USER} PATH=/usr/bin:/bin DISPLAY="$DISPLAY" ` +
        `APPIMAGE_EXTRACT_AND_RUN=1 https_proxy=${gh.proxy} ${INSTALLED} "$@"`,
      ''
    ].join('\n')
  )
  chmodSync(launcher, 0o755)
  // With Chromium's sandbox, as from a desktop (Playwright turns it off on Linux by default).
  const app = await electron.launch({ executablePath: launcher, args: [], chromiumSandbox: true, timeout: 120_000 })
  const page = await app.firstWindow({ timeout: 120_000 })
  await page.waitForSelector('.shell', { timeout: 120_000 })
  // Kept: Playwright drops the ElectronApplication's process once it is closed.
  return { app, page, proc: app.process() }
}

async function waitForExit(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()))
}

/** Writes the requests of one scenario (from its first) to out/<name>-requests.txt and returns them. */
async function report(name: string, from: number) {
  const reqs = (await gh.requests()).slice(from)
  writeFileSync(join(WORK, 'out', `${name}-requests.txt`), describe(reqs).join('\n') + '\n')
  return reqs
}

test(`Restart now: ${OLD} asks about unsaved changes, then replaces its AppImage and starts ${NEW}`, async () => {
  freshInstall()
  const before = (await gh.requests()).length
  const { app, page, proc } = await startApp()
  expect(await version(app)).toBe(OLD)
  const oldExe = appProcesses().map((p) => p.args)
  await checkFromHelpMenu(page)
  await downloadUpdate(page, NEW)
  await shot(page, 'appimage-ready')

  // An unsaved document: Restart now goes through the normal quit flow and Cancel stops it.
  await page.evaluate((p) => (window as any).__fartcrobat.openPaths([p]), DOCUMENT)
  await page.waitForSelector('.viewer-page canvas')
  await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().core.doc.markDirty())
  const card = updateCard(page)
  await card.getByRole('button', { name: 'Restart now' }).click()
  const ask = page.getByRole('dialog', { name: 'Save changes?' })
  await expect(ask).toBeVisible()
  await shot(page, 'appimage-asks')
  await ask.getByRole('button', { name: 'Cancel' }).click()
  await expect(ask).toBeHidden()
  await expect(card).toContainText(`Fartcrobat ${NEW} is ready to install.`)
  expect(await sha512(INSTALLED)).toBe(ymlSha512(join(RELEASES, `v${OLD}`, 'latest-linux.yml')))

  // Restart now, Don't Save: the AppImage is replaced in place and the new version starts.
  await card.getByRole('button', { name: 'Restart now' }).click()
  await ask.getByRole('button', { name: "Don't Save" }).click()
  await waitForExit(proc)
  await expect.poll(() => sha512(INSTALLED), { timeout: 120_000 }).toBe(NEW_SHA)
  await expect
    .poll(() => appProcesses().filter((p) => !oldExe.includes(p.args)).length, { timeout: 120_000 })
    .toBeGreaterThan(0)
  // Still running a few seconds later (it did not crash on start).
  await new Promise((r) => setTimeout(r, 5000))
  expect(appProcesses().length).toBeGreaterThan(0)
  killApps()

  const reqs = await report('restart-now', before)
  // The release was found and downloaded from GitHub only, and in parts (differential download).
  // Other hosts the app tried are refused and listed in out/ (common.ts, contactsOnlyGitHub).
  const others = otherHosts(reqs)
  writeFileSync(join(WORK, 'out', 'other-hosts.txt'), others.join('\n') + '\n')
  console.log(`${OLD} contacted besides GitHub: ${others.join(', ') || 'nothing'}`)
  expect(others.filter((h) => /github/.test(h))).toEqual([])
  if (contactsOnlyGitHub(OLD)) expect(others).toEqual([])
  expect(reqs.some((r) => r.path?.endsWith(`/releases/download/v${NEW}/latest-linux.yml`))).toBe(true)
  const download = downloadSummary(
    reqs.filter((r) => r.host === 'release-assets.githubusercontent.com' && r.path?.endsWith('.AppImage'))
  )
  writeFileSync(join(WORK, 'out', 'restart-now-download.txt'), download.text + '\n')
  console.log(`Download: ${download.text}`)
  expect(download.differential, download.text).toBe(true)

  // The new version, started again: it is NEW, up to date, and asks nobody but GitHub.
  const fromNew = (await gh.requests()).length
  const startedAt = Date.now()
  const again = await startApp()
  try {
    expect(await version(again.app)).toBe(NEW)
    await checkFromHelpMenu(again.page)
    await expect(again.page.locator('.toast', { hasText: /up to date/i })).toBeVisible({ timeout: 60_000 })
    await shot(again.page, 'appimage-new-up-to-date')
    expect(await otherHostsAfter(gh, fromNew, startedAt), `${NEW} contacted hosts other than GitHub`).toEqual([])
  } finally {
    await again.app.close().catch(() => {})
    killApps()
  }
})

test(`Later: the update installs when Fartcrobat quits, without starting ${NEW}`, async () => {
  freshInstall()
  const { app, page, proc } = await startApp()
  await checkFromHelpMenu(page)
  await downloadUpdate(page, NEW)
  await updateCard(page).getByRole('button', { name: 'Later' }).click()
  await expect(updateCard(page)).toBeHidden()
  await app.close()
  await waitForExit(proc)
  await expect.poll(() => sha512(INSTALLED), { timeout: 120_000 }).toBe(NEW_SHA)
  // Nothing started afterwards.
  await new Promise((r) => setTimeout(r, 8000))
  expect(appProcesses()).toEqual([])
})

test('a download that does not match its published checksum is refused, and the AppImage is left alone', async () => {
  test.skip(!existsSync(join(RELEASES, 'v99.0.0')), 'linux.sh makes the release v99.0.0 with a wrong checksum')
  freshInstall()
  await gh.setLatest('v99.0.0')
  try {
    const { app, page, proc } = await startApp()
    await checkFromHelpMenu(page)
    const card = updateCard(page)
    await expect(card).toContainText('Fartcrobat 99.0.0 is available.', { timeout: 60_000 })
    await card.getByRole('button', { name: 'Download' }).click()
    await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible({ timeout: 240_000 })
    // Refused for its checksum, not for any other failure (all of which also offer Try again).
    await expect(card).toContainText('The downloaded update was damaged.')
    await shot(page, 'appimage-tampered')
    await app.close().catch(() => {})
    await waitForExit(proc)
    expect(await sha512(INSTALLED)).toBe(ymlSha512(join(RELEASES, `v${OLD}`, 'latest-linux.yml')))
  } finally {
    await gh.setLatest(`v${NEW}`)
    killApps()
  }
})

test('autoUpdate off in policy.json: no request reaches GitHub', async () => {
  freshInstall()
  mkdirSync('/etc/fartcrobat', { recursive: true })
  writeFileSync(POLICY, JSON.stringify({ autoUpdate: { enabled: false } }))
  const before = (await gh.requests()).length
  try {
    const { app, page } = await startApp()
    await checkFromHelpMenu(page)
    await expect(page.locator('.toast', { hasText: 'Updates are managed by your organization.' })).toBeVisible()
    // Past the automatic check, which comes 30 s after start.
    await new Promise((r) => setTimeout(r, 40_000))
    await app.close().catch(() => {})
    const reqs = await report('policy-off', before)
    expect(reqs.filter((r) => r.host === 'github.com' || r.host === 'release-assets.githubusercontent.com')).toEqual([])
  } finally {
    rmSync(POLICY, { force: true })
    killApps()
  }
})
