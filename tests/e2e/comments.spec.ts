import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/comments-${name}.png` })

/** Calls a core/feature engine op on the active document. */
async function op<T = any>(page: Page, ns: string, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ ns, name, args }) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      return d.ops(ns)[name](...args)
    },
    { ns, name, args }
  )
}

/** Screen position of a page-space point on a page (rotation 0). */
async function toScreen(page: Page, pt: [number, number], pageIndex = 0): Promise<[number, number]> {
  const box = (await page.locator(`.viewer-page[data-page-index="${pageIndex}"]`).boundingBox())!
  const width = await page.evaluate((i) => (window as any).__fartcrobat.getActiveDoc().state.info.pages[i].width, pageIndex)
  const s = box.width / width
  return [box.x + pt[0] * s, box.y + pt[1] * s]
}

async function scale(page: Page): Promise<number> {
  const box = (await page.locator('.viewer-page[data-page-index="0"]').boundingBox())!
  return box.width / 612
}

async function stubDialogs(app: ElectronApplication, save: string | null, open: string[] | null) {
  await app.evaluate(
    ({ ipcMain }, { save, open }) => {
      if (save !== null) {
        ipcMain.removeHandler('file:saveDialog')
        ipcMain.handle('file:saveDialog', () => save)
      }
      if (open !== null) {
        ipcMain.removeHandler('file:openDialog')
        ipcMain.handle('file:openDialog', () => open)
      }
    },
    { save, open }
  )
}

test('select, move, edit, reply, export and import comments', async () => {
  const { app, page } = await launch()
  const tmp = mkdtempSync(join(tmpdir(), 'fartcrobat-comments-'))
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.evaluate(() => (window as any).__fartcrobat.useApp.setState((s: any) => ({ prefs: { ...s.prefs, authorName: 'Alice Reviewer' } })))
    await page.waitForTimeout(200)

    // Comments made by the markup tools (created through the engine here).
    const ids = await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const annots = d.ops('annots')
      await annots.setAuthor('Alice Reviewer')
      const sq = await annots.create(0, { type: 'Square', rect: [100, 300, 220, 380], color: '#ff0000', borderWidth: 2, contents: 'Check this box' })
      const note = await annots.create(0, { type: 'Text', rect: [400, 120, 420, 140], contents: 'Please review this paragraph', color: '#ffeb3b', icon: 'Comment' })
      return { sq: sq.id as number, note: note.id as number }
    })
    await page.waitForTimeout(400)

    // ---- clicking inside the empty middle of an unfilled rectangle does not select it (the text
    // under it stays selectable); its border does
    const s = await scale(page)
    const [mx, my] = await toScreen(page, [160, 340])
    await page.mouse.click(mx, my)
    expect((await activeDocState(page))?.selection.kind).toBe('none')

    // ---- click the square's border: it gets selected with a bounding box and handles
    const [bx, by] = await toScreen(page, [100, 340])
    await page.mouse.move(bx, by)
    await page.waitForTimeout(100)
    await expect(page.locator('.fc-comments-hover')).toBeVisible()
    await page.mouse.click(bx, by)
    await expect(page.locator('.fc-comments-selbox')).toHaveCount(1)
    await expect(page.locator('.fc-comments-handle')).toHaveCount(8)
    let st = await activeDocState(page)
    expect(st?.selection).toEqual({ kind: 'annotations', page: 0, ids: [ids.sq] })
    await expect(page.locator('.fc-comments-inspector')).toBeVisible()
    await shot(page, 'selected')

    // ---- drag it 50px to the right and 30px down
    const before = await op(page, 'annots', 'get', ids.sq)
    await page.mouse.move(bx, by)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(bx + i * 5, by + i * 3)
    await page.waitForTimeout(150)
    await expect(page.locator('.fc-comments-preview')).toHaveCount(1)
    await shot(page, 'dragging')
    await page.mouse.up()
    await expect
      .poll(async () => (await op(page, 'annots', 'get', ids.sq)).rect[0])
      .toBeCloseTo(before.rect[0] + 50 / s, 0)
    const moved = await op(page, 'annots', 'get', ids.sq)
    expect(moved.rect[1]).toBeCloseTo(before.rect[1] + 30 / s, 0)
    st = await activeDocState(page)
    expect(st?.journal.undoLabel).toBe('Move Annotation')
    expect(st?.dirty).toBe(true)

    // ---- undo restores the position
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await op(page, 'annots', 'get', ids.sq)).rect[0]).toBeCloseTo(before.rect[0], 1)

    // ---- arrow keys nudge (1 pt, Shift = 10 pt)
    await page.mouse.click(bx, by)
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await op(page, 'annots', 'get', ids.sq)).rect[0]).toBeCloseTo(before.rect[0] + 1, 1)
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(async () => (await op(page, 'annots', 'get', ids.sq)).rect[1]).toBeCloseTo(before.rect[1] + 10, 1)

    // ---- resize with the bottom-right handle
    const handle = page.locator('.fc-comments-handle').nth(4)
    const hb = (await handle.boundingBox())!
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 5; i++) await page.mouse.move(hb.x + hb.width / 2 + i * 8, hb.y + hb.height / 2 + i * 4)
    await page.mouse.up()
    await expect.poll(async () => {
      const r = (await op(page, 'annots', 'get', ids.sq)).rect
      return r[2] - r[0]
    }).toBeCloseTo(120 + 40 / s, 0)

    // ---- change its colour in the floating properties bar
    await page.locator('.fc-comments-inspector button[title="Colour"]').click()
    await page.locator('.ui-popover button[title="#2196F3"]').click()
    await expect.poll(async () => (await op(page, 'annots', 'get', ids.sq)).color).toBe('#2196f3')
    // and its line style
    await page.locator('.fc-comments-inspector select[aria-label="Line style"]').selectOption('dashed')
    await expect.poll(async () => (await op(page, 'annots', 'get', ids.sq)).borderStyle).toBe('Dashed')
    await page.waitForTimeout(300)
    await shot(page, 'inspector')

    // ---- Delete removes it
    await page.locator('.viewer-scroll').focus()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await op<any[]>(page, 'annots', 'list', 0)).some((a) => a.id === ids.sq)).toBe(false)
    await expect(page.locator('.fc-comments-selbox')).toHaveCount(0)

    // ---- double-click the sticky note: its pop-up note opens; edit the text there
    const [nx, ny] = await toScreen(page, [410, 130])
    await page.mouse.dblclick(nx, ny)
    const popup = page.locator('.fc-comments-popup')
    await expect(popup).toBeVisible()
    await expect(popup.locator('textarea[aria-label="Comment text"]')).toHaveValue('Please review this paragraph')
    await popup.locator('textarea[aria-label="Comment text"]').fill('Please review this paragraph again')
    await popup.locator('textarea[aria-label="Reply"]').click()
    await expect.poll(async () => (await op(page, 'annots', 'get', ids.note)).contents).toBe('Please review this paragraph again')
    await shot(page, 'popup')
    await popup.locator('button[aria-label="Close pop-up note"]').click()
    await expect(popup).toHaveCount(0)

    // ---- hover shows a pop-up preview with author and text
    await page.mouse.move(nx + 40, ny + 40)
    await page.mouse.move(nx, ny)
    await expect(page.locator('.fc-comments-tip')).toBeVisible()
    await expect(page.locator('.fc-comments-tip')).toContainText('Alice Reviewer')
    await shot(page, 'hover')
    await page.mouse.move(nx + 80, ny + 80)

    // ---- Comments panel: the note is listed; reply and set status there
    await page.locator('button[aria-label="Comments"]').click()
    const card = page.locator(`.fc-comments-card[data-comment-id="${ids.note}"]`)
    await expect(card).toBeVisible()
    await expect(card).toContainText('Please review this paragraph again')
    await card.click()
    st = await activeDocState(page)
    expect(st?.selection).toEqual({ kind: 'annotations', page: 0, ids: [ids.note] })
    await card.locator('textarea[aria-label="Reply"]').fill('Done, looks good now.')
    await card.locator('textarea[aria-label="Reply"]').press('Enter')
    await expect(card.locator('.fc-comments-reply')).toHaveCount(1)
    await expect(card.locator('.fc-comments-reply')).toContainText('Alice Reviewer')
    await card.locator('button[aria-label="Comment options"]').click()
    await page.locator('.ui-menu button:has-text("Set Status")').click()
    await page.locator('.ui-submenu button:has-text("Accepted")').click()
    await expect(card.locator('.fc-comments-status')).toHaveText('Accepted')
    await card.locator('button[aria-label="Mark with checkmark"]').click()
    await expect(card.locator('button[aria-label="Remove checkmark"]')).toBeVisible()
    const all = await op<any[]>(page, 'annots', 'listAll')
    expect(all.find((a) => a.contents === 'Done, looks good now.')?.inReplyTo).toBe(ids.note)
    expect(all.some((a) => a.state === 'Accepted' && a.inReplyTo === ids.note)).toBe(true)

    // search and filter
    await page.locator('input[aria-label="Search comments"]').fill('nothing like this')
    await expect(page.locator('.fc-comments-card')).toHaveCount(0)
    await page.locator('input[aria-label="Search comments"]').fill('looks good')
    await expect(page.locator('.fc-comments-card')).toHaveCount(1)
    await page.locator('input[aria-label="Search comments"]').fill('')
    await page.waitForTimeout(300)
    await shot(page, 'panel')

    // ---- export as XFDF (save dialog stubbed) ...
    const xfdf = join(tmp, 'review.xfdf')
    await stubDialogs(app, xfdf, null)
    await runCommand(page, 'comments.export')
    await expect.poll(() => existsSync(xfdf)).toBe(true)
    const xml = readFileSync(xfdf, 'utf8')
    expect(xml).toContain('<xfdf xmlns="http://ns.adobe.com/xfdf/"')
    expect(xml).toContain('Please review this paragraph again')
    expect(xml).toContain('state="Accepted"')

    // ... and import it into a fresh copy of the document
    const copy = join(tmp, 'fresh.pdf')
    copyFileSync(fixturePath('text.pdf'), copy)
    await openFile(page, copy)
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('fresh.pdf')
    await waitForRender(page)
    expect((await op<any[]>(page, 'annots', 'listAll')).length).toBe(0)
    await stubDialogs(app, null, [xfdf])
    await runCommand(page, 'comments.import')
    await expect.poll(async () => (await op<any[]>(page, 'annots', 'listAll')).length).toBe(4)
    const imported = await op<any[]>(page, 'annots', 'listAll')
    const inote = imported.find((a) => a.type === 'Text' && a.inReplyTo === null)
    expect(inote.contents).toBe('Please review this paragraph again')
    expect(inote.author).toBe('Alice Reviewer')
    expect(imported.find((a) => a.contents === 'Done, looks good now.')?.inReplyTo).toBe(inote.id)
    await expect(page.locator(`.fc-comments-card[data-comment-id="${inote.id}"] .fc-comments-status`)).toHaveText('Accepted')
    st = await activeDocState(page)
    expect(st?.journal.undoLabel).toBe('Import Comments')
    await page.waitForTimeout(400)
    await shot(page, 'imported')
  } finally {
    await app.close()
  }
})

test('text boxes, lines, summaries, zoom and dark mode', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    const ids = await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const annots = d.ops('annots')
      await annots.setAuthor('Bob')
      const ft = await annots.create(0, { type: 'FreeText', rect: [300, 500, 480, 530], contents: '', fontSize: 14, textColor: '#0000ff' })
      const line = await annots.create(0, { type: 'Line', line: [[80, 600], [260, 660]], color: '#e91e63', borderWidth: 3, lineEndings: { start: 'None', end: 'ClosedArrow' } })
      const ink = await annots.create(0, { type: 'Ink', ink: [[[350, 300], [380, 340], [420, 310], [460, 350]]], color: '#4caf50', borderWidth: 3 })
      return { ft: ft.id as number, line: line.id as number, ink: ink.id as number }
    })

    // a tool asks for the inline editor of a new text box (like markup-tools does)
    await page.evaluate(
      ({ id }) => {
        const d = (window as any).__fartcrobat.getActiveDoc()
        window.dispatchEvent(new CustomEvent('fartcrobat:edit-annotation', { detail: { docId: d.id, id, page: 0 } }))
      },
      { id: ids.ft }
    )
    const editor = page.locator('.fc-comments-inline-editor')
    await expect(editor).toBeVisible()
    await expect(editor).toBeFocused()
    await page.keyboard.type('Typed straight onto the page')
    await page.waitForTimeout(150)
    await shot(page, 'inline-editor')
    await page.keyboard.press('Control+Enter')
    await expect(editor).toHaveCount(0)
    await expect.poll(async () => (await op(page, 'annots', 'get', ids.ft)).contents).toBe('Typed straight onto the page')

    // ink strokes are hit-tested along the stroke, not the whole box
    const [ex, ey] = await toScreen(page, [440, 305])
    await page.mouse.click(ex, ey)
    await expect.poll(async () => (await activeDocState(page))?.selection.kind).toBe('none')
    const [ix, iy] = await toScreen(page, [380, 340])
    await page.mouse.click(ix, iy)
    await expect.poll(async () => (await activeDocState(page))?.selection).toEqual({ kind: 'annotations', page: 0, ids: [ids.ink] })

    // line endpoints: drag the arrow head with Shift to snap to 45°
    const [lx, ly] = await toScreen(page, [170, 630])
    await page.mouse.click(lx, ly)
    await expect(page.locator('.fc-comments-handle.is-round')).toHaveCount(2)
    const end = page.locator('.fc-comments-handle.is-round').nth(1)
    const eb = (await end.boundingBox())!
    await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2)
    await page.mouse.down()
    await page.keyboard.down('Shift')
    for (let i = 1; i <= 6; i++) await page.mouse.move(eb.x + eb.width / 2 + i * 10, eb.y + eb.height / 2 + i * 12)
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await expect
      .poll(async () => {
        const l = (await op(page, 'annots', 'get', ids.line)).line
        const ang = (Math.atan2(l[1][1] - l[0][1], l[1][0] - l[0][0]) * 180) / Math.PI
        return Math.round(ang)
      })
      .toBe(45)

    // right-click menu on a comment
    const [lx2, ly2] = await toScreen(page, [80 + 40, 600 + 40])
    await page.mouse.click(lx2, ly2, { button: 'right' })
    await expect(page.locator('.ui-menu')).toContainText('Open Pop-up Note')
    await expect(page.locator('.ui-menu')).toContainText('Bring to Front')
    await shot(page, 'context-menu')
    await page.keyboard.press('Escape')

    // zoomed in: the selection box still sits on the comment
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(2))
    await page.waitForTimeout(500)
    await page.evaluate(({ id }) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      d.setSelection({ kind: 'annotations', page: 0, ids: [id] })
      d.view.scrollToRect(0, [300, 500, 480, 530], { center: true })
    }, { id: ids.ft })
    await page.waitForTimeout(500)
    const sel = (await page.locator('.fc-comments-selbox').boundingBox())!
    const [fx, fy] = await toScreen(page, [300, 500])
    expect(Math.abs(sel.x + 3 - fx)).toBeLessThan(4)
    expect(Math.abs(sel.y + 3 - fy)).toBeLessThan(4)
    await shot(page, 'zoomed')
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom('fit-width'))
    await page.waitForTimeout(300)

    // Properties dialog
    await page.evaluate(({ id }) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      d.setSelection({ kind: 'annotations', page: 0, ids: [id] })
    }, { id: ids.line })
    await runCommand(page, 'comments.properties')
    const dlg = page.locator('.fc-comments-props')
    await expect(dlg).toBeVisible()
    await shot(page, 'properties')
    await dlg.locator('select').nth(1).selectOption('6')
    await dlg.locator('button:has-text("General")').click()
    await dlg.locator('input').first().fill('Bob Builder')
    await dlg.locator('button:has-text("OK")').click()
    await expect.poll(async () => (await op(page, 'annots', 'get', ids.line)).author).toBe('Bob Builder')

    // Summarize Comments opens a new PDF
    await runCommand(page, 'comments.summarize')
    await expect(page.locator('.fc-comments-summarize')).toBeVisible()
    await shot(page, 'summarize-dialog')
    await page.locator('.fc-comments-summarize button:has-text("Create PDF Comment Summary")').click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('text - Comment Summary.pdf')
    await waitForRender(page)
    await page.waitForTimeout(500)
    await shot(page, 'summary')
    const text = await page.evaluate(async () => (window as any).__fartcrobat.getActiveDoc().core.text.all())
    expect(text.join('\n')).toContain('Typed straight onto the page')

    // Show/Hide comments
    await page.locator('.shell-tab, [role="tab"]').first().click().catch(() => {})
    await page.evaluate(() => {
      const s = (window as any).__fartcrobat.useApp.getState()
      const d = s.docs.find((x: any) => x.state.title === 'text.pdf')
      ;(window as any).__fartcrobat.useApp.setState({ activeDocId: d.id })
    })
    await waitForRender(page)
    await runCommand(page, 'comments.toggleVisibility')
    expect(await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.showAnnotations)).toBe(false)
    await expect(page.locator('.fc-comments-hits')).toHaveCount(0)
    await runCommand(page, 'comments.toggleVisibility')

    // dark mode: panel and pop-up
    await page.evaluate(() => (window as any).__fartcrobat.useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } })))
    await page.locator('button[aria-label="Comments"]').click()
    const [ftx, fty] = await toScreen(page, [390, 515])
    await page.mouse.click(ftx, fty)
    await runCommand(page, 'comments.openPopup')
    await expect(page.locator('.fc-comments-popup')).toBeVisible()
    await page.waitForTimeout(400)
    await shot(page, 'dark')

    // Delete All Comments asks first and can be undone
    await runCommand(page, 'comments.deleteAll')
    await page.locator('.ui-dialog button:has-text("Delete All")').click()
    await expect.poll(async () => (await op<any[]>(page, 'annots', 'listAll')).length).toBe(0)
    await expect(page.locator('.fc-comments-panel .ui-empty')).toBeVisible()
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await op<any[]>(page, 'annots', 'listAll')).length).toBe(3)
  } finally {
    await app.close()
  }
})
