import { describe, expect, it } from 'vitest'
import {
  ancestorsOf,
  computeMove,
  currentBookmarkId,
  flattenVisible,
  initiallyOpen,
  insertionPoint,
  isNoopMove,
  parentIds,
  titleFromText,
  visibleRowFor
} from '@features/navigation/outlineModel'
import type { Bookmark } from '@features/navigation/types'
import {
  customKeyError,
  describePages,
  dropIndexAt,
  formatBytes,
  formatPageList,
  formatPageSize,
  itemAt,
  mimeTypeFor,
  pagesFileSuffix,
  pdfVersionLabel,
  speechChunks,
  thumbLayout,
  tidyContext,
  visibleRange
} from '@features/navigation/util'

let nextId = 1
function bm(title: string, page: number | null, children: Bookmark[] = [], open = false): Bookmark {
  return {
    id: nextId++,
    title,
    dest: page === null ? null : { page, x: null, y: null, zoom: null, type: 'Fit' },
    uri: null,
    open,
    bold: false,
    italic: false,
    color: null,
    children
  }
}

function sample() {
  nextId = 1
  // 1 Part A (p0) [2 Intro (p1), 3 Body (p3)], 4 Part B (p5) [5 Methods (p6)], 6 Link (no dest)
  const intro = bm('Intro', 1)
  const body = bm('Body', 3)
  const partA = bm('Part A', 0, [intro, body], true)
  const methods = bm('Methods', 6)
  const partB = bm('Part B', 5, [methods])
  const link = bm('Link', null)
  return { tree: [partA, partB, link], partA, intro, body, partB, methods, link }
}

describe('navigation outline model', () => {
  it('flattens only expanded branches', () => {
    const { tree, partA, partB } = sample()
    expect(flattenVisible(tree, new Set()).map((r) => r.bookmark.title)).toEqual(['Part A', 'Part B', 'Link'])
    const rows = flattenVisible(tree, new Set([partA.id, partB.id]))
    expect(rows.map((r) => [r.bookmark.title, r.depth])).toEqual([
      ['Part A', 0],
      ['Intro', 1],
      ['Body', 1],
      ['Part B', 0],
      ['Methods', 1],
      ['Link', 0]
    ])
    expect(rows[1].parentId).toBe(partA.id)
    expect(rows[0].expanded).toBe(true)
    expect(rows[5].hasChildren).toBe(false)
    expect(initiallyOpen(tree)).toEqual([partA.id])
    expect(parentIds(tree)).toEqual([partA.id, partB.id])
  })

  it('finds the current section and the visible row to highlight', () => {
    const { tree, partA, intro, body, partB, methods } = sample()
    expect(currentBookmarkId(tree, 0)).toBe(partA.id)
    expect(currentBookmarkId(tree, 2)).toBe(intro.id)
    expect(currentBookmarkId(tree, 4)).toBe(body.id)
    expect(currentBookmarkId(tree, 5)).toBe(partB.id)
    expect(currentBookmarkId(tree, 99)).toBe(methods.id)
    // several bookmarks on one page: the reading position on the page decides
    const top = bm('Top', 2)
    const lower = { ...bm('Lower', 2), dest: { page: 2, x: null, y: 400, zoom: null, type: 'XYZ' } }
    expect(currentBookmarkId([top, lower], 2, 100)).toBe(top.id)
    expect(currentBookmarkId([top, lower], 2, 500)).toBe(lower.id)
    expect(currentBookmarkId([top, lower], 3)).toBe(lower.id)
    expect(currentBookmarkId([top, lower], 1)).toBeNull()
    expect(ancestorsOf(tree, methods.id)).toEqual([partB.id])
    expect(visibleRowFor(tree, methods.id, new Set())).toBe(partB.id)
    expect(visibleRowFor(tree, methods.id, new Set([partB.id]))).toBe(methods.id)
  })

  it('converts drops into moves and refuses moves into itself', () => {
    const { tree, partA, intro, body, partB, methods, link } = sample()
    const expanded = new Set([partA.id])
    expect(computeMove(tree, partA.id, intro.id, 'inside', expanded)).toBeNull()
    expect(computeMove(tree, partA.id, partA.id, 'before', expanded)).toBeNull()
    expect(computeMove(tree, link.id, intro.id, 'inside', expanded)).toEqual({ parentId: intro.id, index: -1 })
    expect(computeMove(tree, link.id, body.id, 'before', expanded)).toEqual({ parentId: partA.id, index: 1 })
    expect(computeMove(tree, intro.id, partB.id, 'after', expanded)).toEqual({ parentId: null, index: 2 })
    // the line under an expanded parent means "first child"
    expect(computeMove(tree, link.id, partA.id, 'after', expanded)).toEqual({ parentId: partA.id, index: 0 })
    // siblings are counted without the dragged bookmark
    expect(computeMove(tree, partA.id, link.id, 'before', expanded)).toEqual({ parentId: null, index: 1 })
    expect(computeMove(tree, methods.id, partA.id, 'before', expanded)).toEqual({ parentId: null, index: 0 })
    expect(isNoopMove(tree, body.id, { parentId: partA.id, index: 1 })).toBe(true)
    expect(isNoopMove(tree, body.id, { parentId: partA.id, index: -1 })).toBe(true)
    expect(isNoopMove(tree, body.id, { parentId: partA.id, index: 0 })).toBe(false)
    expect(isNoopMove(tree, body.id, { parentId: null, index: 0 })).toBe(false)
  })

  it('inserts new bookmarks in reading order at the selected level', () => {
    const { tree, partA, intro } = sample()
    expect(insertionPoint(tree, null, 0)).toEqual({ parentId: null, index: 1 })
    expect(insertionPoint(tree, null, 7)).toEqual({ parentId: null, index: 2 })
    expect(insertionPoint(tree, intro.id, 2)).toEqual({ parentId: partA.id, index: 1 })
    expect(insertionPoint(tree, intro.id, 0)).toEqual({ parentId: partA.id, index: 0 })
    expect(insertionPoint([], null, 3)).toEqual({ parentId: null, index: 0 })
    // same page: ordered by position on the page
    const a = bm('Top', 2)
    const b = { ...bm('Middle', 2), dest: { page: 2, x: null, y: 300, zoom: null, type: 'XYZ' } }
    const c = bm('Next page', 3)
    expect(insertionPoint([a, b, c], null, 2, 100)).toEqual({ parentId: null, index: 1 })
    expect(insertionPoint([a, b, c], null, 2, 400)).toEqual({ parentId: null, index: 2 })
  })

  it('makes bookmark titles from selected text', () => {
    expect(titleFromText('  The quick\n brown   fox ')).toBe('The quick brown fox')
    const long = 'word '.repeat(60)
    const t = titleFromText(long)
    expect(t.length).toBeLessThanOrEqual(121)
    expect(t.endsWith('…')).toBe(true)
  })
})

describe('navigation helpers', () => {
  it('formats sizes, pages and versions', () => {
    expect(formatBytes(29)).toBe('29 Bytes')
    expect(formatBytes(6788, true)).toBe('6.63 KB (6,788 Bytes)')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.00 MB')
    expect(formatBytes(null)).toBe('—')
    expect(formatPageSize(612, 792, 'in')).toBe('8.50 × 11.00 in')
    expect(formatPageSize(595.28, 841.89, 'mm')).toBe('210.0 × 297.0 mm')
    expect(describePages([2])).toBe('page 3')
    expect(describePages([3, 1, 2])).toBe('pages 2–4')
    expect(describePages([0, 2, 4])).toBe('pages 1, 3 and 5')
    expect(pagesFileSuffix([1, 2, 3])).toBe('pages 2-4')
    expect(pagesFileSuffix([0, 2])).toBe('pages 1, 3')
    expect(formatPageList([0, 1, 2, 4, 7, 8])).toBe('1–3, 5, 8–9')
    expect(pdfVersionLabel('1.7')).toBe('1.7 (Acrobat 8.x and later)')
    expect(customKeyError('Department')).toBeNull()
    expect(customKeyError('has space')).toMatch(/no spaces/)
    expect(customKeyError('Title')).toMatch(/standard property/)
    expect(mimeTypeFor('a.CSV')).toBe('text/csv')
    expect(mimeTypeFor('x.unknown')).toBe('application/octet-stream')
  })

  it('lays out thumbnails and finds drop positions', () => {
    const l = thumbLayout(
      [
        { width: 612, height: 792 },
        { width: 792, height: 612 },
        { width: 612, height: 792 }
      ],
      100
    )
    expect(l.imageHeights).toEqual([129, 77, 129])
    expect(l.tops[0]).toBe(6)
    expect(l.tops[1]).toBe(l.tops[0] + l.heights[0] + 6)
    expect(itemAt(l, 0)).toBe(0)
    expect(itemAt(l, l.tops[2] + 1)).toBe(2)
    expect(dropIndexAt(l, 0)).toBe(0)
    expect(dropIndexAt(l, l.tops[1] + 2)).toBe(1)
    expect(dropIndexAt(l, l.tops[1] + l.heights[1] - 2)).toBe(2)
    expect(dropIndexAt(l, l.total + 50)).toBe(3)
    expect(visibleRange(l, 0, 50, 0)).toEqual([0, 0])
    expect(visibleRange(thumbLayout([], 100), 0, 100)).toEqual([0, -1])
  })

  it('splits text into speakable chunks', () => {
    expect(speechChunks('')).toEqual([])
    expect(speechChunks('Hello world. How are you?')).toEqual(['Hello world. How are you?'])
    const text = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} is here.`).join(' ')
    const chunks = speechChunks(text, 80)
    expect(chunks.every((c) => c.length <= 80)).toBe(true)
    expect(chunks.join(' ')).toBe(text)
    const long = speechChunks('a'.repeat(50) + ' ' + 'b'.repeat(50) + ' ' + 'c'.repeat(50), 60)
    expect(long.every((c) => c.length <= 60)).toBe(true)
    expect(speechChunks('hyphen-\nated words')).toEqual(['hyphenated words'])
  })

  it('trims result context to whole words', () => {
    expect(tidyContext({ before: 'pter 1 Hello ', match: 'quick', after: ' brown fox jum' }, true, true)).toEqual({
      before: '1 Hello ',
      match: 'quick',
      after: ' brown fox'
    })
    expect(tidyContext({ before: 'Hello ', match: 'x', after: ' end' }, false, false)).toEqual({ before: 'Hello ', match: 'x', after: ' end' })
  })
})
