import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import printOps from '@features/print/engine'
import {
  bookletSpreads,
  cellPosition,
  chooseGrid,
  defaultPaperForLocale,
  fitScale,
  gridsFor,
  jobOrientation,
  layoutSheets,
  PAPERS,
  posterTiles,
  PRINT_MARGIN,
  sheetNeedsTurn,
  sheetScale,
  sizingScale,
  type ImpositionOptions,
  type PageBox
} from '@features/print/imposition'
import { filterSubset, fullRangeText, parsePageRange, selectPages } from '@features/print/pageRanges'
import { buildJob } from '@features/print/job'
import {
  defaultSettings,
  formatSize,
  fromPoints,
  impositionOptions,
  persistable,
  printDpi,
  sanitizeSettings,
  toPoints
} from '@features/print/settings'
import { openFixture } from './helpers'

const LETTER: PageBox = { width: 612, height: 792 }
const LETTER_LANDSCAPE: PageBox = { width: 792, height: 612 }
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

function opts(patch: Partial<ImpositionOptions> = {}): ImpositionOptions {
  return { ...impositionOptions(defaultSettings('en-US')), ...patch }
}

// ---------------------------------------------------------------------------------------------
describe('page ranges', () => {
  it('parses Acrobat-style ranges', () => {
    expect(parsePageRange('1-3, 5, 8-', 10).pages).toEqual([0, 1, 2, 4, 7, 8, 9])
    expect(parsePageRange('-3', 10).pages).toEqual([0, 1, 2])
    expect(parsePageRange('2', 10).pages).toEqual([1])
    expect(parsePageRange('5-3', 10).pages).toEqual([4, 3, 2])
    expect(parsePageRange(' 1 - 2 ; 4 ', 10).pages).toEqual([0, 1, 3])
    expect(parsePageRange('1 3 5', 10).pages).toEqual([0, 2, 4])
    expect(parsePageRange('2–4', 10).pages).toEqual([1, 2, 3])
    expect(parsePageRange('1-', 3).pages).toEqual([0, 1, 2])
  })

  it('explains invalid input in plain language', () => {
    expect(parsePageRange('', 5).error).toMatch(/Enter the pages/)
    expect(parsePageRange('7', 5).error).toBe('There is no page 7. This document has 5 pages.')
    expect(parsePageRange('2-9', 5).error).toBe('There is no page 9. This document has 5 pages.')
    expect(parsePageRange('0', 5).error).toBe('Page numbers start at 1.')
    expect(parsePageRange('abc', 5).error).toMatch(/isn't a page number or page label/)
    expect(parsePageRange('1, x', 5).pages).toEqual([])
  })

  it('resolves page labels before physical page numbers', () => {
    const labels = ['i', 'ii', 'iii', '1', '2', '3']
    expect(parsePageRange('ii-1', 6, labels).pages).toEqual([1, 2, 3])
    expect(parsePageRange('1', 6, labels).pages).toEqual([3])
    expect(parsePageRange('III', 6, labels).pages).toEqual([2])
    expect(parsePageRange('2-', 6, labels).pages).toEqual([4, 5])
    const hyphenated = ['A-1', 'A-2', 'A-3', 'B-1']
    expect(parsePageRange('A-3', 4, hyphenated).pages).toEqual([2])
    expect(parsePageRange('A-2-B-1', 4, hyphenated).pages).toEqual([1, 2, 3])
    expect(fullRangeText(labels)).toBe('i - 3')
    expect(parsePageRange(fullRangeText(labels), 6, labels).pages).toEqual(range(6))
  })

  it('selects all, current or a range, then odd or even pages', () => {
    expect(selectPages({ mode: 'all', range: '', subset: 'all' }, 4, 2).pages).toEqual([0, 1, 2, 3])
    expect(selectPages({ mode: 'current', range: '', subset: 'all' }, 4, 2).pages).toEqual([2])
    expect(selectPages({ mode: 'range', range: '2-4', subset: 'odd' }, 5, 0).pages).toEqual([2])
    expect(selectPages({ mode: 'all', range: '', subset: 'even' }, 5, 0).pages).toEqual([1, 3])
    expect(selectPages({ mode: 'current', range: '', subset: 'even' }, 5, 0).error).toMatch(/no even pages/)
    expect(filterSubset([0, 1, 2, 3, 4], 'odd')).toEqual([0, 2, 4])
  })
})

// ---------------------------------------------------------------------------------------------
describe('paper and sizing', () => {
  it('picks the default paper from the locale', () => {
    expect(defaultPaperForLocale('en-US')).toBe('Letter')
    expect(defaultPaperForLocale('fr-CA')).toBe('Letter')
    expect(defaultPaperForLocale('es-MX')).toBe('Letter')
    expect(defaultPaperForLocale('en-GB')).toBe('A4')
    expect(defaultPaperForLocale('de_DE')).toBe('A4')
    expect(defaultPaperForLocale('zh-Hans-CN')).toBe('A4')
    expect(defaultPaperForLocale('en')).toBe('Letter')
    expect(defaultPaperForLocale('fr')).toBe('A4')
    expect(defaultSettings('ja-JP').paper).toBe('A4')
  })

  it('computes fit, actual size, shrink and custom scales', () => {
    expect(fitScale(612, 792, 588, 768)).toBeCloseTo(588 / 612)
    expect(sizingScale(LETTER, 588, 768, 'fit', 100)).toBeCloseTo(0.9608, 3)
    expect(sizingScale(LETTER, 588, 768, 'actual', 100)).toBe(1)
    expect(sizingScale({ width: 300, height: 400 }, 588, 768, 'shrink', 100)).toBe(1)
    expect(sizingScale({ width: 300, height: 400 }, 588, 768, 'fit', 100)).toBeCloseTo(1.92)
    expect(sizingScale(PAPERS.Tabloid, 588, 768, 'shrink', 100)).toBeCloseTo(768 / 1224)
    expect(sizingScale(LETTER, 588, 768, 'custom', 50)).toBe(0.5)
  })

  it('fits each page centred on its own sheet (Size)', () => {
    const sheets = layoutSheets([0, 1], [LETTER, LETTER_LANDSCAPE], opts({ sizing: 'fit' }))
    expect(sheets).toHaveLength(2)
    const [a, b] = sheets
    expect([a.width, a.height]).toEqual([612, 792])
    const p = a.placements[0]
    expect(p.scale).toBeCloseTo((612 - 2 * PRINT_MARGIN) / 612)
    expect(p.x).toBeCloseTo(PRINT_MARGIN)
    expect(p.y).toBeCloseTo((792 - p.height) / 2)
    // Auto orientation: landscape pages print on landscape sheets
    expect([b.width, b.height]).toEqual([792, 612])
    expect(sheetScale(a)).toBeCloseTo(p.scale)
  })

  it('respects forced orientation and actual size', () => {
    const [s] = layoutSheets([0], [LETTER_LANDSCAPE], opts({ orientation: 'portrait', sizing: 'fit' }))
    expect([s.width, s.height]).toEqual([612, 792])
    expect(s.placements[0].scale).toBeCloseTo(588 / 792)
    const [actual] = layoutSheets([0], [PAPERS.A4], opts({ sizing: 'actual' }))
    expect(actual.placements[0].scale).toBe(1)
    expect(actual.placements[0].x).toBeCloseTo((612 - 595.28) / 2)
    const [custom] = layoutSheets([0], [LETTER], opts({ sizing: 'custom', customScale: 50 }))
    expect(custom.placements[0].width).toBeCloseTo(306)
    expect(custom.placements[0].x).toBeCloseTo(153)
  })

  it('reverses the sheet order', () => {
    const sheets = layoutSheets([0, 1, 2], [LETTER, LETTER, LETTER], opts({ reverse: true }))
    expect(sheets.map((s) => s.placements[0].page)).toEqual([2, 1, 0])
  })
})

// ---------------------------------------------------------------------------------------------
describe('multiple pages per sheet', () => {
  it('offers near-square grids', () => {
    expect(gridsFor(2)).toEqual([
      { cols: 1, rows: 2 },
      { cols: 2, rows: 1 }
    ])
    expect(gridsFor(4)).toEqual([{ cols: 2, rows: 2 }])
    expect(gridsFor(6)).toEqual([
      { cols: 2, rows: 3 },
      { cols: 3, rows: 2 }
    ])
    expect(gridsFor(9)).toEqual([{ cols: 3, rows: 3 }])
    expect(gridsFor(16)).toEqual([{ cols: 4, rows: 4 }])
  })

  it('chooses the orientation that prints pages largest', () => {
    const two = chooseGrid(LETTER, opts({ perSheet: 2 }))
    expect([two.cols, two.rows, two.sheet.width]).toEqual([2, 1, 792])
    const four = chooseGrid(LETTER, opts({ perSheet: 4 }))
    expect([four.cols, four.rows, four.sheet.width]).toEqual([2, 2, 612])
    const six = chooseGrid(LETTER, opts({ perSheet: 6 }))
    expect([six.cols, six.rows, six.sheet.width]).toEqual([3, 2, 792])
    const forced = chooseGrid(LETTER, opts({ perSheet: 2, orientation: 'portrait', autoRotate: false }))
    expect([forced.cols, forced.rows, forced.sheet.width]).toEqual([1, 2, 612])
  })

  it('orders pages horizontally or vertically, optionally reversed', () => {
    expect([0, 1, 2, 3].map((k) => cellPosition(k, 2, 2, 'horizontal'))).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 0, row: 1 },
      { col: 1, row: 1 }
    ])
    expect(cellPosition(1, 2, 2, 'vertical')).toEqual({ col: 0, row: 1 })
    expect(cellPosition(0, 2, 2, 'horizontal-reversed')).toEqual({ col: 1, row: 0 })
    expect(cellPosition(2, 2, 2, 'vertical-reversed')).toEqual({ col: 0, row: 0 })
  })

  it('lays out 2-up sheets with the pages side by side', () => {
    const sizes = range(5).map(() => LETTER)
    const sheets = layoutSheets([1, 2], sizes, opts({ mode: 'multiple', perSheet: 2, pageBorder: true }))
    expect(sheets).toHaveLength(1)
    const [s] = sheets
    expect([s.width, s.height]).toEqual([792, 612])
    expect(s.border).toBe(true)
    expect(s.placements.map((p) => p.page)).toEqual([1, 2])
    const [left, right] = s.placements
    expect(left.x + left.width).toBeLessThan(right.x)
    expect(left.scale).toBeCloseTo(right.scale)
    // inside the printable area
    for (const p of s.placements) {
      expect(p.x).toBeGreaterThanOrEqual(PRINT_MARGIN - 1e-6)
      expect(p.y).toBeGreaterThanOrEqual(PRINT_MARGIN - 1e-6)
      expect(p.x + p.width).toBeLessThanOrEqual(792 - PRINT_MARGIN + 1e-6)
      expect(p.y + p.height).toBeLessThanOrEqual(612 - PRINT_MARGIN + 1e-6)
    }
  })

  it('splits pages over sheets and auto-rotates odd ones out', () => {
    const sizes = [LETTER, LETTER, LETTER, LETTER, LETTER_LANDSCAPE]
    const sheets = layoutSheets(range(5), sizes, opts({ mode: 'multiple', perSheet: 4 }))
    expect(sheets.map((s) => s.placements.length)).toEqual([4, 1])
    // the landscape page is turned to fill the portrait cell
    expect(sheets[1].placements[0].rotate).toBe(270)
    const noRotate = layoutSheets(range(5), sizes, opts({ mode: 'multiple', perSheet: 4, autoRotate: false }))
    expect(noRotate[1].placements[0].rotate).toBe(0)
    const custom = layoutSheets(range(5), sizes, opts({ mode: 'multiple', grid: { cols: 3, rows: 1 }, perSheet: 3 }))
    expect(custom.map((s) => s.placements.length)).toEqual([3, 2])
  })
})

// ---------------------------------------------------------------------------------------------
describe('booklets', () => {
  it('imposes saddle-stitched spreads', () => {
    expect(bookletSpreads(range(8), 'left')).toEqual([
      { front: [7, 0], back: [1, 6] },
      { front: [5, 2], back: [3, 4] }
    ])
    expect(bookletSpreads(range(8), 'right')).toEqual([
      { front: [0, 7], back: [6, 1] },
      { front: [2, 5], back: [4, 3] }
    ])
    // 5 pages are padded with blank pages
    expect(bookletSpreads(range(5), 'left')).toEqual([
      { front: [-1, 0], back: [1, -1] },
      { front: [-1, 2], back: [3, 4] }
    ])
  })

  it('prints both sides, one side, or a range of sheets on landscape paper', () => {
    const sizes = range(8).map(() => LETTER)
    const both = layoutSheets(range(8), sizes, opts({ mode: 'booklet', orientation: 'portrait' }))
    expect(both).toHaveLength(4)
    expect(both.every((s) => s.width === 792 && s.height === 612)).toBe(true)
    expect(both.map((s) => `${s.sheetNumber}${s.side}:${s.placements.map((p) => p.page).join('+')}`)).toEqual([
      '1front:7+0',
      '1back:1+6',
      '2front:5+2',
      '2back:3+4'
    ])
    const fronts = layoutSheets(range(8), sizes, opts({ mode: 'booklet', bookletSubset: 'front' }))
    expect(fronts.map((s) => s.side)).toEqual(['front', 'front'])
    const second = layoutSheets(range(8), sizes, opts({ mode: 'booklet', sheetFrom: 2, sheetTo: 2 }))
    expect(second.map((s) => s.sheetNumber)).toEqual([2, 2])
    const reversed = layoutSheets(range(8), sizes, opts({ mode: 'booklet', reverse: true }))
    expect(reversed.map((s) => `${s.sheetNumber}${s.side}`)).toEqual(['2front', '2back', '1front', '1back'])
    // pages meet at the fold
    const [left, right] = both[0].placements
    expect(left.x + left.width).toBeCloseTo(396 - PRINT_MARGIN / 2)
    expect(right.x).toBeCloseTo(396 + PRINT_MARGIN / 2)
  })

  it('leaves blank pages empty', () => {
    const sizes = range(5).map(() => LETTER)
    const sheets = layoutSheets(range(5), sizes, opts({ mode: 'booklet' }))
    expect(sheets.map((s) => s.placements.length)).toEqual([1, 1, 1, 2])
  })
})

// ---------------------------------------------------------------------------------------------
describe('posters', () => {
  it('tiles enlarged pages with overlap', () => {
    const t = posterTiles(LETTER, { width: 612, height: 792 }, 2, 18)
    expect([t.cols, t.rows]).toEqual([3, 3])
    const sheets = layoutSheets([0], [LETTER], opts({ mode: 'poster', tileScale: 200, overlap: 18 }), (p, r, c) => `p${p} r${r} c${c}`)
    // landscape paper needs fewer tiles for this page
    expect(sheets).toHaveLength(6)
    expect(sheets[0].width).toBe(792)
    expect(sheets[0].label).toBe('p0 r0 c0')
    expect(sheets[5].label).toBe('p0 r2 c1')
    const first = sheets[0].placements[0]
    expect(first.width).toBeCloseTo(1224)
    expect(first.clip).toEqual([18, 18, 774, 594])
    expect(sheets[0].cutMarks).toEqual([18, 18, 774, 594])
    // consecutive tiles move by the printable width minus the overlap
    const second = sheets[1].placements[0]
    expect(first.x - second.x).toBeCloseTo(756 - 18)
    // the poster is centred on the tiled area
    const coverW = 2 * (756 - 18) + 18
    expect(first.x).toBeCloseTo(18 + (coverW - 1224) / 2)
  })

  it('prints small pages on one sheet when only large pages are tiled', () => {
    const sheets = layoutSheets([0, 1], [{ width: 300, height: 300 }, LETTER], opts({ mode: 'poster', tileScale: 100, tileLargeOnly: true, labels: false }))
    expect(sheets[0].placements[0].clip).toBeUndefined()
    expect(sheets[0].cutMarks).toBeUndefined()
    // a full Letter page does not fit inside the poster margins: it is tiled
    expect(sheets.length).toBeGreaterThan(2)
  })
})

// ---------------------------------------------------------------------------------------------
describe('job orientation', () => {
  it('uses landscape paper only when every sheet is landscape', () => {
    const land = layoutSheets([0], [LETTER_LANDSCAPE], opts())
    const mixed = layoutSheets([0, 1], [LETTER, LETTER_LANDSCAPE], opts())
    expect(jobOrientation(land)).toBe('landscape')
    expect(jobOrientation(mixed)).toBe('portrait')
    expect(sheetNeedsTurn(mixed[1], 'portrait')).toBe(true)
    expect(sheetNeedsTurn(mixed[0], 'portrait')).toBe(false)
    expect(jobOrientation([])).toBe('portrait')
  })

  it('builds the print job for the main process', () => {
    const s = { ...defaultSettings('en-US'), copies: 3, grayscale: true, duplex: true, flip: 'short' as const, paper: 'A4' as const }
    const sheets = layoutSheets([0], [LETTER_LANDSCAPE], opts())
    const pages = [{ data: new Uint8Array([1]), mime: 'image/png' as const, widthPt: 792, heightPt: 612 }]
    const job = buildJob(pages, s, sheets, { printer: 'Office', printerLabel: 'Office' }, 'a.pdf')
    expect(job).toMatchObject({
      silent: true,
      copies: 3,
      color: false,
      landscape: true,
      fit: 'fit',
      deviceName: 'Office',
      duplex: 'shortEdge',
      jobName: 'a.pdf',
      pageSize: 'A4'
    })
    const sys = buildJob(pages, { ...s, duplex: false }, sheets, { printer: null, printerLabel: 'x' }, 'a.pdf')
    expect(sys.silent).toBe(false)
    expect(sys.deviceName).toBeUndefined()
    expect(sys.duplex).toBe('simplex')
  })
})

// ---------------------------------------------------------------------------------------------
describe('settings', () => {
  it('drops malformed stored values and forgets per-job choices', () => {
    const d = defaultSettings('en-US')
    const s = sanitizeSettings(
      { layout: 'booklet', copies: 5000, paper: 'B5', perSheet: 7, grayscale: 'yes', customScale: 50, content: 'stamps', extra: 1 },
      d
    )
    expect(s.layout).toBe('booklet')
    expect(s.copies).toBe(1)
    expect(s.paper).toBe('Letter')
    expect(s.perSheet).toBe(2)
    expect(s.grayscale).toBe(false)
    expect(s.customScale).toBe(50)
    expect(s.content).toBe('stamps')
    expect(sanitizeSettings(null, d)).toEqual(d)
    const stored = persistable({ ...d, copies: 4, pages: 'range', range: '1-2', reverse: true })
    expect(stored).not.toHaveProperty('copies')
    expect(stored).not.toHaveProperty('range')
    expect(stored).not.toHaveProperty('reverse')
    expect(stored.layout).toBe('size')
  })

  it('maps quality, units and sizes', () => {
    expect(printDpi({ draft: false }, true)).toBe(300)
    expect(printDpi({ draft: true }, true)).toBe(150)
    expect(printDpi({ draft: false }, false)).toBe(150)
    expect(fromPoints(72, 'in')).toBe(1)
    expect(toPoints(25.4, 'mm')).toBeCloseTo(72)
    expect(formatSize(612, 792, 'in')).toBe('8.5 × 11 in')
    expect(formatSize(595.28, 841.89, 'mm')).toBe('210 × 297 mm')
    const custom = impositionOptions({ ...defaultSettings('en-US'), perSheet: 0, gridCols: 3, gridRows: 2 })
    expect(custom.grid).toEqual({ cols: 3, rows: 2 })
    expect(custom.perSheet).toBe(6)
  })
})

// ---------------------------------------------------------------------------------------------
type PrintOps = typeof printOps

function pixel(r: { width: number; pixels?: Uint8ClampedArray }, x: number, y: number): number[] {
  const i = (Math.round(y) * r.width + Math.round(x)) * 4
  return [...r.pixels!.slice(i, i + 3)]
}

function inkIn(r: { width: number; height: number; pixels?: Uint8ClampedArray }, rect: [number, number, number, number]): number {
  let n = 0
  for (let y = Math.max(0, rect[1]); y < Math.min(r.height, rect[3]); y++)
    for (let x = Math.max(0, rect[0]); x < Math.min(r.width, rect[2]); x++) {
      const i = (y * r.width + x) * 4
      if (r.pixels![i] < 200 || r.pixels![i + 1] < 200 || r.pixels![i + 2] < 200) n++
    }
  return n
}

describe('print rendering (engine)', () => {
  it('renders pages at the requested scale, in colour or grayscale', async () => {
    const e = await openFixture('text.pdf')
    const print = e.ops<PrintOps>('print')
    const r = await print.renderPage(0, { scale: 0.5, content: 'markups' })
    expect([r.width, r.height]).toEqual([306, 396])
    expect(r.pixels!.length).toBe(306 * 396 * 4)
    const blue = pixel(r, 86, 186)
    expect(blue[2]).toBeGreaterThan(200)
    expect(blue[0]).toBeLessThan(60)
    const g = await print.renderPage(0, { scale: 0.5, content: 'markups', grayscale: true })
    const gray = pixel(g, 86, 186)
    expect(gray[0]).toBe(gray[1])
    expect(gray[1]).toBe(gray[2])
    expect(gray[0]).toBeLessThan(200)
  })

  it('follows the Comments & Forms choice and the annotations’ Print flag', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    const print = e.ops<PrintOps>('print')
    const markupRect: [number, number, number, number] = [420, 560, 520, 620]
    const stampRect: [number, number, number, number] = [420, 640, 560, 700]
    const hiddenRect: [number, number, number, number] = [300, 560, 400, 620]
    const fillRect: [number, number, number, number] = [300, 640, 400, 700]
    await annots.create(0, { type: 'Square', rect: markupRect, color: '#ff0000', interiorColor: '#ff0000', borderWidth: 2 })
    await annots.create(0, { type: 'Stamp', rect: stampRect })
    await annots.create(0, { type: 'Square', rect: hiddenRect, color: '#00aa00', interiorColor: '#00aa00', flags: 0 })
    await annots.create(0, {
      type: 'Square',
      rect: fillRect,
      color: '#000000',
      interiorColor: '#000000',
      extra: { fartcrobat: 'fillsign' }
    })
    const render = (content: 'markups' | 'document' | 'stamps' | 'forms') => print.renderPage(0, { scale: 1, content })
    const all = await render('markups')
    expect(inkIn(all, markupRect)).toBeGreaterThan(3000)
    expect(inkIn(all, stampRect)).toBeGreaterThan(50)
    expect(inkIn(all, fillRect)).toBeGreaterThan(3000)
    // annotations without the Print flag never print
    expect(inkIn(all, hiddenRect)).toBe(0)

    const doc = await render('document')
    expect(inkIn(doc, markupRect)).toBe(0)
    expect(inkIn(doc, stampRect)).toBe(0)
    // Fill & Sign content is part of the document
    expect(inkIn(doc, fillRect)).toBeGreaterThan(3000)
    // page content still prints
    expect(pixel(doc, 172, 372)[2]).toBeGreaterThan(200)

    const stamps = await render('stamps')
    expect(inkIn(stamps, markupRect)).toBe(0)
    expect(inkIn(stamps, stampRect)).toBeGreaterThan(50)

    const forms = await render('forms')
    expect(inkIn(forms, [0, 0, forms.width, forms.height])).toBe(0)

    // the live document is untouched: nothing stays hidden
    const again = await render('markups')
    expect(inkIn(again, markupRect)).toBe(inkIn(all, markupRect))

    const summary = await print.contentSummary([0, 1])
    expect(summary).toMatchObject({ markups: 2, stamps: 1, documentAnnots: 1 })
  })

  it('prints only form fields with “Form fields only”', async () => {
    const e = await openFixture('form.pdf')
    const print = e.ops<PrintOps>('print')
    const full = await print.renderPage(0, { scale: 1, content: 'markups' })
    const forms = await print.renderPage(0, { scale: 1, content: 'forms' })
    const fieldInk = inkIn(forms, [0, 0, forms.width, forms.height])
    expect(fieldInk).toBeGreaterThan(500)
    expect(fieldInk).toBeLessThan(inkIn(full, [0, 0, full.width, full.height]))
    // labels left of the fields (page content) are gone
    expect(inkIn(forms, [40, 100, 150, 400])).toBe(0)
    expect(inkIn(full, [40, 100, 150, 400])).toBeGreaterThan(0)
    const summary = await print.contentSummary([0])
    expect(summary.fields).toBe(9)
  })

  it('sees when a document forbids printing', async () => {
    const e = await openFixture('print/no-print.pdf')
    expect(e.info.pageCount).toBe(5)
    expect(e.info.permissions.print).toBe(false)
    expect(e.info.permissions.copy).toBe(true)
  })

  it('lowers the resolution of huge renders instead of failing', async () => {
    const e = await openFixture('text.pdf')
    const r = await e.ops<PrintOps>('print').renderPage(0, { scale: 20, content: 'document' })
    expect(r.width * r.height).toBeLessThanOrEqual(36_000_000 * 1.01)
    expect(r.scale).toBeLessThan(20)
    expect(r.width).toBeCloseTo(612 * r.scale, -1)
  })
})
