import { describe, expect, it } from 'vitest'
import type pagesOps from '@engine/ops/pages'
import type textOps from '@engine/ops/text'
import { charIndexAt, charRect, rangeRects, searchPage, wordAt, type PageText } from '@renderer/document/textModel'
import { openFixture } from './helpers'

async function pageText(name: string, page: number, rotate = 0): Promise<PageText> {
  const e = await openFixture(name)
  if (rotate) await e.ops<typeof pagesOps>('pages').rotate([page], rotate)
  return e.ops<typeof textOps>('text').page(page)
}

const center = (r: number[]): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]

describe('text model: selection geometry', () => {
  it('limits highlight rects to the selected characters on /Rotate 90 pages', async () => {
    const t = await pageText('text.pdf', 0, 90)
    const i = t.text.indexOf('quick')
    const line = t.lines.find((l) => l.start <= i && i < l.end)!
    // the line runs vertically in page space
    expect(Math.abs(line.dir[1])).toBeGreaterThan(Math.abs(line.dir[0]))
    const first = charRect(t, i)
    const last = charRect(t, i + 4)
    const span = [Math.min(first[1], last[1]), Math.max(first[3], last[3])]
    const rects = rangeRects(t, i, i + 5)
    expect(rects).toHaveLength(1)
    const [r] = rects
    // along the line: only the word, not the whole line
    expect(r[1]).toBeCloseTo(span[0], 1)
    expect(r[3]).toBeCloseTo(span[1], 1)
    expect(r[3] - r[1]).toBeLessThan((line.bbox[3] - line.bbox[1]) / 4)
    // across the line: the full line thickness
    expect(r[0]).toBeCloseTo(Math.min(r[0], line.bbox[0]), 1)
    expect(r[2]).toBeCloseTo(Math.max(r[2], line.bbox[2]), 1)
  })

  it('keeps the full line height for horizontal lines', async () => {
    const t = await pageText('text.pdf', 0)
    const i = t.text.indexOf('quick')
    const line = t.lines.find((l) => l.start <= i && i < l.end)!
    const [r] = rangeRects(t, i, i + 5)
    expect(r[1]).toBeCloseTo(Math.min(line.bbox[1], r[1]), 3)
    expect(r[3]).toBeCloseTo(Math.max(line.bbox[3], r[3]), 3)
    expect(r[2] - r[0]).toBeLessThan((line.bbox[2] - line.bbox[0]) / 4)
  })

  it('finds the character under a point (for double/triple-click), not the caret after it', async () => {
    const t = await pageText('text.pdf', 0)
    const line = t.lines[0]
    const word = t.text.slice(line.start, line.end).split(' ')[0]
    expect(word).toBe('Chapter')
    const lastLetter = line.start + word.length - 1
    const r = charRect(t, lastLetter)
    // right half of the 'r' of "Chapter"
    const p: [number, number] = [r[0] + (r[2] - r[0]) * 0.8, (r[1] + r[3]) / 2]
    expect(charIndexAt(t, p)).toBe(lastLetter)
    const w = wordAt(t, charIndexAt(t, p))!
    expect(t.text.slice(w.start, w.end)).toBe('Chapter')
    // right half of the last character on a line selects that word, not the line break
    const lr = charRect(t, line.end - 1)
    const w2 = wordAt(t, charIndexAt(t, [lr[0] + (lr[2] - lr[0]) * 0.8, (lr[1] + lr[3]) / 2]))!
    expect(t.text.slice(w2.start, w2.end)).toBe('1')
    // right half of the last letter of a word followed by punctuation
    const g = t.text.indexOf('dog.') + 2
    const gr = charRect(t, g)
    const w3 = wordAt(t, charIndexAt(t, [gr[0] + (gr[2] - gr[0]) * 0.8, (gr[1] + gr[3]) / 2]))!
    expect(t.text.slice(w3.start, w3.end)).toBe('dog')
  })

  it('finds characters on vertical (rotated) lines', async () => {
    const t = await pageText('text.pdf', 0, 90)
    const i = t.text.indexOf('quick')
    for (let k = 0; k < 5; k++) expect(charIndexAt(t, center(charRect(t, i + k)))).toBe(i + k)
    expect(charIndexAt({ ...t, lines: [] }, [0, 0])).toBe(-1)
  })
})

describe('text model: search offsets', () => {
  const fake = (text: string): PageText => ({
    pageIndex: 0,
    text,
    quads: new Float32Array(text.length * 8),
    lines: [],
    spans: [],
    blocks: [],
    images: []
  })

  it('maps hits back correctly after characters whose lowercase form is longer', () => {
    const t = fake('İstanbul and the cat sat')
    const [h] = searchPage(t, 'cat')
    expect(t.text.slice(h.start, h.end)).toBe('cat')
    const [h2] = searchPage(t, 'İSTANBUL')
    expect(t.text.slice(h2.start, h2.end)).toBe('İstanbul')
    const [h3] = searchPage(t, 'stan')
    expect(t.text.slice(h3.start, h3.end)).toBe('stan')
  })

  it('maps hits back correctly after ligatures and astral characters', () => {
    const t = fake('ﬁne 𝐀 office the cat')
    const [h] = searchPage(t, 'cat')
    expect(t.text.slice(h.start, h.end)).toBe('cat')
    const [h2] = searchPage(t, 'fine')
    expect(t.text.slice(h2.start, h2.end)).toBe('ﬁne')
    const [h3] = searchPage(t, 'a office')
    expect(t.text.slice(h3.start, h3.end)).toBe('𝐀 office')
    const re = searchPage(t, 'c.t', { regex: true })
    expect(re.map((x) => t.text.slice(x.start, x.end))).toEqual(['cat'])
  })
})
