import { describe, expect, it } from 'vitest'
import type formOps from '@engine/ops/forms'
import type { FieldInfo } from '@engine/ops/forms'
import { openBytes, signedFormPdf } from './core-docs'
import { openFixture, roundTrip, type OpenedEngine } from './helpers'

function startsWith(bytes: Uint8Array, prefix: Uint8Array) {
  return bytes.length >= prefix.length && prefix.every((v, i) => bytes[i] === v)
}

/** The normal appearance stream of a widget, as text. */
function appearance(e: OpenedEngine, f: FieldInfo): string {
  const w = e.session
    .page(f.page)
    .getWidgets()
    .find((x) => x.getObject().asIndirect() === f.id)!
  return w.getObject().get('AP', 'N').readStream().asString()
}

describe('Clear Form', () => {
  it('keeps signatures, and the next save stays incremental', async () => {
    const original = signedFormPdf()
    const e = await openBytes(original, 'signed.pdf')
    const forms = e.ops<typeof formOps>('forms')
    await forms.setValues([
      { name: 'Name', value: 'Ada' },
      { name: 'Choice', value: 'Yes' }
    ])
    await forms.reset()
    const fields = await forms.listAll()
    expect(fields.find((f) => f.type === 'signature')!.signed).toBe(true)
    expect(fields.find((f) => f.name === 'Name')!.value).toBe('')
    expect(fields.filter((f) => f.name === 'Choice').every((f) => !f.checked)).toBe(true)
    expect((await e.doc.info()).signatureCount).toBe(1)
    const bytes = await e.doc.save({})
    expect(startsWith(bytes, original)).toBe(true)
  })

  it('leaves fields locked by a signature alone', async () => {
    const e = await openBytes(signedFormPdf({ lock: ['Name'] }), 'locked.pdf')
    const forms = e.ops<typeof formOps>('forms')
    await forms.setValues([{ name: 'Choice', value: 'No' }])
    await forms.reset()
    const fields = await forms.listAll()
    expect(fields.find((f) => f.name === 'Name')!.value).toBe('Old')
    expect(fields.filter((f) => f.name === 'Choice').every((f) => !f.checked)).toBe(true)

    const all = await openBytes(signedFormPdf({ lock: 'All' }), 'locked.pdf')
    await all.ops<typeof formOps>('forms').reset()
    expect((await all.ops<typeof formOps>('forms').listAll()).find((f) => f.name === 'Name')!.value).toBe(
      'Old'
    )
  })

  it('still saves a document whose signature was cleared incrementally', async () => {
    const original = signedFormPdf()
    const e = await openBytes(original, 'signed.pdf')
    // e.g. the signatures feature clearing a signature value
    const field = e.session.pdf.getTrailer().get('Root', 'AcroForm', 'Fields').get(2)
    e.session.runMutation('Clear Signature', () => field.delete('V'))
    expect((await e.doc.info()).signatureCount).toBe(0)
    const bytes = await e.doc.save({})
    expect(startsWith(bytes, original)).toBe(true)
  })
})

describe('checkbox fields whose widgets export different values', () => {
  it('turns on only the widget whose export value matches', async () => {
    const e = await openBytes(signedFormPdf(), 'f.pdf')
    const forms = e.ops<typeof formOps>('forms')
    const state = async () =>
      (await forms.listAll())
        .filter((f) => f.name === 'Choice')
        .map((f) => `${f.onState}:${f.checked}:${f.value}`)
    await forms.setValues([{ name: 'Choice', value: 'Yes' }])
    expect(await state()).toEqual(['Yes:true:Yes', 'No:false:Yes'])
    await forms.setValues([{ name: 'Choice', value: 'No' }])
    expect(await state()).toEqual(['Yes:false:No', 'No:true:No'])
    const yes = (await forms.listAll()).find((f) => f.name === 'Choice' && f.onState === 'Yes')!
    await forms.setValue(yes.id, true)
    expect(await state()).toEqual(['Yes:true:Yes', 'No:false:Yes'])
    await forms.setValue(yes.id, false)
    expect(await state()).toEqual(['Yes:false:Off', 'No:false:Off'])
    await forms.setValues([{ name: 'Choice', value: 'Off' }])
    expect(await state()).toEqual(['Yes:false:Off', 'No:false:Off'])
    const rt = await roundTrip(e)
    expect((await rt.ops<typeof formOps>('forms').listAll()).filter((f) => f.checked).length).toBe(0)
  })

  it('still checks a single-state checkbox from any truthy text', async () => {
    const e = await openFixture('form.pdf')
    const forms = e.ops<typeof formOps>('forms')
    await forms.setValues([{ name: 'subscribe', value: 'On' }])
    expect((await forms.listAll()).find((f) => f.name === 'subscribe')!.checked).toBe(true)
    await forms.setValues([{ name: 'subscribe', value: false }])
    expect((await forms.listAll()).find((f) => f.name === 'subscribe')!.checked).toBe(false)
  })

  it('checks a checkbox that has no appearance states yet', async () => {
    const e = await openFixture('form.pdf')
    const forms = e.ops<typeof formOps>('forms')
    const sub = (await forms.listAll()).find((f) => f.name === 'subscribe')!
    // strip the appearance states, as some generators do
    e.session.runMutation('Strip', () => {
      const w = e.session
        .page(sub.page)
        .getWidgets()
        .find((x) => x.getObject().asIndirect() === sub.id)!
      w.getObject().delete('AP')
      w.getObject().put('AS', e.session.pdf.newName('Off'))
    })
    await forms.setValue(sub.id, true)
    const after = (await forms.listAll()).find((f) => f.name === 'subscribe')!
    expect(after.value).not.toBe('Off')
    expect(after.checked).toBe(true)
  })
})

describe('radio groups with NoToggleToOff', () => {
  it('can be cleared through setValue(false) and setValues("Off")', async () => {
    const e = await openFixture('form.pdf')
    const forms = e.ops<typeof formOps>('forms')
    const plan = async () => (await forms.listAll()).filter((f) => f.name === 'plan')
    const pro = (await plan()).find((f) => f.onState === 'pro')!
    const basic = (await plan()).find((f) => f.onState === 'basic')!
    await forms.setValue(pro.id, true)
    expect((await plan()).map((f) => f.checked)).toEqual([basic, pro].map((f) => f === pro))
    await forms.setValue(basic.id, false) // not the selected one: nothing changes
    expect((await plan()).find((f) => f.onState === 'pro')!.checked).toBe(true)
    await forms.setValue(pro.id, false)
    expect((await plan()).every((f) => !f.checked)).toBe(true)
    expect((await plan())[0].value).toBe('Off')
    await forms.setValues([{ name: 'plan', value: 'basic' }])
    expect((await plan()).find((f) => f.onState === 'basic')!.checked).toBe(true)
    await forms.setValues([{ name: 'plan', value: 'Off' }])
    expect((await plan()).every((f) => !f.checked)).toBe(true)
    await e.doc.undo()
    expect((await plan()).find((f) => f.onState === 'basic')!.checked).toBe(true)
  })
})

describe('text fields with several widgets', () => {
  it('shows the formatted display text on every widget and keeps the raw value', async () => {
    const e = await openBytes(signedFormPdf(), 'f.pdf')
    const forms = e.ops<typeof formOps>('forms')
    const name = (await forms.list(0)).find((f) => f.name === 'Name')!
    await forms.setValue(name.id, '1234.5', { display: '$1,234.50' })
    expect(e.lastChanges?.pages).toEqual([0, 1])
    const widgets = (await forms.listAll()).filter((f) => f.name === 'Name')
    expect(widgets.length).toBe(2)
    for (const w of widgets) {
      expect(w.value).toBe('1234.5')
      expect(appearance(e, w)).toContain('$1,234.50')
      expect(appearance(e, w)).not.toContain('(1234.5)')
    }
    // later edits elsewhere do not redraw it from the raw value
    await forms.setValues([{ name: 'Choice', value: 'Yes' }])
    for (const w of widgets) expect(appearance(e, w)).toContain('$1,234.50')
    // the same through setValues
    await forms.setValues([{ name: 'Name', value: '99', display: '$99.00' }])
    for (const w of (await forms.listAll()).filter((f) => f.name === 'Name')) {
      expect(w.value).toBe('99')
      expect(appearance(e, w)).toContain('$99.00')
    }
  })

  it('refreshes the other widgets of the field, on other pages', async () => {
    const e = await openBytes(signedFormPdf(), 'f.pdf')
    const forms = e.ops<typeof formOps>('forms')
    const first = (await forms.list(0)).find((f) => f.name === 'Name')!
    await forms.setValue(first.id, 'NewValue')
    expect(e.lastChanges?.pages).toEqual([0, 1])
    const other = (await forms.list(1)).find((f) => f.name === 'Name')!
    expect(other.value).toBe('NewValue')
    expect(appearance(e, other)).toContain('NewValue')
  })
})
