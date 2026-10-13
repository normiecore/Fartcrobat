import { CSS_PX_PER_POINT } from '@shared/geometry'
import { PageGeometry, type DocumentModel } from '@renderer/sdk'
import type { AlignRow } from './types'

export const PAD = 24
export const COL_GAP = 32
export const ROW_GAP = 22
export const LABEL_H = 24
export const HEAD_H = 34
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

export interface PageSlot {
  page: number
  x: number
  y: number
  geometry: PageGeometry
}

export interface RowLayout {
  row: AlignRow
  index: number
  /** Top of the row (page labels start here). */
  y: number
  height: number
  old: PageSlot | null
  new: PageSlot | null
  /** Where an empty side's placeholder goes. */
  placeholder: { side: 'old' | 'new'; x: number; y: number; width: number; height: number } | null
}

export interface ViewLayout {
  zoom: number
  width: number
  height: number
  colOld: { x: number; width: number }
  colNew: { x: number; width: number }
  rows: RowLayout[]
}

function size(doc: DocumentModel, page: number) {
  const p = doc.state.info.pages[page]
  return { w: p?.width ?? 612, h: p?.height ?? 792 }
}

export function clampZoom(z: number) {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
}

/** Zoom that fits the widest row into the viewport. */
export function fitWidthZoom(rows: AlignRow[], oldDoc: DocumentModel, newDoc: DocumentModel, viewportWidth: number, overlay: boolean) {
  let maxOld = 0
  let maxNew = 0
  for (const r of rows) {
    if (r.old !== null) maxOld = Math.max(maxOld, size(oldDoc, r.old).w)
    if (r.new !== null) maxNew = Math.max(maxNew, size(newDoc, r.new).w)
  }
  maxOld ||= maxNew || 612
  maxNew ||= maxOld
  const avail = Math.max(120, viewportWidth - 2 * PAD - 14)
  const z = overlay ? avail / (Math.max(maxOld, maxNew) * CSS_PX_PER_POINT) : (avail - COL_GAP) / ((maxOld + maxNew) * CSS_PX_PER_POINT)
  return clampZoom(Math.min(z, 2.5))
}

/**
 * Lays out the rows of the results view: in side-by-side mode the old page on the left and the
 * new page on the right, row by row, so both sides scroll together; in overlay mode one column
 * with both pages drawn at the same width.
 */
export function computeLayout(
  rows: AlignRow[],
  oldDoc: DocumentModel,
  newDoc: DocumentModel,
  zoom: number,
  viewportWidth: number,
  overlay: boolean
): ViewLayout {
  const s = zoom * CSS_PX_PER_POINT
  let maxOld = 0
  let maxNew = 0
  for (const r of rows) {
    if (r.old !== null) maxOld = Math.max(maxOld, size(oldDoc, r.old).w)
    if (r.new !== null) maxNew = Math.max(maxNew, size(newDoc, r.new).w)
  }
  maxOld ||= maxNew || 612
  maxNew ||= maxOld
  const out: RowLayout[] = []
  let y = HEAD_H + 12
  if (overlay) {
    const colW = Math.max(maxOld, maxNew) * s
    const width = Math.max(viewportWidth, colW + 2 * PAD)
    const x0 = (width - colW) / 2
    rows.forEach((row, index) => {
      const geo = (doc: DocumentModel, page: number) => {
        const { w, h } = size(doc, page)
        // both pages drawn at the column width
        return new PageGeometry(page, w, h, colW / (w * CSS_PX_PER_POINT))
      }
      const og = row.old !== null ? geo(oldDoc, row.old) : null
      const ng = row.new !== null ? geo(newDoc, row.new) : null
      const h = Math.max(og?.cssHeight ?? 0, ng?.cssHeight ?? 0)
      out.push({
        row,
        index,
        y,
        height: LABEL_H + h,
        old: og ? { page: row.old!, x: x0, y: y + LABEL_H, geometry: og } : null,
        new: ng ? { page: row.new!, x: x0, y: y + LABEL_H, geometry: ng } : null,
        placeholder: null
      })
      y += LABEL_H + h + ROW_GAP
    })
    return { zoom, width, height: y + PAD, colOld: { x: x0, width: colW }, colNew: { x: x0, width: colW }, rows: out }
  }
  const colOldW = maxOld * s
  const colNewW = maxNew * s
  const width = Math.max(viewportWidth, colOldW + COL_GAP + colNewW + 2 * PAD)
  const xOld = (width - (colOldW + COL_GAP + colNewW)) / 2
  const xNew = xOld + colOldW + COL_GAP
  rows.forEach((row, index) => {
    const og = row.old !== null ? new PageGeometry(row.old, size(oldDoc, row.old).w, size(oldDoc, row.old).h, zoom) : null
    const ng = row.new !== null ? new PageGeometry(row.new, size(newDoc, row.new).w, size(newDoc, row.new).h, zoom) : null
    const h = Math.max(og?.cssHeight ?? 0, ng?.cssHeight ?? 0)
    const top = y + LABEL_H
    let placeholder: RowLayout['placeholder'] = null
    if (!og && ng) placeholder = { side: 'old', x: xOld + (colOldW - ng.cssWidth) / 2, y: top, width: Math.min(ng.cssWidth, colOldW), height: ng.cssHeight }
    if (og && !ng) placeholder = { side: 'new', x: xNew + (colNewW - og.cssWidth) / 2, y: top, width: Math.min(og.cssWidth, colNewW), height: og.cssHeight }
    if (placeholder) {
      const col = placeholder.side === 'old' ? { x: xOld, w: colOldW } : { x: xNew, w: colNewW }
      placeholder.x = col.x + (col.w - placeholder.width) / 2
    }
    out.push({
      row,
      index,
      y,
      height: LABEL_H + h,
      old: og ? { page: row.old!, x: xOld + (colOldW - og.cssWidth) / 2, y: top, geometry: og } : null,
      new: ng ? { page: row.new!, x: xNew + (colNewW - ng.cssWidth) / 2, y: top, geometry: ng } : null,
      placeholder
    })
    y += LABEL_H + h + ROW_GAP
  })
  return { zoom, width, height: y + PAD, colOld: { x: xOld, width: colOldW }, colNew: { x: xNew, width: colNewW }, rows: out }
}

/** Rows that intersect [top, bottom] (binary search; rows are sorted by y). */
export function visibleRows(layout: ViewLayout, top: number, bottom: number): RowLayout[] {
  const rows = layout.rows
  let lo = 0
  let hi = rows.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (rows[mid].y + rows[mid].height < top) lo = mid + 1
    else hi = mid
  }
  const out: RowLayout[] = []
  for (let i = lo; i < rows.length && rows[i].y <= bottom; i++) out.push(rows[i])
  return out
}
