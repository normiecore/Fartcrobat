import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeDocState, fixturePath, launch, openFile, runCommand, waitForRender } from './helpers'

const SHOTS = 'test-results'

interface CoreField {
  id: number
  name: string
  type: string
  page: number
  rect: [number, number, number, number]
  value: string
  options: { label: string; value: string }[]
  checked: boolean
  required: boolean
  tooltip: string
}

async function listAll(page: Page): Promise<CoreField[]> {
  return page.evaluate(async () => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    const fields = await d.ops('forms').listAll()
    return fields.map((f: any) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      page: f.page,
      rect: f.rect,
      value: f.value,
      options: f.options,
      checked: f.checked,
      required: f.required,
      tooltip: f.tooltip
    }))
  })
}

const byName = async (page: Page, name: string) => (await listAll(page)).find((f) => f.name === name)

/** Client coordinates of a page-space point. */
async function pagePoint(page: Page, pageIndex: number, x: number, y: number) {
  return page.evaluate(
    ({ pageIndex, x, y }) => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const el = document.querySelector(`.viewer-page[data-page-index="${pageIndex}"]`)!
      const b = el.getBoundingClientRect()
      const s = d.state.zoom * (96 / 72)
      return { x: b.left + x * s, y: b.top + y * s }
    },
    { pageIndex, x, y }
  )
}

async function scrollTo(page: Page, pageIndex: number, y: number) {
  await page.evaluate(
    ({ pageIndex, y }) => (window as any).__fartcrobat.getActiveDoc().view.goToPage(pageIndex, { x: 0, y }),
    { pageIndex, y }
  )
  await page.waitForTimeout(150)
}

async function dragOnPage(page: Page, pageIndex: number, from: [number, number], to: [number, number]) {
  const a = await pagePoint(page, pageIndex, from[0], from[1])
  const b = await pagePoint(page, pageIndex, to[0], to[1])
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 })
  await page.mouse.move(b.x, b.y, { steps: 4 })
  await page.mouse.up()
}

async function clickOnPage(page: Page, pageIndex: number, p: [number, number]) {
  const a = await pagePoint(page, pageIndex, p[0], p[1])
  await page.mouse.click(a.x, a.y)
}

async function stubSaveDialog(app: ElectronApplication, path: string) {
  await app.evaluate(({ ipcMain }, p) => {
    ipcMain.removeHandler('file:saveDialog')
    ipcMain.handle('file:saveDialog', () => p)
  }, path)
}

/** Replaces shell:openExternal so the test can see the mailto: link instead of opening a mail app. */
async function captureExternalLinks(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    ;(globalThis as any).__pfLinks = []
    ipcMain.removeHandler('shell:openExternal')
    ipcMain.handle('shell:openExternal', (_e, url: string) => {
      ;(globalThis as any).__pfLinks.push(url)
    })
  })
}

async function externalLinks(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as any).__pfLinks ?? [])
}

async function pageFieldOrder(page: Page, pageIndex: number): Promise<string[]> {
  return page.evaluate(async (p) => {
    const d = (window as any).__fartcrobat.getActiveDoc()
    const fields = await d.ops('prepare-form').listPage(p)
    return fields.map((f: any) => f.name)
  }, pageIndex)
}

async function selectedFieldIds(page: Page): Promise<number[]> {
  const st = await activeDocState(page)
  return ((st?.selection as any)?.data?.ids as number[]) ?? []
}

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => {
    const { useApp } = (window as any).__fartcrobat
    useApp.setState((s: any) => ({ prefs: { ...s.prefs, theme: t } }))
  }, theme)
  await page.waitForTimeout(150)
}

const near = (a: number[], b: number[], tol = 1.5) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

test('prepare a form: create fields, edit them, preview, save and reopen', async () => {
  const { app, page } = await launch()
  const out = mkdtempSync(join(tmpdir(), 'fartcrobat-pf-'))
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await runCommand(page, 'view.actualSize')

    // open "Prepare a form" from All tools; it offers automatic detection on a document without fields
    await page.locator('.shell-alltools-item', { hasText: 'Prepare a form' }).click()
    const question = page.locator('.ui-dialog', { hasText: 'Detect form fields automatically?' })
    await expect(question).toBeVisible()
    await page.waitForTimeout(250)
    await page.screenshot({ path: `${SHOTS}/prepare-form-detect-question.png` })
    await question.getByRole('button', { name: 'Not now' }).click()
    await expect(question).toBeHidden()

    // 1. a text field drawn by dragging, named in Acrobat's inline name box
    await scrollTo(page, 0, 480)
    await page.getByRole('button', { name: 'Add text field' }).first().click()
    await dragOnPage(page, 0, [72, 560], [272, 584])
    const nameBox = page.getByRole('textbox', { name: 'Field name' })
    await expect(nameBox).toBeVisible()
    await expect(nameBox).toHaveValue('Text1')
    await nameBox.fill('customer')
    await page.screenshot({ path: `${SHOTS}/prepare-form-inline-name.png` })
    await nameBox.press('Enter')
    await expect.poll(async () => (await listAll(page)).map((f) => f.name)).toEqual(['customer'])
    expect(near((await byName(page, 'customer'))!.rect, [72, 560, 272, 584])).toBe(true)
    await expect(nameBox).toBeHidden()

    // 2. a check box placed with a single click (default size)
    await page.getByRole('button', { name: 'Add check box' }).first().click()
    await clickOnPage(page, 0, [300, 565])
    await expect(page.getByRole('textbox', { name: 'Field name' })).toHaveValue('Check Box1')
    await page.keyboard.press('Escape')
    const cb = (await byName(page, 'Check Box1'))!
    expect(cb.type).toBe('checkbox')
    expect(near(cb.rect, [300, 565, 314, 579])).toBe(true)

    // 3. a dropdown whose 3 items are entered in Properties > Options
    await page.getByRole('button', { name: 'Add dropdown list' }).first().click()
    await clickOnPage(page, 0, [72, 610])
    await page.getByRole('button', { name: 'All properties' }).click()
    const props = page.locator('.ui-dialog', { hasText: 'Dropdown list Properties' })
    await expect(props).toBeVisible()
    await props.getByRole('tab', { name: 'Options' }).click()
    const item = props.getByPlaceholder('e.g. Japan')
    for (const v of ['Red', 'Green', 'Blue']) {
      await item.fill(v)
      await item.press('Enter')
    }
    await props.getByRole('radio', { name: 'Select Green by default' }).check()
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${SHOTS}/prepare-form-properties-options.png` })
    await props.getByRole('button', { name: 'OK' }).click()
    await expect(props).toBeHidden()
    await expect
      .poll(async () => (await byName(page, 'Dropdown1'))?.options.map((o) => o.label))
      .toEqual(['Red', 'Green', 'Blue'])
    expect((await byName(page, 'Dropdown1'))!.value).toBe('Green')

    // 4. a signature field
    await page.getByRole('button', { name: 'Add digital signature' }).first().click()
    await dragOnPage(page, 0, [300, 600], [480, 640])
    await expect(page.getByRole('textbox', { name: 'Field name' })).toHaveValue('Signature1')
    await page.keyboard.press('Enter')
    await expect.poll(async () => (await listAll(page)).length).toBe(4)
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/prepare-form-fields.png` })

    // move the text field by dragging its box, then nudge it with the arrow keys
    const box = page.locator('.fc-prepare-form-box[data-field-name="customer"]')
    const bb = (await box.boundingBox())!
    const s = (await activeDocState(page))!.zoom * (96 / 72)
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
    await page.mouse.down()
    await page.mouse.move(bb.x + bb.width / 2 + 10 * s, bb.y + bb.height / 2 + 5 * s, { steps: 3 })
    await page.mouse.move(bb.x + bb.width / 2 + 20 * s, bb.y + bb.height / 2 + 10 * s, { steps: 3 })
    await page.mouse.up()
    await expect
      .poll(async () => near((await byName(page, 'customer'))!.rect, [92, 570, 292, 594]))
      .toBe(true)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    await expect
      .poll(async () => near((await byName(page, 'customer'))!.rect, [94, 580, 294, 604], 0.6))
      .toBe(true)

    // resize the check box with its bottom-right handle
    await page.locator('.fc-prepare-form-box[data-field-name="Check Box1"]').click()
    const handle = page.locator('.fc-prepare-form-box[data-field-name="Check Box1"] .h-se')
    const hb = (await handle.boundingBox())!
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2 + 3 * s, hb.y + hb.height / 2 + 3 * s, { steps: 3 })
    await page.mouse.move(hb.x + hb.width / 2 + 6 * s, hb.y + hb.height / 2 + 6 * s, { steps: 3 })
    await page.mouse.up()
    await expect
      .poll(async () => {
        const r = (await byName(page, 'Check Box1'))!.rect
        return Math.round(r[2] - r[0])
      })
      .toBe(20)

    // delete the signature field with the Delete key, then undo
    await page.locator('.fc-prepare-form-box[data-field-name="Signature1"]').click()
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await listAll(page)).length).toBe(3)
    await runCommand(page, 'edit.undo')
    await expect.poll(async () => (await listAll(page)).length).toBe(4)

    // right-click menu
    await page.locator('.fc-prepare-form-box[data-field-name="customer"]').click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Properties…' })).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/prepare-form-context-menu.png` })
    await page.keyboard.press('Escape')

    // the Fields panel lists the fields in tab order; clicking selects
    await page.getByRole('button', { name: 'Fields', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Fields' })
    await expect(panel.locator('.fc-prepare-form-field')).toHaveCount(4)
    await panel.locator('.fc-prepare-form-field[data-field-name="Dropdown1"]').click()
    await expect.poll(async () => ((await activeDocState(page))!.selection as any).data?.ids?.length).toBe(1)
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${SHOTS}/prepare-form-fields-panel.png` })

    // Preview: back to normal filling; fill the text field
    await page.getByRole('button', { name: 'Preview', exact: true }).first().click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId))
      .toBe('select')
    await expect(page.locator('.fc-prepare-form-box')).toHaveCount(0)
    const cust = (await byName(page, 'customer'))!
    await clickOnPage(page, 0, [(cust.rect[0] + cust.rect[2]) / 2, (cust.rect[1] + cust.rect[3]) / 2])
    const focusedInput = await page.evaluate(() => {
      const a = document.activeElement
      return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')
    })
    if (focusedInput) {
      // forms-fill is installed: type into its field
      await page.keyboard.type('Ada Lovelace')
      await page.keyboard.press('Enter')
    } else {
      await page.evaluate(
        async (id) => (window as any).__fartcrobat.getActiveDoc().ops('forms').setValue(id, 'Ada Lovelace'),
        cust.id
      )
    }
    await expect.poll(async () => (await byName(page, 'customer'))?.value).toBe('Ada Lovelace')

    const fields = await listAll(page)
    expect(fields.map((f) => [f.name, f.type]).sort()).toEqual(
      [
        ['Check Box1', 'checkbox'],
        ['Dropdown1', 'combo'],
        ['Signature1', 'signature'],
        ['customer', 'text']
      ].sort()
    )

    // save as a new file (stubbed dialog) and reopen it
    const saved = join(out, 'form-out.pdf')
    await stubSaveDialog(app, saved)
    await runCommand(page, 'file.saveAs')
    await expect.poll(async () => (await activeDocState(page))?.dirty).toBe(false)
    expect(existsSync(saved)).toBe(true)
    await runCommand(page, 'file.close')
    await openFile(page, saved)
    await waitForRender(page)
    const again = await listAll(page)
    expect(again.map((f) => f.name).sort()).toEqual(['Check Box1', 'Dropdown1', 'Signature1', 'customer'])
    expect(again.find((f) => f.name === 'customer')!.value).toBe('Ada Lovelace')
    expect(again.find((f) => f.name === 'Dropdown1')!.options.map((o) => o.label)).toEqual([
      'Red',
      'Green',
      'Blue'
    ])
    await page.screenshot({ path: `${SHOTS}/prepare-form-reopened.png` })
  } finally {
    await app.close()
  }
})

test('auto-detect finds the blanks of a printed form', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('prepare-form/blank-form.pdf'))
    await waitForRender(page)
    await runCommand(page, 'form.prepare')
    const question = page.locator('.ui-dialog', { hasText: 'Detect form fields automatically?' })
    await expect(question).toBeVisible()
    await question.getByRole('button', { name: 'Detect fields' }).click()
    await expect.poll(async () => (await listAll(page)).length, { timeout: 20000 }).toBeGreaterThanOrEqual(12)
    const fields = await listAll(page)
    const names = fields.map((f) => f.name)
    for (const n of [
      'Full name',
      'Email',
      'Phone',
      'Street address',
      'City',
      'Postcode',
      'Comments',
      'Signature'
    ])
      expect(names).toContain(n)
    expect(fields.find((f) => f.name === 'Signature')!.type).toBe('signature')
    expect(fields.filter((f) => f.type === 'checkbox').length).toBeGreaterThanOrEqual(4)
    await expect(page.locator('.toast', { hasText: 'Added' })).toBeVisible()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/prepare-form-detected.png` })
    // one undo removes them all
    await runCommand(page, 'edit.undo')
    await expect.poll(async () => (await listAll(page)).length).toBe(0)
  } finally {
    await app.close()
  }
})

test('arranging fields at 150% zoom: multi-select, align, tab order, calculations, dark mode', async () => {
  const { app, page } = await launch()
  try {
    await openFile(page, fixturePath('text.pdf'))
    await waitForRender(page)
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(1.5))
    await expect.poll(async () => (await activeDocState(page))?.zoom).toBeCloseTo(1.5, 2)
    await runCommand(page, 'form.prepare')
    await page
      .locator('.ui-dialog', { hasText: 'Detect form fields automatically?' })
      .getByRole('button', { name: 'Not now' })
      .click()
    await scrollTo(page, 0, 520)

    // three text fields: two placed with a click (default size 150 x 22), one drawn
    const addText = page.getByRole('button', { name: 'Add text field' }).first()
    await addText.click()
    await clickOnPage(page, 0, [80, 560])
    const name = page.getByRole('textbox', { name: 'Field name' })
    await name.fill('price')
    await name.press('Enter')
    await addText.click()
    await clickOnPage(page, 0, [95, 600])
    await name.fill('qty')
    await name.press('Enter')
    await addText.click()
    await dragOnPage(page, 0, [300, 640], [420, 664])
    await name.fill('total')
    await name.press('Enter')
    await expect
      .poll(async () => (await listAll(page)).map((f) => f.name).sort())
      .toEqual(['price', 'qty', 'total'])
    // page coordinates are right at this zoom
    expect(near((await byName(page, 'price'))!.rect, [80, 560, 230, 582])).toBe(true)
    expect(near((await byName(page, 'qty'))!.rect, [95, 600, 245, 622])).toBe(true)
    expect(near((await byName(page, 'total'))!.rect, [300, 640, 420, 664])).toBe(true)
    // the blue boxes sit exactly over the fields
    const boxPos = await page.locator('.fc-prepare-form-box[data-field-name="qty"]').boundingBox()
    const expected = await pagePoint(page, 0, 95, 600)
    expect(Math.abs(boxPos!.x - expected.x)).toBeLessThan(2)
    expect(Math.abs(boxPos!.y - expected.y)).toBeLessThan(2)
    expect(Math.abs(boxPos!.width - 150 * 1.5 * (96 / 72))).toBeLessThan(2)

    // Shift-click selects several fields; right-click > Align Left lines them up with the clicked one
    await page.locator('.fc-prepare-form-box[data-field-name="price"]').click()
    await page.locator('.fc-prepare-form-box[data-field-name="qty"]').click({ modifiers: ['Shift'] })
    await page.locator('.fc-prepare-form-box[data-field-name="total"]').click({ modifiers: ['Shift'] })
    await expect.poll(async () => (await selectedFieldIds(page)).length).toBe(3)
    await page.locator('.fc-prepare-form-box[data-field-name="price"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Align, Distribute or Center' }).hover()
    await expect(page.getByRole('menuitem', { name: 'Align Left' })).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/prepare-form-align-menu.png` })
    await page.getByRole('menuitem', { name: 'Align Left' }).click()
    await expect
      .poll(async () => (await listAll(page)).map((f) => Math.round(f.rect[0])))
      .toEqual([80, 80, 80])
    expect(near((await byName(page, 'total'))!.rect, [80, 640, 200, 664])).toBe(true)
    // Match width of the anchor (price)
    await page.locator('.fc-prepare-form-box[data-field-name="price"]').click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Set Fields to Same Size' }).hover()
    await page.getByRole('menuitem', { name: 'Width', exact: true }).click()
    await expect
      .poll(async () => (await listAll(page)).map((f) => Math.round(f.rect[2] - f.rect[0])))
      .toEqual([150, 150, 150])
    // each arrangement is one undo step
    await runCommand(page, 'edit.undo')
    await expect
      .poll(async () =>
        Math.round((await byName(page, 'total'))!.rect[2] - (await byName(page, 'total'))!.rect[0])
      )
      .toBe(120)

    // rubber-band selection: drag around two fields on the empty page
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await selectedFieldIds(page)).length).toBe(0)
    await scrollTo(page, 0, 520)
    await dragOnPage(page, 0, [60, 550], [260, 630])
    await expect.poll(async () => (await selectedFieldIds(page)).length).toBe(2)
    // Ctrl+A selects every field on the page
    await page.keyboard.press('Control+A')
    await expect.poll(async () => (await selectedFieldIds(page)).length).toBe(3)

    // Calculate tab: total = sum of price and qty, written as AFSimple_Calculate
    await page.keyboard.press('Escape')
    await page.locator('.fc-prepare-form-box[data-field-name="total"]').dblclick()
    const props = page.locator('.ui-dialog', { hasText: 'Text field Properties' })
    await expect(props).toBeVisible()
    await props.getByRole('tab', { name: 'Calculate' }).click()
    await props.getByRole('radio', { name: 'Value is the' }).check()
    await props.getByRole('checkbox', { name: 'price' }).check()
    await props.getByRole('checkbox', { name: 'qty' }).check()
    await page.screenshot({ path: `${SHOTS}/prepare-form-calculate.png` })
    await props.getByRole('tab', { name: 'Format' }).click()
    await props.getByRole('combobox', { name: 'Format category' }).selectOption('number')
    await expect(props.locator('.fc-prepare-form-example')).toContainText('1,234.56')
    await page.screenshot({ path: `${SHOTS}/prepare-form-format.png` })
    await props.getByRole('button', { name: 'OK' }).click()
    await expect(props).toBeHidden()
    const scripts = await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const f = (await d.ops('forms').listAll()).find((x: any) => x.name === 'total')
      return { scripts: f.scripts, order: await d.ops('forms').calculationOrder() }
    })
    expect(scripts.scripts.calculate).toBe('AFSimple_Calculate("SUM", new Array ("price", "qty"));')
    expect(scripts.scripts.format).toBe('AFNumber_Format(2, 0, 0, 0, "", true);')
    expect(scripts.order).toEqual(['total'])

    // Fields panel: tab order numbers, reorder with Alt+Down, rename inline
    await page.getByRole('button', { name: 'Fields', exact: true }).click()
    const panel = page.getByRole('complementary', { name: 'Fields' })
    await panel.getByRole('checkbox', { name: 'Show tab numbers' }).check()
    await expect(page.locator('.fc-prepare-form-tab').first()).toBeVisible()
    expect(await pageFieldOrder(page, 0)).toEqual(['price', 'qty', 'total'])
    const priceRow = panel.locator('.fc-prepare-form-field[data-field-name="price"]')
    await priceRow.focus()
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => pageFieldOrder(page, 0)).toEqual(['qty', 'price', 'total'])
    await expect(panel.getByRole('combobox', { name: 'Tab order on page 1' })).toHaveValue('structure')
    await panel.locator('.fc-prepare-form-field[data-field-name="qty"]').dblclick()
    const rename = panel.getByRole('textbox', { name: 'Field name' })
    await rename.fill('quantity')
    await rename.press('Enter')
    await expect.poll(() => pageFieldOrder(page, 0)).toEqual(['quantity', 'price', 'total'])
    // the calculation follows the rename
    const calc = await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      return (await d.ops('forms').listAll()).find((x: any) => x.name === 'total').scripts.calculate
    })
    expect(calc).toBe('AFSimple_Calculate("SUM", new Array ("price", "quantity"));')

    // View > Rotate View: handles and arrow keys follow what is on the screen
    await runCommand(page, 'view.rotateCW')
    await page.waitForTimeout(300)
    const before = (await byName(page, 'total'))!.rect
    const totalBox = page.locator('.fc-prepare-form-box[data-field-name="total"]')
    await totalBox.click()
    await page.waitForTimeout(100)
    await page.screenshot({ path: `${SHOTS}/prepare-form-rotated-view.png` })
    const sh = (await totalBox.locator('.h-s').boundingBox())!
    const s15 = 1.5 * (96 / 72)
    await page.mouse.move(sh.x + sh.width / 2, sh.y + sh.height / 2)
    await page.mouse.down()
    await page.mouse.move(sh.x + sh.width / 2, sh.y + sh.height / 2 + 5 * s15, { steps: 3 })
    await page.mouse.move(sh.x + sh.width / 2, sh.y + sh.height / 2 + 10 * s15, { steps: 3 })
    await page.mouse.up()
    // the page is turned clockwise: the bottom of the screen is the right side of the page
    await expect
      .poll(async () =>
        near((await byName(page, 'total'))!.rect, [before[0], before[1], before[2] + 10, before[3]], 0.6)
      )
      .toBe(true)
    await page.keyboard.press('ArrowDown')
    await expect
      .poll(async () =>
        near((await byName(page, 'total'))!.rect, [before[0] + 1, before[1], before[2] + 11, before[3]], 0.3)
      )
      .toBe(true)
    await runCommand(page, 'view.rotateCCW')

    // keyboard only: choose the check box tool with Enter, Enter again places one mid-view; Delete removes it
    await page.getByRole('button', { name: 'Add check box' }).first().focus()
    await page.keyboard.press('Enter')
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId))
      .toBe('form.checkbox')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('textbox', { name: 'Field name' })).toHaveValue('Check Box1')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('textbox', { name: 'Field name' })).toBeHidden()
    expect((await byName(page, 'Check Box1'))!.page).toBe(0)
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await listAll(page)).length).toBe(3)

    // dark theme: panels and dialogs follow the theme; boxes stay readable on the white page
    await setTheme(page, 'dark')
    await page.locator('.fc-prepare-form-box[data-field-name="price"]').click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: `${SHOTS}/prepare-form-dark.png` })
    await page.locator('.fc-prepare-form-box[data-field-name="price"]').dblclick()
    await expect(page.locator('.ui-dialog', { hasText: 'Text field Properties' })).toBeVisible()
    await page.locator('.ui-dialog').getByRole('tab', { name: 'Appearance' }).click()
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${SHOTS}/prepare-form-dark-properties.png` })
    await page.keyboard.press('Escape')
  } finally {
    await app.close()
  }
})

test('request e-signatures: signers, signature fields, save and share by email', async () => {
  const { app, page } = await launch()
  const out = mkdtempSync(join(tmpdir(), 'fartcrobat-pf-sign-'))
  // work on a copy: "Save and share" saves the document in place
  const original = join(out, 'contract.pdf')
  copyFileSync(fixturePath('text.pdf'), original)
  try {
    await openFile(page, original)
    await waitForRender(page)
    await runCommand(page, 'view.actualSize')
    await page.locator('.shell-alltools-item', { hasText: 'Request e-signatures' }).click()
    const left = page.locator('.fc-prepare-form-request')
    await expect(left).toContainText('works offline')
    await expect(left.getByRole('button', { name: 'Save and share' })).toBeDisabled()

    await left.getByRole('textbox', { name: 'Signer name' }).fill('Ada Lovelace')
    await left.getByRole('textbox', { name: 'Signer email' }).fill('ada@example.com')
    await left.getByRole('button', { name: 'Add signer' }).click()
    await left.getByRole('textbox', { name: 'Signer name' }).fill('C. Babbage')
    await left.getByRole('button', { name: 'Add signer' }).click()
    await expect(left.locator('.fc-prepare-form-signers li')).toHaveCount(2)

    // place Ada's signature and date fields
    await scrollTo(page, 0, 480)
    await left
      .locator('.fc-prepare-form-signers li', { hasText: 'Ada Lovelace' })
      .getByRole('button', { name: 'Signature field' })
      .click()
    await expect
      .poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId))
      .toBe('form.signature')
    await dragOnPage(page, 0, [72, 600], [252, 640])
    await expect.poll(async () => (await listAll(page)).length).toBe(1)
    const sig = (await listAll(page))[0]
    expect(sig.name).toBe('Signature Ada Lovelace')
    expect(sig.type).toBe('signature')
    expect(sig.tooltip).toBe('Signature of Ada Lovelace')
    expect(sig.required).toBe(true)
    await left
      .locator('.fc-prepare-form-signers li', { hasText: 'Ada Lovelace' })
      .getByRole('button', { name: 'Date field' })
      .click()
    await clickOnPage(page, 0, [300, 620])
    await expect.poll(async () => (await listAll(page)).length).toBe(2)
    expect((await byName(page, 'Date Ada Lovelace'))!.tooltip).toBe('Date signed by Ada Lovelace')
    // a plain signature field, then assigned to Babbage from the list (the period does not create a hierarchy)
    await page.getByRole('button', { name: 'Add digital signature' }).first().click()
    await dragOnPage(page, 0, [72, 660], [252, 700])
    await expect(page.getByRole('textbox', { name: 'Field name' })).toHaveValue('Signature1')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('textbox', { name: 'Field name' })).toBeHidden()
    await expect.poll(async () => (await listAll(page)).length).toBe(3)
    await left.getByRole('combobox', { name: 'Signer of Signature1' }).selectOption('C. Babbage')
    await expect.poll(async () => (await byName(page, 'Signature1'))?.tooltip).toBe('Signature of C. Babbage')
    await expect(left.locator('.fc-prepare-form-signers li', { hasText: 'Babbage' })).toContainText('1 field')
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${SHOTS}/prepare-form-request-signers.png` })

    // Save and share: saves the PDF and opens the email app with a mailto: link
    const saved = original
    await captureExternalLinks(app)
    await left.getByRole('button', { name: 'Save and share' }).click()
    await expect(left.locator('.fc-prepare-form-sent')).toBeVisible()
    await expect(left.locator('.fc-prepare-form-path')).toHaveText(saved)
    expect(statSync(saved).size).toBeGreaterThan(statSync(fixturePath('text.pdf')).size)
    const links = await externalLinks(app)
    expect(links.length).toBe(1)
    expect(links[0].startsWith('mailto:ada@example.com?subject=Please%20sign%3A%20contract.pdf&body=')).toBe(
      true
    )
    expect(decodeURIComponent(links[0])).toContain(
      'Signature fields are marked for: Ada Lovelace, C. Babbage'
    )
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${SHOTS}/prepare-form-request-sent.png` })
    expect((await activeDocState(page))?.dirty).toBe(false)
  } finally {
    await app.close()
  }
})
