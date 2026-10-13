import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type renderOps from '@engine/ops/render'
import type textOps from '@engine/ops/text'
import type markupOps from '@features/markup-tools/engine'
import type { Point, Quad } from '@shared/geometry'
import { openFixture, roundTrip } from './helpers'

async function setup(name = 'text.pdf') {
  const e = await openFixture(name)
  const annots = e.ops<typeof annotOps>('annots')
  await annots.setAuthor('Tester')
  return { e, annots, markup: e.ops<typeof markupOps>('markup-tools') }
}

function rangeQuad(t: { quads: Float32Array }, start: number, end: number): Quad {
  const q = t.quads
  const f = start * 8
  const l = (end - 1) * 8
  return [q[f], q[f + 1], q[l + 2], q[l + 3], q[f + 4], q[f + 5], q[l + 6], q[l + 7]]
}

describe('markup-tools engine', () => {
  it('creates several annotations as one undo step with a plain-language label', async () => {
    const { e, annots, markup } = await setup()
    const text = e.ops<typeof textOps>('text')
    const t0 = await text.page(0)
    const t1 = await text.page(1)
    const i0 = t0.text.indexOf('quick brown fox')
    const i1 = t1.text.indexOf('quick brown fox')
    const created = await markup.create(
      [
        { page: 0, spec: { type: 'Highlight', quads: [rangeQuad(t0, i0, i0 + 15)], color: '#ffeb3b', opacity: 1 } },
        { page: 1, spec: { type: 'Highlight', quads: [rangeQuad(t1, i1, i1 + 15)], color: '#ffeb3b', opacity: 1 } }
      ],
      'Add Highlight'
    )
    expect(created).toHaveLength(2)
    expect(created[0].author).toBe('Tester')
    expect(created[0].type).toBe('Highlight')
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Highlight')
    expect(e.lastChanges?.pages).toEqual([0, 1])
    expect(e.lastChanges?.dirty).toBe(true)
    await e.doc.undo()
    expect(await annots.list(0)).toHaveLength(0)
    expect(await annots.list(1)).toHaveLength(0)
    await e.doc.redo()
    expect(await annots.list(0)).toHaveLength(1)
    expect(await annots.list(1)).toHaveLength(1)
  })

  it('creates every comment type the tools produce, with their style properties', async () => {
    const { e, markup } = await setup()
    const [note] = await markup.create([{ page: 0, spec: { type: 'Text', rect: [100, 100, 120, 120], color: '#ffeb3b', icon: 'Comment', contents: '' } }], 'Add Sticky Note')
    expect(note.icon).toBe('Comment')
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Sticky Note')

    const [tw] = await markup.create(
      [{ page: 0, spec: { type: 'FreeText', rect: [50, 50, 250, 70], intent: 'FreeTextTypeWriter', borderWidth: 0, color: null, fontName: 'Helv', fontSize: 14, textColor: '#0000ff', contents: 'Typed' } }],
      'Add Text Comment'
    )
    expect(tw.intent).toBe('FreeTextTypeWriter')
    expect(tw.borderWidth).toBe(0)
    expect(tw.fontSize).toBe(14)
    expect(tw.textColor).toBe('#0000ff')

    const [box] = await markup.create(
      [{ page: 0, spec: { type: 'FreeText', rect: [300, 300, 450, 350], borderWidth: 2, borderStyle: 'Dashed', dashes: [4, 4], color: '#ffffcc', fontName: 'TiRo', fontSize: 12, textColor: '#ff0000', contents: 'Box' } }],
      'Add Text Box'
    )
    expect(box.borderWidth).toBe(2)
    expect(box.color).toBe('#ffffcc')
    expect(box.fontName).toBe('TiRo')

    const [callout] = await markup.create(
      [
        {
          page: 0,
          spec: { type: 'FreeText', intent: 'FreeTextCallout', rect: [380, 50, 540, 110], calloutLine: [[310, 170], [340, 80], [380, 80]], borderWidth: 1, color: '#ffffff', fontSize: 12, textColor: '#000000', contents: '' },
          calloutStyle: 'OpenArrow'
        }
      ],
      'Add Callout'
    )
    expect(callout.intent).toBe('FreeTextCallout')
    expect(callout.calloutLine?.length).toBe(3)
    expect(callout.calloutLine?.[0][0]).toBeCloseTo(310, 0)
    // the text box rect is kept; the callout line lies outside of it
    expect(callout.rect[0]).toBeGreaterThan(370)

    const [sq] = await markup.create([{ page: 0, spec: { type: 'Square', rect: [100, 400, 200, 460], color: '#f44336', interiorColor: null, borderWidth: 2, cloudy: true, opacity: 0.8 } }], 'Add Rectangle')
    expect(sq.cloudy).toBe(true)
    expect(sq.opacity).toBeCloseTo(0.8)
    const [arrow] = await markup.create(
      [{ page: 0, spec: { type: 'Line', line: [[300, 500], [400, 550]], lineEndings: { start: 'None', end: 'OpenArrow' }, intent: 'LineArrow', color: '#f44336', borderWidth: 2 } }],
      'Add Arrow'
    )
    expect(arrow.lineEndings).toEqual({ start: 'None', end: 'OpenArrow' })
    expect(arrow.intent).toBe('LineArrow')
    const [cloud] = await markup.create(
      [{ page: 0, spec: { type: 'Polygon', vertices: [[60, 600], [200, 600], [200, 700]], intent: 'PolygonCloud', cloudy: true, color: '#f44336', borderWidth: 2 } }],
      'Add Cloud'
    )
    expect(cloud.cloudy).toBe(true)
    expect(cloud.vertices).toHaveLength(3)
    const [pl] = await markup.create(
      [{ page: 0, spec: { type: 'PolyLine', vertices: [[300, 600], [350, 650], [400, 600]], lineEndings: { start: 'Circle', end: 'ClosedArrow' }, dashes: [4, 4], borderStyle: 'Dashed', color: '#000000', borderWidth: 1 } }],
      'Add Connected Lines'
    )
    expect(pl.borderStyle).toBe('Dashed')
    const [caret] = await markup.create([{ page: 0, spec: { type: 'Caret', rect: [300, 330, 320, 344], color: '#2196f3' } }], 'Add Inserted Text')
    expect(caret.type).toBe('Caret')
    // the whole set survives a save
    const again = await roundTrip(e)
    const types = (await again.ops<typeof annotOps>('annots').list(0)).map((a) => a.type).sort()
    expect(types).toEqual(['Caret', 'FreeText', 'FreeText', 'FreeText', 'Line', 'PolyLine', 'Polygon', 'Square', 'Text'])
  })

  it('gives area highlights a crisp rectangular appearance', async () => {
    const { e, markup } = await setup('scanned.pdf')
    const render = e.ops<typeof renderOps>('render')
    const before = await render.page(0, { scale: 1 })
    const [hl] = await markup.create(
      [{ page: 0, spec: { type: 'Highlight', quads: [[60, 100, 300, 100, 60, 160, 300, 160]], color: '#ffff00', opacity: 1 }, rectAppearance: true }],
      'Add Area Highlight'
    )
    expect(hl.type).toBe('Highlight')
    expect(hl.rect[0]).toBeCloseTo(60, 0)
    expect(hl.rect[2]).toBeCloseTo(300, 0)
    const after = await render.page(0, { scale: 1 })
    const px = (r: typeof after, x: number, y: number) => {
      const k = (y * r.width + x) * 4
      return [r.pixels![k], r.pixels![k + 1], r.pixels![k + 2]]
    }
    // the corner of the area is yellow (a rounded highlight would leave it white)
    expect(px(after, 61, 101)).toEqual([255, 255, 0])
    // just outside the area nothing changed
    expect(px(after, 50, 130)).toEqual(px(before, 50, 130))
    // multiply blend: dark text stays dark under the highlight
    let dark: [number, number] | null = null
    for (let y = 105; y < 155 && !dark; y++)
      for (let x = 65; x < 295; x++)
        if (px(before, x, y)[0] < 60) {
          dark = [x, y]
          break
        }
    expect(dark).not.toBeNull()
    expect(px(after, dark![0], dark![1])[0]).toBeLessThan(90)
    const again = await roundTrip(e)
    const list = await again.ops<typeof annotOps>('annots').list(0)
    expect(list[0].type).toBe('Highlight')
    // the crisp appearance is saved with the file
    const reopened = await again.ops<typeof renderOps>('render').page(0, { scale: 1 })
    expect(px(reopened, 61, 101)).toEqual([255, 255, 0])
  })

  it('groups the strike-out and caret of Replace Text and undoes them together', async () => {
    const { e, annots, markup } = await setup()
    const t = await e.ops<typeof textOps>('text').page(0)
    const i = t.text.indexOf('lazy dog')
    const quad = rangeQuad(t, i, i + 8)
    const res = await markup.replaceText(0, { quads: [quad], caretRect: [quad[2] - 10, quad[7] - 2, quad[2] + 10, quad[7] + 12], color: '#2196f3', opacity: 1 })
    expect(e.lastChanges?.journal.undoLabel).toBe('Replace Text')
    expect(res.strikeOut.inReplyTo).toBe(res.caret.id)
    expect(res.strikeOut.extra.group).toBe(String(res.caret.id))
    expect(res.caret.extra.fartcrobat).toBe('replaceText')
    expect(await annots.rawType(res.caret.id)).toBe('Caret')
    const list = await annots.list(0)
    expect(list.map((a) => a.type).sort()).toEqual(['Caret', 'StrikeOut'])
    // deleting the caret removes the grouped strike-out too
    await annots.delete([res.caret.id])
    expect(await annots.list(0)).toHaveLength(0)
    await e.doc.undo()
    await e.doc.undo()
    expect(await annots.list(0)).toHaveLength(0)
    await e.doc.redo()
    expect(await annots.list(0)).toHaveLength(2)
    const again = await roundTrip(e)
    const so = (await again.ops<typeof annotOps>('annots').list(0)).find((a) => a.type === 'StrikeOut')!
    expect(so.inReplyTo).not.toBeNull()
  })

  it('appends strokes to a drawing and erases parts of strokes', async () => {
    const { e, annots, markup } = await setup()
    const [ink] = await markup.create([{ page: 0, spec: { type: 'Ink', ink: [[[100, 100], [300, 100]]], color: '#ff0000', borderWidth: 2 } }], 'Add Drawing')
    const appended = await markup.appendInk(0, ink.id, [[[100, 200], [300, 200]]])
    expect(appended.ink).toHaveLength(2)
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Drawing')

    const res = await markup.erase(0, [{ id: ink.id, ink: [[[100, 100], [180, 100]], [[220, 100], [300, 100]], [[100, 200], [300, 200]]] }])
    expect(res.deleted).toEqual([])
    expect(e.lastChanges?.journal.undoLabel).toBe('Erase Drawing')
    expect((await annots.get(ink.id)).ink).toHaveLength(3)

    const res2 = await markup.erase(0, [{ id: ink.id, ink: [] }])
    expect(res2.deleted).toEqual([ink.id])
    expect(await annots.list(0)).toHaveLength(0)
    await e.doc.undo()
    expect((await annots.get(ink.id)).ink).toHaveLength(3)
    await e.doc.undo()
    expect((await annots.get(ink.id)).ink).toHaveLength(2)
  })

  it('embeds a file in a file attachment comment', async () => {
    const { e, annots, markup } = await setup()
    const data = new TextEncoder().encode('quarterly numbers')
    const [att] = await markup.create(
      [
        {
          page: 0,
          spec: { type: 'FileAttachment', rect: [500, 100, 520, 120], icon: 'Paperclip', color: '#2196f3', contents: 'numbers.txt' },
          attachment: { name: 'numbers.txt', data, mime: 'text/plain' }
        }
      ],
      'Add File Attachment'
    )
    expect(att.type).toBe('FileAttachment')
    expect(att.fileName).toBe('numbers.txt')
    expect(att.icon).toBe('Paperclip')
    expect(e.lastChanges?.journal.undoLabel).toBe('Add File Attachment')
    const again = await roundTrip(e)
    const list = await again.ops<typeof annotOps>('annots').list(0)
    const file = await again.ops<typeof annotOps>('annots').attachment(list[0].id)
    expect(new TextDecoder().decode(file!.data)).toBe('quarterly numbers')
    // undo keeps working after embedding a file
    await markup.create([{ page: 0, spec: { type: 'Square', rect: [10, 10, 50, 50], color: '#000000' } }], 'Add Rectangle')
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Rectangle')
    await e.doc.undo()
    await e.doc.undo()
    expect(await annots.list(0)).toHaveLength(0)
    await expect(markup.create([{ page: 0, spec: { type: 'FileAttachment', rect: [0, 0, 20, 20], file: { name: 'x', data } } }], 'x')).rejects.toThrow(/attachment/)
  })

  it('rejects bad requests with clear errors', async () => {
    const { markup } = await setup()
    await expect(markup.create([], 'x')).rejects.toThrow(/Nothing to create/)
    await expect(markup.replaceText(0, { quads: [], caretRect: [0, 0, 1, 1], color: '#000000', opacity: 1 })).rejects.toThrow(/Select the text/)
    const [sq] = await markup.create([{ page: 0, spec: { type: 'Square', rect: [10, 10, 50, 50], color: '#000000' } }], 'Add Rectangle')
    await expect(markup.appendInk(0, sq.id, [[[0, 0] as Point, [1, 1] as Point]])).rejects.toThrow(/Not a drawing/)
  })
})
