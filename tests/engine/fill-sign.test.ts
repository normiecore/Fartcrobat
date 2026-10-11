import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type renderOps from '@engine/ops/render'
import type fillSignOps from '@features/fill-sign/engine'
import {
  DEFAULT_TEXT_SIZE,
  FIRST_BASELINE,
  LINE_HEIGHT,
  lineWidthFor,
  markDimensions,
  stepSize,
  type FillSignItem
} from '@features/fill-sign/shared'
import { fixture, openFixture, roundTrip, type OpenedEngine } from './helpers'

const PNG = () => fixture('fill-sign/signature.png')

function ops(e: OpenedEngine) {
  return {
    fs: e.ops<typeof fillSignOps>('fill-sign'),
    annots: e.ops<typeof annotOps>('annots'),
    render: e.ops<typeof renderOps>('render')
  }
}

/** Fraction of dark pixels inside a page-space rect of a page rendered at 2x. */
async function inkInside(e: OpenedEngine, page: number, rect: [number, number, number, number]) {
  const scale = 2
  const r = await ops(e).render.page(page, { scale, clip: [rect[0] * scale, rect[1] * scale, rect[2] * scale, rect[3] * scale] })
  const px = r.pixels!
  let dark = 0
  for (let i = 0; i < px.length; i += 4) if (px[i] < 128 && px[i + 1] < 128 && px[i + 2] < 128) dark++
  return dark / (px.length / 4)
}

const width = (r: number[]) => r[2] - r[0]
const height = (r: number[]) => r[3] - r[1]

describe('fill-sign engine', () => {
  it('adds a borderless, transparent Helvetica text item that fits its text and starts at the click point', async () => {
    const e = await openFixture('text.pdf')
    const { fs, annots } = ops(e)
    await annots.setAuthor('Jane')
    const item = await fs.addText(0, [100, 650], { text: 'Jane Doe' })
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Text')
    expect(e.lastChanges?.dirty).toBe(true)
    expect(e.lastChanges?.pages).toEqual([0])
    expect(item.kind).toBe('text')
    expect(item.text).toBe('Jane Doe')
    expect(item.size).toBe(DEFAULT_TEXT_SIZE)
    expect(item.color).toBe('#000000')
    // the click is the start of the text, vertically centred on the first line
    expect(item.rect[0]).toBeCloseTo(100, 3)
    expect(item.rect[1]).toBeCloseTo(650 - (DEFAULT_TEXT_SIZE * LINE_HEIGHT) / 2, 3)
    expect(height(item.rect)).toBeCloseTo(DEFAULT_TEXT_SIZE * LINE_HEIGHT, 3)
    // Helvetica 12pt "Jane Doe" is 51.36pt wide
    expect(width(item.rect)).toBeGreaterThan(51)
    expect(width(item.rect)).toBeLessThan(54)

    const a = await annots.get(item.id)
    expect(a.type).toBe('FreeText')
    expect(a.borderWidth).toBe(0)
    expect(a.color).toBeNull()
    expect(a.interiorColor).toBeNull()
    expect(a.fontName).toBe('Helv')
    expect(a.fontSize).toBe(12)
    expect(a.textColor).toBe('#000000')
    expect(a.extra.fartcrobat).toBe('fillsign')
    expect(a.extra.kind).toBe('text')
    expect(a.author).toBe('Jane')
    expect(a.flags & 4).toBe(4) // printable
    // it is really drawn on the page
    expect(await inkInside(e, 0, item.rect)).toBeGreaterThan(0.03)
  })

  it('edits text, refits the box, keeps the top-left corner and supports several lines', async () => {
    const e = await openFixture('text.pdf')
    const { fs } = ops(e)
    const item = await fs.addText(0, [72, 600], { text: 'A' })
    const longer = await fs.setText(item.id, 'A much longer line of text')
    expect(e.lastChanges?.journal.undoLabel).toBe('Edit Text')
    expect(longer.rect[0]).toBeCloseTo(item.rect[0], 3)
    expect(longer.rect[1]).toBeCloseTo(item.rect[1], 3)
    expect(width(longer.rect)).toBeGreaterThan(width(item.rect) * 5)
    const two = await fs.setText(item.id, 'First line\r\nSecond line is longer')
    expect(two.text).toBe('First line\nSecond line is longer')
    expect(height(two.rect)).toBeCloseTo(2 * DEFAULT_TEXT_SIZE * LINE_HEIGHT, 3)
    // undo goes back step by step
    await e.doc.undo()
    expect((await fs.get(item.id)).text).toBe('A much longer line of text')
  })

  it('measures any script with MuPDF fallback fonts and never wraps', async () => {
    const e = await openFixture('text.pdf')
    const { fs } = ops(e)
    const item = await fs.addText(0, [50, 300], { text: 'José Ñandú — Привет 日本語', size: 14 })
    expect(height(item.rect)).toBeCloseTo(14 * LINE_HEIGHT, 3)
    expect(width(item.rect)).toBeGreaterThan(120)
    expect(await inkInside(e, 0, item.rect)).toBeGreaterThan(0.02)
  })

  it('changes text size and colour, and resizing text scales its font', async () => {
    const e = await openFixture('text.pdf')
    const { fs, annots } = ops(e)
    const item = await fs.addText(0, [72, 500], { text: 'Size me' })
    const bigger = await fs.setSize(item.id, stepSize(item.size, 1), 'text')
    expect(e.lastChanges?.journal.undoLabel).toBe('Change Text Size')
    expect(bigger.size).toBe(13)
    expect(bigger.rect[0]).toBeCloseTo(item.rect[0], 3)
    expect(bigger.rect[1]).toBeCloseTo(item.rect[1], 3)
    expect(width(bigger.rect)).toBeGreaterThan(width(item.rect))
    const red = await fs.setColor(item.id, '#c4161c')
    expect(red.color).toBe('#c4161c')
    expect((await annots.get(item.id)).textColor).toBe('#c4161c')
    const r = red.rect
    const doubled = await fs.resize(item.id, [r[0] + 10, r[1] + 10, r[0] + 10 + width(r) * 2, r[1] + 10 + height(r) * 2], 'text')
    expect(e.lastChanges?.journal.undoLabel).toBe('Resize Text')
    expect(doubled.size).toBeCloseTo(26, 1)
    expect(doubled.rect[0]).toBeCloseTo(r[0] + 10, 3)
    expect(doubled.color).toBe('#c4161c')
  })

  it('adds every mark at the click point, sized from the text size', async () => {
    const e = await openFixture('text.pdf')
    const { fs, annots } = ops(e)
    const expectType = { check: 'Ink', cross: 'Ink', line: 'Ink', box: 'Ink', dot: 'Circle' } as const
    const labels = { check: 'Add Check Mark', cross: 'Add Cross Mark', line: 'Add Line', box: 'Add Rounded Box', dot: 'Add Dot' }
    for (const kind of ['check', 'cross', 'dot', 'line', 'box'] as const) {
      const m = await fs.addMark(0, [300, 400], kind, { size: 20, color: '#1a3e9a' })
      expect(e.lastChanges?.journal.undoLabel).toBe(labels[kind])
      const [w, h] = markDimensions(kind, 20)
      expect(m.kind).toBe(kind)
      expect(m.size).toBeCloseTo(20, 1)
      expect(m.color).toBe('#1a3e9a')
      expect(width(m.rect)).toBeCloseTo(w, 1)
      expect(height(m.rect)).toBeCloseTo(h, 1)
      expect((m.rect[0] + m.rect[2]) / 2).toBeCloseTo(300, 1)
      expect((m.rect[1] + m.rect[3]) / 2).toBeCloseTo(400, 1)
      const a = await annots.get(m.id)
      expect(a.type).toBe(expectType[kind])
      expect(a.extra).toMatchObject({ fartcrobat: 'fillsign', kind })
      if (kind !== 'dot') expect(a.borderWidth).toBeCloseTo(lineWidthFor(20), 2)
      else expect(a.interiorColor).toBe('#1a3e9a')
      await fs.remove([m.id], kind)
    }
    // marks near the edge stay on the page
    const edge = await fs.addMark(0, [1, 1], 'box', { size: 12 })
    expect(edge.rect[0]).toBeGreaterThan(-0.01)
    expect(edge.rect[1]).toBeGreaterThan(-0.01)
  })

  it('moves, resizes and rescales marks crisply', async () => {
    const e = await openFixture('text.pdf')
    const { fs } = ops(e)
    const check = await fs.addMark(0, [200, 200], 'check', { size: 12 })
    const moved = await fs.move(check.id, 30, -20, 'check')
    expect(e.lastChanges?.journal.undoLabel).toBe('Move Check Mark')
    expect(moved.rect[0]).toBeCloseTo(check.rect[0] + 30, 2)
    expect(moved.rect[1]).toBeCloseTo(check.rect[1] - 20, 2)
    expect(moved.size).toBeCloseTo(12, 1)

    const r = moved.rect
    const big = await fs.resize(check.id, [r[0], r[1], r[0] + width(r) * 3, r[1] + height(r) * 3], 'check')
    expect(big.size).toBeCloseTo(36, 0)
    expect(width(big.rect)).toBeCloseTo(width(r) * 3, 1)
    expect(big.rect[0]).toBeCloseTo(r[0], 2)

    const smaller = await fs.setSize(check.id, 18, 'check')
    expect(smaller.size).toBeCloseTo(18, 1)
    const c0 = [(big.rect[0] + big.rect[2]) / 2, (big.rect[1] + big.rect[3]) / 2]
    const c1 = [(smaller.rect[0] + smaller.rect[2]) / 2, (smaller.rect[1] + smaller.rect[3]) / 2]
    expect(c1[0]).toBeCloseTo(c0[0], 1)
    expect(c1[1]).toBeCloseTo(c0[1], 1)

    // a line only gets longer when resized; its thickness stays
    const line = await fs.addMark(0, [300, 300], 'line', { size: 12 })
    const longer = await fs.resize(line.id, [line.rect[0], line.rect[1], line.rect[2] + 50, line.rect[3] + 40], 'line')
    expect(width(longer.rect)).toBeCloseTo(width(line.rect) + 50, 1)
    expect(height(longer.rect)).toBeCloseTo(height(line.rect), 2)
  })

  it('converts between text and marks in one undoable step', async () => {
    const e = await openFixture('text.pdf')
    const { fs, annots } = ops(e)
    const t = await fs.addText(0, [100, 100], { text: 'X marks', size: 14 })
    const before = (await annots.list(0)).length
    const check = await fs.convert(t.id, 'check')
    expect(e.lastChanges?.journal.undoLabel).toBe('Change to Check Mark')
    expect(check.kind).toBe('check')
    expect(check.size).toBeCloseTo(14, 1)
    expect((await annots.list(0)).length).toBe(before)
    const dot = await fs.convert(check.id, 'dot')
    expect(dot.kind).toBe('dot')
    const text = await fs.convert(dot.id, 'text', { text: 'Back to text' })
    expect(text.kind).toBe('text')
    expect(text.text).toBe('Back to text')
    await e.doc.undo()
    const items = await fs.list(0)
    expect(items.map((i) => i.kind)).toEqual(['dot'])
  })

  it('places signatures and initials as image stamps with the natural aspect ratio', async () => {
    const e = await openFixture('text.pdf')
    const { fs, annots } = ops(e)
    const rect: [number, number, number, number] = [100, 600, 100 + 36 * (420 / 120), 636]
    const sig = await fs.addSignature(0, rect, PNG(), 'signature')
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Signature')
    expect(sig.kind).toBe('signature')
    expect(sig.rect.map((v) => Math.round(v * 100) / 100)).toEqual(rect.map((v) => Math.round(v * 100) / 100))
    expect(sig.size).toBeCloseTo(36, 3)
    const a = await annots.get(sig.id)
    expect(a.type).toBe('Stamp')
    expect(a.extra).toMatchObject({ fartcrobat: 'fillsign', kind: 'signature' })
    expect(await inkInside(e, 0, sig.rect)).toBeGreaterThan(0.03)
    // transparent background: the corner of the stamp shows the white page
    expect(await inkInside(e, 0, [rect[0], rect[1], rect[0] + 4, rect[1] + 4])).toBe(0)

    const ini = await fs.addSignature(0, [300, 600, 340, 630], PNG(), 'initials')
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Initials')
    expect(ini.kind).toBe('initials')
    const bigger = await fs.setSize(ini.id, 60, 'initials')
    expect(height(bigger.rect)).toBeCloseTo(60, 1)
    expect(width(bigger.rect) / height(bigger.rect)).toBeCloseTo(40 / 30, 2)

    await expect(fs.addSignature(0, rect, new Uint8Array([1, 2, 3]), 'signature')).rejects.toThrow(/could not be read/)
    await expect(fs.convert(sig.id, 'check')).rejects.toThrow(/cannot be changed/)
  })

  it('renders transparent previews of items for dragging', async () => {
    const e = await openFixture('text.pdf')
    const { fs } = ops(e)
    const sig = await fs.addSignature(0, [100, 600, 226, 636], PNG(), 'signature')
    const check = await fs.addMark(0, [300, 300], 'check', { size: 24 })
    for (const item of [sig, check]) {
      const r = await fs.preview(item.id, 2)
      const b = item.bounds
      expect(r.width).toBeGreaterThanOrEqual(Math.floor((b[2] - b[0]) * 2))
      expect(r.width).toBeLessThanOrEqual(Math.ceil((b[2] - b[0]) * 2) + 2)
      const px = r.pixels!
      let clear = 0
      let solid = 0
      for (let i = 3; i < px.length; i += 4) {
        if (px[i] === 0) clear++
        else if (px[i] > 200) solid++
      }
      expect(clear / (px.length / 4)).toBeGreaterThan(0.3)
      expect(solid).toBeGreaterThan(20)
    }
  })

  it('lists only Fill & Sign items, deletes with undo, and refuses locked items', async () => {
    const e = await openFixture('text.pdf')
    const { fs, annots } = ops(e)
    await annots.create(0, { type: 'Square', rect: [10, 10, 50, 50], color: '#ff0000' })
    await annots.create(0, { type: 'FreeText', rect: [10, 60, 150, 80], contents: 'A comment' })
    const t = await fs.addText(0, [100, 100], { text: 'mine' })
    const m = await fs.addMark(0, [200, 200], 'cross')
    const list = await fs.list(0)
    expect(list.map((i) => i.kind)).toEqual(['text', 'cross'])
    expect((await fs.listAll()).length).toBe(2)
    await expect(fs.get((await annots.list(0))[0].id)).rejects.toThrow(/not added with Fill & Sign/)

    await fs.remove([t.id], 'text')
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete Text')
    expect((await fs.list(0)).map((i) => i.kind)).toEqual(['cross'])
    await e.doc.undo()
    expect((await fs.list(0)).map((i) => i.kind).sort()).toEqual(['cross', 'text'])

    await annots.update(m.id, { locked: true })
    const locked = await fs.get(m.id)
    expect(locked.locked).toBe(true)
    await expect(fs.move(m.id, 5, 5, 'cross')).rejects.toThrow(/locked/)
  })

  it('keeps marks recognisable when another tool moves or scales them', async () => {
    const e = await openFixture('text.pdf')
    const { fs, annots } = ops(e)
    const box = await fs.addMark(0, [300, 300], 'box', { size: 12 })
    await annots.move([box.id], 10, 10)
    const moved = await fs.get(box.id)
    expect(moved.rect[0]).toBeCloseTo(box.rect[0] + 10, 1)
    expect(moved.size).toBeCloseTo(12, 1)
    const b = (await annots.get(box.id)).rect
    await annots.transform([{ id: box.id, rect: [b[0], b[1], b[0] + width(b) * 2, b[1] + height(b) * 2] }])
    const scaled = await fs.get(box.id)
    expect(scaled.size).toBeGreaterThan(20)
  })

  it('survives a save and reopen', async () => {
    const e = await openFixture('text.pdf')
    const { fs } = ops(e)
    await fs.addText(1, [72, 100], { text: 'Jane Doe', size: 16, color: '#1a3e9a' })
    await fs.addText(1, [72, 140], { kind: 'date', text: '10/11/2026' })
    await fs.addMark(1, [300, 300], 'check', { size: 12 })
    await fs.addSignature(1, [100, 400, 226, 436], PNG(), 'signature')
    const again = await roundTrip(e)
    const items = await again.ops<typeof fillSignOps>('fill-sign').list(1)
    expect(items.map((i: FillSignItem) => i.kind)).toEqual(['text', 'date', 'check', 'signature'])
    expect(items[0]).toMatchObject({ text: 'Jane Doe', size: 16, color: '#1a3e9a' })
    expect(items[1].text).toBe('10/11/2026')
    expect(items[2].size).toBeCloseTo(12, 1)
    expect(await inkInside(again, 1, items[3].rect)).toBeGreaterThan(0.03)
    // the text of a reopened item can still be edited and refitted
    const edited = await again.ops<typeof fillSignOps>('fill-sign').setText(items[0].id, 'Jane Q. Doe')
    expect(width(edited.rect)).toBeGreaterThan(width(items[0].rect))
  })

  it('lays the first baseline out where the inline editor expects it', async () => {
    const e = await openFixture('text.pdf')
    const { fs } = ops(e)
    const item = await fs.addText(0, [100, 700], { text: 'Hxg', size: 40, topLeft: true })
    expect(item.rect[1]).toBeCloseTo(700, 3)
    // glyph tops of "H" sit about cap-height above the baseline at 0.8 x size below the top
    const scale = 2
    const r = await ops(e).render.page(0, { scale, clip: [item.rect[0] * scale, item.rect[1] * scale, item.rect[2] * scale, item.rect[3] * scale] })
    const px = r.pixels!
    const w = r.width
    let lowestH = -1
    // the "H" occupies the first ~28pt; find its lowest dark row (= baseline)
    for (let y = 0; y < r.height; y++) {
      for (let x = 0; x < Math.min(w, 20 * scale); x++) {
        const i = (y * w + x) * 4
        if (px[i] < 100) lowestH = y
      }
    }
    // the row just below the lowest dark pixel row is the baseline
    expect((lowestH + 1) / scale).toBeCloseTo(40 * FIRST_BASELINE, 0)
  })
})
