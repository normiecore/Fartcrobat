import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/edit-text-${name}.png` })

async function pageText(page: Page, index = 0): Promise<string> {
  return page.evaluate(
    async (i) => (await (window as any).__fartcrobat.getActiveDoc().pageText(i)).text as string,
    index
  )
}

interface Line {
  text: string
  dir: [number, number]
  bbox: number[]
}

/** Lines of a page's text with their direction. */
async function pageLines(page: Page, index = 0): Promise<Line[]> {
  return page.evaluate(async (i) => {
    const t = await (window as any).__fartcrobat.getActiveDoc().pageText(i)
    return t.lines.map((l: any) => ({
      text: t.text.slice(l.start, l.end) as string,
      dir: l.dir as [number, number],
      bbox: l.bbox as number[]
    }))
  }, index)
}

async function spanAt(page: Page, needle: string, index = 0) {
  return page.evaluate(
    async ({ i, needle }) => {
      const t = await (window as any).__fartcrobat.getActiveDoc().pageText(i)
      const at = t.text.indexOf(needle)
      const s = t.spans.find((x: any) => x.start <= at && x.end > at)
      return s ? { font: s.font as string, size: s.size as number, color: s.color as number } : null
    },
    { i: index, needle }
  )
}

/** Screen position of the left edge (vertical middle) of a character, on an unrotated view. */
async function charPoint(page: Page, needle: string, index = 0) {
  const p = await page.evaluate(
    async ({ i, needle }) => {
      const doc = (window as any).__fartcrobat.getActiveDoc()
      const t = await doc.pageText(i)
      const at = t.text.indexOf(needle)
      const q = t.quads.slice(at * 8, at * 8 + 8)
      const el = document.querySelector(`.viewer-page[data-page-index="${i}"]`)!.getBoundingClientRect()
      const s = (doc.state.zoom * 96) / 72
      return { x: el.left + q[0] * s, y: el.top + ((q[1] + q[5]) / 2) * s }
    },
    { i: index, needle }
  )
  return p
}

/** Clicks a spot of a page, given as a fraction of its width and height. */
async function clickPage(page: Page, fx: number, fy: number, index = 0) {
  const box = (await page.locator(`.viewer-page[data-page-index="${index}"]`).boundingBox())!
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
}

const editor = (page: Page) => page.locator('[data-fc-edit-text-editor]')
const toolId = (page: Page) =>
  page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId as string)
const blockButton = (page: Page, name: RegExp, index = 0) =>
  page.locator(`.viewer-page[data-page-index="${index}"]`).getByRole('button', { name })

test('edits the heading, resizes a paragraph, adds text and undoes everything', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    const original = await pageText(page)

    // open "Edit a PDF" from the All tools list: every paragraph gets an outline
    await page.locator('.shell-alltools-item', { hasText: 'Edit a PDF' }).click()
    await expect(page.locator('.ui-panel-header h3', { hasText: 'Edit a PDF' })).toBeVisible()
    await expect.poll(() => toolId(page)).toBe('edit.content')
    await expect(blockButton(page, /^Edit text: Chapter 1$/)).toBeVisible()
    await expect(blockButton(page, /^Edit text: Lorem ipsum/)).toBeVisible()
    await page.waitForTimeout(300)
    await shot(page, '1-before')

    // click the heading, select all and type a new one
    await blockButton(page, /^Edit text: Chapter 1$/).click()
    await expect(editor(page)).toBeFocused()
    await expect(page.locator('.fc-edit-text-frame')).not.toHaveClass(/is-pending/)
    await expect(page.locator('.fc-edit-text-mini')).toBeVisible()
    // the editor sits exactly over the original text, at the original size
    const heading = (await page.locator('.fc-edit-text-frame').boundingBox())!
    const box = await page.evaluate(async () => {
      const doc = (window as any).__fartcrobat.getActiveDoc()
      const t = await doc.pageText(0)
      const l = t.lines.find((x: any) => t.text.slice(x.start, x.end) === 'Chapter 1')
      const el = document.querySelector('.viewer-page[data-page-index="0"]')!.getBoundingClientRect()
      const s = (doc.state.zoom * 96) / 72
      return {
        x: el.left + l.bbox[0] * s,
        y: el.top + l.bbox[1] * s,
        w: (l.bbox[2] - l.bbox[0]) * s,
        h: (l.bbox[3] - l.bbox[1]) * s
      }
    })
    expect(Math.abs(heading.x - box.x)).toBeLessThan(3)
    expect(Math.abs(heading.y + heading.height / 2 - (box.y + box.h / 2))).toBeLessThan(4)
    expect(Math.abs(heading.width - box.w)).toBeLessThan(box.w * 0.08)
    await shot(page, '2-editing-heading')
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Introduction')
    await expect(editor(page)).toHaveText('Introduction')
    // while editing, the selection is the custom 'edit-text:block' selection
    expect((await activeDocState(page))?.selection).toMatchObject({
      kind: 'custom',
      type: 'edit-text:block',
      page: 0
    })
    await shot(page, '3-typed-heading')

    // click outside: the change is written into the page content
    await clickPage(page, 0.8, 0.75)
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(() => pageText(page)).toContain('Introduction')
    expect(await pageText(page)).not.toContain('Chapter 1')
    let st = await activeDocState(page)
    expect(st?.journal.undoLabel).toBe('Edit Text')
    expect(st?.dirty).toBe(true)
    expect(await spanAt(page, 'Introduction')).toMatchObject({ font: 'Helvetica-Bold', size: 24 })
    await page.waitForTimeout(500)
    await shot(page, '4-after-heading')

    // change the size of a paragraph from the panel (no text selected = the whole paragraph)
    const loremRight = Math.max(
      ...(await pageLines(page)).filter((x) => x.text.startsWith('Lorem')).map((x) => x.bbox[2])
    )
    await blockButton(page, /^Edit text: Lorem ipsum/).click()
    await expect(editor(page)).toBeFocused()
    const size = page.locator('.fc-edit-text-panel').getByLabel('Font size')
    await expect(size).toHaveValue('11')
    await size.fill('10')
    await size.press('Enter')
    await expect(editor(page)).toBeFocused()
    const px = await page.evaluate(
      () => (((window as any).__fartcrobat.getActiveDoc().state.zoom * 96) / 72) * 10
    )
    await expect
      .poll(() =>
        editor(page).evaluate((el) => parseFloat(getComputedStyle(el.querySelector('span')!).fontSize))
      )
      .toBeCloseTo(px, 1)
    await page.waitForTimeout(300)
    await shot(page, '5-paragraph-size')
    await clickPage(page, 0.8, 0.75)
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(async () => (await spanAt(page, 'Lorem ipsum'))?.size).toBeCloseTo(10, 1)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Edit Text')
    // the paragraph still wraps inside its original width
    for (const l of (await pageLines(page)).filter(
      (x) => x.text.includes('Lorem') || x.text.includes('consectetur')
    ))
      expect(l.bbox[2]).toBeLessThan(loremRight + 1)
    await page.waitForTimeout(500)
    await shot(page, '6-after-paragraph-size')

    // add new text with "Add text": a click places it
    await page
      .locator('.fc-edit-text-panel')
      .getByRole('button', { name: /^Add text/ })
      .click()
    await expect.poll(() => toolId(page)).toBe('edit.addText')
    await clickPage(page, 0.55, 0.66)
    await expect(editor(page)).toBeFocused()
    await page.keyboard.type('Added with Fartcrobat')
    await shot(page, '7-adding-text')
    await clickPage(page, 0.3, 0.9)
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(() => pageText(page)).toContain('Added with Fartcrobat')
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Add Text')
    // after placing text the tool goes back to editing
    expect(await toolId(page)).toBe('edit.content')
    expect(await spanAt(page, 'Added with')).toMatchObject({ font: 'Helvetica', size: 12 })

    // ... and a drag sets the width the text wraps to
    await page.locator('.fc-edit-text-toolbar').getByRole('radio', { name: 'Add text' }).click()
    const pg = (await page.locator('.viewer-page[data-page-index="0"]').boundingBox())!
    await page.mouse.move(pg.x + pg.width * 0.12, pg.y + pg.height * 0.72)
    await page.mouse.down()
    await page.mouse.move(pg.x + pg.width * 0.3, pg.y + pg.height * 0.74, { steps: 6 })
    await expect(page.locator('.fc-edit-text-marquee')).toBeVisible()
    await page.mouse.up()
    await expect(editor(page)).toBeFocused()
    await page.keyboard.type('A narrow text box wraps its words onto several lines')
    await page.waitForTimeout(200)
    await shot(page, '8-adding-wrapped-text')
    await page.keyboard.press('Control+Enter')
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(() => pageText(page)).toContain('A narrow text box')
    const wrapped = (await pageLines(page)).filter((l) => /narrow|wraps|lines/.test(l.text))
    expect(wrapped.length).toBeGreaterThanOrEqual(2)
    const left = Math.min(...wrapped.map((l) => l.bbox[0]))
    const right = Math.max(...wrapped.map((l) => l.bbox[2]))
    expect(right - left).toBeLessThan(612 * 0.18 + 2)
    await page.waitForTimeout(500)
    await shot(page, '9-after-add')

    // undo with the keyboard: the added text goes, then the paragraph size, then the heading
    await page.keyboard.press('Control+Z')
    await expect.poll(() => pageText(page)).not.toContain('A narrow text box')
    await page.keyboard.press('Control+Z')
    await expect.poll(() => pageText(page)).not.toContain('Added with Fartcrobat')
    await page.keyboard.press('Control+Z')
    await expect.poll(async () => (await spanAt(page, 'Lorem ipsum'))?.size).toBeCloseTo(11, 1)
    expect(await pageText(page)).toContain('Introduction')
    await page.waitForTimeout(500)
    await shot(page, '10-after-undo')
    await page.keyboard.press('Control+Z')
    await expect.poll(() => pageText(page)).toBe(original)
    st = await activeDocState(page)
    expect(st?.journal.canUndo).toBe(false)
    expect(st?.journal.redoLabel).toBe('Edit Text')
  } finally {
    await app.close()
  }
})

test('places the caret where clicked at 200%, formats a selection, keeps line breaks, cancels with Esc, dark mode', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.locator('.shell-alltools-item', { hasText: 'Edit a PDF' }).click()
    await page.getByLabel('Zoom', { exact: true }).selectOption('2')
    await expect.poll(async () => (await activeDocState(page))?.zoom).toBeCloseTo(2, 2)
    await page.waitForTimeout(400)
    await page.evaluate(() => {
      const el = (window as any).__fartcrobat.getActiveDoc().view.getViewportElement()
      el.scrollLeft = 0
    })
    await page.evaluate(() =>
      (window as any).__fartcrobat.getActiveDoc().view.scrollToRect(0, [66, 100, 90, 130])
    )
    await page.waitForTimeout(400)
    await waitForRender(page)

    // Esc cancels without changing anything
    await blockButton(page, /^Edit text: Hello Fartcrobat page 1/).click()
    await expect(editor(page)).toBeFocused()
    await page.keyboard.type('XYZ')
    await page.keyboard.press('Escape')
    await expect(editor(page)).toHaveCount(0)
    expect(await pageText(page)).not.toContain('XYZ')
    expect((await activeDocState(page))?.journal.canUndo).toBe(false)
    expect(await toolId(page)).toBe('edit.content')

    // the caret goes where the text was clicked
    const q = await charPoint(page, 'quick')
    await page.mouse.click(q.x + 2, q.y)
    await expect(editor(page)).toBeFocused()
    await page.keyboard.type('very ')
    await expect(editor(page)).toHaveText(
      'Hello Fartcrobat page 1. The very quick brown fox jumps over the lazy dog.'
    )

    // select to the end of the line: bold with the keyboard, underline and colour from the mini toolbar
    await page.keyboard.press('Shift+End')
    await page.keyboard.press('Control+B')
    const mini = page.locator('.fc-edit-text-mini')
    await expect(mini.getByRole('button', { name: /^Bold/ })).toHaveAttribute('aria-pressed', 'true')
    await mini.getByRole('button', { name: /^Underline/ }).click()
    await mini.locator('.ui-color-button').click()
    await page.locator('.ui-popover .ui-swatch[title="#F44336"]').click()
    await expect(mini.getByRole('button', { name: /^Underline/ })).toHaveAttribute('aria-pressed', 'true')
    // a line break
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('A second line')
    await page.waitForTimeout(300)
    // keyboard selection scrolled the end of the line into view: show the start of the page again
    await page.evaluate(() => ((window as any).__fartcrobat.getActiveDoc().view.getViewportElement().scrollLeft = 0))
    await page.waitForTimeout(200)
    await shot(page, '11-zoom-200-formatting')

    await page.evaluate(() => {
      const s = (window as any).__fartcrobat.useApp
      s.setState({ prefs: { ...s.getState().prefs, theme: 'dark' } })
    })
    await page.waitForTimeout(300)
    await shot(page, '12-dark-editing')
    await mini.getByRole('button', { name: /^Done/ }).click()
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(async () => (await spanAt(page, 'quick brown'))?.font).toBe('Helvetica-Bold')
    expect((await spanAt(page, 'quick brown'))?.color).toBe(0xf44336)
    expect(await spanAt(page, 'Hello Fartcrobat')).toMatchObject({ font: 'Helvetica', color: 0 })
    const lines = (await pageLines(page)).map((l) => l.text)
    expect(lines).toContain('Hello Fartcrobat page 1. The very quick brown fox jumps over the lazy dog.')
    expect(lines).toContain('A second line')
    await page.waitForTimeout(600)
    await shot(page, '13-dark-after')
  } finally {
    await app.close()
  }
})

test('edits a rotated page, adds upright text in a rotated view and edits selected text from the selection bar', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('edit-text/rotated.pdf'))
    await waitForRender(page)
    await page.locator('.shell-alltools-item', { hasText: 'Edit a PDF' }).click()
    await expect(blockButton(page, /^Edit text: Rotated heading/)).toBeVisible()

    // page with /Rotate 90: the text reads upright and is edited in place
    await blockButton(page, /^Edit text: Rotated heading/).click()
    await expect(editor(page)).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.type(' (edited)')
    await page.waitForTimeout(200)
    await shot(page, '14-rotated-page-editing')
    await clickPage(page, 0.5, 0.8)
    await expect.poll(() => pageText(page)).toContain('Rotated heading (edited)')

    // View > Rotate View: new text still reads left to right on screen
    await page.keyboard.press('Control+Shift+=')
    await page.waitForTimeout(500)
    await page.locator('.fc-edit-text-toolbar').getByRole('radio', { name: 'Add text' }).click()
    await clickPage(page, 0.3, 0.5)
    await expect(editor(page)).toBeFocused()
    await page.keyboard.type('Upright note')
    await page.waitForTimeout(200)
    const frame = (await page.locator('.fc-edit-text-frame').boundingBox())!
    expect(frame.width).toBeGreaterThan(frame.height * 2)
    await shot(page, '15-rotated-view-add')
    await clickPage(page, 0.8, 0.9)
    await expect.poll(() => pageText(page)).toContain('Upright note')
    const note = (await pageLines(page)).find((l) => l.text === 'Upright note')!
    // in page space the line runs along y (the view is turned by 90 degrees)
    expect(Math.abs(note.dir[1])).toBeCloseTo(1, 3)
    await page.waitForTimeout(500)
    await shot(page, '16-rotated-view-after')
    await page.keyboard.press('Control+Shift+-')

    // with the Select tool, select a word and choose "Edit text" on the selection bar
    await page.locator('.fc-edit-text-toolbar').getByRole('button', { name: 'Close' }).click()
    await expect.poll(() => toolId(page)).toBe('select')
    await page.waitForTimeout(300)
    const a = await charPoint(page, 'ninety')
    const b = await charPoint(page, ' degrees')
    await page.mouse.move(a.x + 1, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x - 1, b.y, { steps: 6 })
    await page.mouse.up()
    const action = page.locator('.viewer-selection-toolbar button[title="Edit text"]')
    await expect(action).toBeVisible()
    await shot(page, '17-selection-bar')
    await action.click()
    await expect(editor(page)).toBeFocused()
    expect(await toolId(page)).toBe('edit.content')
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('ninety')
    await page.keyboard.type('ninety-one')
    await page.keyboard.press('Control+Enter')
    await expect.poll(() => pageText(page)).toContain('rotated by ninety-one degrees.')
    await page.waitForTimeout(500)
    await shot(page, '18-selection-edited')
  } finally {
    await app.close()
  }
})

test('links to page tools of other features, helps on scanned pages and edits from the page context menu', async () => {
  const { app, page } = await launch()
  try {
    // stand-ins for commands that other features register (page marks, OCR)
    await page.evaluate(() => {
      const w = window as any
      w.__ran = []
      for (const id of [
        'marks.watermark.add',
        'marks.watermark.update',
        'marks.watermark.remove',
        'ocr.recognize'
      ])
        w.__fartcrobat.registry.commands.set(id, { id, label: id, run: () => w.__ran.push(id) })
    })
    await openFile(page, fixturePath('scanned.pdf'))
    await waitForRender(page)
    await page.locator('.shell-alltools-item', { hasText: 'Edit a PDF' }).click()
    // a scan has no editable text: the bar says so and offers OCR
    const bar = page.locator('.fc-edit-text-toolbar')
    await expect(bar).toContainText('This page has no editable text')
    await bar.getByRole('button', { name: 'Recognize text' }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__ran)).toEqual(['ocr.recognize'])
    // page tools: Watermark offers Add / Update / Remove
    const panel = page.locator('.fc-edit-text-panel')
    await expect(panel.getByRole('button', { name: /Recognize text \(OCR\)/ })).toBeVisible()
    await panel.getByRole('button', { name: /^Watermark/ }).click()
    await expect(page.getByRole('menuitem', { name: 'Update…' })).toBeVisible()
    await shot(page, '19-scanned-page-tools')
    await page.getByRole('menuitem', { name: 'Update…' }).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__ran))
      .toEqual(['ocr.recognize', 'marks.watermark.update'])

    // with the Select tool, right-click text and choose "Edit Text"
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.locator('.ui-panel-header').getByRole('button', { name: 'Back to all tools' }).click()
    await expect.poll(() => toolId(page)).toBe('select')
    await page.locator('.viewer-page[data-page-index="0"] .viewer-text-layer').hover()
    await page.waitForTimeout(300)
    const c = await charPoint(page, 'Invoice')
    await page.mouse.click(c.x + 3, c.y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit Text' }).click()
    await expect(editor(page)).toBeFocused()
    await expect(editor(page)).toContainText('Invoice #1000')
    expect(await toolId(page)).toBe('edit.content')
    // Delete removes the whole box from the mini toolbar
    await page.locator('.fc-edit-text-mini').getByRole('button', { name: 'Delete text box' }).click()
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(() => pageText(page)).not.toContain('Invoice #1000')
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Delete Text')
    expect(await pageText(page)).toContain('Lorem ipsum')
    expect(await pageText(page)).toContain('Visit https://example.com')
  } finally {
    await app.close()
  }
})
