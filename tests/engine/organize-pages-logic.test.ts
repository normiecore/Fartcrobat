import { describe, expect, it } from 'vitest'
import {
  applyLabelSection,
  labelsFor,
  normalizeRanges,
  type LabelRange
} from '@features/organize-pages/labels'
import {
  cellAt,
  cellPosition,
  cellsInRect,
  filterPages,
  gapAt,
  gridMetrics,
  isNoopMove,
  movedIndices,
  moveOrder,
  navigate,
  nudgeTarget,
  spanIndices
} from '@features/organize-pages/order'
import { countLabel, describePages, formatPageRange, parsePageRange } from '@features/organize-pages/ranges'
import {
  largestFit,
  partFileNames,
  sanitizeFileName,
  splitByBookmarks,
  splitBySize,
  splitEvery,
  uniqueName
} from '@features/organize-pages/split'

describe('page ranges', () => {
  const ok = (s: string, n = 10, labels?: string[]) => {
    const r = parsePageRange(s, n, labels)
    if (!r.ok) throw new Error(r.error)
    return r.pages
  }
  it('parses numbers, spans, open spans and words', () => {
    expect(ok('1-3, 5')).toEqual([0, 1, 2, 4])
    expect(ok('3–1')).toEqual([0, 1, 2])
    expect(ok('8-')).toEqual([7, 8, 9])
    expect(ok('-2')).toEqual([0, 1])
    expect(ok('2 4 6')).toEqual([1, 3, 5])
    expect(ok('last')).toEqual([9])
    expect(ok('5 - last')).toEqual([4, 5, 6, 7, 8, 9])
    expect(ok('all', 3)).toEqual([0, 1, 2])
    expect(ok('even', 5)).toEqual([1, 3])
    expect(ok('odd', 5)).toEqual([0, 2, 4])
    expect(ok('2,2,1-2')).toEqual([0, 1])
  })
  it('accepts page labels', () => {
    const labels = ['i', 'ii', 'iii', '1', '2', 'A-1']
    expect(ok('ii', 6, labels)).toEqual([1])
    expect(ok('i-iii', 6, labels)).toEqual([0, 1, 2])
    expect(ok('A-1', 6, labels)).toEqual([5])
    // numbers are page positions, not labels
    expect(ok('1', 6, labels)).toEqual([0])
  })
  it('explains mistakes', () => {
    const err = (s: string, n = 5) => {
      const r = parsePageRange(s, n)
      return r.ok ? null : r.error
    }
    expect(err('')).toMatch(/Enter the pages/)
    expect(err('7')).toMatch(/Page 7 doesn't exist.*5 pages/)
    expect(err('0')).toMatch(/Page 0 doesn't exist/)
    expect(err('abc')).toMatch(/“abc” isn't a page number/)
    expect(err('1-2-3')).toMatch(/isn't a valid range/)
  })
  it('formats ranges', () => {
    expect(formatPageRange([0, 1, 2, 4, 6, 7])).toBe('1-3, 5, 7-8')
    expect(formatPageRange([3])).toBe('4')
    expect(formatPageRange([])).toBe('')
    expect(describePages([0, 1])).toBe('pages 1-2')
    expect(describePages([2])).toBe('page 3')
    expect(countLabel(1)).toBe('1 page')
    expect(countLabel(3)).toBe('3 pages')
  })
})

describe('split helpers', () => {
  it('splits by page count', () => {
    expect(splitEvery(5, 2)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
      { start: 4, end: 4 }
    ])
    expect(splitEvery(3, 10)).toEqual([{ start: 0, end: 2 }])
  })
  it('splits by top-level bookmarks', () => {
    expect(
      splitByBookmarks(10, [
        { title: 'Intro', page: 2 },
        { title: 'Body', page: 5 },
        { title: 'Same page', page: 5 },
        { title: 'No dest', page: null }
      ])
    ).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 4, title: 'Intro' },
      { start: 5, end: 9, title: 'Body' }
    ])
    expect(splitByBookmarks(4, [])).toEqual([{ start: 0, end: 3 }])
  })
  it('splits by size with few measurements', () => {
    const sizes = [100, 100, 500, 100, 100, 100, 100, 100]
    let calls = 0
    const sizeOf = (a: number, b: number) => {
      calls++
      let t = 50
      for (let i = a; i <= b; i++) t += sizes[i]
      return t
    }
    expect(largestFit(0, 7, 260, sizeOf)).toBe(1)
    expect(splitBySize(8, 400, sizeOf)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 2 },
      { start: 3, end: 5 },
      { start: 6, end: 7 }
    ])
    calls = 0
    splitBySize(1000, 1e9, () => 10)
    expect(calls).toBeLessThan(0 + 20)
  })
  it('names the output files', () => {
    const parts = [
      { start: 0, end: 0, title: 'Intro: part/one' },
      { start: 1, end: 1, title: 'Intro: part/one' },
      { start: 2, end: 2 }
    ]
    expect(partFileNames('Report', parts, { label: 'Part' })).toEqual([
      'Report Part 1.pdf',
      'Report Part 2.pdf',
      'Report Part 3.pdf'
    ])
    expect(partFileNames('Report', parts, { label: 'Part', useTitles: true })).toEqual([
      'Intro part one.pdf',
      'Intro part one (2).pdf',
      'Report Part 3.pdf'
    ])
    expect(partFileNames('Report', parts.slice(2), { label: '' })).toEqual(['Report 1.pdf'])
    expect(sanitizeFileName('  ..a<b>c?\u0001 ')).toBe('a b c')
  })
  it('finds a free file name', async () => {
    const taken = new Set(['a.pdf', 'a (2).pdf'])
    expect(await uniqueName('a.pdf', async (n) => taken.has(n))).toBe('a (3).pdf')
    expect(await uniqueName('b.pdf', async (n) => taken.has(n))).toBe('b.pdf')
  })
})

describe('page labels', () => {
  const D = (start: number, first = 1, prefix = ''): LabelRange => ({ start, style: 'D', prefix, first })
  it('starts a new section in the middle and keeps the following labels', () => {
    const r = applyLabelSection([], 0, 2, 8, { style: 'r', prefix: '', first: 1 })
    expect(labelsFor(r, 8)).toEqual(['i', 'ii', 'iii', '4', '5', '6', '7', '8'])
    const r2 = applyLabelSection(r, 3, 7, 8, { style: 'D', prefix: '', first: 1 })
    expect(labelsFor(r2, 8)).toEqual(['i', 'ii', 'iii', '1', '2', '3', '4', '5'])
    const r3 = applyLabelSection(r2, 5, 5, 8, { style: 'A', prefix: 'App-', first: 1 })
    expect(labelsFor(r3, 8)).toEqual(['i', 'ii', 'iii', '1', '2', 'App-A', '4', '5'])
  })
  it('extends the preceding section', () => {
    const r = applyLabelSection([{ start: 0, style: 'r', prefix: '', first: 1 }, D(3)], 3, 4, 6, 'extend')
    expect(labelsFor(r, 6)).toEqual(['i', 'ii', 'iii', 'iv', 'v', '3'])
  })
  it('drops redundant sections', () => {
    expect(normalizeRanges([D(0), D(3, 4)], 6)).toEqual([])
    expect(normalizeRanges([D(2, 3), D(9)], 5)).toEqual([])
    expect(normalizeRanges([D(0, 5)], 5)).toEqual([D(0, 5)])
  })
})

describe('page order', () => {
  it('moves pages like the core move op', () => {
    expect(moveOrder(5, [4], 0)).toEqual([4, 0, 1, 2, 3])
    expect(moveOrder(5, [0, 1], 4)).toEqual([2, 3, 0, 1, 4])
    expect(moveOrder(5, [0, 1], 5)).toEqual([2, 3, 4, 0, 1])
    expect(moveOrder(5, [1, 3], 0)).toEqual([1, 3, 0, 2, 4])
    expect(isNoopMove(5, [1, 2], 1)).toBe(true)
    expect(isNoopMove(5, [1, 2], 3)).toBe(true)
    expect(isNoopMove(5, [1, 2], 4)).toBe(false)
    expect(movedIndices(5, [4], 0)).toEqual([0])
    expect(movedIndices(5, [0, 1], 5)).toEqual([3, 4])
  })
  it('nudges the selection with the keyboard', () => {
    expect(nudgeTarget(5, [2], -1)).toBe(1)
    expect(nudgeTarget(5, [2], 1)).toBe(4)
    expect(nudgeTarget(5, [0], -1)).toBeNull()
    expect(nudgeTarget(5, [4], 1)).toBeNull()
    expect(nudgeTarget(5, [1, 2], 3)).toBe(5)
    expect(moveOrder(5, [2], nudgeTarget(5, [2], 1)!)).toEqual([0, 1, 3, 2, 4])
  })
  it('filters pages', () => {
    const pages = [
      { width: 612, height: 792 },
      { width: 792, height: 612 },
      { width: 612, height: 792 },
      { width: 842, height: 595 }
    ]
    expect(filterPages(pages, 'even')).toEqual([1, 3])
    expect(filterPages(pages, 'odd')).toEqual([0, 2])
    expect(filterPages(pages, 'portrait')).toEqual([0, 2])
    expect(filterPages(pages, 'landscape')).toEqual([1, 3])
    expect(filterPages(pages, 'all')).toEqual([0, 1, 2, 3])
    expect(spanIndices(4, 2)).toEqual([2, 3, 4])
  })
  it('navigates the grid with the keyboard', () => {
    expect(navigate(0, 'ArrowRight', 4, 10)).toBe(1)
    expect(navigate(0, 'ArrowLeft', 4, 10)).toBe(0)
    expect(navigate(1, 'ArrowDown', 4, 10)).toBe(5)
    expect(navigate(6, 'ArrowDown', 4, 10)).toBe(9)
    expect(navigate(5, 'ArrowDown', 4, 10)).toBe(9)
    expect(navigate(9, 'ArrowDown', 4, 10)).toBe(9)
    expect(navigate(5, 'ArrowUp', 4, 10)).toBe(1)
    expect(navigate(1, 'ArrowUp', 4, 10)).toBe(1)
    expect(navigate(5, 'Home', 4, 10)).toBe(0)
    expect(navigate(5, 'End', 4, 10)).toBe(9)
    expect(navigate(-1, 'ArrowDown', 4, 10)).toBe(0)
  })
  it('lays out the grid and hit-tests cells and gaps', () => {
    const m = gridMetrics(10, 800, 160)
    expect(m.columns).toBe(3)
    expect(m.rows).toBe(4)
    const c4 = cellPosition(m, 4)
    expect(cellAt(m, 10, c4.left + 5, c4.top + 5)).toBe(4)
    expect(cellAt(m, 10, c4.left - 5, c4.top + 5)).toBe(-1)
    // left half of a cell -> gap before it, right half -> gap after it
    expect(gapAt(m, 10, c4.left + 10, c4.top + 50).gap).toBe(4)
    expect(gapAt(m, 10, c4.left + m.cellWidth - 10, c4.top + 50).gap).toBe(5)
    // far right of the last (partial) row -> after the last page
    const c9 = cellPosition(m, 9)
    expect(gapAt(m, 10, c9.left + 500, c9.top + 10).gap).toBe(10)
    expect(gapAt(m, 10, 0, 99999).gap).toBe(9)
    const all = cellsInRect(m, 10, { left: 0, top: 0, right: 800, bottom: c4.top + 10 })
    expect(all).toEqual([0, 1, 2, 3, 4, 5])
  })
})
