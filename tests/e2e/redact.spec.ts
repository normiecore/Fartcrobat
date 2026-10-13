import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/redact-${name}.png` })

/** Starts a command without waiting for it (commands that open dialogs resolve when they close). */
async function startCommand(page: Page, id: string) {
  await page.evaluate((c) => {
    void (window as any).__fartcrobat.runCommand(c)
  }, id)
}

async function marks(page: Page): Promise<{ id: number; page: number; kind: string; rect: number[]; overlay: string }[]> {
  return page.evaluate(async () => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    const list = await d.ops('redact').list()
    return list.map((m: any) => ({ id: m.id, page: m.page, kind: m.kind, rect: m.rect, overlay: m.props.overlay === 'custom' ? m.props.customText : '' }))
  })
}

async function pageText(page: Page, index: number): Promise<string> {
  return page.evaluate(async (i) => (await (window as any).__fartcrobat.getActiveDoc().pageText(i)).text, index)
}

/** Client coordinates of a page-space point on a page. */
async function clientPoint(page: Page, pageIndex: number, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ pageIndex, x, y }) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const el = document.querySelector(`.viewer-page[data-page-index="${pageIndex}"]`)!
      const b = el.getBoundingClientRect()
      const pg = d.state.info.pages[pageIndex]
      const scale = (b.width / pg.width) as number
      return { x: b.left + x * scale, y: b.top + y * scale }
    },
    { pageIndex, x, y }
  )
}

/** Page-space rectangle of a piece of text on a page. */
async function textRect(page: Page, pageIndex: number, needle: string): Promise<number[]> {
  return page.evaluate(
    async ({ pageIndex, needle }) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const t = await d.pageText(pageIndex)
      const i = t.text.indexOf(needle)
      if (i < 0) throw new Error('text not found: ' + needle)
      let r = [Infinity, Infinity, -Infinity, -Infinity]
      for (let k = i; k < i + needle.length; k++) {
        const q = t.quads.slice(k * 8, k * 8 + 8)
        const xs = [q[0], q[2], q[4], q[6]]
        const ys = [q[1], q[3], q[5], q[7]]
        r = [Math.min(r[0], ...xs), Math.min(r[1], ...ys), Math.max(r[2], ...xs), Math.max(r[3], ...ys)]
      }
      return r
    },
    { pageIndex, needle }
  )
}

function streamsOf(bytes: Buffer): string[] {
  const s = bytes.toString('latin1')
  const out = [s]
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length
    const end = s.indexOf('endstream', start)
    if (end < 0) break
    const raw = Buffer.from(s.slice(start, end), 'latin1')
    try {
      out.push(inflateSync(raw).toString('latin1'))
    } catch {}
  }
  return out
}

test('redact: find & redact emails, mark text and areas, properties, apply, remove hidden information, save', async () => {
  const { app, page } = await launch()
  const outDir = mkdtempSync(join(tmpdir(), 'fartcrobat-redact-'))
  // work on a copy: saving writes back to the opened file
  const source = join(outDir, 'text.pdf')
  copyFileSync(fixturePath('text.pdf'), source)
  const target = join(outDir, 'text_Redacted.pdf')
  try {
    await app.evaluate(({ ipcMain }, path) => {
      ipcMain.removeHandler('file:saveDialog')
      ipcMain.handle('file:saveDialog', () => path)
    }, target)
    await openFile(page, source)
    await waitForRender(page)

    // Open "Redact a PDF" from All tools
    await page.locator('.shell-alltools-item', { hasText: 'Redact a PDF' }).click()
    await expect(page.locator('.ui-panel-header h3', { hasText: 'Redact a PDF' })).toBeVisible()
    await expect(page.locator('.fc-redact-toolbar')).toBeVisible()
    await shot(page, 'panel')

    // ---- Find text & redact: Patterns > Email addresses
    await page.getByRole('button', { name: /Find text & redact/ }).click()
    await page.getByRole('radio', { name: 'Patterns' }).check()
    await page.getByLabel('Pattern', { exact: true }).selectOption({ label: 'Email addresses' })
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    await expect(page.locator('.fc-redact-results-summary')).toHaveText('5 results on 5 pages')
    await expect(page.locator('.fc-redact-result')).toHaveCount(5)
    await expect(page.locator('.fc-redact-find-hit.is-checked').first()).toBeVisible()
    // uncheck one, then "Check all" again
    await page.locator('.fc-redact-result input').nth(1).uncheck()
    await expect(page.getByRole('button', { name: 'Mark 4 for redaction' })).toBeVisible()
    await page.getByRole('checkbox', { name: 'Check all' }).check()
    await shot(page, 'find-results')
    await page.getByRole('button', { name: 'Mark all for redaction' }).click()
    await expect.poll(async () => (await marks(page)).length).toBe(5)
    await expect(page.locator('.fc-redact-mark-row')).toHaveCount(5)
    await expect(page.locator('.fc-redact-mark-row').first()).toContainText('billing0@example.com')
    await expect(page.locator('.fc-redact-bar')).toContainText('5 redaction marks on all 5 pages')
    await shot(page, 'message-bar')

    // ---- Redact text & images tool: drag across text on page 1
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.goToPage(0))
    await page.waitForTimeout(300)
    const fox = await textRect(page, 0, 'quick brown fox')
    const a = await clientPoint(page, 0, fox[0] + 1, (fox[1] + fox[3]) / 2)
    const b = await clientPoint(page, 0, fox[2] - 1, (fox[1] + fox[3]) / 2)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move((a.x + b.x) / 2, a.y, { steps: 4 })
    await page.mouse.move(b.x, b.y, { steps: 4 })
    await expect(page.locator('.fc-redact-drag-text').first()).toBeVisible()
    await shot(page, 'drag-text')
    await page.mouse.up()
    await expect.poll(async () => (await marks(page)).length).toBe(6)
    await expect(page.locator('.fc-redact-mark-row', { hasText: 'quick brown fox' })).toBeVisible()

    // draw an area over the blue box (an image-like graphic): y = 792-460..792-380 in page space
    const p1 = await clientPoint(page, 0, 66, 326)
    const p2 = await clientPoint(page, 0, 280, 418)
    await page.mouse.move(p1.x, p1.y)
    await page.mouse.down()
    await page.mouse.move(p2.x, p2.y, { steps: 6 })
    await expect(page.locator('.fc-redact-drag-area')).toBeVisible()
    await page.mouse.up()
    await expect.poll(async () => (await marks(page)).filter((m) => m.kind === 'area').length).toBe(1)

    // double-click a word marks it
    const ch = await textRect(page, 0, 'Chapter')
    const w = await clientPoint(page, 0, (ch[0] + ch[2]) / 2, (ch[1] + ch[3]) / 2)
    await page.mouse.dblclick(w.x, w.y)
    await expect.poll(async () => (await marks(page)).length).toBe(8)
    await expect(page.locator('.fc-redact-mark-row', { hasText: 'Chapter' })).toBeVisible()

    // hovering a mark shows how it will look
    await page.mouse.move(p1.x + 20, p1.y + 20)
    await expect(page.locator('.fc-redact-hover').first()).toBeVisible()
    await shot(page, 'marks-hover')

    // click a mark to select it, Delete removes it, Undo restores it
    await page.mouse.click(w.x, w.y)
    await expect(page.locator('.fc-redact-selected')).toBeVisible()
    await expect(page.locator('.fc-redact-mark-row.is-selected')).toContainText('Chapter')
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await marks(page)).length).toBe(7)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await marks(page)).length).toBe(8)

    // right-click a mark: Apply / Properties / Delete
    await page.mouse.click(w.x, w.y, { button: 'right' })
    const menu = page.locator('.ui-menu')
    await expect(menu).toContainText('Apply Redaction…')
    await expect(menu).toContainText('Properties…')
    await shot(page, 'context-menu')
    await menu.locator('.ui-menu-item', { hasText: 'Delete Mark' }).click()
    await expect.poll(async () => (await marks(page)).length).toBe(7)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await marks(page)).length).toBe(8)

    // with the Select tool, selected text offers "Mark for redaction"
    await page.getByRole('button', { name: 'Select', exact: true }).click()
    const lazy = await textRect(page, 0, 'lazy dog')
    const l1 = await clientPoint(page, 0, lazy[0] + 1, (lazy[1] + lazy[3]) / 2)
    const l2 = await clientPoint(page, 0, lazy[2] - 1, (lazy[1] + lazy[3]) / 2)
    await page.mouse.move(l1.x, l1.y)
    await page.mouse.down()
    await page.mouse.move(l2.x, l2.y, { steps: 6 })
    await page.mouse.up()
    await page.locator('.viewer-selection-toolbar button[title="Mark for redaction"]').click()
    await expect.poll(async () => (await marks(page)).length).toBe(9)
    await expect(page.locator('.fc-redact-mark-row', { hasText: 'lazy dog' })).toBeVisible()
    // marks are annotations: with the Select tool a click selects one (comments), a right-click
    // offers the redaction menu
    // (the tool's contextual bar is gone, so the page moved up: measure again)
    const ch2 = await textRect(page, 0, 'Chapter')
    const w2 = await clientPoint(page, 0, (ch2[0] + ch2[2]) / 2, (ch2[1] + ch2[3]) / 2)
    await page.mouse.click(w2.x, w2.y)
    await expect(page.locator('.fc-redact-mark-row.is-selected')).toContainText('Chapter')
    await page.mouse.click(w2.x, w2.y, { button: 'right' })
    await expect(page.locator('.ui-menu')).toContainText('Apply Redaction…')
    await expect(page.locator('.ui-menu')).toContainText('Delete Mark')
    await shot(page, 'select-tool-menu')
    await page.keyboard.press('Escape')
    await expect(page.locator('.ui-menu')).toHaveCount(0)
    expect((await marks(page)).length).toBe(9)
    // keyboard: focus the row in the panel and press Delete
    await page.locator('.fc-redact-mark-row', { hasText: 'lazy dog' }).focus()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await marks(page)).length).toBe(8)
    await page.getByRole('button', { name: /Redact text & images/ }).click()
    await expect(page.locator('.fc-redact-toolbar')).toBeVisible()

    // ---- Mark page range: page 3
    await page.getByRole('button', { name: /Mark page range/ }).first().click()
    await page.getByLabel('Page range').fill('3')
    await page.waitForTimeout(300) // let the dialog finish fading in
    await shot(page, 'page-range')
    await page.getByRole('button', { name: 'Mark 1 page' }).click()
    await expect.poll(async () => (await marks(page)).filter((m) => m.kind === 'page').length).toBe(1)

    // ---- Properties: overlay text for all marks
    await page.getByRole('button', { name: /^Properties/ }).first().click()
    await expect(page.getByRole('dialog', { name: undefined }).locator('h2', { hasText: 'Redaction properties' })).toBeVisible()
    await page.getByRole('radio', { name: 'Custom text' }).check()
    await page.getByLabel('Custom overlay text').fill('REDACTED')
    await expect(page.locator('.fc-redact-preview')).toContainText('REDACTED')
    await shot(page, 'properties')
    await page.getByRole('button', { name: 'OK', exact: true }).click()
    await expect.poll(async () => (await marks(page)).every((m) => m.overlay === 'REDACTED')).toBe(true)

    // zoomed in, marks and previews still line up with the text
    await runCommand(page, 'view.zoomIn')
    await runCommand(page, 'view.zoomIn')
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.goToPage(0))
    await page.waitForTimeout(600)
    const fox2 = await textRect(page, 0, 'quick brown fox')
    const h = await clientPoint(page, 0, (fox2[0] + fox2[2]) / 2, (fox2[1] + fox2[3]) / 2)
    await page.mouse.move(h.x, h.y)
    const hover = page.locator('.fc-redact-hover').first()
    await expect(hover).toContainText('REDACTED')
    // the preview covers the text it will replace (within a pixel or two)
    const box = (await hover.boundingBox())!
    const tl = await clientPoint(page, 0, fox2[0], fox2[1])
    const br = await clientPoint(page, 0, fox2[2], fox2[3])
    expect(Math.abs(box.x - tl.x)).toBeLessThan(3)
    expect(Math.abs(box.x + box.width - br.x)).toBeLessThan(3)
    expect(box.y).toBeLessThanOrEqual(tl.y + 2)
    expect(box.y + box.height).toBeGreaterThanOrEqual(br.y - 2)
    await shot(page, 'zoomed')
    await runCommand(page, 'view.fitWidth')

    // ---- Apply from the message bar
    const before = await marks(page)
    expect(before.length).toBe(9)
    await page.locator('.fc-redact-bar').getByRole('button', { name: 'Apply' }).click()
    const dialog = page.locator('.ui-dialog', { hasText: 'Apply redactions' })
    await expect(dialog).toContainText('cannot be undone after you save')
    await expect(dialog.getByRole('checkbox', { name: 'Also remove hidden information' })).toBeChecked()
    await shot(page, 'apply-confirm')
    await dialog.getByRole('button', { name: 'Apply' }).click()

    // Remove hidden information is offered next
    const sanitize = page.locator('.ui-dialog', { hasText: 'Remove hidden information' })
    await expect(sanitize.locator('.fc-redact-hidden-item').first()).toBeVisible()
    await expect(sanitize.locator('.fc-redact-hidden-item', { hasText: 'Metadata' })).toContainText(/\d+ items?/)
    await expect(sanitize.locator('.fc-redact-hidden-item', { hasText: 'Bookmarks' })).toContainText('5 bookmarks')
    await shot(page, 'sanitize')
    await sanitize.getByRole('button', { name: 'Remove' }).click()
    await expect(sanitize).toContainText('Hidden information was removed.')
    await shot(page, 'sanitize-done')
    const t0 = await pageText(page, 0)
    expect(t0).not.toContain('billing0')
    expect(t0).not.toContain('quick brown fox')
    expect(t0).toContain('REDACTED')
    expect(t0).toContain('Phone: (555) 010-0000')
    expect((await pageText(page, 2)).replace(/\s/g, '')).toBe('REDACTED')

    // ---- Save As… (suggests name_Redacted.pdf); the tab then shows the saved file
    await sanitize.getByRole('button', { name: 'Save As…' }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('text_Redacted.pdf')
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)
    await expect.poll(async () => (await activeDocState(page))?.journal.canUndo).toBe(false)
    await expect.poll(async () => (await marks(page)).length).toBe(0)
    await expect(page.locator('.fc-redact-bar')).toHaveCount(0)
    const all = streamsOf(readFileSync(target))
    for (const secret of ['billing0@example.com', 'billing3@example.com', 'page 1. The quick brown fox', 'Fixture Text Document', 'Fartcrobat Tests', '/URI', '/Outlines']) {
      expect([secret, all.some((x) => x.includes(secret))]).toEqual([secret, false])
    }
    expect(all.some((x) => x.includes('(555) 010-0000') || x.includes('\\(555\\) 010-0000'))).toBe(true)
    expect((await pageText(page, 0))).toContain('REDACTED')

    // ---- search for 'billing' finds nothing
    await runCommand(page, 'edit.find')
    await page.getByLabel('Find in document').fill('billing')
    await expect(page.locator('.shell-findbar-count')).toHaveText('No results')
    await shot(page, 'applied')
    await page.keyboard.press('Escape')

    // ---- dark theme
    await page.evaluate(() => {
      const { useApp } = (window as any).__fartcrobat
      useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } }))
    })
    await page.getByRole('button', { name: /Find text & redact/ }).click()
    await page.getByRole('radio', { name: 'Patterns' }).check()
    await page.getByLabel('Pattern', { exact: true }).selectOption({ label: 'Phone numbers' })
    await page.getByRole('button', { name: 'Search', exact: true }).click()
    // page 3 was redacted whole
    await expect(page.locator('.fc-redact-results-summary')).toHaveText('4 results on 4 pages')
    await shot(page, 'dark-find')
    await page.getByRole('button', { name: 'Mark all for redaction' }).click()
    await expect(page.locator('.fc-redact-bar')).toContainText('4 redaction marks')
    await page.mouse.move(10, 10)
    await shot(page, 'dark-marks')
    await page.getByRole('button', { name: /^Properties/ }).first().click()
    await page.getByRole('radio', { name: 'Redaction code' }).check()
    await shot(page, 'dark-properties')
    await page.getByRole('button', { name: 'Cancel' }).click()

    // Preferences > Redaction holds the defaults for new marks
    await startCommand(page, 'app.preferences')
    await page.locator('.prefs-nav button', { hasText: 'Redaction' }).click()
    await expect(page.locator('.fc-redact-settings')).toBeVisible()
    await shot(page, 'dark-settings')
    await page.getByRole('button', { name: 'Done' }).click()
  } finally {
    await app.close()
  }
})

test('redact: remove hidden information on its own, from the Tools menu command', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('redact/hidden-info.pdf'))
    await waitForRender(page)
    await startCommand(page, 'redact.sanitize')
    const dlg = page.locator('.ui-dialog', { hasText: 'Remove hidden information' })
    await expect(dlg.locator('.fc-redact-hidden-item', { hasText: 'File attachments' })).toContainText('2 files')
    await expect(dlg.locator('.fc-redact-hidden-item', { hasText: 'Hidden layers' })).toContainText('1 layer')
    await expect(dlg.locator('.fc-redact-hidden-item', { hasText: 'Overlapping objects' })).toContainText('characters')
    // hidden text is optional and off by default
    const hiddenText = dlg.locator('.fc-redact-hidden-item', { hasText: 'Hidden text' }).locator('input[type=checkbox]')
    await expect(hiddenText).not.toBeChecked()
    await hiddenText.check()
    await dlg.getByRole('radio', { name: /Remove the fields/ }).check()
    await shot(page, 'sanitize-standalone')
    await dlg.getByRole('button', { name: 'Remove' }).click()
    await expect(dlg).toContainText('Hidden information was removed.')
    await dlg.locator('.ui-dialog-footer').getByRole('button', { name: 'Close' }).click()
    const t = await pageText(page, 0)
    expect(t).not.toContain('INVISIBLE')
    expect(t).not.toContain('COVERED')
    expect(t).toContain('Visible paragraph text stays.')
    await page.waitForTimeout(300)
    await shot(page, 'sanitize-result')
    // undo brings everything back
    await runCommand(page, 'edit.undo')
    await expect.poll(async () => (await pageText(page, 0)).includes('INVISIBLE')).toBe(true)

    // content left outside the crop box of a cropped page
    await openFile(page, fixturePath('redact/cropped.pdf'))
    await waitForRender(page)
    await startCommand(page, 'redact.sanitize')
    const crop = page.locator('.ui-dialog', { hasText: 'Remove hidden information' })
    const cropped = crop.locator('.fc-redact-hidden-item', { hasText: 'Cropped content' })
    await expect(cropped).toContainText('1 page')
    await expect(cropped.locator('input[type=checkbox]')).toBeChecked()
    await crop.locator('.fc-redact-hidden-list').evaluate((el) => (el.scrollTop = el.scrollHeight))
    await shot(page, 'sanitize-cropped')
    await crop.getByRole('button', { name: 'Remove' }).click()
    await expect(crop).toContainText('Hidden information was removed.')
    await expect(crop.locator('.fc-redact-done-list')).toContainText('Cropped content')
    await crop.locator('.ui-dialog-footer').getByRole('button', { name: 'Close' }).click()
    await expect
      .poll(async () => page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.info.pages[0].mediaBox))
      .toEqual([100, 100, 512, 692])
    expect(await pageText(page, 0)).toContain('Visible text inside')
  } finally {
    await app.close()
  }
})
