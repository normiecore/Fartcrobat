import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import JSZip from 'jszip'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/export-create-${name}.png` })

async function stubSaveDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as any
  }, path)
}

async function stubOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: p })) as any
  }, paths)
}

async function openPath(page: Page, path: string) {
  await page.evaluate((p) => void (window as any).__fartcrobat.openPaths([p]), path)
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    const { useApp } = (window as any).__fartcrobat
    useApp.setState({ prefs: { ...useApp.getState().prefs, theme: t } })
  }, theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

async function docCount(page: Page) {
  return page.evaluate(() => (window as any).__fartcrobat.useApp.getState().docs.length as number)
}

/** Text of a page of the active document. */
async function pageText(page: Page, index: number) {
  return page.evaluate(async (i) => (await (window as any).__fartcrobat.getActiveDoc().pageText(i)).text as string, index)
}

function pngSize(file: string) {
  const b = readFileSync(file)
  expect(b.subarray(1, 4).toString()).toBe('PNG')
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

const panel = (page: Page) => page.locator('.shell-leftpane')

test('Export a PDF: Word, images to a folder, text from the menu, keyboard and dark theme', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-export-e2e-'))
  const src = join(dir, 'Report.pdf')
  copyFileSync(fixturePath('text.pdf'), src)
  const { app, page } = await launch()
  try {
    await openPath(page, src)
    await waitForRender(page)

    // ---- open Export a PDF from All tools
    await page.locator('.shell-alltools-item', { hasText: 'Export a PDF' }).click()
    await expect(panel(page).getByRole('heading', { name: 'Export a PDF' })).toBeVisible()
    await expect(panel(page).getByRole('radio', { name: /Microsoft Word/ })).toHaveAttribute('aria-checked', 'true')
    await shot(page, 'panel-word')

    // ---- Word (save dialog stubbed): a real .docx with the heading and paragraphs
    const docx = join(dir, 'Report.docx')
    await stubSaveDialog(app, docx)
    await page.getByTestId('export-run').click()
    await expect(page.locator('.toast', { hasText: 'Exported “Report.docx”' })).toBeVisible({ timeout: 60000 })
    expect(existsSync(docx)).toBe(true)
    const zip = await JSZip.loadAsync(readFileSync(docx))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toMatch(/<w:pStyle w:val="Heading1"\/>[\s\S]*?Chapter 1/)
    expect(xml).toContain('Lorem ipsum dolor sit amet')
    await expect(page.getByTestId('export-result')).toContainText('Report.docx')
    await shot(page, 'word-done')

    // ---- Images: PNG at 72 dpi of pages 2-3, into a folder (folder dialog stubbed)
    await panel(page).getByRole('radio', { name: /^Image/ }).click()
    await panel(page).getByLabel('Resolution').selectOption('72')
    await panel(page).getByLabel('Pages to export').fill('2-3')
    await expect(panel(page).getByText('One file per page, for example “Report_Page_1.png”')).toBeVisible()
    await shot(page, 'panel-image')
    const imgDir = join(dir, 'images')
    mkdirSync(imgDir, { recursive: true })
    await stubOpenDialog(app, [imgDir])
    await page.getByTestId('export-run').click()
    await expect(page.locator('.toast', { hasText: 'Saved 2 images' })).toBeVisible({ timeout: 30000 })
    expect(readdirSync(imgDir).sort()).toEqual(['Report_Page_2.png', 'Report_Page_3.png'])
    expect(pngSize(join(imgDir, 'Report_Page_2.png'))).toEqual({ width: 612, height: 792 })

    // Exporting again asks before replacing the images.
    await page.getByTestId('export-run').click()
    await expect(page.getByRole('heading', { name: 'Replace existing files?' })).toBeVisible({ timeout: 30000 })
    await page.getByRole('button', { name: 'Replace' }).click()
    await expect(page.locator('.toast', { hasText: 'Saved 2 images' }).first()).toBeVisible()

    // ---- an invalid page range disables Export and says why
    await panel(page).getByLabel('Pages to export').fill('9')
    await expect(panel(page).getByText('This document has 5 pages')).toBeVisible()
    await expect(page.getByTestId('export-run')).toBeDisabled()
    await panel(page).getByRole('radio', { name: /All pages/ }).check()
    await expect(page.getByTestId('export-run')).toBeEnabled()

    // ---- keyboard: arrow keys move through the formats
    await panel(page).getByRole('radio', { name: /^Image/ }).focus()
    await page.keyboard.press('ArrowUp')
    await expect(panel(page).getByRole('radio', { name: /PowerPoint/ })).toHaveAttribute('aria-checked', 'true')
    await expect(panel(page).getByRole('radio', { name: /PowerPoint/ })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(panel(page).getByRole('radio', { name: /HTML Web Page/ })).toHaveAttribute('aria-checked', 'true')
    await expect(panel(page).getByText('Exact page layout')).toBeVisible()

    // ---- File > Export To > Text (Plain) from the command: all pages, plain text
    const txt = join(dir, 'Report.txt')
    await stubSaveDialog(app, txt)
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('export.text'))
    await expect(page.locator('.toast', { hasText: 'Exported “Report.txt”' })).toBeVisible({ timeout: 30000 })
    const text = readFileSync(txt, 'utf8')
    expect(text).toContain('Chapter 1')
    expect(text).toContain('Chapter 5')
    await expect(panel(page).getByRole('radio', { name: /Text \(Plain\)/ })).toHaveAttribute('aria-checked', 'true')

    // ---- Excel and PowerPoint through the panel
    await panel(page).getByRole('radio', { name: /Spreadsheet/ }).click()
    const xlsx = join(dir, 'Report.xlsx')
    await stubSaveDialog(app, xlsx)
    await page.getByTestId('export-run').click()
    await expect(page.locator('.toast', { hasText: 'Exported “Report.xlsx”' })).toBeVisible({ timeout: 60000 })
    const book = await JSZip.loadAsync(readFileSync(xlsx))
    expect(Object.keys(book.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))).toHaveLength(5)

    await panel(page).getByRole('radio', { name: /PowerPoint/ }).click()
    const pptx = join(dir, 'Report.pptx')
    await stubSaveDialog(app, pptx)
    await page.getByTestId('export-run').click()
    await expect(page.locator('.toast', { hasText: 'Exported “Report.pptx”' })).toBeVisible({ timeout: 60000 })
    const deck = await JSZip.loadAsync(readFileSync(pptx))
    expect(Object.keys(deck.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))).toHaveLength(5)
    expect(await deck.file('ppt/slides/slide1.xml')!.async('string')).toContain('Chapter 1')

    // ---- a document that forbids copying cannot be exported
    const locked = join(dir, 'Locked.pdf')
    await page.evaluate(async (p) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const bytes = await d.core.doc.save({ mode: 'full', encrypt: { method: 'aes-128', userPassword: '', ownerPassword: 'owner', permissions: { copy: false } } })
      await (window as any).api.invoke('file:write', p, bytes)
    }, locked)
    await openPath(page, locked)
    await expect.poll(() => activeDocState(page).then((s) => s?.title)).toBe('Locked.pdf')
    await expect(panel(page).getByText('security settings don’t allow copying')).toBeVisible()
    await page.getByTestId('export-run').click()
    await expect(page.getByRole('heading', { name: 'Exporting isn’t allowed' })).toBeVisible()
    await shot(page, 'restricted')
    await page.getByRole('button', { name: 'OK' }).click()

    // ---- dark theme
    await setTheme(page, 'dark')
    await page.waitForTimeout(300)
    await panel(page).getByRole('radio', { name: /Microsoft Word/ }).click()
    await shot(page, 'panel-dark')
    await setTheme(page, 'light')
  } finally {
    await app.close()
  }
})

test('Create a PDF: from Home, combine files, blank pages, HTML and Office files', async () => {
  const { app, page } = await launch()
  try {
    // ---- the Home tile opens Create a PDF without a document
    await page.locator('.home-tile', { hasText: 'Create a PDF' }).click()
    await expect(page.getByTestId('create-view')).toBeVisible()
    await shot(page, 'home-create')

    // ---- Multiple files: add scan.png and compare-a.pdf, combine into one new tab
    await page.getByRole('button', { name: /Multiple files/ }).click()
    await stubOpenDialog(app, [fixturePath('scan.png'), fixturePath('compare-a.pdf')])
    await page.getByRole('button', { name: 'Add files…' }).click()
    await expect(page.locator('.fc-export-create-files-list li')).toHaveCount(2)
    // reorder with the keyboard-accessible buttons, and back
    await page.getByRole('button', { name: 'Move scan.png down' }).click()
    await expect(page.locator('.fc-export-create-files-list li').first()).toContainText('compare-a.pdf')
    await page.getByRole('button', { name: 'Move scan.png up' }).click()
    await expect(page.locator('.fc-export-create-files-list li').first()).toContainText('scan.png')
    await shot(page, 'combine-list')
    await page.getByTestId('create-combine').click()
    await expect.poll(() => activeDocState(page).then((s) => s?.pageCount), { timeout: 60000 }).toBe(2)
    let state = await activeDocState(page)
    expect(state?.title).toBe('Combined.pdf')
    expect(state?.dirty).toBe(true)
    await waitForRender(page)
    // Create a PDF closed so the new document shows.
    await expect(page.getByTestId('create-view')).toHaveCount(0)
    await shot(page, 'combined-tab')

    // ---- File > Create > PDF from File (Ctrl+N), two files picked in the dialog
    await stubOpenDialog(app, [fixturePath('scan.png'), fixturePath('compare-a.pdf')])
    await page.locator('.viewer').click({ position: { x: 5, y: 5 } }).catch(() => {})
    await page.keyboard.press('Control+n')
    await expect.poll(() => docCount(page), { timeout: 60000 }).toBe(2)
    state = await activeDocState(page)
    expect(state?.pageCount).toBe(2)
    expect(await pageText(page, 1)).toContain('Quarterly report')

    // ---- Blank page: A4 landscape, 3 pages
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('create.blank'))
    await expect(page.getByTestId('create-view')).toBeVisible()
    await page.getByLabel('Page size').selectOption('a4')
    await page.getByRole('radio', { name: 'Landscape' }).click()
    await page.getByLabel('Number of pages').fill('3')
    await shot(page, 'blank-form')
    await page.getByTestId('create-blank').click()
    await expect.poll(() => docCount(page), { timeout: 30000 }).toBe(3)
    const size = await page.evaluate(() => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      return { n: d.state.info.pageCount, w: Math.round(d.state.info.pages[0].width), h: Math.round(d.state.info.pages[0].height), title: d.state.title }
    })
    expect(size).toEqual({ n: 3, w: 842, h: 595, title: 'Untitled.pdf' })

    // ---- HTML file (offline conversion with Chromium)
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('create.open'))
    await page.getByRole('button', { name: /HTML file/ }).click()
    await stubOpenDialog(app, [fixturePath('export-create/sample.html')])
    await shot(page, 'html-form')
    await page.getByTestId('create-select').click()
    await expect.poll(() => docCount(page), { timeout: 60000 }).toBe(4)
    expect((await activeDocState(page))?.title).toBe('sample.pdf')
    expect(await pageText(page, 0)).toContain('Sample HTML Page')

    // ---- File > Create > PDF from Clipboard: a copied picture, then copied text
    const png = [...readFileSync(fixturePath('scan.png'))]
    await app.evaluate(async ({ clipboard, ClipboardItem }, bytes) => {
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })])
    }, png)
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('create.fromClipboard'))
    await expect.poll(() => docCount(page), { timeout: 30000 }).toBe(5)
    expect(await activeDocState(page)).toMatchObject({ title: 'Clipboard.pdf', pageCount: 1, dirty: true })
    await app.evaluate(async ({ clipboard }) => clipboard.writeText('Copied from the clipboard'))
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('create.fromClipboard'))
    await expect.poll(() => docCount(page), { timeout: 30000 }).toBe(6)
    expect(await pageText(page, 0)).toContain('Copied from the clipboard')
    await app.evaluate(({ clipboard }) => clipboard.clear())
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('create.fromClipboard'))
    await expect(page.locator('.toast', { hasText: 'The clipboard is empty' })).toBeVisible()

    // ---- an Office file opened like any file is converted with LibreOffice
    await openPath(page, fixturePath('export-create/sample.docx'))
    await expect.poll(() => docCount(page), { timeout: 90000 }).toBe(7)
    state = await activeDocState(page)
    expect(state?.title).toBe('sample.pdf')
    expect(state?.dirty).toBe(true)
    expect(await pageText(page, 0)).toContain('Converted Word Document')
    await waitForRender(page)
    await shot(page, 'docx-converted')

    // ---- Preferences > Convert finds LibreOffice
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('app.preferences'))
    await page.locator('.prefs-nav button', { hasText: 'Convert' }).click()
    await page.getByTestId('lo-detect').click()
    await expect(page.getByTestId('lo-status')).toContainText(/Found LibreOffice \d/)
    await shot(page, 'settings-convert')
    await setTheme(page, 'dark')
    await page.waitForTimeout(300)
    await shot(page, 'settings-convert-dark')
    await page.getByRole('button', { name: 'Done' }).click()
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('create.open'))
    await page.getByRole('button', { name: /^Images/ }).click()
    await shot(page, 'images-dark')
    await setTheme(page, 'light')
  } finally {
    await app.close()
  }
})
