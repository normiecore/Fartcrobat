import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, waitForRender } from './helpers'

/** Makes the native open dialog return `paths` without showing anything. */
async function stubOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('file:openDialog')
    ipcMain.handle('file:openDialog', () => result)
  }, paths)
}

async function pageTexts(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    const out: string[] = []
    for (let i = 0; i < d.pageCount; i++) out.push(await d.core.text.plain(i))
    return out
  })
}

/** Chapter numbers (or a short tag) of every page of the active document, from its text. */
async function pageOrder(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    const out: string[] = []
    for (let i = 0; i < d.pageCount; i++) {
      const t: string = await d.core.text.plain(i)
      const m = /Chapter (\d)/.exec(t)
      out.push(m ? `C${m[1]}` : t.trim() ? 'other' : 'blank')
    }
    return out
  })
}

async function rotations(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    (window as any).__fartcrobat.getActiveDoc().state.info.pages.map((p: any) => p.rotation)
  )
}

const cell = (page: Page, i: number) => page.locator(`.fc-organize-pages-cell[data-org-index="${i}"]`)

async function waitForThumbs(page: Page, n: number) {
  await expect(page.locator('.fc-organize-pages-cell')).toHaveCount(n)
  await page.waitForFunction(
    (count) => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.fc-organize-pages-canvas')]
      return canvases.length === count && canvases.every((c) => c.width > 10 && c.style.opacity === '1')
    },
    n,
    { timeout: 30000 }
  )
}

test('organize pages: select, rotate, drag, delete, insert, extract, undo', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 1400, height: 900 })
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)

    // Open "Organize pages" from the All tools pane.
    await page.locator('.shell-alltools-item', { hasText: 'Organize pages' }).click()
    await waitForThumbs(page, 5)
    await page.screenshot({ path: 'test-results/organize-pages-grid.png' })

    // Select pages 2-3 with click + Shift+click, then rotate them clockwise.
    await cell(page, 1).click()
    await cell(page, 2).click({ modifiers: ['Shift'] })
    await expect(page.locator('.fc-organize-pages-cell.is-selected')).toHaveCount(2)
    await expect(page.locator('.fc-organize-pages-status')).toContainText('2 selected (2-3)')
    await page.getByRole('button', { name: 'Rotate clockwise', exact: true }).click()
    await expect.poll(() => rotations(page)).toEqual([0, 90, 90, 0, 0])
    await waitForThumbs(page, 5)
    await page.screenshot({ path: 'test-results/organize-pages-rotated.png' })

    // Drag page 5 to the front.
    const from = await cell(page, 4).locator('.fc-organize-pages-page').boundingBox()
    const to = await cell(page, 0).locator('.fc-organize-pages-page').boundingBox()
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
    await page.mouse.down()
    await page.mouse.move(from!.x + from!.width / 2 - 30, from!.y + from!.height / 2, { steps: 4 })
    await page.mouse.move(to!.x + 8, to!.y + to!.height / 2, { steps: 12 })
    await expect(page.locator('.fc-organize-pages-indicator')).toBeVisible()
    await expect(page.locator('.fc-organize-pages-ghost')).toContainText('Move 1 page to the start')
    await page.screenshot({ path: 'test-results/organize-pages-dragging.png' })
    await page.mouse.up()
    await expect.poll(() => pageOrder(page)).toEqual(['C5', 'C1', 'C2', 'C3', 'C4'])
    await expect(cell(page, 0)).toHaveClass(/is-selected/)

    // Delete page 2 (Chapter 1) with the keyboard.
    await cell(page, 1).click()
    await page.keyboard.press('Delete')
    await expect.poll(() => pageOrder(page)).toEqual(['C5', 'C2', 'C3', 'C4'])

    // Insert a blank page after page 1 through the Insert menu.
    await cell(page, 0).click()
    await page
      .getByRole('button', { name: /^Insert/ })
      .first()
      .click()
    await page.getByRole('menuitem', { name: 'Blank page…' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Insert Pages')
    await expect(dialog).toContainText('Inserts 1 page after page 1')
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/organize-pages-insert-dialog.png' })
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect.poll(() => pageOrder(page)).toEqual(['C5', 'blank', 'C2', 'C3', 'C4'])
    await expect(cell(page, 1)).toHaveClass(/is-selected/)
    await waitForThumbs(page, 5)

    // Extract page 1 to a new tab.
    await cell(page, 0).click()
    await page.getByRole('button', { name: 'Extract', exact: true }).click()
    await expect(page.getByRole('dialog')).toContainText('Opens page 1 as a new document')
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/organize-pages-extract-dialog.png' })
    await page.getByRole('dialog').getByRole('button', { name: 'Extract', exact: true }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('Pages from text.pdf')
    expect((await activeDocState(page))?.pageCount).toBe(1)
    expect(await pageOrder(page)).toEqual(['C5'])
    await waitForThumbs(page, 1)

    // Back to the original document: undo everything step by step.
    await page.locator('.shell-tab', { hasText: 'text.pdf' }).first().click()
    await waitForThumbs(page, 5)
    const undo = page.locator('.fc-organize-pages-toolbar').getByRole('button', { name: /^Undo/ })
    await expect(undo).toHaveAttribute('aria-label', 'Undo Insert Pages')
    await undo.click()
    await expect.poll(() => pageOrder(page)).toEqual(['C5', 'C2', 'C3', 'C4'])
    await page.keyboard.press('Control+z')
    await expect.poll(() => pageOrder(page)).toEqual(['C5', 'C1', 'C2', 'C3', 'C4'])
    await undo.click()
    await expect.poll(() => pageOrder(page)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])
    await undo.click()
    await expect.poll(() => rotations(page)).toEqual([0, 0, 0, 0, 0])
    await expect(undo).toBeDisabled()
    expect((await activeDocState(page))?.dirty).toBe(false)

    // Keyboard: arrows move the focus, Shift extends, Ctrl+A selects all.
    await cell(page, 0).click()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowRight')
    await expect(page.locator('.fc-organize-pages-status')).toContainText('2 selected (2-3)')
    await page.keyboard.press('Control+a')
    await expect(page.locator('.fc-organize-pages-status')).toContainText('5 selected')
    await page.keyboard.press('Escape')
    await expect(page.locator('.fc-organize-pages-cell.is-selected')).toHaveCount(0)

    // Bigger thumbnails, dark theme.
    await page.getByRole('slider', { name: 'Thumbnail size' }).fill('260')
    await waitForThumbs(page, 5)
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
    await cell(page, 2).click()
    await cell(page, 3).hover()
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'test-results/organize-pages-dark.png' })
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'))

    // Close returns to the normal view.
    await page.locator('.fc-organize-pages-toolbar').getByRole('button', { name: 'Close' }).click()
    await expect(page.locator('.fc-organize-pages-view')).toHaveCount(0)
    await expect(page.locator('.viewer-page').first()).toBeVisible()
  } finally {
    await app.close()
  }
})

test('combine files into a new document with one bookmark per file', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 1400, height: 900 })
    const files = [fixturePath('compare-a.pdf'), fixturePath('compare-b.pdf'), fixturePath('scan.png')]
    await app.evaluate(({ ipcMain }, paths) => {
      ipcMain.removeHandler('file:openDialog')
      ipcMain.handle('file:openDialog', () => paths)
    }, files)
    await page.locator('.home-tile', { hasText: 'Combine files' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Combine Files')
    await dialog.getByRole('button', { name: 'Add files…' }).click()
    await expect(dialog.locator('.fc-organize-pages-combine-row')).toHaveCount(3)
    await expect(dialog.locator('.fc-organize-pages-combine-thumb img')).toHaveCount(3)
    await expect(dialog).toContainText('3 files · 3 pages')
    // Reorder: move scan.png to the top, then back down with the arrow buttons.
    await dialog.getByRole('button', { name: 'Move scan.png up' }).click()
    await expect(dialog.locator('.fc-organize-pages-combine-name').nth(1)).toHaveText('scan.png')
    await dialog.getByRole('button', { name: 'Move scan.png down' }).click()
    await expect(dialog.locator('.fc-organize-pages-combine-name').nth(2)).toHaveText('scan.png')
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/organize-pages-combine.png' })
    await dialog.getByRole('button', { name: 'Combine', exact: true }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('Binder1.pdf')
    await waitForRender(page)
    const st = await activeDocState(page)
    expect(st?.pageCount).toBe(3)
    expect(st?.dirty).toBe(true)
    const outline = await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const o = await d.core.nav.outline()
      return o.map((b: any) => [b.title, b.dest?.page])
    })
    expect(outline).toEqual([
      ['compare-a', 0],
      ['compare-b', 1],
      ['scan', 2]
    ])
    await page.screenshot({ path: 'test-results/organize-pages-combined.png' })
  } finally {
    await app.close()
  }
})

test('organize dialogs: rotate, page labels, insert from file, replace, split, context menu', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 1280, height: 860 })
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)

    // Ctrl+Shift+R outside the grid opens Rotate Pages.
    await page.locator('.viewer-scroll').click({ position: { x: 20, y: 300 } })
    await page.keyboard.press('Control+Shift+R')
    let dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Rotate Pages')
    await dialog.getByLabel('Page range').fill('2-5')
    await dialog.locator('select').first().selectOption('even')
    await expect(dialog).toContainText('2 pages will be rotated.')
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/organize-pages-rotate-dialog.png' })
    await dialog.getByRole('button', { name: 'Rotate', exact: true }).click()
    await expect.poll(() => rotations(page)).toEqual([0, 90, 0, 90, 0])

    // Document menu > Organize Pages (through the app menu).
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('menuitem', { name: 'Document' }).hover()
    await page.getByRole('menuitem', { name: 'Organize Pages' }).click()
    await waitForThumbs(page, 5)

    // Right-click > Duplicate Page.
    await cell(page, 0).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Duplicate Page' })).toBeVisible()
    await page.waitForTimeout(150)
    await page.screenshot({ path: 'test-results/organize-pages-context-menu.png' })
    await page.getByRole('menuitem', { name: 'Duplicate Page' }).click()
    await expect.poll(() => pageOrder(page)).toEqual(['C1', 'C1', 'C2', 'C3', 'C4', 'C5'])
    await expect(cell(page, 1)).toHaveClass(/is-selected/)

    // Page labels: i, ii for the first two pages.
    await page.locator('.fc-organize-pages-toolbar').getByRole('button', { name: 'Page labels' }).click()
    dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Page Labels')
    await dialog.getByLabel('From page').fill('1')
    await dialog.getByLabel('To page').fill('2')
    await dialog.locator('select').first().selectOption('r')
    await expect(dialog).toContainText('Sample: i, ii')
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/organize-pages-labels-dialog.png' })
    await dialog.getByRole('button', { name: 'OK', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as any).__fartcrobat.getActiveDoc().state.info.pages.map((p: any) => p.label)
        )
      )
      .toEqual(['i', 'ii', '3', '4', '5', '6'])
    await expect(cell(page, 0).locator('.fc-organize-pages-num')).toHaveText('i')

    // Insert from file through the "+" between pages 1 and 2.
    await stubOpenDialog(app, [fixturePath('compare-a.pdf')])
    const box = await cell(page, 1).boundingBox()
    await page.mouse.move(box!.x - 14, box!.y + 60)
    const plus = page.getByRole('button', { name: 'Insert pages after page 1' })
    await expect(plus).toBeVisible()
    await plus.click()
    await page.getByRole('menuitem', { name: 'From file…' }).click()
    dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('compare-a.pdf')
    await expect(dialog).toContainText('Inserts 1 page after page 1')
    await dialog.getByRole('button', { name: 'Insert', exact: true }).click()
    await expect.poll(async () => (await pageTexts(page))[1]).toContain('Quarterly report')
    expect((await activeDocState(page))?.pageCount).toBe(7)
    await waitForThumbs(page, 7)
    await page.screenshot({ path: 'test-results/organize-pages-labels-grid.png' })

    // Replace the inserted page with compare-b.pdf.
    await stubOpenDialog(app, [fixturePath('compare-b.pdf')])
    await cell(page, 1).click()
    await page.locator('.fc-organize-pages-toolbar').getByRole('button', { name: 'Replace' }).click()
    dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Replace Pages')
    await expect(dialog).toContainText('Page 2 of this document will show page 1 of compare-b.pdf')
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/organize-pages-replace-dialog.png' })
    await dialog.getByRole('button', { name: 'Replace', exact: true }).click()
    await expect.poll(async () => (await pageTexts(page))[1]).toContain('audit team')
    expect((await activeDocState(page))?.pageCount).toBe(7)

    // Split into files of 4 pages in a folder.
    const outDir = mkdtempSync(join(tmpdir(), 'fartcrobat-split-'))
    await stubOpenDialog(app, [outDir])
    await page.locator('.fc-organize-pages-toolbar').getByRole('button', { name: 'Split' }).click()
    dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Split Document')
    await dialog.getByLabel('Pages per file').fill('4')
    await dialog.getByRole('button', { name: 'Change…' }).click()
    await expect(dialog.getByLabel('Output folder')).toHaveValue(outDir)
    await expect(dialog).toContainText('Creates 2 files')
    await expect(dialog).toContainText('text Part 1.pdf')
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/organize-pages-split-dialog.png' })
    await dialog.getByRole('button', { name: 'Split', exact: true }).click()
    await expect
      .poll(() => (existsSync(outDir) ? readdirSync(outDir).sort() : []))
      .toEqual(['text Part 1.pdf', 'text Part 2.pdf'])
  } finally {
    await app.close()
  }
})

test('organize pages: keyboard moves, copy by dragging, clipboard and Delete Pages dialog', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 1280, height: 860 })
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.locator('.shell-alltools-item', { hasText: 'Organize pages' }).click()
    await waitForThumbs(page, 5)

    // Alt+Right moves the selected page one place to the right.
    await cell(page, 0).click()
    await page.keyboard.press('Alt+ArrowRight')
    await expect.poll(() => pageOrder(page)).toEqual(['C2', 'C1', 'C3', 'C4', 'C5'])
    await expect(cell(page, 1)).toHaveClass(/is-selected/)
    await page.keyboard.press('Alt+ArrowLeft')
    await expect.poll(() => pageOrder(page)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])

    // Ctrl+drag copies page 2 to the end.
    await cell(page, 1).click()
    const from = await cell(page, 1).locator('.fc-organize-pages-page').boundingBox()
    const last = await cell(page, 4).locator('.fc-organize-pages-page').boundingBox()
    await page.mouse.move(from!.x + 20, from!.y + 20)
    await page.mouse.down()
    await page.mouse.move(from!.x + 60, from!.y + 40, { steps: 3 })
    await page.keyboard.down('Control')
    await page.mouse.move(last!.x + last!.width - 6, last!.y + last!.height / 2, { steps: 10 })
    await expect(page.locator('.fc-organize-pages-ghost')).toContainText('Copy 1 page to the end')
    await page.mouse.up()
    await page.keyboard.up('Control')
    await expect.poll(() => pageOrder(page)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C2'])
    await expect(cell(page, 5)).toHaveClass(/is-selected/)

    // Insert copied text from the clipboard after the selected page.
    await app.evaluate(async ({ clipboard }) => {
      await clipboard.writeText('Hello from the clipboard.\n\nSecond paragraph.')
    })
    await page
      .locator('.fc-organize-pages-toolbar')
      .getByRole('button', { name: /^Insert/ })
      .click()
    await page.getByRole('menuitem', { name: 'From clipboard' }).click()
    await expect.poll(async () => (await pageTexts(page))[6] ?? '').toContain('Hello from the clipboard.')
    await waitForThumbs(page, 7)
    await page.screenshot({ path: 'test-results/organize-pages-clipboard.png' })

    // Delete Pages… (Ctrl+Shift+D) removes a range.
    await page.keyboard.press('Control+Shift+D')
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Delete Pages')
    await dialog.getByLabel('Page range').fill('6-7')
    await expect(dialog).toContainText('2 pages will be deleted')
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect.poll(() => pageOrder(page)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])

    // Deleting every page is refused.
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Delete')
    await expect(page.locator('.toast').last()).toContainText("You can't delete every page")
    expect((await activeDocState(page))?.pageCount).toBe(5)

    // Select > Even pages, then Ctrl+Shift+R rotates them.
    await page.locator('.fc-organize-pages-toolbar').getByRole('button', { name: 'Select' }).click()
    await page.getByRole('menuitem', { name: 'Even pages' }).click()
    await expect(page.locator('.fc-organize-pages-status')).toContainText('2 selected (2, 4)')
    await page.keyboard.press('Control+Shift+R')
    await expect.poll(() => rotations(page)).toEqual([0, 90, 0, 90, 0])

    // The quick buttons on a hovered thumbnail act on that page.
    await cell(page, 0).click()
    await cell(page, 4).hover()
    await cell(page, 4).getByRole('button', { name: 'Rotate counterclockwise (page 5)' }).click()
    await expect.poll(() => rotations(page)).toEqual([0, 90, 0, 90, 270])

    // Files dragged in from the desktop show where they will be inserted.
    const target = await cell(page, 2).boundingBox()
    await page.evaluate(
      ({ x, y }) => {
        const dt = new DataTransfer()
        dt.items.add(new File(['%PDF-1.4'], 'dropped.pdf', { type: 'application/pdf' }))
        const el = document.querySelector('.fc-organize-pages-scroll')!
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }))
      },
      { x: target!.x + 10, y: target!.y + 60 }
    )
    await expect(page.locator('.fc-organize-pages-indicator.is-file')).toBeVisible()
    await page.screenshot({ path: 'test-results/organize-pages-file-drop.png' })
    await page.evaluate(() => {
      document
        .querySelector('.fc-organize-pages-scroll')!
        .dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, relatedTarget: document.body }))
    })
    await expect(page.locator('.fc-organize-pages-indicator')).toHaveCount(0)

    // Double-click opens the page in the normal view.
    await cell(page, 3).dblclick()
    await expect(page.locator('.fc-organize-pages-view')).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view?.visiblePages().includes(3)))
      .toBe(true)
  } finally {
    await app.close()
  }
})

test('combine files: page ranges, open documents and sorting', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 1280, height: 860 })
    await openFile(page, fixturePath('mixed-sizes.pdf'))
    await waitForRender(page)
    await stubOpenDialog(app, [fixturePath('text.pdf')])
    await page.getByRole('button', { name: 'Menu' }).click()
    await page.getByRole('menuitem', { name: 'File', exact: true }).hover()
    await page.getByRole('menuitem', { name: 'Combine Files…' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('button', { name: 'Add files…' }).click()
    await expect(dialog.locator('.fc-organize-pages-combine-row')).toHaveCount(1)
    await dialog.getByRole('button', { name: 'Add open files' }).click()
    await page.getByRole('menuitem', { name: 'mixed-sizes.pdf' }).click()
    await expect(dialog.locator('.fc-organize-pages-combine-thumb img')).toHaveCount(2)
    await expect(dialog).toContainText('2 files · 8 pages')

    // Choose pages 2-3 of text.pdf, then leave page 3 out by clicking its preview.
    await dialog.getByRole('button', { name: /All 5 pages/ }).click()
    await dialog.getByLabel('Pages of text.pdf').fill('2-3')
    await expect(dialog).toContainText('2 files · 5 pages')
    await dialog.locator('.fc-organize-pages-strip-page').nth(2).click()
    await expect(dialog.getByLabel('Pages of text.pdf')).toHaveValue('2')
    await expect(dialog).toContainText('2 files · 4 pages')
    await expect(dialog.locator('.fc-organize-pages-strip-page img')).toHaveCount(5)
    await page.screenshot({ path: 'test-results/organize-pages-combine-ranges.png' })

    // Sort by name (Z to A) puts text.pdf first.
    await dialog.getByRole('button', { name: 'Sort' }).click()
    await page.getByRole('menuitem', { name: 'Name (Z to A)' }).click()
    await expect(dialog.locator('.fc-organize-pages-combine-name').first()).toHaveText('text.pdf')

    await dialog.getByRole('button', { name: 'Combine', exact: true }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('Binder1.pdf')
    // (the third page of mixed-sizes.pdf has no extractable text)
    expect(await pageOrder(page)).toEqual(['C2', 'other', 'other', 'blank'])
    const outline = await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const o = await d.core.nav.outline()
      return o.map((b: any) => [b.title, b.dest?.page, b.children.map((c: any) => c.title)])
    })
    expect(outline).toEqual([
      ['text', 0, ['Chapter 2']],
      ['mixed-sizes', 1, []]
    ])
  } finally {
    await app.close()
  }
})

test('organize pages: narrow window, copy pages to another document, 640 pages', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 960, height: 720 })
    await openFile(page, fixturePath('mixed-sizes.pdf'))
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.locator('.shell-alltools-item', { hasText: 'Organize pages' }).click()
    await waitForThumbs(page, 5)

    // In a narrow window the toolbar shows icons only; the buttons keep their names.
    const toolbar = page.locator('.fc-organize-pages-toolbar')
    await expect(toolbar.locator('.fc-organize-pages-btn-text').first()).toBeHidden()
    await expect(toolbar.getByRole('button', { name: 'Extract', exact: true })).toBeVisible()
    const tb = await toolbar.boundingBox()
    expect(tb!.height).toBeLessThan(50)
    await page.screenshot({ path: 'test-results/organize-pages-narrow.png' })

    // Keyboard: Enter on a focused toolbar button runs it (it doesn't open the focused page);
    // arrow keys still move through the pages and bring the focus back to the grid.
    await cell(page, 2).click()
    await toolbar.getByRole('button', { name: 'Extract', exact: true }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByRole('dialog')).toContainText('Extract Pages')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await toolbar.getByRole('button', { name: 'Split', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.fc-organize-pages-status')).toContainText('1 selected (4)')
    await expect(page.locator('.fc-organize-pages-scroll')).toBeFocused()

    // Drag pages 1-2 onto the other document's tab: they are copied to its end.
    await cell(page, 0).click()
    await cell(page, 1).click({ modifiers: ['Shift'] })
    const from = await cell(page, 1).locator('.fc-organize-pages-page').boundingBox()
    const tab = await page.locator('.shell-tab', { hasText: 'mixed-sizes.pdf' }).boundingBox()
    await page.mouse.move(from!.x + 30, from!.y + 30)
    await page.mouse.down()
    await page.mouse.move(from!.x + 60, from!.y + 50, { steps: 3 })
    await page.mouse.move(tab!.x + tab!.width / 2, tab!.y + tab!.height / 2, { steps: 12 })
    await expect(page.locator('.fc-organize-pages-ghost')).toHaveText('Copy 2 pages to the end of mixed-sizes.pdf')
    await expect(page.locator('.fc-organize-pages-tab-target')).toBeVisible()
    await page.screenshot({ path: 'test-results/organize-pages-drag-to-tab.png' })
    await page.mouse.up()
    const docsState = () =>
      page.evaluate(() =>
        (window as any).__fartcrobat.useApp
          .getState()
          .docs.map((d: any) => ({ title: d.state.title, pages: d.pageCount, dirty: d.state.dirty }))
      )
    await expect.poll(docsState).toEqual([
      { title: 'mixed-sizes.pdf', pages: 5, dirty: true },
      { title: 'text.pdf', pages: 5, dirty: false }
    ])
    // "Show" switches to the other document with the copied pages selected.
    await page.locator('.toast', { hasText: 'Copied 2 pages' }).getByRole('button', { name: 'Show' }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('mixed-sizes.pdf')
    await waitForThumbs(page, 5)
    await expect(page.locator('.fc-organize-pages-status')).toContainText('2 selected (4-5)')
    expect((await pageOrder(page)).slice(3)).toEqual(['C1', 'C2'])
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await activeDocState(page))?.pageCount).toBe(3)

    // A long document: only the visible thumbnails are in the page.
    await page.locator('.shell-tab', { hasText: 'text.pdf' }).click()
    await waitForThumbs(page, 5)
    await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      for (let k = 0; k < 7; k++) {
        const n = (await d.core.doc.info()).pageCount
        await d.ops('pages').duplicate([...Array(n).keys()], n)
      }
    })
    await expect(page.locator('.fc-organize-pages-status')).toContainText('640 pages')
    expect(await page.locator('.fc-organize-pages-cell').count()).toBeLessThan(60)
    await cell(page, 0).click()
    await page.keyboard.press('End')
    await expect(cell(page, 639)).toBeInViewport()
    await expect(cell(page, 639)).toHaveClass(/is-selected/)
    await page.keyboard.press('Control+a')
    await expect(page.locator('.fc-organize-pages-status')).toContainText('640 selected (1-640)')
    await expect(cell(page, 639)).toBeInViewport()
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'test-results/organize-pages-640.png' })
  } finally {
    await app.close()
  }
})

test('extract pages as separate files and split by bookmarks', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 1280, height: 860 })
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.locator('.shell-alltools-item', { hasText: 'Organize pages' }).click()
    await waitForThumbs(page, 5)

    // Extract pages 2-3 as separate files, deleting them afterwards.
    const extractDir = mkdtempSync(join(tmpdir(), 'fartcrobat-extract-'))
    await stubOpenDialog(app, [extractDir])
    await cell(page, 1).click()
    await cell(page, 2).click({ modifiers: ['Shift'] })
    await page.locator('.fc-organize-pages-toolbar').getByRole('button', { name: 'Extract' }).click()
    let dialog = page.getByRole('dialog')
    await dialog.getByLabel('Delete pages after extracting').check()
    await dialog.getByLabel('Extract pages as separate files').check()
    await expect(dialog).toContainText('Saves 2 files (one per page)')
    await dialog.getByRole('button', { name: 'Extract', exact: true }).click()
    await expect
      .poll(() => (existsSync(extractDir) ? readdirSync(extractDir).sort() : []))
      .toEqual(['text - page 2.pdf', 'text - page 3.pdf'])
    await expect.poll(() => pageOrder(page)).toEqual(['C1', 'C4', 'C5'])
    await page.keyboard.press('Control+z')
    await expect.poll(() => pageOrder(page)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])

    // Split at the top-level bookmarks, naming the files after them.
    const splitDir = mkdtempSync(join(tmpdir(), 'fartcrobat-split-'))
    await stubOpenDialog(app, [splitDir])
    await page.locator('.fc-organize-pages-toolbar').getByRole('button', { name: 'Split' }).click()
    dialog = page.getByRole('dialog')
    await dialog.getByLabel('Top-level bookmarks').check()
    await dialog.getByRole('button', { name: 'Change…' }).click()
    await expect(dialog).toContainText('Creates 5 files')
    await page.waitForTimeout(250)
    await page.screenshot({ path: 'test-results/organize-pages-split-bookmarks.png' })
    await dialog.getByRole('button', { name: 'Split', exact: true }).click()
    await expect
      .poll(() => (existsSync(splitDir) ? readdirSync(splitDir).sort() : []))
      .toEqual(['Chapter 1.pdf', 'Chapter 2.pdf', 'Chapter 3.pdf', 'Chapter 4.pdf', 'Chapter 5.pdf'])
  } finally {
    await app.close()
  }
})
