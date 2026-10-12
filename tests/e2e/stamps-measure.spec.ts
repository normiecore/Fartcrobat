import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { fixturePath, launch, openFile, waitForRender } from './helpers'

const SHOT = (name: string) => `test-results/stamps-measure-${name}.png`

interface Annot {
  id: number
  type: string
  rect: [number, number, number, number]
  icon: string
  subject: string
  contents: string
  intent: string | null
  color: string | null
  extra: Record<string, string>
}

async function annots(page: Page, pageIndex = 0): Promise<Annot[]> {
  return page.evaluate((i) => (window as any).__fartcrobat.getActiveDoc().ops('annots').list(i), pageIndex)
}

async function toolId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)
}

/** Sets an exact zoom and scrolls page `index` to the top so it is fully laid out. */
async function setZoom(page: Page, zoom: number) {
  await page.evaluate((z) => (window as any).__fartcrobat.getActiveDoc().view.setZoom(z), zoom)
  await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.zoom)).toBeCloseTo(zoom, 3)
  await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.goToPage(0))
  await page.waitForTimeout(300)
}

/** Screen position of a page-space point (points, y down) on page `index`. */
async function at(page: Page, x: number, y: number, index = 0): Promise<{ x: number; y: number }> {
  const box = await page.locator(`.viewer-page[data-page-index="${index}"]`).boundingBox()
  if (!box) throw new Error('page not visible')
  const zoom: number = await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.zoom)
  const s = (zoom * 96) / 72
  return { x: box.x + x * s, y: box.y + y * s }
}

async function clickAt(page: Page, x: number, y: number, index = 0) {
  const p = await at(page, x, y, index)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.up()
}

/** Screen position of a page-space point on page 0 while the view is rotated 90° clockwise. */
async function atRotated90(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const box = await page.locator('.viewer-page[data-page-index="0"]').boundingBox()
  if (!box) throw new Error('page not visible')
  const { zoom, height } = await page.evaluate(() => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    return { zoom: d.state.zoom as number, height: d.state.info.pages[0].height as number }
  })
  const s = (zoom * 96) / 72
  return { x: box.x + (height - y) * s, y: box.y + x * s }
}

async function setViewRotation(page: Page, rotation: 0 | 90) {
  await page.evaluate((r) => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    d.set({ viewRotation: r })
    d.view.goToPage(0)
  }, rotation)
  await page.waitForTimeout(400)
}

/** Scrolls so a page-space rectangle of page 0 is in view. */
async function reveal(page: Page, rect: [number, number, number, number]) {
  await page.evaluate((r) => (window as any).__fartcrobat.getActiveDoc().view.scrollToRect(0, r, { center: true }), rect)
  await page.waitForTimeout(300)
}

/**
 * Makes the native "Open" dialog return `path` (no OS dialog in tests). window.api is frozen by
 * Electron's contextBridge, so the stub replaces the main-process handler instead.
 */
async function stubOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ ipcMain }, p) => {
    ipcMain.removeHandler('file:openDialog')
    ipcMain.handle('file:openDialog', () => [p])
  }, path)
}

async function openGroup(page: Page, label: string) {
  await page.locator('.shell-alltools-item', { hasText: label }).click()
  await expect(page.locator('.ui-panel-header h3', { hasText: label })).toBeVisible()
}

test('stamps: palette, click and drag placement, dynamic and custom stamps', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 1400, height: 900 })
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await setZoom(page, 0.75)

    await openGroup(page, 'Add a stamp')
    expect(await toolId(page)).toBe('stamps.stamp')
    const standard = page.getByRole('region', { name: 'Standard Business' })
    const approvedTile = standard.getByRole('button', { name: 'Approved stamp', exact: true })
    await expect(approvedTile.locator('img')).toBeVisible()
    await expect(page.getByRole('region', { name: 'Dynamic' }).getByRole('button', { name: 'Reviewed stamp' }).locator('img')).toBeVisible()
    await page.screenshot({ path: SHOT('palette') })

    // Approved (drawn by MuPDF from its name): one click places it at its default size.
    await approvedTile.click()
    const hover = await at(page, 300, 600)
    await page.mouse.move(hover.x, hover.y)
    await expect(page.locator('.fc-stamps-measure-ghost')).toBeVisible()
    await page.screenshot({ path: SHOT('ghost') })
    await clickAt(page, 300, 600)
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'Stamp').length).toBe(1)
    const approved = (await annots(page)).find((a) => a.type === 'Stamp')!
    expect(approved.icon).toBe('Approved')
    expect(approved.subject).toBe('Approved')
    expect(approved.extra.stamp).toBe('standard:approved')
    const cx = (approved.rect[0] + approved.rect[2]) / 2
    const cy = (approved.rect[1] + approved.rect[3]) / 2
    expect(cx).toBeCloseTo(300, 0)
    expect(cy).toBeCloseTo(600, 0)
    expect(approved.rect[2] - approved.rect[0]).toBeCloseTo(150, 0)
    // back to the Select tool with the new stamp selected (Acrobat behaviour)
    expect(await toolId(page)).toBe('select')
    const sel = await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().state.selection)
    expect(sel).toEqual({ kind: 'annotations', page: 0, ids: [approved.id] })

    // Dynamic "Reviewed" stamp placed by dragging: size follows the drag, with author and time.
    await page.getByRole('region', { name: 'Dynamic' }).getByRole('button', { name: 'Reviewed stamp' }).click()
    expect(await toolId(page)).toBe('stamps.stamp')
    const a = await at(page, 100, 650)
    const b = await at(page, 280, 700)
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
    await page.mouse.move(b.x, b.y, { steps: 4 })
    await expect(page.locator('.fc-stamps-measure-ghost-frame')).toBeVisible()
    await page.screenshot({ path: SHOT('drag') })
    await page.mouse.up()
    await expect.poll(async () => (await annots(page)).filter((x) => x.type === 'Stamp').length).toBe(2)
    const reviewed = (await annots(page)).find((x) => x.extra.stamp === 'dynamic:reviewed')!
    expect(reviewed.icon).toBe('DReviewed')
    expect(reviewed.subject).toBe('Reviewed')
    expect(reviewed.contents).toMatch(/^Reviewed by .+ at .+/)
    expect(reviewed.rect[0]).toBeCloseTo(100, 0)
    expect(reviewed.rect[1]).toBeCloseTo(650, 0)
    expect(reviewed.rect[2] - reviewed.rect[0]).toBeCloseTo(180, 0)
    expect((reviewed.rect[2] - reviewed.rect[0]) / (reviewed.rect[3] - reviewed.rect[1])).toBeCloseTo(3, 1)
    await page.waitForTimeout(400)
    await page.screenshot({ path: SHOT('placed') })

    // Custom stamp from an image file.
    await stubOpenDialog(app, fixturePath('scan.png'))
    await page.getByRole('button', { name: 'Create custom stamp…' }).click()
    const dialog = page.locator('.fc-stamps-measure-custom-dialog')
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Choose image or PDF…' }).click()
    await expect(dialog.getByRole('img', { name: 'Stamp preview' })).toBeVisible()
    await expect(dialog.getByLabel('Stamp name')).toHaveValue('scan')
    await dialog.getByLabel('Stamp name').fill('Scanned note')
    await page.waitForTimeout(300) // let the dialog finish fading in
    await page.screenshot({ path: SHOT('custom-dialog') })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toBeHidden()
    const customTile = page.getByRole('region', { name: 'Custom' }).getByRole('button', { name: 'Scanned note stamp' })
    await expect(customTile).toHaveAttribute('aria-pressed', 'true')
    expect(await toolId(page)).toBe('stamps.stamp')
    const stored = await page.evaluate(() => (window as any).api.invoke('store:get', 'stamps-measure:custom'))
    expect(stored).toHaveLength(1)
    expect(stored[0].name).toBe('Scanned note')
    expect(stored[0].dataUrl).toMatch(/^data:image\/png;base64,/)

    await clickAt(page, 450, 520)
    await expect.poll(async () => (await annots(page)).filter((x) => x.type === 'Stamp').length).toBe(3)
    const custom = (await annots(page)).find((x) => x.extra.stamp?.startsWith('custom:'))!
    expect(custom.subject).toBe('Scanned note')
    await page.waitForTimeout(400)
    await page.screenshot({ path: SHOT('custom-placed') })

    // Undo removes the last stamp.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await annots(page)).filter((x) => x.type === 'Stamp').length).toBe(2)

    // Contextual toolbar: the palette dropdown picks another stamp.
    await page.keyboard.press('k')
    expect(await toolId(page)).toBe('stamps.stamp')
    await page.getByRole('button', { name: /Choose stamp/ }).click()
    const pop = page.getByRole('dialog', { name: 'Stamps' })
    await expect(pop).toBeVisible()
    await pop.getByLabel('Search stamps').fill('sign')
    await expect(pop.getByRole('button', { name: 'Sign Here stamp' })).toBeVisible()
    await page.screenshot({ path: SHOT('toolbar-palette') })
    await pop.getByRole('button', { name: 'Sign Here stamp' }).click()
    await expect(pop).toBeHidden()
    await expect(page.getByRole('button', { name: 'Choose stamp (current: Sign Here)' })).toBeVisible()
    await clickAt(page, 450, 740)
    await expect.poll(async () => (await annots(page)).some((x) => x.extra.stamp === 'signhere:signhere')).toBe(true)

    // Rotated view (View > Rotate View): the stamp lands where you click and reads upright on the page.
    await setViewRotation(page, 90)
    await page.keyboard.press('k')
    await page.getByRole('button', { name: /Choose stamp/ }).click()
    await page.getByRole('dialog', { name: 'Stamps' }).getByLabel('Search stamps').fill('draft')
    await page.getByRole('dialog', { name: 'Stamps' }).getByRole('button', { name: 'Draft stamp' }).click()
    const rp = await atRotated90(page, 300, 200)
    await page.mouse.move(rp.x, rp.y)
    await expect(page.locator('.fc-stamps-measure-ghost')).toBeVisible()
    await page.screenshot({ path: SHOT('rotated-ghost') })
    await page.mouse.down()
    await page.mouse.up()
    await expect.poll(async () => (await annots(page)).some((x) => x.extra.stamp === 'standard:draft')).toBe(true)
    const draft = (await annots(page)).find((x) => x.extra.stamp === 'standard:draft')!
    expect((draft.rect[0] + draft.rect[2]) / 2).toBeCloseTo(300, 0)
    expect((draft.rect[1] + draft.rect[3]) / 2).toBeCloseTo(200, 0)
    // wider than tall in page space: upright on the page, not turned with the view
    expect(draft.rect[2] - draft.rect[0]).toBeGreaterThan(draft.rect[3] - draft.rect[1])
    await page.waitForTimeout(400)
    await page.screenshot({ path: SHOT('rotated-placed') })
    await setViewRotation(page, 0)

    // Custom stamp from page 2 of a PDF (rendered by a temporary engine), then rename and delete it.
    // (through Menu > Comment > Stamps, where Acrobat keeps it)
    await stubOpenDialog(app, fixturePath('text.pdf'))
    await page.getByRole('button', { name: 'Menu', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Comment', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Stamps', exact: true }).click()
    await expect(page.getByRole('menuitem', { name: 'Show Stamps Palette' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Create Custom Stamp…' }).click()
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Choose image or PDF…' }).click()
    await expect(dialog.getByText('Page 1 of 5')).toBeVisible()
    await expect(dialog.getByRole('img', { name: 'Stamp preview' })).toBeVisible()
    const firstPreview = await dialog.getByRole('img', { name: 'Stamp preview' }).getAttribute('src')
    await dialog.getByRole('button', { name: 'Next page' }).click()
    await expect(dialog.getByText('Page 2 of 5')).toBeVisible()
    await expect.poll(() => dialog.getByRole('img', { name: 'Stamp preview' }).getAttribute('src')).not.toBe(firstPreview)
    await dialog.getByLabel('Stamp name').fill('Chapter two')
    await page.waitForTimeout(300) // let the dialog finish fading in
    await page.screenshot({ path: SHOT('custom-pdf') })
    await dialog.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(dialog).toBeHidden()
    const customRegion = page.getByRole('region', { name: 'Custom' })
    await expect(customRegion.getByRole('button', { name: 'Chapter two stamp' })).toBeVisible()

    await customRegion.getByRole('button', { name: 'Chapter two stamp' }).hover()
    await customRegion.getByRole('button', { name: 'More options for Chapter two' }).click()
    await page.getByRole('menuitem', { name: 'Rename…' }).click()
    await page.locator('.ui-dialog input').fill('Chapter 2 page')
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await expect(customRegion.getByRole('button', { name: 'Chapter 2 page stamp' })).toBeVisible()
    await customRegion.getByRole('button', { name: 'Chapter 2 page stamp' }).hover()
    await customRegion.getByRole('button', { name: 'More options for Chapter 2 page' }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    await page.locator('.ui-dialog').getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(customRegion.getByRole('button', { name: 'Chapter 2 page stamp' })).toHaveCount(0)
    const remaining = await page.evaluate(() => (window as any).api.invoke('store:get', 'stamps-measure:custom'))
    expect(remaining.map((c: { name: string }) => c.name)).toEqual(['Scanned note'])

    // Dark theme
    await page.evaluate(() => {
      const { useApp } = (window as any).__fartcrobat
      useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } }))
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: SHOT('dark') })
    await page.keyboard.press('k')
    await page.getByRole('button', { name: /Choose stamp/ }).click()
    await expect(page.getByRole('dialog', { name: 'Stamps' })).toBeVisible()
    await page.screenshot({ path: SHOT('dark-toolbar-palette') })
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Stamps' })).toBeHidden()
    expect(await toolId(page)).toBe('stamps.stamp')
    await stubOpenDialog(app, fixturePath('scan.png'))
    await page.getByRole('button', { name: 'Create custom stamp…' }).click()
    await dialog.getByRole('button', { name: 'Choose image or PDF…' }).click()
    await expect(dialog.getByRole('img', { name: 'Stamp preview' })).toBeVisible()
    await page.waitForTimeout(300) // let the dialog finish fading in
    await page.screenshot({ path: SHOT('dark-custom-dialog') })
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toBeHidden()
  } finally {
    await app.close()
  }
})

test('measuring: scale, distance, area and perimeter with live readout', async () => {
  const { app, page } = await launch()
  try {
    await page.setViewportSize({ width: 1400, height: 900 })
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await setZoom(page, 0.75)

    await openGroup(page, 'Measure objects')
    expect(await toolId(page)).toBe('measure.distance')

    // Scale 1 in = 1 ft
    await page.getByLabel('Real unit').first().selectOption('ft')
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().ops('stamps-measure').getScale()))
      .toMatchObject({ pageValue: 1, pageUnit: 'in', realValue: 1, realUnit: 'ft' })
    await expect(page.getByRole('button', { name: 'Scale: 1 in = 1 ft' })).toBeVisible()

    // Distance: two clicks 144 pt apart
    const p1 = await at(page, 100, 560)
    const p2 = await at(page, 244, 560)
    await page.mouse.move(p1.x, p1.y)
    await page.mouse.down()
    await page.mouse.up()
    await page.mouse.move((p1.x + p2.x) / 2, p2.y, { steps: 3 })
    await page.mouse.move(p2.x, p2.y, { steps: 3 })
    await expect(page.locator('.fc-stamps-measure-readout')).toHaveText('2 ft')
    await expect(page.locator('.fc-stamps-measure-info-row', { hasText: 'Distance' })).toContainText('2 ft')
    await expect(page.locator('.fc-stamps-measure-info-row', { hasText: 'Angle' })).toContainText('0°')
    await expect(page.locator('.fc-stamps-measure-info-row', { hasText: 'Scale' })).toContainText('1 in = 1 ft')
    await page.screenshot({ path: SHOT('distance-live') })
    await page.mouse.down()
    await page.mouse.up()
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'Line').length).toBe(1)
    const line = (await annots(page)).find((a) => a.type === 'Line')!
    expect(line.contents).toBe('2 ft')
    expect(line.intent).toBe('LineDimension')
    expect(line.extra).toMatchObject({ fartcrobat: 'measure', kind: 'distance', value: '2', unit: 'ft', scale: '1 in = 1 ft' })
    // the tool stays active for the next measurement
    expect(await toolId(page)).toBe('measure.distance')
    await expect(page.locator('.fc-stamps-measure-item-value', { hasText: '2 ft' })).toBeVisible()

    // Area: a 1 in square closed by clicking its first corner -> 1 sq ft
    await page.getByRole('group', { name: 'Measuring tools' }).getByRole('button', { name: /Area/ }).click()
    expect(await toolId(page)).toBe('measure.area')
    for (const [x, y] of [
      [100, 600],
      [172, 600],
      [172, 672],
      [100, 672]
    ]) {
      await clickAt(page, x, y)
    }
    const close = await at(page, 100.5, 600.5)
    await page.mouse.move(close.x, close.y, { steps: 2 })
    await expect(page.locator('.fc-stamps-measure-readout')).toHaveText('1 sq ft')
    await page.screenshot({ path: SHOT('area-live') })
    await page.mouse.down()
    await page.mouse.up()
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'Polygon').length).toBe(1)
    const area = (await annots(page)).find((a) => a.type === 'Polygon')!
    expect(area.contents).toBe('1 sq ft')
    expect(area.extra).toMatchObject({ kind: 'area', unit: 'sq ft', value: '1' })

    // A colour picked in the toolbar applies to the next measurements
    await page.locator('.shell-tooloptions').getByRole('button', { name: 'Measurement colour' }).click()
    const colours = page.getByRole('dialog', { name: 'Measurement colour' })
    await expect(colours).toBeVisible()
    await page.screenshot({ path: SHOT('colour') })
    await colours.getByTitle('#2196F3').click()
    await expect(colours).toBeHidden()

    // Perimeter with the toolbar switch, finished by double-click
    await page.locator('.shell-tooloptions').getByRole('radio', { name: /Perimeter/ }).click()
    expect(await toolId(page)).toBe('measure.perimeter')
    await clickAt(page, 300, 600)
    await clickAt(page, 372, 600)
    const end = await at(page, 372, 672)
    await page.mouse.dblclick(end.x, end.y)
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'PolyLine').length).toBe(1)
    const perim = (await annots(page)).find((a) => a.type === 'PolyLine')!
    expect(perim.contents).toBe('2 ft')
    expect(perim.color).toBe('#2196f3')
    await page.mouse.move(10, 10)
    await page.waitForTimeout(400)
    await page.screenshot({ path: SHOT('measured') })

    // Esc cancels a measurement in progress (and does not leave the tool)
    await clickAt(page, 300, 700)
    await expect(page.locator('.fc-stamps-measure-measure-layer circle')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page.locator('.fc-stamps-measure-measure-layer circle')).toHaveCount(0)
    expect(await toolId(page)).toBe('measure.perimeter')

    // Undo/redo
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'PolyLine').length).toBe(0)
    await page.keyboard.press('Control+Shift+z')
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'PolyLine').length).toBe(1)

    // Another zoom level: measuring still maps to the right page points
    await page.locator('.shell-tooloptions').getByRole('radio', { name: /Distance/ }).click()
    await setZoom(page, 1.5)
    await reveal(page, [280, 640, 400, 760])
    await clickAt(page, 300, 720)
    await clickAt(page, 300 + 72, 720)
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'Line').length).toBe(2)
    const second = (await annots(page)).filter((a) => a.type === 'Line').find((a) => a.id !== line.id)!
    expect(second.contents).toBe('1 ft')
    await page.waitForTimeout(400)
    await page.screenshot({ path: SHOT('zoom150') })

    // Rotated view: a line drawn down the page (across the screen) is still 144 pt -> 2 ft
    await setZoom(page, 0.75)
    await setViewRotation(page, 90)
    const r1 = await atRotated90(page, 480, 600)
    const r2 = await atRotated90(page, 480, 744)
    await page.mouse.click(r1.x, r1.y)
    await page.mouse.move(r2.x, r2.y, { steps: 4 })
    await expect(page.locator('.fc-stamps-measure-readout')).toHaveText('2 ft')
    await page.screenshot({ path: SHOT('rotated-live') })
    await page.mouse.click(r2.x, r2.y)
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'Line').length).toBe(3)
    const rotated = (await annots(page)).find((a) => a.type === 'Line' && a.contents === '2 ft' && a.id !== line.id)! as Annot & {
      line: [[number, number], [number, number]]
    }
    expect(rotated).toBeTruthy()
    const xs = rotated.line.map((p) => p[0])
    const ys = rotated.line.map((p) => p[1]).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(480, 0)
    expect(xs[1]).toBeCloseTo(480, 0)
    expect(ys[0]).toBeCloseTo(600, 0)
    expect(ys[1]).toBeCloseTo(744, 0)
    await page.waitForTimeout(300)
    await page.screenshot({ path: SHOT('rotated-measured') })
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'Line').length).toBe(2)
    await setViewRotation(page, 0)

    // Tools > Measure > Set Scale Ratio… opens the same scale settings in a dialog
    // not awaited: the command resolves when its dialog closes
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('measure.setScale'))
    const scaleDialog = page.locator('.fc-stamps-measure-scale-dialog')
    await expect(scaleDialog).toBeVisible()
    await expect(scaleDialog).toContainText('Now: 1 in = 1 ft')
    await scaleDialog.getByLabel('Common scales').selectOption({ label: '1/4 in = 1 ft' })
    await expect(scaleDialog).toContainText('Now: 0.25 in = 1 ft')
    await page.waitForTimeout(300) // let the dialog finish fading in
    await page.screenshot({ path: SHOT('scale-dialog') })
    await scaleDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(scaleDialog).toBeHidden()
    await expect(page.getByRole('button', { name: 'Scale: 1 in = 1 ft' })).toBeVisible()

    // Calibrate: a 2 in line that is really 10 ft -> 1 in = 5 ft
    await page.getByRole('button', { name: 'Calibrate…' }).click()
    await expect(page.getByRole('button', { name: 'Draw over a known length…' })).toBeVisible()
    expect(await toolId(page)).toBe('measure.distance')
    await clickAt(page, 300, 740)
    await clickAt(page, 444, 740)
    const calib = page.locator('.ui-dialog', { hasText: 'Calibrate scale' })
    await expect(calib).toContainText('2 in long on the page')
    await calib.getByLabel('Real length', { exact: true }).fill('10')
    await calib.getByLabel('Real length unit').selectOption('ft')
    await page.waitForTimeout(300) // let the dialog finish fading in
    await page.screenshot({ path: SHOT('calibrate-dialog') })
    await calib.getByRole('button', { name: 'Set scale' }).click()
    await expect(calib).toBeHidden()
    await expect(page.getByRole('button', { name: 'Scale: 1 in = 5 ft' })).toBeVisible()
    expect((await annots(page)).filter((a) => a.type === 'Line').length).toBe(2) // calibrating adds nothing

    // Existing measurements keep their scale until you apply the new one
    await page.getByRole('button', { name: 'Apply to 4 on this page' }).click()
    await expect.poll(async () => (await annots(page)).find((a) => a.id === line.id)?.contents).toBe('10 ft')
    await expect.poll(async () => (await annots(page)).find((a) => a.type === 'Polygon')?.contents).toBe('25 sq ft')

    // Export to a spreadsheet (CSV)
    const csvPath = join(tmpdir(), `fc-measure-${Date.now()}.csv`)
    await app.evaluate(({ ipcMain }, p) => {
      ipcMain.removeHandler('file:saveDialog')
      ipcMain.handle('file:saveDialog', () => p)
    }, csvPath)
    await page.getByRole('button', { name: 'Export to spreadsheet…' }).click()
    await expect.poll(() => existsSync(csvPath)).toBe(true)
    const csv = readFileSync(csvPath, 'utf8')
    expect(csv).toContain('Page,Type,Value,Unit,Label,Scale,Author,Date,Comment')
    expect(csv).toContain('1,Distance,10,ft,10 ft,1 in = 5 ft')
    expect(csv).toContain('1,Area,25,sq ft,25 sq ft,1 in = 5 ft')
    await page.waitForTimeout(300)
    await page.screenshot({ path: SHOT('calibrated') })

    // A measurement stays on one page: passing over the next page keeps its points, and clicking
    // there finishes it and starts a new one on that page.
    await page.locator('.shell-tooloptions').getByRole('radio', { name: /Perimeter/ }).click()
    await reveal(page, [250, 700, 450, 792])
    const polylines = (await annots(page)).filter((a) => a.type === 'PolyLine').length
    await clickAt(page, 300, 745)
    await clickAt(page, 372, 745)
    const page0Points = page.locator('.viewer-page[data-page-index="0"] .fc-stamps-measure-measure-layer circle')
    const page1Points = page.locator('.viewer-page[data-page-index="1"] .fc-stamps-measure-measure-layer circle')
    await expect(page0Points).toHaveCount(2)
    const over = await at(page, 336, 30, 1)
    await page.mouse.move(over.x, over.y, { steps: 6 })
    await expect(page0Points).toHaveCount(2)
    await clickAt(page, 336, 30, 1)
    await expect.poll(async () => (await annots(page)).filter((a) => a.type === 'PolyLine').length).toBe(polylines + 1)
    await expect(page0Points).toHaveCount(0)
    await expect(page1Points).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(page1Points).toHaveCount(0)
    expect((await annots(page, 1)).length).toBe(0)

    // Dark theme panel
    await page.evaluate(() => {
      const { useApp } = (window as any).__fartcrobat
      useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } }))
    })
    await page.waitForTimeout(400)
    await page.screenshot({ path: SHOT('measure-dark') })
  } finally {
    await app.close()
  }
})
