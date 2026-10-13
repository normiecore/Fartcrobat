import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, runCommand } from './helpers'

function dialogTitled(page: Page, title: string) {
  return page.locator('.ui-dialog', { has: page.locator('h2', { hasText: title }) })
}

function focusInfo(page: Page) {
  return page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null
    return { inDialog: !!a?.closest('.ui-dialog'), tag: a?.tagName ?? null, cls: a?.className ?? '' }
  })
}

test('a confirmation without a primary button takes focus, traps Tab and closes with Escape', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().ops('pages').rotate([0], 90))
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
    await page.focus('.shell-search')

    void runCommand(page, 'file.revert')
    const dialog = dialogTitled(page, 'Revert')
    await expect(dialog).toBeVisible()
    await expect.poll(async () => (await focusInfo(page)).inDialog).toBe(true)
    // The destructive button is not the default: Enter does not revert.
    expect((await focusInfo(page)).cls).not.toContain('ui-btn-danger')
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab')
      expect((await focusInfo(page)).inDialog).toBe(true)
    }
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press('Shift+Tab')
      expect((await focusInfo(page)).inDialog).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect((await activeDocState(page))?.dirty).toBe(true)
    // Focus goes back to where it was before the dialog opened.
    await expect(page.locator('.shell-search')).toBeFocused()
  } finally {
    await app.close()
  }
})

test('number fields can be cleared and retyped', async () => {
  const { app, page } = await launch()
  try {
    await runCommand(page, 'app.preferences')
    const field = page.locator('.ui-field', { hasText: 'Recent files to remember' }).locator('input')
    await expect(field).toBeVisible()
    await field.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.press('Backspace')
    expect(await field.inputValue()).toBe('')
    await page.keyboard.type('7')
    expect(await field.inputValue()).toBe('7')
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().prefs.recentFilesLimit))
      .toBe(7)

    // Leaving the field empty restores the last valid value.
    await page.keyboard.press('Backspace')
    expect(await field.inputValue()).toBe('')
    await page.keyboard.press('Tab')
    expect(await field.inputValue()).toBe('7')
  } finally {
    await app.close()
  }
})
