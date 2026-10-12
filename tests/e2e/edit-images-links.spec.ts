import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

const FIX = (name: string) => fixturePath(`edit-images-links/${name}`)
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/edit-images-links-${name}.png` })

type Rect = [number, number, number, number]
interface Img {
  index: number
  xref: number
  bbox: Rect
  visible: Rect
  width: number
  height: number
  rotation: number
  flipped: boolean
}
interface NavLink {
  rect: Rect
  uri: string
  dest: { page: number; x: number | null; y: number | null; zoom: number | null } | null
}

/** Native file dialogs answer with the given paths. */
async function answerOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: p })
  }, paths)
}

async function answerSaveDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, path)
}

/** Starts a command without waiting for it (commands that open dialogs only finish when they close). */
async function startCommand(page: Page, id: string) {
  await page.evaluate((c) => {
    void (window as any).__fartcrobat.runCommand(c)
  }, id)
}

const images = (page: Page, p = 0): Promise<Img[]> =>
  page.evaluate((pg) => (window as any).__fartcrobat.getActiveDoc().ops('edit-images-links').images(pg), p)

const navLinks = (page: Page, p = 0): Promise<NavLink[]> =>
  page.evaluate((pg) => (window as any).__fartcrobat.getActiveDoc().core.nav.links(pg), p)

const toolId = (page: Page): Promise<string> => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)

async function setTool(page: Page, id: string) {
  await page.evaluate((t) => (window as any).__fartcrobat.useApp.setState({ toolId: t }), id)
}

/** "Edit text & images" belongs to edit-text; register a stand-in tool when that feature is not built in. */
async function enterEditMode(page: Page) {
  await page.evaluate(() => {
    const reg = (window as any).__fartcrobat.registry
    if (!reg.tools.has('edit.content'))
      reg.tools.set('edit.content', { id: 'edit.content', label: 'Edit text & images', icon: () => null, layer: () => null })
  })
  await setTool(page, 'edit.content')
}

/** Client coordinates of a page-space rectangle on page `p` (no view rotation). */
async function clientRect(page: Page, r: Rect, p = 0) {
  return page.evaluate(
    ({ r, p }) => {
      const doc = (window as any).__fartcrobat.getActiveDoc()
      const el = document.querySelector(`.viewer-page[data-page-index="${p}"]`)!.getBoundingClientRect()
      const s = (doc.state.zoom * 96) / 72
      return { x: el.left + r[0] * s, y: el.top + r[1] * s, w: (r[2] - r[0]) * s, h: (r[3] - r[1]) * s, scale: s }
    },
    { r, p }
  )
}

const center = (c: { x: number; y: number; w: number; h: number }) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 })

async function textRect(page: Page, needle: string, p = 0): Promise<Rect> {
  return page.evaluate(
    ({ needle, p }) =>
      (window as any).__fartcrobat
        .getActiveDoc()
        .pageText(p)
        .then((t: any) => {
          const i = t.text.indexOf(needle)
          const xs: number[] = []
          const ys: number[] = []
          for (let k = i; k < i + needle.length; k++) {
            for (let j = 0; j < 4; j++) {
              xs.push(t.quads[k * 8 + j * 2])
              ys.push(t.quads[k * 8 + j * 2 + 1])
            }
          }
          return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
        }),
    { needle, p }
  )
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 8) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
  await page.mouse.up()
}

async function openFixture(page: Page) {
  await openFile(page, FIX('images.pdf'))
  await waitForRender(page)
  await runCommand(page, 'view.fitWidth')
  await expect.poll(async () => (await activeDocState(page))?.zoomMode).toBe('fit-width')
  await page.waitForTimeout(300)
}

const dialogNamed = (page: Page, title: string) => page.locator('.ui-dialog', { has: page.locator('h2', { hasText: title }) })

test('edit images: select, move, resize, rotate, nudge, replace, crop, arrange, save, delete', async () => {
  const { app, page } = await launch()
  try {
    await openFixture(page)
    await enterEditMode(page)
    const hits = page.locator('.viewer-page[data-page-index="0"] .fc-edit-images-links-hit')
    await expect(hits).toHaveCount(2)
    await shot(page, '01-edit-mode')

    // ---- click the chart to select it ------------------------------------------------------
    const [chart, photo] = await images(page)
    const c = await clientRect(page, chart.visible)
    await page.mouse.click(center(c).x, center(c).y)
    const frame = page.locator('.fc-edit-images-links-frame')
    await expect(frame).toBeVisible()
    const fb = (await frame.boundingBox())!
    expect(Math.abs(fb.x - c.x)).toBeLessThan(2)
    expect(Math.abs(fb.y - c.y)).toBeLessThan(2)
    expect(Math.abs(fb.width - c.w)).toBeLessThan(2)
    expect((await activeDocState(page))?.selection).toMatchObject({ kind: 'custom', type: 'edit-images-links:image', page: 0 })
    await expect(page.getByRole('toolbar', { name: 'Image tools' })).toBeVisible()
    await shot(page, '02-selected')

    // ---- drag it 100px to the right -----------------------------------------------------------
    await page.mouse.move(center(c).x, center(c).y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(center(c).x + i * 10, center(c).y)
    await expect(page.locator('.fc-edit-images-links-preview')).toBeVisible()
    await shot(page, '03-dragging')
    await page.mouse.up()
    await expect.poll(async () => (await images(page))[0].bbox[0]).toBeCloseTo(chart.bbox[0] + 100 / c.scale, 0)
    const afterMove = await images(page)
    expect(afterMove[0].bbox[1]).toBeCloseTo(chart.bbox[1], 1)
    expect(afterMove[1].bbox).toEqual(photo.bbox)
    const st = await activeDocState(page)
    expect(st?.journal.undoLabel).toBe('Move Image')
    expect(st?.dirty).toBe(true)
    // the selection frame follows the moved image
    const mc = await clientRect(page, afterMove[0].visible)
    await expect.poll(async () => Math.round((await frame.boundingBox())!.x)).toBe(Math.round(mc.x))
    await page.waitForTimeout(300)
    await shot(page, '04-moved')

    // ---- resize from the bottom-right corner (keeps proportions) ------------------------------
    const se = (await frame.locator('.fc-edit-images-links-handle-se').boundingBox())!
    const w0 = afterMove[0].bbox[2] - afterMove[0].bbox[0]
    const h0 = afterMove[0].bbox[3] - afterMove[0].bbox[1]
    await drag(page, { x: se.x + se.width / 2, y: se.y + se.height / 2 }, { x: se.x + se.width / 2 - 60, y: se.y + se.height / 2 - (60 * h0) / w0 })
    await expect.poll(async () => (await activeDocState(page))?.journal.undoLabel).toBe('Resize Image')
    const resized = (await images(page))[0]
    expect(resized.bbox[2] - resized.bbox[0]).toBeCloseTo(w0 - 60 / c.scale, 0)
    expect((resized.bbox[2] - resized.bbox[0]) / (resized.bbox[3] - resized.bbox[1])).toBeCloseTo(w0 / h0, 1)
    expect(resized.bbox[0]).toBeCloseTo(afterMove[0].bbox[0], 1)
    expect(resized.bbox[1]).toBeCloseTo(afterMove[0].bbox[1], 1)

    // ---- rotate with the toolbar, then undo with the keyboard --------------------------------
    await page.getByRole('button', { name: 'Rotate clockwise' }).click()
    await expect.poll(async () => (await images(page))[0].rotation).toBe(90)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Rotate Image')
    await page.waitForTimeout(300)
    await shot(page, '05-rotated')
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await images(page))[0].rotation).toBe(0)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await images(page))[0].bbox).toEqual(afterMove[0].bbox)

    // ---- arrow keys nudge the selected image; Escape deselects it ----------------------------
    const m2 = (await images(page))[0]
    const m2c = await clientRect(page, m2.visible)
    await page.mouse.click(center(m2c).x, center(m2c).y)
    await expect(frame).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(async () => (await images(page))[0].bbox[1]).toBeCloseTo(m2.bbox[1] + 11, 1)
    expect((await activeDocState(page))?.currentPage).toBe(0)
    await page.keyboard.press('Escape')
    await expect(frame).toHaveCount(0)
    expect(await toolId(page)).toBe('edit.content')

    // ---- keyboard: Tab to an image, Enter selects it, Tab reaches the toolbar ------------------
    await hits.first().focus()
    await page.keyboard.press('Enter')
    await expect(frame).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(page.getByRole('button', { name: 'Rotate counterclockwise' })).toBeFocused()

    // ---- Position and Size dialog from the right-click menu -----------------------------------
    const m3 = (await images(page))[0]
    const m3c = await clientRect(page, m3.visible)
    await page.mouse.click(center(m3c).x, center(m3c).y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Position and Size…' }).click()
    const sizeDialog = dialogNamed(page, 'Position and Size')
    await expect(sizeDialog).toBeVisible()
    // sizes are shown in the units chosen in Preferences (inches by default)
    await expect(sizeDialog.getByLabel('Width')).toHaveValue('2.78')
    await sizeDialog.getByLabel('Width').fill('2')
    await expect(sizeDialog.getByLabel('Height')).toHaveValue('1.2')
    await page.waitForTimeout(250)
    await shot(page, '06-position-size')
    await sizeDialog.getByRole('button', { name: 'Apply' }).click()
    await expect.poll(async () => (await activeDocState(page))?.journal.undoLabel).toBe('Resize Image')
    const sized = (await images(page))[0]
    expect(sized.bbox[2] - sized.bbox[0]).toBeCloseTo(144, 1)
    expect(sized.bbox[3] - sized.bbox[1]).toBeCloseTo(86.4, 1)
    // the untouched position is kept exactly
    expect(sized.bbox[0]).toBeCloseTo(m3.bbox[0], 2)
    expect(sized.bbox[1]).toBeCloseTo(m3.bbox[1], 2)

    // ---- replace the image --------------------------------------------------------------------
    await answerOpenDialog(app, [FIX('replacement.png')])
    await page.getByRole('button', { name: 'Replace image' }).click()
    await expect.poll(async () => (await images(page))[0].width).toBe(120)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Replace Image')
    await page.waitForTimeout(300)
    await shot(page, '07-replaced')

    // ---- right-click menu: Save Image As… ------------------------------------------------------
    const r = (await images(page))[0]
    const rc = await clientRect(page, r.visible)
    await page.mouse.click(center(rc).x, center(rc).y, { button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Save Image As…' })).toBeVisible()
    await page.getByRole('menuitem', { name: 'Arrange' }).hover()
    await expect(page.getByRole('menuitem', { name: 'Send to Back' })).toBeVisible()
    await shot(page, '08-context-menu')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'Save Image As…' })).toHaveCount(0)
    // Escape closed only the menu: the image stays selected
    await expect(frame).toBeVisible()
    const out = join(mkdtempSync(join(tmpdir(), 'fc-eil-')), 'extracted.png')
    await answerSaveDialog(app, out)
    await page.mouse.click(center(rc).x, center(rc).y, { button: 'right' })
    await page.getByRole('menuitem', { name: 'Save Image As…' }).click()
    await expect.poll(() => existsSync(out) && statSync(out).size > 100).toBe(true)

    // ---- crop the photo with the crop handles ----------------------------------------------------
    const ph = (await images(page))[1]
    const pc = await clientRect(page, ph.visible)
    await page.mouse.click(center(pc).x, center(pc).y)
    await page.getByRole('button', { name: 'Crop image' }).click()
    const cropBox = page.locator('.fc-edit-images-links-crop')
    await expect(cropBox).toBeVisible()
    const east = cropBox.locator('.fc-edit-images-links-handle-e')
    const eb = (await east.boundingBox())!
    await drag(page, { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2 }, { x: eb.x + eb.width / 2 - 60, y: eb.y + eb.height / 2 })
    await shot(page, '09-cropping')
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => {
        const v = (await images(page))[1].visible
        return Math.round(v[2] - v[0])
      })
      .toBe(Math.round(ph.visible[2] - ph.visible[0] - 60 / pc.scale))
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Crop Image')

    // ---- arrange: send the photo behind the replaced image, with the keyboard shortcut ---------
    await page.keyboard.press('Control+Shift+BracketLeft')
    await expect.poll(async () => (await activeDocState(page))?.journal.undoLabel).toBe('Send to Back')
    expect((await images(page))[0].xref).toBe(ph.xref)

    // ---- flip from the Edit menu command, delete with the Delete key -----------------------------
    await runCommand(page, 'edit.image.flipH')
    await expect.poll(async () => (await images(page)).find((i) => i.xref === ph.xref)?.flipped).toBe(true)
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await images(page)).length).toBe(1)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Delete Image')
    await expect(frame).toHaveCount(0)

    // ---- the selection frame stays aligned at another zoom ----------------------------------------
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(1.5))
    await expect.poll(async () => (await activeDocState(page))?.zoom).toBeCloseTo(1.5, 2)
    await waitForRender(page)
    const z = (await images(page))[0]
    await page.evaluate((v) => (window as any).__fartcrobat.getActiveDoc().view.scrollToRect(0, v, { center: true }), z.visible)
    await page.waitForTimeout(300)
    const zc = await clientRect(page, z.visible)
    await page.mouse.click(center(zc).x, center(zc).y)
    await expect(frame).toBeVisible()
    const zb = (await frame.boundingBox())!
    expect(Math.abs(zb.x - zc.x)).toBeLessThan(2)
    expect(Math.abs(zb.y - zc.y)).toBeLessThan(2)
    expect(Math.abs(zb.width - zc.w)).toBeLessThan(2)
    await page.waitForTimeout(300)
    await shot(page, '10-zoom-150')

    // ---- rotated view: dragging down on screen moves the image along the page's x axis ------------
    await page.keyboard.press('Escape')
    await expect(frame).toHaveCount(0)
    await runCommand(page, 'view.fitPage')
    await runCommand(page, 'view.rotateCW')
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.goToPage(0))
    await page.waitForTimeout(500)
    await waitForRender(page)
    const before = (await images(page))[0]
    await page.locator('.viewer-page[data-page-index="0"] .fc-edit-images-links-hit').first().click()
    await expect(frame).toBeVisible()
    const rb = (await frame.boundingBox())!
    // the frame is turned with the page: the image's width is now vertical on screen
    const scale = await page.evaluate(() => ((window as any).__fartcrobat.getActiveDoc().state.zoom * 96) / 72)
    expect(rb.height).toBeCloseTo((before.visible[2] - before.visible[0]) * scale, 0)
    await drag(page, { x: rb.x + rb.width / 2, y: rb.y + rb.height / 2 }, { x: rb.x + rb.width / 2, y: rb.y + rb.height / 2 + 40 })
    await expect.poll(async () => (await images(page))[0].bbox[0]).toBeCloseTo(before.bbox[0] + 40 / scale, 0)
    expect((await images(page))[0].bbox[1]).toBeCloseTo(before.bbox[1], 0)
    await page.waitForTimeout(300)
    await shot(page, '11-rotated-view')
  } finally {
    await app.close()
  }
})

test('add image: click to place at natural size, drag to fill an area', async () => {
  const { app, page } = await launch()
  try {
    await openFixture(page)
    await enterEditMode(page)
    await expect(page.locator('.viewer-page[data-page-index="0"] .fc-edit-images-links-hit')).toHaveCount(2)

    // ---- click to place at natural size (64 px at 72 dpi = 64 pt) -------------------------------
    await answerOpenDialog(app, [FIX('stamp.jpg')])
    await startCommand(page, 'edit.image.add')
    await expect.poll(() => toolId(page)).toBe('edit.addImage')
    await expect(page.getByText('stamp.jpg')).toBeVisible()
    const place = await clientRect(page, [400, 130, 464, 194])
    await page.mouse.move(place.x + 5, place.y + 5)
    await page.mouse.move(place.x, place.y)
    await expect(page.locator('.fc-edit-images-links-ghost')).toBeVisible()
    await shot(page, '12-add-image-ghost')
    await page.mouse.click(place.x, place.y)
    await expect.poll(async () => (await images(page)).length).toBe(3)
    const added = (await images(page))[2]
    expect(added.bbox[0]).toBeCloseTo(400, 0)
    expect(added.bbox[1]).toBeCloseTo(130, 0)
    expect(added.bbox[2] - added.bbox[0]).toBeCloseTo(64, 0)
    expect(added.bbox[3] - added.bbox[1]).toBeCloseTo(64, 0)
    expect(added.flipped).toBe(false)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Add Image')
    // back in Edit text & images with the new image selected
    expect(await toolId(page)).toBe('edit.content')
    expect((await activeDocState(page))?.selection).toMatchObject({ kind: 'custom', type: 'edit-images-links:image' })
    await page.waitForTimeout(300)
    await shot(page, '13-image-added')

    // ---- drag a rectangle: the image fills it, keeping its proportions ------------------------------
    await answerOpenDialog(app, [FIX('replacement.png')])
    await startCommand(page, 'edit.image.add')
    await expect.poll(() => toolId(page)).toBe('edit.addImage')
    await expect(page.getByText('replacement.png')).toBeVisible()
    const a = await clientRect(page, [300, 450, 460, 530])
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + (a.w * i) / 8, a.y + (a.h * i) / 8)
    await shot(page, '14-add-image-drag')
    await page.mouse.up()
    await expect.poll(async () => (await images(page)).length).toBe(4)
    const drawn = (await images(page))[3]
    expect(drawn.width).toBe(120)
    expect(drawn.bbox[0]).toBeCloseTo(300, 0)
    expect(drawn.bbox[1]).toBeCloseTo(450, 0)
    expect(drawn.bbox[2] - drawn.bbox[0]).toBeCloseTo(160, 0)
    expect(drawn.bbox[3] - drawn.bbox[1]).toBeCloseTo(80, 0)

    // ---- Cancel leaves the tool without adding anything ---------------------------------------------
    await answerOpenDialog(app, [FIX('stamp.jpg')])
    await startCommand(page, 'edit.image.add')
    await expect.poll(() => toolId(page)).toBe('edit.addImage')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect.poll(() => toolId(page)).toBe('edit.content')
    expect((await images(page)).length).toBe(4)

    // ---- a file that is not an image is reported, not added -----------------------------------------
    await answerOpenDialog(app, [FIX('make_fixture.py')])
    await startCommand(page, 'edit.image.add')
    await expect(page.getByText(/not an image/)).toBeVisible()
    await expect.poll(() => toolId(page)).toBe('edit.content')
    expect((await images(page)).length).toBe(4)
  } finally {
    await app.close()
  }
})

test('links: create, go to view, move, resize, edit, delete, create from URLs', async () => {
  const { app, page } = await launch()
  try {
    await openFixture(page)

    // ---- drag a rectangle over a web address --------------------------------------------------------
    await runCommand(page, 'edit.link.tool')
    await expect.poll(() => toolId(page)).toBe('edit.link')
    await expect(page.getByText('Drag a rectangle where the link should be.')).toBeVisible()
    const addr = await textRect(page, 'https://example.com/docs')
    const ac = await clientRect(page, [addr[0] - 1, addr[1] - 1, addr[2] + 1, addr[3] + 1])
    await drag(page, { x: ac.x, y: ac.y }, { x: ac.x + ac.w, y: ac.y + ac.h })
    const create = dialogNamed(page, 'Create Link')
    await expect(create).toBeVisible()
    await expect(create.getByLabel('Web address')).toHaveValue('https://example.com/docs')
    await create.getByLabel('Link type').selectOption('visible')
    await create.getByLabel('Line style').selectOption('dashed')
    await expect(create.getByLabel('Line thickness')).toBeVisible()
    await page.waitForTimeout(250)
    await shot(page, '15-create-link-dialog')
    await create.getByRole('button', { name: 'Create link' }).click()
    await expect.poll(async () => (await navLinks(page)).map((l) => l.uri)).toContain('https://example.com/docs')
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Create Link')
    const webLink = (await navLinks(page)).find((l) => l.uri === 'https://example.com/docs')!
    expect(webLink.rect[0]).toBeCloseTo(addr[0] - 1, 0)
    expect(webLink.rect[1]).toBeCloseTo(addr[1] - 1, 0)

    // ---- a link to a page view chosen by navigating there ("Create Go to View") -------------------
    const cap = await textRect(page, 'Figure 1. Sales by region.')
    const cc = await clientRect(page, cap)
    await drag(page, { x: cc.x, y: cc.y }, { x: cc.x + cc.w, y: cc.y + cc.h })
    await expect(create).toBeVisible()
    await create.getByRole('radio', { name: 'Go to a page view' }).check()
    await create.getByRole('button', { name: 'Choose the view…' }).click()
    const bar = page.getByRole('dialog', { name: 'Create Go to View' })
    await expect(bar).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(1)
    await page.waitForTimeout(400)
    await shot(page, '16-go-to-view')
    await bar.getByRole('button', { name: 'Set Link' }).click()
    await expect(bar).toHaveCount(0)
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.goToPage(0))
    await expect.poll(async () => (await navLinks(page)).filter((l) => l.dest?.page === 1).length).toBe(1)
    const toPage2 = (await navLinks(page)).find((l) => l.dest?.page === 1)!
    expect(toPage2.dest?.zoom).toBeGreaterThan(0)
    await page.waitForTimeout(400)

    // ---- move the web link 20px down by dragging it, then resize it from a handle ---------------
    const wl = await clientRect(page, webLink.rect)
    await drag(page, center(wl), { x: center(wl).x, y: center(wl).y + 20 })
    await expect
      .poll(async () => (await navLinks(page)).find((l) => l.uri === 'https://example.com/docs')!.rect[1])
      .toBeCloseTo(webLink.rect[1] + 20 / wl.scale, 0)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Move Link')
    const linkBox = page.locator('.fc-edit-images-links-link.is-selected')
    await expect(linkBox).toBeVisible()
    const e = (await linkBox.locator('.fc-edit-images-links-handle').nth(3).boundingBox())!
    await drag(page, { x: e.x + e.width / 2, y: e.y + e.height / 2 }, { x: e.x + e.width / 2 + 30, y: e.y + e.height / 2 })
    await expect
      .poll(async () => {
        const l = (await navLinks(page)).find((x) => x.uri === 'https://example.com/docs')!
        return Math.round((l.rect[2] - l.rect[0]) * wl.scale)
      })
      .toBe(Math.round(wl.w + 30))
    await page.waitForTimeout(300)
    await shot(page, '17-link-tool')

    // ---- arrow keys move the selected link ------------------------------------------------------------
    const y0 = (await navLinks(page)).find((l) => l.uri === 'https://example.com/docs')!.rect[1]
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(async () => (await navLinks(page)).find((l) => l.uri === 'https://example.com/docs')!.rect[1]).toBeCloseTo(y0 + 10, 1)

    // ---- double-click to edit, then delete with the Delete key ---------------------------------------
    const wl2 = await clientRect(page, (await navLinks(page)).find((l) => l.uri === 'https://example.com/docs')!.rect)
    await page.mouse.dblclick(center(wl2).x, center(wl2).y)
    const props = dialogNamed(page, 'Link Properties')
    await expect(props).toBeVisible()
    await expect(props.getByLabel('Line style')).toHaveValue('dashed')
    await props.getByLabel('Web address').fill('fartcrobat.org/help')
    await props.getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => (await navLinks(page)).map((l) => l.uri)).toContain('https://fartcrobat.org/help')
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Edit Link')
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await navLinks(page)).map((l) => l.uri)).not.toContain('https://fartcrobat.org/help')
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Delete Link')

    // ---- Escape deselects first, then leaves the link tool --------------------------------------------
    const pl = await clientRect(page, toPage2.rect)
    await page.mouse.click(center(pl).x, center(pl).y)
    await expect(linkBox).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(linkBox).toHaveCount(0)
    expect(await toolId(page)).toBe('edit.link')
    await page.keyboard.press('Escape')
    await expect.poll(() => toolId(page)).toBe('select')

    // ---- Create Links from URLs (Tools > Edit PDF) -----------------------------------------------------
    await startCommand(page, 'edit.autoLinks')
    const auto = dialogNamed(page, 'Create Links from URLs')
    await expect(auto).toBeVisible()
    await page.waitForTimeout(250)
    await shot(page, '18-create-links-from-urls')
    await auto.getByRole('button', { name: 'Create links' }).click()
    await expect
      .poll(async () => (await navLinks(page)).map((l) => l.uri))
      .toEqual(expect.arrayContaining(['http://www.fartcrobat.org', 'https://example.com/docs', 'mailto:support@example.org']))
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Create Links from URLs')

    // ---- create a link from selected text (select tool mini toolbar) ------------------------------------
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await navLinks(page)).map((l) => l.uri)).not.toContain('http://www.fartcrobat.org')
    const www = await textRect(page, 'www.fartcrobat.org')
    const wc = await clientRect(page, www)
    await drag(page, { x: wc.x + 1, y: center(wc).y }, { x: wc.x + wc.w - 1, y: center(wc).y })
    await page.locator('button[title="Create link"]').click()
    await expect(create).toBeVisible()
    await expect(create.getByLabel('Web address')).toHaveValue('http://www.fartcrobat.org')
    await create.getByRole('button', { name: 'Create link' }).click()
    await expect.poll(async () => (await navLinks(page)).map((l) => l.uri)).toContain('http://www.fartcrobat.org')

    // ---- visible link borders are drawn in the normal view -----------------------------------------------
    await page.waitForTimeout(300)
    await shot(page, '19-links-normal-view')

    // ---- Remove All Links ----------------------------------------------------------------------------------
    await startCommand(page, 'edit.removeAllLinks')
    const remove = dialogNamed(page, 'Remove All Links')
    await expect(remove).toBeVisible()
    await remove.getByRole('radio', { name: 'Current page (1)' }).check()
    await remove.getByRole('button', { name: 'Remove links' }).click()
    await expect.poll(async () => (await navLinks(page)).length).toBe(0)
    expect((await navLinks(page, 1)).length).toBe(2)

    // ---- dark theme ----------------------------------------------------------------------------------------
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await navLinks(page)).length).toBeGreaterThan(0)
    await page.evaluate(() => {
      const useApp = (window as any).__fartcrobat.useApp
      useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } }))
    })
    await runCommand(page, 'edit.link.tool')
    await expect(page.locator('.viewer-page[data-page-index="0"] .fc-edit-images-links-link')).not.toHaveCount(0)
    const any = (await navLinks(page))[0]
    const al = await clientRect(page, any.rect)
    await page.mouse.dblclick(center(al).x, center(al).y)
    await expect(props).toBeVisible()
    await page.waitForTimeout(250)
    await shot(page, '20-dark-link-properties')
    await props.getByRole('button', { name: 'Cancel' }).click()
    await enterEditMode(page)
    const d0 = (await images(page))[0]
    const dc = await clientRect(page, d0.visible)
    await page.mouse.click(center(dc).x, center(dc).y)
    await expect(page.locator('.fc-edit-images-links-frame')).toBeVisible()
    await page.waitForTimeout(300)
    await shot(page, '21-dark-image-selected')
  } finally {
    await app.close()
  }
})
