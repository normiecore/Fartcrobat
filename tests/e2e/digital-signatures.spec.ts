import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

const SHOTS = 'test-results'
const PASSWORD = 'Signing-Pass-42'

/** Makes the native Save dialog return `path` (the main process handler is replaced). */
async function stubSaveDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ ipcMain }, p) => {
    ipcMain.removeHandler('file:saveDialog')
    ipcMain.handle('file:saveDialog', () => p)
  }, path)
}

/** CSS pixels per PDF point at 100% zoom. */
const PX_PER_PT = 96 / 72

/** Makes the native Open dialog return `paths`. */
async function stubOpenDialog(app: ElectronApplication, paths: string[]) {
  await app.evaluate(({ ipcMain }, p) => {
    ipcMain.removeHandler('file:openDialog')
    ipcMain.handle('file:openDialog', () => p)
  }, paths)
}

/** A .p12 Digital ID made by OpenSSL (another program), or null when OpenSSL is missing. */
function opensslDigitalId(dir: string, cn: string, password: string): string | null {
  try {
    const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
    run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '60', '-nodes', '-subj', `/CN=${cn}/O=Interop Ltd/C=DE`])
    run(['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-out', 'id.pfx', '-passout', `pass:${password}`])
    return join(dir, 'id.pfx')
  } catch {
    return null
  }
}

async function docInfo(page: Page) {
  return page.evaluate((k) => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    if (!d) return null
    const s = d.state
    // `scale`: CSS pixels per page point at the current zoom.
    return { title: s.title as string, filePath: s.filePath as string | null, dirty: s.dirty as boolean, zoom: s.zoom as number, scale: (s.zoom as number) * k }
  }, PX_PER_PT)
}

/** A modal dialog by its exact title. */
function dialog(page: Page, title: string) {
  return page.locator('.ui-dialog').filter({ has: page.locator('.ui-dialog-header h2').getByText(title, { exact: true }) })
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    const { useApp } = (window as any).__fartcrobat
    useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: t } }))
  }, theme)
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
}

/** Fills in and submits the "Create a Digital ID" dialog. */
async function fillCreateIdDialog(page: Page, name: string, email: string) {
  const dlg = dialog(page, 'Create a Digital ID')
  await expect(dlg).toBeVisible()
  await dlg.getByLabel('Name', { exact: true }).fill(name)
  await dlg.getByLabel('Email address').fill(email)
  await dlg.getByLabel('Organisation', { exact: true }).fill('Fartcrobat QA')
  await dlg.getByLabel('Country/Region').selectOption('US')
  await dlg.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await dlg.getByLabel('Confirm password').fill(PASSWORD)
  return dlg
}

test('create a Digital ID in Preferences, sign by dragging a box, validate and trust', async () => {
  const { app, page, userData } = await launch()
  const out = mkdtempSync(join(tmpdir(), 'fc-digsig-e2e-'))
  const signedPath = join(out, 'text_signed.pdf')
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)

    // --- Preferences > Digital IDs > Create Digital ID
    await runCommand(page, 'sign.manageDigitalIds')
    const prefs = dialog(page, 'Preferences')
    await expect(prefs.locator('.fc-digital-signatures-settings')).toBeVisible()
    await expect(prefs.getByText('No Digital IDs yet')).toBeVisible()
    await prefs.getByRole('button', { name: 'Create Digital ID…' }).click()
    const create = await fillCreateIdDialog(page, 'Jane Doe', 'jane@example.com')
    await expect(create.getByText('Strong')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/digital-signatures-create-id.png` })
    await create.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(create).toBeHidden({ timeout: 30_000 })
    const row = prefs.getByRole('row', { name: /Jane Doe/ })
    await expect(row).toBeVisible()
    await expect(row).toContainText('Self-signed')
    await expect(row).toContainText('RSA 2048-bit')
    // The .p12 file lives in the (throwaway) user data folder; the password is not stored anywhere.
    const idFiles = readdirSync(join(userData, 'digital-ids'))
    expect(idFiles.filter((f) => f.endsWith('.p12'))).toHaveLength(1)
    const settingsFile = join(userData, 'fartcrobat-settings.json')
    await expect.poll(() => (existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : '')).toContain('digital-signatures:ids')
    expect(readFileSync(settingsFile, 'utf8')).not.toContain(PASSWORD)
    await row.click()
    await expect(prefs.getByRole('button', { name: 'Export Certificate…' })).toBeEnabled()
    await page.screenshot({ path: `${SHOTS}/digital-signatures-prefs.png` })
    await prefs.getByRole('button', { name: 'Done' }).click()
    await expect(prefs).toBeHidden()

    // --- Use a certificate > Digitally sign, then drag a box on page 1
    await stubSaveDialog(app, signedPath)
    await runCommand(page, 'sign.useCertificate')
    const panel = page.locator('.ui-panel', { hasText: 'Use a certificate' })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('Jane Doe')).toBeVisible()
    await panel.getByRole('button', { name: /Digitally sign/ }).click()
    await expect(page.locator('.fc-digital-signatures-toolbar')).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/digital-signatures-tool.png` })
    const pageEl = page.locator('.viewer-page[data-page-index="0"]')
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.scrollToRect(0, [320, 620, 560, 700], { center: true }))
    await page.waitForTimeout(300)
    const box = (await pageEl.boundingBox())!
    const zoom = (await docInfo(page))!.scale
    // Box from (320,620) to (560,700) in page points (an empty area below the text).
    const p0 = { x: box.x + 320 * zoom, y: box.y + 620 * zoom }
    const p1 = { x: box.x + 560 * zoom, y: box.y + 700 * zoom }
    await page.mouse.move(p0.x, p0.y)
    await page.mouse.down()
    await page.mouse.move((p0.x + p1.x) / 2, (p0.y + p1.y) / 2, { steps: 4 })
    await expect(page.locator('.fc-digital-signatures-boxdraft')).toBeVisible()
    await page.mouse.move(p1.x, p1.y, { steps: 4 })
    await page.mouse.up()

    // --- Sign dialog: Digital ID, password, reason, live appearance preview
    const dlg = dialog(page, 'Sign with a Digital ID')
    await expect(dlg).toBeVisible()
    await expect(dlg.getByRole('radio', { name: 'Jane Doe' })).toBeChecked()
    await expect(dlg.getByLabel('Digital ID password')).toBeFocused()
    await dlg.getByRole('combobox', { name: 'Reason' }).fill('I have reviewed this document')
    await dlg.getByRole('textbox', { name: 'Location' }).fill('Springfield')
    await expect(dlg.locator('.fc-digital-signatures-preview img')).toBeVisible()
    // Wrong password first: the dialog explains and stays open.
    await dlg.getByLabel('Digital ID password').fill('wrong-password')
    await dlg.getByRole('button', { name: 'Sign', exact: true }).click()
    await expect(dlg.getByRole('alert')).toHaveText(/password is incorrect/)
    await dlg.getByLabel('Digital ID password').fill(PASSWORD)
    await page.waitForTimeout(400) // preview debounce
    await page.screenshot({ path: `${SHOTS}/digital-signatures-sign-dialog.png` })
    await dlg.getByLabel('Digital ID password').press('Enter')
    await expect(dlg).toBeHidden()

    // --- The tab now shows the signed copy written to the chosen path
    await expect.poll(async () => (await docInfo(page))?.filePath, { timeout: 30_000 }).toBe(signedPath)
    const info = (await docInfo(page))!
    expect(info.title).toBe('text_signed.pdf')
    expect(info.dirty).toBe(false)
    expect(existsSync(signedPath)).toBe(true)
    expect(readFileSync(signedPath).toString('latin1')).toContain('/ETSI.CAdES.detached')
    // The original file is untouched.
    expect(readFileSync(fixturePath('text.pdf')).toString('latin1')).not.toContain('/ByteRange')

    const bar = page.locator('.fc-digital-signatures-bar')
    await expect(bar).toContainText("Signed and all signatures are valid, but the signer's identity is unknown.")
    const rightPanel = page.locator('aside.shell-rightpanel[aria-label="Signatures"]')
    await expect(rightPanel).toBeVisible()
    const entry = rightPanel.locator('.fc-digital-signatures-entry')
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText('Signed by Jane Doe')
    await expect(entry).toContainText("Signature is valid, but the signer's identity is unknown.")
    await entry.getByRole('button', { name: /Expand Signature1/ }).click()
    await expect(entry).toContainText('The document has not been modified since this signature was applied.')
    await expect(entry).toContainText('I have reviewed this document')

    // The signature field overlay sits exactly on the box that was drawn (page space -> CSS px).
    const field = page.locator('.viewer-page[data-page-index="0"] .fc-digital-signatures-field.is-signed')
    await expect(field).toHaveCount(1)
    await waitForRender(page)
    const checkOverlay = async () => {
      const z = (await docInfo(page))!.scale
      const pb = (await pageEl.boundingBox())!
      const fb = (await field.boundingBox())!
      expect(Math.abs(fb.x - (pb.x + 320 * z))).toBeLessThan(2)
      expect(Math.abs(fb.y - (pb.y + 620 * z))).toBeLessThan(2)
      expect(Math.abs(fb.width - 240 * z)).toBeLessThan(2)
      expect(Math.abs(fb.height - 80 * z)).toBeLessThan(2)
    }
    await checkOverlay()
    await page.locator('.viewer-page[data-page-index="0"] .fc-digital-signatures-field.is-signed').scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/digital-signatures-signed.png` })
    await field.screenshot({ path: `${SHOTS}/digital-signatures-appearance.png` })

    // Another zoom level: the overlay follows.
    await runCommand(page, 'view.actualSize')
    await expect.poll(async () => (await docInfo(page))?.zoom).toBeCloseTo(1, 2)
    await field.scrollIntoViewIfNeeded()
    await page.waitForTimeout(400)
    await checkOverlay()
    await field.screenshot({ path: `${SHOTS}/digital-signatures-appearance-100.png` })

    // --- Signature Properties > Trust This Signer -> the identity becomes known
    await field.click()
    const props = dialog(page, 'Signature Properties')
    await expect(props).toBeVisible()
    await expect(props).toContainText("Signature is valid, but the signer's identity is unknown.")
    await expect(props).toContainText('Springfield')
    await page.screenshot({ path: `${SHOTS}/digital-signatures-properties.png` })
    await props.getByRole('button', { name: "Show Signer's Certificate…" }).click()
    const viewer = dialog(page, 'Certificate Viewer')
    await expect(viewer).toContainText('CN=Jane Doe')
    await expect(viewer).toContainText('SHA-256 fingerprint')
    await expect(viewer).toContainText('Non-repudiation')
    await page.screenshot({ path: `${SHOTS}/digital-signatures-certificate.png` })
    await viewer.getByRole('button', { name: 'Close' }).last().click()
    await props.getByRole('button', { name: 'Trust This Signer' }).click()
    await expect(props).toContainText('Signature is valid.')
    await expect(props.getByRole('button', { name: 'Trust This Signer' })).toHaveCount(0)
    await props.getByRole('button', { name: 'Close' }).last().click()
    await expect(bar).toContainText('Signed and all signatures are valid.')
    await expect(entry).toContainText("The signer's identity is valid.")
    await expect.poll(() => readFileSync(settingsFile, 'utf8')).toContain('digital-signatures:trusted')

    // --- Dark theme
    await setTheme(page, 'dark')
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/digital-signatures-dark.png` })
    await runCommand(page, 'sign.useCertificate')
    await page.locator('.ui-panel', { hasText: 'Use a certificate' }).getByRole('button', { name: /Digitally sign/ }).click()
    // A click (no drag) makes a standard-size (180 x 54 pt) box on page 2, top-left at the click.
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.scrollToRect(1, [300, 600, 560, 720], { center: true }))
    await page.waitForTimeout(300)
    const page2 = page.locator('.viewer-page[data-page-index="1"]')
    const b2 = (await page2.boundingBox())!
    const z2 = (await docInfo(page))!.scale
    const stubbed2 = join(out, 'text_signed_twice.pdf')
    await stubSaveDialog(app, stubbed2)
    await page.mouse.click(b2.x + 330 * z2, b2.y + 640 * z2)
    const dlg2 = dialog(page, 'Sign with a Digital ID')
    await expect(dlg2).toBeVisible()
    await dlg2.getByLabel('Digital ID password').fill(PASSWORD)
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/digital-signatures-sign-dialog-dark.png` })
    await dlg2.getByRole('button', { name: 'Sign', exact: true }).click()
    await expect.poll(async () => (await docInfo(page))?.filePath, { timeout: 30_000 }).toBe(stubbed2)
    await expect(rightPanel.locator('.fc-digital-signatures-entry')).toHaveCount(2)
    await expect(bar).toContainText('Signed and all signatures are valid.')
    await expect(rightPanel.locator('.fc-digital-signatures-entry').first()).toContainText('Rev. 1: Signed by Jane Doe')
    await expect(rightPanel.locator('.fc-digital-signatures-entry').last()).toContainText('Rev. 2: Signed by Jane Doe')
    const field2 = page.locator('.viewer-page[data-page-index="1"] .fc-digital-signatures-field.is-signed')
    await expect(field2).toHaveCount(1)
    const fb2 = (await field2.boundingBox())!
    const pb2 = (await page2.boundingBox())!
    expect(Math.abs(fb2.x - (pb2.x + 330 * z2))).toBeLessThan(2)
    expect(Math.abs(fb2.width - 180 * z2)).toBeLessThan(2)
    expect(Math.abs(fb2.height - 54 * z2)).toBeLessThan(2)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/digital-signatures-dark-panel.png` })

    // --- View Signed Version of the first signature opens the earlier revision in a new tab
    const first = rightPanel.locator('.fc-digital-signatures-entry').first()
    await first.getByRole('button', { name: 'Signature options' }).click()
    await page.getByRole('menuitem', { name: 'View Signed Version' }).click()
    await expect.poll(async () => (await activeDocState(page))?.title).toMatch(/signed version, rev\. 1/)
    expect((await activeDocState(page))?.dirty).toBe(false)
    await expect(page.locator('.fc-digital-signatures-entry')).toHaveCount(1)
    await expect(page.locator('.fc-digital-signatures-bar')).toContainText('Signed and all signatures are valid.')
    await setTheme(page, 'light')
  } finally {
    await app.close()
  }
})

test('sign an existing signature field, creating the Digital ID from the sign dialog; tampering is detected', async () => {
  const { app, page } = await launch()
  const out = mkdtempSync(join(tmpdir(), 'fc-digsig-e2e-'))
  const signedPath = join(out, 'approved.pdf')
  try {
    await openFile(page, fixturePath('digital-signatures/unsigned-field.pdf'))
    await waitForRender(page)
    await stubSaveDialog(app, signedPath)
    // A handwritten signature saved by Fill & Sign (an SVG drawing) shows up as "My signature".
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="100" viewBox="0 0 300 100"><path d="M10 70 C 40 10, 60 10, 70 60 S 110 90, 130 40 S 170 20, 190 60 S 240 80, 290 30" fill="none" stroke="#1a2a80" stroke-width="6" stroke-linecap="round"/></svg>'
    await page.evaluate(
      (url) => (window as any).api.invoke('store:set', 'fill-sign:signature', { dataUrl: url }),
      'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64')
    )
    // Unsigned field: the panel lists it, the page shows a clickable field.
    await runCommand(page, 'sign.showSignaturesPanel')
    const rightPanel = page.locator('aside.shell-rightpanel[aria-label="Signatures"]')
    await expect(rightPanel.locator('.fc-digital-signatures-entry.is-unsigned')).toContainText('Approver')
    const fieldEl = page.locator('.viewer-page[data-page-index="0"] .fc-digital-signatures-field.is-unsigned')
    await expect(fieldEl).toHaveCount(1)
    await fieldEl.hover()
    await expect(fieldEl).toContainText('Click to sign')
    await page.screenshot({ path: `${SHOTS}/digital-signatures-unsigned-field.png` })
    await fieldEl.click()
    const dlg = dialog(page, 'Sign with a Digital ID')
    await expect(dlg).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dlg).toBeHidden()

    // forms-fill asks to sign a field with a window event; the same dialog opens.
    await page.evaluate(() => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      window.dispatchEvent(new CustomEvent('fartcrobat:sign-field', { detail: { docId: d.id, fieldName: 'Approver', page: 0 } }))
    })
    await expect(dlg).toBeVisible()
    await expect(dlg.getByText("You don't have a Digital ID yet.")).toBeVisible()
    await expect(dlg.locator('.fc-digital-signatures-preview img')).toBeVisible()
    await expect(dlg.getByRole('radio', { name: 'My signature', exact: true })).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/digital-signatures-no-id.png` })
    await dlg.getByRole('button', { name: 'Create a Digital ID' }).click()
    const create = await fillCreateIdDialog(page, 'Ana Approver', 'ana@example.com')
    await create.getByText('ECDSA P-256').click()
    await create.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(create).toBeHidden({ timeout: 30_000 })
    await expect(dlg.getByRole('radio', { name: 'Ana Approver' })).toBeChecked()
    await expect(dlg.getByLabel('Digital ID password')).toHaveValue(PASSWORD)
    await expect(dlg).toContainText('ECDSA P-256')
    await dlg.getByRole('combobox', { name: 'Reason' }).fill('I am approving this document')
    await dlg.getByRole('checkbox', { name: 'Labels' }).uncheck()
    await dlg.getByRole('radio', { name: 'My signature', exact: true }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/digital-signatures-field-dialog.png` })
    await dlg.getByRole('button', { name: 'Sign', exact: true }).click()
    await expect.poll(async () => (await docInfo(page))?.filePath, { timeout: 30_000 }).toBe(signedPath)
    const entry = rightPanel.locator('.fc-digital-signatures-entry')
    await expect(entry).toHaveCount(1)
    await expect(entry).toContainText('Signed by Ana Approver')
    await expect(entry).toContainText("Signature is valid, but the signer's identity is unknown.")
    const signedField = page.locator('.viewer-page[data-page-index="0"] .fc-digital-signatures-field.is-signed')
    await expect(signedField).toHaveCount(1)
    await page.waitForTimeout(300)
    await signedField.screenshot({ path: `${SHOTS}/digital-signatures-field-appearance.png` })

    // Tamper with one byte inside the signed range and open the copy: the signature is invalid.
    const bytes = readFileSync(signedPath)
    const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)/.exec(bytes.toString('latin1'))!
    const pos = Math.floor(Number(m[2]) / 3)
    bytes[pos] = bytes[pos] === 0x20 ? 0x0a : 0x20
    const tamperedPath = join(out, 'tampered.pdf')
    writeFileSync(tamperedPath, bytes)
    await openFile(page, tamperedPath)
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('tampered.pdf')
    await expect(page.locator('.fc-digital-signatures-bar')).toContainText('At least one signature is invalid.')
    await expect(page.locator('.fc-digital-signatures-entry')).toContainText('Signature is invalid.')
    await page.locator('.fc-digital-signatures-entry').getByRole('button', { name: /Expand/ }).click()
    await expect(page.locator('.fc-digital-signatures-entry')).toContainText('altered or corrupted')
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/digital-signatures-tampered.png` })
  } finally {
    await app.close()
  }
})

test('certify a form with an invisible signature that allows form filling', async () => {
  const { app, page } = await launch()
  const out = mkdtempSync(join(tmpdir(), 'fc-digsig-e2e-'))
  const certifiedPath = join(out, 'form_certified.pdf')
  try {
    await openFile(page, fixturePath('form.pdf'))
    await waitForRender(page)
    await stubSaveDialog(app, certifiedPath)
    await runCommand(page, 'sign.useCertificate')
    const panel = page.locator('.ui-panel', { hasText: 'Use a certificate' })
    await panel.getByRole('button', { name: /Certify \(invisible signature\)/ }).click()
    const dlg = dialog(page, 'Certify with a Digital ID (invisible)')
    await expect(dlg).toBeVisible()
    // Import a .pfx made by another program (OpenSSL) when available, otherwise create an ID.
    const pfx = opensslDigitalId(out, 'Carl Certifier', 'imported-pw')
    if (pfx) {
      await stubOpenDialog(app, [pfx])
      await dlg.getByRole('button', { name: 'Import from file' }).click()
      const imp = dialog(page, 'Import a Digital ID')
      await expect(imp).toContainText('id.pfx')
      await imp.getByLabel('Digital ID password').fill('wrong')
      await imp.getByRole('button', { name: 'Import', exact: true }).click()
      await expect(imp.getByRole('alert')).toHaveText(/password is incorrect/)
      await imp.getByLabel('Digital ID password').fill('imported-pw')
      await page.screenshot({ path: `${SHOTS}/digital-signatures-import.png` })
      await imp.getByRole('button', { name: 'Import', exact: true }).click()
      await expect(imp).toBeHidden()
      await expect(dlg.getByRole('radio', { name: 'Carl Certifier' })).toBeChecked()
      await expect(dlg).toContainText('Self-signed')
    } else {
      await dlg.getByRole('button', { name: 'Create a Digital ID' }).click()
      const create = await fillCreateIdDialog(page, 'Carl Certifier', 'carl@example.com')
      await create.getByRole('button', { name: 'Create', exact: true }).click()
      await expect(create).toBeHidden({ timeout: 30_000 })
    }
    await dlg.getByLabel('Allowed after certifying').selectOption('2')
    await page.screenshot({ path: `${SHOTS}/digital-signatures-certify-dialog.png` })
    await dlg.getByRole('button', { name: 'Certify', exact: true }).click()
    await expect.poll(async () => (await docInfo(page))?.filePath, { timeout: 30_000 }).toBe(certifiedPath)
    const bar = page.locator('.fc-digital-signatures-bar')
    await expect(bar).toContainText('Certified by Carl Certifier. Filling in forms and signing are allowed.')
    const entry = page.locator('.fc-digital-signatures-entry')
    await expect(entry).toContainText('Certified by Carl Certifier')
    await expect(entry).toContainText("Certification is valid, but the signer's identity is unknown.")
    // Certify rows are disabled now that the document is certified.
    await expect(panel.getByRole('button', { name: /Certify \(visible signature\)/ })).toBeDisabled()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/digital-signatures-certified.png` })
  } finally {
    await app.close()
  }
})

test('certify with a visible signature placed from the keyboard; no changes allowed', async () => {
  const { app, page } = await launch()
  const out = mkdtempSync(join(tmpdir(), 'fc-digsig-e2e-'))
  const certifiedPath = join(out, 'text_certified.pdf')
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await stubSaveDialog(app, certifiedPath)
    await runCommand(page, 'sign.useCertificate')
    const panel = page.locator('.ui-panel', { hasText: 'Use a certificate' })
    await panel.getByRole('button', { name: /Certify \(visible signature\)/ }).click()
    const place = page.getByRole('button', { name: 'Place at bottom of page' })
    await place.focus()
    await page.keyboard.press('Enter')
    const dlg = dialog(page, 'Certify with a Digital ID')
    await expect(dlg).toBeVisible()
    await dlg.getByRole('button', { name: 'Create a Digital ID' }).click()
    const create = await fillCreateIdDialog(page, 'Carl Certifier', 'carl@example.com')
    await create.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(create).toBeHidden({ timeout: 30_000 })
    await dlg.getByLabel('Allowed after certifying').selectOption('1')
    await expect(dlg.locator('.fc-digital-signatures-preview img')).toBeVisible()
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${SHOTS}/digital-signatures-certify-visible-dialog.png` })
    await dlg.getByRole('button', { name: 'Certify', exact: true }).click()
    await expect.poll(async () => (await docInfo(page))?.filePath, { timeout: 30_000 }).toBe(certifiedPath)
    await expect(page.locator('.fc-digital-signatures-bar')).toContainText('Certified by Carl Certifier. No changes are allowed.')
    // Bottom-right of page 1, clear of the footer.
    const field = page.locator('.viewer-page[data-page-index="0"] .fc-digital-signatures-field.is-signed')
    await expect(field).toHaveCount(1)
    const pb = (await page.locator('.viewer-page[data-page-index="0"]').boundingBox())!
    const fb = (await field.boundingBox())!
    expect(fb.x + fb.width).toBeLessThan(pb.x + pb.width)
    expect(fb.x + fb.width).toBeGreaterThan(pb.x + pb.width * 0.9)
    expect(fb.y + fb.height).toBeGreaterThan(pb.y + pb.height * 0.8)
    expect(fb.y + fb.height).toBeLessThan(pb.y + pb.height)
    // Nothing else can be signed now.
    await expect(panel.getByRole('button', { name: /Digitally sign/ })).toBeDisabled()
    await page.locator('.fc-digital-signatures-entry').getByRole('button', { name: /Expand/ }).click()
    await expect(page.locator('.fc-digital-signatures-entry')).toContainText('The document is certified. No changes are allowed.')
    await field.scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/digital-signatures-certified-visible.png` })
  } finally {
    await app.close()
  }
})
