import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mupdf from 'mupdf'
import { activeDocState, fixturePath, launch, waitForRender } from './helpers'

// Files made from protected documents keep the protection, and their new tabs open without
// asking for the password again.

async function stubOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ ipcMain }, result) => {
    ipcMain.removeHandler('file:openDialog')
    ipcMain.handle('file:openDialog', () => result)
  }, paths)
}

/** Opens a protected file, typing its password in the prompt. */
async function openProtected(page: Page, path: string, password: string, title: string) {
  const opening = page.evaluate((p) => (window as any).__fartcrobat.openPaths([p]), path)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.keyboard.press('Enter')
  await opening
  await expect.poll(async () => (await activeDocState(page))?.title).toBe(title)
  await waitForRender(page)
}

/** Security of the active tab, and whether its engine reopens its own saved bytes without a password. */
async function activeSecurity(page: Page) {
  return page.evaluate(async () => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    const bytes = await d.saveBytes({})
    const reloaded = await d.core.doc.reload(bytes, {})
    return { encryption: d.state.info.encryption, copy: d.state.info.permissions.copy, reloaded: reloaded.ok }
  })
}

function fileSecurity(path: string, password: string) {
  const bytes = new Uint8Array(readFileSync(path))
  const doc = new mupdf.PDFDocument(bytes)
  return { encryption: doc.getMetaData('encryption'), needsPassword: doc.needsPassword(), auth: doc.authenticatePassword(password) }
}

/** Starts a command without waiting for it: commands that open a dialog finish when it closes. */
async function startCommand(page: Page, id: string) {
  await page.evaluate((c) => void (window as any).__fartcrobat.runCommand(c), id)
}

const passwordPrompt = (page: Page) => page.locator('.ui-dialog', { hasText: 'Password required' })

test('extract, split and combine keep the protection of their source', async () => {
  const { app, page } = await launch()
  try {
    await openProtected(page, fixturePath('encrypted.pdf'), 'secret', 'encrypted.pdf')

    // Extract to a new tab: protected, no second password prompt.
    await startCommand(page, 'organize.extract')
    await page.getByRole('dialog').getByRole('button', { name: 'Extract', exact: true }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('Pages from encrypted.pdf')
    await waitForRender(page)
    await expect(passwordPrompt(page)).toHaveCount(0)
    await expect(page.locator('.toast', { hasText: 'The new document keeps the protection of “encrypted.pdf”' })).toBeVisible()
    expect(await activeSecurity(page)).toEqual({ encryption: 'Standard V2 R3 128-bit RC4', copy: false, reloaded: true })
    await page.screenshot({ path: 'test-results/derived-protection-extract.png' })

    // Split a 256-bit AES document: every part needs its open password.
    await openProtected(page, fixturePath('derived-protection/aes256-open.pdf'), 'open-256', 'aes256-open.pdf')
    const outDir = mkdtempSync(join(tmpdir(), 'fartcrobat-derived-'))
    await stubOpenDialog(app, [outDir])
    await startCommand(page, 'organize.split')
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Pages per file').fill('2')
    await dialog.getByRole('button', { name: 'Change…' }).click()
    await expect(dialog.getByLabel('Output folder')).toHaveValue(outDir)
    await dialog.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(page.locator('.toast', { hasText: 'They keep the protection of “aes256-open.pdf”' })).toBeVisible()
    const parts = readdirSync(outDir).sort()
    expect(parts).toEqual(['aes256-open Part 1.pdf', 'aes256-open Part 2.pdf'])
    for (const p of parts) {
      expect(fileSecurity(join(outDir, p), 'open-256')).toEqual({
        encryption: 'Standard V5 R6 256-bit AES',
        needsPassword: true,
        auth: 2
      })
    }

    // Combine a plain and a protected file: the result has the protected file's security.
    await stubOpenDialog(app, [fixturePath('text.pdf'), fixturePath('encrypted.pdf')])
    await startCommand(page, 'combine.open')
    const combine = page.getByRole('dialog', { name: 'Combine Files' })
    await combine.getByRole('button', { name: 'Add files…' }).click()
    const prompt = passwordPrompt(page)
    await prompt.getByLabel('Password').fill('secret')
    await prompt.getByRole('button', { name: 'OK' }).click()
    await expect(combine.locator('.fc-organize-pages-combine-row')).toHaveCount(2)
    await expect(combine.locator('.fc-organize-pages-combine-thumb img')).toHaveCount(2)
    await combine.getByRole('button', { name: 'Combine', exact: true }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('Binder1.pdf')
    await waitForRender(page)
    await expect(passwordPrompt(page)).toHaveCount(0)
    await expect(page.locator('.toast', { hasText: 'It keeps the protection of “encrypted.pdf”' })).toBeVisible()
    expect((await activeDocState(page))?.pageCount).toBe(6)
    expect(await activeSecurity(page)).toEqual({ encryption: 'Standard V2 R3 128-bit RC4', copy: false, reloaded: true })
    await page.screenshot({ path: 'test-results/derived-protection-combine.png' })
  } finally {
    await app.close()
  }
})

test('the compare report keeps the protection of a protected document', async () => {
  const { app, page } = await launch()
  try {
    await app.evaluate(
      ({ ipcMain }, paths) => {
        ipcMain.removeHandler('file:openDialog')
        ipcMain.handle('file:openDialog', (_e, opts: { title?: string }) => [/old/i.test(opts?.title ?? '') ? paths.old : paths.new])
      },
      { old: fixturePath('derived-protection/contract-old-protected.pdf'), new: fixturePath('compare/contract-new.pdf') }
    )
    await page.locator('.home-tile', { hasText: 'Compare files' }).click()
    const host = page.locator('.fc-compare-home')
    await host.locator('.fc-compare-card').first().getByRole('button', { name: /Choose old file/i }).first().click()
    await page.getByRole('menuitem', { name: 'Browse…' }).click()
    const prompt = passwordPrompt(page)
    await prompt.getByLabel('Password').fill('old-open')
    await prompt.getByRole('button', { name: 'Open' }).click()
    await expect(host.locator('.fc-compare-card').first()).toContainText('contract-old-protected.pdf')
    await host.locator('.fc-compare-card').nth(1).getByRole('button', { name: /Choose new file/i }).first().click()
    await page.getByRole('menuitem', { name: 'Browse…' }).click()
    await expect(host.locator('.fc-compare-card').nth(1)).toContainText('contract-new.pdf')
    await host.locator('.fc-compare-landing').getByRole('button', { name: 'Compare', exact: true }).click()
    await expect(host.locator('.fc-compare-item').first()).toBeVisible()

    await page.locator('.shell-leftpane').getByRole('button', { name: 'Export report' }).click()
    await expect.poll(async () => (await activeDocState(page))?.title ?? '').toMatch(/^Compare report/)
    await waitForRender(page)
    await expect(passwordPrompt(page)).toHaveCount(0)
    await expect(page.locator('.toast', { hasText: 'It keeps the protection of “contract-old-protected.pdf”' })).toBeVisible()
    expect(await activeSecurity(page)).toEqual({ encryption: 'Standard V4 R4 128-bit AES', copy: true, reloaded: true })
    await page.screenshot({ path: 'test-results/derived-protection-compare-report.png' })
  } finally {
    await app.close()
  }
})
