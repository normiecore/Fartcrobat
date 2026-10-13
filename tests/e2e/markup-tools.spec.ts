import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

/** Waits until a text editor (pop-up note, inline editor or dialog field) has keyboard focus. */
async function waitForEditor(page: import('@playwright/test').Page) {
  await page.waitForFunction(() => {
    const a = document.activeElement as HTMLElement | null
    return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable)
  })
}


type Pt = { x: number; y: number }

interface Annot {
  id: number
  type: string
  rect: number[]
  quads: number[][]
  ink: number[][][]
  line: number[][] | null
  lineEndings: { start: string; end: string } | null
  contents: string
  color: string | null
  author: string
}

async function annots(page: Page, pageIndex = 0): Promise<Annot[]> {
  return page.evaluate(async (i) => (window as any).__fartcrobat.getActiveDoc().ops('annots').list(i), pageIndex)
}

async function ofType(page: Page, type: string, pageIndex = 0) {
  return (await annots(page, pageIndex)).filter((a) => a.type === type)
}

/** Page-space point -> screen point (handles zoom and view rotation, like PageGeometry). */
async function toScreen(page: Page, pageIndex: number, x: number, y: number): Promise<Pt> {
  return page.evaluate(
    ({ pageIndex, x, y }) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const el = document.querySelector(`.viewer-page[data-page-index="${pageIndex}"]`)!
      const r = el.getBoundingClientRect()
      const s = (d.state.zoom * 96) / 72
      const { width: w, height: h } = d.state.info.pages[pageIndex]
      const rot = d.state.viewRotation
      const [cx, cy] =
        rot === 90 ? [s * (h - y), s * x] : rot === 180 ? [s * (w - x), s * (h - y)] : rot === 270 ? [s * y, s * (w - x)] : [s * x, s * y]
      return { x: r.left + cx, y: r.top + cy }
    },
    { pageIndex, x, y }
  )
}

/** Quads of the first and last character of `needle` on a page. */
async function textQuads(page: Page, pageIndex: number, needle: string) {
  return page.evaluate(
    async ({ pageIndex, needle }) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const t = await d.pageText(pageIndex)
      const i = t.text.indexOf(needle)
      const q = (k: number) => Array.from(t.quads.slice(k * 8, k * 8 + 8)) as number[]
      return { first: q(i), last: q(i + needle.length - 1) }
    },
    { pageIndex, needle }
  )
}

async function drag(page: Page, a: Pt, b: Pt, opts: { steps?: number; shift?: boolean } = {}) {
  await page.mouse.move(a.x, a.y)
  if (opts.shift) await page.keyboard.down('Shift')
  await page.mouse.down()
  await page.mouse.move(b.x, b.y, { steps: opts.steps ?? 12 })
  await page.mouse.up()
  if (opts.shift) await page.keyboard.up('Shift')
}

async function toolId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)
}

async function undoRedo(page: Page, type: string, count: number) {
  await runCommand(page, 'edit.undo')
  await expect.poll(async () => (await ofType(page, type)).length).toBe(count - 1)
  await runCommand(page, 'edit.redo')
  await expect.poll(async () => (await ofType(page, type)).length).toBe(count)
}

/**
 * Records 'fartcrobat:edit-annotation' events (sent so the comments feature opens its popup or inline
 * editor) and stops them, so an editor opened by the comments feature cannot take keyboard focus in
 * the middle of these tests.
 */
async function captureEditEvents(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    w.__editEvents = []
    window.addEventListener(
      'fartcrobat:edit-annotation',
      (e) => {
        w.__editEvents.push((e as CustomEvent).detail)
        e.stopImmediatePropagation()
      },
      true
    )
  })
}

async function editEvents(page: Page): Promise<{ docId: string; id: number; page: number }[]> {
  return page.evaluate(() => (window as any).__editEvents)
}

/**
 * Waits until the pages stop moving. The options bar takes room above the document while a comment
 * tool is active, so "Fit page" / "Fit width" zoom changes whenever a tool is picked or put away.
 */
async function settle(page: Page) {
  let last = ''
  for (let i = 0; i < 50; i++) {
    const now = await page.evaluate(() => {
      const r = document.querySelector('.viewer-page[data-page-index="0"]')?.getBoundingClientRect()
      return JSON.stringify([r?.left, r?.top, r?.width, r?.height, (window as any).__fartcrobat.getActiveDoc()?.state.zoom])
    })
    if (now === last) return
    last = now
    await page.waitForTimeout(100)
  }
}

/** Activates a tool and waits until the options bar is shown and the page layout has settled. */
async function activate(page: Page, id: string) {
  await runCommand(page, id)
  await expect(page.locator('.fc-markup-tools-toolbar')).toBeVisible()
  await settle(page)
}

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/markup-tools-${name}.png` })

test('comment tools: highlight, underline, shapes, pencil, note, eraser with undo/redo', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await captureEditEvents(page)
    await page.waitForTimeout(400)

    // ---- 1. Highlight from the quick toolbar: drag across "quick brown fox"
    await page.locator('.shell-quicktools button[aria-label="Highlight text"]').click()
    expect(await toolId(page)).toBe('comment.highlight')
    await expect(page.locator('.fc-markup-tools-toolbar')).toBeVisible()
    await settle(page)
    const fox = await textQuads(page, 0, 'quick brown fox')
    const midY = (fox.first[1] + fox.first[5]) / 2
    const a = await toScreen(page, 0, fox.first[0] + 1, midY)
    const b = await toScreen(page, 0, fox.last[2] - 0.5, midY)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move((a.x + b.x) / 2, b.y, { steps: 8 })
    await expect(page.locator('.viewer-page[data-page-index="0"] .fc-markup-tools-svg polygon').first()).toBeVisible()
    await shot(page, '01-highlight-dragging')
    await page.mouse.move(b.x, b.y, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await ofType(page, 'Highlight')).length).toBe(1)
    const hl = (await ofType(page, 'Highlight'))[0]
    expect(hl.quads).toHaveLength(1)
    const q = hl.quads[0]
    expect(Math.min(q[0], q[4])).toBeCloseTo(fox.first[0], 0)
    expect(Math.max(q[2], q[6])).toBeCloseTo(fox.last[2], 0)
    expect(hl.color?.toUpperCase()).toBe('#FFEB3B')
    // back to the Select tool with the new highlight selected
    expect(await toolId(page)).toBe('select')
    expect((await activeDocState(page))?.selection).toEqual({ kind: 'annotations', page: 0, ids: [hl.id] })
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Add Highlight')
    await page.waitForTimeout(400)
    await shot(page, '02-highlight')
    await undoRedo(page, 'Highlight', 1)

    // ---- 2. Select text, then "Underline" in the selection mini toolbar
    await settle(page)
    const lazy = await textQuads(page, 0, 'lazy dog')
    const ly = (lazy.first[1] + lazy.first[5]) / 2
    await page.locator('.viewer-scroll').click({ position: { x: 5, y: 5 } })
    await drag(page, await toScreen(page, 0, lazy.first[0] + 0.5, ly), await toScreen(page, 0, lazy.last[2] - 0.3, ly))
    await expect(page.locator('.viewer-selection-toolbar')).toBeVisible()
    await shot(page, '03-selection-toolbar')
    await page.locator('.viewer-selection-toolbar button[title="Underline"]').click()
    await expect.poll(async () => (await ofType(page, 'Underline')).length).toBe(1)
    const ul = (await ofType(page, 'Underline'))[0]
    expect(Math.min(ul.quads[0][0], ul.quads[0][4])).toBeCloseTo(lazy.first[0], 0)
    expect((await activeDocState(page))?.selection.kind).toBe('annotations')
    await page.waitForTimeout(300)
    await shot(page, '04-underline')
    await undoRedo(page, 'Underline', 1)

    // ---- 3. Rectangle with Shift (square) at 150% zoom, from the "Add comments" panel
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(1.5))
    await page.waitForTimeout(400)
    await page.locator('.shell-alltools-item', { hasText: 'Add comments' }).click()
    await expect(page.locator('.ui-panel-header h3', { hasText: 'Add comments' })).toBeVisible()
    await shot(page, '05-panel')
    await page.locator('.ui-tool-row', { hasText: 'Draw rectangle' }).click()
    expect(await toolId(page)).toBe('comment.rectangle')
    await settle(page)
    const r0 = await toScreen(page, 0, 120, 260)
    const r1 = { x: r0.x + 150, y: r0.y + 90 }
    await page.mouse.move(r0.x, r0.y)
    await page.keyboard.down('Shift')
    await page.mouse.down()
    await page.mouse.move(r1.x, r1.y, { steps: 10 })
    await expect(page.locator('.fc-markup-tools-svg rect')).toBeVisible()
    await shot(page, '06-rectangle-dragging')
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await expect.poll(async () => (await ofType(page, 'Square')).length).toBe(1)
    const sq = (await ofType(page, 'Square'))[0]
    // drawn at 150%: the square starts exactly where the mouse went down (120, 260)
    const side = 150 / ((1.5 * 96) / 72)
    expect(sq.rect[0]).toBeCloseTo(120, 0)
    expect(sq.rect[1]).toBeCloseTo(260, 0)
    expect(sq.rect[2] - sq.rect[0]).toBeCloseTo(side, 0)
    expect(sq.rect[3] - sq.rect[1]).toBeCloseTo(side, 0)
    await page.waitForTimeout(400)
    await shot(page, '07-rectangle')
    await undoRedo(page, 'Square', 1)

    // ---- 4. Arrow with Shift (snaps to 45°)
    await page.locator('.ui-tool-row', { hasText: 'Draw arrow' }).click()
    await expect(page.locator('.fc-markup-tools-toolbar')).toContainText('Draw arrow')
    await settle(page)
    const s0 = await toScreen(page, 0, 330, 260)
    await drag(page, s0, { x: s0.x + 160, y: s0.y + 120 }, { shift: true })
    await expect.poll(async () => (await ofType(page, 'Line')).length).toBe(1)
    const arrow = (await ofType(page, 'Line'))[0]
    const [p, p2] = arrow.line!
    expect(Math.abs(p2[0] - p[0])).toBeCloseTo(Math.abs(p2[1] - p[1]), 0)
    expect(arrow.lineEndings?.end).toBe('OpenArrow')
    await page.waitForTimeout(400)
    await shot(page, '08-arrow')
    await undoRedo(page, 'Line', 1)

    // back to fit width for the rest
    await runCommand(page, 'view.fitWidth')
    await page.waitForTimeout(400)

    // ---- 5. Pencil from the quick toolbar
    await page.locator('.shell-quicktools button[aria-label="Draw free form"]').click()
    await settle(page)
    const ink0 = await toScreen(page, 0, 100, 520)
    const ink1 = await toScreen(page, 0, 400, 520)
    await page.mouse.move(ink0.x, ink0.y)
    await page.mouse.down()
    for (let i = 1; i <= 30; i++) {
      await page.mouse.move(ink0.x + ((ink1.x - ink0.x) * i) / 30, ink0.y + Math.sin(i / 3) * 12)
    }
    await expect(page.locator('.fc-markup-tools-svg polyline')).toBeVisible()
    await shot(page, '09-pencil-drawing')
    await page.mouse.up()
    await expect.poll(async () => (await ofType(page, 'Ink')).length).toBe(1)
    // the drawing finishes after a 1.5 s pause: back to Select with the drawing selected
    await expect.poll(() => toolId(page), { timeout: 5000 }).toBe('select')
    const ink = (await ofType(page, 'Ink'))[0]
    expect(ink.ink).toHaveLength(1)
    const xs = ink.ink[0].map((pt) => pt[0])
    expect(Math.min(...xs)).toBeCloseTo(100, -1)
    expect(Math.max(...xs)).toBeCloseTo(400, -1)
    await page.waitForTimeout(400)
    await shot(page, '10-pencil')
    await undoRedo(page, 'Ink', 1)

    // ---- 6. Sticky note (comments feature absent here: a small dialog asks for the text)
    await page.locator('.shell-quicktools button[aria-label="Add sticky note"]').click()
    await settle(page)
    const n = await toScreen(page, 0, 500, 120)
    await page.mouse.click(n.x, n.y)
    const dialog = page.locator('.ui-dialog', { hasText: 'Add sticky note' })
    const hasComments = await page.evaluate(() => (window as any).__fartcrobat.registry.features.some((f: any) => f.id === 'comments'))
    if (!hasComments) {
      await expect(dialog).toBeVisible()
      await page.keyboard.type('Please check this paragraph.')
      await shot(page, '11-note-dialog')
      await dialog.getByRole('button', { name: 'Add note' }).click()
    }
    await expect.poll(async () => (await ofType(page, 'Text')).length).toBe(1)
    const note = (await ofType(page, 'Text'))[0]
    if (!hasComments) expect(note.contents).toBe('Please check this paragraph.')
    // with the comments feature installed, its popup note is asked to open for the new note
    else await expect.poll(async () => (await editEvents(page)).map((ev) => ev.id)).toContain(note.id)
    expect(note.rect[0]).toBeCloseTo(492, -1)
    await page.waitForTimeout(400)
    await shot(page, '12-note')
    await undoRedo(page, 'Text', 1)

    // ---- 7. Eraser: erase the right half of the drawing
    await activate(page, 'comment.eraser')
    expect(await toolId(page)).toBe('comment.eraser')
    const e0 = await toScreen(page, 0, 255, 490)
    const e1 = await toScreen(page, 0, 420, 550)
    await page.mouse.move(e0.x, e0.y)
    await page.mouse.down()
    // sweep back and forth over the right half
    for (let i = 0; i <= 12; i++) {
      const x = e0.x + ((e1.x - e0.x) * i) / 12
      await page.mouse.move(x, e0.y, { steps: 2 })
      await page.mouse.move(x + 4, e1.y, { steps: 4 })
    }
    await shot(page, '13-erasing')
    await page.mouse.up()
    await expect.poll(async () => Math.max(...(await ofType(page, 'Ink'))[0].ink.flat().map((pt) => pt[0]))).toBeLessThan(270)
    const erased = (await ofType(page, 'Ink'))[0]
    expect(Math.min(...erased.ink.flat().map((pt) => pt[0]))).toBeCloseTo(100, -1)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Erase Drawing')
    await page.waitForTimeout(500)
    await shot(page, '14-erased')
    await runCommand(page, 'edit.undo')
    await expect.poll(async () => Math.max(...(await ofType(page, 'Ink'))[0].ink.flat().map((pt) => pt[0]))).toBeGreaterThan(390)
    await runCommand(page, 'edit.redo')
    await expect.poll(async () => Math.max(...(await ofType(page, 'Ink'))[0].ink.flat().map((pt) => pt[0]))).toBeLessThan(270)

    // everything was made by the current author and the document is dirty
    const all = await annots(page)
    expect(all.map((x) => x.type).sort()).toEqual(['Highlight', 'Ink', 'Line', 'Square', 'Text', 'Underline'])
    expect((await activeDocState(page))?.dirty).toBe(true)
  } finally {
    await app.close()
  }
})

test('keyboard shortcuts, tool options, text tools and dark theme', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await captureEditEvents(page)
    await runCommand(page, 'view.fitPage')
    await page.waitForTimeout(400)
    await page.locator('.viewer-scroll').click({ position: { x: 5, y: 5 } })

    // single-key shortcuts like Acrobat: U highlight, Shift+U cycles text markup, D pencil, X text box, S note
    await page.keyboard.press('u')
    expect(await toolId(page)).toBe('comment.highlight')
    await page.keyboard.press('Shift+U')
    expect(await toolId(page)).toBe('comment.underline')
    await page.keyboard.press('d')
    expect(await toolId(page)).toBe('comment.pencil')
    await page.keyboard.press('x')
    expect(await toolId(page)).toBe('comment.textbox')
    await page.keyboard.press('Shift+X')
    expect(await toolId(page)).toBe('comment.callout')
    await page.keyboard.press('q')
    expect(await toolId(page)).toBe('comment.cloud')
    await page.keyboard.press('Shift+D')
    expect(await toolId(page)).toBe('comment.arrow')
    await page.keyboard.press('Control+6')
    expect(await toolId(page)).toBe('comment.note')
    await page.keyboard.press('Escape')
    expect(await toolId(page)).toBe('select')

    // keyboard only: with the sticky note tool, Enter puts a note in the middle of the view
    const hasComments = await page.evaluate(() => (window as any).__fartcrobat.registry.features.some((f: any) => f.id === 'comments'))
    await page.keyboard.press('s')
    await settle(page)
    const centre = await page.evaluate(() => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const r = d.view.getViewportElement().getBoundingClientRect()
      return d.view.hitTest(r.left + r.width / 2, r.top + r.height / 2)
    })
    await page.keyboard.press('Enter')
    if (!hasComments) {
      await expect(page.locator('.ui-dialog', { hasText: 'Add sticky note' })).toBeVisible()
      await page.keyboard.type('Placed from the keyboard')
      await page.keyboard.press('Control+Enter')
    }
    await expect.poll(async () => (await ofType(page, 'Text')).length).toBe(1)
    const kbNote = (await ofType(page, 'Text'))[0]
    expect(centre.pageIndex).toBe(0)
    expect((kbNote.rect[0] + kbNote.rect[2]) / 2).toBeCloseTo(centre.point[0] + 2, -1)
    expect((kbNote.rect[1] + kbNote.rect[3]) / 2).toBeCloseTo(centre.point[1] + 2, -1)
    if (!hasComments) expect(kbNote.contents).toBe('Placed from the keyboard')
    await runCommand(page, 'edit.undo')
    await expect.poll(async () => (await ofType(page, 'Text')).length).toBe(0)
    await page.locator('.viewer-scroll').click({ position: { x: 5, y: 5 } })

    // tool options are remembered per tool
    await page.keyboard.press('s')
    await page.locator('.fc-markup-tools-color', { hasText: 'Colour' }).click()
    await expect(page.locator('.fc-markup-tools-popover')).toBeVisible()
    await shot(page, '15-color-popover')
    await page.locator('.fc-markup-tools-popover .ui-swatch[title="#2196F3"]').click()
    await expect(page.locator('.fc-markup-tools-popover')).toHaveCount(0)
    await page.locator('select[aria-label="Note icon"]').selectOption('Key')
    const stored = await page.evaluate(() => (window as any).api.invoke('store:get', 'markup-tools:defaults'))
    await expect.poll(async () => (await page.evaluate(() => (window as any).api.invoke('store:get', 'markup-tools:defaults')))?.tools?.note?.icon).toBe('Key')
    expect(stored === undefined || typeof stored === 'object').toBe(true)

    // keep tool selected: place two notes in a row
    await page.locator('.fc-markup-tools-pin').click()
    await expect(page.locator('.fc-markup-tools-pin')).toHaveAttribute('aria-pressed', 'true')
    // the second note goes below the first: the comments feature opens a pop-up beside each note
    for (const x of [300, 340]) {
      const pt = await toScreen(page, 0, x === 300 ? 300 : 120, x === 300 ? 400 : 560)
      await page.mouse.click(pt.x, pt.y)
      // the note editor (ours, or the comments pop-up) gets focus: type and close it with Ctrl+Enter
      await waitForEditor(page)
      await page.keyboard.type(`Note at ${x}`)
      await page.keyboard.press('Control+Enter')
      await expect.poll(async () => (await ofType(page, 'Text')).length).toBe(x === 300 ? 1 : 2)
    }
    expect(await toolId(page)).toBe('comment.note')
    const notes = await ofType(page, 'Text')
    expect(notes.every((nt) => nt.color?.toUpperCase() === '#2196F3')).toBe(true)
    await page.locator('.fc-markup-tools-pin').click()

    // Replace text: strike-out + caret grouped
    await activate(page, 'comment.replaceText')
    const lorem = await textQuads(page, 0, 'dolor sit')
    const ly = (lorem.first[1] + lorem.first[5]) / 2
    await drag(page, await toScreen(page, 0, lorem.first[0] + 0.5, ly), await toScreen(page, 0, lorem.last[2] - 0.3, ly))
    if (!hasComments) {
      await expect(page.locator('.ui-dialog', { hasText: 'Replace text' })).toBeVisible()
      await page.keyboard.type('pain')
      await page.locator('.ui-dialog').getByRole('button', { name: 'Replace' }).click()
    } else {
      await expect(page.locator('.fc-comments-popup').last()).toBeVisible()
      await waitForEditor(page)
      await page.keyboard.type('pain')
      await page.keyboard.press('Control+Enter')
    }
    await expect.poll(async () => (await ofType(page, 'Caret')).length).toBe(1)
    const strike = (await ofType(page, 'StrikeOut'))[0]
    const caret = (await ofType(page, 'Caret'))[0]
    expect((strike as any).inReplyTo).toBe(caret.id)
    if (!hasComments) expect(caret.contents).toBe('pain')

    // Insert text between characters
    await activate(page, 'comment.insertText')
    const amet = await textQuads(page, 0, 'amet')
    const ins = await toScreen(page, 0, amet.first[0] + 0.3, (amet.first[1] + amet.first[5]) / 2)
    await page.mouse.move(ins.x, ins.y)
    await page.mouse.click(ins.x, ins.y)
    if (!hasComments) {
      await page.keyboard.type('very ')
      await page.locator('.ui-dialog').getByRole('button', { name: 'Insert' }).click()
    } else {
      await expect(page.locator('.fc-comments-popup').last()).toBeVisible()
      await waitForEditor(page)
      await page.keyboard.type('very ')
      await page.keyboard.press('Control+Enter')
    }
    await expect.poll(async () => (await ofType(page, 'Caret')).length).toBe(2)
    const inserted = (await ofType(page, 'Caret')).find((c) => c.id !== caret.id)!
    expect((inserted.rect[0] + inserted.rect[2]) / 2).toBeCloseTo(amet.first[0], 0)

    // Text box (drag) and callout (click tip, then click for the box)
    await activate(page, 'comment.textbox')
    const tb0 = await toScreen(page, 0, 320, 470)
    await drag(page, tb0, { x: tb0.x + 220, y: tb0.y + 60 })
    if (!hasComments) {
      await page.keyboard.type('A text box')
      await page.locator('.ui-dialog').getByRole('button', { name: 'Add text box' }).click()
    } else {
      // the comments inline editor opens; empty text boxes are discarded, so type something
      await waitForEditor(page)
      await page.keyboard.type('A text box')
      await page.keyboard.press('Control+Enter')
    }
    await expect.poll(async () => (await ofType(page, 'FreeText')).length).toBe(1)
    await activate(page, 'comment.callout')
    const tip = await toScreen(page, 0, 150, 470)
    await page.mouse.click(tip.x, tip.y)
    const boxAt = await toScreen(page, 0, 200, 600)
    await page.mouse.move(boxAt.x, boxAt.y, { steps: 5 })
    await expect(page.locator('.fc-markup-tools-tip')).toBeVisible()
    await shot(page, '16-callout-placing')
    await page.mouse.click(boxAt.x, boxAt.y)
    if (!hasComments) {
      await page.keyboard.type('Look here')
      await page.locator('.ui-dialog').getByRole('button', { name: 'Add callout' }).click()
    } else {
      await waitForEditor(page)
      await page.keyboard.type('Look here')
      await page.keyboard.press('Control+Enter')
    }
    await expect.poll(async () => (await ofType(page, 'FreeText')).length).toBe(2)
    const callout = (await page.evaluate(async () => (window as any).__fartcrobat.getActiveDoc().ops('annots').list(0))).find(
      (x: any) => x.intent === 'FreeTextCallout'
    )
    expect(callout.calloutLine[0][0]).toBeCloseTo(150, 0)

    // Polygon: click points, double-click to finish
    await activate(page, 'comment.cloud')
    const c0 = await toScreen(page, 0, 80, 640)
    await page.mouse.click(c0.x, c0.y)
    await page.mouse.click(c0.x + 120, c0.y)
    await page.mouse.click(c0.x + 120, c0.y + 70)
    await page.mouse.move(c0.x + 20, c0.y + 80, { steps: 4 })
    await shot(page, '17-cloud-drawing')
    await page.mouse.dblclick(c0.x + 20, c0.y + 80)
    await expect.poll(async () => (await ofType(page, 'Polygon')).length).toBe(1)
    expect((await ofType(page, 'Polygon'))[0] as any).toMatchObject({ cloudy: true })

    await page.waitForTimeout(500)
    await shot(page, '18-text-tools')

    // dark theme: options bar and panel
    await page.evaluate(() => {
      const s = (window as any).__fartcrobat.useApp.getState()
      ;(window as any).__fartcrobat.useApp.setState({ prefs: { ...s.prefs, theme: 'dark' } })
    })
    await page.locator('.shell-alltools-item', { hasText: 'Add comments' }).click()
    await page.locator('.ui-tool-row', { hasText: 'Draw oval' }).click()
    // the colour picker works from the keyboard: Enter opens it on the current colour, arrows move,
    // Enter picks, focus returns to the button
    const fill = page.locator('.fc-markup-tools-color', { hasText: 'Fill' })
    await fill.focus()
    await page.keyboard.press('Enter')
    await expect(page.locator('.fc-markup-tools-popover')).toBeVisible()
    await expect(page.locator('.fc-markup-tools-popover .ui-swatch-none')).toBeFocused()
    await page.waitForTimeout(200)
    await shot(page, '19-dark')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.fc-markup-tools-popover .ui-swatch[title="#FFEB3B"]')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(page.locator('.fc-markup-tools-popover')).toHaveCount(0)
    await expect(fill).toBeFocused()
    await expect(fill).toHaveAttribute('aria-label', 'Fill: #FFEB3B')
    await expect
      .poll(async () => (await page.evaluate(() => (window as any).api.invoke('store:get', 'markup-tools:defaults')))?.tools?.oval?.fill)
      .toBe('#FFEB3B')
    // Tab leaves the picker (closing it) for the next control of the options bar
    await page.keyboard.press('Enter')
    await expect(page.locator('.fc-markup-tools-popover')).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(page.locator('.fc-markup-tools-popover')).toHaveCount(0)
    await expect(page.locator('select[aria-label="Line width"]')).toBeFocused()
  } finally {
    await app.close()
  }
})

test('rotated view, scanned pages, typewriter, connected lines, squiggly, note on text and shared defaults', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await captureEditEvents(page)
    await runCommand(page, 'view.fitPage')
    await page.waitForTimeout(300)
    const hasComments = await page.evaluate(() => (window as any).__fartcrobat.registry.features.some((f: any) => f.id === 'comments'))

    // the "Add comments" tile is on the Home screen too
    expect(await page.evaluate(() => (window as any).__fartcrobat.registry.toolGroups.find((g: any) => g.id === 'comment')?.homeTile)).toBe(true)

    // defaults saved by the comments feature ("Make current properties default") are picked up
    await page.evaluate(() => (window as any).api.invoke('store:set', 'comments:defaults:Square', { color: '#4caf50', borderWidth: 4, dashes: [3, 3] }))

    // comments hidden (View > Show/Hide > Comments): picking a comment tool shows them again
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().set({ showAnnotations: false }))

    // ---- rectangle in a view rotated 90° clockwise lands where it was drawn
    await runCommand(page, 'view.rotateCW')
    await activate(page, 'comment.rectangle')
    expect(await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.showAnnotations)).toBe(true)
    await expect(page.locator('.toast-message', { hasText: 'Comments were hidden' })).toBeVisible()
    await expect(page.locator('.fc-markup-tools-color', { hasText: 'Colour' }).locator('.fc-markup-tools-color-swatch')).toHaveCSS('background-color', 'rgb(76, 175, 80)')
    await expect(page.locator('select[aria-label="Line width"]')).toHaveValue('4')
    await drag(page, await toScreen(page, 0, 100, 100), await toScreen(page, 0, 220, 160))
    await expect.poll(async () => (await ofType(page, 'Square')).length).toBe(1)
    const sq = (await ofType(page, 'Square'))[0] as any
    expect(sq.rect[0]).toBeCloseTo(100, 0)
    expect(sq.rect[1]).toBeCloseTo(100, 0)
    expect(sq.rect[2]).toBeCloseTo(220, 0)
    expect(sq.rect[3]).toBeCloseTo(160, 0)
    expect(sq.color).toBe('#4caf50')
    expect(sq.borderWidth).toBe(4)
    expect(sq.dashes.length).toBeGreaterThan(0)
    await page.waitForTimeout(400)
    await shot(page, '20-rotated-rectangle')
    await runCommand(page, 'view.rotateCCW')
    await page.waitForTimeout(300)

    // ---- typewriter: click and type
    await activate(page, 'comment.typewriter')
    const tw = await toScreen(page, 0, 300, 120)
    await page.mouse.click(tw.x, tw.y)
    if (!hasComments) {
      await page.keyboard.type('Typed on the page')
      await page.locator('.ui-dialog').getByRole('button', { name: 'Add text' }).click()
    }
    await expect.poll(async () => (await ofType(page, 'FreeText')).length).toBe(1)
    const ft = (await ofType(page, 'FreeText'))[0] as any
    expect(ft.intent).toBe('FreeTextTypeWriter')
    if (hasComments) await expect.poll(async () => (await editEvents(page)).map((ev) => ev.id)).toContain(ft.id)
    expect(ft.borderWidth).toBe(0)
    expect(ft.rect[0]).toBeLessThan(300)
    expect(ft.rect[1]).toBeLessThan(120)
    expect(ft.rect[3]).toBeGreaterThan(120)

    // ---- connected lines: click points, Backspace removes one, Enter finishes
    await activate(page, 'comment.polyline')
    for (const [x, y] of [[80, 700], [160, 660], [240, 700], [300, 640]]) {
      const pt = await toScreen(page, 0, x, y)
      await page.mouse.click(pt.x, pt.y)
    }
    await page.keyboard.press('Backspace')
    await expect(page.locator('.fc-markup-tools-vertex')).toHaveCount(3)
    await shot(page, '21-polyline-drawing')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await ofType(page, 'PolyLine')).length).toBe(1)
    expect(((await ofType(page, 'PolyLine'))[0] as any).vertices).toHaveLength(3)
    // Escape cancels a shape in progress without leaving the tool
    await activate(page, 'comment.polygon')
    const pg0 = await toScreen(page, 0, 400, 650)
    await page.mouse.click(pg0.x, pg0.y)
    await page.mouse.click(pg0.x + 40, pg0.y)
    await page.keyboard.press('Escape')
    await expect(page.locator('.fc-markup-tools-vertex')).toHaveCount(0)
    expect(await toolId(page)).toBe('comment.polygon')
    await page.keyboard.press('Escape')
    expect(await toolId(page)).toBe('select')

    // ---- squiggly by dragging across text (Shift+U cycles to it)
    await page.locator('.viewer-scroll').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('u')
    await page.keyboard.press('Shift+U')
    await page.keyboard.press('Shift+U')
    await page.keyboard.press('Shift+U')
    expect(await toolId(page)).toBe('comment.squiggly')
    await settle(page)
    const cons = await textQuads(page, 0, 'consectetur')
    const cy = (cons.first[1] + cons.first[5]) / 2
    await drag(page, await toScreen(page, 0, cons.first[0] + 0.3, cy), await toScreen(page, 0, cons.last[2] - 0.3, cy))
    await expect.poll(async () => (await ofType(page, 'Squiggly')).length).toBe(1)

    // ---- "Add note to text" from the selection toolbar: a highlight with a comment
    await expect.poll(() => toolId(page)).toBe('select')
    await settle(page)
    const hello = await textQuads(page, 0, 'Hello Fartcrobat')
    const hy = (hello.first[1] + hello.first[5]) / 2
    await drag(page, await toScreen(page, 0, hello.first[0] + 0.3, hy), await toScreen(page, 0, hello.last[2] - 0.3, hy))
    await page.locator('.viewer-selection-toolbar button[title="Add note to text"]').click()
    if (!hasComments) {
      await expect(page.locator('.ui-dialog', { hasText: 'Add note to text' })).toBeVisible()
      await page.keyboard.type('Greeting')
      await page.keyboard.press('Control+Enter')
    }
    await expect.poll(async () => (await ofType(page, 'Highlight')).length).toBe(1)
    const greeting = (await ofType(page, 'Highlight'))[0]
    if (!hasComments) expect(greeting.contents).toBe('Greeting')
    // the highlight covers exactly "Hello Fartcrobat"
    expect(Math.min(greeting.quads[0][0], greeting.quads[0][4])).toBeCloseTo(hello.first[0], 0)
    expect(Math.max(greeting.quads[0][2], greeting.quads[0][6])).toBeCloseTo(hello.last[2], 0)

    // ---- Attach file: click, choose a file (native dialog stubbed), the file is embedded
    await app.evaluate(({ dialog }, file) => {
      ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
    }, fixturePath('scan.png'))
    await activate(page, 'comment.attachFile')
    const at = await toScreen(page, 0, 540, 300)
    await page.mouse.click(at.x, at.y)
    await expect.poll(async () => (await ofType(page, 'FileAttachment')).length).toBe(1)
    const att = (await ofType(page, 'FileAttachment'))[0] as any
    expect(att.fileName).toBe('scan.png')
    expect(att.icon).toBe('PushPin')
    const size = await page.evaluate(async (id) => (await (window as any).__fartcrobat.getActiveDoc().ops('annots').attachment(id))?.data.length, att.id)
    expect(size).toBeGreaterThan(1000)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Add File Attachment')
    await undoRedo(page, 'FileAttachment', 1)

    await page.waitForTimeout(400)
    await shot(page, '22-more-tools')

    // ---- a scanned page has no text: the Highlight tool highlights an area instead
    await openFile(page, fixturePath('scanned.pdf'))
    await waitForRender(page)
    await activate(page, 'comment.highlight')
    const s0 = await toScreen(page, 0, 70, 95)
    const s1 = await toScreen(page, 0, 420, 150)
    await page.mouse.move(s0.x, s0.y)
    await page.mouse.down()
    await page.mouse.move(s1.x, s1.y, { steps: 8 })
    await shot(page, '23-scanned-area-dragging')
    await page.mouse.up()
    await expect.poll(async () => (await ofType(page, 'Highlight')).length).toBe(1)
    const area = (await ofType(page, 'Highlight'))[0]
    expect(area.quads[0][0]).toBeCloseTo(70, 0)
    expect(area.quads[0][7]).toBeCloseTo(150, 0)
    await page.waitForTimeout(500)
    await shot(page, '24-scanned-area')
  } finally {
    await app.close()
  }
})

test('with the comments feature installed, new comments open its editor instead of a dialog', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await captureEditEvents(page)
    // stand-in for the comments feature when it is not part of this build
    await page.evaluate(() => {
      const reg = (window as any).__fartcrobat.registry
      if (!reg.features.some((f: any) => f.id === 'comments')) reg.register({ id: 'comments' })
    })
    const docId = await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().id)

    await activate(page, 'comment.note')
    const n = await toScreen(page, 0, 520, 140)
    await page.mouse.click(n.x, n.y)
    await expect.poll(async () => (await ofType(page, 'Text')).length).toBe(1)
    const note = (await ofType(page, 'Text'))[0]
    await expect.poll(() => editEvents(page)).toEqual([{ docId, id: note.id, page: 0 }])
    expect(note.contents).toBe('')
    await expect(page.locator('.ui-dialog')).toHaveCount(0)

    await activate(page, 'comment.textbox')
    const t0 = await toScreen(page, 0, 300, 520)
    await drag(page, t0, { x: t0.x + 180, y: t0.y + 50 })
    await expect.poll(async () => (await ofType(page, 'FreeText')).length).toBe(1)
    const box = (await ofType(page, 'FreeText'))[0]
    await expect.poll(async () => (await editEvents(page)).length).toBe(2)
    expect((await editEvents(page))[1].id).toBe(box.id)
    // the text box keeps the size that was drawn
    expect(box.rect[2] - box.rect[0]).toBeGreaterThan(100)

    await activate(page, 'comment.replaceText')
    const q = await textQuads(page, 0, 'lazy dog')
    const y = (q.first[1] + q.first[5]) / 2
    await drag(page, await toScreen(page, 0, q.first[0] + 0.3, y), await toScreen(page, 0, q.last[2] - 0.3, y))
    await expect.poll(async () => (await ofType(page, 'Caret')).length).toBe(1)
    const caret = (await ofType(page, 'Caret'))[0]
    await expect.poll(async () => (await editEvents(page)).length).toBe(3)
    expect((await editEvents(page))[2].id).toBe(caret.id)
    await expect(page.locator('.ui-dialog')).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('the Add comments panel lists stamp, measure and comment commands when those features are installed', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    // stand-ins for the stamps-measure and comments features when they are not part of this build
    await page.evaluate(() => {
      const w = window as any
      const reg = w.__fartcrobat.registry
      const icon = reg.tools.get('select').icon
      w.__ran = []
      const fakeTools = [
        { id: 'stamps.stamp', label: 'Add stamp', icon, shortcut: 'K' },
        { id: 'measure.distance', label: 'Distance', icon },
        { id: 'measure.perimeter', label: 'Perimeter', icon },
        { id: 'measure.area', label: 'Area', icon }
      ].filter((t) => !reg.tools.has(t.id))
      const fakeCommands = [
        { id: 'comments.export', label: 'Export comments', icon },
        { id: 'comments.import', label: 'Import comments', icon },
        { id: 'comments.summarize', label: 'Summarize comments', icon },
        { id: 'comments.toggleVisibility', label: 'Show/Hide Comments', icon, shortcut: 'Mod+Shift+8' }
      ]
        .filter((c) => !reg.commands.has(c.id))
        .map((c) => ({ ...c, run: () => w.__ran.push(c.id) }))
      reg.register({ id: 'markup-tools-e2e-standins', tools: fakeTools, commands: fakeCommands })
    })
    await page.locator('.shell-alltools-item', { hasText: 'Add comments' }).click()
    const panel = page.locator('.fc-markup-tools-panel')
    await expect(panel.locator('.ui-section', { hasText: 'Stamps & measure' }).locator('.ui-tool-row')).toHaveCount(4)
    const stamp = await page.evaluate(() => {
      const t = (window as any).__fartcrobat.registry.tools.get('stamps.stamp')
      return { label: t.label as string, shortcut: (t.shortcut ?? null) as string | null }
    })
    const stampRow = panel.locator('.ui-tool-row', { hasText: stamp.label })
    if (stamp.shortcut && /^[A-Z]$/.test(stamp.shortcut)) await expect(stampRow).toContainText(stamp.shortcut)
    await expect(panel.locator('.ui-section', { hasText: 'Manage comments' }).locator('.ui-tool-row')).toHaveCount(4)
    await stampRow.click()
    expect(await toolId(page)).toBe('stamps.stamp')
    const realComments = await page.evaluate(() => (window as any).__fartcrobat.registry.features.some((f: any) => f.id === 'comments'))
    if (!realComments) {
      await panel.locator('.ui-tool-row', { hasText: 'Export comments' }).click()
      await expect.poll(() => page.evaluate(() => (window as any).__ran)).toEqual(['comments.export'])
    }
    await panel.locator('.ui-section', { hasText: 'Manage comments' }).scrollIntoViewIfNeeded()
    await shot(page, '25-panel-with-other-tools')
  } finally {
    await app.close()
  }
})
