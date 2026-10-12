import { describe, expect, it } from 'vitest'
import type navOps from '@engine/ops/nav'
import type renderOps from '@engine/ops/render'
import type pageOps from '@engine/ops/pages'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type navigationOps from '@features/navigation/engine'
import type { Bookmark } from '@features/navigation/types'
import { openFixture, roundTrip, type OpenedEngine } from './helpers'

const nav = (e: OpenedEngine) => e.ops<typeof navigationOps>('navigation')
const titles = (list: Bookmark[]): unknown[] => list.map((b) => (b.children.length ? [b.title, titles(b.children)] : b.title))

/** Checks the low-level outline invariants MuPDF and Acrobat rely on. */
function checkOutlineStructure(e: OpenedEngine) {
  const pdf = e.session.pdf
  const root = pdf.getTrailer().get('Root').get('Outlines')
  const visit = (node: any): number => {
    let cur = node.get('First')
    let prev: any = null
    let visible = 0
    let last: any = null
    while (!cur.isNull()) {
      expect(cur.get('Parent').asIndirect()).toBe(node.asIndirect())
      if (prev) expect(cur.get('Prev').asIndirect()).toBe(prev.asIndirect())
      else expect(cur.get('Prev').isNull()).toBe(true)
      const kidVisible = visit(cur)
      const count = cur.get('Count')
      if (cur.get('First').isNull()) expect(count.isNull()).toBe(true)
      else expect(Math.abs(count.asNumber())).toBe(kidVisible)
      visible += 1 + (!count.isNull() && count.asNumber() > 0 ? kidVisible : 0)
      prev = cur
      last = cur
      cur = cur.get('Next')
    }
    if (last) expect(node.get('Last').asIndirect()).toBe(last.asIndirect())
    else expect(node.get('Last').isNull()).toBe(true)
    return visible
  }
  const total = visit(root)
  if (total) expect(root.get('Count').asNumber()).toBe(total)
}

describe('navigation: bookmarks', () => {
  it('lists the outline with stable ids and destinations', async () => {
    const e = await openFixture('text.pdf')
    const list = await nav(e).outline()
    expect(list.map((b) => b.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5'])
    expect(list[3].dest).toMatchObject({ page: 3, type: 'Fit' })
    expect(new Set(list.map((b) => b.id)).size).toBe(5)
    expect(list.every((b) => b.id > 0)).toBe(true)
  })

  it('reads nested bookmarks and their open state', async () => {
    const e = await openFixture('navigation/initial-view.pdf')
    const list = await nav(e).outline()
    expect(titles(list)).toEqual([
      ['Part One', ['Introduction', 'Background']],
      ['Part Two', ['Methods', 'Results']],
      'Appendix'
    ])
    expect(list[0].open).toBe(true)
    expect(list[1].children[1].dest?.page).toBe(5)
  })

  it('adds, renames, nests, un-nests and deletes bookmarks with undo', async () => {
    const e = await openFixture('text.pdf')
    const n = nav(e)
    const [c1, c2, c3] = await n.outline()
    // add after chapter 2 at the top level, pointing at a position on page 2
    const id = await n.addBookmark(null, 2, '  Summary\n', { page: 1, x: 72, y: 100, zoom: 1.5 })
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Bookmark')
    expect(e.lastChanges?.dirty).toBe(true)
    let list = await n.outline()
    expect(list.map((b) => b.title)).toEqual(['Chapter 1', 'Chapter 2', 'Summary', 'Chapter 3', 'Chapter 4', 'Chapter 5'])
    const added = list[2]
    expect(added.id).toBe(id)
    expect(added.dest).toMatchObject({ page: 1, type: 'XYZ', zoom: 1.5 })
    expect(added.dest!.x).toBeCloseTo(72)
    expect(added.dest!.y).toBeCloseTo(100)
    checkOutlineStructure(e)

    await n.renameBookmark(id, 'Summary of results')
    expect(e.lastChanges?.journal.undoLabel).toBe('Rename Bookmark')
    // nest the new bookmark and chapter 3 under chapter 2
    await n.moveBookmark(id, c2.id, 0)
    await n.moveBookmark(c3.id, c2.id, -1)
    list = await n.outline()
    expect(titles(list)).toEqual(['Chapter 1', ['Chapter 2', ['Summary of results', 'Chapter 3']], 'Chapter 4', 'Chapter 5'])
    expect(list[1].open).toBe(true)
    checkOutlineStructure(e)
    // core outline (MuPDF) agrees
    const core = await e.ops<typeof navOps>('nav').outline()
    expect(core[1].children.map((c) => c.title)).toEqual(['Summary of results', 'Chapter 3'])
    expect(core[1].children[1].dest?.page).toBe(2)

    // moving a bookmark inside itself is refused
    await expect(n.moveBookmark(c2.id, id, 0)).rejects.toThrow(/inside itself/)
    // un-nest chapter 3 back to the top level before chapter 1
    await n.moveBookmark(c3.id, null, 0)
    list = await n.outline()
    expect(titles(list)).toEqual(['Chapter 3', 'Chapter 1', ['Chapter 2', ['Summary of results']], 'Chapter 4', 'Chapter 5'])
    checkOutlineStructure(e)

    // deleting a parent removes its children
    await n.deleteBookmarks([c2.id, c1.id])
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete Bookmarks')
    list = await n.outline()
    expect(titles(list)).toEqual(['Chapter 3', 'Chapter 4', 'Chapter 5'])
    checkOutlineStructure(e)

    // undo everything step by step
    await e.doc.undo()
    expect(titles(await n.outline())).toEqual(['Chapter 3', 'Chapter 1', ['Chapter 2', ['Summary of results']], 'Chapter 4', 'Chapter 5'])
    await e.doc.undo()
    await e.doc.undo()
    await e.doc.undo()
    expect((await n.outline())[2].title).toBe('Summary of results')
    await e.doc.undo()
    expect((await n.outline())[2].title).toBe('Summary')
    await e.doc.undo()
    expect((await n.outline()).map((b) => b.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5'])
    expect(e.lastChanges?.dirty).toBe(false)
    await e.doc.redo()
    expect((await n.outline()).length).toBe(6)
  })

  it('round-trips edited bookmarks through save', async () => {
    const e = await openFixture('text.pdf')
    const n = nav(e)
    const list = await n.outline()
    const child = await n.addBookmark(list[0].id, -1, 'Ünïcödé – 日本', { page: 0, x: null, y: 300, zoom: null })
    await n.setBookmarkStyle(child, { bold: true, italic: true, color: '#cc0000' })
    await n.setBookmarkDestination(list[4].id, { page: 2, x: null, y: 50, zoom: null })
    const again = await roundTrip(e)
    const out = await nav(again).outline()
    expect(out[0].children[0]).toMatchObject({ title: 'Ünïcödé – 日本', bold: true, italic: true, color: '#cc0000' })
    expect(out[0].children[0].dest?.y).toBeCloseTo(300)
    expect(out[0].children[0].dest?.zoom).toBeNull()
    expect(out[4].dest).toMatchObject({ page: 2, type: 'XYZ' })
    expect(out[4].dest!.y).toBeCloseTo(50)
    checkOutlineStructure(again)
  })

  it('creates the outline in a document without bookmarks and converts rotated destinations', async () => {
    const e = await openFixture('mixed-sizes.pdf')
    const n = nav(e)
    expect(await n.outline()).toEqual([])
    const id = await n.addBookmark(null, -1, 'Rotated', { page: 2, x: 100, y: 200, zoom: null })
    const list = await n.outline()
    expect(list[0].id).toBe(id)
    expect(list[0].dest!.page).toBe(2)
    expect(list[0].dest!.x).toBeCloseTo(100)
    expect(list[0].dest!.y).toBeCloseTo(200)
    await n.deleteBookmarks([id])
    expect(await n.outline()).toEqual([])
    await e.doc.undo()
    expect((await n.outline()).length).toBe(1)
    await e.doc.undo()
    expect(await n.outline()).toEqual([])
    expect(e.lastChanges?.dirty).toBe(false)
  })

  it('reads and repairs an inconsistent outline while editing it, with working undo', async () => {
    const e = await openFixture('navigation/broken-outline.pdf')
    const n = nav(e)
    let list = await n.outline()
    expect(titles(list)).toEqual(['One', ['Two', ['Child']]])
    expect(list[1].dest).toMatchObject({ page: 1, type: 'XYZ' })
    expect(list[1].dest!.y).toBeCloseTo(92)
    // the core outline (MuPDF) can be read too, and reading does not leave the journal in a bad state
    await e.ops<typeof navOps>('nav').outline()
    const id = await n.addBookmark(null, -1, 'Three', { page: 1, x: null, y: null, zoom: null })
    checkOutlineStructure(e)
    list = await n.outline()
    expect(titles(list)).toEqual(['One', ['Two', ['Child']], 'Three'])
    await n.moveBookmark(id, list[1].id, 0)
    checkOutlineStructure(e)
    expect(titles(await n.outline())).toEqual(['One', ['Two', ['Three', 'Child']]])
    await e.doc.undo()
    await e.doc.undo()
    expect(titles(await n.outline())).toEqual(['One', ['Two', ['Child']]])
    const again = await roundTrip(e)
    expect(titles(await nav(again).outline())).toEqual(['One', ['Two', ['Child']]])
  })

  it('keeps destinations pointing at the right page after pages are reordered', async () => {
    const e = await openFixture('text.pdf')
    await e.ops<typeof pageOps>('pages').move([4], 0)
    const list = await nav(e).outline()
    expect(list.find((b) => b.title === 'Chapter 5')!.dest?.page).toBe(0)
    expect(list.find((b) => b.title === 'Chapter 1')!.dest?.page).toBe(1)
  })
})

describe('navigation: attachments', () => {
  it('lists embedded files and file attachment annotations', async () => {
    const e = await openFixture('navigation/attachments.pdf')
    const { files, annotations } = await nav(e).attachments()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ key: 'data.csv', fileName: 'data.csv', size: 29, description: 'Quarterly figures', mimeType: 'text/csv' })
    expect(files[0].modified).toBe('2024-03-05T10:15:00.000Z')
    expect(annotations).toHaveLength(1)
    expect(annotations[0]).toMatchObject({ page: 1, fileName: 'notes.txt', size: 30 })
    const data = await nav(e).attachmentData('data.csv')
    expect(new TextDecoder().decode(data)).toBe('name,amount\nalpha,1\nbeta,2\n')
    const note = await nav(e).annotationFileData(1, annotations[0].id)
    expect(new TextDecoder().decode(note)).toBe('Remember to check the totals.\n')
  })

  it('adds, describes and deletes attachments with undo and round trip', async () => {
    const e = await openFixture('navigation/attachments.pdf')
    const n = nav(e)
    const bytes = new TextEncoder().encode('hello world')
    const key = await n.addAttachment('data.csv', bytes, { mimeType: 'text/csv', description: 'Copy' })
    expect(key).toBe('data (2).csv')
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Attachment')
    expect(e.lastChanges?.document).toBe(true)
    let files = (await n.attachments()).files
    expect(files.map((f) => f.fileName)).toEqual(['data (2).csv', 'data.csv'])
    expect(files[0]).toMatchObject({ size: 11, description: 'Copy' })
    await n.setAttachmentDescription('data.csv', 'Updated description')
    await n.deleteAttachment(key)
    files = (await n.attachments()).files
    expect(files).toHaveLength(1)
    expect(files[0].description).toBe('Updated description')
    await e.doc.undo()
    expect((await n.attachments()).files).toHaveLength(2)
    await e.doc.redo()
    const kept = await n.addAttachment('readme.txt', bytes, {})
    const again = await roundTrip(e)
    const out = await nav(again).attachments()
    expect(out.files.map((f) => f.key).sort()).toEqual(['data.csv', kept].sort())
    expect(new TextDecoder().decode(await nav(again).attachmentData(kept))).toBe('hello world')
    await expect(n.deleteAttachment('missing.bin')).rejects.toThrow(/no longer exists/)
  })

  it('adds the first attachment to a document without any', async () => {
    const e = await openFixture('text.pdf')
    expect((await nav(e).attachments()).files).toEqual([])
    await nav(e).addAttachment('a.txt', new Uint8Array([65]), {})
    expect((await e.doc.info()).attachmentCount).toBe(1)
    await e.doc.undo()
    expect((await nav(e).attachments()).files).toEqual([])
  })
})

describe('navigation: layers', () => {
  const pixel = async (e: OpenedEngine, x: number, y: number) => {
    const r = await e.ops<typeof renderOps>('render').page(0, { scale: 1 })
    const k = (y * r.width + x) * 4
    return [r.pixels![k], r.pixels![k + 1], r.pixels![k + 2]]
  }

  it('lists layers, toggles visibility (re-rendering pages) and resets', async () => {
    const e = await openFixture('navigation/layers.pdf')
    const n = nav(e)
    let layers = await n.layers()
    const byName = (name: string) => layers.find((l) => l.name === name)!
    expect(layers.map((l) => l.name).sort()).toEqual(['Draft watermark', 'Reviewer notes', 'Shapes'])
    expect(byName('Reviewer notes')).toMatchObject({ visible: false, initiallyVisible: false })
    expect(byName('Shapes').visible).toBe(true)
    // red box of the hidden layer is not drawn
    expect(await pixel(e, 400, 240)).toEqual([255, 255, 255])
    layers = await n.setLayerVisible(byName('Reviewer notes').index, true)
    expect(e.lastChanges?.all).toBe(true)
    expect(e.lastChanges?.dirty).toBe(false)
    expect(await pixel(e, 400, 240)).toEqual([255, 0, 0])
    layers = await n.setLayerVisible(byName('Shapes').index, false)
    expect(await pixel(e, 150, 240)).toEqual([255, 255, 255])
    layers = await n.resetLayers()
    expect(byName('Reviewer notes').visible).toBe(false)
    expect(byName('Shapes').visible).toBe(true)
    expect(await pixel(e, 150, 240)).toEqual([0, 0, 255])
    await expect(n.setLayerVisible(9, true)).rejects.toThrow(/no longer exists/)
  })

  it('returns no layers for documents without optional content', async () => {
    const e = await openFixture('text.pdf')
    expect(await nav(e).layers()).toEqual([])
  })
})

describe('navigation: document properties', () => {
  it('reads custom keys, tagging and the default initial view', async () => {
    const e = await openFixture('text.pdf')
    const p = await nav(e).properties()
    expect(p.tagged).toBe(false)
    expect(p.custom).toEqual([])
    expect(p.trapped).toBe('False')
    expect(p.initialView).toEqual({
      navigationTab: 'page',
      pageLayout: 'default',
      magnification: 'default',
      openToPage: 0,
      displayDocTitle: false,
      openActionIsScript: false
    })
  })

  it('reads an initial view from the catalog', async () => {
    const e = await openFixture('navigation/initial-view.pdf')
    const p = await nav(e).properties()
    expect(p.initialView).toMatchObject({
      navigationTab: 'bookmarks',
      pageLayout: 'two-up-continuous',
      magnification: 1.5,
      openToPage: 2
    })
  })

  it('applies metadata, initial view and custom keys in one undoable step', async () => {
    const e = await openFixture('text.pdf')
    const n = nav(e)
    await n.setProperties({
      metadata: { author: 'Jane Smith', keywords: 'alpha, beta' },
      initialView: { navigationTab: 'thumbnails', pageLayout: 'two-up-cover', magnification: 'fit-width', openToPage: 3, displayDocTitle: true },
      custom: [
        { key: 'Department', value: 'Finance' },
        { key: 'Title', value: 'ignored' }
      ]
    })
    expect(e.lastChanges?.journal.undoLabel).toBe('Change Document Properties')
    expect(e.lastChanges?.document).toBe(true)
    let info = await e.doc.info()
    expect(info.metadata.author).toBe('Jane Smith')
    expect(info.metadata.keywords).toBe('alpha, beta')
    expect(info.metadata.title).toBe('Fixture Text Document')
    let p = await n.properties()
    expect(p.initialView).toMatchObject({
      navigationTab: 'thumbnails',
      pageLayout: 'two-up-cover',
      magnification: 'fit-width',
      openToPage: 3,
      displayDocTitle: true
    })
    expect(p.custom).toEqual([{ key: 'Department', value: 'Finance' }])
    const again = await roundTrip(e)
    expect((await nav(again).properties()).initialView.openToPage).toBe(3)
    expect((await nav(again).properties()).custom).toEqual([{ key: 'Department', value: 'Finance' }])
    // a later edit only changes what it names
    await n.setProperties({ initialView: { magnification: 2 } })
    p = await n.properties()
    expect(p.initialView).toMatchObject({ magnification: 2, openToPage: 3 })
    await n.setProperties({ initialView: { magnification: 'default', openToPage: 0, navigationTab: 'page', pageLayout: 'default', displayDocTitle: false }, custom: [] })
    p = await n.properties()
    expect(p.initialView).toMatchObject({ navigationTab: 'page', pageLayout: 'default', magnification: 'default', openToPage: 0 })
    expect(p.custom).toEqual([])
    expect(e.session.pdf.getTrailer().get('Root').get('OpenAction').isNull()).toBe(true)
    await e.doc.undo()
    await e.doc.undo()
    await e.doc.undo()
    info = await e.doc.info()
    expect(info.metadata.author).toBe('Fartcrobat Tests')
    p = await n.properties()
    expect(p.custom).toEqual([])
    expect(p.initialView.navigationTab).toBe('page')
    expect(e.lastChanges?.dirty).toBe(false)
  })

  it('rejects invalid custom property names', async () => {
    const e = await openFixture('text.pdf')
    await expect(nav(e).setProperties({ custom: [{ key: 'has space', value: 'x' }] })).rejects.toThrow(/not a valid property name/)
  })

  it('creates the information dictionary for custom keys when missing', async () => {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    await doc.createBlank({ pages: 2 })
    const n = engine.ops<typeof navigationOps>('navigation')
    expect((await n.properties()).hasInfo).toBe(false)
    await n.setProperties({ custom: [{ key: 'Client', value: 'ACME' }] })
    expect((await n.properties()).custom).toEqual([{ key: 'Client', value: 'ACME' }])
    await doc.undo()
    expect((await n.properties()).custom).toEqual([])
  })

  it('lists fonts with type, encoding, embedding and the pages that use them', async () => {
    const e = await openFixture('navigation/fonts.pdf')
    const fonts = await nav(e).fonts(0, 2)
    const by = (name: string) => fonts.find((f) => f.name === name)!
    expect(by('DejaVuSans')).toMatchObject({ type: 'TrueType', embedded: true, subset: true })
    expect(by('Helvetica')).toMatchObject({ type: 'Type 1', embedded: false, subset: false, encoding: 'Ansi' })
    expect(by('Times-Roman').embedded).toBe(false)
    expect(by('Courier').pages).toEqual([0, 1])
    // chunked scanning returns the per-page usage of each chunk
    const second = await nav(e).fonts(1, 2)
    expect(second.every((f) => f.pages.join() === '1')).toBe(true)
  })
})
