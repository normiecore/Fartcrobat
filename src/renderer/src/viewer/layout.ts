import { CSS_PX_PER_POINT } from '@shared/geometry'
import type { PageInfo, PageLayoutMode, ZoomMode } from '@shared/types'

export const PAGE_GAP = 12
export const VIEW_PADDING = 20

export interface PageSlot {
  index: number
  x: number
  y: number
  width: number
  height: number
}

export interface ViewLayout {
  slots: PageSlot[]
  width: number
  height: number
  /** Pages that are laid out (all pages in continuous modes, the current spread otherwise). */
  visibleIndices: number[]
}

function pageCssSize(p: PageInfo, zoom: number, rotation: number) {
  const s = zoom * CSS_PX_PER_POINT
  const swap = rotation === 90 || rotation === 270
  return { w: (swap ? p.height : p.width) * s, h: (swap ? p.width : p.height) * s }
}

/** Groups page indices into rows: single pages or two-page spreads. */
export function spreads(count: number, mode: PageLayoutMode, cover: boolean): number[][] {
  const rows: number[][] = []
  const two = mode === 'two-page' || mode === 'two-page-continuous'
  let i = 0
  if (two && cover && count > 0) {
    rows.push([0])
    i = 1
  }
  while (i < count) {
    if (two && i + 1 < count) {
      rows.push([i, i + 1])
      i += 2
    } else {
      rows.push([i])
      i += 1
    }
  }
  return rows
}

export function spreadIndexOf(rows: number[][], page: number): number {
  return Math.max(
    0,
    rows.findIndex((r) => r.includes(page))
  )
}

const isTwoUp = (mode: PageLayoutMode) => mode === 'two-page' || mode === 'two-page-continuous'
const isContinuous = (mode: PageLayoutMode) => mode === 'continuous' || mode === 'two-page-continuous'

/** A lone cover page sits on the right half of a spread, like Acrobat. */
function isRightHalfCover(row: number[], pageCount: number, mode: PageLayoutMode, cover: boolean): boolean {
  return isTwoUp(mode) && cover && row.length === 1 && row[0] === 0 && pageCount > 1
}

/**
 * Width and height a row needs, given the CSS size of each page. In two-page layouts a lone page
 * (the cover, or the last page of an odd count) is half a spread, so fit zooms stay the same from
 * spread to spread and the right-half cover never overflows.
 */
function rowExtent(row: number[], sizes: { w: number; h: number }[], pageCount: number, mode: PageLayoutMode): { w: number; h: number } {
  const h = Math.max(...row.map((i) => sizes[i].h))
  if (isTwoUp(mode) && row.length === 1 && pageCount > 1) return { w: 2 * sizes[row[0]].w + PAGE_GAP, h }
  return { w: row.reduce((acc, i) => acc + sizes[i].w, 0) + PAGE_GAP * (row.length - 1), h }
}

export function computeLayout(
  pages: PageInfo[],
  opts: {
    zoom: number
    rotation: number
    mode: PageLayoutMode
    cover: boolean
    containerWidth: number
    currentPage: number
  }
): ViewLayout {
  const rows = spreads(pages.length, opts.mode, opts.cover)
  const shownRows = isContinuous(opts.mode) ? rows : [rows[spreadIndexOf(rows, opts.currentPage)] ?? []]
  const sizes = pages.map((p) => pageCssSize(p, opts.zoom, opts.rotation))
  let maxRowWidth = 0
  for (const row of shownRows) {
    if (!row.length) continue
    const w = isRightHalfCover(row, pages.length, opts.mode, opts.cover)
      ? rowExtent(row, sizes, pages.length, opts.mode).w
      : row.reduce((acc, i) => acc + sizes[i].w, 0) + PAGE_GAP * (row.length - 1)
    maxRowWidth = Math.max(maxRowWidth, w)
  }
  const width = Math.max(opts.containerWidth, maxRowWidth + VIEW_PADDING * 2)
  const slots: PageSlot[] = []
  let y = VIEW_PADDING
  for (const row of shownRows) {
    if (!row.length) continue
    const rowH = Math.max(...row.map((i) => sizes[i].h))
    const rowW = row.reduce((acc, i) => acc + sizes[i].w, 0) + PAGE_GAP * (row.length - 1)
    let x = (width - rowW) / 2
    if (isRightHalfCover(row, pages.length, opts.mode, opts.cover)) x = width / 2 + PAGE_GAP / 2
    for (const i of row) {
      slots[i] = { index: i, x, y: y + (rowH - sizes[i].h) / 2, width: sizes[i].w, height: sizes[i].h }
      x += sizes[i].w + PAGE_GAP
    }
    y += rowH + PAGE_GAP
  }
  const visibleIndices = shownRows.flat()
  return { slots, width, height: y - PAGE_GAP + VIEW_PADDING, visibleIndices }
}

/**
 * Zoom factor for a fit mode, given the viewport size. Single Page and Two Page View fit the shown
 * page or spread. Scrolling layouts fit the whole document (the widest row for Fit Width, every row
 * for Fit Page), so the zoom never depends on the scroll position: with mixed page sizes, a zoom
 * that followed the current page would move another page into view, which would change the zoom
 * again.
 */
export function fitZoom(
  mode: ZoomMode,
  pages: PageInfo[],
  opts: { currentPage: number; rotation: number; layout: PageLayoutMode; cover: boolean; width: number; height: number }
): number | null {
  if (mode === 'custom') return null
  if (mode === 'actual-size') return 1
  if (!pages.length) return 1
  const rows = spreads(pages.length, opts.layout, opts.cover)
  const fitRows = isContinuous(opts.layout) ? rows : [rows[spreadIndexOf(rows, opts.currentPage)] ?? [0]]
  const sizes: { w: number; h: number }[] = []
  for (const row of fitRows) for (const i of row) sizes[i] = pageCssSize(pages[i], 1, opts.rotation)
  const availW = Math.max(100, opts.width - VIEW_PADDING * 2 - 16)
  const availH = Math.max(100, opts.height - VIEW_PADDING * 2)
  let zw = Infinity
  let zp = Infinity
  for (const row of fitRows) {
    const { w, h } = rowExtent(row, sizes, pages.length, opts.layout)
    zw = Math.min(zw, availW / w)
    zp = Math.min(zp, availW / w, availH / h)
  }
  if (mode === 'fit-width' || mode === 'fit-visible') return clampZoom(zw)
  return clampZoom(zp)
}

export const MIN_ZOOM = 0.08
export const MAX_ZOOM = 64

export function clampZoom(z: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
}

export const ZOOM_STEPS = [
  0.0833, 0.125, 0.25, 0.3333, 0.5, 0.6667, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 64
]

export function nextZoomStep(z: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((s) => s > z * 1.01) ?? MAX_ZOOM
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z * 0.99) return ZOOM_STEPS[i]
  return MIN_ZOOM
}
