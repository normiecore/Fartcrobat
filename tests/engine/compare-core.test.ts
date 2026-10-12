import { describe, expect, it } from 'vitest'
import type { PageText, TextSpan } from '@engine/ops/text'
import {
  alignPages,
  compareText,
  describeChange,
  finalizeResult,
  formattingDifference,
  parsePageRange,
  visualDiff
} from '../../src/features/compare/core'
import { tokenizePage } from '../../src/features/compare/tokens'
import { DEFAULT_OPTIONS, THUMB_H, THUMB_W, type CompareOptions, type PageTokens, type Raster } from '../../src/features/compare/types'

// ---- synthetic pages ------------------------------------------------------------------------------

const CHAR_W = 6
const LINE_H = 16

/** A PageText like the engine produces: one line per string, 6pt per character, 16pt line pitch. */
function pageText(pageIndex: number, lines: string[], spans?: Omit<TextSpan, 'start' | 'end'>[][]): PageText {
  let text = ''
  const quads: number[] = []
  const tlines: PageText['lines'] = []
  const outSpans: TextSpan[] = []
  lines.forEach((line, li) => {
    const start = text.length
    const y0 = 72 + li * LINE_H
    const y1 = y0 + 12
    for (let k = 0; k < line.length; k++) {
      const x = 72 + k * CHAR_W
      quads.push(x, y0, x + CHAR_W, y0, x, y1, x + CHAR_W, y1)
    }
    text += line
    tlines.push({ start, end: text.length, bbox: [72, y0, 72 + line.length * CHAR_W, y1], wmode: 0, dir: [1, 0], block: 0 })
    // per-word span overrides for formatting tests
    const words = [...line.matchAll(/\S+/g)]
    words.forEach((m, wi) => {
      const fmt = spans?.[li]?.[wi] ?? { font: 'Helvetica', size: 12, color: 0, flags: 0 }
      outSpans.push({ start: start + m.index!, end: start + m.index! + m[0].length, ...fmt })
    })
    const endX = 72 + line.length * CHAR_W
    text += '\n'
    quads.push(endX, y0, endX, y0, endX, y1, endX, y1)
  })
  return { pageIndex, text, quads: new Float32Array(quads), lines: tlines, spans: outSpans, blocks: [], images: [] }
}

function page(pageIndex: number, lines: string[], spans?: Omit<TextSpan, 'start' | 'end'>[][]): PageTokens {
  const t = pageText(pageIndex, lines, spans)
  return {
    page: pageIndex,
    width: 612,
    height: 792,
    tokens: tokenizePage(t),
    textRects: t.lines.map((l) => l.bbox),
    imageRects: [],
    thumb: null
  }
}

const doc = (pages: string[][]) => pages.map((lines, i) => page(i, lines))

function run(oldPages: PageTokens[], newPages: PageTokens[], opts: Partial<CompareOptions> = {}) {
  const options = { ...DEFAULT_OPTIONS, mode: 'text' as const, ...opts }
  const text = compareText(oldPages, newPages, options)
  return finalizeResult(text, [], {
    options,
    oldPages: oldPages.map((p) => p.page),
    newPages: newPages.map((p) => p.page),
    elapsed: 0
  })
}

const describe_ = (r: ReturnType<typeof run>) => r.changes.map((c) => describeChange(c))

const LOREM = [
  'Each party shall keep the other party informed of any change.',
  'Notices must be given in writing and delivered by hand or post.',
  'A notice is received when it is delivered to the right address.'
]
const TERMS = ['The supplier provides the services with reasonable care.', 'Invoices are payable within thirty days of receipt.']
const APPENDIX = ['Support requests are answered within one working day.', 'Urgent requests are answered within four hours.']
const CONTACTS = ['Questions about invoices go to the accounts team in Leeds.', 'Complaints go to the customer care team.']

// ---- tokenizer ------------------------------------------------------------------------------------

describe('tokenizePage', () => {
  it('splits words, separates edge punctuation and keeps positions', () => {
    const toks = tokenizePage(pageText(0, ['Hello, “world” (again).']))
    expect(toks.map((t) => t.text)).toEqual(['Hello', ',', '“', 'world', '”', '(', 'again', ')', '.'])
    expect(toks.map((t) => t.ws)).toEqual([' ', '', ' ', '', '', ' ', '', '', ''])
    // "world" starts at character 8
    expect(toks[3].rects[0]).toEqual([72 + 8 * CHAR_W, 72, 72 + 13 * CHAR_W, 84])
  })

  it('joins words hyphenated over a line break and folds ligatures', () => {
    const toks = tokenizePage(pageText(0, ['the compar-', 'ison of ﬁles']))
    expect(toks.map((t) => t.text)).toEqual(['the', 'comparison', 'of', 'ﬁles'])
    expect(toks[1].rects).toHaveLength(2)
    expect(toks[3].norm).toBe('files')
  })

  it('keeps hyphenated names that continue with a capital letter', () => {
    const toks = tokenizePage(pageText(0, ['Jean-', 'Paul']))
    expect(toks.map((t) => t.text)).toEqual(['Jean-', 'Paul'])
  })
})

// ---- word diff ------------------------------------------------------------------------------------

describe('compareText: words', () => {
  it('reports nothing for identical documents', () => {
    const r = run(doc([LOREM, TERMS]), doc([LOREM, TERMS]))
    expect(r.changes).toEqual([])
    expect(r.rows).toEqual([
      { old: 0, new: 0, kind: 'match' },
      { old: 1, new: 1, kind: 'match' }
    ])
  })

  it('classifies replaced, deleted and inserted words with positions on both sides', () => {
    const r = run(
      [page(0, ['The quick brown fox jumps over the lazy dog.'])],
      [page(0, ['The quick red fox jumps over the dog. It barks.'])]
    )
    expect(describe_(r)).toEqual(['Replaced “brown” with “red”', 'Deleted “lazy”', 'Inserted “It barks.”'])
    const [rep, del, ins] = r.changes
    expect(rep.old!.rects[0][0]).toBe(72 + 10 * CHAR_W) // "brown" at column 10
    expect(rep.new!.rects[0][0]).toBe(72 + 10 * CHAR_W) // "red" at column 10
    // deleted words: a position marker on the new page right after "the" (columns 29-31)
    expect(del.new!.anchor).toBe(true)
    expect(del.new!.rects[0][0]).toBe(72 + 32 * CHAR_W)
    expect(del.old!.anchor).toBeUndefined()
    // inserted words: a marker on the old page after "dog."
    expect(ins.old!.anchor).toBe(true)
    expect(ins.old!.rects[0][0]).toBe(72 + 44 * CHAR_W)
    expect(r.counts).toMatchObject({ replaced: 1, deleted: 1, inserted: 1 })
  })

  it('does not keep a lone common word between larger edits', () => {
    const r = run(
      [page(0, ['Payment is due within 30 days. Late payments incur a fee of 2%. Thank you.'])],
      [page(0, ['Payment is due within 30 days of the invoice date. Thank you.'])]
    )
    expect(describe_(r)).toEqual(['Replaced “. Late payments incur a fee of 2%” with “of the invoice date”'])
  })

  it('ignores case only when asked', () => {
    const a = [page(0, ['Total revenue for the year'])]
    const b = [page(0, ['TOTAL revenue for the year'])]
    expect(describe_(run(a, b))).toEqual(['Replaced “Total” with “TOTAL”'])
    expect(run(a, b, { ignoreCase: true }).changes).toEqual([])
  })

  it('ignores spacing differences only when asked', () => {
    const a = [page(0, ['a data base  of records'])]
    const b = [page(0, ['a database of records'])]
    expect(run(a, b).changes).toEqual([])
    const strict = run(a, b, { ignoreWhitespace: false })
    expect(strict.changes.map((c) => [c.type, c.detail, c.oldText, c.newText])).toEqual([
      ['formatting', 'Spacing changed', 'data base of', 'database of']
    ])
  })

  it('treats text that flows onto the next page as unchanged', () => {
    const words = 'one two three four five six seven eight nine ten'
    const r = run(doc([[words], ['eleven twelve thirteen']]), doc([['one two three four five six seven eight'], ['nine ten eleven twelve thirteen']]))
    expect(r.changes).toEqual([])
  })

  it('reports formatting changes: font, size and colour', () => {
    const plain = { font: 'Helvetica', size: 12, color: 0, flags: 0 }
    const bold = { font: 'Helvetica-Bold', size: 12, color: 0, flags: 1 }
    const big = { font: 'Helvetica', size: 14, color: 0xd7373f, flags: 0 }
    const a = [page(0, ['The total fee is due'])]
    const b = [page(0, ['The total fee is due'], [[plain, bold, bold, plain, big]])]
    const r = run(a, b)
    expect(r.changes.map((c) => [describeChange(c), c.detail])).toEqual([
      ['Formatting changed in “total fee”', 'Font Helvetica → Helvetica-Bold'],
      ['Formatting changed in “due”', 'Size 12 → 14 pt; colour #000000 → #D7373F']
    ])
    expect(run(a, b, { formatting: false }).changes).toEqual([])
  })

  it('describes formatting differences in plain language', () => {
    const t = { text: 'x', norm: 'x', rects: [], line: 0, ws: ' ', font: 'Times-Roman', size: 10, color: 0, flags: 0 }
    expect(formattingDifference(t, { ...t, flags: 2 })).toBe('Font Times-Roman → Times-Roman Italic')
    expect(formattingDifference(t, { ...t, color: 0x101010 })).toBeNull()
  })

  it('falls back to a page-by-page comparison when the documents are too different', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 16807) % 2147483647)
    const randomPage = (i: number) => page(i, Array.from({ length: 20 }, () => Array.from({ length: 12 }, () => `w${rnd() % 100000}`).join(' ')))
    const a = [0, 1, 2, 3].map(randomPage)
    const b = [0, 1, 2, 3].map(randomPage)
    const text = compareText(a, b, { ...DEFAULT_OPTIONS, mode: 'text' }, undefined, { whole: 1, page: 2000 })
    expect(text.pageByPage).toBe(true)
    // nothing in common: every old page removed and every new page added
    expect(text.changes.filter((c) => c.type === 'pageRemoved')).toHaveLength(4)
    expect(text.changes.filter((c) => c.type === 'pageAdded')).toHaveLength(4)
  })
})

// ---- page alignment -------------------------------------------------------------------------------

describe('page alignment', () => {
  it('finds an inserted page', () => {
    const r = run(doc([LOREM, TERMS, APPENDIX]), doc([LOREM, CONTACTS, TERMS, APPENDIX]))
    expect(r.rows).toEqual([
      { old: 0, new: 0, kind: 'match' },
      { old: null, new: 1, kind: 'gap' },
      { old: 1, new: 2, kind: 'match' },
      { old: 2, new: 3, kind: 'match' }
    ])
    expect(describe_(r)).toEqual(['Page 2 added'])
  })

  it('reports a removed page exactly, even when the next page starts with the same words', () => {
    const sec = (n: string) => [`Section ${n}`, `Paragraph one of section ${n} describes clause ${n}.`, `Paragraph two of section ${n}.`]
    const r = run(doc([sec('1'), sec('2'), sec('3'), sec('4')]), doc([sec('1'), sec('2'), sec('4')]))
    expect(describe_(r)).toEqual(['Page 3 removed'])
    const r2 = run(doc([sec('1'), sec('2'), sec('4')]), doc([sec('1'), sec('2'), sec('3'), sec('4')]))
    expect(describe_(r2)).toEqual(['Page 3 added'])
  })

  it('finds a removed page', () => {
    const r = run(doc([LOREM, CONTACTS, TERMS]), doc([LOREM, TERMS]))
    expect(describe_(r)).toEqual(['Page 2 removed'])
    expect(r.rows[1]).toEqual({ old: 1, new: null, kind: 'gap' })
  })

  it('finds a moved page and still compares its text', () => {
    const appendix2 = [...APPENDIX.slice(0, 1), 'Urgent requests are answered within two hours.']
    const r = run(doc([LOREM, APPENDIX, TERMS, CONTACTS]), doc([LOREM, TERMS, CONTACTS, appendix2]))
    expect(describe_(r)).toEqual(['Page 2 moved to page 4', 'Replaced “four” with “two”'])
    expect(r.rows).toEqual([
      { old: 0, new: 0, kind: 'match' },
      { old: 2, new: 1, kind: 'match' },
      { old: 3, new: 2, kind: 'match' },
      { old: 1, new: 3, kind: 'moved' }
    ])
    expect(r.visualPairs).toContainEqual([1, 3])
  })

  it('shows a rewritten page next to the page it replaced', () => {
    const r = run(doc([LOREM, TERMS, APPENDIX]), doc([LOREM, CONTACTS, APPENDIX]))
    expect(r.rows[1]).toEqual({ old: 1, new: 1, kind: 'gap' })
    expect(describe_(r).sort()).toEqual(['Page 2 added', 'Page 2 removed'])
  })

  it('aligns pages without text by their thumbnails', () => {
    const blank = (v: number, i: number): PageTokens => ({
      page: i,
      width: 612,
      height: 792,
      tokens: [],
      textRects: [],
      imageRects: [],
      thumb: new Uint8Array(THUMB_W * THUMB_H).fill(v)
    })
    const al = alignPages([blank(255, 0), blank(0, 1)], [blank(0, 0)])
    expect(al.pairs).toEqual([[1, 0]])
  })
})

// ---- visual diff ----------------------------------------------------------------------------------

function raster(w: number, h: number, paint?: (x: number, y: number) => [number, number, number] | null): Raster {
  const data = new Uint8Array(w * h * 3).fill(255)
  if (paint)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const c = paint(x, y)
        if (c) data.set(c, (y * w + x) * 3)
      }
  return { width: w, height: h, data }
}

describe('visualDiff', () => {
  const meta = { width: 306, height: 396, textRects: [] as [number, number, number, number][], imageRects: [] as [number, number, number, number][] }

  it('finds a changed area and maps it to page space on both sides', () => {
    // 2 px per point
    const a = raster(612, 792)
    const b = raster(612, 792, (x, y) => (x >= 100 && x < 200 && y >= 300 && y < 340 ? [0, 0, 200] : null))
    const regions = visualDiff(a, b, meta, meta)
    expect(regions).toHaveLength(1)
    const r = regions[0].newRect
    expect(r[0]).toBeGreaterThanOrEqual(48)
    expect(r[0]).toBeLessThanOrEqual(50)
    expect(r[1]).toBeGreaterThanOrEqual(148)
    expect(r[2]).toBeGreaterThanOrEqual(100)
    expect(r[2]).toBeLessThanOrEqual(102)
    expect(r[3]).toBeLessThanOrEqual(172)
    expect(regions[0].detail).toBe('Graphics changed')
  })

  it('ignores differences inside text areas and tiny specks', () => {
    const a = raster(612, 792)
    const b = raster(612, 792, (x, y) => {
      if (x >= 100 && x < 200 && y >= 300 && y < 340) return [0, 0, 0] // text
      if (x === 500 && y === 500) return [0, 0, 0] // speck
      return null
    })
    const withText = { ...meta, textRects: [[48, 148, 102, 172]] as [number, number, number, number][] }
    expect(visualDiff(a, b, withText, withText)).toEqual([])
  })

  it('labels changes over images', () => {
    const a = raster(612, 792)
    const b = raster(612, 792, (x, y) => (x >= 400 && x < 500 && y >= 100 && y < 200 ? [200, 30, 30] : null))
    const img = { ...meta, imageRects: [[190, 40, 260, 110]] as [number, number, number, number][] }
    expect(visualDiff(a, b, img, img).map((r) => r.detail)).toEqual(['Image changed'])
    expect(visualDiff(a, b, meta, img).map((r) => r.detail)).toEqual(['Image added'])
  })
})

// ---- results and helpers --------------------------------------------------------------------------

describe('finalizeResult', () => {
  it('orders changes as they appear, numbers and counts them', () => {
    const text = compareText(
      [page(0, ['alpha beta gamma']), page(1, ['delta epsilon'])],
      [page(0, ['alpha BETA gamma']), page(1, ['delta epsilon zeta'])],
      { ...DEFAULT_OPTIONS, mode: 'text-images' }
    )
    const r = finalizeResult(text, [{ oldPage: 0, newPage: 0, regions: [{ oldRect: [0, 0, 10, 10], newRect: [0, 0, 10, 10], detail: 'Image changed' }] }], {
      options: DEFAULT_OPTIONS,
      oldPages: [0, 1],
      newPages: [0, 1],
      elapsed: 1
    })
    expect(r.changes.map((c) => [c.id, describeChange(c)])).toEqual([
      [1, 'Image changed'],
      [2, 'Replaced “beta” with “BETA”'],
      [3, 'Inserted “zeta”']
    ])
    expect(r.counts).toEqual({ replaced: 1, inserted: 1, deleted: 0, formatting: 0, image: 1, page: 0 })
  })
})

describe('parsePageRange', () => {
  it('parses pages and ranges', () => {
    expect(parsePageRange('1-3, 5', 10)).toEqual({ pages: [0, 1, 2, 4] })
    expect(parsePageRange('8-', 10)).toEqual({ pages: [7, 8, 9] })
    expect(parsePageRange('-2', 10)).toEqual({ pages: [0, 1] })
    expect(parsePageRange('3–1', 10)).toEqual({ pages: [0, 1, 2] })
  })
  it('explains invalid input', () => {
    expect(parsePageRange('', 4)).toEqual({ error: 'Enter pages, for example 1-3, 5' })
    expect(parsePageRange('2-9', 4)).toEqual({ error: 'Page 9 does not exist (the document has 4 pages)' })
    expect(parsePageRange('abc', 4)).toEqual({ error: '“abc” is not a page or range' })
    expect(parsePageRange('0', 4)).toEqual({ error: 'Page numbers start at 1' })
  })
})
