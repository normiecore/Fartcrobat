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
  const continuous = opts.mode === 'continuous' || opts.mode === 'two-page-continuous'
  const shownRows = continuous ? rows : [rows[spreadIndexOf(rows, opts.currentPage)] ?? []]
  const sizes = pages.map((p) => pageCssSize(p, opts.zoom, opts.rotation))
  let maxRowWidth = 0
  for (const row of shownRows) {
    const w = row.reduce((acc, i) => acc + sizes[i].w, 0) + PAGE_GAP * (row.length - 1)
    maxRowWidth = Math.max(maxRowWidth, w)
  }
  const width = Math.max(opts.containerWidth, maxRowWidth + VIEW_PADDING * 2)
  const slots: PageSlot[] = []
  let y = VIEW_PADDING
  const two = opts.mode === 'two-page' || opts.mode === 'two-page-continuous'
  for (const row of shownRows) {
    const rowH = Math.max(...row.map((i) => sizes[i].h))
    const rowW = row.reduce((acc, i) => acc + sizes[i].w, 0) + PAGE_GAP * (row.length - 1)
    let x = (width - rowW) / 2
    // A lone cover page sits on the right half of a spread, like Acrobat.
    if (two && row.length === 1 && opts.cover && row[0] === 0 && pages.length > 1) {
      x = width / 2 + PAGE_GAP / 2
    }
    for (const i of row) {
      slots[i] = { index: i, x, y: y + (rowH - sizes[i].h) / 2, width: sizes[i].w, height: sizes[i].h }
      x += sizes[i].w + PAGE_GAP
    }
    y += rowH + PAGE_GAP
  }
  const visibleIndices = shownRows.flat()
  return { slots, width, height: y - PAGE_GAP + VIEW_PADDING, visibleIndices }
}

/** Zoom factor for a fit mode, given the viewport size. */
export function fitZoom(
  mode: ZoomMode,
  pages: PageInfo[],
  opts: { currentPage: number; rotation: number; layout: PageLayoutMode; cover: boolean; width: number; height: number }
): number | null {
  if (mode === 'custom') return null
  if (mode === 'actual-size') return 1
  if (!pages.length) return 1
  const rows = spreads(pages.length, opts.layout, opts.cover)
  const row = rows[spreadIndexOf(rows, opts.currentPage)] ?? [0]
  const at100 = row.map((i) => pageCssSize(pages[i], 1, opts.rotation))
  const rowW = at100.reduce((a, s) => a + s.w, 0) + PAGE_GAP * (row.length - 1)
  const rowH = Math.max(...at100.map((s) => s.h))
  const availW = Math.max(100, opts.width - VIEW_PADDING * 2 - 16)
  const availH = Math.max(100, opts.height - VIEW_PADDING * 2)
  const zw = availW / rowW
  if (mode === 'fit-width' || mode === 'fit-visible') return clampZoom(zw)
  return clampZoom(Math.min(zw, availH / rowH))
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
