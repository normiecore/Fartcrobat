/**
 * Imposition: how document pages are placed on printed sheets (Acrobat's "Page Sizing & Handling":
 * Size, Poster, Multiple and Booklet, plus orientation). Pure functions, all measurements in points
 * (1/72 inch) with the origin at the top-left of the sheet.
 */

export type PaperName = 'Letter' | 'Legal' | 'Tabloid' | 'A5' | 'A4' | 'A3'

/** Paper sizes in points, portrait. Names match Electron's `pageSize` values. */
export const PAPERS: Record<PaperName, { label: string; width: number; height: number }> = {
  Letter: { label: 'Letter', width: 612, height: 792 },
  Legal: { label: 'Legal', width: 612, height: 1008 },
  Tabloid: { label: 'Tabloid', width: 792, height: 1224 },
  A5: { label: 'A5', width: 419.53, height: 595.28 },
  A4: { label: 'A4', width: 595.28, height: 841.89 },
  A3: { label: 'A3', width: 841.89, height: 1190.55 }
}

export const PAPER_NAMES = Object.keys(PAPERS) as PaperName[]

/** Countries that use US Letter paper by default (everyone else uses A4). */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR', 'GT', 'DO', 'PA', 'PR', 'SV', 'NI', 'HN', 'BZ'])

/** Default paper for a BCP 47 locale such as "en-US" or "de-DE". */
export function defaultPaperForLocale(locale: string | undefined | null): PaperName {
  if (!locale) return 'Letter'
  const parts = locale.replace(/_/g, '-').split('-')
  const region = parts.slice(1).find((p) => /^[A-Za-z]{2}$/.test(p))?.toUpperCase()
  if (region) return LETTER_REGIONS.has(region) ? 'Letter' : 'A4'
  // No region: English speakers most often mean the US; other languages default to A4.
  return parts[0].toLowerCase() === 'en' ? 'Letter' : 'A4'
}

export type LayoutMode = 'size' | 'poster' | 'multiple' | 'booklet'
export type SizingMode = 'fit' | 'actual' | 'shrink' | 'custom'
export type Orientation = 'auto' | 'portrait' | 'landscape'
export type PageOrder = 'horizontal' | 'horizontal-reversed' | 'vertical' | 'vertical-reversed'
export type BookletBinding = 'left' | 'right'
export type BookletSubset = 'both' | 'front' | 'back'
export type Rotation = 0 | 90 | 180 | 270

export interface PageBox {
  width: number
  height: number
}

/** One document page drawn on a sheet. */
export interface Placement {
  /** 0-based page index. */
  page: number
  /** Box the page occupies on the sheet (after rotation), in points. */
  x: number
  y: number
  width: number
  height: number
  /** Clockwise rotation applied to the page inside its box. */
  rotate: Rotation
  /** Printed size / page size. */
  scale: number
  /** Only this part of the sheet shows the page (posters). [x0, y0, x1, y1] */
  clip?: [number, number, number, number]
}

/** One printed side of paper. */
export interface Sheet {
  /** Sheet size in points as shown in the preview (landscape sheets are wider than tall). */
  width: number
  height: number
  placements: Placement[]
  /** Draw a thin border around every page (Multiple > Print page border). */
  border: boolean
  /** Booklets: which side of the folded sheet this is, and which sheet (1-based). */
  side?: 'front' | 'back'
  sheetNumber?: number
  /** Posters: trim box to mark with cut marks. */
  cutMarks?: [number, number, number, number]
  /** Posters: text printed in the top margin. */
  label?: string
}

export interface ImpositionOptions {
  mode: LayoutMode
  /** Portrait paper size in points. */
  paper: PageBox
  orientation: Orientation
  // Size
  sizing: SizingMode
  /** Custom scale in percent. */
  customScale: number
  // Multiple
  /** Pages per sheet (2, 4, 6, 9, 16) or columns × rows when `grid` is set. */
  perSheet: number
  grid?: { cols: number; rows: number } | null
  pageOrder: PageOrder
  pageBorder: boolean
  /** Rotate pages inside their cell when that makes them larger. */
  autoRotate: boolean
  // Booklet
  binding: BookletBinding
  bookletSubset: BookletSubset
  /** 1-based first sheet to print. */
  sheetFrom: number
  /** 1-based last sheet to print; 0 means the last sheet. */
  sheetTo: number
  // Poster
  /** Tile scale in percent. */
  tileScale: number
  /** Overlap between tiles in points. */
  overlap: number
  cutMarks: boolean
  labels: boolean
  tileLargeOnly: boolean
  /** Print the last sheet first. */
  reverse: boolean
}

/** Unprintable border most printers need; "Fit" keeps pages inside it. */
export const PRINT_MARGIN = 12
/** Posters leave room for labels and cut marks. */
export const POSTER_MARGIN = 18
/** Space between pages on a "Multiple" sheet. */
export const CELL_GAP = 6

const EPS = 1e-6

export function orientPaper(paper: PageBox, orientation: 'portrait' | 'landscape'): PageBox {
  const short = Math.min(paper.width, paper.height)
  const long = Math.max(paper.width, paper.height)
  return orientation === 'portrait' ? { width: short, height: long } : { width: long, height: short }
}

export function isLandscape(box: PageBox): boolean {
  return box.width > box.height + EPS
}

/** Largest scale at which a w×h box fits inside aw×ah. */
export function fitScale(w: number, h: number, aw: number, ah: number): number {
  if (w <= 0 || h <= 0) return 1
  return Math.max(0, Math.min(aw / w, ah / h))
}

/** Scale used by Page Sizing "Size" for a page on a printable area. */
export function sizingScale(page: PageBox, aw: number, ah: number, sizing: SizingMode, customScale: number): number {
  const fit = fitScale(page.width, page.height, aw, ah)
  switch (sizing) {
    case 'fit':
      return fit
    case 'shrink':
      return Math.min(1, fit)
    case 'actual':
      return 1
    case 'custom':
      return Math.max(0.01, (Number.isFinite(customScale) ? customScale : 100) / 100)
  }
}

function rotatedSize(page: PageBox, rotate: Rotation): PageBox {
  return rotate === 90 || rotate === 270 ? { width: page.height, height: page.width } : page
}

/** Places a page at `scale` inside a box; `align` positions it horizontally inside the box. */
function placeInBox(
  page: number,
  size: PageBox,
  box: { x: number; y: number; width: number; height: number },
  scale: number,
  rotate: Rotation,
  align: 'center' | 'start' | 'end' = 'center'
): Placement {
  const r = rotatedSize(size, rotate)
  const w = r.width * scale
  const h = r.height * scale
  const free = box.width - w
  const dx = align === 'start' ? 0 : align === 'end' ? free : free / 2
  return { page, x: box.x + dx, y: box.y + (box.height - h) / 2, width: w, height: h, rotate, scale }
}

// ---- Size ---------------------------------------------------------------------------------

function layoutSize(pages: number[], sizes: PageBox[], o: ImpositionOptions): Sheet[] {
  return pages.map((p) => {
    const size = sizes[p]
    const orient = o.orientation === 'auto' ? (isLandscape(size) ? 'landscape' : 'portrait') : o.orientation
    const sheet = orientPaper(o.paper, orient)
    const m = PRINT_MARGIN
    const scale = sizingScale(size, sheet.width - 2 * m, sheet.height - 2 * m, o.sizing, o.customScale)
    const placement = placeInBox(p, size, { x: 0, y: 0, width: sheet.width, height: sheet.height }, scale, 0)
    return { width: sheet.width, height: sheet.height, placements: [placement], border: false }
  })
}

// ---- Multiple (N-up) ----------------------------------------------------------------------

/** Column × row grids for a pages-per-sheet count, as close to square as possible. */
export function gridsFor(perSheet: number): { cols: number; rows: number }[] {
  const n = Math.max(1, Math.round(perSheet))
  const out: { cols: number; rows: number }[] = []
  for (let c = 1; c <= n; c++) {
    if (n % c) continue
    const r = n / c
    if (Math.max(c, r) / Math.min(c, r) <= 2) out.push({ cols: c, rows: r })
  }
  if (!out.length) {
    // Primes and other awkward counts: the most square grid with room for every page.
    const c = Math.ceil(Math.sqrt(n))
    const r = Math.ceil(n / c)
    out.push({ cols: c, rows: r }, { cols: r, rows: c })
  }
  return out
}

interface GridChoice {
  sheet: PageBox
  cols: number
  rows: number
  cellW: number
  cellH: number
}

function gridCells(sheet: PageBox, cols: number, rows: number): { cellW: number; cellH: number } {
  const m = PRINT_MARGIN
  return {
    cellW: (sheet.width - 2 * m - (cols - 1) * CELL_GAP) / cols,
    cellH: (sheet.height - 2 * m - (rows - 1) * CELL_GAP) / rows
  }
}

/** Scale and rotation for one page in a cell. */
function cellFit(size: PageBox, cellW: number, cellH: number, autoRotate: boolean): { scale: number; rotate: Rotation } {
  const straight = fitScale(size.width, size.height, cellW, cellH)
  if (!autoRotate) return { scale: straight, rotate: 0 }
  const turned = fitScale(size.height, size.width, cellW, cellH)
  return turned > straight * 1.01 ? { scale: turned, rotate: 270 } : { scale: straight, rotate: 0 }
}

/** Picks sheet orientation and grid so pages print as large as possible (Acrobat does the same). */
export function chooseGrid(reference: PageBox, o: Pick<ImpositionOptions, 'paper' | 'orientation' | 'perSheet' | 'grid' | 'autoRotate'>): GridChoice {
  const orientations: ('portrait' | 'landscape')[] = o.orientation === 'auto' ? ['portrait', 'landscape'] : [o.orientation]
  const grids = o.grid ? [{ cols: Math.max(1, o.grid.cols), rows: Math.max(1, o.grid.rows) }] : gridsFor(o.perSheet)
  let best: (GridChoice & { score: number }) | null = null
  for (const orient of orientations) {
    const sheet = orientPaper(o.paper, orient)
    for (const g of grids) {
      const { cellW, cellH } = gridCells(sheet, g.cols, g.rows)
      const fit = cellFit(reference, cellW, cellH, o.autoRotate)
      // Prefer upright pages, then portrait paper, when sizes are (nearly) equal.
      const score = fit.scale * (fit.rotate ? 0.995 : 1) * (orient === 'portrait' ? 1.0001 : 1)
      if (!best || score > best.score + EPS) best = { sheet, cols: g.cols, rows: g.rows, cellW, cellH, score }
    }
  }
  return best!
}

/** Cell (column, row) of the k-th page on a sheet for a page order. */
export function cellPosition(k: number, cols: number, rows: number, order: PageOrder): { col: number; row: number } {
  switch (order) {
    case 'horizontal':
      return { col: k % cols, row: Math.floor(k / cols) }
    case 'horizontal-reversed':
      return { col: cols - 1 - (k % cols), row: Math.floor(k / cols) }
    case 'vertical':
      return { col: Math.floor(k / rows), row: k % rows }
    case 'vertical-reversed':
      return { col: cols - 1 - Math.floor(k / rows), row: k % rows }
  }
}

function layoutMultiple(pages: number[], sizes: PageBox[], o: ImpositionOptions): Sheet[] {
  if (!pages.length) return []
  const g = chooseGrid(sizes[pages[0]], o)
  const n = g.cols * g.rows
  const sheets: Sheet[] = []
  for (let start = 0; start < pages.length; start += n) {
    const chunk = pages.slice(start, start + n)
    const placements = chunk.map((p, k) => {
      const { col, row } = cellPosition(k, g.cols, g.rows, o.pageOrder)
      const box = {
        x: PRINT_MARGIN + col * (g.cellW + CELL_GAP),
        y: PRINT_MARGIN + row * (g.cellH + CELL_GAP),
        width: g.cellW,
        height: g.cellH
      }
      const fit = cellFit(sizes[p], g.cellW, g.cellH, o.autoRotate)
      return placeInBox(p, sizes[p], box, fit.scale, fit.rotate)
    })
    sheets.push({ width: g.sheet.width, height: g.sheet.height, placements, border: o.pageBorder })
  }
  return sheets
}

// ---- Booklet ------------------------------------------------------------------------------

/**
 * Page order for saddle-stitched booklets. Pages are padded with blanks (-1) to a multiple of 4.
 * Each entry is one sheet: [left, right] on the front and on the back.
 */
export function bookletSpreads(pages: number[], binding: BookletBinding): { front: [number, number]; back: [number, number] }[] {
  const seq = [...pages]
  while (seq.length % 4 !== 0 || seq.length === 0) seq.push(-1)
  const n = seq.length
  const out: { front: [number, number]; back: [number, number] }[] = []
  for (let s = 0; s < n / 4; s++) {
    const outerBack = seq[n - 1 - 2 * s]
    const outerFront = seq[2 * s]
    const innerFront = seq[2 * s + 1]
    const innerBack = seq[n - 2 - 2 * s]
    out.push(
      binding === 'left'
        ? { front: [outerBack, outerFront], back: [innerFront, innerBack] }
        : { front: [outerFront, outerBack], back: [innerBack, innerFront] }
    )
  }
  return out
}

export function bookletSheetCount(pageCount: number): number {
  return Math.max(1, Math.ceil(pageCount / 4))
}

function layoutBooklet(pages: number[], sizes: PageBox[], o: ImpositionOptions): Sheet[] {
  if (!pages.length) return []
  const sheet = orientPaper(o.paper, 'landscape')
  const m = PRINT_MARGIN
  const half = sheet.width / 2
  const cellW = half - m - m / 2
  const cellH = sheet.height - 2 * m
  const spreads = bookletSpreads(pages, o.binding)
  const total = spreads.length
  const from = Math.min(Math.max(1, Math.round(o.sheetFrom || 1)), total)
  const to = Math.max(from, Math.min(total, o.sheetTo > 0 ? Math.round(o.sheetTo) : total))
  const order: number[] = []
  for (let s = from; s <= to; s++) order.push(s - 1)
  if (o.reverse) order.reverse()
  const side = (pair: [number, number], which: 'front' | 'back', sheetNumber: number): Sheet => {
    const placements: Placement[] = []
    pair.forEach((p, k) => {
      if (p < 0) return
      const box = { x: k === 0 ? m : half + m / 2, y: m, width: cellW, height: cellH }
      const scale = fitScale(sizes[p].width, sizes[p].height, cellW, cellH)
      // Pages sit against the fold, like an open book.
      placements.push(placeInBox(p, sizes[p], box, scale, 0, k === 0 ? 'end' : 'start'))
    })
    return { width: sheet.width, height: sheet.height, placements, border: false, side: which, sheetNumber }
  }
  const out: Sheet[] = []
  for (const s of order) {
    if (o.bookletSubset !== 'back') out.push(side(spreads[s].front, 'front', s + 1))
    if (o.bookletSubset !== 'front') out.push(side(spreads[s].back, 'back', s + 1))
  }
  return out
}

// ---- Poster -------------------------------------------------------------------------------

export function posterTiles(
  page: PageBox,
  sheet: PageBox,
  scale: number,
  overlap: number
): { cols: number; rows: number; step: [number, number]; offset: [number, number]; area: PageBox } {
  const m = POSTER_MARGIN
  const area = { width: sheet.width - 2 * m, height: sheet.height - 2 * m }
  const o = Math.max(0, Math.min(overlap, area.width / 2, area.height / 2))
  const w = page.width * scale
  const h = page.height * scale
  const stepX = area.width - o
  const stepY = area.height - o
  const cols = w <= area.width + EPS ? 1 : Math.ceil((w - o) / stepX - EPS)
  const rows = h <= area.height + EPS ? 1 : Math.ceil((h - o) / stepY - EPS)
  // Centre the poster on the tiled area so the outer tiles have equal white borders.
  const coverW = cols * stepX + o
  const coverH = rows * stepY + o
  return { cols, rows, step: [stepX, stepY], offset: [(coverW - w) / 2, (coverH - h) / 2], area }
}

function layoutPoster(
  pages: number[],
  sizes: PageBox[],
  o: ImpositionOptions,
  labelFor?: (page: number, row: number, col: number) => string
): Sheet[] {
  const scale = Math.max(0.01, (Number.isFinite(o.tileScale) ? o.tileScale : 100) / 100)
  const m = POSTER_MARGIN
  const sheets: Sheet[] = []
  for (const p of pages) {
    const size = sizes[p]
    const candidates: ('portrait' | 'landscape')[] = o.orientation === 'auto' ? ['portrait', 'landscape'] : [o.orientation]
    let best: { sheet: PageBox; tiles: ReturnType<typeof posterTiles> } | null = null
    for (const orient of candidates) {
      const sheet = orientPaper(o.paper, orient)
      const tiles = posterTiles(size, sheet, scale, o.overlap)
      const count = tiles.cols * tiles.rows
      const bestCount = best ? best.tiles.cols * best.tiles.rows : Infinity
      const matches = isLandscape(sheet) === isLandscape(size)
      if (count < bestCount || (count === bestCount && matches)) best = { sheet, tiles }
    }
    const { sheet, tiles } = best!
    const trim: [number, number, number, number] = [m, m, sheet.width - m, sheet.height - m]
    const w = size.width * scale
    const h = size.height * scale
    if (o.tileLargeOnly && tiles.cols === 1 && tiles.rows === 1) {
      const placement = placeInBox(p, size, { x: 0, y: 0, width: sheet.width, height: sheet.height }, scale, 0)
      sheets.push({ width: sheet.width, height: sheet.height, placements: [placement], border: false })
      continue
    }
    for (let r = 0; r < tiles.rows; r++) {
      for (let c = 0; c < tiles.cols; c++) {
        const placement: Placement = {
          page: p,
          x: m + tiles.offset[0] - c * tiles.step[0],
          y: m + tiles.offset[1] - r * tiles.step[1],
          width: w,
          height: h,
          rotate: 0,
          scale,
          clip: trim
        }
        sheets.push({
          width: sheet.width,
          height: sheet.height,
          placements: [placement],
          border: false,
          cutMarks: o.cutMarks ? trim : undefined,
          label: o.labels && labelFor ? labelFor(p, r, c) : undefined
        })
      }
    }
  }
  return sheets
}

// ---- entry point --------------------------------------------------------------------------

/**
 * Lays out the selected pages (0-based indices, in print order) on sheets.
 * `sizes` is indexed by page index and gives each page's visible size in points (rotation applied).
 */
export function layoutSheets(
  pages: number[],
  sizes: PageBox[],
  o: ImpositionOptions,
  labelFor?: (page: number, row: number, col: number) => string
): Sheet[] {
  const valid = pages.filter((p) => sizes[p] && sizes[p].width > 0 && sizes[p].height > 0)
  let sheets: Sheet[]
  switch (o.mode) {
    case 'size':
      sheets = layoutSize(valid, sizes, o)
      break
    case 'multiple':
      sheets = layoutMultiple(valid, sizes, o)
      break
    case 'booklet':
      return layoutBooklet(valid, sizes, o)
    case 'poster':
      sheets = layoutPoster(valid, sizes, o, labelFor)
      break
  }
  return o.reverse ? sheets.reverse() : sheets
}

/**
 * Paper orientation for the printer. A job has one orientation; sheets that differ (mixed
 * documents with Auto orientation) are turned a quarter turn to fit the paper.
 */
export function jobOrientation(sheets: Sheet[]): 'portrait' | 'landscape' {
  return sheets.length > 0 && sheets.every(isLandscape) ? 'landscape' : 'portrait'
}

/** True when a sheet must be turned to fit the job's paper orientation. */
export function sheetNeedsTurn(sheet: Sheet, orientation: 'portrait' | 'landscape'): boolean {
  return isLandscape(sheet) !== (orientation === 'landscape')
}

/** Average printed scale of the pages on a sheet, for the "Scale: 97%" readout. */
export function sheetScale(sheet: Sheet | undefined): number | null {
  if (!sheet || !sheet.placements.length) return null
  return sheet.placements.reduce((a, p) => a + p.scale, 0) / sheet.placements.length
}
