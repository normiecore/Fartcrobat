import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, FIXTURES, fixturePath, launch, openFile, ROOT, runCommand, waitForRender } from './helpers'

function tempCopy(name: string, as = name): string {
  const dir = mkdtempSync(join(tmpdir(), 'fc-shell-docs-'))
  const path = join(dir, as)
  copyFileSync(fixturePath(name), path)
  return path
}

/** Replaces a main-process IPC handler so native dialogs never open. */
async function stubHandler(app: ElectronApplication, channel: string, result: unknown) {
  await app.evaluate(
    ({ ipcMain }, { channel, result }) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, () => result)
    },
    { channel, result }
  )
}

async function docTitles(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__fartcrobat.useApp.getState().docs.map((d: any) => d.state.title))
}

function dialogTitled(page: Page, title: string) {
  return page.locator('.ui-dialog', { has: page.locator('h2', { hasText: title }) })
}

async function dialogCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as any).__fartcrobat.useApp.getState().dialogs.length)
}

function countRotate90(path: string): number {
  return (readFileSync(path, 'latin1').match(/\/Rotate 90\b/g) ?? []).length
}

test('an edit made while the file is being written stays unsaved', async () => {
  const { app, page } = await launch()
  try {
    const file = tempCopy('text.pdf', 'race.pdf')
    await openFile(page, file)
    await waitForRender(page)
    await page.evaluate(async () => {
      const f = (window as any).__fartcrobat
      const pages = f.getActiveDoc().ops('pages')
      await pages.rotate([1], 90)
      // The save serializes first; the rotation of page 1 lands while the bytes are being written.
      const saving = f.runCommand('file.save')
      await pages.rotate([0], 90)
      await saving
    })
    expect(countRotate90(file)).toBe(1)
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
    await page.waitForTimeout(300)
    expect((await activeDocState(page))?.dirty).toBe(true)

    // Saving again writes the late edit and the document becomes clean.
    await runCommand(page, 'file.save')
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)
    expect(countRotate90(file)).toBe(2)
  } finally {
    await app.close()
  }
})

test('opening the same file twice at once opens a single tab', async () => {
  const { app, page } = await launch()
  try {
    const file = fixturePath('text.pdf')
    await page.evaluate(async (p) => {
      const f = (window as any).__fartcrobat
      await Promise.all([f.openPaths([p]), f.openPaths([p]), f.openPaths([p.replace(/\/text\.pdf$/, '/./text.pdf')])])
    }, file)
    await waitForRender(page)
    await page.waitForTimeout(300)
    expect(await docTitles(page)).toEqual(['text.pdf'])

    // A habitual double-click on a recent file on Home opens it once.
    await page.keyboard.press('Control+w')
    const row = page.locator('.home-recent-table tbody tr', { hasText: 'text.pdf' })
    await expect(row).toBeVisible()
    await row.dblclick()
    await page.waitForSelector('.viewer-page canvas')
    await page.waitForTimeout(500)
    expect(await docTitles(page)).toEqual(['text.pdf'])
  } finally {
    await app.close()
  }
})

test('closing the last document leaves Read Mode so Home keeps its top bar', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await page.keyboard.press('Control+h')
    await expect(page.locator('.shell-topbar')).toHaveCount(0)
    await page.keyboard.press('Control+w')
    await expect(page.locator('.home')).toBeVisible()
    await expect(page.locator('.shell-topbar')).toBeVisible()
    expect(await page.evaluate(() => (window as any).__fartcrobat.useApp.getState().readMode)).toBe(false)
    await page.screenshot({ path: 'test-results/core-shell-home-after-read-mode.png' })

    // Full Screen chosen on Home keeps the top bar too, and the next document opens normally.
    await page.keyboard.press('Control+l')
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().fullScreen)).toBe(true)
    await expect(page.locator('.shell-topbar')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().fullScreen)).toBe(false)
  } finally {
    await app.close()
  }
})

test('cancelling quit keeps every tab open, and repeated close requests ask only once', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await openFile(page, fixturePath('form.pdf'))
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().ops('pages').rotate([0], 90))
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)

    const requestClose = () =>
      app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('app:beforeQuit'))
    await requestClose()
    await expect(dialogTitled(page, 'Save changes?')).toBeVisible()
    await requestClose()
    await page.waitForTimeout(400)
    expect(await dialogCount(page)).toBe(1)

    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect.poll(() => dialogCount(page)).toBe(0)
    expect(await docTitles(page)).toEqual(['text.pdf', 'form.pdf'])
    expect(app.windows().length).toBe(1)
  } finally {
    await app.close()
  }
})

test('Revert reloads the tab in place and keeps its position', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await openFile(page, fixturePath('form.pdf'))
    const firstId = await page.evaluate(() => {
      const f = (window as any).__fartcrobat
      const s = f.useApp.getState()
      f.useApp.setState({ activeDocId: s.docs[0].id })
      return s.docs[0].id
    })
    await waitForRender(page)
    await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      d.view.goToPage(2)
      await d.ops('pages').rotate([0], 90)
    })
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(2)

    // File > Revert from the in-app Menu.
    await page.locator('.shell-menu-btn').click()
    await page.getByRole('menuitem', { name: 'File', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Revert' }).click()
    await dialogTitled(page, 'Revert').getByRole('button', { name: 'Revert' }).click()
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.info.pages[0].rotation)).toBe(0)
    expect(await docTitles(page)).toEqual(['text.pdf', 'form.pdf'])
    const after = await page.evaluate(() => {
      const f = (window as any).__fartcrobat
      const d = f.getActiveDoc()
      return { id: d.id, rotation: d.state.info.pages[0].rotation, page: d.state.currentPage, canUndo: d.state.journal.canUndo }
    })
    expect(after).toEqual({ id: firstId, rotation: 0, page: 2, canUndo: false })
    await expect(page.locator('.home')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('Save asks before replacing a file when it has to add the .pdf extension', async () => {
  const { app, page } = await launch()
  try {
    const dir = mkdtempSync(join(tmpdir(), 'fc-shell-save-'))
    const existing = join(dir, 'report.pdf')
    writeFileSync(existing, 'keep me')
    await openFile(page, fixturePath('text.pdf'))
    await stubHandler(app, 'file:saveDialog', join(dir, 'report'))

    await page.keyboard.press('Control+Shift+S')
    const prompt = dialogTitled(page, 'Replace file?')
    await expect(prompt).toBeVisible()
    await expect(prompt).toContainText('“report.pdf” already exists')
    // The safe choice has the focus: Enter keeps the existing file.
    await expect(prompt.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.screenshot({ path: 'test-results/core-shell-replace-file.png' })
    await page.keyboard.press('Enter')
    await expect.poll(() => dialogCount(page)).toBe(0)
    expect(readFileSync(existing, 'latin1')).toBe('keep me')
    expect((await activeDocState(page))?.title).toBe('text.pdf')

    await page.keyboard.press('Control+Shift+S')
    await prompt.getByRole('button', { name: 'Replace' }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('report.pdf')
    expect(readFileSync(existing, 'latin1').startsWith('%PDF')).toBe(true)
  } finally {
    await app.close()
  }
})

test('a Home tile opens its tool on the file picked for it', async () => {
  const { app, page } = await launch()
  try {
    await stubHandler(app, 'file:openDialog', [fixturePath('text.pdf')])
    const tile = await page.evaluate(() => {
      const g = (window as any).__fartcrobat.registry.toolGroups.find((t: any) => t.homeTile && t.panel && t.requiresDocument !== false)
      return g ? { id: g.id, label: g.label } : null
    })
    test.skip(!tile, 'No Home tile with a tool panel is registered')
    await page.locator('.home-tile', { hasText: tile!.label }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('text.pdf')
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolGroupId)).toBe(tile!.id)
  } finally {
    await app.close()
  }
})

test('a tool chosen before any document is open starts once a file is picked', async () => {
  const { app, page } = await launch()
  try {
    await stubHandler(app, 'file:openDialog', [fixturePath('text.pdf')])
    await page.evaluate(() => {
      const f = (window as any).__fartcrobat
      const Nothing = () => null
      f.registry.toolGroups.push({ id: 'shell-probe', label: 'Shell Probe Tool', icon: Nothing, order: 9999, panel: Nothing })
      f.useApp.setState({ paletteOpen: true })
    })
    await page.getByPlaceholder('Find text or tools').fill('Shell Probe')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('text.pdf')
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolGroupId))
      .toBe('shell-probe')
  } finally {
    await app.close()
  }
})

test('the in-app Menu shows check marks and the default-app banner stays dismissed', async () => {
  const { app, page } = await launch()
  try {
    await stubHandler(app, 'defaultApp:status', { isDefault: false, canSetDirectly: false, instructions: 'Probe instructions' })
    await openFile(page, fixturePath('text.pdf'))
    await page.locator('.shell-menu-btn').click()
    await page.getByRole('menuitem', { name: 'View', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Page Display' }).click()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Enable Scrolling' })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('menuitemcheckbox', { name: 'Two Page View', exact: true })).toHaveAttribute('aria-checked', 'false')
    await page.screenshot({ path: 'test-results/core-shell-menu-checks.png' })
    // Choosing another layout moves the check mark.
    await page.getByRole('menuitemcheckbox', { name: 'Two Page View', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.layout)).toBe('two-page')
    await page.locator('.shell-menu-btn').click()
    await page.getByRole('menuitem', { name: 'View', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Page Display' }).click()
    await expect(page.getByRole('menuitemcheckbox', { name: 'Two Page View', exact: true })).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByRole('menuitemcheckbox', { name: 'Enable Scrolling' })).toHaveAttribute('aria-checked', 'false')
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
    await page.screenshot({ path: 'test-results/core-shell-menu-checks-dark.png' })
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))
    await page.keyboard.press('Escape')

    await runCommand(page, 'file.close')
    const banner = page.locator('.home-banner')
    await expect(banner).toBeVisible()
    await page.screenshot({ path: 'test-results/core-shell-home-banner.png' })
    await banner.getByRole('button', { name: 'Dismiss' }).click()
    await expect(banner).toHaveCount(0)
    await expect(page.locator('.toast', { hasText: 'won’t ask again' })).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => (window as any).api.invoke('prefs:get').then((p: any) => p.checkDefaultAppOnStartup)))
      .toBe(false)
    // Home is shown again after a document closes: the banner does not come back.
    await openFile(page, fixturePath('text.pdf'))
    await runCommand(page, 'file.close')
    await expect(page.locator('.home')).toBeVisible()
    await page.waitForTimeout(300)
    await expect(banner).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('a second launch with a relative path opens the file from its own folder', async () => {
  // A single-instance app, like a normal installation.
  const { app, page, userData } = await launch([], { FARTCROBAT_MULTI_INSTANCE: '' })
  try {
    const electronPath = createRequire(import.meta.url)('electron') as unknown as string
    const second = spawn(electronPath, [join(ROOT, 'out/main/index.js'), '--no-sandbox', '--disable-gpu', 'text.pdf'], {
      cwd: FIXTURES,
      env: { ...process.env, FARTCROBAT_USER_DATA: userData, FARTCROBAT_MULTI_INSTANCE: '' },
      stdio: 'ignore'
    })
    const code = await new Promise<number | null>((resolve) => second.on('exit', resolve))
    expect(code).toBe(0)
    await page.waitForSelector('.viewer-page canvas')
    const opened = await page.evaluate(() =>
      (window as any).__fartcrobat.useApp.getState().docs.map((d: any) => d.state.filePath)
    )
    expect(opened).toEqual([fixturePath('text.pdf')])
  } finally {
    await app.close()
  }
})
