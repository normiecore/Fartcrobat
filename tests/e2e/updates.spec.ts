import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UpdateStatus } from '../../src/shared/updates'
import { activeDocState, fixturePath, launch, menuItem, openFile, ROOT, runCommand } from './helpers'

// Updates end to end: a local server stands in for github.com (FARTCROBAT_UPDATE_URL) and
// FARTCROBAT_FAKE_UPDATER stands in for electron-updater, reporting download progress and writing
// the install it would run to a log file. Both work only in unpackaged builds.

/** This build's version: the server answers with it for "up to date". */
const CURRENT: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const NEW = '99.0.0'
const REPO = '/normiecore/Fartcrobat'

/** Lets windows ask about unsaved changes (launch closes them without asking). */
const ASK_ON_CLOSE = { FARTCROBAT_FORCE_CLOSE: '' }

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `test-results/updates-${name}.png`, animations: 'disabled' })

function workDir() {
  return mkdtempSync(join(tmpdir(), 'fartcrobat-updates-'))
}

interface FakeGitHub {
  /** FARTCROBAT_UPDATE_URL: stands in for https://github.com/normiecore/Fartcrobat. */
  base: string
  /** The release page /releases/latest leads to. */
  releaseUrl: (version: string) => string
  /** How /releases/latest answers: a redirect to that version's tag, a server error, or a page without a tag. */
  answer: { kind: 'latest'; version: string; absolute?: boolean } | { kind: 'error' } | { kind: 'page' }
  /** Requests for /releases/latest so far. */
  checks: () => number
  close: () => Promise<void>
}

/** github.com in miniature: /releases/latest redirects to /releases/tag/v<version>, as GitHub does. */
async function fakeGitHub(
  answer: FakeGitHub['answer'] = { kind: 'latest', version: NEW }
): Promise<FakeGitHub> {
  let checks = 0
  let origin = ''
  const gh = { answer } as FakeGitHub
  const server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url === `${REPO}/releases/latest`) {
      checks++
      const a = gh.answer
      if (a.kind === 'latest') {
        const tag = `${REPO}/releases/tag/v${a.version}`
        res.writeHead(302, { Location: a.absolute ? `${origin}${tag}` : tag })
        res.end()
      } else if (a.kind === 'error') {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('Something went wrong')
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Releases</h1>')
      }
      return
    }
    if (url.startsWith(`${REPO}/releases/tag/`)) {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<h1>Release notes</h1>')
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  gh.base = `${origin}${REPO}`
  gh.releaseUrl = (version) => `${origin}${REPO}/releases/tag/v${version}`
  gh.checks = () => checks
  gh.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return gh
}

interface FakeUpdater {
  file: string
  /** The installs the app ran, one object per line of the install log. */
  installs: () => { version: string; silent: boolean; runAfter: boolean }[]
}

function fakeUpdater(opts: { steps?: number; stepMs?: number; failDownload?: boolean } = {}): FakeUpdater {
  const dir = workDir()
  const installLog = join(dir, 'install.log')
  const file = join(dir, 'fake-updater.json')
  const config = {
    steps: opts.steps ?? 5,
    stepMs: opts.stepMs ?? 150,
    total: 1_000_000,
    failDownload: !!opts.failDownload,
    installLog
  }
  writeFileSync(file, JSON.stringify(config))
  return {
    file,
    installs: () =>
      existsSync(installLog)
        ? readFileSync(installLog, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l))
        : []
  }
}

/** Automatic checks on, the first one at once, against the fake GitHub (and the fake updater). */
function updateEnv(gh: FakeGitHub, updater?: FakeUpdater): Record<string, string> {
  return {
    FARTCROBAT_UPDATE_CHECKS: '1',
    FARTCROBAT_UPDATE_URL: gh.base,
    FARTCROBAT_UPDATE_FIRST_CHECK_MS: '0',
    ...(updater ? { FARTCROBAT_FAKE_UPDATER: updater.file } : {})
  }
}

const updateCard = (page: Page) => page.getByRole('region', { name: 'Update' })

/** The status the main process holds. */
async function updateStatus(page: Page): Promise<UpdateStatus> {
  return page.evaluate(() => (window as any).api.invoke('feature:updates:status'))
}

/** Help > Check for Updates..., the way the person finds it in the in-app Menu. */
async function checkFromHelpMenu(page: Page) {
  await page.getByRole('button', { name: 'Menu' }).click()
  await menuItem(page, /^Help$/).hover()
  await menuItem(page, 'Check for Updates...').click()
}

/** Replaces shell.openExternal in the main process, recording the URLs instead of opening a browser. */
async function recordOpenedLinks(app: ElectronApplication) {
  await app.evaluate(({ shell }) => {
    const g = globalThis as any
    g.__opened = []
    shell.openExternal = (async (url: string) => {
      g.__opened.push(url)
    }) as typeof shell.openExternal
  })
  return () => app.evaluate(() => (globalThis as any).__opened as string[])
}

async function openPreferencesAt(page: Page, section: string) {
  await page.evaluate(() => void (window as any).__fartcrobat.runCommand('app.preferences'))
  const prefs = page.getByRole('dialog', { name: 'Preferences' })
  await prefs.getByRole('button', { name: section, exact: true }).click()
  return prefs
}

async function waitForExit(app: ElectronApplication) {
  const proc = app.process()
  if (proc.exitCode !== null || proc.signalCode !== null) return
  await new Promise<void>((resolve) => proc.once('exit', () => resolve()))
}

async function closeQuietly(app: ElectronApplication) {
  try {
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))])
  } catch {}
}

// ---- finding, downloading and installing ----------------------------------------------------------

test('an automatic check finds a new version; Download shows progress; Restart now asks about unsaved changes, then installs', async () => {
  const gh = await fakeGitHub()
  const updater = fakeUpdater({ steps: 8, stepMs: 300 })
  const { app, page } = await launch([], { ...updateEnv(gh, updater), ...ASK_ON_CLOSE })
  try {
    const card = updateCard(page)
    await expect(card).toContainText(`Fartcrobat ${NEW} is available.`)
    await expect(card).toContainText(`You have ${CURRENT}.`)
    await expect(card.getByRole('button', { name: "What's new" })).toBeVisible()
    // 'install': no note about the download page.
    await expect(card).not.toContainText('Opens the download page on GitHub.')
    expect(gh.checks()).toBe(1)
    await shot(page, 'available')

    await card.getByRole('button', { name: 'Download' }).click()
    const bar = card.getByRole('progressbar')
    await expect(bar).toHaveAttribute('aria-valuemin', '0')
    await expect(bar).toHaveAttribute('aria-valuemax', '100')
    await expect(card).toContainText(`Downloading Fartcrobat ${NEW}`)
    // The bar moves: somewhere between the start and the end.
    await expect(bar).toHaveAttribute('aria-valuenow', /^[1-9]\d?$/)
    await expect(card).toContainText(/\d+% \(\d+ of 977 KB\)/)
    await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible()
    await shot(page, 'downloading')

    await expect(card).toContainText(`Fartcrobat ${NEW} is ready to install.`)
    await expect(card).toContainText('Restart Fartcrobat to finish.')
    await expect(card.getByRole('button', { name: 'Later' })).toHaveAttribute(
      'title',
      'It installs the next time you quit.'
    )
    await shot(page, 'ready')
    await page.evaluate(() =>
      (window as any).__fartcrobat.useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } }))
    )
    await shot(page, 'ready-dark')
    await page.evaluate(() =>
      (window as any).__fartcrobat.useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'light' } }))
    )

    // A document with unsaved changes: the card moves to the corner of the document area.
    await openFile(page, fixturePath('text.pdf'))
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().core.doc.markDirty())
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
    await expect(card).toContainText(`Fartcrobat ${NEW} is ready to install.`)
    await expect(page.locator('.shell-viewer-wrap').getByRole('region', { name: 'Update' })).toBeVisible()
    await shot(page, 'ready-document')

    // Restart now goes through the normal quit flow: the question about unsaved changes comes
    // first, over the card, and Cancel stops the restart. The update stays ready.
    await card.getByRole('button', { name: 'Restart now' }).click()
    const ask = page.getByRole('dialog', { name: 'Save changes?' })
    await expect(ask).toBeVisible()
    await shot(page, 'restart-asks')
    await ask.getByRole('button', { name: 'Cancel' }).click()
    await expect(ask).toBeHidden()
    expect((await activeDocState(page))?.dirty).toBe(true)
    await expect(card).toContainText(`Fartcrobat ${NEW} is ready to install.`)
    expect((await updateStatus(page)).phase).toBe('ready')
    expect(updater.installs()).toEqual([])

    // Restart now again, Don't Save: the app quits, installs silently, and starts the new version.
    await card.getByRole('button', { name: 'Restart now' }).click()
    await ask.getByRole('button', { name: "Don't Save" }).click()
    await waitForExit(app)
    await expect.poll(() => updater.installs()).toEqual([{ version: NEW, silent: true, runAfter: true }])
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})

test('closing the card hides it until Help > Check for Updates... finds the version again; a download continues while it is closed', async () => {
  const gh = await fakeGitHub()
  const updater = fakeUpdater({ steps: 10, stepMs: 400 })
  const { app, page } = await launch([], updateEnv(gh, updater))
  try {
    const card = updateCard(page)
    await expect(card).toContainText(`Fartcrobat ${NEW} is available.`)
    await card.getByRole('button', { name: 'Close' }).click()
    await expect(card).toBeHidden()
    expect((await updateStatus(page)).dismissedVersion).toBe(NEW)

    await checkFromHelpMenu(page)
    await expect(card).toContainText(`Fartcrobat ${NEW} is available.`)
    expect(gh.checks()).toBe(2)
    // The card says it; no toast as well.
    await expect(page.locator('.toast')).toHaveCount(0)

    // Hidden in Read Mode, like the rest of the window's chrome.
    await openFile(page, fixturePath('text.pdf'))
    await expect(card).toBeVisible()
    await runCommand(page, 'view.readMode')
    await expect(card).toBeHidden()
    await runCommand(page, 'view.readMode')
    await expect(card).toBeVisible()

    // Closed while downloading: the download goes on and the card comes back when it is ready.
    await card.getByRole('button', { name: 'Download' }).click()
    await expect(card.getByRole('progressbar')).toBeVisible()
    await card.getByRole('button', { name: 'Close' }).click()
    await expect(card).toBeHidden()
    expect((await updateStatus(page)).phase).toBe('downloading')
    await expect(card).toContainText(`Fartcrobat ${NEW} is ready to install.`)
    expect((await updateStatus(page)).dismissedVersion).toBeNull()
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})

test('Cancel stops a download and offers it again', async () => {
  const gh = await fakeGitHub()
  const updater = fakeUpdater({ steps: 20, stepMs: 400 })
  const { app, page } = await launch([], updateEnv(gh, updater))
  try {
    const card = updateCard(page)
    await card.getByRole('button', { name: 'Download' }).click()
    await expect(card.getByRole('progressbar')).toBeVisible()
    await card.getByRole('button', { name: 'Cancel' }).click()
    await expect(card).toContainText(`Fartcrobat ${NEW} is available.`)
    await expect(card.getByRole('progressbar')).toHaveCount(0)
    expect((await updateStatus(page)).phase).toBe('available')
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})

test('Later: the update installs the next time Fartcrobat quits, without starting again', async () => {
  const gh = await fakeGitHub()
  const updater = fakeUpdater({ steps: 3, stepMs: 100 })
  const { app, page } = await launch([], updateEnv(gh, updater))
  try {
    const card = updateCard(page)
    await card.getByRole('button', { name: 'Download' }).click()
    await expect(card).toContainText(`Fartcrobat ${NEW} is ready to install.`)
    await card.getByRole('button', { name: 'Later' }).click()
    await expect(card).toBeHidden()
    expect(updater.installs()).toEqual([])

    // File > Exit. The window may be gone before the call returns.
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('app.quit')).catch(() => {})
    await waitForExit(app)
    await expect.poll(() => updater.installs()).toEqual([{ version: NEW, silent: true, runAfter: false }])
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})

test('a download that fails says so, with Try again and Download from GitHub', async () => {
  const gh = await fakeGitHub()
  const updater = fakeUpdater({ steps: 3, stepMs: 100, failDownload: true })
  const { app, page } = await launch([], updateEnv(gh, updater))
  try {
    const opened = await recordOpenedLinks(app)
    const card = updateCard(page)
    await card.getByRole('button', { name: 'Download' }).click()
    await expect(card).toContainText(`Couldn't download Fartcrobat ${NEW}.`)
    const status = await updateStatus(page)
    expect(status).toMatchObject({ phase: 'error', errorDuring: 'download' })
    expect(status.error).toBeTruthy()
    await expect(card).toContainText(status.error!)
    await shot(page, 'download-failed')

    await card.getByRole('button', { name: 'Download from GitHub' }).click()
    await expect.poll(opened).toEqual([gh.releaseUrl(NEW)])

    // Try again downloads again (and fails again here).
    await card.getByRole('button', { name: 'Try again' }).click()
    await expect(card.getByRole('progressbar')).toBeVisible()
    await expect(card).toContainText(`Couldn't download Fartcrobat ${NEW}.`)

    await card.getByRole('button', { name: 'Close' }).click()
    await expect(card).toBeHidden()
    expect(updater.installs()).toEqual([])
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})

test("where the app cannot install ('notify'), Download opens the release page", async () => {
  const gh = await fakeGitHub({ kind: 'latest', version: NEW, absolute: true })
  // No FARTCROBAT_FAKE_UPDATER: an unpackaged run only tells about new versions.
  const { app, page } = await launch([], updateEnv(gh))
  try {
    const opened = await recordOpenedLinks(app)
    const card = updateCard(page)
    await expect(card).toContainText(`Fartcrobat ${NEW} is available.`)
    await expect(card).toContainText('Opens the download page on GitHub.')
    expect((await updateStatus(page)).capability).toBe('notify')
    await shot(page, 'available-notify')

    await card.getByRole('button', { name: 'Download' }).click()
    await expect.poll(opened).toEqual([gh.releaseUrl(NEW)])
    // Nothing downloads in the app.
    await expect(card.getByRole('progressbar')).toHaveCount(0)
    await expect(card).toContainText(`Fartcrobat ${NEW} is available.`)

    await card.getByRole('button', { name: "What's new" }).click()
    await expect.poll(opened).toEqual([gh.releaseUrl(NEW), gh.releaseUrl(NEW)])

    const prefs = await openPreferencesAt(page, 'Updates')
    await expect(prefs).toContainText(
      'On this system Fartcrobat tells you about new versions, and you download them from GitHub.'
    )
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})

// ---- checking by hand -----------------------------------------------------------------------------

test('up to date: an automatic check says nothing; Help > Check for Updates... and About say so', async () => {
  const gh = await fakeGitHub({ kind: 'latest', version: CURRENT })
  const { app, page } = await launch([], updateEnv(gh))
  try {
    await expect.poll(async () => (await updateStatus(page)).phase).toBe('upToDate')
    expect(gh.checks()).toBe(1)
    await expect(page.locator('.toast')).toHaveCount(0)
    await expect(updateCard(page)).toHaveCount(0)

    await checkFromHelpMenu(page)
    const toast = page.locator('.toast', { hasText: `Fartcrobat ${CURRENT} is up to date.` })
    await expect(toast).toBeVisible()
    expect(gh.checks()).toBe(2)
    await expect(updateCard(page)).toHaveCount(0)
    await shot(page, 'up-to-date-toast')

    // Help > About Fartcrobat: the version, and a check of its own.
    await runCommand(page, 'help.about')
    const about = page.getByRole('dialog', { name: 'About Fartcrobat' })
    await expect(about.getByRole('heading', { name: `Fartcrobat ${CURRENT}` })).toBeVisible()
    await about.getByRole('button', { name: 'Check for Updates' }).click()
    await expect(about.getByRole('status')).toHaveText(`Fartcrobat ${CURRENT} is up to date.`)
    await expect.poll(gh.checks).toBe(3)
    await shot(page, 'about-up-to-date')

    // A newer version: About offers it.
    gh.answer = { kind: 'latest', version: NEW }
    await about.getByRole('button', { name: 'Check for Updates' }).click()
    await expect(about.getByRole('status')).toContainText(`Fartcrobat ${NEW} is available.`)
    await expect(about.getByRole('button', { name: 'Download' })).toBeVisible()
    await shot(page, 'about-available')
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})

test('a failed check: silent when automatic, an error toast when asked for', async () => {
  const gh = await fakeGitHub({ kind: 'error' })
  const { app, page } = await launch([], updateEnv(gh))
  try {
    await expect.poll(async () => (await updateStatus(page)).phase).toBe('error')
    expect(gh.checks()).toBe(1)
    await expect(page.locator('.toast')).toHaveCount(0)
    await expect(updateCard(page)).toHaveCount(0)

    const failed = page.locator('.toast-error', {
      hasText: "Couldn't check for updates. Check your internet connection and try again."
    })
    await runCommand(page, 'help.checkForUpdates')
    await expect(failed).toBeVisible()
    expect(gh.checks()).toBe(2)
    await expect(updateCard(page)).toHaveCount(0)
    await shot(page, 'check-failed')
    await failed.getByRole('button', { name: 'Dismiss' }).click()

    // A page without a release tag is no answer either.
    gh.answer = { kind: 'page' }
    await runCommand(page, 'help.checkForUpdates')
    await expect(failed).toBeVisible()
    await failed.getByRole('button', { name: 'Dismiss' }).click()

    // GitHub answers again: the card.
    gh.answer = { kind: 'latest', version: NEW }
    await runCommand(page, 'help.checkForUpdates')
    await expect(updateCard(page)).toContainText(`Fartcrobat ${NEW} is available.`)
    await expect(failed).toHaveCount(0)
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})

// ---- turning it off -------------------------------------------------------------------------------

test('Preferences > Updates: with the switch off nothing is checked at start-up; Check Now still checks', async () => {
  const gh = await fakeGitHub()
  const userData = workDir()
  writeFileSync(
    join(userData, 'fartcrobat-settings.json'),
    JSON.stringify({ prefs: { rememberPasswords: false, checkForUpdates: false } })
  )
  const { app, page } = await launch([], { ...updateEnv(gh), FARTCROBAT_USER_DATA: userData })
  try {
    const prefs = await openPreferencesAt(page, 'Updates')
    await expect(prefs.getByText(`Version ${CURRENT}`, { exact: true })).toBeVisible()
    const toggle = prefs.getByRole('switch', { name: 'Check for updates automatically' })
    await expect(toggle).not.toBeChecked()
    await expect(toggle).toBeEnabled()
    await expect(prefs.getByText('Not checked yet')).toBeVisible()
    await expect(prefs).toContainText(
      'Checking asks GitHub for the latest release. Nothing about you or your documents is sent.'
    )
    await expect.poll(async () => (await updateStatus(page)).checksOff).toBe('preference')
    // The first automatic check would have run at once (FARTCROBAT_UPDATE_FIRST_CHECK_MS=0). Give it
    // time to show up at the server, which it must not.
    await page.waitForTimeout(1500)
    expect(gh.checks()).toBe(0)
    await shot(page, 'preferences-off')

    await prefs.getByRole('button', { name: 'Check Now' }).click()
    await expect(prefs.getByRole('status')).toContainText(`Fartcrobat ${NEW} is available.`)
    await expect(prefs.getByText('Last checked: just now')).toBeVisible()
    expect(gh.checks()).toBe(1)
    await shot(page, 'preferences-checked')

    // Turning it on is saved like any preference.
    await prefs.getByText('Check for updates automatically', { exact: true }).click()
    await expect(toggle).toBeChecked()
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().prefs.checkForUpdates))
      .toBe(true)
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})

test('a machine policy that turns updates off: no checks at all, a read-only switch, and Help says so', async () => {
  const gh = await fakeGitHub()
  const dir = workDir()
  const policy = join(dir, 'policy.json')
  writeFileSync(policy, JSON.stringify({ autoUpdate: { enabled: false } }))
  const { app, page } = await launch([], { ...updateEnv(gh), FARTCROBAT_POLICY_FILE: policy })
  try {
    await expect.poll(async () => (await updateStatus(page)).checksOff).toBe('policy')

    const prefs = await openPreferencesAt(page, 'Updates')
    const toggle = prefs.getByRole('switch', { name: 'Check for updates automatically' })
    await expect(toggle).toBeDisabled()
    await expect(toggle).not.toBeChecked()
    await expect(prefs).toContainText('Your organization manages updates on this computer.')
    await expect(prefs.getByRole('button', { name: 'Check Now' })).toBeDisabled()
    await expect(prefs.getByText(`Version ${CURRENT}`, { exact: true })).toBeVisible()
    await shot(page, 'preferences-policy')
    await prefs.getByRole('button', { name: 'Done' }).click()

    await checkFromHelpMenu(page)
    await expect(
      page.locator('.toast', { hasText: 'Updates are managed by your organization.' })
    ).toBeVisible()

    await runCommand(page, 'help.about')
    const about = page.getByRole('dialog', { name: 'About Fartcrobat' })
    await expect(about.getByRole('heading', { name: `Fartcrobat ${CURRENT}` })).toBeVisible()
    await expect(about.getByRole('button', { name: 'Check for Updates' })).toBeDisabled()
    await expect(about.getByRole('status')).toHaveText('Updates are managed by your organization.')
    await shot(page, 'about-policy')

    // Neither the automatic check (due at once) nor the manual one reached the server.
    await page.waitForTimeout(1000)
    expect(gh.checks()).toBe(0)
  } finally {
    await closeQuietly(app)
    await gh.close()
  }
})
