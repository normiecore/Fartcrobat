/** Page order and selection logic for the Organize Pages grid (pure, unit tested). */

export interface PageShape {
  width: number
  height: number
}

/**
 * The page order after moving `moving` pages to the gap `to` (0 = before the first page,
 * count = after the last). Same semantics as the core `pages.move` op. Returns old indices in
 * their new order.
 */
export function moveOrder(count: number, moving: number[], to: number): number[] {
  const set = new Set(moving.filter((i) => Number.isInteger(i) && i >= 0 && i < count))
  const sorted = [...set].sort((a, b) => a - b)
  const rest: number[] = []
  for (let i = 0; i < count; i++) if (!set.has(i)) rest.push(i)
  const before = rest.filter((i) => i < to).length
  return [...rest.slice(0, before), ...sorted, ...rest.slice(before)]
}

/** True when moving the pages to `to` would not change the order. */
export function isNoopMove(count: number, moving: number[], to: number): boolean {
  return moveOrder(count, moving, to).every((v, i) => v === i)
}

/** New indices of the moved pages after a move (for keeping them selected). */
export function movedIndices(count: number, moving: number[], to: number): number[] {
  const order = moveOrder(count, moving, to)
  const set = new Set(moving)
  const out: number[] = []
  order.forEach((old, i) => {
    if (set.has(old)) out.push(i)
  })
  return out
}

/**
 * Gap to move a selection to when nudging it with the keyboard (Alt+Arrow): `delta` pages forward
 * or back from the selection's edges. Returns null when it cannot move further.
 */
export function nudgeTarget(count: number, selected: number[], delta: number): number | null {
  if (!selected.length || delta === 0) return null
  const sorted = [...selected].sort((a, b) => a - b)
  if (delta < 0) {
    const first = sorted[0]
    if (first === 0) return null
    return Math.max(0, first + delta)
  }
  const last = sorted[sorted.length - 1]
  if (last >= count - 1) return null
  return Math.min(count, last + 1 + delta)
}

export type SelectFilter = 'all' | 'even' | 'odd' | 'portrait' | 'landscape'

/** Pages matching a quick-select filter. "Even" and "odd" use page numbers (1-based), like Acrobat. */
export function filterPages(pages: PageShape[], filter: SelectFilter): number[] {
  const out: number[] = []
  pages.forEach((p, i) => {
    const n = i + 1
    if (
      filter === 'all' ||
      (filter === 'even' && n % 2 === 0) ||
      (filter === 'odd' && n % 2 === 1) ||
      (filter === 'portrait' && p.height >= p.width) ||
      (filter === 'landscape' && p.width > p.height)
    )
      out.push(i)
  })
  return out
}

/** Indices from a to b inclusive (either order). */
export function spanIndices(a: number, b: number): number[] {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  return Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)
}

/** Keyboard navigation in a grid with `columns` columns. Returns the new focused index. */
export function navigate(index: number, key: string, columns: number, count: number, pageRows = 3): number {
  if (count <= 0) return -1
  const cols = Math.max(1, columns)
  let next = index < 0 ? 0 : index
  switch (key) {
    case 'ArrowLeft':
      next = index - 1
      break
    case 'ArrowRight':
      next = index + 1
      break
    case 'ArrowUp':
      next = index - cols
      break
    case 'ArrowDown':
      next = index + cols
      break
    case 'Home':
      next = 0
      break
    case 'End':
      next = count - 1
      break
    case 'PageUp':
      next = index - cols * pageRows
      break
    case 'PageDown':
      next = index + cols * pageRows
      break
  }
  if (index < 0) return key === 'End' ? count - 1 : 0
  if ((key === 'ArrowUp' || key === 'PageUp') && next < 0) next = index % cols
  if ((key === 'ArrowDown' || key === 'PageDown') && next > count - 1) {
    // Stay in the same column on the last row when possible.
    const lastRowStart = Math.floor((count - 1) / cols) * cols
    const col = index % cols
    next = Math.min(count - 1, lastRowStart + col)
    if (next <= index) next = index
  }
  return Math.max(0, Math.min(count - 1, next))
}

/**
 * Shape of the box every thumbnail sits in, as fractions of the thumbnail size (the larger is 1).
 * A document of portrait pages gets narrow boxes, so "Fit width" really fills the width with the
 * page; mixed portrait and landscape pages get square boxes.
 */
export interface BoxAspect {
  w: number
  h: number
}

export const SQUARE: BoxAspect = { w: 1, h: 1 }

/** The box shape that fits every page of the document. */
export function boxAspect(pages: PageShape[]): BoxAspect {
  let w = 0
  let h = 0
  for (const p of pages) {
    const pw = Math.max(1, p.width)
    const ph = Math.max(1, p.height)
    const long = Math.max(pw, ph)
    w = Math.max(w, pw / long)
    h = Math.max(h, ph / long)
  }
  if (!w || !h) return SQUARE
  // Nearly square differences are not worth a different layout; keep the values stable.
  return { w: Math.min(1, Math.round(w * 1000) / 1000), h: Math.min(1, Math.round(h * 1000) / 1000) }
}

/** Space around and between thumbnails (CSS pixels). */
export const GRID = {
  gapX: 28,
  gapY: 20,
  padX: 24,
  padY: 20,
  /** A cell is this much wider than its page box (selection border and padding). */
  cellExtraW: 24,
  /** ...and this much taller (padding and the page number underneath). */
  cellExtraH: 44
}

/** Grid layout of the thumbnail view. All values in CSS pixels. */
export interface GridMetrics {
  /** Size of the box the page image is fitted into. */
  boxWidth: number
  boxHeight: number
  columns: number
  cellWidth: number
  cellHeight: number
  gapX: number
  gapY: number
  padX: number
  padY: number
  offsetX: number
  rows: number
  contentHeight: number
}

export function gridMetrics(
  count: number,
  viewportWidth: number,
  thumb: number,
  aspect: BoxAspect = SQUARE
): GridMetrics {
  const boxWidth = Math.max(8, Math.round(thumb * aspect.w))
  const boxHeight = Math.max(8, Math.round(thumb * aspect.h))
  const { gapX, gapY, padX, padY } = GRID
  const cellWidth = boxWidth + GRID.cellExtraW
  const cellHeight = boxHeight + GRID.cellExtraH
  const usable = Math.max(cellWidth, viewportWidth - padX * 2)
  const columns = Math.max(1, Math.floor((usable + gapX) / (cellWidth + gapX)))
  const rowWidth = columns * cellWidth + (columns - 1) * gapX
  const offsetX = Math.max(padX, Math.floor((viewportWidth - rowWidth) / 2))
  const rows = Math.ceil(count / columns)
  const contentHeight = padY * 2 + rows * cellHeight + Math.max(0, rows - 1) * gapY + 40
  return {
    boxWidth,
    boxHeight,
    columns,
    cellWidth,
    cellHeight,
    gapX,
    gapY,
    padX,
    padY,
    offsetX,
    rows,
    contentHeight
  }
}

export function cellPosition(m: GridMetrics, index: number): { left: number; top: number } {
  const row = Math.floor(index / m.columns)
  const col = index % m.columns
  return { left: m.offsetX + col * (m.cellWidth + m.gapX), top: m.padY + row * (m.cellHeight + m.gapY) }
}

/**
 * Where an insertion gap is drawn. In a grid it is a vertical line before a cell (`left`, `top`);
 * with one column (`horizontal`) it is a line across the space between two rows, at `top`.
 */
export interface GapSpot {
  gap: number
  left: number
  top: number
  horizontal?: boolean
}

/** Nearest insertion gap (0..count) for a point in content coordinates, with where to draw it. */
export function gapAt(m: GridMetrics, count: number, x: number, y: number): GapSpot {
  if (count === 0) return { gap: 0, left: m.offsetX, top: m.padY }
  const rowH = m.cellHeight + m.gapY
  if (m.columns === 1) {
    // One page per row: the nearest space between two pages, going by the height only.
    const gap = Math.max(0, Math.min(count, Math.round((y - m.padY + m.gapY / 2) / rowH)))
    return { gap, left: m.offsetX, top: rowGapTop(m, gap), horizontal: true }
  }
  const row = Math.max(0, Math.min(m.rows - 1, Math.floor((y - m.padY + m.gapY / 2) / rowH)))
  // Gap c of a row sits between cells c-1 and c; pick the nearest one.
  const inRow = Math.min(m.columns, count - row * m.columns)
  const col = Math.max(0, Math.min(inRow, Math.round((x - m.offsetX + m.gapX / 2) / (m.cellWidth + m.gapX))))
  return {
    gap: row * m.columns + col,
    left: m.offsetX + col * (m.cellWidth + m.gapX) - m.gapX / 2,
    top: m.padY + row * rowH
  }
}

/** Middle of the space above row `row` (one-column layout), in content coordinates. */
export function rowGapTop(m: GridMetrics, row: number): number {
  return m.padY + row * (m.cellHeight + m.gapY) - m.gapY / 2
}

/** Index of the cell under a point in content coordinates, or -1. */
export function cellAt(m: GridMetrics, count: number, x: number, y: number): number {
  const rowH = m.cellHeight + m.gapY
  const colW = m.cellWidth + m.gapX
  const row = Math.floor((y - m.padY) / rowH)
  const col = Math.floor((x - m.offsetX) / colW)
  if (row < 0 || col < 0 || col >= m.columns) return -1
  if (y - m.padY - row * rowH > m.cellHeight) return -1
  if (x - m.offsetX - col * colW > m.cellWidth) return -1
  const i = row * m.columns + col
  return i < count ? i : -1
}

/** Cells intersecting a rectangle (content coordinates) — for rubber-band selection. */
export function cellsInRect(
  m: GridMetrics,
  count: number,
  r: { left: number; top: number; right: number; bottom: number }
): number[] {
  const out: number[] = []
  const rowH = m.cellHeight + m.gapY
  const firstRow = Math.max(0, Math.floor((r.top - m.padY) / rowH))
  const lastRow = Math.min(m.rows - 1, Math.floor((r.bottom - m.padY) / rowH))
  for (let row = firstRow; row <= lastRow; row++) {
    for (let col = 0; col < m.columns; col++) {
      const i = row * m.columns + col
      if (i >= count) break
      const p = cellPosition(m, i)
      if (
        p.left < r.right &&
        p.left + m.cellWidth > r.left &&
        p.top < r.bottom &&
        p.top + m.cellHeight > r.top
      )
        out.push(i)
    }
  }
  return out
}

/** Position (content coordinates) of the indicator for a gap, drawn before the cell at `gap`. */
export function gapPosition(m: GridMetrics, count: number, gap: number): { left: number; top: number } {
  if (count === 0) return { left: m.offsetX - m.gapX / 2, top: m.padY }
  if (gap >= count) {
    const p = cellPosition(m, count - 1)
    return { left: p.left + m.cellWidth + m.gapX / 2, top: p.top }
  }
  const p = cellPosition(m, gap)
  return { left: p.left - m.gapX / 2, top: p.top }
}
