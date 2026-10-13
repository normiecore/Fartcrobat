import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

interface Item {
  id: number
  page: number
  kind: string
  rect: [number, number, number, number]
  text: string
  size: number
  color: string
  spacing: number
}

async function items(page: Page, pageIndex = 0): Promise<Item[]> {
  return page.evaluate((p) => (window as any).__fartcrobat.getActiveDoc().ops('fill-sign').list(p), pageIndex)
}

/** Client coordinates of a page-space point. */
async function toClient(page: Page, pageIndex: number, pt: [number, number]): Promise<[number, number]> {
  return page.evaluate(
    ({ i, pt }) => {
      const el = document.querySelector(`.viewer-page[data-page-index="${i}"]`)!
      const r = el.getBoundingClientRect()
      const info = (window as any).__fartcrobat.getActiveDoc().state.info.pages[i]
      const s = r.width / info.width
      return [r.left + pt[0] * s, r.top + pt[1] * s] as [number, number]
    },
    { i: pageIndex, pt }
  )
}

/** Client rect of a page-space rect, with the view rotation applied. */
async function clientRect(page: Page, pageIndex: number, r: [number, number, number, number]) {
  return page.evaluate(
    ({ i, r }) => {
      const doc = (window as any).__fartcrobat.getActiveDoc()
      const el = document.querySelector(`.viewer-page[data-page-index="${i}"]`)!
      const b = el.getBoundingClientRect()
      const info = doc.state.info.pages[i]
      const rot = doc.state.viewRotation
      const s = b.width / (rot % 180 ? info.height : info.width)
      const map = ([x, y]: number[]) => {
        if (rot === 90) return [(info.height - y) * s, x * s]
        if (rot === 180) return [(info.width - x) * s, (info.height - y) * s]
        if (rot === 270) return [y * s, (info.width - x) * s]
        return [x * s, y * s]
      }
      const a = map([r[0], r[1]])
      const c = map([r[2], r[3]])
      return {
        x: b.left + Math.min(a[0], c[0]),
        y: b.top + Math.min(a[1], c[1]),
        width: Math.abs(c[0] - a[0]),
        height: Math.abs(c[1] - a[1])
      }
    },
    { i: pageIndex, r }
  )
}

async function toolId(page: Page): Promise<string> {
  return page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)
}

async function cssPerPoint(page: Page, pageIndex = 0): Promise<number> {
  return page.evaluate((i) => {
    const el = document.querySelector(`.viewer-page[data-page-index="${i}"]`)!
    const info = (window as any).__fartcrobat.getActiveDoc().state.info.pages[i]
    return el.getBoundingClientRect().width / info.width
  }, pageIndex)
}

async function clickAt(page: Page, pageIndex: number, pt: [number, number]) {
  const [x, y] = await toClient(page, pageIndex, pt)
  await page.mouse.click(x, y)
}

async function settle(page: Page, ms = 400) {
  await page.waitForTimeout(ms)
}

test('Fill & Sign: type, tick, sign, move, save and reopen', async () => {
  const { app, page } = await launch()
  const savePath = join(mkdtempSync(join(tmpdir(), 'fartcrobat-fill-sign-')), 'signed.pdf')
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await runCommand(page, 'view.fitPage')
    await settle(page)

    // ---- Add text from the quick toolbar, type, commit ---------------------------------------
    await page.locator('.shell-quicktool[aria-label="Add text"]').click()
    await expect(page.locator('.fc-fill-sign-toolbar')).toBeVisible()
    await clickAt(page, 0, [100, 600])
    const editor = page.locator('.fc-fill-sign-textarea')
    await expect(editor).toBeFocused()
    await page.keyboard.type('Jane Doe')
    await page.screenshot({ path: 'test-results/fill-sign-typing.png' })
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect.poll(async () => (await items(page)).map((i) => [i.kind, i.text])).toEqual([['text', 'Jane Doe']])
    const text = (await items(page))[0]
    expect(text.rect[0]).toBeCloseTo(100, 0)
    expect((text.rect[1] + text.rect[3]) / 2).toBeCloseTo(600, 0)
    expect((await activeDocState(page))?.dirty).toBe(true)
    // clicking and typing is one step: there is never an empty text box in the document
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Add Text')

    // the item is selected: mini toolbar, A+ makes it bigger
    await expect(page.locator('.fc-fill-sign-minibar')).toBeVisible()
    await page.locator('.fc-fill-sign-minibar').getByRole('button', { name: 'Larger text' }).click()
    await expect.poll(async () => (await items(page))[0].size).toBe(13)
    await page.screenshot({ path: 'test-results/fill-sign-text.png' })

    // undo: the size change, then the whole text at once; redo brings both back
    await runCommand(page, 'edit.undo')
    await expect.poll(async () => (await items(page))[0]?.size).toBe(12)
    await runCommand(page, 'edit.undo')
    await expect.poll(async () => (await items(page)).length).toBe(0)
    await runCommand(page, 'edit.redo')
    await runCommand(page, 'edit.redo')
    await expect.poll(async () => (await items(page)).map((i) => [i.text, i.size])).toEqual([['Jane Doe', 13]])

    // ---- Letter spacing from the mini toolbar (for boxed "comb" fields) -----------------------
    const plain = (await items(page))[0]
    await page.locator(`[data-fill-sign-id="${plain.id}"]`).click() // Add text tool: opens it for typing
    await expect(editor).toBeFocused()
    await page.locator('.fc-fill-sign-minibar').getByRole('button', { name: 'Letter spacing' }).click()
    await page.getByRole('menuitem', { name: '4 pt' }).click()
    await expect.poll(async () => (await items(page))[0].spacing).toBe(4)
    const spaced = (await items(page))[0]
    expect(spaced.rect[2] - spaced.rect[0]).toBeGreaterThan(plain.rect[2] - plain.rect[0] + 7 * 4 - 1)
    expect(spaced.text).toBe('Jane Doe')
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Change Letter Spacing')
    await settle(page)
    await page.screenshot({ path: 'test-results/fill-sign-spacing.png' })
    await page.keyboard.press('Escape')

    // clicking elsewhere with Add text and leaving it empty adds nothing
    await clickAt(page, 0, [300, 560])
    await expect(editor).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(editor).toHaveCount(0)
    await expect.poll(async () => (await items(page)).length).toBe(1)

    // ---- Check mark from the Fill & Sign toolbar ---------------------------------------------
    await page.locator('.fc-fill-sign-toolbar').getByRole('button', { name: 'Check mark' }).click()
    const [hx, hy] = await toClient(page, 0, [80, 640])
    await page.mouse.move(hx, hy)
    await expect(page.locator('.fc-fill-sign-ghost')).toBeVisible()
    await page.mouse.click(hx, hy)
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['text', 'check'])
    const check = (await items(page))[1]
    expect((check.rect[0] + check.rect[2]) / 2).toBeCloseTo(80, 0)
    expect((check.rect[1] + check.rect[3]) / 2).toBeCloseTo(640, 0)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Add Check Mark')

    // ---- Create a typed signature and place it -----------------------------------------------
    await page.locator('.shell-quicktool[aria-label="Sign Yourself"]').click()
    const menu = page.getByRole('menu', { name: 'Sign yourself' })
    await expect(menu).toBeVisible()
    await page.screenshot({ path: 'test-results/fill-sign-menu-empty.png' })
    await menu.getByRole('menuitem', { name: 'Add signature' }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('Add signature')
    await dialog.getByLabel('Your name').fill('Jane Doe')
    await dialog.getByRole('radio', { name: 'Great Vibes' }).click()
    await expect(dialog.getByRole('radio', { name: 'Great Vibes' })).toHaveAttribute('aria-checked', 'true')
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'test-results/fill-sign-dialog-type.png' })
    await dialog.getByRole('button', { name: 'Done' }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('fillsign.place')
    const [gx, gy] = await toClient(page, 0, [400, 700])
    await page.mouse.move(gx - 20, gy - 20)
    await page.mouse.move(gx, gy)
    await expect(page.locator('.fc-fill-sign-ghost-signature')).toBeVisible()
    await page.screenshot({ path: 'test-results/fill-sign-placing.png' })
    await page.mouse.click(gx, gy)
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['text', 'check', 'signature'])
    const sig = (await items(page))[2]
    expect(sig.rect[3] - sig.rect[1]).toBeCloseTo(36, 0) // 0.5 in tall
    expect((sig.rect[0] + sig.rect[2]) / 2).toBeCloseTo(400, 0)
    expect((sig.rect[1] + sig.rect[3]) / 2).toBeCloseTo(700, 0)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Add Signature')
    // the tool goes back to the one used before (Check mark), and the new signature is selected
    await expect.poll(async () => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('fillsign.check')
    await expect(page.locator('.fc-fill-sign-frame')).toBeVisible()
    await settle(page)
    await page.screenshot({ path: 'test-results/fill-sign-placed.png' })

    // ---- Move the signature by dragging it ---------------------------------------------------
    const s = await cssPerPoint(page)
    const handle = page.locator(`[data-fill-sign-id="${sig.id}"]`)
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 - 30, { steps: 5 })
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 - 60, { steps: 5 })
    await expect(page.locator('.fc-fill-sign-preview')).toBeVisible()
    await page.screenshot({ path: 'test-results/fill-sign-dragging.png' })
    await page.mouse.up()
    await expect.poll(async () => (await items(page))[2].rect[0]).toBeCloseTo(sig.rect[0] + 80 / s, 0)
    const moved = (await items(page))[2]
    expect(moved.rect[1]).toBeCloseTo(sig.rect[1] - 60 / s, 0)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Move Signature')
    await expect(page.locator('.fc-fill-sign-preview')).toHaveCount(0)

    // resize it with the corner handle (keeps its aspect ratio)
    const corner = (await page.locator('.fc-fill-sign-handle').boundingBox())!
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2)
    await page.mouse.down()
    await page.mouse.move(corner.x + corner.width / 2 + 60, corner.y + corner.height / 2 + 10, { steps: 6 })
    await page.mouse.up()
    await expect.poll(async () => (await items(page))[2].rect[2] - (await items(page))[2].rect[0]).toBeGreaterThan(moved.rect[2] - moved.rect[0] + 20)
    const resized = (await items(page))[2]
    expect((resized.rect[2] - resized.rect[0]) / (resized.rect[3] - resized.rect[1])).toBeCloseTo(
      (moved.rect[2] - moved.rect[0]) / (moved.rect[3] - moved.rect[1]),
      1
    )
    await settle(page)
    await page.screenshot({ path: 'test-results/fill-sign-moved.png' })

    // ---- The Sign menu now shows the saved signature ----------------------------------------
    await page.locator('.shell-quicktool[aria-label="Sign Yourself"]').click()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Place your saved signature' })).toBeVisible()
    await expect(menu.locator('.fc-fill-sign-saved img')).toHaveCount(1)
    await page.screenshot({ path: 'test-results/fill-sign-menu-saved.png' })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    // Esc only closed the menu: the Check mark tool is still on
    expect(await toolId(page)).toBe('fillsign.check')
    const stored = await page.evaluate(() => (window as any).api.invoke('store:get', 'fill-sign:signature'))
    expect(String(stored)).toMatch(/^data:image\/png;base64,/)

    // ---- Keyboard: select the check mark, nudge it, delete it, undo -------------------------
    await page.locator(`[data-fill-sign-id="${check.id}"]`).focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await items(page))[1].rect[0]).toBeCloseTo(check.rect[0] + 1, 1)
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['text', 'signature'])
    await runCommand(page, 'edit.undo')
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['text', 'check', 'signature'])

    // ---- Double-click text to edit it at a different zoom ------------------------------------
    await runCommand(page, 'tools.select')
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(1.5))
    await settle(page, 400)
    const t = (await items(page))[0]
    await page.evaluate((r) => (window as any).__fartcrobat.getActiveDoc().view.scrollToRect(0, r, { center: true }), t.rect)
    await settle(page, 600)
    const [tx, ty] = await toClient(page, 0, [(t.rect[0] + t.rect[2]) / 2, (t.rect[1] + t.rect[3]) / 2])
    await page.mouse.dblclick(tx, ty)
    await expect(editor).toBeFocused()
    await expect(editor).toHaveValue('Jane Doe')
    // the editor sits where the PDF text is, with the same letter spacing
    const eb = (await editor.boundingBox())!
    const [ex] = await toClient(page, 0, [t.rect[0], t.rect[1]])
    expect(Math.abs(eb.x - ex)).toBeLessThan(2)
    const s15 = await cssPerPoint(page)
    expect(parseFloat(await editor.evaluate((el) => getComputedStyle(el).letterSpacing))).toBeCloseTo(4 * s15, 0)
    await page.keyboard.press('End')
    await page.keyboard.type(', Esq.')
    await page.screenshot({ path: 'test-results/fill-sign-zoom-edit.png' })
    await clickAt(page, 0, [t.rect[0] + 200, t.rect[1] - 30]) // click away (select tool) commits
    await expect.poll(async () => (await items(page))[0].text).toBe('Jane Doe, Esq.')
    await settle(page)
    await page.screenshot({ path: 'test-results/fill-sign-zoom.png' })

    // ---- Save through a stubbed Save dialog and reopen in a fresh window ---------------------
    await app.evaluate(({ ipcMain }, path) => {
      ipcMain.removeHandler('file:saveDialog')
      ipcMain.handle('file:saveDialog', () => path)
    }, savePath)
    await runCommand(page, 'file.saveAs')
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)
  } finally {
    await app.close()
  }

  const second = await launch([savePath])
  try {
    await second.page.waitForSelector('.viewer-page canvas')
    await waitForRender(second.page)
    await expect
      .poll(async () => (await items(second.page)).map((i) => [i.kind, i.text]))
      .toEqual([
        ['text', 'Jane Doe, Esq.'],
        ['check', ''],
        ['signature', '']
      ])
    expect((await items(second.page))[0].spacing).toBe(4)
    await second.page.locator('.shell-quicktool[aria-label="Add text"]').click()
    await settle(second.page, 600)
    await second.page.screenshot({ path: 'test-results/fill-sign-reopened.png' })
  } finally {
    await second.app.close()
  }
})

test('Fill & Sign: panel, draw and image signatures, preferences, dark theme', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.evaluate(() => (window as any).__fartcrobat.useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } })))
    // Open Fill & Sign from All tools
    await page.locator('.shell-alltools-item', { hasText: 'Fill & Sign' }).click()
    await expect(page.locator('.ui-panel-header h3', { hasText: 'Fill & Sign' })).toBeVisible()
    await expect.poll(async () => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('fillsign.text')
    await settle(page)
    await page.screenshot({ path: 'test-results/fill-sign-panel-dark.png' })

    // Rounded box and dot from the panel rows
    await page.locator('.ui-tool-row', { hasText: 'Rounded box' }).click()
    await clickAt(page, 0, [200, 200])
    await page.locator('.ui-tool-row', { hasText: 'Dot' }).click()
    await clickAt(page, 0, [120, 200])
    await page.locator('.ui-tool-row', { hasText: 'Date' }).click()
    await clickAt(page, 0, [300, 260])
    await expect(page.locator('.fc-fill-sign-textarea')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['box', 'dot', 'date'])
    expect((await items(page))[2].text).toMatch(/\d/)

    // Convert the dot into a cross mark from the mini toolbar
    const dot = (await items(page))[1]
    await page.locator(`[data-fill-sign-id="${dot.id}"]`).click()
    await page.locator('.fc-fill-sign-minibar').getByRole('button', { name: /Change dot/ }).click()
    await page.getByRole('menuitem', { name: 'Cross Mark' }).click()
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['box', 'date', 'cross'])
    await settle(page)
    await page.screenshot({ path: 'test-results/fill-sign-marks-dark.png' })

    // Custom letter spacing for the date
    const date = (await items(page))[1]
    await page.locator(`[data-fill-sign-id="${date.id}"]`).click() // Date tool: opens it for typing
    await expect(page.locator('.fc-fill-sign-textarea')).toBeFocused()
    await page.locator('.fc-fill-sign-minibar').getByRole('button', { name: 'Letter spacing' }).click()
    await page.getByRole('menuitem', { name: 'Custom…' }).click()
    const spacingDialog = page.getByRole('dialog').filter({ hasText: 'Letter spacing' })
    await spacingDialog.getByRole('textbox').fill('99')
    await expect(spacingDialog.getByRole('button', { name: 'Apply' })).toBeDisabled()
    await spacingDialog.getByRole('textbox').fill('6')
    await spacingDialog.getByRole('button', { name: 'Apply' }).click()
    await expect.poll(async () => (await items(page))[1].spacing).toBe(6)
    expect((await items(page))[1].text).toBe(date.text)

    // ---- Rotated view: overlays follow the rotation ------------------------------------------
    await runCommand(page, 'view.rotateCW')
    await settle(page, 600)
    const cross = (await items(page))[2]
    const crossHit = page.locator(`[data-fill-sign-id="${cross.id}"]`)
    await crossHit.scrollIntoViewIfNeeded()
    await crossHit.click()
    const expected = await clientRect(page, 0, cross.rect)
    const frame = (await page.locator('.fc-fill-sign-frame').boundingBox())!
    expect(frame.x).toBeLessThan(expected.x + 0.5)
    expect(frame.y).toBeLessThan(expected.y + 0.5)
    expect(frame.x + frame.width).toBeGreaterThan(expected.x + expected.width - 0.5)
    expect(frame.y + frame.height).toBeGreaterThan(expected.y + expected.height - 0.5)
    // drag-resize in the rotated view: the cross grows (keeping its shape)
    const rh = (await page.locator('.fc-fill-sign-handle').boundingBox())!
    await page.mouse.move(rh.x + rh.width / 2, rh.y + rh.height / 2)
    await page.mouse.down()
    await page.mouse.move(rh.x + rh.width / 2 - 25, rh.y + rh.height / 2 + 25, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await items(page))[2].size).toBeGreaterThan(cross.size * 1.5)
    const grown = (await items(page))[2]
    expect((grown.rect[2] - grown.rect[0]) / (grown.rect[3] - grown.rect[1])).toBeCloseTo(1, 1)
    // edit the date in place: the editor is turned with the page
    const d2 = (await items(page))[1]
    const dateBox = await clientRect(page, 0, d2.rect)
    await page.mouse.dblclick(dateBox.x + dateBox.width / 2, dateBox.y + dateBox.height / 2)
    await expect(page.locator('.fc-fill-sign-textarea')).toBeFocused()
    const eb = (await page.locator('.fc-fill-sign-textarea').boundingBox())!
    expect(eb.width).toBeLessThan(eb.height) // vertical, like the page
    expect(Math.abs(eb.y - dateBox.y)).toBeLessThan(3)
    await settle(page)
    await page.screenshot({ path: 'test-results/fill-sign-rotated-dark.png' })
    await page.keyboard.press('Escape')
    await runCommand(page, 'view.rotateCCW')
    await settle(page)

    // Draw a signature (initials) in blue
    await page.locator('.fc-fill-sign-bigbtn').click()
    await page.getByRole('menuitem', { name: 'Add initials' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('tab', { name: 'Draw' }).click()
    await dialog.getByRole('radio', { name: 'Blue' }).click()
    const pad = (await dialog.locator('.fc-fill-sign-drawpad').boundingBox())!
    await page.mouse.move(pad.x + 60, pad.y + 140)
    await page.mouse.down()
    for (const [dx, dy] of [
      [90, 60],
      [120, 150],
      [150, 70],
      [190, 150],
      [230, 90]
    ])
      await page.mouse.move(pad.x + dx, pad.y + dy, { steps: 6 })
    await page.mouse.up()
    await page.screenshot({ path: 'test-results/fill-sign-dialog-draw.png' })
    await dialog.getByRole('button', { name: 'Done' }).click()
    await clickAt(page, 0, [450, 300])
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['box', 'date', 'cross', 'initials'])
    const ini = (await items(page))[3]
    expect(ini.rect[3] - ini.rect[1]).toBeCloseTo(30, 0)

    // Image signature from a photo: the paper becomes transparent
    await app.evaluate(({ ipcMain }, path) => {
      ipcMain.removeHandler('file:openDialog')
      ipcMain.handle('file:openDialog', () => [path])
    }, fixturePath('fill-sign/signature-photo.jpg'))
    // (not awaited: the command resolves when the dialog closes)
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('fillsign.addSignature'))
    await dialog.getByRole('tab', { name: 'Image' }).click()
    await dialog.getByRole('button', { name: 'Choose image…' }).click()
    await expect(dialog.locator('.fc-fill-sign-picked')).toBeVisible()
    const alpha = await dialog.locator('.fc-fill-sign-picked').evaluate(async (img: HTMLImageElement) => {
      await img.decode()
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const ctx = c.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      let clear = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] === 0) clear++
      return clear / (d.length / 4)
    })
    expect(alpha).toBeGreaterThan(0.5)
    await page.screenshot({ path: 'test-results/fill-sign-dialog-image.png' })
    await dialog.getByRole('checkbox').uncheck()
    await dialog.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: 'Place in the middle of the page' }).click()
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toContain('signature')
    // not saved because the box was unticked
    expect(await page.evaluate(() => (window as any).api.invoke('store:get', 'fill-sign:signature'))).toBeFalsy()
    expect(String(await page.evaluate(() => (window as any).api.invoke('store:get', 'fill-sign:initials')))).toMatch(/^data:image\/png/)

    // Escape cancels placing
    const before = await toolId(page)
    expect(before).toBe('fillsign.date')
    await runCommand(page, 'fillsign.placeInitials')
    await expect.poll(async () => toolId(page)).toBe('fillsign.place')
    await page.keyboard.press('Escape')
    // back to the tool used before, not the Select tool
    await expect.poll(async () => toolId(page)).toBe(before)
    expect((await items(page)).filter((i) => i.kind === 'initials')).toHaveLength(1)

    // the saved initials in the panel place them directly
    await page.getByRole('button', { name: 'Place your saved initials' }).click()
    await expect.poll(async () => toolId(page)).toBe('fillsign.place')
    await clickAt(page, 0, [480, 520])
    await expect.poll(async () => (await items(page)).filter((i) => i.kind === 'initials')).toHaveLength(2)

    // Preferences > Signatures
    await runCommand(page, 'app.preferences')
    await page.locator('.prefs-nav button', { hasText: 'Signatures' }).click()
    await expect(page.locator('.fc-fill-sign-card')).toHaveCount(2)
    await expect(page.locator('.fc-fill-sign-card').nth(1).locator('img')).toBeVisible()
    await page.screenshot({ path: 'test-results/fill-sign-preferences-dark.png' })
    await page.locator('.fc-fill-sign-card').nth(1).getByRole('button', { name: 'Delete' }).click()
    await expect(page.locator('.fc-fill-sign-card').nth(1).locator('img')).toHaveCount(0)
    expect(await page.evaluate(() => (window as any).api.invoke('store:get', 'fill-sign:initials'))).toBeFalsy()
  } finally {
    await app.close()
  }
})

test('Fill & Sign: printed form, signature field, narrow window', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('fill-sign/agreement.pdf'))
    await waitForRender(page)
    await runCommand(page, 'view.fitPage')
    await settle(page)

    // ---- Type on the "Full name" blank and tick a printed box ---------------------------------
    await page.locator('.shell-quicktool[aria-label="Add text"]').click()
    await clickAt(page, 0, [145, 146])
    await expect(page.locator('.fc-fill-sign-textarea')).toBeFocused()
    await page.keyboard.type('Jane Doe')
    await page.keyboard.press('Tab')
    await expect.poll(async () => (await items(page)).map((i) => i.text)).toEqual(['Jane Doe'])
    await page.locator('.fc-fill-sign-toolbar').getByRole('button', { name: 'Check mark' }).click()
    // the "Wednesday" box is drawn at x 270-281, y 214-225 (page space)
    await clickAt(page, 0, [275.5, 219.5])
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['text', 'check'])
    const tick = (await items(page))[1]
    expect((tick.rect[0] + tick.rect[2]) / 2).toBeCloseTo(275.5, 0)
    expect((tick.rect[1] + tick.rect[3]) / 2).toBeCloseTo(219.5, 0)

    // ---- Click the signature field: no certificate signing here, so "Fill & Sign instead" ----
    const hasForms = await page.evaluate(() => {
      const r = (window as any).__fartcrobat.registry
      return r.features.some((f: any) => f.id === 'forms-fill') && !r.features.some((f: any) => f.id === 'digital-signatures')
    })
    // field rectangle in page space (the PDF has it at 140,410 - 380,460 on a 792pt page)
    const field: [number, number, number, number] = [140, 332, 380, 382]
    if (hasForms) {
      await page.locator('[data-field-name="Signature"]').click()
      await page.getByRole('button', { name: 'Fill & Sign instead' }).click()
      const menu = page.getByRole('menu', { name: 'Sign yourself' })
      await expect(menu).toBeVisible()
      await expect(menu.getByRole('note')).toContainText('signature field you clicked')
      // the menu opens under the Sign yourself button of the Fill & Sign pane
      const big = (await page.locator('.fc-fill-sign-bigbtn').boundingBox())!
      const mb = (await menu.boundingBox())!
      expect(Math.abs(mb.y - (big.y + big.height + 4))).toBeLessThan(3)
      await page.screenshot({ path: 'test-results/fill-sign-field-menu.png' })
      await menu.getByRole('menuitem', { name: 'Add signature' }).click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Your name').fill('Jane Doe')
      await dialog.getByRole('button', { name: 'Done' }).click()
      // no placing step: it goes straight into the field, as large as fits, centred
      await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['text', 'check', 'signature'])
      const sig = (await items(page))[2]
      expect(sig.rect[0]).toBeGreaterThanOrEqual(field[0])
      expect(sig.rect[2]).toBeLessThanOrEqual(field[2])
      expect(sig.rect[1]).toBeGreaterThanOrEqual(field[1])
      expect(sig.rect[3]).toBeLessThanOrEqual(field[3])
      expect((sig.rect[0] + sig.rect[2]) / 2).toBeCloseTo((field[0] + field[2]) / 2, 0)
      expect((sig.rect[1] + sig.rect[3]) / 2).toBeCloseTo((field[1] + field[3]) / 2, 0)
      expect(sig.rect[3] - sig.rect[1]).toBeGreaterThan(36) // fills the field, bigger than a loose signature
      expect((await activeDocState(page))?.journal.undoLabel).toBe('Add Signature')
      await settle(page)
      await page.screenshot({ path: 'test-results/fill-sign-field-signed.png' })

      // the signature stays selectable on top of the field, and Delete removes it
      await page.locator('.fc-fill-sign-bigbtn').focus() // move focus away from the item
      await runCommand(page, 'tools.select')
      const sb = await clientRect(page, 0, sig.rect)
      await page.mouse.click(sb.x + sb.width / 2, sb.y + sb.height / 2)
      await expect.poll(async () => (await activeDocState(page))?.selection).toMatchObject({ kind: 'custom', data: { id: sig.id } })
      await expect(page.locator('.fc-fill-sign-minibar')).toBeVisible()
      await page.keyboard.press('Delete')
      await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['text', 'check'])
    }

    // ---- Placing a signature snaps it into an empty signature field --------------------------
    if (hasForms) {
      await runCommand(page, 'fillsign.placeSignature') // the one saved above
    } else {
      // (not awaited: the command resolves when the dialog closes)
      await page.evaluate(() => void (window as any).__fartcrobat.runCommand('fillsign.addSignature'))
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Your name').fill('Jane Doe')
      await dialog.getByRole('button', { name: 'Done' }).click()
    }
    await expect.poll(async () => toolId(page)).toBe('fillsign.place')
    const fb = await clientRect(page, 0, field)
    await page.mouse.move(fb.x + 12, fb.y + 8)
    await page.mouse.move(fb.x + 20, fb.y + 10)
    const ghost = page.locator('.fc-fill-sign-ghost-signature.is-in-field')
    await expect(ghost).toBeVisible()
    const gb = (await ghost.boundingBox())!
    expect(gb.x).toBeGreaterThanOrEqual(fb.x - 0.5)
    expect(gb.x + gb.width).toBeLessThanOrEqual(fb.x + fb.width + 0.5)
    expect(Math.abs(gb.x + gb.width / 2 - (fb.x + fb.width / 2))).toBeLessThan(1.5)
    await expect(page.locator('.fc-fill-sign-place-field')).toBeVisible()
    await page.screenshot({ path: 'test-results/fill-sign-field-snap.png' })
    await page.mouse.click(fb.x + 20, fb.y + 10)
    await expect.poll(async () => (await items(page)).map((i) => i.kind)).toEqual(['text', 'check', 'signature'])
    const snapped = (await items(page))[2]
    expect((snapped.rect[0] + snapped.rect[2]) / 2).toBeCloseTo((field[0] + field[2]) / 2, 0)
    expect((snapped.rect[1] + snapped.rect[3]) / 2).toBeCloseTo((field[1] + field[3]) / 2, 0)

    // ---- A narrow window: the Fill & Sign bar still fits without scrolling -------------------
    await runCommand(page, 'fillsign.tool.text')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 760))
    await settle(page, 600)
    const fits = await page.locator('.shell-tooloptions').evaluate((el) => el.scrollWidth <= el.clientWidth + 1)
    expect(fits).toBe(true)
    // the Sign yourself button keeps its name when only its icon shows
    await expect(page.locator('.fc-fill-sign-toolbar').getByRole('button', { name: 'Sign yourself' })).toBeVisible()
    await page.screenshot({ path: 'test-results/fill-sign-narrow.png' })
  } finally {
    await app.close()
  }
})
