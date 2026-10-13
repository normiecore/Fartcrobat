import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, ROOT, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/ocr-${name}.png` })

/** Where a page-space rectangle (points) is on screen. */
async function pageRectToScreen(page: Page, pageIndex: number, r: [number, number, number, number]) {
  const box = await page.locator(`.viewer-page[data-page-index="${pageIndex}"]`).boundingBox()
  if (!box) throw new Error('page not visible')
  const info = await page.evaluate((i) => (window as any).__fartcrobat.getActiveDoc().state.info.pages[i], pageIndex)
  const s = box.width / info.width
  return { x: box.x + r[0] * s, y: box.y + r[1] * s, width: (r[2] - r[0]) * s, height: (r[3] - r[1]) * s }
}

function overlap(a: { x: number; y: number; width: number; height: number }, b: typeof a) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? (w * h) / (a.width * a.height) : 0
}

// Positions of words in tests/fixtures/scan.png (150 dpi), in page points (x 72/150).
const PX = 72 / 150
const SEARCHABLE_PT: [number, number, number, number] = [150 * PX, 398 * PX, 369 * PX, 428 * PX]
const LAST_LINE_PT: [number, number, number, number] = [150 * PX, 398 * PX, 686 * PX, 428 * PX]

test('scanned document: message bar, recognize text, search, select and copy', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('scanned.pdf'))
    await waitForRender(page)

    // The scanned-document bar offers recognition.
    const bar = page.getByRole('region', { name: 'Scanned document message bar' })
    await expect(bar).toBeVisible()
    await expect(bar).toContainText('This document appears to be scanned. Recognize text to make it searchable?')
    await page.waitForTimeout(300)
    await shot(page, 'bar')

    // Nothing to find yet.
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().search('searchable'))
    await expect.poll(async () => (await activeDocState(page))?.search.query).toBe('searchable')
    expect((await activeDocState(page))?.search.hits).toBe(0)
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().cancelSearch())

    // The bar's Options… opens the Scan & OCR panel; its Recognize text runs with one click.
    await bar.getByRole('button', { name: 'Options…' }).click()
    await expect(page.locator('.ui-panel-header h3', { hasText: 'Scan & OCR' })).toBeVisible()
    await expect(page.getByTestId('ocr-status')).toContainText('1 page has no searchable text')
    await shot(page, 'panel')
    await bar.getByRole('button', { name: 'Recognize text' }).click()
    const progress = page.locator('.fc-ocr-progress')
    await expect(progress).toBeVisible()
    await shot(page, 'progress')
    await expect(progress).toBeHidden({ timeout: 60_000 })
    await expect(page.locator('.toast').filter({ hasText: /Recognized \d+ words on 1 page/ })).toBeVisible()
    await expect(bar).toBeHidden()
    await expect(page.getByTestId('ocr-status')).toContainText('1 page has recognized text')
    const st = await activeDocState(page)
    expect(st?.dirty).toBe(true)
    expect(st?.journal.undoLabel).toBe('Recognize Text')

    // Ctrl+F finds the word, and the highlight sits on the word in the image.
    await page.locator('.viewer-scroll').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Control+F')
    const find = page.getByLabel('Find in document')
    await expect(find).toBeFocused()
    await page.keyboard.type('searchable')
    await expect.poll(async () => (await activeDocState(page))?.search.hits).toBe(1)
    const hit = page.locator('.viewer-search-hit').first()
    await expect(hit).toBeVisible()
    const hitBox = (await hit.boundingBox())!
    const wordBox = await pageRectToScreen(page, 0, SEARCHABLE_PT)
    expect(overlap(hitBox, wordBox)).toBeGreaterThan(0.6)
    expect(overlap(wordBox, hitBox)).toBeGreaterThan(0.6)
    await shot(page, 'search-hit')

    // Zoomed in, the highlight still covers the word.
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(2))
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().revealHit(0))
    await page.waitForTimeout(500)
    const hitBox2 = (await page.locator('.viewer-search-hit').first().boundingBox())!
    const wordBox2 = await pageRectToScreen(page, 0, SEARCHABLE_PT)
    expect(overlap(hitBox2, wordBox2)).toBeGreaterThan(0.6)
    await shot(page, 'search-hit-zoomed')
    await page.getByRole('button', { name: 'Close find' }).first().click()
    await page.evaluate(() => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      d.view.setZoom('fit-width')
      d.view.goToPage(0)
    })
    await page.waitForTimeout(400)

    // Select the last line with the mouse and copy it.
    const line = await pageRectToScreen(page, 0, LAST_LINE_PT)
    await page.mouse.move(line.x + 2, line.y + line.height / 2)
    await page.mouse.down()
    await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2, { steps: 5 })
    await page.mouse.move(line.x + line.width - 1, line.y + line.height / 2, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await activeDocState(page))?.selection.kind).toBe('text')
    await shot(page, 'selection')
    await page.keyboard.press('Control+C')
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('searchable and selectable.')
  } finally {
    await app.close()
  }
})

/** Runs a command without waiting for it (commands that open dialogs wait for them). */
async function fire(page: Page, id: string) {
  await page.evaluate((c) => void (window as any).__fartcrobat.runCommand(c), id)
}

function dialogTitled(page: Page, title: string) {
  return page.locator('.ui-dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

const expected = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/ocr/scanned-pages.json'), 'utf8')) as {
  words: Record<string, { text: string; rect: [number, number, number, number] }[]>
}

test('multi-page scan: Recognize Text dialog, skipped pages, rotated page, undo, cancel, added language, dark theme', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-ocr-e2e-'))
  // A "French" language file (English data under another name) to add in Preferences.
  const langFile = join(dir, 'fra.traineddata.gz')
  copyFileSync(join(ROOT, 'node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz'), langFile)
  const { app, page } = await launch()
  try {
    await page.evaluate(async () => {
      const prefs = await (window as any).api.invoke('prefs:set', { theme: 'dark' })
      ;(window as any).__fartcrobat.useApp.setState({ prefs })
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await openFile(page, fixturePath('ocr/scanned-pages.pdf'))
    await waitForRender(page)
    const bar = page.getByRole('region', { name: 'Scanned document message bar' })
    await expect(bar).toBeVisible()
    await page.waitForTimeout(300)
    await shot(page, 'dark-bar')

    // Right-click a page without text: "Recognize Text on This Page…".
    const first = page.locator('.viewer-page[data-page-index="0"]')
    await first.hover({ position: { x: 200, y: 300 } })
    await page.waitForTimeout(300)
    await first.click({ button: 'right', position: { x: 200, y: 300 } })
    await page.getByRole('menuitem', { name: 'Recognize Text on This Page…' }).click()
    let dialog = dialogTitled(page, 'Recognize Text')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('radio', { name: 'Current page (1)' })).toBeChecked()
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()

    // Tools > Scan & OCR > Recognize Text…: pages 1-3 by keyboard; page 3 has real text.
    await fire(page, 'ocr.recognize')
    dialog = dialogTitled(page, 'Recognize Text')
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('radio', { name: 'All 4 pages' })).toBeChecked()
    await expect(dialog.getByRole('checkbox', { name: 'Skip pages that already have text' })).toBeChecked()
    const range = dialog.getByRole('textbox', { name: 'Page range' })
    await range.fill('9')
    await expect(dialog.getByText('This document has pages 1 to 4')).toBeVisible()
    await expect(page.getByTestId('ocr-dialog-recognize')).toBeDisabled()
    await shot(page, 'dark-dialog')
    await range.fill('1-3')
    await expect(dialog.getByRole('radio', { name: 'Pages', exact: true })).toBeChecked()
    await range.press('Enter')
    const progress = page.locator('.fc-ocr-progress')
    await expect(progress).toBeVisible()
    await expect(progress.locator('.fc-ocr-progress-page.is-skipped')).toContainText('Page 3')
    await shot(page, 'dark-progress')
    await expect(progress).toBeHidden({ timeout: 90_000 })
    await expect(page.locator('.toast').filter({ hasText: 'on 2 pages' }).filter({ hasText: '1 page was skipped because it already has text.' })).toBeVisible()
    await expect(bar).toBeHidden()
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Recognize Text')

    // The rotated page (page 2, /Rotate 90) is searchable where its words are.
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().search('sideways'))
    await expect.poll(async () => (await activeDocState(page))?.search.hits).toBe(1)
    const hit = await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.search.hits[0])
    expect(hit.page).toBe(1)
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().revealHit(0))
    await expect(page.locator('.viewer-page[data-page-index="1"] .viewer-search-hit')).toBeVisible()
    const hitBox = (await page.locator('.viewer-page[data-page-index="1"] .viewer-search-hit').boundingBox())!
    const word = expected.words['1'].find((w) => w.text === 'sideways.')!.rect
    const wordBox = await pageRectToScreen(page, 1, [word[0], word[1], word[2] - 4, word[3]])
    expect(overlap(hitBox, wordBox)).toBeGreaterThan(0.6)
    await page.waitForTimeout(300)
    await shot(page, 'dark-rotated-hit')
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().cancelSearch())

    // Undo removes the text in one step.
    await page.locator('.viewer-scroll').focus()
    await page.keyboard.press('Control+Z')
    await expect.poll(async () => (await activeDocState(page))?.journal.undoLabel ?? null).toBeNull()
    const pageText = (i: number) => page.evaluate(async (k) => (await (window as any).__fartcrobat.getActiveDoc().pageText(k)).text.trim(), i)
    expect(await pageText(1)).toBe('')

    // Cancel: nothing changes.
    await fire(page, 'ocr.recognize')
    dialog = dialogTitled(page, 'Recognize Text')
    await dialog.getByRole('checkbox', { name: 'Skip pages that already have text' }).uncheck()
    await page.getByTestId('ocr-dialog-recognize').click()
    await expect(progress).toBeVisible()
    await page.getByTestId('ocr-cancel').click()
    await expect(progress).toBeHidden()
    await expect(page.locator('.toast').filter({ hasText: 'Text recognition was cancelled. Nothing was changed.' })).toBeVisible()
    expect((await activeDocState(page))?.journal.undoLabel ?? null).toBeNull()
    expect(await pageText(0)).toBe('')

    // Stop after the first page: the pages already recognized are kept, in one undo step.
    await fire(page, 'ocr.recognize')
    dialog = dialogTitled(page, 'Recognize Text')
    await expect(dialog.getByRole('checkbox', { name: 'Skip pages that already have text' })).not.toBeChecked()
    await page.getByTestId('ocr-dialog-recognize').click()
    await expect(progress.locator('.fc-ocr-progress-page.is-done')).toHaveCount(1, { timeout: 60_000 })
    await progress.getByRole('button', { name: /Stop and keep/ }).click()
    await expect(progress).toBeHidden()
    await expect(page.locator('.toast').filter({ hasText: /^Stopped\. Recognized \d+ words on [12] pages?\./ })).toBeVisible()
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Recognize Text')
    const recognizedPages = await page.evaluate(async () =>
      (await (window as any).__fartcrobat.getActiveDoc().ops('ocr').status()).filter((s: any) => s.hasOcrLayer).length
    )
    expect(recognizedPages).toBeGreaterThanOrEqual(1)
    expect(recognizedPages).toBeLessThan(4)
    await page.keyboard.press('Control+Z')
    await expect.poll(async () => (await activeDocState(page))?.journal.undoLabel ?? null).toBeNull()
    await dialogTitled(page, 'Recognize Text').waitFor({ state: 'detached' })
    await fire(page, 'ocr.recognize')
    await dialogTitled(page, 'Recognize Text').getByRole('checkbox', { name: 'Skip pages that already have text' }).check()
    await dialogTitled(page, 'Recognize Text').getByRole('button', { name: 'Cancel' }).click()

    // Preferences > OCR: add a language file, make it the default.
    await app.evaluate(({ dialog }, p) => {
      ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
    }, langFile)
    await fire(page, 'app.preferences')
    const prefs = dialogTitled(page, 'Preferences')
    await prefs.getByRole('button', { name: 'OCR', exact: true }).click()
    await expect(prefs.getByRole('list', { name: 'Recognition languages' })).toContainText('English')
    await prefs.getByRole('button', { name: 'Add language…' }).click()
    await expect(prefs.getByRole('list', { name: 'Recognition languages' })).toContainText('French')
    await expect(page.locator('.toast').filter({ hasText: 'French can now be used for text recognition.' })).toBeVisible()
    await prefs.getByRole('combobox', { name: 'Document language' }).selectOption('fra')
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().prefs.ocrLanguage)).toBe('fra')
    await shot(page, 'dark-preferences')
    await prefs.getByRole('button', { name: 'Done' }).click()

    // The added language is used (loaded from the user's settings folder).
    await fire(page, 'ocr.recognize')
    dialog = dialogTitled(page, 'Recognize Text')
    await expect(dialog.getByRole('combobox', { name: 'Document language' })).toHaveValue('fra')
    await dialog.getByRole('textbox', { name: 'Page range' }).fill('1')
    await page.getByTestId('ocr-dialog-recognize').click()
    await expect(progress).toContainText('French')
    await expect(progress).toBeHidden({ timeout: 60_000 })
    await expect(page.locator('.toast').filter({ hasText: /^Recognized \d+ words on 1 page/ })).toBeVisible()
    expect(await pageText(0)).toContain('Quarterly Report')

    // The Scan & OCR panel in the dark theme, with Remove recognized text.
    await page.locator('.shell-alltools-item', { hasText: 'Scan & OCR' }).click()
    await expect(page.getByTestId('ocr-status')).toContainText('1 page has recognized text')
    await expect(page.getByTestId('ocr-status')).toContainText('1 page has text of its own')
    await expect(page.getByTestId('ocr-status')).toContainText('2 pages have no searchable text')
    await shot(page, 'dark-panel')
    await page.getByRole('button', { name: 'Remove recognized text' }).click()
    await expect(page.getByTestId('ocr-status')).not.toContainText('recognized text')
    expect(await pageText(0)).toBe('')
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Remove Recognized Text')

    // Removing the added language falls back to English.
    await fire(page, 'app.preferences')
    const prefs2 = dialogTitled(page, 'Preferences')
    await prefs2.getByRole('button', { name: 'OCR', exact: true }).click()
    await prefs2.getByRole('button', { name: 'Remove French' }).click()
    await expect(prefs2.getByRole('list', { name: 'Recognition languages' })).not.toContainText('French')
    await expect(prefs2.getByText('French is no longer installed; English is used.')).toBeVisible()
    await expect(prefs2.getByRole('combobox', { name: 'Document language' })).toHaveValue('eng')
    await prefs2.getByRole('button', { name: 'Done' }).click()
  } finally {
    await app.close()
  }
})
