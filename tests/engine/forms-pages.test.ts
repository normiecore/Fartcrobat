import { describe, expect, it } from 'vitest'
import type formOps from '@engine/ops/forms'
import type pageOps from '@engine/ops/pages'
import type textOps from '@engine/ops/text'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import { fixture, openFixture, roundTrip } from './helpers'

describe('forms', () => {
  it('lists fields with types, values and options', async () => {
    const e = await openFixture('form.pdf')
    const forms = e.ops<typeof formOps>('forms')
    const fields = await forms.listAll()
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]))
    expect(byName.fullName.type).toBe('text')
    expect(byName.qty.value).toBe('2')
    expect(byName.subscribe.type).toBe('checkbox')
    expect(byName.subscribe.checked).toBe(false)
    expect(fields.filter((f) => f.name === 'plan').length).toBe(2)
    expect(byName.country.type).toBe('combo')
    expect(byName.country.options.map((o) => o.label)).toContain('Japan')
    expect(byName.notes.multiline).toBe(true)
    expect(e.info.hasForm).toBe(true)
  })

  it('fills text, checkbox, radio and choice fields, with undo and round trip', async () => {
    const e = await openFixture('form.pdf')
    const forms = e.ops<typeof formOps>('forms')
    let fields = await forms.listAll()
    const id = (name: string, onState?: string) =>
      fields.find((f) => f.name === name && (!onState || f.onState === onState))!.id
    await forms.setValue(id('fullName'), 'Ada Lovelace')
    await forms.setValue(id('subscribe'), true)
    await forms.setValue(id('plan', 'pro'), true)
    await forms.setValue(id('country'), 'Japan')
    fields = await forms.listAll()
    const get = (name: string) => fields.filter((f) => f.name === name)
    expect(get('fullName')[0].value).toBe('Ada Lovelace')
    expect(get('subscribe')[0].checked).toBe(true)
    expect(get('plan').find((f) => f.onState === 'pro')!.checked).toBe(true)
    expect(get('plan').find((f) => f.onState === 'basic')!.checked).toBe(false)
    expect(get('country')[0].value).toBe('Japan')

    const again = await roundTrip(e)
    const f2 = await again.ops<typeof formOps>('forms').listAll()
    expect(f2.find((f) => f.name === 'fullName')!.value).toBe('Ada Lovelace')
    expect(f2.find((f) => f.name === 'subscribe')!.checked).toBe(true)

    await forms.reset()
    const f3 = await forms.listAll()
    expect(f3.find((f) => f.name === 'fullName')!.value).toBe('')
    await e.doc.undo()
    expect((await forms.listAll()).find((f) => f.name === 'fullName')!.value).toBe('Ada Lovelace')
  })

  it('stores a raw value while showing formatted text', async () => {
    const e = await openFixture('form.pdf')
    const forms = e.ops<typeof formOps>('forms')
    await forms.setValues([{ name: 'price', value: '1234.5', display: '$1,234.50' }])
    const f = (await forms.listAll()).find((x) => x.name === 'price')!
    expect(f.value).toBe('1234.5')
  })
})

describe('pages', () => {
  it('rotates, deletes, moves and inserts pages with undo', async () => {
    const e = await openFixture('text.pdf')
    const pages = e.ops<typeof pageOps>('pages')
    const text = e.ops<typeof textOps>('text')
    await pages.rotate([0, 1], 90)
    expect(e.lastChanges?.structure).toBe(true)
    let info = await e.doc.info()
    expect(info.pages[0].rotation).toBe(90)
    expect(Math.round(info.pages[0].width)).toBe(792)

    await pages.delete([1])
    info = await e.doc.info()
    expect(info.pageCount).toBe(4)
    expect(await text.plain(1)).toContain('Chapter 3')

    await pages.move([3], 0)
    expect(await text.plain(0)).toContain('Chapter 5')

    await pages.insertBlank(0, { count: 2 })
    expect((await e.doc.info()).pageCount).toBe(6)

    await e.doc.undo()
    await e.doc.undo()
    await e.doc.undo()
    await e.doc.undo()
    info = await e.doc.info()
    expect(info.pageCount).toBe(5)
    expect(info.pages[0].rotation).toBe(0)
  })

  it('inserts pages from another PDF and from an image, extracts, replaces and crops', async () => {
    const e = await openFixture('text.pdf')
    const pages = e.ops<typeof pageOps>('pages')
    const n = await pages.insertFrom(5, fixture('compare-a.pdf'), { fileName: 'compare-a.pdf' })
    expect(n).toBe(1)
    await pages.insertFrom(-1, fixture('scan.png'), { fileName: 'scan.png' })
    let info = await e.doc.info()
    expect(info.pageCount).toBe(7)
    expect(await e.ops<typeof textOps>('text').plain(5)).toContain('Quarterly report')

    const bytes = await pages.extract([0, 2])
    const e2 = await createLocalEngine()
    const res = await e2.ops<typeof docOps>('doc').open(bytes, { fileName: 'x.pdf' })
    expect(res.ok && res.info.pageCount).toBe(2)

    await pages.replace(0, fixture('compare-b.pdf'), { fileName: 'compare-b.pdf' })
    expect(await e.ops<typeof textOps>('text').plain(0)).toContain('audit team')
    expect((await e.doc.info()).pageCount).toBe(7)

    await pages.setBox([1], [50, 50, 350, 450])
    info = await e.doc.info()
    expect(Math.round(info.pages[1].width)).toBe(300)
    expect(Math.round(info.pages[1].height)).toBe(400)
    const b = e.session.pageBounds(1)
    expect(Math.round(b[2] - b[0])).toBe(300)

    const rt = await roundTrip(e)
    expect(rt.info.pageCount).toBe(7)
  })

  it('sets page labels', async () => {
    const e = await openFixture('text.pdf')
    const pages = e.ops<typeof pageOps>('pages')
    await pages.setLabels([
      { start: 0, style: 'r' },
      { start: 2, style: 'D', prefix: 'A-', first: 1 }
    ])
    const info = await e.doc.info()
    expect(info.pages.map((p) => p.label)).toEqual(['i', 'ii', 'A-1', 'A-2', 'A-3'])
  })
})
