import { expect, test } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

test('opens a PDF, renders, searches and navigates', async () => {
  const { app, page } = await launch()
  try {
    await expect(page.locator('.home-title')).toBeVisible()
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    const st = await activeDocState(page)
    expect(st?.pageCount).toBe(5)
    expect(st?.title).toBe('text.pdf')
    await page.waitForTimeout(500)
    await page.screenshot({ path: 'test-results/smoke-open.png' })

    // search
    await runCommand(page, 'edit.find')
    await page.getByLabel('Find in document').fill('quick brown fox')
    await expect.poll(async () => (await activeDocState(page))?.search.hits).toBe(5)

    // navigation
    await runCommand(page, 'nav.last')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(4)

    // zoom
    await runCommand(page, 'view.actualSize')
    await expect.poll(async () => (await activeDocState(page))?.zoom).toBeCloseTo(1, 2)
    await page.screenshot({ path: 'test-results/smoke-search.png' })
  } finally {
    await app.close()
  }
})
