import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync } from 'node:fs'
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
  rotation: number
}

/** Native file dialogs answer with the next queued paths. */
async function queueOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: p })
  }, paths)
}

async function queueSaveDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, path)
}

async function images(page: Page, p = 0): Promise<Img[]> {
  return page.evaluate((pg) => (window as any).__fartcrobat.getActiveDoc().ops('edit-images-links').images(pg), p)
}

async function navLinks(page: Page, p = 0): Promise<{ rect: Rect; uri: string; dest: { page: number } | null }[]> {
  return page.evaluate((pg) => (window as any).__fartcrobat.getActiveDoc().core.nav.links(pg), p)
}

async function setTool(page: Page, id: string) {
  await page.evaluate((t) => (window as any).__fartcrobat.useApp.setState({ toolId: t }), id)
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

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8)
  await page.mouse.up()
}

test('edit images and links', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, FIX('images.pdf'))
    await waitForRender(page)
    await runCommand(page, 'view.fitWidth')
    await expect.poll(async () => (await activeDocState(page))?.zoomMode).toBe('fit-width')
    await page.waitForTimeout(300)

    // "Edit text & images" belongs to edit-text; register a stand-in tool when it is not built in.
    await page.evaluate(() => {
      const reg = (window as any).__fartcrobat.registry
      if (!reg.tools.has('edit.content'))
        reg.tools.set('edit.content', { id: 'edit.content', label: 'Edit text & images', icon: () => null, layer: () => null })
    })
    await setTool(page, 'edit.content')
    await expect(page.locator('.viewer-page[data-page-index="0"] .fc-edit-images-links-hit')).toHaveCount(2)
    await waitForRender(page)
    await shot(page, '1-edit-mode')

    // ---- select the chart and drag it 100px to the right ----------------------------------
    const before = await images(page)
    const [chart, photo] = before
    const c = await clientRect(page, chart.visible)
    await page.mouse.click(c.x + c.w / 2, c.y + c.h / 2)
    const frame = page.locator('.fc-edit-images-links-frame')
    await expect(frame).toBeVisible()
    const fb = (await frame.boundingBox())!
    expect(Math.abs(fb.x - c.x)).toBeLessThan(2)
    expect(Math.abs(fb.width - c.w)).toBeLessThan(2)
    await expect(page.getByRole('toolbar', { name: 'Image tools' })).toBeVisible()
    await shot(page, '2-selected')

    await page.mouse.move(c.x + c.w / 2, c.y + c.h / 2)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) await page.mouse.move(c.x + c.w / 2 + i * 10, c.y + c.h / 2)
    await shot(page, '3-dragging')
    await page.mouse.up()
    await expect.poll(async () => (await images(page))[0].bbox[0]).toBeCloseTo(chart.bbox[0] + 100 / c.scale, 0)
    const afterMove = await images(page)
    expect(afterMove[0].bbox[1]).toBeCloseTo(chart.bbox[1], 0)
    expect(afterMove[1].bbox).toEqual(photo.bbox)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Move Image')
    expect((await activeDocState(page))?.dirty).toBe(true)
    await page.waitForTimeout(400)
    await shot(page, '4-moved')

    // the selection frame follows the moved image
    const moved = afterMove[0]
    const mc = await clientRect(page, moved.visible)
    await expect.poll(async () => Math.round((await frame.boundingBox())!.x)).toBe(Math.round(mc.x))

    // ---- rotate with the toolbar, then undo with the keyboard -----------------------------
    await page.getByRole('button', { name: 'Rotate clockwise' }).click()
    await expect.poll(async () => (await images(page))[0].rotation).toBe(90)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await images(page))[0].rotation).toBe(0)

    // ---- arrow keys nudge the selected image ----------------------------------------------
    const m2 = (await images(page))[0]
    await page.mouse.click(mc.x + mc.w / 2, mc.y + mc.h / 2)
    await expect(frame).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(async () => (await images(page))[0].bbox[1]).toBeCloseTo(m2.bbox[1] + 11, 1)

    // ---- replace the image ----------------------------------------------------------------
    await queueOpenDialog(app, [FIX('replacement.png')])
    await page.getByRole('button', { name: 'Replace image' }).click()
    await expect.poll(async () => (await images(page))[0].width).toBe(120)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Replace Image')
    await page.waitForTimeout(400)
    await shot(page, '5-replaced')

    // ---- right-click menu ------------------------------------------------------------------
    const r = (await images(page))[0]
    const rc = await clientRect(page, r.visible)
    await page.mouse.click(rc.x + rc.w / 2, rc.y + rc.h / 2, { button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Save Image As…' })).toBeVisible()
    await shot(page, '6-context-menu')
    const out = join(mkdtempSync(join(tmpdir(), 'fc-eil-')), 'extracted.png')
    await queueSaveDialog(app, out)
    await page.getByRole('menuitem', { name: 'Save Image As…' }).click()
    await expect.poll(() => existsSync(out)).toBe(true)

    // ---- crop the photo with the crop handles ---------------------------------------------
    const ph = (await images(page))[1]
    const pc = await clientRect(page, ph.visible)
    await page.mouse.click(pc.x + pc.w / 2, pc.y + pc.h / 2)
    await page.getByRole('button', { name: 'Crop image' }).click()
    const cropBox = page.locator('.fc-edit-images-links-crop')
    await expect(cropBox).toBeVisible()
    const east = cropBox.locator('.fc-edit-images-links-handle').nth(3)
    const eb = (await east.boundingBox())!
    await drag(page, { x: eb.x + eb.width / 2, y: eb.y + eb.height / 2 }, { x: eb.x + eb.width / 2 - 60, y: eb.y + eb.height / 2 })
    await shot(page, '7-cropping')
    await page.keyboard.press('Enter')
    await expect.poll(async () => {
      const v = (await images(page))[1].visible
      return Math.round(v[2] - v[0])
    }).toBe(Math.round(ph.visible[2] - ph.visible[0] - 60 / pc.scale))

    // ---- add an image: click to place at natural size --------------------------------------
    await queueOpenDialog(app, [FIX('stamp.jpg')])
    await runCommand(page, 'edit.image.add')
    await expect.poll(async () => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('edit.addImage')
    const place = await clientRect(page, [400, 130, 464, 194])
    await page.mouse.move(place.x + 5, place.y + 5)
    await page.mouse.move(place.x, place.y)
    await expect(page.locator('.fc-edit-images-links-ghost')).toBeVisible()
    await shot(page, '8-add-image-ghost')
    await page.mouse.click(place.x, place.y)
    await expect.poll(async () => (await images(page)).length).toBe(3)
    const added = (await images(page))[2]
    expect(added.bbox[0]).toBeCloseTo(400, 0)
    expect(added.bbox[1]).toBeCloseTo(130, 0)
    expect(added.bbox[2] - added.bbox[0]).toBeCloseTo(64, 0)
    expect(await page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('edit.content')
    expect((await activeDocState(page))?.selection).toMatchObject({ kind: 'custom', type: 'edit-images-links:image' })
    await page.waitForTimeout(400)
    await shot(page, '9-image-added')

    // delete it with the Delete key
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await images(page)).length).toBe(2)

    // ---- the selection frame stays aligned at another zoom ---------------------------------
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(1.5))
    await expect.poll(async () => (await activeDocState(page))?.zoom).toBeCloseTo(1.5, 2)
    await waitForRender(page)
    const z = (await images(page))[0]
    const zc = await clientRect(page, z.visible)
    await page.mouse.click(zc.x + zc.w / 2, zc.y + zc.h / 2)
    await expect(frame).toBeVisible()
    const zb = (await frame.boundingBox())!
    expect(Math.abs(zb.x - zc.x)).toBeLessThan(2)
    expect(Math.abs(zb.y - zc.y)).toBeLessThan(2)
    expect(Math.abs(zb.width - zc.w)).toBeLessThan(2)
    await page.waitForTimeout(300)
    await shot(page, '10-zoom-150')
    await runCommand(page, 'view.fitWidth')
    await expect.poll(async () => (await activeDocState(page))?.zoomMode).toBe('fit-width')
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.goToPage(0))
    await page.waitForTimeout(300)
    await page.keyboard.press('Escape')

    // ---- links: drag a rectangle over a web address ----------------------------------------
    await runCommand(page, 'edit.link.tool')
    await expect.poll(async () => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('edit.link')
    const addr = await textRect(page, 'https://example.com/docs')
    const ac = await clientRect(page, [addr[0] - 1, addr[1] - 1, addr[2] + 1, addr[3] + 1])
    await drag(page, { x: ac.x, y: ac.y }, { x: ac.x + ac.w, y: ac.y + ac.h })
    const dialog = page.locator('.ui-dialog', { has: page.locator('h2', { hasText: 'Create Link' }) })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Web address')).toHaveValue('https://example.com/docs')
    await dialog.getByLabel('Link type').selectOption('visible')
    await expect(dialog.getByLabel('Line thickness')).toBeVisible()
    await shot(page, '11-create-link-dialog')
    await dialog.getByRole('button', { name: 'Create link' }).click()
    await expect.poll(async () => (await navLinks(page)).map((l) => l.uri)).toContain('https://example.com/docs')
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Create Link')
    const webLink = (await navLinks(page)).find((l) => l.uri === 'https://example.com/docs')!
    expect(webLink.rect[0]).toBeCloseTo(addr[0] - 1, 0)

    // a link to page 2
    const cap = await textRect(page, 'Figure 1. Sales by region.')
    const cc = await clientRect(page, cap)
    await drag(page, { x: cc.x, y: cc.y }, { x: cc.x + cc.w, y: cc.y + cc.h })
    await expect(dialog).toBeVisible()
    await dialog.getByRole('radio', { name: 'Go to a page view' }).check()
    await dialog.getByLabel('Page number').fill('2')
    await dialog.getByRole('button', { name: 'Create link' }).click()
    await expect.poll(async () => (await navLinks(page)).filter((l) => l.dest?.page === 1).length).toBe(1)

    // move the web link 20px down by dragging it
    const wl = await clientRect(page, webLink.rect)
    await drag(page, { x: wl.x + wl.w / 2, y: wl.y + wl.h / 2 }, { x: wl.x + wl.w / 2, y: wl.y + wl.h / 2 + 20 })
    await expect.poll(async () => (await navLinks(page)).find((l) => l.uri === 'https://example.com/docs')!.rect[1]).toBeCloseTo(webLink.rect[1] + 20 / wl.scale, 0)
    await page.waitForTimeout(300)
    await shot(page, '12-link-tool')

    // edit it with a double-click, then delete it with the Delete key
    const wl2 = await clientRect(page, (await navLinks(page)).find((l) => l.uri === 'https://example.com/docs')!.rect)
    await page.mouse.dblclick(wl2.x + wl2.w / 2, wl2.y + wl2.h / 2)
    const props = page.locator('.ui-dialog', { has: page.locator('h2', { hasText: 'Link Properties' }) })
    await expect(props).toBeVisible()
    await props.getByLabel('Web address').fill('fartcrobat.org/help')
    await props.getByRole('button', { name: 'Save' }).click()
    await expect.poll(async () => (await navLinks(page)).map((l) => l.uri)).toContain('https://fartcrobat.org/help')
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await navLinks(page)).map((l) => l.uri)).not.toContain('https://fartcrobat.org/help')

    // ---- Create Links from URLs ---------------------------------------------------------------
    await runCommand(page, 'edit.autoLinks')
    const auto = page.locator('.ui-dialog', { has: page.locator('h2', { hasText: 'Create Links from URLs' }) })
    await expect(auto).toBeVisible()
    await auto.getByRole('button', { name: 'Create links' }).click()
    await expect
      .poll(async () => (await navLinks(page)).map((l) => l.uri))
      .toEqual(expect.arrayContaining(['http://www.fartcrobat.org', 'https://example.com/docs', 'mailto:support@example.org']))
    await page.waitForTimeout(300)
    await shot(page, '13-auto-links')

    // ---- dark theme ------------------------------------------------------------------------
    await page.evaluate(() => {
      const useApp = (window as any).__fartcrobat.useApp
      useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } }))
    })
    const any = (await navLinks(page))[0]
    const al = await clientRect(page, any.rect)
    await page.mouse.dblclick(al.x + al.w / 2, al.y + al.h / 2)
    await expect(props).toBeVisible()
    await shot(page, '14-dark-link-properties')
    await props.getByRole('button', { name: 'Cancel' }).click()
    await setTool(page, 'edit.content')
    const d0 = (await images(page))[0]
    const dc = await clientRect(page, d0.visible)
    await page.mouse.click(dc.x + dc.w / 2, dc.y + dc.h / 2)
    await expect(frame).toBeVisible()
    await page.waitForTimeout(300)
    await shot(page, '15-dark-image-selected')
  } finally {
    await app.close()
  }
})
