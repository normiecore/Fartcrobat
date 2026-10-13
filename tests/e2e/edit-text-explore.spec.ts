import { expect, test, type Page } from '@playwright/test'
import { fixturePath, launch, openFile, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/explore-${name}.png` })
const editor = (page: Page) => page.locator('[data-fc-edit-text-editor]')

test('explore dark page colours', async () => {
  const { app, page } = await launch()
  try {
    await page.evaluate(() => {
      const s = (window as any).__fartcrobat.useApp
      s.setState({ prefs: { ...s.getState().prefs, pageColors: 'dark', theme: 'dark' } })
    })
    await openFile(page, fixturePath('edit-text/layout.pdf'))
    await waitForRender(page)
    await page.locator('.shell-alltools-item', { hasText: 'Edit a PDF' }).click()
    await page.waitForTimeout(600)
    await page.getByRole('button', { name: /^Edit text: Red text/ }).click()
    await expect(editor(page)).toBeFocused()
    await page.keyboard.press('End')
    await page.keyboard.type(' and more')
    await page.waitForTimeout(300)
    await shot(page, 'darkpage-editing')
  } finally {
    await app.close()
  }
})
