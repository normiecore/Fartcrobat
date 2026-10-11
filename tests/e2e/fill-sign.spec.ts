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
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Edit Text')

    // the item is selected: mini toolbar, A+ makes it bigger
    await expect(page.locator('.fc-fill-sign-minibar')).toBeVisible()
    await page.locator('.fc-fill-sign-minibar').getByRole('button', { name: 'Larger text' }).click()
    await expect.poll(async () => (await items(page))[0].size).toBe(13)
    await page.screenshot({ path: 'test-results/fill-sign-text.png' })

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
    // the editor sits where the PDF text is
    const eb = (await editor.boundingBox())!
    const [ex] = await toClient(page, 0, [t.rect[0], t.rect[1]])
    expect(Math.abs(eb.x - ex)).toBeLessThan(2)
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
    await runCommand(page, 'fillsign.placeInitials')
    await expect.poll(async () => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('fillsign.place')
    await page.keyboard.press('Escape')
    await expect.poll(async () => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).not.toBe('fillsign.place')

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
