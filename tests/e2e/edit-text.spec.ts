import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/edit-text-${name}.png` })

async function pageText(page: Page, index = 0): Promise<string> {
  return page.evaluate(async (i) => (await (window as any).__fartcrobat.getActiveDoc().pageText(i)).text as string, index)
}

async function spanAt(page: Page, needle: string, index = 0) {
  return page.evaluate(
    async ({ i, needle }) => {
      const t = await (window as any).__fartcrobat.getActiveDoc().pageText(i)
      const at = t.text.indexOf(needle)
      const s = t.spans.find((x: any) => x.start <= at && x.end > at)
      return s ? { font: s.font as string, size: s.size as number, color: s.color as number } : null
    },
    { i: index, needle }
  )
}

/** Clicks an empty spot of a page, given as a fraction of its width and height. */
async function clickPage(page: Page, fx: number, fy: number, index = 0) {
  const box = (await page.locator(`.viewer-page[data-page-index="${index}"]`).boundingBox())!
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy)
}

const editor = (page: Page) => page.locator('[data-fc-edit-text-editor]')

test('edits existing text, changes a paragraph size, adds text and undoes', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)

    // open "Edit a PDF" from the All tools list
    await page.locator('.shell-alltools-item', { hasText: 'Edit a PDF' }).click()
    await expect(page.locator('.ui-panel-header h3', { hasText: 'Edit a PDF' })).toBeVisible()
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('edit.content')
    await expect(page.getByRole('button', { name: 'Edit text: Chapter 1' })).toBeVisible()
    await page.waitForTimeout(300)
    await shot(page, 'mode')

    // click the heading, select all and type a new one
    await page.getByRole('button', { name: 'Edit text: Chapter 1' }).click()
    await expect(editor(page)).toBeFocused()
    await expect(page.locator('.fc-edit-text-frame')).not.toHaveClass(/is-pending/)
    await expect(page.locator('.fc-edit-text-mini')).toBeVisible()
    await shot(page, 'editing-heading')
    await page.keyboard.press('Control+A')
    await page.keyboard.type('Introduction')
    await expect(editor(page)).toHaveText('Introduction')
    await shot(page, 'typed-heading')
    // the selection is a custom 'edit-text:block' selection while editing
    expect((await activeDocState(page))?.selection).toMatchObject({ kind: 'custom', type: 'edit-text:block', page: 0 })

    // click outside: the change is written into the page
    await clickPage(page, 0.8, 0.6)
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(() => pageText(page)).toContain('Introduction')
    expect(await pageText(page)).not.toContain('Chapter 1')
    const st = await activeDocState(page)
    expect(st?.journal.undoLabel).toBe('Edit Text')
    expect(st?.dirty).toBe(true)
    expect(await spanAt(page, 'Introduction')).toMatchObject({ font: 'Helvetica-Bold', size: 24 })
    await page.waitForTimeout(500)
    await shot(page, 'after-heading')

    // change the size of a paragraph from the panel (no text selected = whole box)
    await page.locator('.viewer-page[data-page-index="0"]').getByRole('button', { name: /^Edit text: Lorem ipsum/ }).click()
    await expect(editor(page)).toBeFocused()
    const size = page.locator('.fc-edit-text-panel').getByLabel('Font size')
    await expect(size).toHaveValue('11')
    await size.fill('14')
    await size.press('Enter')
    await expect(editor(page)).toBeFocused()
    await expect.poll(() => editor(page).evaluate((el) => getComputedStyle(el.querySelector('span')!).fontSize)).not.toBe(
      await editor(page).evaluate((el) => el.style.fontSize)
    )
    await page.waitForTimeout(300)
    await shot(page, 'paragraph-size')
    await clickPage(page, 0.8, 0.6)
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(async () => (await spanAt(page, 'Lorem ipsum'))?.size).toBeCloseTo(14, 1)
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Edit Text')
    await page.waitForTimeout(500)
    await shot(page, 'after-paragraph-size')

    // add new text with "Add text"
    await page.locator('.fc-edit-text-panel').getByRole('button', { name: /^Add text/ }).click()
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('edit.addText')
    await clickPage(page, 0.55, 0.62)
    await expect(editor(page)).toBeFocused()
    await page.keyboard.type('Added with Fartcrobat')
    await shot(page, 'adding-text')
    await clickPage(page, 0.3, 0.9)
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(() => pageText(page)).toContain('Added with Fartcrobat')
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Add Text')
    // after placing text the tool goes back to editing
    expect(await page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('edit.content')
    await page.waitForTimeout(500)
    await shot(page, 'after-add')

    // undo removes the added text, a second undo restores the paragraph size
    await page.keyboard.press('Control+Z')
    await expect.poll(() => pageText(page)).not.toContain('Added with Fartcrobat')
    await runCommand(page, 'edit.undo')
    await expect.poll(async () => (await spanAt(page, 'Lorem ipsum'))?.size).toBeCloseTo(11, 1)
    expect(await pageText(page)).toContain('Introduction')
    await page.waitForTimeout(500)
    await shot(page, 'after-undo')
  } finally {
    await app.close()
  }
})

test('edits at another zoom level, formats a selection, cancels with Esc and works in dark mode', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await runCommand(page, 'editText.editContent')
    await runCommand(page, 'view.actualSize')
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(2))
    await page.waitForTimeout(500)
    await waitForRender(page)

    // Esc cancels without changing anything
    await page.getByRole('button', { name: /^Edit text: Hello Fartcrobat page 1/ }).click()
    await expect(editor(page)).toBeFocused()
    await page.keyboard.type('XYZ')
    await page.keyboard.press('Escape')
    await expect(editor(page)).toHaveCount(0)
    expect(await pageText(page)).not.toContain('XYZ')
    expect((await activeDocState(page))?.journal.canUndo).toBe(false)

    // select a word with the keyboard and make it bold and red from the mini toolbar
    await page.getByRole('button', { name: /^Edit text: Hello Fartcrobat page 1/ }).click()
    await expect(editor(page)).toBeFocused()
    await page.keyboard.press('Home')
    await page.keyboard.press('Shift+End')
    await page.keyboard.press('Control+B')
    await expect(page.locator('.fc-edit-text-mini').getByRole('button', { name: /^Bold/ })).toHaveAttribute('aria-pressed', 'true')
    await page.locator('.fc-edit-text-mini').getByRole('button', { name: /^Underline/ }).click()
    await page.waitForTimeout(300)
    await shot(page, 'zoom-200-formatting')

    await page.evaluate(() => {
      const s = (window as any).__fartcrobat.useApp
      s.setState({ prefs: { ...s.getState().prefs, theme: 'dark' } })
    })
    await page.waitForTimeout(300)
    await shot(page, 'dark-editing')
    await page.locator('.fc-edit-text-mini').getByRole('button', { name: /^Done/ }).click()
    await expect(editor(page)).toHaveCount(0)
    await expect.poll(async () => (await spanAt(page, 'Hello Fartcrobat'))?.font).toBe('Helvetica-Bold')
    await page.waitForTimeout(600)
    await shot(page, 'dark-after')
  } finally {
    await app.close()
  }
})
