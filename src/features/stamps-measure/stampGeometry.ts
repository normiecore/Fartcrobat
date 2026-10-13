/**
 * Where a stamp goes when you click or drag with the Stamp tool. Pure page-space geometry (points,
 * y down), shared by the Stamp tool layer and the contextual toolbar.
 */
import type { Point, Rect } from '@shared/geometry'
import type { StampDef } from './stampCatalog'

/** Default rectangle for a click: the stamp's default size centred on the point, kept on the page. */
export function clickRect(def: StampDef, p: Point, pageW: number, pageH: number): Rect {
  let w = def.width
  let h = w / def.aspect
  const fit = Math.min(1, (pageW * 0.9) / w, (pageH * 0.9) / h)
  w *= fit
  h *= fit
  let x = p[0] - w / 2
  let y = p[1] - h / 2
  x = Math.max(0, Math.min(pageW - w, x))
  y = Math.max(0, Math.min(pageH - h, y))
  return [x, y, x + w, y + h]
}

/** Smallest width a drag gives a stamp, in points (smaller would be unreadable and hard to grab). */
const MIN_DRAG_WIDTH = 12

/** Rectangle for a drag from a to b keeping the stamp's proportions (anchored at a). */
export function dragRect(def: StampDef, a: Point, b: Point, pageW: number, pageH: number): Rect {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const w0 = Math.max(Math.abs(dx), Math.abs(dy) * def.aspect)
  // keep it on the page
  const maxW = dx >= 0 ? pageW - a[0] : a[0]
  const maxH = dy >= 0 ? pageH - a[1] : a[1]
  const limit = Math.min(maxW, maxH * def.aspect)
  const w = Math.max(Math.min(MIN_DRAG_WIDTH, limit), Math.min(w0, limit), 1)
  const h = w / def.aspect
  const x0 = dx >= 0 ? a[0] : a[0] - w
  const y0 = dy >= 0 ? a[1] : a[1] - h
  return [x0, y0, x0 + w, y0 + h]
}
