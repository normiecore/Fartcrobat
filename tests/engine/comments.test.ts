import { describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import type annotOps from '@engine/ops/annots'
import type textOps from '@engine/ops/text'
import type commentOps from '@features/comments/engine'
import type { AnnotInfo } from '@engine/ops/annots'
import type { Quad } from '@shared/geometry'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import {
  buildDefaultAppearance,
  buildThreads,
  flagsToNames,
  namesToFlags,
  parseDefaultAppearance,
  textUnderQuads,
  typeLabel
} from '@features/comments/shared'
import { buildXfdf, parseXfdf, type XmlNode } from '@features/comments/xfdf'
import { fixture, openFixture, type OpenedEngine } from './helpers'

function ops(e: OpenedEngine) {
  return {
    annots: e.ops<typeof annotOps>('annots'),
    comments: e.ops<typeof commentOps>('comments'),
    text: e.ops<typeof textOps>('text')
  }
}

async function quadsFor(e: OpenedEngine, page: number, needle: string): Promise<Quad[]> {
  const t = await ops(e).text.page(page)
  const i = t.text.indexOf(needle)
  expect(i).toBeGreaterThanOrEqual(0)
  const q = t.quads
  const a = i * 8
  const b = (i + needle.length - 1) * 8
  return [[q[a], q[a + 1], q[b + 2], q[b + 3], q[a + 4], q[a + 5], q[b + 6], q[b + 7]]]
}

/** A document with one of each common comment type. */
async function populate(e: OpenedEngine) {
  const { annots } = ops(e)
  await annots.setAuthor('Alice')
  const square = await annots.create(0, {
    type: 'Square',
    rect: [100, 100, 200, 150],
    color: '#ff0000',
    interiorColor: '#00ff00',
    borderWidth: 3,
    opacity: 0.8,
    contents: 'Fix this box',
    subject: 'Rectangle'
  })
  const note = await annots.create(0, { type: 'Text', rect: [300, 80, 320, 100], contents: 'Is this right?', color: '#ffeb3b', icon: 'Comment' })
  const reply = await annots.reply(note.id, 'Yes, it is.', 'Bob')
  await annots.setState(note.id, 'Accepted', 'Bob')
  const hl = await annots.create(1, { type: 'Highlight', quads: await quadsFor(e, 1, 'quick brown fox'), color: '#ffeb3b', contents: 'Nice' })
  const ink = await annots.create(0, { type: 'Ink', ink: [[[50, 300], [80, 330], [120, 310]]], color: '#0000ff', borderWidth: 2 })
  const line = await annots.create(0, { type: 'Line', line: [[60, 400], [200, 450]], color: '#000000', lineEndings: { start: 'None', end: 'ClosedArrow' } })
  const ft = await annots.create(0, {
    type: 'FreeText',
    rect: [300, 500, 500, 540],
    contents: 'Typed note\nsecond line',
    fontSize: 14,
    textColor: '#0000ff',
    extra: { kind: 'test' }
  })
  const poly = await annots.create(2, { type: 'Polygon', vertices: [[100, 100], [200, 120], [150, 200]], color: '#ff00ff', cloudy: true })
  const stamp = await annots.create(0, { type: 'Stamp', rect: [350, 600, 450, 650], stampImage: fixture('scan.png') })
  return { square, note, reply, hl, ink, line, ft, poly, stamp }
}

async function freshEngine(name = 'text.pdf'): Promise<OpenedEngine> {
  return openFixture(name)
}

describe('comments engine', () => {
  it('brings comments to the front and sends them to the back (undoable)', async () => {
    const e = await openFixture('text.pdf')
    const { annots, comments } = ops(e)
    const a = await annots.create(0, { type: 'Square', rect: [10, 10, 50, 50] })
    const b = await annots.create(0, { type: 'Circle', rect: [20, 20, 60, 60] })
    const c = await annots.create(0, { type: 'Text', rect: [30, 30, 50, 50] })
    const order = async () => (await annots.list(0)).map((x) => x.id)
    expect(await order()).toEqual([a.id, b.id, c.id])
    await comments.arrange([a.id], 'front', 0)
    expect(e.lastChanges?.journal.undoLabel).toBe('Bring to Front')
    expect(e.lastChanges?.pages).toContain(0)
    expect(await order()).toEqual([b.id, c.id, a.id])
    await comments.arrange([c.id], 'back')
    expect(await order()).toEqual([c.id, b.id, a.id])
    await e.doc.undo()
    expect(await order()).toEqual([b.id, c.id, a.id])
    await e.doc.undo()
    expect(await order()).toEqual([a.id, b.id, c.id])
    // links on the page are kept
    const t = await e.ops<typeof import('@engine/ops/nav').default>('nav').links(0)
    expect(t.length).toBeGreaterThan(0)
  })

  it('deletes all comments in one undoable step', async () => {
    const e = await openFixture('text.pdf')
    const { annots, comments } = ops(e)
    await populate(e)
    expect(await comments.count()).toBeGreaterThan(8)
    const removed = await comments.deleteAll()
    expect(removed).toBeGreaterThan(8)
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete All Comments')
    expect(e.lastChanges?.dirty).toBe(true)
    expect((await annots.listAll()).length).toBe(0)
    await expect(comments.deleteAll()).rejects.toThrow(/no comments/i)
    await e.doc.undo()
    expect((await annots.listAll()).length).toBe(removed)
  })

  it('exports comments as user-space records', async () => {
    const e = await openFixture('text.pdf')
    const made = await populate(e)
    const recs = await ops(e).comments.exportRecords()
    const sq = recs.find((r) => r.type === 'Square')!
    // page space [100,100,200,150] on a 792pt-high page -> PDF user space (y up)
    expect(sq.rect[0]).toBeCloseTo(100, 0)
    expect(sq.rect[1]).toBeCloseTo(792 - 150, 0)
    expect(sq.rect[3]).toBeCloseTo(792 - 100, 0)
    expect(sq.color).toBe('#ff0000')
    expect(sq.interiorColor).toBe('#00ff00')
    expect(sq.borderWidth).toBe(3)
    expect(sq.author).toBe('Alice')
    expect(sq.contents).toBe('Fix this box')
    const note = recs.find((r) => r.type === 'Text' && r.contents === 'Is this right?')!
    const reply = recs.find((r) => r.contents === 'Yes, it is.')!
    expect(reply.inReplyTo).toBe(note.name)
    expect(reply.author).toBe('Bob')
    const state = recs.find((r) => r.state === 'Accepted')!
    expect(state.stateModel).toBe('Review')
    expect(state.inReplyTo).toBe(note.name)
    const hl = recs.find((r) => r.type === 'Highlight')!
    expect(hl.page).toBe(1)
    expect(hl.quads?.[0].length).toBe(8)
    const ink = recs.find((r) => r.type === 'Ink')!
    expect(ink.ink?.[0][0][0]).toBeCloseTo(50, 0)
    expect(ink.ink?.[0][0][1]).toBeCloseTo(792 - 300, 0)
    const line = recs.find((r) => r.type === 'Line')!
    expect(line.lineEndings?.end).toBe('ClosedArrow')
    const ft = recs.find((r) => r.type === 'FreeText')!
    expect(ft.defaultAppearance).toMatch(/14 Tf/)
    expect(ft.extra?.kind).toBe('test')
    expect(recs.find((r) => r.type === 'Polygon')!.cloudy).toBe(true)
    const stamp = recs.find((r) => r.type === 'Stamp')!
    expect(stamp.imagePng && stamp.imagePng.length).toBeGreaterThan(100)
    expect(made.square.id).toBeGreaterThan(0)
  })

  it('round-trips comments through XFDF into another document, skipping duplicates', async () => {
    const src = await openFixture('text.pdf')
    await populate(src)
    const recs = await ops(src).comments.exportRecords()
    const xml = buildXfdf(recs, 'text.pdf')
    expect(xml).toContain('<xfdf xmlns="http://ns.adobe.com/xfdf/"')
    expect(xml).toContain('<square ')
    expect(xml).toContain('<highlight ')
    expect(xml).toContain('<inklist><gesture>')
    expect(xml).toContain('<imagedata>data:image/png;base64,')
    const dom = new DOMParser().parseFromString(xml, 'application/xml')
    const parsed = parseXfdf(dom.documentElement as unknown as XmlNode)
    expect(parsed.length).toBe(recs.length)

    const dst = await freshEngine()
    const { comments, annots } = ops(dst)
    const res = await comments.importRecords(parsed)
    expect(res.imported).toBe(recs.length)
    expect(dst.lastChanges?.journal.undoLabel).toBe('Import Comments')
    const all = await annots.listAll()
    const orig = await ops(src).annots.listAll()
    expect(all.length).toBe(orig.length)
    const byType = (list: AnnotInfo[], t: string) => list.filter((a) => a.type === t)
    for (const t of ['Square', 'Text', 'Highlight', 'Ink', 'Line', 'FreeText', 'Polygon', 'Stamp']) {
      expect(byType(all, t).length, t).toBe(byType(orig, t).length)
    }
    const sq = byType(all, 'Square')[0]
    expect(sq.rect[0]).toBeCloseTo(100, 0)
    expect(sq.rect[1]).toBeCloseTo(100, 0)
    expect(sq.color).toBe('#ff0000')
    expect(sq.interiorColor).toBe('#00ff00')
    expect(sq.opacity).toBeCloseTo(0.8, 2)
    const ft = byType(all, 'FreeText')[0]
    expect(ft.contents).toBe('Typed note\nsecond line')
    expect(ft.fontSize).toBe(14)
    expect(ft.textColor).toBe('#0000ff')
    expect(ft.extra.kind).toBe('test')
    const threads = buildThreads(all)
    const noteThread = threads.find((t) => t.root.type === 'Text')!
    expect(noteThread.replies.map((r) => r.contents)).toEqual(['Yes, it is.'])
    expect(noteThread.replies[0].hidden).toBe(true)
    expect(noteThread.status).toBe('Accepted')
    expect(byType(all, 'Line')[0].lineEndings?.end).toBe('ClosedArrow')
    expect(byType(all, 'Polygon')[0].cloudy).toBe(true)
    // importing the same file again does not duplicate
    const again = await comments.importRecords(parsed)
    expect(again.imported).toBe(0)
    expect(again.duplicates).toBe(recs.length)
    expect((await annots.listAll()).length).toBe(orig.length)
    // and the import is one undo step
    await dst.doc.undo()
    await dst.doc.undo()
    expect((await annots.listAll()).length).toBe(0)
  })

  it('reads XFDF written by other apps (Acrobat style attributes)', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
<annots>
<text color="#FFFF00" creationdate="D:20240102030405Z" flags="print,nozoom,norotate" date="D:20240102030405Z" name="n-1" icon="Comment" page="0" rect="100,600,120,620" subject="Sticky Note" title="Carol"><contents>Hello&#13;world</contents><popup flags="print,nozoom,norotate" open="yes" page="0" rect="120,500,300,600"/></text>
<text page="0" rect="100,600,120,620" name="n-2" inreplyto="n-1" replyType="reply" title="Dave"><contents>Reply here</contents></text>
<square color="#0000FF" width="2" style="dash" dashes="3,3" page="1" rect="50,50,150,100" name="n-3" title="Carol"/>
<polygon page="0" rect="0,0,100,100" name="n-4" color="#FF0000" style="cloudy" intensity="1"><vertices>10,10;90,10;50,90</vertices></polygon>
<freetext page="0" rect="200,200,400,240" name="n-5" justification="centered"><contents-richtext><body><p>Rich only</p></body></contents-richtext><defaultstyle>font: Helvetica 16pt; color: #FF0000</defaultstyle></freetext>
<widget page="0" rect="0,0,1,1"/>
</annots>
<f href="other.pdf"/>
</xfdf>`
    const dom = new DOMParser().parseFromString(xml, 'application/xml')
    const recs = parseXfdf(dom.documentElement as unknown as XmlNode)
    expect(recs.map((r) => r.type)).toEqual(['Text', 'Text', 'Square', 'Polygon', 'FreeText'])
    expect(recs[0].contents).toBe('Hello\nworld')
    expect(recs[0].author).toBe('Carol')
    expect(recs[0].popup?.open).toBe(true)
    expect(recs[0].created).toBe('2024-01-02T03:04:05.000Z')
    expect(recs[1].inReplyTo).toBe('n-1')
    expect(recs[2].borderStyle).toBe('Dashed')
    expect(recs[3].cloudy).toBe(true)
    expect(recs[3].vertices).toEqual([
      [10, 10],
      [90, 10],
      [50, 90]
    ])
    expect(recs[4].quadding).toBe(1)
    expect(recs[4].contents).toBe('Rich only')
    expect(parseDefaultAppearance(recs[4].defaultAppearance!).size).toBe(16)
    const e = await openFixture('text.pdf')
    const res = await ops(e).comments.importRecords(recs)
    expect(res.imported).toBe(5)
    const all = await ops(e).annots.listAll()
    const note = all.find((a) => a.contents === 'Hello\nworld')!
    expect(note.rect[1]).toBeCloseTo(792 - 620, 0)
    expect(all.find((a) => a.contents === 'Reply here')!.inReplyTo).toBe(note.id)
    expect(all.find((a) => a.type === 'Square')!.page).toBe(1)
    const ft = all.find((a) => a.type === 'FreeText')!
    expect(ft.fontSize).toBe(16)
    expect(ft.textColor).toBe('#ff0000')
    expect(() => parseXfdf((new DOMParser().parseFromString('<foo/>', 'application/xml')).documentElement as unknown as XmlNode)).toThrow(
      /not an XFDF/
    )
  })

  it('round-trips comments through FDF', async () => {
    const src = await openFixture('text.pdf')
    await populate(src)
    const { bytes, count } = await ops(src).comments.exportFdf('text.pdf')
    expect(count).toBe(8)
    expect(new TextDecoder().decode(bytes.slice(0, 8))).toBe('%FDF-1.2')
    const dst = await freshEngine()
    const res = await ops(dst).comments.importFdf(bytes)
    const orig = await ops(src).annots.listAll()
    expect(res.imported).toBe(orig.length)
    const all = await ops(dst).annots.listAll()
    expect(all.length).toBe(orig.length)
    const sq = all.find((a) => a.type === 'Square')!
    expect(sq.rect[0]).toBeCloseTo(100, 0)
    expect(sq.rect[1]).toBeCloseTo(100, 0)
    expect(sq.contents).toBe('Fix this box')
    const threads = buildThreads(all)
    const note = threads.find((t) => t.root.type === 'Text')!
    expect(note.replies[0].contents).toBe('Yes, it is.')
    expect(note.status).toBe('Accepted')
    const stamp = all.find((a) => a.type === 'Stamp')!
    expect(stamp.rect[2] - stamp.rect[0]).toBeCloseTo(100, 0)
    expect(all.find((a) => a.type === 'FreeText')!.extra.kind).toBe('test')
    // The imported stamp keeps its image appearance: render the page and look for ink in it.
    const img = await dst.ops<typeof import('@engine/ops/render').default>('render').image(0, { dpi: 36, format: 'png' })
    expect(img.length).toBeGreaterThan(1000)
    const again = await ops(dst).comments.importFdf(bytes)
    expect(again.imported).toBe(0)
    await dst.doc.undo()
    await dst.doc.undo()
    expect((await ops(dst).annots.listAll()).length).toBe(0)
    await expect(ops(dst).comments.importFdf(new TextEncoder().encode('not an fdf'))).rejects.toThrow()
  })

  it('summarizes comments in every layout', async () => {
    const e = await openFixture('text.pdf')
    await populate(e)
    const { comments } = ops(e)
    const read = async (bytes: Uint8Array) => {
      const engine = await createLocalEngine()
      const doc = engine.ops<typeof docOps>('doc')
      const res = await doc.open(bytes, { fileName: 'summary.pdf' })
      if (!res.ok) throw new Error('needs password')
      const text = await engine.ops<typeof textOps>('text').all()
      return { pages: res.info.pageCount, text: text.join('\n'), info: res.info }
    }
    const only = await read(await comments.summary({ layout: 'comments-only', title: 'text.pdf' }))
    expect(only.text).toContain('Summary of Comments on text.pdf')
    expect(only.text).toContain('Fix this box')
    expect(only.text).toContain('Reply from Bob')
    expect(only.text).toContain('Yes, it is.')
    expect(only.text).toContain('Status: Accepted')
    expect(only.text).toContain('quick brown fox')
    expect(only.text).toContain('Rectangle')
    expect(only.text).toContain('Page 1 of')
    expect(only.info.metadata.title).toBe('Summary of Comments on text.pdf')

    const separate = await read(await comments.summary({ layout: 'separate', title: 'text.pdf' }))
    // pages 1, 2 and 3 have comments: each page plus its comment list
    expect(separate.pages).toBe(6)
    expect(separate.text).toContain('Fix this box')

    const single = await read(await comments.summary({ layout: 'single', connectors: true, title: 'text.pdf', sort: 'author' }))
    expect(single.pages).toBe(3)
    expect(single.text).toContain('Typed note')
    expect(single.info.pages[0].width).toBeGreaterThan(612)

    const withEmpty = await read(await comments.summary({ layout: 'single', includeEmptyPages: true, title: 'x' }))
    expect(withEmpty.pages).toBe(5)

    const subset = await read(await comments.summary({ layout: 'comments-only', ids: [(await ops(e).annots.list(0))[0].id] }))
    expect(subset.text).toContain('Fix this box')
    expect(subset.text).not.toContain('Typed note')

    const fresh = await openFixture('text.pdf')
    await expect(ops(fresh).comments.summary({ layout: 'comments-only' })).rejects.toThrow(/no comments/i)
  })

  it('renders a drag preview with bounds', async () => {
    const e = await openFixture('text.pdf')
    const sq = await ops(e).annots.create(0, { type: 'Square', rect: [100, 100, 200, 150], color: '#ff0000', borderWidth: 2 })
    const p = await ops(e).comments.preview(sq.id, 2)
    // bounds include the border stroke
    expect(p.bounds[0]).toBeGreaterThan(96)
    expect(p.bounds[0]).toBeLessThanOrEqual(100)
    expect(p.width).toBeGreaterThanOrEqual(198)
    expect(p.pixels?.length).toBe(p.width * p.height * 4)
  })
})

describe('comment helpers', () => {
  it('finds the text under highlight quads', async () => {
    const e = await openFixture('text.pdf')
    const t = await ops(e).text.page(1)
    expect(textUnderQuads(t, await quadsFor(e, 1, 'quick brown fox'))).toBe('quick brown fox')
    expect(textUnderQuads(t, [])).toBe('')
  })

  it('names comment types like Acrobat', () => {
    expect(typeLabel({ type: 'Text' })).toBe('Sticky Note')
    expect(typeLabel({ type: 'Square' })).toBe('Rectangle')
    expect(typeLabel({ type: 'Line', lineEndings: { start: 'None', end: 'OpenArrow' } })).toBe('Arrow')
    expect(typeLabel({ type: 'Polygon', cloudy: true })).toBe('Cloud')
    expect(typeLabel({ type: 'FreeText', intent: 'FreeTextCallout' })).toBe('Callout')
    expect(typeLabel({ type: 'StrikeOut' })).toBe('Strikethrough')
  })

  it('converts flags and default appearances', () => {
    expect(flagsToNames(4 | 8 | 16)).toBe('print,nozoom,norotate')
    expect(namesToFlags('print, nozoom,locked')).toBe(4 | 8 | 128)
    const da = buildDefaultAppearance('Helv', 14, '#0000ff')
    expect(da).toBe('/Helv 14 Tf 0 0 1 rg')
    expect(parseDefaultAppearance(da)).toEqual({ font: 'Helv', size: 14, color: '#0000ff' })
    expect(parseDefaultAppearance('/Cour 9 Tf 0.5 g').color).toBe('#808080')
  })

  it('builds threads with the latest status and checkmark', () => {
    const base = { page: 0, rect: [0, 0, 1, 1] as [number, number, number, number], stateModel: null, state: null, author: 'A' }
    const list = [
      { ...base, id: 1, type: 'Square', inReplyTo: null, created: '2024-01-01T00:00:00Z', modified: '' },
      { ...base, id: 2, type: 'Text', inReplyTo: 1, created: '2024-01-02T00:00:00Z', modified: '' },
      { ...base, id: 3, type: 'Text', inReplyTo: 2, created: '2024-01-03T00:00:00Z', modified: '' },
      { ...base, id: 4, type: 'Text', inReplyTo: 1, state: 'Accepted', stateModel: 'Review', created: '', modified: '2024-01-04T00:00:00Z' },
      { ...base, id: 5, type: 'Text', inReplyTo: 1, state: 'Rejected', stateModel: 'Review', created: '', modified: '2024-01-05T00:00:00Z' },
      { ...base, id: 6, type: 'Text', inReplyTo: 1, state: 'Marked', stateModel: 'Marked', created: '', modified: '2024-01-05T00:00:00Z' },
      { ...base, id: 7, type: 'Caret', inReplyTo: 1, created: '', modified: '' },
      { ...base, id: 8, type: 'Text', inReplyTo: 99, state: 'Accepted', stateModel: 'Review', created: '', modified: '' }
    ]
    const threads = buildThreads(list)
    expect(threads.length).toBe(1)
    expect(threads[0].replies.map((r) => r.id)).toEqual([2, 3])
    expect(threads[0].status).toBe('Rejected')
    expect(threads[0].marked).toBe(true)
    expect(threads[0].group.map((g) => g.id)).toEqual([7])
  })
})
