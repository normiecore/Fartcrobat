import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, waitForRender } from './helpers'

async function pageText(page: Page, index: number): Promise<string> {
  return page.evaluate((i) => (window as any).__fartcrobat.getActiveDoc().core.text.plain(i), index)
}

async function pageSize(page: Page, index: number): Promise<{ width: number; height: number }> {
  return page.evaluate((i) => {
    const p = (window as any).__fartcrobat.getActiveDoc().state.info.pages[i]
    return { width: p.width, height: p.height }
  }, index)
}

function dialog(page: Page, title: string) {
  return page.locator('.ui-dialog').filter({ has: page.locator('h2', { hasText: title }) })
}

async function waitForPreview(page: Page) {
  await expect(page.locator('.fc-page-marks-preview-canvas[data-ready="true"]')).toBeVisible()
  await page.waitForTimeout(250)
  await expect(page.locator('.fc-page-marks-preview-canvas[data-ready="true"]')).toBeVisible()
}

test('headers, footers, watermarks, backgrounds, Bates numbers and cropping', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)

    // ---- open the tool group from All tools ----
    await page.locator('.shell-alltools-item', { hasText: 'Add header, watermark or background' }).click()
    const panel = page.locator('.fc-page-marks-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByRole('button', { name: /Update header & footer/ })).toBeDisabled()
    await page.screenshot({ path: 'test-results/page-marks-panel.png' })

    // ---- Header & Footer: "Page 1 of n" in the centre footer ----
    await panel.getByRole('button', { name: /Add header & footer/ }).click()
    const hf = dialog(page, 'Add Header & Footer')
    await expect(hf).toBeVisible()
    await hf.locator('textarea[data-slot="footerCenter"]').click()
    await hf.getByLabel('Page number format').selectOption('Page 1 of n')
    await hf.getByRole('button', { name: 'Insert page number' }).click()
    await expect(hf.locator('textarea[data-slot="footerCenter"]')).toHaveValue('Page <<1>> of <<n>>')
    await hf.locator('textarea[data-slot="headerRight"]').fill('Fartcrobat test')
    await hf.getByLabel('Font size (pt)').fill('14')
    await waitForPreview(page)
    await page.screenshot({ path: 'test-results/page-marks-headerfooter-dialog.png' })
    await hf.getByRole('button', { name: 'OK' }).click()
    await expect(hf).toBeHidden()
    await expect.poll(() => pageText(page, 2)).toContain('Fartcrobat test')
    // the fixture already shows "Page 3 of 5" once; our footer adds another
    expect((await pageText(page, 2)).split('Page 3 of 5').length - 1).toBe(2)
    let st = await activeDocState(page)
    expect(st?.dirty).toBe(true)
    expect(st?.journal.undoLabel).toBe('Add Header & Footer')
    await expect(panel.getByRole('button', { name: /Update header & footer/ })).toBeEnabled()

    // ---- Watermark: diagonal CONFIDENTIAL at 30% ----
    await panel.getByRole('button', { name: /Add watermark/ }).click()
    const wm = dialog(page, 'Add Watermark')
    await expect(wm).toBeVisible()
    await wm.getByLabel('Watermark text').fill('CONFIDENTIAL')
    await expect(wm.getByRole('radio', { name: '45°', exact: true })).toHaveAttribute('aria-checked', 'true')
    const slider = wm.locator('.ui-slider input[type="range"]')
    await slider.focus()
    for (let k = 0; k < 20; k++) await page.keyboard.press('ArrowLeft')
    await expect(wm.locator('.ui-slider-value')).toHaveText('30%')
    await waitForPreview(page)
    await page.screenshot({ path: 'test-results/page-marks-watermark-dialog.png' })
    await wm.getByRole('button', { name: 'OK' }).click()
    await expect(wm).toBeHidden()
    await expect.poll(() => pageText(page, 0)).toContain('CONFIDENTIAL')
    expect(await pageText(page, 4)).toContain('CONFIDENTIAL')
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'test-results/page-marks-watermark.png' })

    // ---- Update the watermark: dialog is prefilled ----
    await panel.getByRole('button', { name: /Update watermark/ }).click()
    const upd = dialog(page, 'Update Watermark')
    await expect(upd.getByLabel('Watermark text')).toHaveValue('CONFIDENTIAL')
    await expect(upd.locator('.ui-slider-value')).toHaveText('30%')
    await upd.getByRole('button', { name: 'Cancel' }).click()
    await expect(upd).toBeHidden()

    // ---- Remove the watermark ----
    await panel.getByRole('button', { name: /Remove watermark/ }).click()
    const confirmRemove = dialog(page, 'Remove Watermark')
    await expect(confirmRemove).toBeVisible()
    await confirmRemove.getByRole('button', { name: 'Remove' }).click()
    await expect.poll(() => pageText(page, 0)).not.toContain('CONFIDENTIAL')
    expect(await pageText(page, 0)).toContain('Fartcrobat test')
    st = await activeDocState(page)
    expect(st?.journal.undoLabel).toBe('Remove Watermark')

    // ---- Background and Bates numbering (dark theme) ----
    await page.evaluate(() => {
      const { useApp } = (window as any).__fartcrobat
      useApp.setState({ prefs: { ...useApp.getState().prefs, theme: 'dark' } })
    })
    await panel.getByRole('button', { name: /Add Bates numbering/ }).click()
    const bates = dialog(page, 'Add Bates Numbering')
    await bates.getByLabel('Prefix').fill('ACME-')
    await bates.getByLabel('Start number').fill('100')
    await bates.getByRole('radio', { name: 'Left header' }).click()
    await expect(bates.locator('.fc-page-marks-hint').first()).toContainText('ACME-000100')
    await waitForPreview(page)
    await page.screenshot({ path: 'test-results/page-marks-bates-dark.png' })
    await bates.getByRole('button', { name: 'OK' }).click()
    await expect(bates).toBeHidden()
    await expect.poll(() => pageText(page, 4)).toContain('ACME-000104')

    await panel.getByRole('button', { name: /Add background/ }).click()
    const bg = dialog(page, 'Add Background')
    await bg.locator('.ui-swatch[title="#E3F2FD"]').click()
    await waitForPreview(page)
    await page.screenshot({ path: 'test-results/page-marks-background-dark.png' })
    await bg.getByRole('button', { name: 'OK' }).click()
    await expect(bg).toBeHidden()
    await page.evaluate(() => {
      const { useApp } = (window as any).__fartcrobat
      useApp.setState({ prefs: { ...useApp.getState().prefs, theme: 'light' } })
    })
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'test-results/page-marks-all-marks.png' })

    // ---- Crop page 1 by dragging, at 150% zoom ----
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(1.5))
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.goToPage(0))
    await page.waitForTimeout(500)
    await panel.getByRole('button', { name: /Crop pages/ }).click()
    await expect(page.locator('.fc-page-marks-toolbar')).toBeVisible()
    const pageEl = page.locator('.viewer-page[data-page-index="0"]')
    const box = (await pageEl.boundingBox())!
    const vp = (await page.locator('.viewer-scroll').boundingBox())!
    const x0 = Math.max(box.x, vp.x) + 60
    const y0 = Math.max(box.y, vp.y) + 60
    const dx = 450
    const dy = 300
    await page.mouse.move(x0, y0)
    await page.mouse.down()
    await page.mouse.move(x0 + dx / 2, y0 + dy / 2, { steps: 5 })
    await page.mouse.move(x0 + dx, y0 + dy, { steps: 5 })
    await page.screenshot({ path: 'test-results/page-marks-crop-drag.png' })
    await page.mouse.up()
    const crop = dialog(page, 'Set Page Boxes')
    await expect(crop).toBeVisible()
    await expect(crop.locator('.fc-page-marks-preview-size')).toContainText('New size')
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'test-results/page-marks-crop-dialog.png' })
    await crop.getByRole('button', { name: 'OK' }).click()
    await expect(crop).toBeHidden()
    // 150% zoom: 1 pt = 2 CSS px
    await expect.poll(async () => Math.round((await pageSize(page, 0)).width)).toBeGreaterThan(dx / 2 - 3)
    let size = await pageSize(page, 0)
    expect(size.width).toBeLessThan(dx / 2 + 3)
    expect(size.height).toBeGreaterThan(dy / 2 - 3)
    expect(size.height).toBeLessThan(dy / 2 + 3)
    expect((await pageSize(page, 1)).width).toBeCloseTo(612, 0)
    st = await activeDocState(page)
    expect(st?.journal.undoLabel).toBe('Crop Pages')
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'test-results/page-marks-cropped.png' })

    // ---- Undo with the keyboard ----
    await page.keyboard.press('Escape')
    await expect(page.locator('.fc-page-marks-toolbar')).toBeHidden()
    await page.keyboard.press('Control+z')
    await expect.poll(async () => Math.round((await pageSize(page, 0)).width)).toBe(612)
    st = await activeDocState(page)
    expect(st?.journal.undoLabel).toBe('Add Background')
    // a full-page background has no white margins: take it away first
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await activeDocState(page))?.journal.undoLabel).toBe('Add Bates Numbering')

    // ---- Set Page Boxes: remove white margins on every page ----
    await page.keyboard.press('Control+Shift+T')
    const boxes = dialog(page, 'Set Page Boxes')
    await expect(boxes).toBeVisible()
    await boxes.getByText('Remove white margins').click()
    await expect(boxes.locator('.fc-page-marks-preview-size')).toContainText('New size')
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'test-results/page-marks-white-margins.png' })
    await boxes.getByRole('button', { name: 'OK' }).click()
    await expect(boxes).toBeHidden()
    size = await pageSize(page, 2)
    expect(size.width).toBeLessThan(612)
    await expect(panel.getByRole('button', { name: /Remove crop/ })).toBeEnabled()
    await page.keyboard.press('Control+z')
    await expect.poll(async () => Math.round((await pageSize(page, 2)).width)).toBe(612)
  } finally {
    await app.close()
  }
})

/** Starts a command without waiting for it (dialog commands finish when their dialog closes). */
async function startCommand(page: Page, id: string) {
  await page.evaluate((c) => {
    void (window as any).__fartcrobat.runCommand(c)
  }, id)
}

async function markGroups(page: Page): Promise<{ type: string; source: string | null }[]> {
  return page.evaluate(async () => {
    const listing = await (window as any).__fartcrobat.getActiveDoc().ops('page-marks').list()
    return listing.groups.map((g: any) => ({ type: g.type, source: g.settings.source?.kind ?? null }))
  })
}

test('image watermark, add-or-replace prompt and a header on a rotated page', async () => {
  const { app, page } = await launch()
  try {
    // The native "Choose file" dialog returns a fixture image.
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as any
    }, fixturePath('scan.png'))
    await openFile(page, fixturePath('mixed-sizes.pdf'))
    await waitForRender(page)

    // The page-marks commands are in the Document menu.
    const menuCommands = await page.evaluate(() =>
      (window as any).__fartcrobat.registry.menus
        .filter((m: any) => m.menu === 'document' && m.command.startsWith('marks.'))
        .map((m: any) => m.command)
    )
    expect(menuCommands).toEqual(
      expect.arrayContaining([
        'marks.headerFooter.add',
        'marks.watermark.update',
        'marks.background.remove',
        'marks.bates.add',
        'marks.crop',
        'marks.setPageBoxes'
      ])
    )

    // ---- Header through "Find text or tools", typed with the keyboard ----
    await page.keyboard.press('Control+Shift+K')
    await page.keyboard.type('Add Header & Footer')
    await page.keyboard.press('Enter')
    const hf = dialog(page, 'Add Header & Footer')
    await expect(hf).toBeVisible()
    await expect(hf.locator('textarea[data-slot="footerCenter"]')).toBeFocused()
    await page.keyboard.type('Sheet ')
    await hf.getByLabel('Page number format').selectOption('1 of n')
    await hf.getByRole('button', { name: 'Insert page number' }).click()
    await expect(hf.locator('textarea[data-slot="footerCenter"]')).toHaveValue('Sheet <<1>> of <<n>>')
    await hf.locator('textarea[data-slot="headerCenter"]').fill('Upright header')
    await hf.getByRole('button', { name: 'Next page' }).click()
    await hf.getByRole('button', { name: 'Next page' }).click()
    await waitForPreview(page)
    await page.screenshot({ path: 'test-results/page-marks-rotated-preview.png' })
    await hf.getByRole('button', { name: 'OK' }).click()
    await expect(hf).toBeHidden()
    await expect.poll(() => pageText(page, 2)).toContain('Sheet 3 of 3')
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom('fit-page'))
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.goToPage(2))
    await page.waitForTimeout(800)
    await page.screenshot({ path: 'test-results/page-marks-rotated.png' })

    // ---- Image watermark from a file, behind the page, half the page size ----
    await startCommand(page, 'marks.watermark.add')
    const wm = dialog(page, 'Add Watermark')
    await expect(wm).toBeVisible()
    await wm.getByRole('radio', { name: 'File (image or PDF)' }).click()
    await expect(wm.getByRole('button', { name: 'OK' })).toBeDisabled()
    await wm.getByRole('button', { name: 'Choose file…' }).click()
    await expect(wm.locator('.fc-page-marks-filename')).toHaveText('scan.png')
    await wm.getByText('Scale relative to the page', { exact: true }).click()
    await wm.getByRole('radio', { name: '0°', exact: true }).click()
    await wm.getByRole('radio', { name: 'Behind the page' }).click()
    await waitForPreview(page)
    await page.screenshot({ path: 'test-results/page-marks-image-watermark-dialog.png' })
    await wm.getByRole('button', { name: 'OK' }).click()
    await expect(wm).toBeHidden()
    await expect
      .poll(() => markGroups(page))
      .toEqual([
        { type: 'HeaderFooter', source: null },
        { type: 'Watermark', source: 'file' }
      ])

    // ---- Adding again offers to replace the existing watermark ----
    await startCommand(page, 'marks.watermark.add')
    const existing = dialog(page, 'Existing Watermark')
    await expect(existing).toBeVisible()
    await existing.getByRole('button', { name: 'Replace Existing' }).click()
    const wm2 = dialog(page, 'Add Watermark')
    await expect(wm2).toBeVisible()
    await wm2.getByRole('radio', { name: 'Text' }).click()
    await wm2.getByLabel('Watermark text').fill('DRAFT')
    await wm2.getByRole('button', { name: 'OK' }).click()
    await expect(wm2).toBeHidden()
    await expect.poll(() => pageText(page, 0)).toContain('DRAFT')
    expect(await markGroups(page)).toEqual([
      { type: 'HeaderFooter', source: null },
      { type: 'Watermark', source: 'text' }
    ])
    await page.waitForTimeout(600)
    await page.screenshot({ path: 'test-results/page-marks-replaced.png' })

    // Undo brings the image watermark back.
    await page.keyboard.press('Control+z')
    await expect
      .poll(() => markGroups(page))
      .toEqual([
        { type: 'HeaderFooter', source: null },
        { type: 'Watermark', source: 'file' }
      ])
  } finally {
    await app.close()
  }
})
