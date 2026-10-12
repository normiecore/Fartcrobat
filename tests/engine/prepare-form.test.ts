import { describe, expect, it } from 'vitest'
import type formOps from '@engine/ops/forms'
import type pfOps from '@features/prepare-form/engine'
import type { PFField } from '@features/prepare-form/model'
import { openFixture, roundTrip, type OpenedEngine } from './helpers'

function ops(e: OpenedEngine) {
  return {
    pf: e.ops<typeof pfOps>('prepare-form'),
    forms: e.ops<typeof formOps>('forms')
  }
}

async function byName(e: OpenedEngine) {
  const { fields } = await ops(e).pf.listAll()
  const map: Record<string, PFField[]> = {}
  for (const f of fields) (map[f.name] ??= []).push(f)
  return map
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
    const list = await pf.create({ type: 'list', page: 0, rect: [300, 100, 450, 160], props: { options: [{ label: 'Red', value: 'r' }, { label: 'Green', value: 'Green' }] } })
    const combo = await pf.create({ type: 'combo', page: 0, rect: [300, 180, 450, 202], props: { options: [{ label: 'A', value: 'A' }, { label: 'B', value: 'B' }, { label: 'C', value: 'C' }], editable: true } })
    const btn = await pf.create({ type: 'button', page: 0, rect: [300, 220, 380, 244], props: { caption: 'Clear', action: { kind: 'reset' } } })
    const sig = await pf.create({ type: 'signature', page: 1, rect: [72, 600, 252, 640] })
    const date = await pf.create({ type: 'date', page: 1, rect: [300, 600, 400, 622] })
    expect([list.name, combo.name, btn.name, sig.name, date.name]).toEqual(['List Box1', 'Dropdown1', 'Button1', 'Signature1', 'Date1'])
    expect(date.type).toBe('date')
    expect(date.format).toEqual({ kind: 'date', pattern: 'mm/dd/yyyy' })

    const core = await forms.listAll()
    const t = (n: string) => core.filter((f) => f.name === n)
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
    expect(t('Date1')[0].scripts.format).toBe('AFDate_FormatEx("mm/dd/yyyy");')
    expect(t('Date1')[0].scripts.keystroke).toBe('AFDate_KeystrokeEx("mm/dd/yyyy");')
    // rectangles are kept in page space
    expect(t('Text1')[0].rect.map(Math.round)).toEqual([72, 100, 222, 122])

    const info = await e.doc.info()
    expect(info.hasForm).toBe(true)
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
    const core = await again.ops<typeof formOps>('forms').listAll()
    const f = (n: string) => core.filter((x) => x.name === n)
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
    await e.doc.redo()
    expect((await forms.listAll()).map((f) => f.name)).toEqual(['Text1'])
  })
})
