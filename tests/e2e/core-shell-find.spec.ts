import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

async function selectWord(page: Page, word: string) {
  await page.evaluate(async (w) => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    const t = await d.pageText(0)
    const start = t.text.indexOf(w)
    d.setSelection({ kind: 'text', ranges: [{ page: 0, start, end: start + w.length }] })
  }, word)
}

function searchFinished(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).__fartcrobat.getActiveDoc().state.search
    return !!s.query && !s.running
  })
}

test('Ctrl+F with selected text shows that text in the find box and Enter keeps the results', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    const input = page.getByLabel('Find in document')

    await selectWord(page, 'Chapter')
    await page.keyboard.press('Control+f')
    await expect.poll(() => searchFinished(page)).toBe(true)
    expect((await activeDocState(page))?.search.hits ?? 0).toBeGreaterThan(1)
    await expect(input).toHaveValue('Chapter')
    await expect(page.locator('.shell-findbar-count')).toHaveText(/^1 of \d+$/)
    await page.screenshot({ path: 'test-results/core-shell-find-selection.png' })
    const hits = (await activeDocState(page))!.search.hits
    await input.press('Enter')
    await page.waitForTimeout(300)
    const st = await activeDocState(page)
    expect(st?.search.query).toBe('Chapter')
    expect(st?.search.hits).toBe(hits)

    // With the bar already open, a new selection replaces the old term.
    await selectWord(page, 'Hello')
    await runCommand(page, 'edit.find')
    await expect(input).toHaveValue('Hello')
    await expect.poll(async () => (await activeDocState(page))?.search.query).toBe('Hello')
  } finally {
    await app.close()
  }
})

test('closing the find bar right after typing cancels the pending search', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await runCommand(page, 'edit.find')
    const input = page.getByLabel('Find in document')
    await input.pressSequentially('Chapter', { delay: 10 })
    await input.press('Escape')
    await page.waitForTimeout(600)
    const st = await activeDocState(page)
    expect(st?.search.query).toBe('')
    expect(st?.search.hits).toBe(0)
  } finally {
    await app.close()
  }
})

test('clicking the page number box and back does not move the view', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(3))
    await expect.poll(async () => (await activeDocState(page))?.zoom).toBeCloseTo(3, 2)
    await page.waitForTimeout(300)
    const scrollTop = () => page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.getViewportElement().scrollTop)
    await page.evaluate(() => {
      const el = (window as any).__fartcrobat.getActiveDoc().view.getViewportElement()
      el.scrollTop = 1500
    })
    await page.waitForTimeout(300)
    const before = await scrollTop()
    expect(before).toBeGreaterThan(1000)
    expect((await activeDocState(page))?.currentPage).toBe(0)

    const box = page.getByLabel('Page number')
    await box.click()
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    await page.waitForTimeout(400)
    expect(Math.abs((await scrollTop()) - before)).toBeLessThan(5)

    await box.click()
    await box.press('Enter')
    await page.waitForTimeout(400)
    expect(Math.abs((await scrollTop()) - before)).toBeLessThan(5)

    // Typing a different page still navigates.
    await box.click()
    await box.fill('3')
    await box.press('Enter')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(2)
  } finally {
    await app.close()
  }
})
