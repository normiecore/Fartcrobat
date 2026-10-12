import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, waitForRender } from './helpers'

/**
 * Two long documents: 150 pages; in the new one every 10th page says "version 2", page 40 is gone
 * and a new page follows page 100.
 */
function makeLongPair(): { old: string; new: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fc-compare-'))
  const script = join(dir, 'make.py')
  writeFileSync(
    script,
    `
import sys
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
def make(path, new):
    c = canvas.Canvas(path, pagesize=letter)
    for i in range(1, 151):
        if new and i == 40:
            continue
        c.setFont('Helvetica-Bold', 16)
        c.drawString(72, 720, f'Section {i}')
        c.setFont('Helvetica', 11)
        for k in range(30):
            v = 2 if (new and i % 10 == 0 and k == 3) else 1
            c.drawString(72, 690 - k * 18, f'Paragraph {k} of section {i} describes clause {i * 31 + k} in version {v}.')
        c.showPage()
        if new and i == 100:
            c.setFont('Helvetica-Bold', 16)
            c.drawString(72, 720, 'Additional terms')
            c.setFont('Helvetica', 11)
            c.drawString(72, 690, 'These terms were added in the new edition of the contract.')
            c.showPage()
    c.save()
make(sys.argv[1], False)
make(sys.argv[2], True)
`
  )
  const paths = { old: join(dir, 'long-old.pdf'), new: join(dir, 'long-new.pdf') }
  execFileSync('python3', [script, paths.old, paths.new])
  return paths
}

/** Makes the native Open dialog return `old` or `new` depending on which side asks. */
async function stubOpenDialog(app: ElectronApplication, oldPath: string, newPath: string) {
  await app.evaluate(
    ({ ipcMain }, paths) => {
      ipcMain.removeHandler('file:openDialog')
      ipcMain.handle('file:openDialog', (_e, opts: { title?: string }) => [/old/i.test(opts?.title ?? '') ? paths.old : paths.new])
    },
    { old: oldPath, new: newPath }
  )
}

async function browseFor(page: Page, side: 'old' | 'new', scope = page.locator('.shell-leftpane')) {
  await scope.getByRole('button', { name: new RegExp(`(Choose|Change) ${side} file`, 'i') }).first().click()
  await page.getByRole('menuitem', { name: 'Browse…' }).click()
}

/** Waits until every visible compare page canvas has been painted. */
async function waitForComparePages(page: Page) {
  await page.waitForFunction(
    () => {
      const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.fc-compare-page canvas, .fc-compare-overlay-stack canvas')]
      if (!canvases.length) return false
      return canvases.every((c) => {
        if (c.width < 10) return false
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
        for (let k = 0; k < d.length; k += 4 * 101) if (d[k] < 200) return true
        return false
      })
    },
    undefined,
    { timeout: 30000 }
  )
}

/** Is the element inside the visible part of the compare scroll area? */
async function inView(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel)
    const scroller = document.querySelector('.fc-compare-scroll')
    if (!el || !scroller) return false
    const r = el.getBoundingClientRect()
    const v = scroller.getBoundingClientRect()
    return r.top >= v.top && r.bottom <= v.bottom && r.left >= v.left - 1 && r.right <= v.right + 1
  }, selector)
}

test('compares compare-a.pdf with compare-b.pdf from an open document', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('compare-a.pdf'))
    await waitForRender(page)
    await stubOpenDialog(app, fixturePath('compare-a.pdf'), fixturePath('compare-b.pdf'))

    // All tools > Compare files; the open document is preselected as the old file.
    await page.locator('.shell-alltools-list').getByRole('button', { name: 'Compare files' }).click()
    const pane = page.locator('.shell-leftpane')
    await expect(pane.getByRole('heading', { name: 'Compare files' })).toBeVisible()
    await expect(pane.locator('.fc-compare-slot').first()).toContainText('compare-a.pdf')
    await browseFor(page, 'new')
    await expect(pane.locator('.fc-compare-slot').nth(1)).toContainText('compare-b.pdf')
    await expect(page.locator('.fc-compare-card').nth(1)).toContainText('compare-b.pdf')
    await page.waitForTimeout(400)
    await page.screenshot({ path: 'test-results/compare-setup.png' })

    await pane.getByRole('button', { name: 'Compare', exact: true }).click()
    const items = pane.locator('.fc-compare-item')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('Replaced “$1,234.56” with “$9,876.54”')
    await expect(items.nth(1)).toContainText('Replaced “finance” with “audit”')
    await expect(pane.locator('.fc-compare-total')).toContainText('2 changes')

    // Highlights on both sides: orange (replaced) on the old and the new page.
    await expect(page.locator('.fc-compare-page[data-side="old"] .fc-compare-hl--replaced')).toHaveCount(2)
    await expect(page.locator('.fc-compare-page[data-side="new"] .fc-compare-hl--replaced')).toHaveCount(2)
    await waitForComparePages(page)
    await page.screenshot({ path: 'test-results/compare-results.png' })

    // Highlights sit on the changed words: the old one covers "$1,234.56" right of "Total revenue:".
    const hl = await page.locator('.fc-compare-page[data-side="new"] .fc-compare-hl[data-change-id="1"]').boundingBox()
    const pg = await page.locator('.fc-compare-page[data-side="new"]').boundingBox()
    expect(hl && pg).toBeTruthy()
    const fx = (hl!.x - pg!.x) / pg!.width
    const fy = (hl!.y - pg!.y) / pg!.height
    // reportlab drew "Total revenue: $9,876.54" at x=72pt, y=680pt (from the bottom) on a 612x792 page
    expect(fx).toBeGreaterThan(0.2)
    expect(fx).toBeLessThan(0.32)
    expect(fy).toBeGreaterThan(0.12)
    expect(fy).toBeLessThan(0.16)

    // Clicking a change selects it on both sides and scrolls to it, also when zoomed in.
    const toolbar = page.locator('.fc-compare-toolbar')
    for (let k = 0; k < 3; k++) await toolbar.getByRole('button', { name: 'Zoom in' }).click()
    await page.locator('.fc-compare-scroll').evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await items.nth(1).click()
    await expect(page.locator('.fc-compare-counter')).toHaveText('Change 2 of 2')
    await expect(page.locator('.fc-compare-hl.is-selected')).toHaveCount(2)
    await expect.poll(() => inView(page, '.fc-compare-page[data-side="new"] .fc-compare-hl.is-selected')).toBe(true)
    await expect.poll(() => inView(page, '.fc-compare-page[data-side="old"] .fc-compare-hl.is-selected')).toBe(true)
    await waitForComparePages(page)
    await page.screenshot({ path: 'test-results/compare-zoomed.png' })

    // Editing a compared document marks the results as out of date; Compare again refreshes them.
    await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      await d.ops('annots').create(0, { type: 'Square', rect: [300, 300, 400, 400], color: '#ff0000' })
    })
    const stale = pane.locator('.fc-compare-stale')
    await expect(stale).toContainText('“compare-a.pdf” was changed after the comparison')
    await stale.getByRole('button', { name: 'Compare again' }).click()
    await expect(stale).toBeHidden()
    await expect(items).toHaveCount(2)
    await items.nth(1).click()

    // Previous change with the keyboard (Shift+F7).
    await page.keyboard.press('Shift+F7')
    await expect(page.locator('.fc-compare-counter')).toHaveText('Change 1 of 2')
    await expect(items.nth(0)).toHaveAttribute('aria-selected', 'true')

    // Single page overlay.
    await page.getByRole('radio', { name: /Single page overlay/ }).click()
    await expect(page.locator('.fc-compare-overlay-stack')).toHaveCount(1)
    await page.locator('.fc-compare-zoom').click()
    await waitForComparePages(page)
    await page.screenshot({ path: 'test-results/compare-overlay.png' })
    await page.getByRole('radio', { name: /Side by side/ }).click()

    // Export report: a new tab with the summary and the annotated new page.
    const before = await page.evaluate(() => (window as any).__fartcrobat.useApp.getState().docs.length)
    await page.locator('.shell-leftpane').getByRole('button', { name: 'Export report' }).click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().docs.length))
      .toBe(before + 1)
    const st = await activeDocState(page)
    expect(st?.title).toMatch(/^Compare report/)
    expect(st?.pageCount).toBe(2)
    await waitForRender(page)
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'test-results/compare-report.png' })
    const annots = await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      return (await d.ops('annots').list(1)).map((a: any) => `${a.type}: ${a.contents}`)
    })
    expect(annots).toEqual(['Highlight: Replaced “$1,234.56” with “$9,876.54”', 'Highlight: Replaced “finance” with “audit”'])

    // The results are kept: Back to results.
    await page.getByRole('button', { name: 'Back to results' }).click()
    await expect(page.locator('.fc-compare-item')).toHaveCount(2)

    // Closing the compared tab: the results stay, its pages are no longer shown.
    await page.getByRole('button', { name: 'Close compare-a.pdf' }).click()
    await page.getByRole('button', { name: "Don't Save" }).click()
    await expect(pane.locator('.fc-compare-stale')).toContainText('“compare-a.pdf” was closed')
    await expect(page.locator('.fc-compare-page[data-side="old"] .fc-compare-closed')).toBeVisible()
    await expect(pane.locator('.fc-compare-stale').getByRole('button', { name: 'Choose files again' })).toBeVisible()
    await waitForComparePages(page).catch(() => {})
    await page.screenshot({ path: 'test-results/compare-closed.png' })
  } finally {
    await app.close()
  }
})

test('compares two files from Home: page changes, filters, keyboard and dark theme', async () => {
  const { app, page } = await launch()
  try {
    await page.locator('.home-tile', { hasText: 'Compare files' }).click()
    const host = page.locator('.fc-compare-home')
    await expect(host).toBeVisible()
    // A protected file asks for its password.
    await stubOpenDialog(app, fixturePath('encrypted.pdf'), fixturePath('compare/contract-new.pdf'))
    await browseFor(page, 'old', host.locator('.fc-compare-card').first())
    const dialog = page.locator('.ui-dialog', { hasText: 'Password required' })
    await dialog.getByLabel('Password').fill('nope')
    await dialog.getByRole('button', { name: 'Open' }).click()
    await expect(dialog).toContainText('incorrect')
    await dialog.getByLabel('Password').fill('secret')
    await dialog.getByRole('button', { name: 'Open' }).click()
    await expect(host.locator('.fc-compare-card').first()).toContainText('encrypted.pdf')
    // Pick both files with the big cards.
    await stubOpenDialog(app, fixturePath('compare/contract-old.pdf'), fixturePath('compare/contract-new.pdf'))
    await browseFor(page, 'old', host.locator('.fc-compare-card').first())
    await expect(host.locator('.fc-compare-card').first()).toContainText('contract-old.pdf')
    await browseFor(page, 'new', host.locator('.fc-compare-card').nth(1))
    await expect(host.locator('.fc-compare-card').nth(1)).toContainText('contract-new.pdf')
    await host.locator('.fc-compare-card canvas').first().waitFor()
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'test-results/compare-home-setup.png' })

    await host.locator('.fc-compare-landing').getByRole('button', { name: 'Compare', exact: true }).click()
    const items = host.locator('.fc-compare-item')
    await expect(items.first()).toBeVisible()
    const texts = await items.locator('.fc-compare-item-title').allTextContents()
    expect(texts).toEqual([
      'Image changed',
      'Graphics changed',
      'Replaced “Beta” with “Gamma”',
      'Formatting changed in “total fee”',
      'Replaced “. Late payments incur a fee of 2%” with “of the invoice date”',
      'Page 3 added',
      'Page 3 moved to page 5',
      'Page 5 removed'
    ])
    await waitForComparePages(page)
    await page.screenshot({ path: 'test-results/compare-home-results.png' })

    // Filter: only pages.
    await host.getByRole('button', { name: /Pages\s*3/ }).click()
    await expect(items).toHaveCount(3)
    await items.nth(0).click()
    await expect(page.locator('.fc-compare-page[data-side="new"].is-inserted')).toBeVisible()
    await expect(page.locator('.fc-compare-placeholder', { hasText: 'Not in the old file' })).toBeVisible()
    await waitForComparePages(page)
    await page.screenshot({ path: 'test-results/compare-home-pages.png' })
    // F7 moves to the next visible change.
    await page.keyboard.press('F7')
    await expect(items.nth(1)).toHaveAttribute('aria-selected', 'true')
    await expect(page.locator('.fc-compare-page-label', { hasText: 'Moved from page 3' })).toBeVisible()
    await host.getByRole('button', { name: 'Show all' }).click()
    await expect(items).toHaveCount(8)

    // Dark theme.
    await page.evaluate(() => {
      const { useApp } = (window as any).__fartcrobat
      useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } }))
    })
    await items.nth(3).click()
    await waitForComparePages(page)
    await page.waitForTimeout(300)
    await page.screenshot({ path: 'test-results/compare-home-dark.png' })

    // Back arrow leaves the tool and shows Home again.
    await host.getByRole('button', { name: 'Back to all tools' }).click()
    await expect(host).toBeHidden()
    await expect(page.locator('.home-title')).toBeVisible()
  } finally {
    await app.close()
  }
})

test('long documents: progress, cancel, page ranges and a responsive window', async () => {
  const long = makeLongPair()
  const { app, page } = await launch()
  try {
    await stubOpenDialog(app, long.old, long.new)
    await page.locator('.home-tile', { hasText: 'Compare files' }).click()
    const host = page.locator('.fc-compare-home')
    await browseFor(page, 'old', host.locator('.fc-compare-card').first())
    await browseFor(page, 'new', host.locator('.fc-compare-card').nth(1))
    await expect(host.locator('.fc-compare-card').nth(1)).toContainText('150 pages')

    // Cancel a running comparison.
    const compare = host.locator('.fc-compare-landing').getByRole('button', { name: 'Compare', exact: true })
    await compare.click()
    const progress = page.getByRole('progressbar', { name: 'Comparing documents' })
    await expect(progress).toBeVisible()
    await page.screenshot({ path: 'test-results/compare-progress.png' })
    await page.keyboard.press('Escape')
    await expect(progress).toBeHidden()
    await expect(page.locator('.toast', { hasText: 'Comparison cancelled' })).toBeVisible()
    await expect(host.locator('.fc-compare-landing')).toBeVisible()

    // Run it to the end while watching for frames the UI thread could not paint.
    await page.evaluate(() => {
      const w = window as any
      w.__maxGap = 0
      let last = performance.now()
      const tick = (t: number) => {
        w.__maxGap = Math.max(w.__maxGap, t - last)
        last = t
        if (!w.__stopFrames) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
    await compare.click()
    const items = host.locator('.fc-compare-item')
    await expect(items.first()).toBeVisible({ timeout: 60000 })
    const maxGap = await page.evaluate(() => {
      ;(window as any).__stopFrames = true
      return (window as any).__maxGap as number
    })
    console.log(`longest frame while comparing: ${Math.round(maxGap)} ms`)
    expect(maxGap).toBeLessThan(1500)
    await expect(host.locator('.fc-compare-total')).toContainText('16 changes')
    const titles = await items.locator('.fc-compare-item-title').allTextContents()
    // every 10th page changed, except page 40 which was removed
    expect(titles.filter((t) => t === 'Replaced “1” with “2”')).toHaveLength(14)
    expect(titles).toContain('Page 40 removed')
    expect(titles).toContain('Page 100 added')
    // Only the pages near the viewport are mounted.
    expect(await page.locator('.fc-compare-page').count()).toBeLessThan(20)
    // Jump to the last change: the view scrolls far down and shows it.
    await items.last().click()
    await expect.poll(() => inView(page, '.fc-compare-page[data-side="new"] .fc-compare-hl.is-selected')).toBe(true)
    await waitForComparePages(page)
    await page.screenshot({ path: 'test-results/compare-long.png' })

    // Page ranges: compare only pages 1-12 of both files.
    await host.getByRole('button', { name: 'New comparison' }).click()
    for (const side of ['old', 'new']) {
      await host.getByLabel(`Pages of the ${side} file`).selectOption('custom')
      await host.getByLabel(`Page range of the ${side} file`).fill('1-12')
    }
    await host.locator('.shell-leftpane').getByRole('button', { name: 'Compare', exact: true }).click()
    await expect(host.locator('.fc-compare-total')).toContainText('1 change')
    await expect(items).toHaveCount(1)
    await expect(items.first()).toContainText('Replaced “1” with “2”')
    await expect(items.first()).toContainText('Old page 10 · New page 10')
    // An invalid range explains itself and disables Compare.
    await host.getByRole('button', { name: 'New comparison' }).click()
    await host.getByLabel('Page range of the old file').fill('140-160')
    await expect(host.locator('.fc-compare-range-error')).toHaveText('Page 160 does not exist (the document has 150 pages)')
    await expect(host.locator('.shell-leftpane').getByRole('button', { name: 'Compare', exact: true })).toBeDisabled()
    await page.screenshot({ path: 'test-results/compare-range-error.png' })
  } finally {
    await app.close()
  }
})
