import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, runCommand, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/protect-optimize-${name}.png` })

/** Makes the native Save dialog return `path` without showing it. */
async function stubSaveDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: p })) as any
  }, path)
}

async function openPath(page: Page, path: string) {
  await page.evaluate((p) => void (window as any).__fartcrobat.openPaths([p]), path)
}

async function docInfo(page: Page) {
  return page.evaluate(() => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    return d ? { encryption: d.state.info.encryption as string | null, permissions: d.state.info.permissions, filePath: d.state.filePath as string | null } : null
  })
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    const { useApp } = (window as any).__fartcrobat
    useApp.setState({ prefs: { ...useApp.getState().prefs, theme: t } })
  }, theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

/** Runs a command without waiting for it to finish (commands that open dialogs wait for them). */
async function fire(page: Page, id: string) {
  await page.evaluate((c) => void (window as any).__fartcrobat.runCommand(c), id)
}

/** A dialog by its title (the dialog frame has no accessible name). */
function dialogTitled(page: Page, title: string) {
  return page.locator('.ui-dialog').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
}

async function openToolFromAllTools(page: Page, label: string) {
  const backButton = page.getByRole('button', { name: 'Back to all tools' })
  if (await backButton.isVisible().catch(() => false)) await backButton.click()
  await page.locator('.shell-alltools-item', { hasText: label }).click()
}

test('protect using password, reopen asks for it; restrictions, copy blocking and remove security', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-po-e2e-'))
  const src = join(dir, 'text.pdf')
  copyFileSync(fixturePath('text.pdf'), src)
  const protectedPath = join(dir, 'text-protected.pdf')
  const { app, page } = await launch()
  try {
    await openPath(page, src)
    await waitForRender(page)

    // ---- Protect a PDF panel from All tools
    await openToolFromAllTools(page, 'Protect a PDF')
    await expect(page.getByTestId('security-status')).toContainText('Not protected')
    await shot(page, 'panel-unprotected')

    await page.getByRole('button', { name: /Protect using password/ }).click()
    const dialog = dialogTitled(page, 'Protect using password')
    await expect(dialog).toBeVisible()
    // focus starts in the password field: type with the keyboard
    await expect(page.getByTestId('protect-open-password')).toBeFocused()
    await page.keyboard.type('a,b')
    await expect(dialog.getByText('Passwords can’t contain commas (,).')).toBeVisible()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('abc')
    await expect(dialog.getByText('Password strength: Weak')).toBeVisible()
    // mismatched confirmation is reported on Apply
    await page.getByTestId('protect-open-confirm').fill('abd')
    await page.getByTestId('protect-apply').click()
    await expect(dialog.getByText('The passwords don’t match.')).toBeVisible()
    await page.getByTestId('protect-open-confirm').fill('abc')
    await shot(page, 'dialog')

    await stubSaveDialog(app, protectedPath)
    await page.getByTestId('protect-apply').click()
    const done = dialogTitled(page, 'Your PDF is protected')
    await expect(done).toBeVisible()
    await expect(done).toContainText('Opening it needs the password you set.')
    await shot(page, 'protected-summary')
    await done.getByRole('button', { name: 'OK', exact: true }).click()

    expect(existsSync(protectedPath)).toBe(true)
    await expect(page.getByTestId('security-badge')).toBeVisible()
    await expect(page.getByTestId('security-status')).toContainText('256-bit AES')
    const st = await activeDocState(page)
    expect(st?.title).toBe('text-protected.pdf')
    expect(st?.dirty).toBe(false)
    await waitForRender(page)
    await shot(page, 'panel-protected')

    // ---- reopen: the password prompt appears
    await runCommand(page, 'file.close')
    await expect(page.locator('.home-title')).toBeVisible()
    await openPath(page, protectedPath)
    const pw = dialogTitled(page, 'Password required')
    await expect(pw).toBeVisible()
    await expect(pw).toContainText('is protected')
    await shot(page, 'password-prompt')
    await page.keyboard.type('wrong')
    await page.keyboard.press('Enter')
    await expect(pw).toContainText('incorrect')
    await page.keyboard.press('Control+A')
    await page.keyboard.type('abc')
    await page.keyboard.press('Enter')
    await waitForRender(page)
    expect((await docInfo(page))?.encryption).toMatch(/256-bit AES/)
    await runCommand(page, 'file.close')

    // ---- Restrict editing (no open password) on the original file
    await openPath(page, src)
    await waitForRender(page)
    const restrictedPath = join(dir, 'text-restricted.pdf')
    await fire(page, 'protect.restrictEditing')
    const rd = dialogTitled(page, 'Restrict editing')
    await expect(rd).toBeVisible()
    await expect(page.getByTestId('protect-perms-password')).toBeFocused()
    await page.keyboard.type('perm-pw')
    await page.getByTestId('protect-perms-confirm').fill('perm-pw')
    await rd.getByLabel('Printing allowed').selectOption('low')
    await rd.getByLabel('Changes allowed').selectOption('comments')
    await shot(page, 'restrict-dialog')
    await stubSaveDialog(app, restrictedPath)
    await page.getByTestId('protect-apply').click()
    const done2 = dialogTitled(page, 'Your PDF is protected')
    await expect(done2).toContainText('copying text and images')
    await done2.getByRole('button', { name: 'OK', exact: true }).click()
    // the author keeps full access in this session
    await expect(page.getByTestId('restricted-bar')).toHaveCount(0)
    await runCommand(page, 'file.close')

    // reopening restricted file: no password, but a message bar and restrictions
    await openPath(page, restrictedPath)
    await waitForRender(page)
    await expect(page.getByTestId('restricted-bar')).toBeVisible()
    await expect(page.getByTestId('restricted-bar')).toContainText('This document has restricted permissions')
    const info = await docInfo(page)
    expect(info?.permissions).toMatchObject({ copy: false, print: true, 'print-hq': false, annotate: true, edit: false })

    // copying is blocked with a message
    await runCommand(page, 'edit.selectAll')
    await expect.poll(async () => (await activeDocState(page))?.selection.kind).toBe('text')
    await page.keyboard.press('Control+C')
    await expect(page.locator('.toast', { hasText: 'Copying is not allowed' })).toBeVisible()
    await shot(page, 'restricted-bar')

    // the panel lists what is restricted
    await page.getByTestId('security-badge').click()
    await expect(page.getByTestId('security-permissions')).toContainText('Low resolution only')
    await shot(page, 'panel-restricted')
    await setTheme(page, 'dark')
    await shot(page, 'panel-restricted-dark')
    await setTheme(page, 'light')

    // the permissions password lifts the restrictions
    await page.getByTestId('restricted-bar').getByRole('button', { name: 'Enter password…' }).click()
    const unlock = dialogTitled(page, 'Permissions password')
    await expect(unlock).toBeVisible()
    await page.keyboard.type('nope')
    await page.keyboard.press('Enter')
    await expect(unlock).toContainText('not correct')
    await page.keyboard.press('Control+A')
    await page.keyboard.type('perm-pw')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('restricted-bar')).toHaveCount(0)
    expect((await docInfo(page))?.permissions.copy).toBe(true)

    // ---- Remove security (saves the file without security)
    await page.getByRole('button', { name: /Remove security/ }).click()
    const rm = dialogTitled(page, 'Remove security')
    await expect(rm).toBeVisible()
    await shot(page, 'remove-confirm')
    await rm.getByRole('button', { name: 'Remove Security' }).click()
    await expect(page.locator('.toast', { hasText: 'Security removed' })).toBeVisible()
    await expect(page.getByTestId('security-badge')).toHaveCount(0)
    await expect(page.getByTestId('security-status')).toContainText('Not protected')
    expect((await docInfo(page))?.encryption).toBeNull()
    await runCommand(page, 'file.close')
    await openPath(page, restrictedPath)
    await waitForRender(page)
    expect((await docInfo(page))?.encryption).toBeNull()
  } finally {
    await app.close()
  }
})

test('compress a PDF with a large image and see the size reduction', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fc-po-e2e-'))
  const src = join(dir, 'big-image.pdf')
  copyFileSync(fixturePath('protect-optimize/big-image.pdf'), src)
  const out = join(dir, 'big-image_compressed.pdf')
  const { app, page } = await launch()
  try {
    // Home tile
    await expect(page.locator('.home-tile', { hasText: 'Compress a PDF' })).toBeVisible()
    await openPath(page, src)
    await waitForRender(page)
    await openToolFromAllTools(page, 'Compress a PDF')
    await expect(page.getByTestId('compress-current-size')).toHaveText('1.3 MB')
    await expect(page.getByRole('radio', { name: /Medium/ })).toBeChecked()
    await expect(page.getByRole('radio', { name: /Save as a new file/ })).toBeChecked()
    await expect(page.getByText('big-image_compressed.pdf')).toBeVisible()
    await shot(page, 'compress-panel')

    await stubSaveDialog(app, out)
    await page.getByTestId('compress-run').click()
    const result = page.getByTestId('compress-result')
    await expect(result).toBeVisible({ timeout: 30000 })
    await expect(result).toContainText(/Reduced from 1\.3 MB to \d+(\.\d)? KB \(\d+% smaller\)/)
    await expect(result).toContainText('1 image downsampled')
    await shot(page, 'compress-result')
    expect(existsSync(out)).toBe(true)
    expect(statSync(out).size).toBeLessThan(statSync(src).size / 10)

    // the result opens fine
    await result.getByRole('button', { name: 'Open' }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('big-image_compressed.pdf')
    await waitForRender(page)
    await shot(page, 'compressed-opened')

    // back on the original: pick "Small size" with the keyboard and "Open in a new tab"
    await page.locator('.shell-tab', { hasText: 'big-image.pdf' }).first().click()
    await expect(page.getByTestId('compress-result')).toBeVisible()
    await page.getByRole('radio', { name: /Medium/ }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('radio', { name: /Small size/ })).toBeChecked()
    await page.getByRole('radio', { name: /Open in a new tab/ }).check()

    // Advanced optimization: sections, the space audit, and running it with custom settings
    await fire(page, 'compress.advanced')
    const adv = dialogTitled(page, 'Advanced optimization')
    await expect(adv).toBeVisible()
    await expect(adv.getByLabel('Settings')).toHaveValue('small')
    await adv.getByLabel('Settings').selectOption('medium')
    await adv.getByLabel('Color images: target resolution in ppi').fill('100')
    await expect(adv.getByLabel('Settings')).toHaveValue('custom')
    await shot(page, 'optimizer-images')
    await adv.getByRole('button', { name: 'Space usage' }).click()
    await expect(adv.getByTestId('space-audit')).toContainText('Images')
    await shot(page, 'optimizer-audit')
    await adv.getByRole('button', { name: 'Clean up' }).click()
    await expect(adv.getByText('Remove unused objects and merge duplicates')).toBeVisible()
    await shot(page, 'optimizer-cleanup')
    await adv.getByRole('button', { name: 'Discard user data' }).click()
    await expect(adv.getByText('Discard all comments')).toBeVisible()
    await adv.getByRole('button', { name: 'Discard objects' }).click()
    await adv.getByText('Discard bookmarks').click()
    await shot(page, 'optimizer-discard')
    await adv.getByRole('button', { name: 'Optimize', exact: true }).click()
    await expect(adv).toHaveCount(0)
    // the optimized copy opens as a new, unsaved tab
    await expect.poll(async () => page.locator('.shell-tab').count()).toBe(3)
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(true)
    expect((await activeDocState(page))?.title).toBe('big-image_compressed.pdf')
    await waitForRender(page)
    const optimized = await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const bytes: Uint8Array = await d.saveBytes({})
      return bytes.length
    })
    expect(optimized).toBeLessThan(statSync(src).size / 20)

    // dark theme
    await setTheme(page, 'dark')
    await page.locator('.shell-tab', { hasText: 'big-image.pdf' }).first().click()
    await expect(page.getByTestId('compress-result')).toBeVisible()
    await page.getByRole('radio', { name: /Medium/ }).check()
    await page.getByRole('radio', { name: /Save as a new file/ }).check()
    await shot(page, 'compress-dark')
    await fire(page, 'protect.encrypt')
    await expect(dialogTitled(page, 'Protect using password')).toBeVisible()
    await page.keyboard.type('Sunny-Day-2026!')
    await shot(page, 'dialog-dark')
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
})
