import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/forms-fill-${name}.png` })

/** The overlay control of a field (the first widget when a field has several). */
const field = (page: Page, name: string) => page.locator(`.fc-forms-fill-layer [data-field-name="${name}"]`).first()

/** Field values straight from the document (what Save writes). */
async function values(page: Page): Promise<Record<string, string | string[]>> {
  return page.evaluate(async () => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    const list: { name: string; value: string | string[] }[] = await d.ops('forms-fill').exportValues()
    return Object.fromEntries(list.map((f) => [f.name, f.value]))
  })
}

async function valueOf(page: Page, name: string) {
  return (await values(page))[name]
}

/** Runs a command without waiting for it (for commands that open a dialog and wait for an answer). */
async function startCommand(page: Page, id: string) {
  await page.evaluate((c) => {
    void (window as any).__fartcrobat.runCommand(c)
  }, id)
}

async function stubSaveDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as any).showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, path)
}

async function stubOpenDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ dialog }, p) => {
    ;(dialog as any).showOpenDialog = async () => ({ canceled: false, filePaths: [p] })
  }, path)
}

function tempCopy(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fc-forms-fill-'))
  const path = join(dir, name.split('/').pop()!)
  copyFileSync(fixturePath(name), path)
  return { dir, path }
}

/** Clicks an empty spot of the page so the focused field commits. */
async function clickOutside(page: Page) {
  const pageEl = page.locator('.viewer-page[data-page-index="0"]')
  const box = (await pageEl.boundingBox())!
  await pageEl.click({ position: { x: box.width - 40, y: 40 } })
}

test('fill form.pdf with the mouse and keyboard, save, reopen, clear and undo', async () => {
  const { dir, path } = tempCopy('form.pdf')
  const { app, page } = await launch()
  try {
    await openFile(page, path)
    await waitForRender(page)

    // The document message bar
    const bar = page.locator('.fc-forms-fill-msgbar')
    await expect(bar).toContainText('This document contains interactive form fields.')
    await expect(bar.getByRole('button', { name: 'Highlight existing fields' })).toHaveAttribute('aria-pressed', 'true')
    await expect(bar).toContainText('1 required field left')
    await expect(page.locator('.fc-forms-fill-layer.is-highlighted')).toHaveCount(1)
    await expect(field(page, 'subscribe')).toHaveClass(/is-required/)
    await shot(page, '1-open')

    // Text: click, type, Tab to the next field
    await field(page, 'fullName').click()
    await expect(field(page, 'fullName')).toBeFocused()
    await page.keyboard.type('Ada Lovelace')
    await shot(page, '2-typing')
    await page.keyboard.press('Tab')
    await expect(field(page, 'email')).toBeFocused()
    await expect.poll(() => valueOf(page, 'fullName')).toBe('Ada Lovelace')
    await page.keyboard.type('ada@example.com')
    await page.keyboard.press('Tab')
    await expect(field(page, 'qty')).toBeFocused()
    await expect.poll(() => valueOf(page, 'email')).toBe('ada@example.com')
    await page.keyboard.press('Shift+Tab')
    await expect(field(page, 'email')).toBeFocused()
    // Enter in a single-line field commits and moves on
    await page.keyboard.press('End')
    await page.keyboard.type('.uk')
    await page.keyboard.press('Enter')
    await expect(field(page, 'qty')).toBeFocused()
    await expect.poll(() => valueOf(page, 'email')).toBe('ada@example.com.uk')
    // Escape cancels an edit
    await page.keyboard.type('99')
    await page.keyboard.press('Escape')
    await expect(field(page, 'qty')).not.toBeFocused()
    await expect.poll(() => valueOf(page, 'qty')).toBe('2')

    // Check box: click, then Space with the keyboard
    await field(page, 'subscribe').click()
    await expect.poll(() => valueOf(page, 'subscribe')).toBe('Yes')
    await expect(field(page, 'subscribe')).toBeFocused()
    await page.keyboard.press('Space')
    await expect.poll(() => valueOf(page, 'subscribe')).toBe('Off')
    await page.keyboard.press('Space')
    await expect.poll(() => valueOf(page, 'subscribe')).toBe('Yes')
    await expect(bar).not.toContainText('required field')

    // Radio button
    await page.locator('.fc-forms-fill-layer [data-field-name="plan"][data-on-state="pro"]').click()
    await expect.poll(() => valueOf(page, 'plan')).toBe('pro')
    await expect(page.locator('[data-field-name="plan"][data-on-state="pro"]')).toHaveAttribute('aria-checked', 'true')
    await expect(page.locator('[data-field-name="plan"][data-on-state="basic"]')).toHaveAttribute('aria-checked', 'false')

    // Combo box
    await field(page, 'country').selectOption('Japan')
    await expect.poll(() => valueOf(page, 'country')).toBe('Japan')

    // Multi-line text
    await field(page, 'notes').click()
    await page.keyboard.type('Line one')
    await page.keyboard.press('Enter')
    await page.keyboard.type('Line two')
    await expect(field(page, 'notes')).toHaveValue('Line one\nLine two')
    await clickOutside(page)
    await expect.poll(() => valueOf(page, 'notes')).toBe('Line one\nLine two')
    await page.waitForTimeout(400)
    await shot(page, '3-filled')
    let st = await activeDocState(page)
    expect(st?.dirty).toBe(true)
    expect(st?.journal.undoLabel).toBe('Fill Form Field')

    // Save As through a stubbed save dialog, close, reopen
    const saved = join(dir, 'form-filled.pdf')
    await stubSaveDialog(app, saved)
    await runCommand(page, 'file.saveAs')
    await expect.poll(async () => (await activeDocState(page))?.title).toBe('form-filled.pdf')
    expect((await activeDocState(page))?.dirty).toBe(false)
    expect(existsSync(saved)).toBe(true)
    await runCommand(page, 'file.close')
    await expect(page.locator('.home-title')).toBeVisible()
    await openFile(page, saved)
    await waitForRender(page)
    const reopened = await values(page)
    expect(reopened).toMatchObject({
      fullName: 'Ada Lovelace',
      email: 'ada@example.com.uk',
      qty: '2',
      subscribe: 'Yes',
      plan: 'pro',
      country: 'Japan',
      notes: 'Line one\nLine two'
    })
    await expect(field(page, 'fullName')).toHaveValue('Ada Lovelace')
    await expect(field(page, 'notes')).toHaveValue('Line one\nLine two')
    await shot(page, '4-reopened')

    // Clear form (asks first), then undo
    await bar.getByRole('button', { name: 'Clear form' }).click()
    const dialog = page.locator('.ui-dialog')
    await expect(dialog).toContainText('Clear all the fields')
    await dialog.getByRole('button', { name: 'Clear form' }).click()
    await expect.poll(() => valueOf(page, 'fullName')).toBe('')
    const cleared = await values(page)
    expect(cleared.email).toBe('')
    expect(cleared.notes).toBe('')
    expect(cleared.subscribe).toBe('Off')
    st = await activeDocState(page)
    expect(st?.journal.undoLabel).toBe('Clear Form')
    await expect(field(page, 'fullName')).toHaveValue('')
    await page.waitForTimeout(300)
    await shot(page, '5-cleared')
    await page.locator('.viewer-scroll').focus()
    await page.keyboard.press('Control+z')
    await expect.poll(() => valueOf(page, 'fullName')).toBe('Ada Lovelace')
    expect((await values(page)).plan).toBe('pro')
    await expect(field(page, 'fullName')).toHaveValue('Ada Lovelace')

    // Highlight existing fields toggles the highlight
    await bar.getByRole('button', { name: 'Highlight existing fields' }).click()
    await expect(bar.getByRole('button', { name: 'Highlight existing fields' })).toHaveAttribute('aria-pressed', 'false')
    await expect(page.locator('.fc-forms-fill-layer.is-highlighted')).toHaveCount(0)
    await page.waitForTimeout(300)
    await shot(page, '6-no-highlight')
    await runCommand(page, 'forms.highlightFields')
    await expect(page.locator('.fc-forms-fill-layer.is-highlighted')).toHaveCount(1)

    // The bar can be closed
    await bar.getByRole('button', { name: 'Close the message bar' }).click()
    await expect(bar).toHaveCount(0)
  } finally {
    await app.close()
  }
})

test('calculations, formats, keystroke filters and validation (calc.pdf)', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('forms-fill/calc.pdf'))
    await waitForRender(page)

    await field(page, 'amount1').click()
    // AFNumber_Keystroke blocks letters while typing
    await page.keyboard.type('10x0a0')
    await expect(field(page, 'amount1')).toHaveValue('1000')
    await page.keyboard.press('Tab')
    await expect(field(page, 'amount2')).toBeFocused()
    await page.keyboard.type('234.5')
    await page.keyboard.press('Tab')
    // Total and Net total are read-only: Tab skips them
    await expect(field(page, 'discount')).toBeFocused()
    await expect.poll(() => valueOf(page, 'total')).toBe('1234.5')
    // fields that are not being edited show their formatted value, like the appearance
    await expect(field(page, 'total')).toHaveValue('$1,234.50')
    await expect(field(page, 'amount1')).toHaveValue('$1,000.00')
    await expect(field(page, 'amount2')).toHaveValue('$234.50')
    // the stored value stays a plain number
    expect(await valueOf(page, 'amount1')).toBe('1000')
    // the whole edit (value, format and calculation) is one undo step
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Fill Form')

    // Custom calculation script: Net total = Total x (1 - Discount)
    await page.keyboard.type('0.1')
    await page.keyboard.press('Tab')
    await expect.poll(() => valueOf(page, 'net')).toBe('1111.05')
    await expect(field(page, 'net')).toHaveValue('$1,111.05')
    await expect(field(page, 'discount')).toHaveValue('10%')

    // A focused field shows the raw value for editing
    await field(page, 'amount1').click()
    await expect(field(page, 'amount1')).toHaveValue('1000')
    await shot(page, '7-calc-editing')

    // Validation: AFRange_Validate shows Acrobat's message and keeps the old value
    await field(page, 'qty').click()
    await page.keyboard.type('150')
    await page.keyboard.press('Tab')
    const alert = page.locator('.ui-dialog')
    await expect(alert).toContainText('Invalid value: must be greater than or equal to 0 and less than or equal to 100.')
    await page.waitForTimeout(400)
    await shot(page, '8-validation')
    await alert.getByRole('button', { name: 'OK' }).click()
    await expect(alert).toHaveCount(0)
    expect(await valueOf(page, 'qty')).toBe('')
    await expect(field(page, 'qty')).toBeFocused()
    await page.keyboard.type('42')
    await page.keyboard.press('Tab')
    await expect.poll(() => valueOf(page, 'qty')).toBe('42')

    // Date format
    await expect(field(page, 'orderDate')).toBeFocused()
    await page.keyboard.type('3/4/2024')
    await page.keyboard.press('Tab')
    await expect(field(page, 'orderDate')).toHaveValue('03/04/2024')
    // A date that does not exist is refused with Acrobat's message
    await field(page, 'orderDate').click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('13/45/2024')
    await page.keyboard.press('Enter')
    await expect(alert).toContainText('Invalid date/time: please ensure that the date/time exists. Field [ orderDate ] should match format mm/dd/yyyy')
    await alert.getByRole('button', { name: 'OK' }).click()
    expect(await valueOf(page, 'orderDate')).toBe('3/4/2024')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await shot(page, '9-calc')

    // Controls follow the zoom
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(1.5))
    await expect.poll(async () => (await activeDocState(page))?.zoom).toBeCloseTo(1.5, 2)
    await page.waitForTimeout(300)
    const zoom = 1.5
    const box = await field(page, 'amount1').boundingBox()
    // the field is 160 x 20 points; 1 point = 4/3 CSS pixels at 100%
    expect(box!.width).toBeCloseTo((160 * zoom * 4) / 3, 0)
    expect(box!.height).toBeCloseTo((20 * zoom * 4) / 3, 0)
    await field(page, 'amount2').click()
    await waitForRender(page)
    await page.waitForTimeout(300)
    await shot(page, '10-zoomed')
    await page.keyboard.press('Escape')

    // Rotated view: the controls turn with the page
    await runCommand(page, 'view.rotateCW')
    await page.waitForTimeout(400)
    const turned = await field(page, 'amount1').boundingBox()
    expect(turned!.width).toBeCloseTo((20 * zoom * 4) / 3, 0)
    expect(turned!.height).toBeCloseTo((160 * zoom * 4) / 3, 0)
    await field(page, 'amount1').click()
    await expect(field(page, 'amount1')).toBeFocused()
    await waitForRender(page)
    await shot(page, '10b-rotated')
    await page.keyboard.press('Escape')
    await runCommand(page, 'view.rotateCCW')

    // Recalculation can be switched off in Preferences > Forms
    await runCommand(page, 'app.preferences')
    await page.locator('.prefs-nav').getByRole('button', { name: 'Forms' }).click()
    await expect(page.locator('.fc-forms-fill-settings')).toBeVisible()
    await shot(page, '11-preferences')
    await page.getByText('Automatically calculate field values').click()
    await page.locator('.ui-dialog').getByRole('button', { name: 'Done' }).click()
    await field(page, 'amount2').click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('1000')
    await page.keyboard.press('Tab')
    await expect.poll(() => valueOf(page, 'amount2')).toBe('1000')
    expect(await valueOf(page, 'total')).toBe('1234.5')
    await runCommand(page, 'forms.calculateNow')
    await expect.poll(() => valueOf(page, 'total')).toBe('2000')
  } finally {
    await app.close()
  }
})

test('all field types, buttons, signature fields, form data and dark mode', async () => {
  const { dir, path } = tempCopy('forms-fill/all-fields.pdf')
  const { app, page } = await launch()
  try {
    await openFile(page, path)
    await waitForRender(page)
    await page.evaluate(() => {
      ;(window as any).__signEvents = []
      window.addEventListener('fartcrobat:sign-field', (e) => (window as any).__signEvents.push((e as CustomEvent).detail))
    })
    await expect(page.locator('.fc-forms-fill-msgbar')).toContainText('2 required fields left')
    await expect(field(page, 'memberId')).toHaveAttribute('readonly', '')

    // Editable combo box: pick from the list with the keyboard, then type a custom value
    const state = field(page, 'state')
    await state.click()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.fc-forms-fill-dropdown')).toBeVisible()
    await shot(page, '12-combo-list')
    await page.locator('.fc-forms-fill-dropdown-item', { hasText: 'Washington' }).click()
    await expect.poll(() => valueOf(page, 'state')).toBe('Washington')
    await state.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Oregon')
    await page.keyboard.press('Enter')
    await expect.poll(() => valueOf(page, 'state')).toBe('Oregon')

    // Combo box with export values: the stored value is the export value
    await field(page, 'colour').selectOption({ label: 'Blue' })
    await expect.poll(() => valueOf(page, 'colour')).toBe('B')

    // Multiple-selection list box: click, Ctrl+click, keyboard
    const languages = field(page, 'languages')
    await languages.getByRole('option', { name: 'German' }).click()
    await languages.getByRole('option', { name: 'Spanish' }).click({ modifiers: ['Control'] })
    await expect(languages.getByRole('option', { name: 'Spanish' })).toHaveAttribute('aria-selected', 'true')
    await shot(page, '13-list')
    await page.keyboard.press('Enter')
    await expect.poll(() => valueOf(page, 'languages')).toEqual(['German', 'Spanish'])
    // Single-selection list box: arrow keys and Space (Space must not switch to the hand tool)
    const contact = field(page, 'contact')
    await contact.getByRole('option', { name: 'Email' }).click()
    await expect.poll(() => valueOf(page, 'contact')).toBe('Email')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Space')
    await page.keyboard.press('Tab')
    await expect.poll(() => valueOf(page, 'contact')).toBe('Phone')
    await expect(page.locator('.viewer-scroll.tool-hand')).toHaveCount(0)

    // Comb field with a character limit, password field
    await field(page, 'pin').click()
    await page.keyboard.type('123456789')
    await expect(field(page, 'pin')).toHaveValue('123456')
    await field(page, 'password').click()
    await page.keyboard.type('hunter2')
    await field(page, 'firstName').click()
    await page.keyboard.type('Grace')
    await field(page, 'agree').click()
    await expect.poll(() => valueOf(page, 'pin')).toBe('123456')
    await expect.poll(() => valueOf(page, 'password')).toBe('hunter2')
    await expect(field(page, 'password')).toHaveAttribute('type', 'password')
    await expect(page.locator('.fc-forms-fill-msgbar')).not.toContainText('required field')

    // Push buttons: JavaScript alert, submit (offline), reset
    await field(page, 'helloButton').click()
    const dialog = page.locator('.ui-dialog')
    await expect(dialog).toContainText('Hello from the form')
    await dialog.getByRole('button', { name: 'OK' }).click()
    await field(page, 'submitButton').click()
    await expect(page.locator('.toast', { hasText: 'never sends forms' })).toBeVisible()

    // Unsigned signature field: dispatches the sign-field event
    await field(page, 'signature1').hover()
    await shot(page, '14-signature-hover')
    await field(page, 'signature1').click()
    const events = await page.evaluate(() => (window as any).__signEvents)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ fieldName: 'signature1', page: 0 })
    expect(events[0].rect).toHaveLength(4)

    // Tab from the last field of page 1 goes to the first field of page 2
    await field(page, 'comments').click()
    for (let i = 0; i < 8; i++) {
      if (await field(page, 'city').evaluate((el) => el === document.activeElement).catch(() => false)) break
      await page.keyboard.press('Tab')
    }
    await expect(field(page, 'city')).toBeFocused()
    await expect(field(page, 'city')).toBeInViewport()
    // custom keystroke script: upper-case while typing
    await page.keyboard.type('paris')
    await expect(field(page, 'city')).toHaveValue('PARIS')
    await page.keyboard.press('Tab')
    await expect(field(page, 'zip')).toBeFocused()
    await page.keyboard.type('12a34x5')
    await expect(field(page, 'zip')).toHaveValue('12345')
    await page.keyboard.press('Tab')
    await page.keyboard.type('5551234567')
    await page.keyboard.press('Tab')
    await expect(field(page, 'phone')).toHaveValue('(555) 123-4567')
    await shot(page, '15-page2')

    // Export the data, clear the form, import it back
    const xfdf = join(dir, 'data.xfdf')
    await stubSaveDialog(app, xfdf)
    await runCommand(page, 'forms.exportData')
    await expect.poll(() => existsSync(xfdf)).toBe(true)
    const xml = readFileSync(xfdf, 'utf8')
    expect(xml).toContain('<field name="pin">')
    expect(xml).toContain('<value>123456</value>')
    expect(xml).toContain('<value>Oregon</value>')
    const json = join(dir, 'data.json')
    await stubSaveDialog(app, json)
    await runCommand(page, 'forms.exportData')
    await expect.poll(() => existsSync(json)).toBe(true)
    expect(JSON.parse(readFileSync(json, 'utf8')).fields.city).toBe('PARIS')

    await startCommand(page, 'forms.reset')
    await dialog.getByRole('button', { name: 'Clear form' }).click()
    await expect.poll(() => valueOf(page, 'pin')).toBe('')
    const defaults = await values(page)
    expect(defaults.state).toBe('Texas')
    expect(defaults.colour).toBe('G')
    expect(defaults.languages).toEqual(['French', 'Japanese'])
    expect(defaults.memberId).toBe('M-0042')
    await expect(field(page, 'colour').locator('option:checked')).toHaveText('Green')

    await stubOpenDialog(app, xfdf)
    await runCommand(page, 'forms.importData')
    await expect.poll(() => valueOf(page, 'pin')).toBe('123456')
    const imported = await values(page)
    expect(imported).toMatchObject({ state: 'Oregon', colour: 'B', city: 'PARIS', agree: 'Yes', firstName: 'Grace' })
    expect(imported.languages).toEqual(['German', 'Spanish'])
    await expect(page.locator('.toast', { hasText: 'Imported' })).toBeVisible()
    expect((await activeDocState(page))?.journal.undoLabel).toBe('Import Form Data')

    // Dark theme: the message bar, the field being edited and the dropdowns stay readable
    await runCommand(page, 'nav.first')
    await page.evaluate(() => (window as any).__fartcrobat.useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: 'dark' } })))
    await expect(page.locator('html[data-theme="dark"]')).toHaveCount(1)
    await field(page, 'comments').click()
    await page.keyboard.type('Written in the dark theme')
    await page.waitForTimeout(300)
    await shot(page, '16-dark')
    await field(page, 'state').click()
    await page.keyboard.press('ArrowDown')
    await shot(page, '17-dark-combo')
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
})

test('dynamic XFA forms and signed signature fields', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('forms-fill/xfa.pdf'))
    await waitForRender(page)
    const bar = page.locator('.fc-forms-fill-msgbar')
    await expect(bar).toContainText('dynamic XFA')
    await expect(bar).toContainText('static form fields are shown')
    await field(page, 'amount1').click()
    await page.keyboard.type('5')
    await page.keyboard.press('Tab')
    await expect.poll(() => valueOf(page, 'total')).toBe('5')
    await shot(page, '18-xfa')

    // A signed signature field says who signed it and points to the Signatures panel
    await openFile(page, fixturePath('forms-fill/signed.pdf'))
    await waitForRender(page)
    const sig = field(page, 'signature1')
    await expect(sig).toHaveAttribute('title', /^Signed by Jane Signer on .+ — see Signatures panel$/)
    await expect(sig).toHaveClass(/is-signed/)
    const events = await page.evaluate(() => {
      const list: unknown[] = []
      window.addEventListener('fartcrobat:sign-field', (e) => list.push((e as CustomEvent).detail))
      ;(window as any).__signedEvents = list
      return list.length
    })
    expect(events).toBe(0)
    await sig.click()
    // no new signing starts on a signed field
    expect(await page.evaluate(() => (window as any).__signedEvents.length)).toBe(0)
    await expect(page.locator('.toast', { hasText: 'Signed by Jane Signer' }).first()).toBeVisible()
  } finally {
    await app.close()
  }
})
