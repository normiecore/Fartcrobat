import { describe, expect, it } from 'vitest'
import type formOps from '@engine/ops/forms'
import type renderOps from '@engine/ops/render'
import type { PDFObject } from '@engine/session'
import type pfOps from '@features/prepare-form/engine'
import type { FieldInfo } from '@engine/ops/forms'
import type { PFField } from '@features/prepare-form/model'
import { openFixture, roundTrip, type OpenedEngine } from './helpers'

function ops(e: OpenedEngine) {
  return {
    pf: e.ops<typeof pfOps>('prepare-form'),
    forms: e.ops<typeof formOps>('forms')
  }
}

/** The raw PDF dictionary of a widget (or any indirect object). */
function raw(e: OpenedEngine, id: number): PDFObject {
  return e.session.pdf.newIndirect(id).resolve()
}

function acroForm(e: OpenedEngine): PDFObject {
  const a = e.session.pdf.getTrailer().get('Root').get('AcroForm')
  return a.isNull() ? a : a.resolve()
}

/** Indirect object numbers in an array. */
function refs(arr: PDFObject): number[] {
  const out: number[] = []
  if (!arr || arr.isNull() || !arr.isArray()) return out
  for (let i = 0; i < arr.length; i++) out.push(arr.get(i).asIndirect())
  return out
}

function pageAnnots(e: OpenedEngine, page: number): number[] {
  return refs(e.session.pdf.findPage(page).get('Annots'))
}

/** Widget annotations of a page, in /Annots order (text.pdf also has links). */
function pageWidgets(e: OpenedEngine, page: number): number[] {
  return pageAnnots(e, page).filter((id) => str(raw(e, id).get('Subtype')) === 'Widget')
}

const str = (o: PDFObject) => (o.isNull() ? '' : o.isString() ? o.asString() : o.isName() ? o.asName() : String(o))

async function core(e: OpenedEngine, name: string): Promise<FieldInfo[]> {
  return (await ops(e).forms.listAll()).filter((f) => f.name === name)
}

async function pfByName(e: OpenedEngine, name: string): Promise<PFField> {
  const { fields } = await ops(e).pf.listAll()
  const f = fields.find((x) => x.name === name)
  if (!f) throw new Error(`no field ${name}: ${fields.map((x) => x.name).join(', ')}`)
  return f
}

describe('prepare-form: creating fields', () => {
  it('creates every field type with Acrobat-style names that core forms sees', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const text = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122] })
    expect(text.name).toBe('Text1')
    expect(text.type).toBe('text')
    expect(e.lastChanges?.dirty).toBe(true)
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Text field')
    const cb = await pf.create({ type: 'checkbox', page: 0, rect: [72, 140, 86, 154] })
    expect(cb.name).toBe('Check Box1')
    const r1 = await pf.create({ type: 'radio', page: 0, rect: [72, 170, 86, 184] })
    const r2 = await pf.create({ type: 'radio', page: 0, rect: [100, 170, 114, 184], name: r1.name })
    expect(r1.name).toBe('Group1')
    expect(r2.name).toBe('Group1')
    expect(r1.exportValue).toBe('Choice1')
    expect(r2.exportValue).toBe('Choice2')
    expect(r2.widgetCount).toBe(2)
    const list = await pf.create({
      type: 'list',
      page: 0,
      rect: [300, 100, 450, 160],
      props: {
        options: [
          { label: 'Red', value: 'r' },
          { label: 'Green', value: 'Green' }
        ]
      }
    })
    const combo = await pf.create({
      type: 'combo',
      page: 0,
      rect: [300, 180, 450, 202],
      props: {
        options: [
          { label: 'A', value: 'A' },
          { label: 'B', value: 'B' },
          { label: 'C', value: 'C' }
        ],
        editable: true
      }
    })
    const btn = await pf.create({ type: 'button', page: 0, rect: [300, 220, 380, 244], props: { caption: 'Clear', action: { kind: 'reset' } } })
    const sig = await pf.create({ type: 'signature', page: 1, rect: [72, 600, 252, 640] })
    const date = await pf.create({ type: 'date', page: 1, rect: [300, 600, 400, 622] })
    expect([list.name, combo.name, btn.name, sig.name, date.name]).toEqual(['List Box1', 'Dropdown1', 'Button1', 'Signature1', 'Date1'])
    expect(date.type).toBe('date')
    expect(date.format).toEqual({ kind: 'date', pattern: 'mm/dd/yyyy' })

    const all = await forms.listAll()
    const t = (n: string) => all.filter((f) => f.name === n)
    expect(t('Text1')[0].type).toBe('text')
    expect(t('Check Box1')[0].type).toBe('checkbox')
    expect(t('Check Box1')[0].onState).toBe('Yes')
    expect(t('Group1').map((f) => f.type)).toEqual(['radio', 'radio'])
    expect(t('Group1').map((f) => f.onState).sort()).toEqual(['Choice1', 'Choice2'])
    expect(t('List Box1')[0].type).toBe('list')
    expect(t('List Box1')[0].options).toEqual([
      { label: 'Red', value: 'r' },
      { label: 'Green', value: 'Green' }
    ])
    expect(t('Dropdown1')[0].type).toBe('combo')
    expect(t('Dropdown1')[0].editable).toBe(true)
    expect(t('Dropdown1')[0].options.map((o) => o.label)).toEqual(['A', 'B', 'C'])
    expect(t('Button1')[0].type).toBe('button')
    expect(t('Signature1')[0].type).toBe('signature')
    expect(t('Signature1')[0].page).toBe(1)
    expect(t('Signature1')[0].signed).toBe(false)
    expect(t('Date1')[0].scripts.format).toBe('AFDate_FormatEx("mm/dd/yyyy");')
    expect(t('Date1')[0].scripts.keystroke).toBe('AFDate_KeystrokeEx("mm/dd/yyyy");')
    // rectangles are kept in page space
    expect(t('Text1')[0].rect.map(Math.round)).toEqual([72, 100, 222, 122])

    const info = await e.doc.info()
    expect(info.hasForm).toBe(true)
  })

  it('builds standard AcroForm, widget and field dictionaries', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const text = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122], props: { tooltip: 'Your name', maxLen: 12, alignment: 1 } })
    const cb = await pf.create({ type: 'checkbox', page: 0, rect: [72, 140, 86, 154] })
    const r1 = await pf.create({ type: 'radio', page: 0, rect: [72, 170, 86, 184], name: 'size' })
    const r2 = await pf.create({ type: 'radio', page: 0, rect: [100, 170, 114, 184], name: 'size' })
    const combo = await pf.create({ type: 'combo', page: 0, rect: [300, 180, 450, 202] })
    const list = await pf.create({ type: 'list', page: 0, rect: [300, 100, 450, 160] })
    const btn = await pf.create({ type: 'button', page: 0, rect: [300, 220, 380, 244] })
    const sig = await pf.create({ type: 'signature', page: 0, rect: [72, 600, 252, 640] })

    const acro = acroForm(e)
    expect(str(acro.get('DA'))).toBe('/Helv 0 Tf 0 g')
    expect(acro.get('NeedAppearances').asBoolean()).toBe(false)
    const fonts = acro.get('DR').get('Font')
    expect(str(fonts.get('Helv').get('BaseFont'))).toBe('Helvetica')
    expect(str(fonts.get('ZaDb').get('BaseFont'))).toBe('ZapfDingbats')
    const fieldRefs = refs(acro.get('Fields'))
    // radio buttons are kids of one group field
    const group = raw(e, r1.id).get('Parent').asIndirect()
    expect(raw(e, r2.id).get('Parent').asIndirect()).toBe(group)
    expect(fieldRefs).toEqual([text.id, cb.id, group, combo.id, list.id, btn.id, sig.id])
    expect(refs(raw(e, group).get('Kids'))).toEqual([r1.id, r2.id])
    expect(str(raw(e, group).get('T'))).toBe('size')
    expect(str(raw(e, group).get('FT'))).toBe('Btn')
    expect(raw(e, group).get('Ff').asNumber() & (1 << 15)).toBeTruthy()

    // every widget is on the page and points back to it
    expect(pageWidgets(e, 0)).toEqual([text.id, cb.id, r1.id, r2.id, combo.id, list.id, btn.id, sig.id])
    const pageObj = e.session.pdf.findPage(0)
    expect(str(pageObj.get('Tabs'))).toBe('R')
    for (const id of pageWidgets(e, 0)) {
      const w = raw(e, id)
      expect(str(w.get('Subtype'))).toBe('Widget')
      expect(w.get('P').asIndirect()).toBe(pageObj.asIndirect())
      expect(w.get('F').asNumber()).toBe(4)
      expect(w.get('AP').get('N').isNull()).toBe(false)
    }

    const tw = raw(e, text.id)
    expect(str(tw.get('FT'))).toBe('Tx')
    expect(str(tw.get('T'))).toBe('Text1')
    expect(str(tw.get('TU'))).toBe('Your name')
    expect(str(tw.get('DA'))).toBe('/Helv 0 Tf 0 g')
    expect(tw.get('MaxLen').asNumber()).toBe(12)
    expect(tw.get('Q').asNumber()).toBe(1)

    const cw = raw(e, cb.id)
    expect(str(cw.get('FT'))).toBe('Btn')
    expect(str(cw.get('MK').get('CA'))).toBe('4')
    expect(str(cw.get('V'))).toBe('Off')
    expect(str(cw.get('AS'))).toBe('Off')
    const n = cw.get('AP').get('N')
    expect(n.get('Yes').isStream()).toBe(true)
    expect(n.get('Off').isStream()).toBe(true)
    expect(n.get('Yes').readStream().asString()).toContain('(4) Tj')
    expect(n.get('Off').readStream().asString()).not.toContain('Tj')

    const rw = raw(e, r1.id)
    expect(str(rw.get('MK').get('CA'))).toBe('l')
    expect(rw.get('T').isNull()).toBe(true)
    expect(rw.get('AP').get('N').get('Choice1').readStream().asString()).toContain('(l) Tj')

    expect(raw(e, combo.id).get('Ff').asNumber()).toBe(1 << 17)
    expect(str(raw(e, list.id).get('FT'))).toBe('Ch')
    expect(raw(e, btn.id).get('Ff').asNumber()).toBe(1 << 16)
    expect(str(raw(e, btn.id).get('MK').get('CA'))).toBe('Button')
    expect(str(raw(e, sig.id).get('FT'))).toBe('Sig')
  })

  it('uses the ZapfDingbats character of each check style', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const styles = { check: '4', circle: 'l', cross: '8', diamond: 'u', square: 'n', star: 'H' } as const
    let y = 100
    for (const [style, ch] of Object.entries(styles)) {
      const f = await pf.create({ type: 'checkbox', page: 0, rect: [72, y, 90, y + 18], props: { checkStyle: style as keyof typeof styles } })
      y += 30
      expect(f.checkStyle).toBe(style)
      const w = raw(e, f.id)
      expect(str(w.get('MK').get('CA'))).toBe(ch)
      expect(w.get('AP').get('N').get('Yes').readStream().asString()).toContain(`(${ch}) Tj`)
      expect(w.get('AP').get('D').get('Yes').readStream().asString()).toContain(`(${ch}) Tj`)
    }
  })

  it('places fields correctly on rotated pages', async () => {
    const e = await openFixture('mixed-sizes.pdf')
    const { pf, forms } = ops(e)
    const info = await e.doc.info()
    expect(info.pages[2].rotation).toBe(90)
    const f = await pf.create({ type: 'text', page: 2, rect: [100, 100, 300, 124] })
    expect(f.rect.map(Math.round)).toEqual([100, 100, 300, 124])
    expect(f.orientation).toBe(90)
    const c = (await forms.listAll()).find((x) => x.id === f.id)!
    expect(c.rect.map(Math.round)).toEqual([100, 100, 300, 124])
    // fields cannot be placed outside the page
    const g = await pf.create({ type: 'text', page: 0, rect: [500, 800, 700, 830] })
    const w = info.pages[0].width
    const h = info.pages[0].height
    expect(g.rect[2]).toBeLessThanOrEqual(w + 0.01)
    expect(g.rect[3]).toBeLessThanOrEqual(h + 0.01)
    expect(Math.round(g.rect[2] - g.rect[0])).toBe(200)
  })

  it('fills created fields and survives save and reopen', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const t = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122], name: 'customer', props: { required: true, tooltip: 'Customer name', maxLen: 20 } })
    const cb = await pf.create({ type: 'checkbox', page: 0, rect: [72, 140, 86, 154], props: { checkStyle: 'cross', exportValue: 'Agreed' } })
    const r1 = await pf.create({ type: 'radio', page: 0, rect: [72, 170, 86, 184], name: 'size' })
    await pf.create({ type: 'radio', page: 0, rect: [100, 170, 114, 184], name: 'size' })
    await pf.update([r1.id], { exportValue: 'small' })
    await forms.setValue(t.id, 'Ada')
    await forms.setValue(cb.id, true)
    await forms.setValue(r1.id, true)

    const again = await roundTrip(e)
    const all = await again.ops<typeof formOps>('forms').listAll()
    const f = (n: string) => all.filter((x) => x.name === n)
    expect(f('customer')[0].value).toBe('Ada')
    expect(f('customer')[0].required).toBe(true)
    expect(f('customer')[0].tooltip).toBe('Customer name')
    expect(f('customer')[0].maxLen).toBe(20)
    expect(f('Check Box1')[0].checked).toBe(true)
    expect(f('Check Box1')[0].onState).toBe('Agreed')
    expect(f('size').find((x) => x.onState === 'small')!.checked).toBe(true)
    expect(f('size').find((x) => x.onState === 'Choice2')!.checked).toBe(false)
    const pf2 = await again.ops<typeof pfOps>('prepare-form').listPage(0)
    expect(pf2.find((x) => x.name === 'Check Box1')!.checkStyle).toBe('cross')
    expect(pf2.find((x) => x.name === 'customer')!.tooltip).toBe('Customer name')
  })

  it('radio buttons of a group switch each other off and share one value', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const a = await pf.create({ type: 'radio', page: 0, rect: [72, 170, 86, 184], name: 'plan' })
    const b = await pf.create({ type: 'radio', page: 0, rect: [100, 170, 114, 184], name: 'plan' })
    const c = await pf.create({ type: 'radio', page: 0, rect: [128, 170, 142, 184], name: 'plan' })
    await pf.update([a.id], { exportValue: 'basic' })
    await pf.update([b.id], { exportValue: 'pro' })
    await forms.setValue(b.id, true)
    let all = await core(e, 'plan')
    expect(all.map((x) => [x.onState, x.checked])).toEqual([
      ['basic', false],
      ['pro', true],
      ['Choice3', false]
    ])
    expect(all[0].value).toBe('pro')
    await forms.setValue(c.id, true)
    all = await core(e, 'plan')
    expect(all.map((x) => x.checked)).toEqual([false, false, true])
    // a button checked by default is what the form resets to
    await pf.update([a.id], { checkedByDefault: true })
    expect((await pfByName(e, 'plan')).checkedByDefault).toBe(true)
    await forms.reset()
    all = await core(e, 'plan')
    expect(all.map((x) => x.checked)).toEqual([true, false, false])
  })

  it('every creation is one undo step', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122] })
    await pf.create({ type: 'radio', page: 0, rect: [72, 170, 86, 184] })
    expect((await forms.listAll()).length).toBe(2)
    await e.doc.undo()
    expect((await forms.listAll()).length).toBe(1)
    await e.doc.undo()
    expect((await forms.listAll()).length).toBe(0)
    expect(acroForm(e).isNull()).toBe(true)
    await e.doc.redo()
    expect((await forms.listAll()).map((f) => f.name)).toEqual(['Text1'])
  })

  it('creates many fields in one step (automatic detection)', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const created = await pf.createMany(
      [
        { type: 'text', page: 0, rect: [72, 100, 222, 122], name: 'Name' },
        { type: 'text', page: 0, rect: [72, 130, 222, 152], name: 'Name' },
        { type: 'date', page: 1, rect: [72, 100, 222, 122], name: 'Date' },
        { type: 'checkbox', page: 1, rect: [72, 130, 86, 144], name: '' }
      ],
      'Detect Form Fields'
    )
    expect(created.map((f) => f.name)).toEqual(['Name', 'Name_2', 'Date', 'Check Box1'])
    expect(e.lastChanges?.journal.undoLabel).toBe('Detect Form Fields')
    await e.doc.undo()
    expect((await ops(e).forms.listAll()).length).toBe(0)
  })
})

describe('prepare-form: properties', () => {
  it('writes General and Appearance properties as standard PDF keys', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const f = await pf.create({ type: 'text', page: 0, rect: [72, 100, 272, 124] })
    await pf.update([f.id], {
      tooltip: 'Full name',
      readOnly: true,
      required: true,
      noExport: true,
      visibility: 'visible-noprint',
      orientation: 90,
      borderColor: '#ff0000',
      fillColor: '#ffff00',
      borderWidth: 2,
      borderStyle: 'dashed',
      fontName: 'TiRo',
      fontSize: 14,
      textColor: '#0000ff'
    })
    const w = raw(e, f.id)
    expect(w.get('Ff').asNumber()).toBe(1 | 2 | 4)
    expect(w.get('F').asNumber()).toBe(0)
    expect(w.get('MK').get('R').asNumber()).toBe(90)
    expect(w.get('MK').get('BC').asJS()).toEqual([1, 0, 0])
    expect(w.get('MK').get('BG').asJS()).toEqual([1, 1, 0])
    expect(w.get('BS').get('W').asNumber()).toBe(2)
    expect(str(w.get('BS').get('S'))).toBe('D')
    expect(str(w.get('DA'))).toBe('/TiRo 14 Tf 0 0 1 rg')
    expect(str(acroForm(e).get('DR').get('Font').get('TiRo').get('BaseFont'))).toBe('Times-Roman')

    const p = await pf.get(f.id)
    expect(p).toMatchObject({
      tooltip: 'Full name',
      readOnly: true,
      required: true,
      noExport: true,
      visibility: 'visible-noprint',
      orientation: 90,
      borderColor: '#ff0000',
      fillColor: '#ffff00',
      borderWidth: 2,
      borderStyle: 'dashed',
      fontName: 'TiRo',
      fontSize: 14,
      textColor: '#0000ff'
    })
    const c = (await forms.listAll())[0]
    expect(c.readOnly).toBe(true)
    expect(c.required).toBe(true)
    expect(c.noExport).toBe(true)
    expect(c.tooltip).toBe('Full name')
    expect(c.fontName).toBe('TiRo')
    expect(c.fontSize).toBe(14)
    expect(c.textColor).toBe('#0000ff')
    expect(c.borderColor).toBe('#ff0000')
    expect(c.backgroundColor).toBe('#ffff00')

    await pf.update([f.id], { visibility: 'hidden' })
    expect(raw(e, f.id).get('F').asNumber()).toBe(2)
    expect((await forms.listAll())[0].hidden).toBe(true)
    await pf.update([f.id], { visibility: 'hidden-print' })
    expect(raw(e, f.id).get('F').asNumber()).toBe(32 | 4)
    await pf.update([f.id], { visibility: 'visible', tooltip: '', borderColor: null })
    expect(raw(e, f.id).get('F').asNumber()).toBe(4)
    expect(raw(e, f.id).get('TU').isNull()).toBe(true)
    expect((await pf.get(f.id)).borderColor).toBeNull()

    // one undo step per change
    await e.doc.undo()
    expect((await pf.get(f.id)).visibility).toBe('hidden-print')
  })

  it('applies text field options', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const f = await pf.create({ type: 'text', page: 0, rect: [72, 100, 272, 124] })
    await pf.update([f.id], { multiline: true, doNotScroll: true, doNotSpellCheck: true, alignment: 2, defaultValue: 'n/a' })
    let w = raw(e, f.id)
    expect(w.get('Ff').asNumber()).toBe((1 << 12) | (1 << 23) | (1 << 22))
    expect(str(w.get('DV'))).toBe('n/a')
    expect(str(w.get('V'))).toBe('n/a')
    expect(w.get('Q').asNumber()).toBe(2)
    let c = (await forms.listAll())[0]
    expect(c.multiline).toBe(true)
    expect(c.alignment).toBe(2)
    expect(c.value).toBe('n/a')

    await pf.update([f.id], { multiline: false, comb: true, maxLen: 8 })
    w = raw(e, f.id)
    expect(w.get('Ff').asNumber() & (1 << 24)).toBeTruthy()
    expect(w.get('MaxLen').asNumber()).toBe(8)
    c = (await forms.listAll())[0]
    expect(c.comb).toBe(true)
    expect(c.maxLen).toBe(8)

    await pf.update([f.id], { comb: false, password: true, maxLen: 0, defaultValue: '' })
    w = raw(e, f.id)
    expect(w.get('MaxLen').isNull()).toBe(true)
    expect(w.get('DV').isNull()).toBe(true)
    c = (await forms.listAll())[0]
    expect(c.password).toBe(true)
    expect(c.comb).toBe(false)
    const p = await pf.get(f.id)
    expect(p).toMatchObject({ password: true, comb: false, maxLen: 0, doNotScroll: true, doNotSpellCheck: true, multiline: false })
  })

  it('applies check box options', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const f = await pf.create({ type: 'checkbox', page: 0, rect: [72, 100, 86, 114] })
    await pf.update([f.id], { exportValue: 'Accepted', checkedByDefault: true, checkStyle: 'star', textColor: '#ff0000' })
    const w = raw(e, f.id)
    expect(str(w.get('DV'))).toBe('Accepted')
    expect(str(w.get('V'))).toBe('Accepted')
    expect(str(w.get('AS'))).toBe('Accepted')
    expect(w.get('AP').get('N').get('Yes').isNull()).toBe(true)
    expect(w.get('AP').get('N').get('Accepted').readStream().asString()).toContain('(H) Tj')
    const c = (await forms.listAll())[0]
    expect(c.onState).toBe('Accepted')
    expect(c.checked).toBe(true)
    await expect(pf.update([f.id], { exportValue: 'Off' })).rejects.toThrow(/Off/)
    await expect(pf.update([f.id], { exportValue: '  ' })).rejects.toThrow(/empty/)
    await pf.update([f.id], { checkedByDefault: false })
    expect((await forms.listAll())[0].checked).toBe(false)
  })

  it('applies list and dropdown options', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const combo = await pf.create({ type: 'combo', page: 0, rect: [72, 100, 222, 122] })
    await pf.update([combo.id], {
      options: [
        { label: 'Japan', value: 'JP' },
        { label: 'France', value: 'FR' },
        { label: 'Brazil', value: 'Brazil' }
      ],
      defaultSelection: ['FR'],
      editable: true,
      commitOnSelChange: true
    })
    let w = raw(e, combo.id)
    expect(w.get('Opt').asJS()).toEqual([['JP', 'Japan'], ['FR', 'France'], 'Brazil'])
    expect(str(w.get('DV'))).toBe('FR')
    expect(str(w.get('V'))).toBe('FR')
    let c = (await core(e, 'Dropdown1'))[0]
    expect(c.value).toBe('FR')
    expect(c.editable).toBe(true)
    expect(c.options.map((o) => o.label)).toEqual(['Japan', 'France', 'Brazil'])
    expect(raw(e, combo.id).get('Ff').asNumber()).toBe((1 << 17) | (1 << 18) | (1 << 26))
    // the dropdown shows the label of the export value
    const ap = raw(e, combo.id).get('AP').get('N').readStream().asString()
    expect(ap).toContain('France')

    await pf.update([combo.id], { sort: true })
    w = raw(e, combo.id)
    expect(w.get('Opt').asJS()).toEqual(['Brazil', ['FR', 'France'], ['JP', 'Japan']])
    c = (await core(e, 'Dropdown1'))[0]
    expect(c.options.map((o) => o.value)).toEqual(['Brazil', 'FR', 'JP'])
    // removing the default item drops it from the value
    await pf.update([combo.id], { options: [{ label: 'Japan', value: 'JP' }] })
    expect(raw(e, combo.id).get('DV').isNull()).toBe(true)

    const list = await pf.create({ type: 'list', page: 0, rect: [72, 140, 222, 200] })
    await pf.update([list.id], {
      options: ['One', 'Two', 'Three'].map((v) => ({ label: v, value: v })),
      multiSelect: true
    })
    await pf.update([list.id], { defaultSelection: ['Two', 'Three'] })
    const lw = raw(e, list.id)
    expect(lw.get('V').asJS()).toEqual(['Two', 'Three'])
    expect(lw.get('I').asJS()).toEqual([1, 2])
    const lc = (await core(e, 'List Box1'))[0]
    expect(lc.multiSelect).toBe(true)
    const p = await pf.get(list.id)
    expect(p.defaultSelection).toEqual(['Two', 'Three'])
    expect(p.multiSelect).toBe(true)
  })

  it('stores button actions as standard PDF actions', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const b = await pf.create({ type: 'button', page: 0, rect: [72, 100, 152, 124] })
    await pf.update([b.id], { caption: 'Clear form', action: { kind: 'reset' }, highlight: 'outline' })
    let a = raw(e, b.id).get('A')
    expect(str(a.get('S'))).toBe('ResetForm')
    expect(str(raw(e, b.id).get('MK').get('CA'))).toBe('Clear form')
    expect(str(raw(e, b.id).get('H'))).toBe('O')
    expect((await pf.get(b.id)).action).toEqual({ kind: 'reset' })

    await pf.update([b.id], { action: { kind: 'url', url: 'example.com/help' } })
    a = raw(e, b.id).get('A')
    expect(str(a.get('S'))).toBe('URI')
    expect(str(a.get('URI'))).toBe('https://example.com/help')
    expect((await pf.get(b.id)).action).toEqual({ kind: 'url', url: 'https://example.com/help' })

    await pf.update([b.id], { action: { kind: 'page', page: 3 } })
    a = raw(e, b.id).get('A')
    expect(str(a.get('S'))).toBe('GoTo')
    expect(a.get('D').get(0).asIndirect()).toBe(e.session.pdf.findPage(3).asIndirect())
    expect(str(a.get('D').get(1))).toBe('Fit')
    expect((await pf.get(b.id)).action).toEqual({ kind: 'page', page: 3 })

    await pf.update([b.id], { action: { kind: 'print' } })
    expect(str(raw(e, b.id).get('A').get('N'))).toBe('Print')
    await pf.update([b.id], { action: { kind: 'none' } })
    expect(raw(e, b.id).get('A').isNull()).toBe(true)

    // the appearance shows the caption
    await pf.update([b.id], { caption: 'Submit' })
    expect(raw(e, b.id).get('AP').get('N').readStream().asString()).toContain('Submit')
  })

  it('updates several fields at once', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const a = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122] })
    const b = await pf.create({ type: 'checkbox', page: 0, rect: [72, 140, 86, 154] })
    await pf.update([a.id, b.id], { required: true, borderColor: '#00ff00' })
    expect(e.lastChanges?.journal.undoLabel).toBe('Edit Properties of Fields')
    expect((await pf.get(a.id)).required).toBe(true)
    expect((await pf.get(b.id)).required).toBe(true)
    expect((await pf.get(b.id)).borderColor).toBe('#00ff00')
    await e.doc.undo()
    expect((await pf.get(a.id)).required).toBe(false)
    expect((await pf.get(b.id)).required).toBe(false)
  })
})

describe('prepare-form: scripts', () => {
  it('writes format, keystroke, validate and calculate JavaScript and the calculation order', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const price = await pf.create({ type: 'text', page: 0, rect: [72, 100, 172, 122], name: 'price' })
    const qty = await pf.create({ type: 'text', page: 0, rect: [72, 130, 172, 152], name: 'qty' })
    const total = await pf.create({ type: 'text', page: 0, rect: [72, 160, 172, 182], name: 'total' })
    const avg = await pf.create({ type: 'text', page: 0, rect: [72, 190, 172, 212], name: 'avg' })
    await pf.update([price.id], {
      format: { kind: 'number', decimals: 2, separator: 0, negative: 0, currency: '$', currencyPrepend: true },
      validate: { kind: 'range', min: 0, max: 1000 }
    })
    await pf.update([qty.id], { format: { kind: 'number', decimals: 0, separator: 0, negative: 0, currency: '', currencyPrepend: true } })
    await pf.update([total.id], { calculate: { kind: 'notation', expr: 'price * qty' }, readOnly: true })
    await pf.update([avg.id], { calculate: { kind: 'simple', op: 'AVG', fields: ['price', 'qty'] }, format: { kind: 'percent', decimals: 1, separator: 1 } })

    const all = await forms.listAll()
    const by = (n: string) => all.find((f) => f.name === n)!
    expect(by('price').scripts.format).toBe('AFNumber_Format(2, 0, 0, 0, "$", true);')
    expect(by('price').scripts.keystroke).toBe('AFNumber_Keystroke(2, 0, 0, 0, "$", true);')
    expect(by('price').scripts.validate).toBe('AFRange_Validate(true, 0, true, 1000);')
    expect(by('total').scripts.calculate).toBe("event.value = getField('price').value * getField('qty').value;")
    expect(by('avg').scripts.calculate).toBe('AFSimple_Calculate("AVG", new Array ("price", "qty"));')
    expect(by('avg').scripts.format).toBe('AFPercent_Format(1, 1);')
    // the JavaScript sits in the field's /AA as JavaScript actions
    const aa = raw(e, price.id).get('AA')
    expect(str(aa.get('F').get('S'))).toBe('JavaScript')

    expect(await forms.calculationOrder()).toEqual(['total', 'avg'])
    expect(await pf.calculationOrder()).toEqual([
      { id: total.id, name: 'total' },
      { id: avg.id, name: 'avg' }
    ])
    await pf.setCalculationOrder([avg.id, total.id])
    expect(await forms.calculationOrder()).toEqual(['avg', 'total'])

    // read back as specs
    expect((await pf.get(total.id)).calculate).toEqual({ kind: 'notation', expr: 'price * qty' })
    expect((await pf.get(avg.id)).calculate).toEqual({ kind: 'simple', op: 'AVG', fields: ['price', 'qty'] })
    expect((await pf.get(price.id)).validate).toEqual({ kind: 'range', min: 0, max: 1000 })

    // renaming a field updates the calculations that use it
    await pf.rename(price.id, 'unit price')
    expect((await pf.get(total.id)).calculate).toEqual({ kind: 'notation', expr: 'unit\\ price * qty' })
    expect((await pf.get(avg.id)).calculate).toEqual({ kind: 'simple', op: 'AVG', fields: ['unit price', 'qty'] })
    expect((await core(e, 'total'))[0].scripts.calculate).toBe("event.value = getField('unit price').value * getField('qty').value;")

    // removing a calculation takes the field out of /CO; deleting a field too
    await pf.update([avg.id], { calculate: { kind: 'none' } })
    expect(await forms.calculationOrder()).toEqual(['total'])
    await pf.delete([total.id])
    expect(acroForm(e).get('CO').isNull()).toBe(true)

    const again = await roundTrip(e)
    const p2 = await again.ops<typeof pfOps>('prepare-form').listPage(0)
    expect(p2.find((f) => f.name === 'unit price')!.format).toEqual({ kind: 'number', decimals: 2, separator: 0, negative: 0, currency: '$', currencyPrepend: true })
  })

  it('rejects an invalid simplified notation', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const f = await pf.create({ type: 'text', page: 0, rect: [72, 100, 172, 122] })
    await expect(pf.update([f.id], { calculate: { kind: 'notation', expr: '(a + b' } })).rejects.toThrow(/not valid/)
    expect((await pf.get(f.id)).calculate).toEqual({ kind: 'none' })
  })

  it('formats dates, times and special formats', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const d = await pf.create({ type: 'date', page: 0, rect: [72, 100, 172, 122], props: { format: { kind: 'date', pattern: 'dd.mm.yyyy' } } })
    expect((await pf.get(d.id)).format).toEqual({ kind: 'date', pattern: 'dd.mm.yyyy' })
    expect((await pf.get(d.id)).type).toBe('date')
    await pf.update([d.id], { format: { kind: 'time', style: 1 } })
    expect((await pf.get(d.id)).type).toBe('text')
    expect((await core(e, 'Date1'))[0].scripts.format).toBe('AFTime_Format(1);')
    await pf.update([d.id], { format: { kind: 'special', style: 2 } })
    expect((await core(e, 'Date1'))[0].scripts.keystroke).toBe('AFSpecial_Keystroke(2);')
    await pf.update([d.id], { format: { kind: 'none' } })
    const c = (await core(e, 'Date1'))[0]
    expect(c.scripts.format).toBeUndefined()
    expect(c.scripts.keystroke).toBeUndefined()
    expect(raw(e, d.id).get('AA').isNull()).toBe(true)
  })
})

describe('prepare-form: names', () => {
  it('renames fields, keeps names unique and supports dotted names', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const a = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122] })
    const b = await pf.create({ type: 'text', page: 0, rect: [72, 130, 222, 152] })
    expect(b.name).toBe('Text2')
    await pf.rename(a.id, 'email')
    expect(e.lastChanges?.journal.undoLabel).toBe('Rename Field')
    await expect(pf.rename(b.id, 'email')).rejects.toMatchObject({ code: 'NAME_SHARED' })
    await expect(pf.rename(b.id, '')).rejects.toThrow(/Enter a field name/)
    await expect(pf.rename(b.id, 'a..b')).rejects.toThrow(/period/)
    // the next automatic name continues after the highest number
    expect(await pf.nextName('text')).toBe('Text3')

    await pf.rename(b.id, 'address.city')
    await pf.create({ type: 'text', page: 0, rect: [72, 160, 222, 182], name: 'address.zip' })
    expect((await forms.listAll()).map((f) => f.name)).toEqual(['email', 'address.city', 'address.zip'])
    const fields = refs(acroForm(e).get('Fields'))
    expect(fields.length).toBe(2)
    const parent = raw(e, fields[1])
    expect(str(parent.get('T'))).toBe('address')
    expect(refs(parent.get('Kids')).length).toBe(2)
    // a field cannot hold other fields
    await expect(pf.rename(b.id, 'email.home')).rejects.toThrow(/already a field/)

    // moving the last field out of a group removes the empty group
    const zip = (await forms.listAll()).find((f) => f.name === 'address.zip')!
    await pf.rename(b.id, 'city')
    await pf.rename(zip.id, 'zip')
    expect(refs(acroForm(e).get('Fields')).length).toBe(3)
    expect((await pf.fieldNames()).sort()).toEqual(['city', 'email', 'zip'])

    const again = await roundTrip(e)
    expect((await again.ops<typeof formOps>('forms').listAll()).map((f) => f.name)).toEqual(['email', 'city', 'zip'])
  })

  it('lets two fields share a name (and value) when asked', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const a = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122], name: 'name' })
    const b = await pf.create({ type: 'text', page: 1, rect: [72, 100, 222, 122] })
    const cb = await pf.create({ type: 'checkbox', page: 1, rect: [72, 140, 86, 154] })
    await expect(pf.rename(cb.id, 'name', { join: true })).rejects.toMatchObject({ code: 'NAME_EXISTS' })
    await pf.rename(b.id, 'name', { join: true })
    const shared = await core(e, 'name')
    expect(shared.map((f) => f.page)).toEqual([0, 1])
    expect((await pf.get(a.id)).widgetCount).toBe(2)
    await forms.setValues([{ name: 'name', value: 'Ada' }])
    expect((await core(e, 'name')).map((f) => f.value)).toEqual(['Ada', 'Ada'])
    const again = await roundTrip(e)
    const f2 = (await again.ops<typeof formOps>('forms').listAll()).filter((f) => f.name === 'name')
    expect(f2.map((f) => f.value)).toEqual(['Ada', 'Ada'])
  })

  it('moves a radio button to another group by renaming it', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const a = await pf.create({ type: 'radio', page: 0, rect: [72, 100, 86, 114], name: 'color' })
    await pf.create({ type: 'radio', page: 0, rect: [100, 100, 114, 114], name: 'color' })
    const c = await pf.create({ type: 'radio', page: 0, rect: [128, 100, 142, 114] })
    expect(c.name).toBe('Group1')
    const moved = await pf.rename(c.id, 'color')
    expect(moved.name).toBe('color')
    expect(moved.exportValue).toBe('Choice3')
    expect((await pf.get(a.id)).widgetCount).toBe(3)
    // the empty group is gone
    expect((await pf.fieldNames())).toEqual(['color'])
  })
})

describe('prepare-form: moving, duplicating and deleting', () => {
  it('moves and resizes fields', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const a = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122] })
    const b = await pf.create({ type: 'checkbox', page: 0, rect: [72, 140, 86, 154] })
    await pf.move([a.id, b.id], 10, -20)
    expect(e.lastChanges?.journal.undoLabel).toBe('Move Fields')
    let all = await forms.listAll()
    expect(all[0].rect.map(Math.round)).toEqual([82, 80, 232, 102])
    expect(all[1].rect.map(Math.round)).toEqual([82, 120, 96, 134])
    await pf.setRects([{ id: b.id, rect: [82, 120, 102, 140] }])
    all = await forms.listAll()
    expect(all[1].rect.map(Math.round)).toEqual([82, 120, 102, 140])
    // the check box appearance is redrawn at the new size
    const bbox = raw(e, b.id).get('AP').get('N').get('Yes').get('BBox').asJS()
    expect(bbox).toEqual([0, 0, 20, 20])
    // moving off the page is stopped at the edge
    await pf.move([a.id], -500, 0)
    expect((await pf.get(a.id)).rect.map(Math.round)).toEqual([0, 80, 150, 102])
    await e.doc.undo()
    expect((await pf.get(a.id)).rect.map(Math.round)).toEqual([82, 80, 232, 102])
  })

  it('duplicates fields on the same page with new names', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const a = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122], props: { required: true, tooltip: 'x' } })
    const r = await pf.create({ type: 'radio', page: 0, rect: [72, 140, 86, 154], name: 'pick' })
    const copies = await pf.duplicate([a.id, r.id], { offset: [0, 50] })
    expect(e.lastChanges?.journal.undoLabel).toBe('Duplicate Field')
    expect(copies.map((f) => f.name)).toEqual(['Text2', 'pick'])
    expect(copies[0].rect.map(Math.round)).toEqual([72, 150, 222, 172])
    expect(copies[0].required).toBe(true)
    expect(copies[0].tooltip).toBe('x')
    expect(copies[1].exportValue).toBe('Choice2')
    expect((await forms.listAll()).length).toBe(4)
  })

  it('duplicates fields across pages as one shared field', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const a = await pf.create({ type: 'text', page: 0, rect: [72, 700, 222, 722], name: 'initials', props: { borderColor: '#000000' } })
    const cb = await pf.create({ type: 'checkbox', page: 0, rect: [300, 700, 314, 714], name: 'ok' })
    const copies = await pf.duplicate([a.id, cb.id], { pages: [0, 1, 2, 3, 4] })
    expect(e.lastChanges?.journal.undoLabel).toBe('Duplicate Field Across Pages')
    expect(copies.length).toBe(8)
    const initials = await core(e, 'initials')
    expect(initials.map((f) => f.page)).toEqual([0, 1, 2, 3, 4])
    expect(initials.every((f) => f.rect.map(Math.round).join() === '72,700,222,722')).toBe(true)
    expect(initials.every((f) => f.borderColor === '#000000')).toBe(true)
    // one field with five widgets
    const parent = raw(e, a.id).get('Parent')
    expect(refs(parent.get('Kids')).length).toBe(5)
    expect(str(parent.get('T'))).toBe('initials')
    expect(refs(acroForm(e).get('Fields')).length).toBe(2)
    await forms.setValues([{ name: 'initials', value: 'AL' }])
    expect((await core(e, 'initials')).every((f) => f.value === 'AL')).toBe(true)
    await forms.setValue(cb.id, true)
    expect((await core(e, 'ok')).every((f) => f.checked)).toBe(true)

    const again = await roundTrip(e)
    const f2 = (await again.ops<typeof formOps>('forms').listAll()).filter((f) => f.name === 'initials')
    expect(f2.map((f) => [f.page, f.value])).toEqual([0, 1, 2, 3, 4].map((p) => [p, 'AL']))

    // deleting one copy keeps the others; deleting all removes the field
    await pf.delete([copies[0].id])
    expect((await core(e, 'initials')).length).toBe(4)
    await pf.delete((await core(e, 'initials')).map((f) => f.id))
    expect((await core(e, 'initials')).length).toBe(0)
    expect(refs(acroForm(e).get('Fields')).length).toBe(1)
  })

  it('deletes fields from the page, the field tree and radio groups', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const t = await pf.create({ type: 'text', page: 0, rect: [72, 100, 222, 122] })
    const r1 = await pf.create({ type: 'radio', page: 0, rect: [72, 140, 86, 154], name: 'g' })
    const r2 = await pf.create({ type: 'radio', page: 0, rect: [100, 140, 114, 154], name: 'g' })
    await forms.setValue(r2.id, true)
    const group = raw(e, r1.id).get('Parent').asIndirect()
    await pf.delete([r2.id])
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete Field')
    expect(pageWidgets(e, 0)).toEqual([t.id, r1.id])
    expect(refs(raw(e, group).get('Kids'))).toEqual([r1.id])
    // the selected button is gone, so the group is now off
    expect(str(raw(e, group).get('V'))).toBe('Off')
    await pf.delete([t.id, r1.id])
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete Fields')
    expect(pageWidgets(e, 0)).toEqual([])
    expect(refs(acroForm(e).get('Fields'))).toEqual([])
    expect((await forms.listAll()).length).toBe(0)
    await e.doc.undo()
    expect((await forms.listAll()).length).toBe(2)
    await e.doc.undo()
    expect((await forms.listAll()).length).toBe(3)
    expect((await core(e, 'g')).find((f) => f.id === r2.id)!.checked).toBe(true)
  })

  it('deletes all fields except signed signatures', async () => {
    const e = await openFixture('form.pdf')
    const { pf, forms } = ops(e)
    const before = (await forms.listAll()).length
    expect(before).toBeGreaterThan(5)
    const n = await pf.deleteAll()
    expect(n).toBe(before)
    expect((await forms.listAll()).length).toBe(0)
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete All Fields')
    await e.doc.undo()
    expect((await forms.listAll()).length).toBe(before)
  })

  it('copies fields and pastes them on another page', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const a = await pf.create({ type: 'combo', page: 0, rect: [72, 100, 222, 122], name: 'country', props: { options: [{ label: 'Japan', value: 'JP' }] } })
    const clips = await pf.copy([a.id])
    expect(clips[0].type).toBe('combo')
    const pasted = await pf.paste(2, clips)
    expect(e.lastChanges?.journal.undoLabel).toBe('Paste Fields')
    expect(pasted[0].page).toBe(2)
    expect(pasted[0].name).toBe('country_2')
    expect(pasted[0].options).toEqual([{ label: 'Japan', value: 'JP' }])
    expect((await forms.listAll()).map((f) => [f.name, f.page])).toEqual([
      ['country', 0],
      ['country_2', 2]
    ])
  })

  it('edits fields of an existing form', async () => {
    const e = await openFixture('form.pdf')
    const { pf } = ops(e)
    const all = await pf.listAll()
    const plan = all.fields.filter((f) => f.name === 'plan')
    expect(plan.map((f) => f.type)).toEqual(['radio', 'radio'])
    expect(plan.map((f) => f.exportValue).sort()).toEqual(['basic', 'pro'])
    const country = all.fields.find((f) => f.name === 'country')!
    expect(country.type).toBe('combo')
    // add a radio button to the existing group
    const added = await pf.create({ type: 'radio', page: 0, rect: [320, 250, 336, 266], name: 'plan' })
    expect(added.exportValue).toBe('Choice1')
    expect((await core(e, 'plan')).length).toBe(3)
    await pf.update([country.id], { required: true, tooltip: 'Where you live' })
    const c = (await core(e, 'country'))[0]
    expect(c.required).toBe(true)
    expect(c.options.map((o) => o.label)).toContain('Japan')
    await pf.rename(country.id, 'land')
    expect((await core(e, 'land')).length).toBe(1)
    const again = await roundTrip(e)
    expect((await again.ops<typeof formOps>('forms').listAll()).filter((f) => f.name === 'plan').length).toBe(3)
  })
})

describe('prepare-form: tab order', () => {
  it('orders fields by row, by column and manually', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    // created in a scrambled order
    const b2 = await pf.create({ type: 'text', page: 0, rect: [300, 200, 400, 222], name: 'b2' })
    const a1 = await pf.create({ type: 'text', page: 0, rect: [72, 100, 172, 122], name: 'a1' })
    const b1 = await pf.create({ type: 'text', page: 0, rect: [72, 200, 172, 222], name: 'b1' })
    const a2 = await pf.create({ type: 'text', page: 0, rect: [300, 102, 400, 124], name: 'a2' })
    const names = async () => (await pf.listPage(0)).map((f) => f.name)
    expect(await names()).toEqual(['a1', 'a2', 'b1', 'b2'])
    expect((await pf.listAll()).tabs[0]).toEqual({ page: 0, order: 'row' })

    await pf.setTabOrder(0, 'column')
    expect(await names()).toEqual(['a1', 'b1', 'a2', 'b2'])
    expect(str(e.session.pdf.findPage(0).get('Tabs'))).toBe('C')

    await pf.setTabOrder(0, 'structure', [b2.id, a1.id, a2.id, b1.id])
    expect(await names()).toEqual(['b2', 'a1', 'a2', 'b1'])
    expect(str(e.session.pdf.findPage(0).get('Tabs'))).toBe('S')
    expect(pageWidgets(e, 0)).toEqual([b2.id, a1.id, a2.id, b1.id])
    expect((await pf.get(a2.id)).tabIndex).toBe(2)

    await pf.setTabOrder(0, 'unspecified')
    expect(e.session.pdf.findPage(0).get('Tabs').isNull()).toBe(true)
    expect(await names()).toEqual(['b2', 'a1', 'a2', 'b1'])
    await e.doc.undo()
    expect(str(e.session.pdf.findPage(0).get('Tabs'))).toBe('S')

    const again = await roundTrip(e)
    expect((await again.ops<typeof pfOps>('prepare-form').listPage(0)).map((f) => f.name)).toEqual(['b2', 'a1', 'a2', 'b1'])
  })

  it('keeps other annotations in place when reordering widgets', async () => {
    const e = await openFixture('text.pdf')
    const { pf } = ops(e)
    const linksBefore = pageAnnots(e, 0)
    expect(linksBefore.length).toBeGreaterThan(0)
    const a = await pf.create({ type: 'text', page: 0, rect: [72, 600, 172, 622] })
    const b = await pf.create({ type: 'text', page: 0, rect: [72, 640, 172, 662] })
    await pf.setTabOrder(0, 'structure', [b.id, a.id])
    expect(pageAnnots(e, 0)).toEqual([...linksBefore, b.id, a.id])
  })
})

describe('prepare-form: rendering', () => {
  it('draws the created fields on the page', async () => {
    const e = await openFixture('text.pdf')
    const { pf, forms } = ops(e)
    const cb = await pf.create({ type: 'checkbox', page: 0, rect: [400, 700, 440, 740], props: { checkStyle: 'square', textColor: '#ff0000' } })
    await pf.create({ type: 'text', page: 0, rect: [72, 700, 272, 724], props: { borderColor: '#0000ff', fillColor: '#ffff00', defaultValue: 'Hello' } })
    const render = e.ops<typeof renderOps>('render')
    const pixel = async (x: number, y: number) => {
      const r = await render.page(0, { scale: 1, clip: [x, y, x + 1, y + 1] })
      return Array.from(r.pixels!.slice(0, 3))
    }
    // yellow fill of the text field, blue border
    expect(await pixel(250, 712)).toEqual([255, 255, 0])
    expect(await pixel(150, 700)).toEqual([0, 0, 255])
    // unchecked box is empty, checked box shows a red square
    expect(await pixel(420, 720)).toEqual([255, 255, 255])
    await forms.setValue(cb.id, true)
    expect(await pixel(420, 720)).toEqual([255, 0, 0])
  })
})
