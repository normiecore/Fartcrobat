import { expect, test, type Page } from '@playwright/test'
import { activeDocState, fixturePath, launch, menuItem, openFile, runCommand, waitForRender } from './helpers'

function appState(page: Page) {
  return page.evaluate(() => {
    const s = (window as any).__fartcrobat.useApp.getState()
    return { readMode: s.readMode, paletteOpen: s.paletteOpen, toolId: s.toolId, findBarOpen: s.findBarOpen, docs: s.docs.length, dialogs: s.dialogs.length }
  })
}

test('Ctrl shortcuts work with a non-Latin keyboard layout', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    // Ctrl+F on a Russian layout: the key reports "а", the physical key is still KeyF.
    const handled = await page.evaluate(() => {
      const e = new KeyboardEvent('keydown', { key: 'а', code: 'KeyF', ctrlKey: true, bubbles: true, cancelable: true })
      document.body.dispatchEvent(e)
      return e.defaultPrevented
    })
    expect(handled).toBe(true)
    await expect.poll(async () => (await appState(page)).findBarOpen).toBe(true)
  } finally {
    await app.close()
  }
})

test('Escape that closes the palette or a menu does nothing else', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await runCommand(page, 'view.readMode')
    await runCommand(page, 'app.commandPalette')
    await expect(page.getByPlaceholder('Find text or tools')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await appState(page)).paletteOpen).toBe(false)
    expect((await appState(page)).readMode).toBe(true)

    await page.evaluate(() => (window as any).__fartcrobat.useApp.setState({ readMode: false }))
    await runCommand(page, 'tools.hand')
    await page.locator('.shell-menu-btn').click()
    await expect(page.locator('.ui-menu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.ui-menu')).toHaveCount(0)
    expect((await appState(page)).toolId).toBe('hand')

    // With nothing left to close, Escape still resets the tool.
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await appState(page)).toolId).toBe('select')
  } finally {
    await app.close()
  }
})

test('Escape closes the innermost popup first and nothing else sees it', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await runCommand(page, 'tools.hand')
    // Stands in for a tool's own Escape handling, listening since before any popup opened.
    await page.evaluate(() => {
      ;(window as any).__escapes = 0
      window.addEventListener('keydown', (e) => e.key === 'Escape' && (window as any).__escapes++, true)
    })
    const escapesSeen = () => page.evaluate(() => (window as any).__escapes as number)

    await page.locator('.shell-menu-btn').click()
    await menuItem(page, /^View$/).hover()
    await expect(page.locator('.ui-submenu')).toBeVisible()

    // A context menu opened over the menu closes alone.
    await page.evaluate(() =>
      (window as any).__fartcrobat.useApp.setState({ contextMenu: { x: 300, y: 300, items: [{ id: 'only', label: 'Only item' }] } })
    )
    await expect(menuItem(page, 'Only item')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menuItem(page, 'Only item')).toHaveCount(0)
    await expect(page.locator('.ui-submenu')).toBeVisible()
    expect(await escapesSeen()).toBe(0)

    // A dialog opened over the menu keeps its Escape.
    await page.evaluate(() => void (window as any).__fartcrobat.runCommand('app.preferences'))
    await expect(page.locator('.ui-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.ui-dialog')).toHaveCount(0)
    await expect(menuItem(page, /^View$/)).toBeVisible()

    // The menu closes with its submenu.
    const seen = await escapesSeen()
    await page.keyboard.press('Escape')
    await expect(page.locator('.ui-menu')).toHaveCount(0)
    expect(await escapesSeen()).toBe(seen)
    expect((await appState(page)).toolId).toBe('hand')

    // The next Escape leaves the tool.
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await appState(page)).toolId).toBe('select')
    expect(await escapesSeen()).toBe(seen + 1)
  } finally {
    await app.close()
  }
})

test('arrow keys on a focused slider or radio move the control, not the page', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.evaluate(() => {
      const host = document.createElement('div')
      host.id = 'shell-probe-controls'
      host.innerHTML =
        '<input id="probe-range" type="range" min="0" max="10" value="5">' +
        '<div role="radiogroup"><button id="probe-radio" role="radio" aria-checked="true">A</button></div>'
      document.body.appendChild(host)
    })
    await page.focus('#probe-range')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('End')
    expect(await page.inputValue('#probe-range')).toBe('10')
    await page.focus('#probe-radio')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)
    expect((await activeDocState(page))?.currentPage).toBe(0)

    // Outside such controls the arrow keys still turn pages.
    await page.evaluate(() => (document.activeElement as HTMLElement).blur())
    await page.keyboard.press('ArrowRight')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(1)
  } finally {
    await app.close()
  }
})

test('Alt+Arrow inside a text field does not run Previous/Next View', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await runCommand(page, 'nav.last')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(4)
    await runCommand(page, 'edit.find')
    const input = page.getByLabel('Find in document')
    await input.fill('page')
    await input.press('Alt+ArrowLeft')
    await page.waitForTimeout(300)
    expect((await activeDocState(page))?.currentPage).toBe(4)
  } finally {
    await app.close()
  }
})

test('shortcuts are blocked while the progress modal is up', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await page.evaluate(() => (window as any).__fartcrobat.useApp.setState({ progress: { title: 'Working…', fraction: null } }))
    await page.keyboard.press('Control+w')
    await page.keyboard.press('Control+o')
    await page.waitForTimeout(300)
    const st = await appState(page)
    expect(st.docs).toBe(1)
    expect(st.dialogs).toBe(0)
    // Native menu commands are ignored too.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', 'file.close'))
    await page.waitForTimeout(300)
    expect((await appState(page)).docs).toBe(1)
  } finally {
    await app.close()
  }
})

test('Ctrl+Shift+N goes to a page, as in Acrobat', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await page.keyboard.press('Control+Shift+N')
    const dialog = page.locator('.ui-dialog', { has: page.locator('h2', { hasText: 'Go to page' }) })
    await expect(dialog).toBeVisible()
    await page.screenshot({ path: 'test-results/core-shell-go-to-page.png' })
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    expect(app.windows().length).toBe(1)
    // And it goes to the page typed.
    await page.keyboard.press('Control+Shift+N')
    await page.keyboard.press('Control+a')
    await page.keyboard.type('4')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await activeDocState(page))?.currentPage).toBe(3)
    expect(app.windows().length).toBe(1)
  } finally {
    await app.close()
  }
})
