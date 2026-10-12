import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type formOps from '@engine/ops/forms'
import type navOps from '@engine/ops/nav'
import type pageOps from '@engine/ops/pages'
import type textOps from '@engine/ops/text'
import { catalog } from '@engine/util/pdf'
import { nestedTreePdf, openBytes, reopen, richCatalogPdf, signedFormPdf } from './core-docs'
import { fixture, openFixture, roundTrip, type OpenedEngine } from './helpers'

function catalogKeys(e: OpenedEngine): string[] {
  const keys: string[] = []
  catalog(e.session.pdf).forEach((_v, k) => keys.push(String(k)))
  return keys.sort()
}

async function firstLines(e: OpenedEngine): Promise<string[]> {
  const text = e.ops<typeof textOps>('text')
  const out: string[] = []
  for (let i = 0; i < e.info.pageCount; i++) out.push((await text.plain(i)).trim().split('\n')[0])
  return out
}

describe('moving and reordering pages', () => {
  it('keeps every catalog entry: labels, language, attachments, metadata, structure, open action', async () => {
    const e = await openBytes(richCatalogPdf(), 'rich.pdf')
    const pages = e.ops<typeof pageOps>('pages')
    const before = catalogKeys(e)
    expect(before).toEqual(
      expect.arrayContaining([
        'Lang',
        'Metadata',
        'Names',
        'OpenAction',
        'PageLabels',
        'StructTreeRoot',
        'ViewerPreferences'
      ])
    )
    await pages.move([4], 0)
    expect(catalogKeys(e)).toEqual(before)
    let info = await e.doc.info()
    expect(info.pages.map((p) => p.label)).toEqual(['i', 'ii', 'A-1', 'A-2', 'A-3'])
    expect(info.language).toBe('en-GB')
    expect(info.attachmentCount).toBe(1)
    expect(await e.ops<typeof textOps>('text').plain(0)).toContain('Chapter 5')
    // the outline still points at the moved page
    const outline = await e.ops<typeof navOps>('nav').outline()
    expect(outline.find((o) => o.title === 'Chapter 5')?.dest?.page).toBe(0)

    await pages.reorder([4, 3, 2, 1, 0])
    expect(catalogKeys(e)).toEqual(before)
    const rt = await roundTrip(e)
    expect(rt.info.attachmentCount).toBe(1)
    expect(rt.info.language).toBe('en-GB')
    expect(rt.info.pages.map((p) => p.label)).toEqual(['i', 'ii', 'A-1', 'A-2', 'A-3'])

    await e.doc.undo()
    await e.doc.undo()
    info = await e.doc.info()
    expect(await e.ops<typeof textOps>('text').plain(0)).toContain('Chapter 1')
  })

  it('keeps the form of a fillable PDF', async () => {
    const e = await openFixture('form.pdf')
    const forms = e.ops<typeof formOps>('forms')
    const count = (await forms.listAll()).length
    await e.ops<typeof pageOps>('pages').reorder([0])
    await e.ops<typeof pageOps>('pages').insertBlank(1)
    await e.ops<typeof pageOps>('pages').move([1], 0)
    const info = await e.doc.info()
    expect(info.hasForm).toBe(true)
    expect((await forms.listAll()).length).toBe(count)
    const rt = await roundTrip(e)
    expect(rt.info.hasForm).toBe(true)
  })

  it('keeps sizes, rotation and resources the pages inherited from intermediate page tree nodes', async () => {
    const e = await openBytes(nestedTreePdf(), 'nested.pdf')
    expect(await firstLines(e)).toEqual(['First', 'Second', 'Third'])
    const sizes = (info: typeof e.info) =>
      info.pages.map((p) => [Math.round(p.width), Math.round(p.height), p.rotation])
    const before = sizes(e.info)
    expect(before).toEqual([
      [612, 792, 0],
      [300, 400, 90],
      [300, 400, 90]
    ])
    await e.ops<typeof pageOps>('pages').move([2], 0)
    const info = await e.doc.info()
    expect(sizes(info)).toEqual([before[2], before[0], before[1]])
    expect(await firstLines(Object.assign(e, { info }))).toEqual(['Third', 'First', 'Second'])
  })
})

describe('copying pages keeps annotations, links and form fields', () => {
  it('duplicates comments and links, and links to copied pages follow the copy', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    const nav = e.ops<typeof navOps>('nav')
    const note = await annots.create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'Check this' })
    await annots.reply(note.id, 'Agreed')
    await annots.create(0, { type: 'Square', rect: [200, 200, 300, 260], color: '#ff0000' })
    const linksBefore = await nav.links(0)
    await e.ops<typeof pageOps>('pages').duplicate([0])
    const copy = await annots.list(1)
    expect(copy.map((a) => a.type).sort()).toEqual(['Square', 'Text', 'Text'])
    const copiedNote = copy.find((a) => a.contents === 'Check this')!
    expect(copiedNote.id).not.toBe(note.id)
    const reply = copy.find((a) => a.contents === 'Agreed')!
    expect(reply.inReplyTo).toBe(copiedNote.id)
    // the original is untouched
    expect((await annots.list(0)).length).toBe(3)
    // links: external kept, internal (to page 3 of the original) still goes to that page
    const links = await nav.links(1)
    expect(links.length).toBe(linksBefore.length)
    expect(links.find((l) => l.external)?.uri).toBe('https://example.com')
    expect(links.find((l) => !l.external)?.dest?.page).toBe(3)
    // editing the copy does not change the original
    await annots.update(copy.find((a) => a.type === 'Square')!.id, { color: '#00ff00' })
    expect((await annots.list(0)).find((a) => a.type === 'Square')!.color).toBe('#ff0000')
  })

  it('extracts pages with their comments; links to pages left behind are dropped', async () => {
    const e = await openFixture('text.pdf')
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    const bytes = await e.ops<typeof pageOps>('pages').extract([0])
    const out = await openBytes(bytes, 'extract.pdf')
    expect((await out.ops<typeof annotOps>('annots').list(0)).map((a) => a.type)).toEqual(['Square'])
    const links = await out.ops<typeof navOps>('nav').links(0)
    expect(links.map((l) => l.external)).toEqual([true])
    // the extracted file did not drag the rest of the document along
    expect(out.info.pageCount).toBe(1)
    const d = reopen(bytes)
    expect(d.countObjects()).toBeLessThan(40)
    d.destroy()
  })

  it('extracts and inserts form fields, renaming the ones whose name is taken', async () => {
    const e = await openFixture('form.pdf')
    const bytes = await e.ops<typeof pageOps>('pages').extract([0])
    const out = await openBytes(bytes, 'extract.pdf')
    expect(out.info.hasForm).toBe(true)
    const names = (await e.ops<typeof formOps>('forms').listAll()).map((f) => f.name).sort()
    expect((await out.ops<typeof formOps>('forms').listAll()).map((f) => f.name).sort()).toEqual(names)

    const t = await openFixture('text.pdf')
    await t.ops<typeof pageOps>('pages').insertFrom(1, fixture('form.pdf'), { fileName: 'form.pdf' })
    let info = await t.doc.info()
    expect(info.hasForm).toBe(true)
    const inserted = await t.ops<typeof formOps>('forms').list(1)
    expect(inserted.map((f) => f.name).sort()).toEqual(names)
    // insert the same form again: the second copy gets its own names
    await t.ops<typeof pageOps>('pages').insertFrom(2, fixture('form.pdf'), { fileName: 'form.pdf' })
    const second = await t.ops<typeof formOps>('forms').list(2)
    expect(second.map((f) => f.name)).toContain('fullName_2')
    const forms = t.ops<typeof formOps>('forms')
    await forms.setValue(second.find((f) => f.name === 'fullName_2')!.id, 'Second')
    const first = (await forms.list(1)).find((f) => f.name === 'fullName')!
    expect(first.value).not.toBe('Second')
    // radio groups stay groups
    const plan = second.filter((f) => f.name === 'plan_2')
    expect(plan.length).toBe(2)
    info = await t.doc.info()
    const rt = await roundTrip(t)
    expect(rt.info.hasForm).toBe(true)
    expect((await rt.ops<typeof formOps>('forms').listAll()).length).toBe(names.length * 2)
  })

  it('duplicates a page with form fields as independent fields; copied signatures come out unsigned', async () => {
    const e = await openBytes(signedFormPdf(), 'signed.pdf')
    const forms = e.ops<typeof formOps>('forms')
    await e.ops<typeof pageOps>('pages').duplicate([1])
    const copy = await forms.list(2)
    expect(copy.map((f) => f.name).sort()).toEqual(['Name_2', 'Signature1_2'])
    expect(copy.find((f) => f.type === 'signature')!.signed).toBe(false)
    expect((await e.doc.info()).signatureCount).toBe(1)
    const original = (await forms.list(1)).find((f) => f.name === 'Name')!
    await forms.setValue(copy.find((f) => f.name === 'Name_2')!.id, 'Copy')
    expect((await forms.listAll()).find((f) => f.id === original.id)!.value).toBe('Old')
  })
})

describe('deleting pages', () => {
  it('removes the form fields (and signatures) that lived on the deleted pages', async () => {
    const e = await openBytes(signedFormPdf(), 'signed.pdf')
    const acro = catalog(e.session.pdf).get('AcroForm')
    // a calculation order listing the text field and the signature field
    e.session.runMutation('Set Calculation Order', () => {
      const co = e.session.pdf.newArray()
      co.push(acro.get('Fields').get(0))
      co.push(acro.get('Fields').get(2))
      acro.put('CO', co)
    })
    await e.ops<typeof pageOps>('pages').delete([1])
    const info = await e.doc.info()
    expect(info.signatureCount).toBe(0)
    expect(info.hasForm).toBe(true)
    const d = e.session.pdf
    const fields = catalog(d).get('AcroForm', 'Fields')
    const names: string[] = []
    fields.forEach((f) => names.push(f.resolve().get('T').asString()))
    expect(names.sort()).toEqual(['Choice', 'Name'])
    const name = fields.get(0).resolve()
    expect(name.get('Kids').length).toBe(1)
    const co = catalog(d).get('AcroForm', 'CO')
    expect(co.length).toBe(1)
    expect(co.get(0).resolve().get('T').asString()).toBe('Name')
    await e.doc.undo()
    expect((await e.doc.info()).signatureCount).toBe(1)
  })
})
