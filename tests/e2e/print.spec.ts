import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, waitForRender } from './helpers'

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

interface PageStats {
  mime: string
  widthPt: number
  heightPt: number
  bytes: number
  /** Decoded pixel size. */
  pxW: number
  pxH: number
  /** Inked (non-white) samples per quadrant: top-left, top-right, bottom-left, bottom-right. */
  quadrants: [number, number, number, number]
  /** Samples with a clear colour (not grey). */
  colourful: number
  /** Strong red samples (the test comment). */
  red: number
  /** Darkest channel value found (0 = full black). */
  darkest: number
}

interface CapturedJob {
  silent: boolean
  copies: number
  color: boolean
  landscape: boolean
  fit: string
  deviceName?: string
  duplex?: string
  pageSize?: unknown
  jobName?: string
  pages: PageStats[]
}

/**
 * window.api is frozen by contextBridge, so printing is stubbed where it is handled: the main
 * process. 'print:images' jobs are captured instead of reaching a real printer and
 * 'print:printers' returns two fake printers. The renderer, preload and IPC paths stay real.
 */
async function stubPrinting(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as any
    g.__printJobs = []
    ipcMain.removeHandler('print:images')
    ipcMain.handle('print:images', (_e, job) => {
      g.__printJobs.push(job)
      return { ok: true }
    })
    ipcMain.removeHandler('print:printers')
    ipcMain.handle('print:printers', () => [
      { name: 'office-laser', displayName: 'Office Laser', isDefault: true },
      { name: 'photo-inkjet', displayName: 'Photo Inkjet', isDefault: false }
    ])
  })
}

/** Captured jobs, with every printed image decoded (Electron nativeImage) and summarised. */
async function capturedJobs(app: ElectronApplication): Promise<CapturedJob[]> {
  return app.evaluate(({ nativeImage }) => {
    const jobs = ((globalThis as any).__printJobs ?? []) as any[]
    return jobs.map((j) => ({
      ...j,
      pages: j.pages.map((p: any) => {
        const data = Buffer.from(p.data)
        const img = nativeImage.createFromBuffer(data)
        const { width, height } = img.getSize()
        const bgra = img.toBitmap()
        const quadrants: [number, number, number, number] = [0, 0, 0, 0]
        let colourful = 0
        let red = 0
        let darkest = 255
        for (let y = 0; y < height; y += 3)
          for (let x = 0; x < width; x += 3) {
            const i = (y * width + x) * 4
            const b = bgra[i]
            const g = bgra[i + 1]
            const r = bgra[i + 2]
            const lo = Math.min(r, g, b)
            darkest = Math.min(darkest, lo)
            if (lo < 235) quadrants[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]++
            if (Math.max(r, g, b) - lo > 40) colourful++
            if (r > 180 && g < 90 && b < 90) red++
          }
        return { mime: p.mime, widthPt: p.widthPt, heightPt: p.heightPt, bytes: data.length, pxW: width, pxH: height, quadrants, colourful, red, darkest }
      })
    }))
  })
}

/** Runs a command without waiting for it to finish (file.print resolves only when its dialog closes). */
async function startCommand(page: Page, id: string) {
  await page.evaluate((c) => {
    void (window as any).__fartcrobat.runCommand(c)
  }, id)
}

const dialog = (page: Page) => page.locator('.fc-print-dialog')
const counter = (page: Page) => page.locator('.fc-print-counter')
const preview = (page: Page) => page.locator('.fc-print-preview-canvas')

async function waitForPreview(page: Page) {
  await expect(preview(page)).toHaveAttribute('data-busy', 'false')
  await expect(preview(page)).not.toHaveClass(/is-pending/)
}

/** Fraction of preview pixels that are clearly coloured (not white/grey) and dark, per half. */
async function previewInk(page: Page) {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('.fc-print-preview-canvas')!
    const ctx = c.getContext('2d')!
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let left = 0
    let right = 0
    let red = 0
    let blue = 0
    let colourful = 0
    for (let y = 0; y < c.height; y++)
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        const [r, g, b] = [d[i], d[i + 1], d[i + 2]]
        if (r < 160 || g < 160 || b < 160) {
          if (x < c.width / 2) left++
          else right++
        }
        if (r > 180 && g < 80 && b < 80) red++
        if (b > 180 && r < 80) blue++
        if (Math.max(r, g, b) - Math.min(r, g, b) > 40) colourful++
      }
    return { left, right, red, blue, colourful, width: c.width, height: c.height }
  })
}

test('print dialog: page range, 2-up, booklet, poster, comments, grayscale, permissions', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await stubPrinting(app)

    // A comment on page 2, to check the Comments & Forms choice.
    await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      await d.ops('annots').create(1, { type: 'Square', rect: [380, 560, 540, 700], color: '#ff0000', interiorColor: '#ff0000' })
    })

    // ---- Ctrl+P opens the dialog -------------------------------------------------------
    await page.keyboard.press(`${MOD}+KeyP`)
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByRole('heading', { name: 'Print' })).toBeVisible()
    await dialog(page).locator('.fc-print-paper select').selectOption('Letter')
    await expect(dialog(page).locator('select.fc-print-printer')).toHaveValue('office-laser')
    await expect(counter(page)).toHaveText('Page 1 of 5')
    await waitForPreview(page)
    await expect(dialog(page).locator('.fc-print-preview-head')).toContainText('Scale: 96%')
    await page.screenshot({ path: 'test-results/print-dialog.png' })

    // ---- Pages 2-3, 2 pages per sheet ------------------------------------------------------
    await dialog(page).getByLabel('Pages to print').fill('2-3')
    await expect(dialog(page).getByRole('radio', { name: 'Pages', exact: true })).toBeChecked()
    await expect(counter(page)).toHaveText('Page 1 of 2')
    await dialog(page).locator('label.fc-print-mode', { hasText: 'Multiple' }).click()
    await dialog(page).getByLabel('Pages per sheet').selectOption('2')
    await expect(counter(page)).toHaveText('Page 1 of 1')
    await expect(preview(page)).toHaveAttribute('data-pages', '2')
    await waitForPreview(page)
    const ink = await previewInk(page)
    expect(ink.width).toBeGreaterThan(ink.height) // landscape sheet
    expect(ink.left).toBeGreaterThan(200) // page 2 on the left
    expect(ink.right).toBeGreaterThan(200) // page 3 on the right
    expect(ink.red).toBeGreaterThan(50) // the comment prints with "Document and Markups"
    await page.screenshot({ path: 'test-results/print-2up.png' })

    // Comments & Forms: "Document" leaves the comment out of the preview
    await dialog(page).getByLabel('Comments and forms').selectOption('document')
    await expect(dialog(page)).toContainText("This document has 1 comment; it won't print.")
    await waitForPreview(page)
    expect((await previewInk(page)).red).toBe(0)
    await dialog(page).getByLabel('Comments and forms').selectOption('markups')
    await waitForPreview(page)

    // ---- Print: the job has one landscape 300 dpi sheet ------------------------------------
    await dialog(page).getByRole('button', { name: 'Print', exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(async () => (await capturedJobs(app)).length, { timeout: 30000 }).toBe(1)
    const [job] = await capturedJobs(app)
    expect(job.silent).toBe(true)
    expect(job.deviceName).toBe('office-laser')
    expect(job.landscape).toBe(true)
    expect(job.copies).toBe(1)
    expect(job.color).toBe(true)
    expect(job.pageSize).toBe('Letter')
    expect(job.jobName).toBe('text.pdf')
    expect(job.pages).toHaveLength(1)
    expect(job.pages[0]).toMatchObject({ widthPt: 792, heightPt: 612, pxW: 3300, pxH: 2550 })
    const [tl, tr, bl, br] = job.pages[0].quadrants
    expect(tl + bl).toBeGreaterThan(1000) // page 2 on the left half
    expect(tr + br).toBeGreaterThan(1000) // page 3 on the right half
    expect(job.pages[0].red).toBeGreaterThan(1000) // the comment
    expect(job.pages[0].darkest).toBeLessThan(40)
    await expect(page.locator('.toast-success')).toContainText('Sent 1 sheet to Office Laser')

    // Settings were remembered (store) …
    const stored = await page.evaluate(() => (window as any).api.invoke('store:get', 'print:settings'))
    expect(stored).toMatchObject({ layout: 'multiple', perSheet: 2, printer: 'office-laser' })
    expect(stored).not.toHaveProperty('range')

    // … and come back next time, while the page selection resets to All
    await startCommand(page, 'file.print')
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).locator('label.fc-print-mode.is-active')).toHaveText('Multiple')
    await expect(dialog(page).getByRole('radio', { name: 'All', exact: true })).toBeChecked()
    await expect(counter(page)).toHaveText('Page 1 of 3')

    // ---- invalid range -----------------------------------------------------------------
    await dialog(page).getByLabel('Pages to print').fill('2-9')
    await expect(dialog(page).getByRole('alert')).toHaveText('There is no page 9. This document has 5 pages.')
    await expect(dialog(page).getByRole('button', { name: 'Print', exact: true })).toBeDisabled()
    await dialog(page).getByLabel('Pages to print').fill('1-5')

    // ---- Booklet ----------------------------------------------------------------------
    await dialog(page).locator('label.fc-print-mode', { hasText: 'Booklet' }).click()
    await expect(counter(page)).toHaveText('Page 1 of 4 (sheet 1, front)')
    await expect(dialog(page).getByRole('checkbox', { name: 'Print on both sides of paper' })).toBeChecked()
    await expect(dialog(page).getByRole('radio', { name: 'Flip on short edge' })).toBeChecked()
    await waitForPreview(page)
    await page.screenshot({ path: 'test-results/print-booklet.png' })
    await dialog(page).getByRole('button', { name: 'Next page' }).click()
    await expect(counter(page)).toHaveText('Page 2 of 4 (sheet 1, back)')
    // 5 pages are padded to 8: the back of the first sheet has page 2 and a blank page
    await expect(preview(page)).toHaveAttribute('data-pages', '1')
    await dialog(page).locator('.fc-print-slider').fill('4')
    await expect(counter(page)).toHaveText('Page 4 of 4 (sheet 2, back)')
    await expect(preview(page)).toHaveAttribute('data-pages', '2')

    // ---- Poster with grayscale ------------------------------------------------------------
    await dialog(page).locator('label.fc-print-mode', { hasText: 'Poster' }).click()
    await dialog(page).getByLabel('Pages to print').fill('1')
    const tile = dialog(page).locator('label', { hasText: 'Tile scale:' }).locator('input')
    await tile.fill('200')
    await expect(counter(page)).toHaveText('Page 1 of 6')
    // the third tile (row 2, column 1) shows the blue box
    await dialog(page).getByRole('button', { name: 'Next page' }).click()
    await page.keyboard.press('PageDown')
    await expect(counter(page)).toHaveText('Page 3 of 6')
    await waitForPreview(page)
    expect((await previewInk(page)).blue).toBeGreaterThan(100)
    await dialog(page).getByRole('checkbox', { name: 'Print in grayscale (black and white)' }).check()
    await waitForPreview(page)
    const gray = await previewInk(page)
    expect(gray.colourful).toBe(0)
    expect(gray.left + gray.right).toBeGreaterThan(100)
    await page.screenshot({ path: 'test-results/print-poster.png' })

    // ---- 4 pages per sheet, grayscale, save ink: printed for real (stubbed printer) --------
    await expect(dialog(page).getByRole('checkbox', { name: 'Print on both sides of paper' })).not.toBeChecked()
    await dialog(page).locator('label.fc-print-mode', { hasText: 'Multiple' }).click()
    await dialog(page).getByLabel('Pages per sheet').selectOption('4')
    await dialog(page).getByRole('radio', { name: 'All', exact: true }).check()
    await dialog(page).getByRole('checkbox', { name: 'Save ink/toner' }).check()
    await dialog(page).getByLabel('Copies:').fill('2')
    await expect(counter(page)).toHaveText('Page 1 of 2')
    await waitForPreview(page)
    await page.screenshot({ path: 'test-results/print-4up-gray.png' })
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(async () => (await capturedJobs(app)).length, { timeout: 30000 }).toBe(2)
    const four = (await capturedJobs(app))[1]
    expect(four.color).toBe(false)
    expect(four.copies).toBe(2)
    expect(four.landscape).toBe(false)
    expect(four.pages).toHaveLength(2)
    expect(four.pages[0]).toMatchObject({ widthPt: 612, heightPt: 792, pxW: 2550, pxH: 3300, colourful: 0 })
    expect(four.pages[0].quadrants.every((q) => q > 300)).toBe(true)
    const last = four.pages[1].quadrants
    expect(last[0]).toBeGreaterThan(300) // page 5 alone, top left
    expect(last[1] + last[2] + last[3]).toBe(0)
    expect(four.pages[0].darkest).toBeGreaterThan(90) // save ink lightens black

    // ---- dark theme ----------------------------------------------------------------------
    await startCommand(page, 'file.print')
    await expect(dialog(page)).toBeVisible()
    await expect(dialog(page).getByRole('checkbox', { name: 'Save ink/toner' })).toBeChecked()
    await expect(dialog(page).getByLabel('Copies:')).toHaveValue('1')
    await dialog(page).locator('label.fc-print-mode', { hasText: 'Size' }).click()
    await dialog(page).getByRole('checkbox', { name: 'Save ink/toner' }).uncheck()
    await page.evaluate(() => {
      const { useApp } = (window as any).__fartcrobat
      useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } }))
    })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await waitForPreview(page)
    await page.screenshot({ path: 'test-results/print-dark.png' })

    // Escape closes without printing
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    expect((await capturedJobs(app)).length).toBe(2)
  } finally {
    await app.close()
  }
})

test('print: Properties uses the system dialog, cancel stops a large job, restricted files explain why', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('mixed-sizes.pdf'))
    await waitForRender(page)
    await stubPrinting(app)

    // Toolbar button; mixed portrait/landscape pages print on portrait paper, landscape sheets turned.
    await page.getByRole('button', { name: 'Print file' }).click()
    await expect(dialog(page)).toBeVisible()
    await dialog(page).locator('.fc-print-paper select').selectOption('Letter')
    await expect(counter(page)).toHaveText('Page 1 of 3')
    await dialog(page).getByRole('checkbox', { name: 'Print as image draft (faster, 150 dpi)' }).check()
    await dialog(page).getByRole('button', { name: 'Properties' }).click()
    await expect.poll(async () => (await capturedJobs(app)).length, { timeout: 30000 }).toBe(1)
    const [job] = await capturedJobs(app)
    expect(job.silent).toBe(false)
    expect(job.landscape).toBe(false)
    expect(job.pages.map((p) => [p.widthPt, p.heightPt, p.pxW, p.pxH])).toEqual([
      [612, 792, 1275, 1650],
      [612, 792, 1275, 1650],
      [612, 792, 1275, 1650]
    ])

    // A big poster job shows progress and can be cancelled.
    await startCommand(page, 'file.print')
    await expect(dialog(page)).toBeVisible()
    await dialog(page).locator('label.fc-print-mode', { hasText: 'Poster' }).click()
    await dialog(page).getByRole('checkbox', { name: 'Print as image draft (faster, 150 dpi)' }).uncheck()
    const tile = dialog(page).locator('label', { hasText: 'Tile scale:' }).locator('input')
    await tile.fill('600')
    await expect(counter(page)).toContainText('of ')
    await dialog(page).getByRole('button', { name: 'Print', exact: true }).click()
    const progress = page.locator('.progress-dialog')
    await expect(progress).toBeVisible()
    await expect(progress).toContainText('Preparing “mixed-sizes.pdf” for printing')
    await page.screenshot({ path: 'test-results/print-progress.png' })
    await progress.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.locator('.toast').filter({ hasText: 'Printing cancelled.' })).toBeVisible()
    await expect(progress).toHaveCount(0)
    expect((await capturedJobs(app)).length).toBe(1)

    // A document whose security forbids printing explains why instead of opening the dialog.
    await page.evaluate((p) => (window as any).__fartcrobat.openPaths([p]), fixturePath('print/no-print.pdf'))
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('no-print.pdf')
    await page.keyboard.press(`${MOD}+KeyP`)
    const notice = page.getByRole('dialog').filter({ hasText: 'Printing isn’t allowed' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('restricted this document so that it can’t be printed')
    await expect(dialog(page)).toHaveCount(0)
    await page.screenshot({ path: 'test-results/print-restricted.png' })
    await notice.getByRole('button', { name: 'OK' }).click()
    await expect(notice).toHaveCount(0)
  } finally {
    await app.close()
  }
})
