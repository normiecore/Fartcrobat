import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdtempSync } from 'node:fs'
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
    await props.getByRole('checkbox', { name: 'Select Green by default' }).check()
    await page.waitForTimeout(200)
    await page.screenshot({ path: `${SHOTS}/prepare-form-properties-options.png` })
    await props.getByRole('button', { name: 'OK' }).click()
    await expect(props).toBeHidden()
    await expect.poll(async () => (await byName(page, 'Dropdown1'))?.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue'])
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
    await expect.poll(async () => near((await byName(page, 'customer'))!.rect, [92, 570, 292, 594])).toBe(true)
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(async () => near((await byName(page, 'customer'))!.rect, [94, 580, 294, 604], 0.6)).toBe(true)

    // resize the check box with its bottom-right handle
    await page.locator('.fc-prepare-form-box[data-field-name="Check Box1"]').click()
    const handle = page.locator('.fc-prepare-form-box[data-field-name="Check Box1"] .h-se')
    const hb = (await handle.boundingBox())!
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb.x + hb.width / 2 + 3 * s, hb.y + hb.height / 2 + 3 * s, { steps: 3 })
    await page.mouse.move(hb.x + hb.width / 2 + 6 * s, hb.y + hb.height / 2 + 6 * s, { steps: 3 })
    await page.mouse.up()
    await expect.poll(async () => {
      const r = (await byName(page, 'Check Box1'))!.rect
      return Math.round(r[2] - r[0])
    }).toBe(20)

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
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().toolId)).toBe('select')
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
      await page.evaluate(async (id) => (window as any).__fartcrobat.getActiveDoc().ops('forms').setValue(id, 'Ada Lovelace'), cust.id)
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
    expect(again.find((f) => f.name === 'Dropdown1')!.options.map((o) => o.label)).toEqual(['Red', 'Green', 'Blue'])
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
    for (const n of ['Full name', 'Email', 'Phone', 'Street address', 'City', 'Postcode', 'Comments', 'Signature']) expect(names).toContain(n)
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
