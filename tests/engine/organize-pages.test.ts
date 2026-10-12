import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type docOps from '@engine/ops/doc'
import type formOps from '@engine/ops/forms'
import type navOps from '@engine/ops/nav'
import type pageOps from '@engine/ops/pages'
import type textOps from '@engine/ops/text'
import { createLocalEngine } from '@engine/local'
import type organizeOps from '@features/organize-pages/engine'
import { fixture, openFixture, roundTrip, type OpenedEngine } from './helpers'

async function openBytes(bytes: Uint8Array, name = 'out.pdf'): Promise<OpenedEngine> {
  const engine = await createLocalEngine()
  const doc = engine.ops<typeof docOps>('doc')
  const res = await doc.open(bytes, { fileName: name })
  if (!res.ok) throw new Error('needs password')
  return Object.assign(engine, { info: res.info, doc })
}

const org = (e: OpenedEngine) => e.ops<typeof organizeOps>('organize-pages')
const text = (e: OpenedEngine) => e.ops<typeof textOps>('text')
const nav = (e: OpenedEngine) => e.ops<typeof navOps>('nav')

async function chapters(e: OpenedEngine): Promise<string[]> {
  const n = (await e.doc.info()).pageCount
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const t = await text(e).plain(i)
    const m = /Chapter (\d)/.exec(t)
    out.push(
      m
        ? `C${m[1]}`
        : t.includes('audit team')
          ? 'audit team'
          : t.includes('Quarterly report')
            ? 'Quarterly report'
            : t.trim()
              ? 'other'
              : 'blank'
    )
  }
  return out
}

describe('organize-pages: combine', () => {
  it('combines PDFs and images with one bookmark per file and keeps their bookmarks and links', async () => {
    const e = await createLocalEngine()
    const bytes = await e.ops<typeof organizeOps>('organize-pages').combine([
      { data: fixture('text.pdf'), fileName: 'text.pdf', pages: [0, 2] },
      { data: fixture('compare-a.pdf'), fileName: 'compare-a.pdf' },
      { data: fixture('scan.png'), fileName: 'scan.png', title: 'The scan' }
    ])
    const out = await openBytes(bytes)
    expect(out.info.pageCount).toBe(4)
    const outline = await nav(out).outline()
    expect(outline.map((o) => o.title)).toEqual(['text', 'compare-a', 'The scan'])
    expect(outline.map((o) => o.dest?.page)).toEqual([0, 2, 3])
    // text.pdf's own bookmarks survive for the pages that were taken (Chapter 1 and 3).
    expect(outline[0].children.map((c) => [c.title, c.dest?.page])).toEqual([
      ['Chapter 1', 0],
      ['Chapter 3', 1]
    ])
    // The internal link on page 1 pointed at page 3, which is now page 2 of the result.
    const links = await nav(out).links(0)
    expect(links.find((l) => l.external)?.uri).toBe('https://example.com')
    expect(links.find((l) => !l.external)?.dest?.page).toBe(1)
    expect(await text(out).plain(2)).toContain('Quarterly report')
  })

  it('can leave out the file bookmarks', async () => {
    const e = await createLocalEngine()
    const bytes = await e.ops<typeof organizeOps>('organize-pages').combine(
      [
        { data: fixture('compare-a.pdf'), fileName: 'compare-a.pdf' },
        { data: fixture('compare-b.pdf'), fileName: 'compare-b.pdf' }
      ],
      { bookmarks: false }
    )
    const out = await openBytes(bytes)
    expect(out.info.pageCount).toBe(2)
    expect(await nav(out).outline()).toEqual([])
  })

  it('combines from scratch documents and reports passwords', async () => {
    const e = await createLocalEngine()
    const o = e.ops<typeof organizeOps>('organize-pages')
    const locked = await o.openScratch('a', fixture('encrypted.pdf'), 'encrypted.pdf')
    expect(locked).toEqual({ ok: false, needsPassword: true, wrongPassword: false })
    expect(await o.openScratch('a', fixture('encrypted.pdf'), 'encrypted.pdf', 'nope')).toMatchObject({
      wrongPassword: true
    })
    const ok = await o.openScratch('a', fixture('encrypted.pdf'), 'encrypted.pdf', 'secret')
    expect(ok.ok && ok.pageCount).toBeGreaterThan(0)
    const b = await o.openScratch('b', fixture('mixed-sizes.pdf'), 'mixed-sizes.pdf')
    expect(b.ok && b.pages.map((p) => Math.round(p.width))).toEqual([595, 842, 612])
    const thumb = await o.scratchThumbnail('b', 1, 120)
    expect(thumb.width).toBe(120)
    expect(thumb.png.slice(1, 4)).toEqual(new Uint8Array([80, 78, 71]))
    const bytes = await o.combine([
      { key: 'b', fileName: 'mixed-sizes.pdf', pages: [2] },
      { key: 'a', fileName: 'encrypted.pdf' }
    ])
    const out = await openBytes(bytes)
    expect(out.info.pageCount).toBe(1 + (ok.ok ? ok.pageCount : 0))
    expect(out.info.encryption).toBeNull()
    await o.closeScratch('a')
    await expect(o.combine([{ key: 'a', fileName: 'encrypted.pdf' }])).rejects.toThrow(/no longer open/)
  })

  it('keeps comments and form fields, renaming clashing field names', async () => {
    const form = await openFixture('form.pdf')
    await form
      .ops<typeof annotOps>('annots')
      .create(0, { type: 'Square', rect: [50, 50, 150, 120], contents: 'Check this' } as never)
    const annotated = await form.doc.save({})
    const e = await createLocalEngine()
    const bytes = await e.ops<typeof organizeOps>('organize-pages').combine([
      { data: annotated, fileName: 'one.pdf' },
      { data: fixture('form.pdf'), fileName: 'two.pdf' }
    ])
    const out = await openBytes(bytes)
    const fields = await out.ops<typeof formOps>('forms').listAll()
    const names = fields.map((f) => f.name)
    expect(names).toContain('fullName')
    expect(names).toContain('fullName_2')
    expect(fields.filter((f) => f.name === 'plan').length).toBe(2)
    expect(fields.filter((f) => f.name === 'plan_2').length).toBe(2)
    const annots = await out.ops<typeof annotOps>('annots').list(0)
    expect(annots.some((a) => a.type === 'Square' && a.contents === 'Check this')).toBe(true)
    // The copy can be filled independently.
    const forms = out.ops<typeof formOps>('forms')
    const id = fields.find((f) => f.name === 'fullName_2')!.id
    await forms.setValue(id, 'Grace')
    const after = await forms.listAll()
    expect(after.find((f) => f.name === 'fullName_2')!.value).toBe('Grace')
    expect(after.find((f) => f.name === 'fullName')!.value).toBe('')
    const rt = await roundTrip(out)
    expect(rt.info.pageCount).toBe(2)
  })
})

describe('organize-pages: page operations', () => {
  it('inserts files in one undoable step, keeping bookmarks', async () => {
    const e = await openFixture('text.pdf')
    const inserted = await org(e).insertFiles(1, [
      { data: fixture('compare-a.pdf'), fileName: 'compare-a.pdf' },
      { data: fixture('scan.png'), fileName: 'scan.png' }
    ])
    expect(inserted).toEqual([1, 2])
    expect(e.lastChanges?.structure).toBe(true)
    expect(e.lastChanges?.journal.undoLabel).toBe('Insert Pages')
    expect(await chapters(e)).toEqual(['C1', 'Quarterly report', 'blank', 'C2', 'C3', 'C4', 'C5'])
    // existing links and bookmarks still point at the right pages
    const outline = await nav(e).outline()
    expect(outline.find((o) => o.title === 'Chapter 2')?.dest?.page).toBe(3)
    await e.doc.undo()
    expect(await chapters(e)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])
  })

  it('inserts only the chosen pages of a password-protected file', async () => {
    const e = await openFixture('text.pdf')
    await expect(
      org(e).insertFiles(0, [{ data: fixture('encrypted.pdf'), fileName: 'encrypted.pdf' }])
    ).rejects.toThrow(/password/)
    const probe = await org(e).probe(fixture('encrypted.pdf'), 'encrypted.pdf', 'secret')
    expect(probe.ok).toBe(true)
    const r = await org(e).insertFiles(-1, [
      { data: fixture('text.pdf'), fileName: 'more.pdf', pages: [4, 3] }
    ])
    expect(r).toEqual([5, 6])
    expect(await chapters(e)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C5', 'C4'])
  })

  it('copies pages into another document without its bookmarks (drag to another tab)', async () => {
    const source = await openFixture('text.pdf')
    const target = await openFixture('mixed-sizes.pdf')
    const before = await nav(target).outline()
    const bytes = await org(source).extract([0, 1])
    const created = await org(target).insertFiles(-1, [{ data: bytes, fileName: 'pages.pdf' }], {
      bookmarks: false
    })
    expect(created).toEqual([3, 4])
    expect((await chapters(target)).slice(3)).toEqual(['C1', 'C2'])
    expect(await nav(target).outline()).toEqual(before)
    // web links come along; the link to a page that was not copied is left out
    const links = await nav(target).links(3)
    expect(links.some((l) => l.external && l.uri.includes('example.com'))).toBe(true)
    expect(links.some((l) => !l.external)).toBe(false)
    expect(target.lastChanges?.dirty).toBe(true)
    await target.doc.undo()
    expect((await target.doc.info()).pageCount).toBe(3)
    expect((await source.doc.info()).pageCount).toBe(5)
  })

  it('extracts pages with their links and bookmarks', async () => {
    const e = await openFixture('text.pdf')
    const bytes = await org(e).extract([0, 2])
    const out = await openBytes(bytes)
    expect(await chapters(out)).toEqual(['C1', 'C3'])
    const outline = await nav(out).outline()
    expect(outline.map((o) => [o.title, o.dest?.page])).toEqual([
      ['Chapter 1', 0],
      ['Chapter 3', 1]
    ])
    expect((await nav(out).links(0)).find((l) => !l.external)?.dest?.page).toBe(1)
    // the source document is untouched
    expect((await e.doc.info()).pageCount).toBe(5)
    expect(e.lastChanges?.dirty).toBe(false)
  })

  it('duplicates pages with comments; links keep their targets', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Text', rect: [20, 20, 40, 40], contents: 'note' } as never)
    const res = await org(e).duplicate([0])
    expect(res).toEqual([1])
    expect(e.lastChanges?.journal.undoLabel).toBe('Duplicate Page')
    expect(await chapters(e)).toEqual(['C1', 'C1', 'C2', 'C3', 'C4', 'C5'])
    const copy = await annots.list(1)
    expect(copy.some((a) => a.type === 'Text' && a.contents === 'note')).toBe(true)
    const links = await nav(e).links(1)
    expect(links.find((l) => !l.external)?.dest?.page).toBe(3) // Chapter 3 moved from 2 to 3
    await e.doc.undo()
    expect(await chapters(e)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])
  })

  it('replaces page content but keeps the original links and bookmarks', async () => {
    const e = await openFixture('text.pdf')
    const r = await org(e).replace(1, 2, { data: fixture('compare-b.pdf'), fileName: 'compare-b.pdf' })
    expect(r).toEqual({ replaced: 1, inserted: 0, removed: 1 })
    expect(await chapters(e)).toEqual(['C1', 'audit team', 'C4', 'C5'])
    const outline = await nav(e).outline()
    expect(outline.find((o) => o.title === 'Chapter 2')?.dest?.page).toBe(1)
    await e.doc.undo()
    expect(await chapters(e)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5'])
    const more = await org(e).replace(4, 4, {
      data: fixture('text.pdf'),
      fileName: 'text.pdf',
      pages: [0, 1]
    })
    expect(more).toEqual({ replaced: 1, inserted: 1, removed: 0 })
    expect(await chapters(e)).toEqual(['C1', 'C2', 'C3', 'C4', 'C1', 'C2'])
    const rt = await roundTrip(e)
    expect(rt.info.pageCount).toBe(6)
  })

  it('reads page label sections', async () => {
    const e = await openFixture('text.pdf')
    expect(await org(e).labelRanges()).toEqual([])
    await e.ops<typeof pageOps>('pages').setLabels([
      { start: 0, style: 'r' },
      { start: 2, style: 'D', prefix: 'A-', first: 3 }
    ])
    expect(await org(e).labelRanges()).toEqual([
      { start: 0, style: 'r', prefix: '', first: 1 },
      { start: 2, style: 'D', prefix: 'A-', first: 3 }
    ])
  })

  it('plans a split by file size', async () => {
    const e = await openFixture('text.pdf')
    const whole = (await org(e).extract([0, 1, 2, 3, 4])).length
    const one = await org(e).splitPlanBySize(whole + 10000)
    expect(one).toEqual([{ start: 0, end: 4 }])
    const parts = await org(e).splitPlanBySize(Math.round(whole * 0.6))
    expect(parts.length).toBeGreaterThan(1)
    expect(parts[0].start).toBe(0)
    expect(parts[parts.length - 1].end).toBe(4)
    for (let i = 1; i < parts.length; i++) expect(parts[i].start).toBe(parts[i - 1].end + 1)
  })
})
