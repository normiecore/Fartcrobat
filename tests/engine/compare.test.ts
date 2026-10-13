import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import type compareOps from '../../src/features/compare/engine'
import { CancelledError, inlineBackend, runComparison } from '../../src/features/compare/pipeline'
import { describeChange } from '../../src/features/compare/core'
import type { ReportInput } from '../../src/features/compare/report'
import { DEFAULT_OPTIONS, type CompareOptions, type CompareResult } from '../../src/features/compare/types'
import { openFixture, type OpenedEngine } from './helpers'

const all = (e: OpenedEngine) => [...Array(e.info.pageCount).keys()]

async function compareFixtures(
  a: string,
  b: string,
  opts: Partial<CompareOptions> = {},
  pages: { old?: number[]; new?: number[] } = {}
) {
  const ea = await openFixture(a)
  const eb = await openFixture(b)
  const result = await runComparison(
    { ops: ea.ops<typeof compareOps>('compare'), pages: pages.old ?? all(ea) },
    { ops: eb.ops<typeof compareOps>('compare'), pages: pages.new ?? all(eb) },
    { ...DEFAULT_OPTIONS, ...opts },
    inlineBackend
  )
  return { ea, eb, result }
}

const titles = (r: CompareResult) => r.changes.map((c) => describeChange(c))

describe('compare: compare-a.pdf vs compare-b.pdf', () => {
  it('finds exactly the two changes', async () => {
    const { result } = await compareFixtures('compare-a.pdf', 'compare-b.pdf')
    expect(titles(result)).toEqual(['Replaced “$1,234.56” with “$9,876.54”', 'Replaced “finance” with “audit”'])
    expect(result.counts).toEqual({ replaced: 2, inserted: 0, deleted: 0, formatting: 0, image: 0, page: 0 })
    expect(result.rows).toEqual([{ old: 0, new: 0, kind: 'match' }])
    // the highlight of "$9,876.54" sits on the second line, right of "Total revenue:"
    const r = result.changes[0].new!.rects[0]
    expect(r[0]).toBeGreaterThan(140)
    expect(r[0]).toBeLessThan(160)
    expect(r[1]).toBeGreaterThan(95)
    expect(r[3]).toBeLessThan(118)
  })

  it('finds the same changes when comparing text only', async () => {
    const { result } = await compareFixtures('compare-a.pdf', 'compare-b.pdf', { mode: 'text' })
    expect(titles(result)).toEqual(['Replaced “$1,234.56” with “$9,876.54”', 'Replaced “finance” with “audit”'])
  })

  it('finds no differences between a file and itself', async () => {
    const { result } = await compareFixtures('text.pdf', 'text.pdf')
    expect(result.changes).toEqual([])
    expect(result.rows).toHaveLength(5)
  })

  it('handles rotated pages of different sizes and pages without text', async () => {
    const mixed = await compareFixtures('mixed-sizes.pdf', 'mixed-sizes.pdf')
    expect(mixed.result.changes).toEqual([])
    expect(mixed.result.rows.map((r) => r.kind)).toEqual(['match', 'match', 'match'])
    const scanned = await compareFixtures('scanned.pdf', 'scanned.pdf')
    expect(scanned.result.changes).toEqual([])
    expect(scanned.result.rows).toEqual([{ old: 0, new: 0, kind: 'match' }])
    // an image-only page against a text page: the whole page is different
    const other = await compareFixtures('scanned.pdf', 'compare-a.pdf')
    expect(titles(other.result).sort()).toEqual(['Page 1 added', 'Page 1 removed'])
  })
})

describe('compare: multi-page contract', () => {
  it('finds text, formatting, image and page changes', async () => {
    const { result } = await compareFixtures('compare/contract-old.pdf', 'compare/contract-new.pdf')
    expect(titles(result)).toEqual([
      'Image changed',
      'Graphics changed',
      'Replaced “Beta” with “Gamma”',
      'Formatting changed in “total fee”',
      'Replaced “. Late payments incur a fee of 2%” with “of the invoice date”',
      'Page 3 added',
      'Page 3 moved to page 5',
      'Page 5 removed'
    ])
    expect(result.changes[3].detail).toBe('Font Helvetica → Helvetica-Bold')
    expect(result.rows).toEqual([
      { old: 0, new: 0, kind: 'match' },
      { old: 1, new: 1, kind: 'match' },
      { old: null, new: 2, kind: 'gap' },
      { old: 3, new: 3, kind: 'match' },
      { old: 2, new: 4, kind: 'moved' },
      { old: 4, new: null, kind: 'gap' }
    ])
    // the logo (drawn at x 470-530, y 692-752 from the bottom) and the bar (y 670-678)
    const [logo, bar] = result.changes
    expect(logo.new!.rects[0][0]).toBeGreaterThan(460)
    expect(logo.new!.rects[0][1]).toBeGreaterThan(30)
    expect(logo.new!.rects[0][3]).toBeLessThan(110)
    expect(bar.old!.rects[0][1]).toBeGreaterThan(105)
    expect(bar.old!.rects[0][3]).toBeLessThan(130)
    expect(result.counts).toEqual({ replaced: 2, inserted: 0, deleted: 0, formatting: 1, image: 2, page: 3 })
  })

  it('skips images and formatting when asked', async () => {
    const { result } = await compareFixtures('compare/contract-old.pdf', 'compare/contract-new.pdf', { mode: 'text', formatting: false })
    expect(result.counts).toEqual({ replaced: 2, inserted: 0, deleted: 0, formatting: 0, image: 0, page: 3 })
  })

  it('compares page ranges only', async () => {
    const { result } = await compareFixtures('compare/contract-old.pdf', 'compare/contract-new.pdf', { mode: 'text' }, { old: [0, 1], new: [0, 1] })
    expect(result.oldPages).toEqual([0, 1])
    expect(titles(result)).toEqual([
      'Replaced “Beta” with “Gamma”',
      'Formatting changed in “total fee”',
      'Replaced “. Late payments incur a fee of 2%” with “of the invoice date”'
    ])
  })

  it('stops when cancelled', async () => {
    const ea = await openFixture('compare/contract-old.pdf')
    const eb = await openFixture('compare/contract-new.pdf')
    let calls = 0
    await expect(
      runComparison(
        { ops: ea.ops<typeof compareOps>('compare'), pages: all(ea) },
        { ops: eb.ops<typeof compareOps>('compare'), pages: all(eb) },
        DEFAULT_OPTIONS,
        inlineBackend,
        () => {},
        () => ++calls > 2
      )
    ).rejects.toBeInstanceOf(CancelledError)
  })
})

describe('compare engine ops', () => {
  it('extracts words with positions, line and image boxes', async () => {
    const e = await openFixture('compare/contract-new.pdf')
    const [p] = await e.ops<typeof compareOps>('compare').extract([0])
    expect(p.width).toBeCloseTo(612)
    expect(p.tokens.slice(0, 2).map((t) => t.text)).toEqual(['Service', 'Agreement'])
    expect(p.tokens[0].font).toBe('Helvetica-Bold')
    expect(p.tokens[0].size).toBe(18)
    expect(p.textRects.length).toBeGreaterThan(5)
    expect(p.imageRects).toHaveLength(1)
    expect(p.thumb).toBeNull()
  })

  it('renders RGB rasters at the requested width', async () => {
    const e = await openFixture('compare-a.pdf')
    const r = await e.ops<typeof compareOps>('compare').raster(0, 300)
    expect(r.width).toBe(300)
    expect(r.height).toBe(Math.round((300 * 792) / 612))
    expect(r.data.length).toBe(r.width * r.height * 3)
  })

  it('rejects pages that do not exist', async () => {
    const e = await openFixture('compare-a.pdf')
    await expect(e.ops<typeof compareOps>('compare').extract([3])).rejects.toThrow(/Page 4 does not exist/)
  })
})

describe('compare report', () => {
  async function buildReport() {
    const { ea, eb, result } = await compareFixtures('compare/contract-old.pdf', 'compare/contract-new.pdf')
    const removedPages = result.changes.filter((c) => c.type === 'pageRemoved').map((c) => c.old!.page)
    const removedPdf = await ea.ops<typeof compareOps>('compare').copyPages(removedPages)
    const input: ReportInput = {
      oldName: 'contract-old.pdf',
      newName: 'contract-new.pdf',
      oldPageCount: 5,
      newPageCount: 5,
      oldPages: result.oldPages,
      newPages: result.newPages,
      options: result.options,
      date: '12 Oct 2026',
      changes: result.changes,
      counts: result.counts,
      pageByPage: false,
      removedPdf,
      removedPages
    }
    const bytes = await eb.ops<typeof compareOps>('compare').report(input)
    return { bytes, eb }
  }

  it('has a summary and annotated copies of the changed pages', async () => {
    const { bytes, eb } = await buildReport()
    const doc = new mupdf.PDFDocument(bytes)
    expect(doc.countPages()).toBe(5)
    const summary = doc.loadPage(0).toStructuredText('').asText()
    expect(summary).toContain('Compare report')
    expect(summary).toContain('contract-old.pdf')
    expect(summary).toContain('8 changes found.')
    expect(summary).toContain('Replaced “Beta” with “Gamma”')
    // the change list links to the report pages
    expect(doc.loadPage(0).getLinks().map((l) => l.getURI())).toContain('#page=2')
    const annots = (i: number) => doc.loadPage(i).getAnnotations().map((a) => `${a.getType()}: ${a.getContents()}`)
    expect(annots(1)).toEqual([
      'Square: Image changed',
      'Square: Graphics changed',
      'Highlight: Replaced “Beta” with “Gamma”',
      'Underline: Formatting changed in “total fee”. Font Helvetica → Helvetica-Bold.',
      'Highlight: Replaced “. Late payments incur a fee of 2%” with “of the invoice date”'
    ])
    expect(annots(2)).toEqual(['Square: Page 3 was added in the new document.', 'Text: Page 3 was added in the new document.'])
    expect(annots(3)).toEqual(['Text: Page 3 moved to page 5.'])
    expect(annots(4)[0]).toBe('Square: Page 5 of the old document was removed.')
    // the removed page is a copy of the old page
    expect(doc.loadPage(4).toStructuredText('').asText()).toContain('Obsolete notes')
    // highlights have popup notes, an author and the compare tag
    const hl = doc.loadPage(1).getAnnotations().find((a) => a.getType() === 'Highlight')!
    expect(hl.getObject().get('Popup').isNull()).toBe(false)
    expect(hl.getAuthor()).toBe('Fartcrobat Compare')
    expect(hl.getObject().get('FartcrobatData').get('fartcrobat').asString()).toBe('compare')
    expect(hl.getColor().map((v) => Math.round(v * 100) / 100)).toEqual([0.96, 0.62, 0.04])
    expect(doc.loadOutline()?.map((o) => o.title)).toEqual([
      'Summary',
      'New page 1 — 5 changes',
      'New page 3 — 1 change',
      'New page 5 — 1 change',
      'Old page 5 (removed)'
    ])
    // the open document was not modified
    expect(await eb.doc.isDirty()).toBe(false)
    expect(eb.lastChanges?.journal.canUndo).toBe(false)
  })

  it('marks deleted text with a strikeout where it was', async () => {
    const ea = await openFixture('compare-b.pdf')
    const eb = await openFixture('compare-a.pdf')
    const result = await runComparison(
      { ops: ea.ops<typeof compareOps>('compare'), pages: [0] },
      { ops: eb.ops<typeof compareOps>('compare'), pages: [0] },
      { ...DEFAULT_OPTIONS, mode: 'text' },
      inlineBackend
    )
    // turn one replacement into a deletion to exercise the strikeout
    const del = { ...result.changes[1], type: 'deleted' as const, new: { page: 0, rects: [[200, 110, 201, 124]] as [number, number, number, number][], anchor: true } }
    const bytes = await eb.ops<typeof compareOps>('compare').report({
      oldName: 'b.pdf',
      newName: 'a.pdf',
      oldPageCount: 1,
      newPageCount: 1,
      oldPages: [0],
      newPages: [0],
      options: result.options,
      date: 'today',
      changes: [result.changes[0], del],
      counts: { ...result.counts, replaced: 1, deleted: 1 },
      pageByPage: false,
      removedPdf: null,
      removedPages: []
    })
    const doc = new mupdf.PDFDocument(bytes)
    const strike = doc.loadPage(1).getAnnotations().find((a) => a.getType() === 'StrikeOut')!
    expect(strike.getContents()).toBe('Deleted “audit”')
    const q = strike.getQuadPoints()[0]
    expect(q[0]).toBeCloseTo(195.5, 0)
    expect(q[2]).toBeCloseTo(205.5, 0)
  })
})
