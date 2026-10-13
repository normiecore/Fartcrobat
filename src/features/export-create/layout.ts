/**
 * Layout analysis for Export: turns the raw content of pages (styled text lines, images, ruled
 * lines) into document structure — paragraphs with alignment and indents, headings, bulleted and
 * numbered lists, tables (ruled grids and aligned columns) and images, in reading order. The Word,
 * HTML, Excel, PowerPoint and text builders all work from this.
 *
 * Pure functions on plain data: no MuPDF, no DOM.
 */
import {
  FONT_BOLD,
  FONT_ITALIC,
  FONT_MONO,
  segmentText,
  type PageContent,
  type XComment,
  type XDrawing,
  type XFill,
  type XImage,
  type XLine,
  type XRule,
  type XRun,
  type XSegment
} from './content'
import { fontFamily } from './fonts'

export type Align = 'left' | 'center' | 'right' | 'justify'

export interface LRun {
  text: string
  family: string
  size: number
  /** 0xRRGGBB */
  color: number
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  mono: boolean
  link?: string
}

/** One line of text as it is in the PDF. */
export interface LLine {
  runs: LRun[]
  x0: number
  y0: number
  x1: number
  y1: number
  baseline: number
  size: number
}

export type ListFormat = 'bullet' | 'decimal' | 'lowerLetter' | 'upperLetter' | 'lowerRoman' | 'upperRoman'

export interface ListInfo {
  format: ListFormat
  /** The marker as printed ("•", "3.", "b)"). */
  marker: string
  /** Number of the item (1 for bullets). */
  value: number
  /** Nesting depth from the indentation, 0-based. */
  depth: number
}

interface Placed {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Reading order (MuPDF block sequence). */
  order: number
  /** Extra space above, in points (beyond normal line spacing). */
  spaceBefore: number
}

export interface LParagraph extends Placed {
  kind: 'paragraph'
  lines: LLine[]
  role: 'body' | 'heading' | 'list'
  /** Heading level, 1 = largest (0 for body text). */
  level: number
  list?: ListInfo
  align: Align
  /** Left edge of the text from the left margin, in points. */
  indent: number
  /** First line position relative to `indent` (negative: hanging indent). */
  firstLine: number
  /** Distance between baselines when the paragraph has several lines (0 otherwise). */
  lineStep: number
  /** Dominant font size. */
  size: number
  /** The whole paragraph is bold. */
  bold: boolean
  /** Monospaced text (code, data listings): keep its line breaks and spacing. */
  preformatted: boolean
  /** Comments made on this paragraph (Word comments). */
  comments?: XComment[]
  /** A line drawn under or over the paragraph (title underlines, separators). */
  borderBottom?: LBorder
  borderTop?: LBorder
  /** Candidate for a heading before the levels of the whole document are known. */
  headingCandidate: boolean
}

export interface LBorder {
  /** Line width in points. */
  width: number
  color: number
  /** Distance from the text, in points. */
  gap: number
}

export interface LCell {
  row: number
  col: number
  rowSpan: number
  colSpan: number
  lines: LLine[]
  align: Align
  /** Background colour (0xRRGGBB) when the cell is shaded. */
  fill?: number
}

export interface LTable extends Placed {
  kind: 'table'
  rows: number
  cols: number
  cells: LCell[]
  /** Column widths in points. */
  colWidths: number[]
  /** Row heights in points. */
  rowHeights: number[]
  /** Drawn with borders in the PDF. */
  ruled: boolean
}

export interface LImage extends Placed {
  kind: 'image'
  image: XImage
  align: Align
  /**
   * Vector artwork still to be rendered from the page as a picture (see resolvePictures): the area
   * in page space, and whether the text inside it is part of the picture.
   */
  render?: { pageIndex: number; clip: [number, number, number, number]; text: boolean }
}

export type LElement = LParagraph | LTable | LImage

export interface LPage {
  index: number
  width: number
  height: number
  margins: { left: number; right: number; top: number; bottom: number }
  elements: LElement[]
  /** The page without its text, for layouts that put text over a picture of the page (set by the exporter). */
  background?: XImage
  /** The page has pictures, artwork, rules or shading (worth a background picture). */
  graphics: boolean
  /** Underlines and strike-through lines of the text, to leave out of a background picture. */
  decorations: [number, number, number, number][]
  /** Recognized text on a scan, to erase from a background picture (PageContent.erase). */
  erase: [number, number, number, number][]
}

export interface LayoutOptions {
  /** Detect headings and lists (otherwise everything is body text). */
  structure?: boolean
  /** Detect tables. */
  tables?: boolean
  /** Include images. */
  images?: boolean
  /** Turn vector artwork (charts, diagrams) into pictures, with their labels. Defaults to `images`. */
  pictures?: boolean
  /**
   * For layouts that place text where it is on the page (Word "Retain Page Layout", PowerPoint):
   * text separated by wide gaps on one line becomes separate items.
   */
  positioned?: boolean
}

export interface DocLayout {
  pages: LPage[]
  bodySize: number
}

// ---- runs and lines -----------------------------------------------------------------------

export function toRun(r: XRun): LRun {
  return {
    text: r.text,
    family: fontFamily(r.font, r.flags),
    size: Math.round(r.size * 2) / 2 || 10,
    color: r.color,
    bold: (r.flags & FONT_BOLD) !== 0,
    italic: (r.flags & FONT_ITALIC) !== 0,
    underline: !!r.underline,
    strike: !!r.strike,
    mono: (r.flags & FONT_MONO) !== 0,
    ...(r.link ? { link: r.link } : {})
  }
}

export function sameRunStyle(a: LRun, b: LRun): boolean {
  return (
    a.family === b.family &&
    a.size === b.size &&
    a.color === b.color &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.link === b.link
  )
}

function pushRun(out: LRun[], run: LRun) {
  if (!run.text) return
  const last = out[out.length - 1]
  if (last && sameRunStyle(last, run)) last.text += run.text
  else out.push({ ...run })
}

/** Joins segments of one row into a line; wide gaps become a tab. */
function lineFromSegments(segs: XSegment[]): LLine {
  const sorted = [...segs].sort((a, b) => a.x0 - b.x0)
  const runs: LRun[] = []
  sorted.forEach((seg, i) => {
    if (i > 0) {
      const prev = sorted[i - 1]
      const size = seg.runs[0]?.size ?? 10
      const sep = seg.x0 - prev.x1 > 3 * size ? '\t' : ' '
      const last = runs[runs.length - 1]
      if (last) last.text += sep
    }
    for (const r of seg.runs) pushRun(runs, toRun(r))
  })
  const sizes = sorted.flatMap((s) => s.runs.map((r) => ({ size: r.size, n: r.text.length })))
  return {
    runs,
    x0: Math.min(...sorted.map((s) => s.x0)),
    y0: Math.min(...sorted.map((s) => s.y0)),
    x1: Math.max(...sorted.map((s) => s.x1)),
    y1: Math.max(...sorted.map((s) => s.y1)),
    baseline: sorted[0].baseline,
    size: dominant(sizes)
  }
}

function dominant(items: { size: number; n: number }[]): number {
  const w = new Map<number, number>()
  for (const it of items) {
    const k = Math.round(it.size * 2) / 2
    w.set(k, (w.get(k) ?? 0) + it.n)
  }
  let best = 10
  let bw = -1
  for (const [k, v] of w) {
    if (v > bw) {
      best = k
      bw = v
    }
  }
  return best
}

export function lineString(line: LLine): string {
  return line.runs.map((r) => r.text).join('')
}

/**
 * The runs of a paragraph as one flowing text: lines joined with a space, words hyphenated at a
 * line end joined again ("docu-" + "ment" -> "document"). Wide gaps inside a line stay tabs.
 */
export function flowRuns(lines: LLine[]): LRun[] {
  const out: LRun[] = []
  lines.forEach((line, i) => {
    const runs = line.runs.map((r) => ({ ...r }))
    if (i > 0 && out.length && runs.length) {
      const prev = out[out.length - 1]
      const next = runs[0]
      if (/[A-Za-zÀ-ÖØ-öø-ÿ][-­]$/.test(prev.text) && /^[a-zß-öø-ÿ]/.test(next.text)) {
        prev.text = prev.text.slice(0, -1)
      } else if (!/\s$/.test(prev.text) && !/^\s/.test(next.text)) {
        prev.text += ' '
      }
    }
    for (const r of runs) pushRun(out, r)
  })
  return out
}

/** The lines of a paragraph kept as they are, with a '\n' between lines (tabs kept). */
export function linedRuns(lines: LLine[]): LRun[] {
  const out: LRun[] = []
  lines.forEach((line, i) => {
    if (i > 0 && out.length) out[out.length - 1].text += '\n'
    for (const r of line.runs) pushRun(out, r)
  })
  return out
}

export function plainText(runs: LRun[]): string {
  return runs.map((r) => r.text).join('')
}

// ---- lists --------------------------------------------------------------------------------

const BULLET_CHARS = '•●○◦▪■□►▸‣⁃∙·➢➤✓✔-–—*'
const INLINE_BULLET = /^([•●○◦▪■□►▸‣⁃∙·➢➤✓✔])\s+(?=\S)/
const INLINE_NUMBER = /^(\(?(\d{1,3})[.)])\s+(?=\S)/
const ROMAN = /^[ivxlcdm]{1,6}$/i

function romanValue(s: string): number {
  const v: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 }
  let total = 0
  const t = s.toLowerCase()
  for (let i = 0; i < t.length; i++) {
    const cur = v[t[i]]
    const next = v[t[i + 1]] ?? 0
    total += cur < next ? -cur : cur
  }
  return total
}

/** Bullets drawn with Symbol or Wingdings fonts come out as private-use characters. */
const PRIVATE_BULLETS: Record<number, string> = { 0xf0b7: '•', 0xf0a7: '▪', 0xf06e: '■', 0xf06c: '●', 0xf0d8: '➢', 0xf0fc: '✓', 0xf076: '❖', 0xf0a8: '◆', 0xf075: '◆' }

export function parseMarker(text: string): Omit<ListInfo, 'depth'> | null {
  const t = text.trim()
  if (t.length === 1 && BULLET_CHARS.includes(t)) return { format: 'bullet', marker: t, value: 1 }
  const code = t.length === 1 ? t.charCodeAt(0) : 0
  if (code >= 0xe000 && code <= 0xf8ff) return { format: 'bullet', marker: PRIVATE_BULLETS[code] ?? '•', value: 1 }
  const m = /^\(?([0-9]{1,3}|[a-zA-Z]|[ivxlcdmIVXLCDM]{1,6})[.)]$/.exec(t)
  if (!m) return null
  const k = m[1]
  if (/^\d+$/.test(k)) return { format: 'decimal', marker: t, value: parseInt(k, 10) }
  if (ROMAN.test(k) && (k.length > 1 || /[ivx]/i.test(k))) {
    return { format: k === k.toLowerCase() ? 'lowerRoman' : 'upperRoman', marker: t, value: romanValue(k) }
  }
  if (k.length === 1) {
    const lower = k === k.toLowerCase()
    return { format: lower ? 'lowerLetter' : 'upperLetter', marker: t, value: k.toLowerCase().charCodeAt(0) - 96 }
  }
  return null
}

interface MarkedLine {
  list: Omit<ListInfo, 'depth'>
  /** Line without its marker. */
  line: LLine
  markerX: number
}

/** A list item marker at the start of a line: a separate bullet/number, or "• text" / "1. text". */
function detectMarker(x: XLine): MarkedLine | null {
  const segs = [...x.segments].sort((a, b) => a.x0 - b.x0)
  if (segs.length >= 2) {
    const info = parseMarker(segmentText(segs[0]))
    // A wide gap after a short marker; the rest is the item text.
    if (info && segs[1].x0 - segs[0].x1 < 6 * (segs[0].runs[0]?.size ?? 10)) {
      return { list: info, line: lineFromSegments(segs.slice(1)), markerX: segs[0].x0 }
    }
  }
  const line = lineFromSegments(segs)
  const text = lineString(line)
  const b = INLINE_BULLET.exec(text)
  const n = b ? null : INLINE_NUMBER.exec(text)
  const hit = b ?? n
  if (!hit) return null
  const info = parseMarker(hit[1])
  if (!info) return null
  // Strip the marker and the spaces after it from the runs.
  let strip = hit[0].length
  const runs: LRun[] = []
  for (const r of line.runs) {
    if (strip >= r.text.length) {
      strip -= r.text.length
      continue
    }
    runs.push({ ...r, text: r.text.slice(strip) })
    strip = 0
  }
  if (!runs.length) return null
  const chars = text.length || 1
  const textX0 = line.x0 + ((line.x1 - line.x0) * hit[0].length) / chars
  return { list: info, line: { ...line, runs, x0: textX0 }, markerX: line.x0 }
}

// ---- ruled tables -------------------------------------------------------------------------

function cluster(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[][] = []
  for (const v of sorted) {
    const last = out[out.length - 1]
    if (last && v - last[last.length - 1] <= tol) last.push(v)
    else out.push([v])
  }
  return out.map((g) => g.reduce((s, v) => s + v, 0) / g.length)
}

interface Grid {
  xs: number[]
  ys: number[]
  hs: XRule[]
  vs: XRule[]
}

function findGrids(rules: XRule[]): Grid[] {
  const hs = rules.filter((r) => r.dir === 'h')
  const vs = rules.filter((r) => r.dir === 'v')
  const all = [...hs, ...vs]
  const parent = all.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const tol = 2.5
  for (let i = 0; i < hs.length; i++) {
    for (let j = 0; j < vs.length; j++) {
      const h = hs[i]
      const v = vs[j]
      if (v.x0 >= h.x0 - tol && v.x0 <= h.x1 + tol && h.y0 >= v.y0 - tol && h.y0 <= v.y1 + tol) {
        parent[find(i)] = find(hs.length + j)
      }
    }
  }
  const groups = new Map<number, XRule[]>()
  all.forEach((r, i) => {
    const g = find(i)
    const list = groups.get(g)
    if (list) list.push(r)
    else groups.set(g, [r])
  })
  const grids: Grid[] = []
  for (const g of groups.values()) {
    const gh = g.filter((r) => r.dir === 'h')
    const gv = g.filter((r) => r.dir === 'v')
    if (gh.length < 2 || gv.length < 2) continue
    const xs = cluster(
      gv.map((r) => r.x0),
      2
    )
    const ys = cluster(
      gh.map((r) => r.y0),
      2
    )
    if (xs.length < 2 || ys.length < 2) continue
    if ((xs.length - 1) * (ys.length - 1) < 2) continue
    grids.push({ xs, ys, hs: gh, vs: gv })
  }
  return grids
}

function cellFill(fills: XFill[], x0: number, y0: number, x1: number, y1: number): number | undefined {
  const area = (x1 - x0) * (y1 - y0)
  for (const f of fills) {
    const ix = Math.min(x1, f.x1) - Math.max(x0, f.x0)
    const iy = Math.min(y1, f.y1) - Math.max(y0, f.y0)
    // A band over a whole row or column shades its cells; a box much larger both ways is a background.
    const wider = f.x1 - f.x0 > (x1 - x0) * 1.6
    const taller = f.y1 - f.y0 > (y1 - y0) * 1.6
    if (ix > 0 && iy > 0 && ix * iy >= 0.8 * area && !(wider && taller)) return f.color
  }
  return undefined
}

/** Lines of text from segments (grouped by baseline). */
function linesOf(segs: XSegment[]): LLine[] {
  const sorted = [...segs].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0)
  const rows: XSegment[][] = []
  for (const s of sorted) {
    const row = rows[rows.length - 1]
    const size = s.runs[0]?.size ?? 10
    if (row && Math.abs(row[0].baseline - s.baseline) <= 0.35 * size) row.push(s)
    else rows.push([s])
  }
  return rows.map(lineFromSegments)
}

function columnAlign(cellLines: LLine[], left: number, right: number): Align {
  if (!cellLines.length) return 'left'
  const x0 = Math.min(...cellLines.map((l) => l.x0))
  const x1 = Math.max(...cellLines.map((l) => l.x1))
  const lgap = x0 - left
  const rgap = right - x1
  if (Math.abs(lgap - rgap) <= 3 && lgap > 6) return 'center'
  if (rgap + 4 < lgap && rgap < 12) return 'right'
  return 'left'
}

function ruledTable(grid: Grid, segs: Map<XSegment, XLine>, fills: XFill[]): { table: LTable; used: Set<XSegment> } | null {
  const { xs, ys, hs, vs } = grid
  const rows = ys.length - 1
  const cols = xs.length - 1
  const tol = 2.5
  const hasV = (xi: number, r: number) =>
    vs.some((v) => Math.abs(v.x0 - xs[xi]) <= tol && v.y0 <= ys[r] + tol + 1 && v.y1 >= ys[r + 1] - tol - 1)
  const hasH = (yi: number, c: number) =>
    hs.some((h) => Math.abs(h.y0 - ys[yi]) <= tol && h.x0 <= xs[c] + tol + 1 && h.x1 >= xs[c + 1] - tol - 1)
  // Merged cells: neighbours without a border between them.
  const owner = Array.from({ length: rows * cols }, (_, i) => i)
  const find = (i: number): number => (owner[i] === i ? i : (owner[i] = find(owner[i])))
  const join = (a: number, b: number) => {
    owner[find(a)] = find(b)
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols && !hasV(c + 1, r)) join(r * cols + c, r * cols + c + 1)
      if (r + 1 < rows && !hasH(r + 1, c)) join(r * cols + c, (r + 1) * cols + c)
    }
  }
  const regions = new Map<number, { r0: number; r1: number; c0: number; c1: number; n: number }>()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = find(r * cols + c)
      const reg = regions.get(k)
      if (reg) {
        reg.r0 = Math.min(reg.r0, r)
        reg.r1 = Math.max(reg.r1, r)
        reg.c0 = Math.min(reg.c0, c)
        reg.c1 = Math.max(reg.c1, c)
        reg.n++
      } else regions.set(k, { r0: r, r1: r, c0: c, c1: c, n: 1 })
    }
  }
  let rectangular = true
  for (const reg of regions.values()) if ((reg.r1 - reg.r0 + 1) * (reg.c1 - reg.c0 + 1) !== reg.n) rectangular = false
  const regionOf = (r: number, c: number) => {
    if (!rectangular) return { r0: r, r1: r, c0: c, c1: c, n: 1 }
    return regions.get(find(r * cols + c))!
  }
  // A grid that is one big box (a frame around text) is not a table.
  const distinct = rectangular ? regions.size : rows * cols
  if (distinct < 2) return null
  const bx0 = xs[0]
  const bx1 = xs[xs.length - 1]
  const by0 = ys[0]
  const by1 = ys[ys.length - 1]
  const content = new Map<string, XSegment[]>()
  const used = new Set<XSegment>()
  let minOrder = Infinity
  for (const [seg, line] of segs) {
    const cx = (seg.x0 + seg.x1) / 2
    const cy = (seg.y0 + seg.y1) / 2
    if (cx < bx0 || cx > bx1 || cy < by0 || cy > by1) continue
    const c = Math.min(cols - 1, Math.max(0, xs.findIndex((x, i) => i < cols && cx >= x && cx < xs[i + 1])))
    const r = Math.min(rows - 1, Math.max(0, ys.findIndex((y, i) => i < rows && cy >= y && cy < ys[i + 1])))
    const reg = regionOf(r, c)
    const key = `${reg.r0}:${reg.c0}`
    const list = content.get(key)
    if (list) list.push(seg)
    else content.set(key, [seg])
    used.add(seg)
    minOrder = Math.min(minOrder, line.block)
  }
  if (!used.size) return null
  const cells: LCell[] = []
  const seen = new Set<string>()
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const reg = regionOf(r, c)
      const key = `${reg.r0}:${reg.c0}`
      if (seen.has(key)) continue
      seen.add(key)
      const lines = linesOf(content.get(key) ?? [])
      const x0 = xs[reg.c0]
      const x1 = xs[reg.c1 + 1]
      const y0 = ys[reg.r0]
      const y1 = ys[reg.r1 + 1]
      const fill = cellFill(fills, x0, y0, x1, y1)
      cells.push({
        row: reg.r0,
        col: reg.c0,
        rowSpan: reg.r1 - reg.r0 + 1,
        colSpan: reg.c1 - reg.c0 + 1,
        lines,
        align: columnAlign(lines, x0, x1),
        ...(fill !== undefined ? { fill } : {})
      })
    }
  }
  return {
    table: {
      kind: 'table',
      rows,
      cols,
      cells,
      colWidths: xs.slice(1).map((x, i) => x - xs[i]),
      rowHeights: ys.slice(1).map((y, i) => y - ys[i]),
      ruled: true,
      x0: bx0,
      y0: by0,
      x1: bx1,
      y1: by1,
      order: minOrder,
      spaceBefore: 0
    },
    used
  }
}

// ---- tables from aligned columns ----------------------------------------------------------

interface Column {
  x0: number
  x1: number
  /** Left and right edges of the cells in the column. */
  lefts: number[]
  rights: number[]
}

function isListRow(line: XLine): boolean {
  if (line.segments.length !== 2) return false
  const segs = [...line.segments].sort((a, b) => a.x0 - b.x0)
  return !!parseMarker(segmentText(segs[0]))
}

function overlapping(cols: Column[], s: XSegment): number[] {
  const out: number[] = []
  cols.forEach((c, i) => {
    const ov = Math.min(c.x1, s.x1) - Math.max(c.x0, s.x0)
    if (ov > 0 || Math.abs(c.x0 - s.x0) <= 3 || Math.abs(c.x1 - s.x1) <= 3) out.push(i)
  })
  return out
}

function addToColumns(cols: Column[], line: XLine) {
  for (const s of line.segments) {
    const hit = overlapping(cols, s)
    if (hit.length === 1) {
      const c = cols[hit[0]]
      c.x0 = Math.min(c.x0, s.x0)
      c.x1 = Math.max(c.x1, s.x1)
      c.lefts.push(s.x0)
      c.rights.push(s.x1)
    } else if (hit.length === 0) {
      cols.push({ x0: s.x0, x1: s.x1, lefts: [s.x0], rights: [s.x1] })
    }
  }
  cols.sort((a, b) => a.x0 - b.x0)
  // Columns that grew into each other are one column.
  for (let i = 0; i + 1 < cols.length; ) {
    if (cols[i].x1 > cols[i + 1].x0 + 1) {
      const a = cols[i]
      const b = cols.splice(i + 1, 1)[0]
      a.x0 = Math.min(a.x0, b.x0)
      a.x1 = Math.max(a.x1, b.x1)
      a.lefts.push(...b.lefts)
      a.rights.push(...b.rights)
    } else i++
  }
}

function fitsColumns(cols: Column[], line: XLine): boolean {
  let matched = 0
  for (const s of line.segments) {
    const hit = overlapping(cols, s)
    if (hit.length >= 1) matched++
  }
  return matched >= Math.min(2, line.segments.length)
}

function alignedTable(rowsIn: XLine[], continuations: Map<XLine, XLine>, fills: XFill[]): LTable | null {
  const cols: Column[] = []
  for (const l of rowsIn) addToColumns(cols, l)
  if (cols.length < 2) return null
  const n = cols.length
  // Boundaries halfway between columns.
  const bounds: number[] = [cols[0].x0 - 4]
  for (let i = 0; i + 1 < n; i++) bounds.push((cols[i].x1 + cols[i + 1].x0) / 2)
  bounds.push(cols[n - 1].x1 + 4)
  const colAlign: Align[] = cols.map((c) => {
    const lspread = Math.max(...c.lefts) - Math.min(...c.lefts)
    const rspread = Math.max(...c.rights) - Math.min(...c.rights)
    if (rspread <= 2 && lspread > 3) return 'right'
    const centers = c.lefts.map((l, i) => (l + c.rights[i]) / 2)
    if (Math.max(...centers) - Math.min(...centers) <= 2.5 && lspread > 3 && rspread > 3) return 'center'
    return 'left'
  })
  const cells: LCell[] = []
  const rowHeights: number[] = []
  let filled = 0
  let chars = 0
  rowsIn.forEach((line, r) => {
    const byCell = new Map<number, { span: number; segs: XSegment[] }>()
    for (const s of [...line.segments].sort((a, b) => a.x0 - b.x0)) {
      const first = Math.max(0, bounds.findIndex((b, i) => i < n && s.x0 < bounds[i + 1]))
      let last = first
      while (last + 1 < n && s.x1 > bounds[last + 1] + 2) last++
      const entry = byCell.get(first)
      if (entry) {
        entry.segs.push(s)
        entry.span = Math.max(entry.span, last - first + 1)
      } else byCell.set(first, { span: last - first + 1, segs: [s] })
      chars += segmentText(s).length
    }
    const cont = continuations.get(line)
    if (cont) {
      // A wrapped cell: the extra line goes into the cell whose column it sits in.
      for (const s of cont.segments) {
        const c = Math.max(0, bounds.findIndex((b, i) => i < n && (s.x0 + s.x1) / 2 < bounds[i + 1]))
        const entry = byCell.get(c)
        if (entry) entry.segs.push(s)
        else byCell.set(c, { span: 1, segs: [s] })
      }
    }
    let c = 0
    while (c < n) {
      const entry = byCell.get(c)
      if (entry) {
        const span = Math.min(entry.span, n - c)
        const lines = linesOf(entry.segs)
        const fill = cellFill(fills, bounds[c], line.y0 - 2, bounds[c + span], (cont ?? line).y1 + 2)
        cells.push({
          row: r,
          col: c,
          rowSpan: 1,
          colSpan: span,
          lines,
          align: span === 1 ? colAlign[c] : columnAlign(lines, bounds[c], bounds[c + span]),
          ...(fill !== undefined ? { fill } : {})
        })
        filled++
        // Skip covered columns, keeping segments that started inside them.
        c += span
      } else {
        cells.push({ row: r, col: c, rowSpan: 1, colSpan: 1, lines: [], align: colAlign[c] })
        c++
      }
    }
    const next = rowsIn[r + 1]
    const bottom = (cont ?? line).y1
    rowHeights.push(next ? Math.max(4, next.y0 - line.y0) : Math.max(4, bottom - line.y0 + 2))
  })
  if (filled < 4 || chars / Math.max(1, filled) > 60) return null
  return {
    kind: 'table',
    rows: rowsIn.length,
    cols: n,
    cells,
    colWidths: bounds.slice(1).map((b, i) => b - bounds[i]),
    rowHeights,
    ruled: false,
    x0: bounds[0],
    y0: Math.min(...rowsIn.map((l) => l.y0)),
    x1: bounds[n],
    y1: Math.max(...rowsIn.map((l) => (continuations.get(l) ?? l).y1)),
    order: Math.min(...rowsIn.map((l) => l.block)),
    spaceBefore: 0
  }
}

/** Finds runs of consecutive lines whose segments line up in columns. */
function findAlignedTables(lines: XLine[], fills: XFill[]): { tables: LTable[]; used: Set<XLine> } {
  const tables: LTable[] = []
  const used = new Set<XLine>()
  const candidate = (l: XLine) => !l.rotated && l.segments.length >= 2 && !isListRow(l)
  let i = 0
  while (i < lines.length) {
    if (!candidate(lines[i])) {
      i++
      continue
    }
    const rows: XLine[] = [lines[i]]
    const continuations = new Map<XLine, XLine>()
    const cols: Column[] = []
    addToColumns(cols, lines[i])
    let j = i + 1
    while (j < lines.length) {
      const l = lines[j]
      const prev = continuations.get(rows[rows.length - 1]) ?? rows[rows.length - 1]
      const step = l.baseline - prev.baseline
      const size = Math.max(l.size, prev.size)
      if (step <= 0 || step > 2.6 * size || l.rotated) break
      if (candidate(l) && fitsColumns(cols, l)) {
        rows.push(l)
        addToColumns(cols, l)
        j++
        continue
      }
      // One line squeezed between two rows, inside a single column: a wrapped cell.
      const next = lines[j + 1]
      if (
        l.segments.length === 1 &&
        !continuations.has(rows[rows.length - 1]) &&
        next &&
        candidate(next) &&
        step <= 1.5 * size &&
        overlapping(cols, l.segments[0]).length === 1
      ) {
        continuations.set(rows[rows.length - 1], l)
        j++
        continue
      }
      break
    }
    if (rows.length >= 2) {
      const t = alignedTable(rows, continuations, fills)
      if (t) {
        tables.push(t)
        for (const r of rows) used.add(r)
        for (const c of continuations.values()) used.add(c)
        i = j
        continue
      }
    }
    i++
  }
  return { tables, used }
}

// ---- paragraphs ---------------------------------------------------------------------------

interface ParaBuilder {
  lines: LLine[]
  sources: XLine[]
  list?: Omit<ListInfo, 'depth'>
  markerX?: number
  left: number
  right: number
  size: number
  bold: boolean
  block: number
}

function allBold(line: LLine): boolean {
  const ink = line.runs.filter((r) => r.text.trim())
  return ink.length > 0 && ink.every((r) => r.bold)
}

function firstWordWidth(line: LLine): number {
  const w = /^\s*(\S+)/.exec(lineString(line))?.[1] ?? ''
  return w.length * 0.5 * line.size
}

function startsNewParagraph(p: ParaBuilder, line: LLine, src: XLine, content: { left: number; right: number }): boolean {
  const prev = p.lines[p.lines.length - 1]
  const prevSrc = p.sources[p.sources.length - 1]
  if (src.rotated || prevSrc.rotated) return true
  const ratio = line.size / p.size
  if (ratio > 1.12 || ratio < 0.89) return true
  if (allBold(prev) !== allBold(line)) return true
  const step = line.baseline - prev.baseline
  if (step <= 0.3 * line.size) return true
  const maxStep = p.lines.length >= 2 ? (prev.baseline - p.lines[p.lines.length - 2].baseline) * 1.3 + 1 : 1.65 * Math.max(line.size, p.size)
  if (step > maxStep || step > 2.5 * line.size) return true
  // Another column.
  if (line.x0 > p.right + line.size || line.x1 < p.left - line.size) return true
  if (src.block !== prevSrc.block && step > 1.3 * line.size) return true
  if (p.list) {
    // Continuation lines of a list item start under its text.
    if (Math.abs(line.x0 - p.left) > 0.8 * line.size) return true
  } else if (p.lines.length >= 2) {
    // Indented first line of the next paragraph, or a line sticking out.
    if (Math.abs(line.x0 - p.left) > 0.8 * line.size) return true
  } else if (line.x0 > prev.x0 + 1.5) {
    return true
  } else if (prev.x0 - line.x0 > 6 * line.size) {
    return true
  }
  // The previous line ended early although the next word would have fitted: a deliberate break.
  const right = Math.max(p.right, line.x1)
  if (prev.x1 + firstWordWidth(line) + line.size * 0.6 < right - 1) return true
  // A short line ending a sentence closes the paragraph.
  if (prev.x1 < content.right - 0.25 * (content.right - content.left) && /[.!?:]["”’)]?$/.test(lineString(prev).trim()) && line.x1 > prev.x1 + 2 * line.size) return true
  return false
}

function guessAlign(lines: LLine[], content: { left: number; right: number }, pageWidth: number): Align {
  const width = content.right - content.left
  if (lines.length >= 2) {
    const body = lines.slice(0, -1)
    const lefts = lines.slice(1).map((l) => l.x0)
    const rights = body.map((l) => l.x1)
    const leftSpread = Math.max(...lefts) - Math.min(...lefts)
    const rightSpread = Math.max(...rights) - Math.min(...rights)
    const centers = lines.map((l) => (l.x0 + l.x1) / 2)
    const centerSpread = Math.max(...centers) - Math.min(...centers)
    const allLefts = lines.map((l) => l.x0)
    const allLeftSpread = Math.max(...allLefts) - Math.min(...allLefts)
    if (centerSpread <= 3 && allLeftSpread > 4) return 'center'
    const allRights = lines.map((l) => l.x1)
    if (Math.max(...allRights) - Math.min(...allRights) <= 2 && allLeftSpread > 4) return 'right'
    const paraWidth = Math.max(...lines.map((l) => l.x1)) - Math.min(...lines.map((l) => l.x0))
    if (leftSpread <= 2 && rightSpread <= 1.5 && lines.length >= 3 && paraWidth > 0.5 * width) {
      // Justified text: the lines are stretched to one width; the last line is shorter.
      const last = lines[lines.length - 1]
      if (last.x1 < Math.max(...rights) - 2 || lines.length >= 4) return 'justify'
    }
    return 'left'
  }
  const l = lines[0]
  const lgap = l.x0 - content.left
  const rgap = content.right - l.x1
  if (Math.abs(lgap - rgap) <= Math.max(6, 0.02 * width) && lgap > 18) return 'center'
  if (Math.abs((l.x0 + l.x1) / 2 - pageWidth / 2) <= 4 && l.x0 > 0.2 * pageWidth) return 'center'
  if (rgap <= 3 && lgap > 0.3 * width) return 'right'
  return 'left'
}

function finishParagraph(p: ParaBuilder, content: { left: number; right: number }, pageWidth: number, bodySize: number): LParagraph {
  const lines = p.lines
  const mono = lines.every((l) => l.runs.every((r) => r.mono || !r.text.trim()))
  const align = p.list || (mono && lines.length > 1) ? 'left' : guessAlign(lines, content, pageWidth)
  const rest = lines.length >= 2 ? Math.min(...lines.slice(1).map((l) => l.x0)) : lines[0].x0
  let indent = Math.max(0, (p.list ? p.left : rest) - content.left)
  let firstLine = p.list ? (p.markerX ?? p.left) - p.left : lines[0].x0 - rest
  if (align === 'center' || align === 'right') {
    indent = 0
    firstLine = 0
  }
  // A text column on the right of the page is not an indented paragraph when the text flows.
  if (!p.list && lines.length >= 2 && indent > 0.3 * (content.right - content.left)) {
    indent = 0
    firstLine = 0
  }
  const text = lines.map(lineString).join(' ').trim()
  const steps = lines.slice(1).map((l, i) => l.baseline - lines[i].baseline)
  const lineStep = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0
  const bold = lines.every(allBold)
  const preformatted = lines.every((l) => l.runs.every((r) => r.mono || !r.text.trim()))
  const hasLetters = /\p{L}/u.test(text)
  const headingCandidate =
    !p.list &&
    hasLetters &&
    lines.length <= 3 &&
    text.length <= 200 &&
    (p.size >= bodySize * 1.15 || (bold && lines.length === 1 && text.length <= 80 && p.size >= bodySize * 0.95 && !/[.,;:]$/.test(text)))
  return {
    kind: 'paragraph',
    lines,
    role: p.list ? 'list' : 'body',
    level: 0,
    ...(p.list ? { list: { ...p.list, depth: 0 } } : {}),
    align,
    indent,
    firstLine,
    lineStep,
    size: p.size,
    bold,
    preformatted,
    headingCandidate,
    x0: Math.min(...lines.map((l) => l.x0), p.markerX ?? Infinity),
    y0: Math.min(...lines.map((l) => l.y0)),
    x1: Math.max(...lines.map((l) => l.x1)),
    y1: Math.max(...lines.map((l) => l.y1)),
    order: p.block,
    spaceBefore: 0
  }
}

// ---- pages --------------------------------------------------------------------------------

/** Splits a line where its text is separated by wide gaps (labels under a chart, form layouts). */
function splitWideGaps(l: XLine): XLine[] {
  if (l.segments.length < 2 || l.rotated) return [l]
  const segs = [...l.segments].sort((a, b) => a.x0 - b.x0)
  const groups: XSegment[][] = [[segs[0]]]
  for (let i = 1; i < segs.length; i++) {
    const size = segs[i].runs[0]?.size ?? l.size
    if (segs[i].x0 - segs[i - 1].x1 > 2 * size) groups.push([segs[i]])
    else groups[groups.length - 1].push(segs[i])
  }
  if (groups.length === 1) return [l]
  return groups.map((g) => ({
    ...l,
    segments: g,
    x0: Math.min(...g.map((s) => s.x0)),
    x1: Math.max(...g.map((s) => s.x1)),
    y0: Math.min(...g.map((s) => s.y0)),
    y1: Math.max(...g.map((s) => s.y1))
  }))
}

function overlap(a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

/** Grid lines of a chart (with bars or curves inside) rather than a table. */
function isChart(grid: Grid, content: PageContent): boolean {
  const box = { x0: grid.xs[0], y0: grid.ys[0], x1: grid.xs[grid.xs.length - 1], y1: grid.ys[grid.ys.length - 1] }
  const area = (box.x1 - box.x0) * (box.y1 - box.y0)
  if (area <= 0) return false
  if (content.drawings.some((d: XDrawing) => d.art && overlap(d, box) > 0.3 * (d.x1 - d.x0) * (d.y1 - d.y0))) return true
  const near = (v: number, list: number[]) => list.some((x) => Math.abs(x - v) <= 2.5)
  let misaligned = 0
  for (const f of content.fills) {
    const cx = (f.x0 + f.x1) / 2
    const cy = (f.y0 + f.y1) / 2
    if (cx < box.x0 || cx > box.x1 || cy < box.y0 || cy > box.y1) continue
    // Cell shading lines up with the grid; bars of a chart do not.
    const aligned = near(f.x0, grid.xs) && near(f.x1, grid.xs) && near(f.y0, grid.ys) && near(f.y1, grid.ys)
    if (!aligned) misaligned += (f.x1 - f.x0) * (f.y1 - f.y0)
  }
  return misaligned > 0.05 * area
}

/** The most common text size (weighted by characters) of a set of pages. */
export function bodyTextSize(pages: PageContent[]): number {
  const items: { size: number; n: number }[] = []
  for (const p of pages) for (const l of p.lines) for (const s of l.segments) for (const r of s.runs) items.push({ size: r.size, n: r.text.length })
  return items.length ? dominant(items) : 11
}

export function analyzePage(content: PageContent, bodySize: number, opts: LayoutOptions = {}): LPage {
  const structure = opts.structure !== false
  const detectTables = opts.tables !== false
  const textLines = content.lines.filter((l) => l.segments.length)
  const flat = textLines.filter((l) => !l.rotated)
  const left = flat.length ? Math.min(...flat.map((l) => l.x0)) : 72
  const right = flat.length ? Math.max(...flat.map((l) => l.x1)) : content.width - 72
  const area = { left, right }
  const elements: LElement[] = []

  // 1. Ruled tables claim the text inside their grid.
  let remaining = textLines
  const usedRules = new Set<XRule>()
  if (detectTables) {
    const segs = new Map<XSegment, XLine>()
    for (const l of textLines) if (!l.rotated) for (const s of l.segments) segs.set(s, l)
    const claimed = new Set<XSegment>()
    for (const grid of findGrids(content.rules)) {
      if (isChart(grid, content)) {
        for (const r of [...grid.hs, ...grid.vs]) usedRules.add(r)
        continue
      }
      const free = new Map([...segs].filter(([s]) => !claimed.has(s)))
      const t = ruledTable(grid, free, content.fills)
      if (!t) continue
      elements.push(t.table)
      for (const r of [...grid.hs, ...grid.vs]) usedRules.add(r)
      for (const s of t.used) claimed.add(s)
    }
    remaining = []
    for (const l of textLines) {
      const keep = l.segments.filter((s) => !claimed.has(s))
      if (keep.length === l.segments.length) remaining.push(l)
      else if (keep.length) {
        remaining.push({
          ...l,
          segments: keep,
          x0: Math.min(...keep.map((s) => s.x0)),
          x1: Math.max(...keep.map((s) => s.x1)),
          y0: Math.min(...keep.map((s) => s.y0)),
          y1: Math.max(...keep.map((s) => s.y1))
        })
      }
    }
    // 2. Tables without borders: text aligned in columns over several lines.
    const aligned = findAlignedTables(remaining, content.fills)
    elements.push(...aligned.tables)
    remaining = remaining.filter((l) => !aligned.used.has(l))
  }

  if (opts.positioned) remaining = remaining.flatMap(splitWideGaps)

  // 3. Vector artwork (charts, diagrams, shapes) becomes pictures.
  if (opts.pictures ?? opts.images !== false) {
    const tables = elements.filter((e): e is LTable => e.kind === 'table')
    for (const d of content.drawings) {
      const area = (d.x1 - d.x0) * (d.y1 - d.y0)
      // Cell shading of a table.
      if (tables.some((t) => overlap(d, t) > 0.5 * area)) continue
      const inside = remaining.filter((l) => {
        const cx = (l.x0 + l.x1) / 2
        const cy = (l.y0 + l.y1) / 2
        return cx >= d.x0 - 2 && cx <= d.x1 + 2 && cy >= d.y0 - 2 && cy <= d.y1 + 2
      })
      const chars = inside.reduce((n, l) => n + l.segments.reduce((k, sg) => k + segmentText(sg).length, 0), 0)
      let withText = false
      const box: [number, number, number, number] = [d.x0, d.y0, d.x1, d.y1]
      const claimed = new Set<XLine>(inside)
      if (!d.art) {
        // A coloured box behind text: keep the text editable and leave the box out.
        if (inside.length) continue
      } else if (chars <= 300) {
        // A chart or diagram with its labels: labels just outside the artwork belong to it too
        // (not next to what is cut from a scan: that text was recognized as text).
        const labels = remaining.filter(
          (l) =>
            !d.scan &&
            !inside.includes(l) &&
            l.x1 >= d.x0 - 6 &&
            l.x0 <= d.x1 + 6 &&
            l.y1 >= d.y0 - 6 &&
            l.y0 <= d.y1 + 6 &&
            l.segments.reduce((k, sg) => k + segmentText(sg).length, 0) <= 25
        )
        for (const l of labels) claimed.add(l)
        for (const l of claimed) {
          box[0] = Math.min(box[0], l.x0)
          box[1] = Math.min(box[1], l.y0)
          box[2] = Math.max(box[2], l.x1)
          box[3] = Math.max(box[3], l.y1)
        }
        withText = true
        remaining = remaining.filter((l) => !claimed.has(l))
      }
      // In reading order, the picture comes before the first text below its top.
      const after = textLines.find((l) => l.y0 >= box[1] - 2 && !claimed.has(l))
      const order = after ? after.block - 0.5 : Number.MAX_SAFE_INTEGER
      const pad = 1
      const clip: [number, number, number, number] = [
        Math.max(0, box[0] - pad),
        Math.max(0, box[1] - pad),
        Math.min(content.width, box[2] + pad),
        Math.min(content.height, box[3] + pad)
      ]
      elements.push({
        kind: 'image',
        image: { x0: clip[0], y0: clip[1], x1: clip[2], y1: clip[3], block: order, data: new Uint8Array(0), mime: 'image/png', width: 0, height: 0 },
        align: 'left',
        render: { pageIndex: content.index, clip, text: withText },
        x0: clip[0],
        y0: clip[1],
        x1: clip[2],
        y1: clip[3],
        order,
        spaceBefore: 0
      })
    }
  }

  // 4. Paragraphs, headings and list items.
  let cur: ParaBuilder | null = null
  const flush = () => {
    if (cur) elements.push(finishParagraph(cur, area, content.width, bodySize))
    cur = null
  }
  for (const src of remaining) {
    let marked = structure && !src.rotated ? detectMarker(src) : null
    // A numbered heading ("1. Background" in larger type) is a heading, not a list item.
    if (marked && marked.list.format !== 'bullet' && marked.line.size >= bodySize * 1.15) marked = null
    const line = marked ? marked.line : lineFromSegments(src.segments)
    if (!lineString(line).trim()) continue
    if (!cur || marked || startsNewParagraph(cur, line, src, area)) {
      flush()
      cur = {
        lines: [line],
        sources: [src],
        list: marked?.list,
        markerX: marked?.markerX,
        left: line.x0,
        right: line.x1,
        size: line.size,
        bold: allBold(line),
        block: src.block
      }
      continue
    }
    const p: ParaBuilder = cur
    p.lines.push(line)
    p.sources.push(src)
    if (p.lines.length === 2 && !p.list) p.left = line.x0
    else p.left = Math.min(p.left, line.x0)
    p.right = Math.max(p.right, line.x1)
  }
  flush()

  // 5. Images.
  if (opts.images !== false) {
    for (const img of content.images) {
      if (!img.data.length) continue
      const lgap = img.x0 - left
      const rgap = right - img.x1
      const align: Align = Math.abs(lgap - rgap) <= Math.max(8, 0.03 * (right - left)) && lgap > 12 ? 'center' : rgap < 4 && lgap > 24 ? 'right' : 'left'
      elements.push({ kind: 'image', image: img, align, x0: img.x0, y0: img.y0, x1: img.x1, y1: img.y1, order: img.block, spaceBefore: 0 })
    }
    // Drawings were aligned like images once their final place is known.
    for (const el of elements) {
      if (el.kind !== 'image' || !el.render) continue
      const lgap = el.x0 - left
      const rgap = right - el.x1
      el.align = Math.abs(lgap - rgap) <= Math.max(8, 0.03 * (right - left)) && lgap > 12 ? 'center' : rgap < 4 && lgap > 24 ? 'right' : 'left'
    }
  }

  // Reading order: MuPDF's block order, then top to bottom.
  elements.sort((a, b) => a.order - b.order || a.y0 - b.y0)
  numberLists(elements, left)
  attachRules(elements, content, usedRules, right - left)
  attachComments(elements, content.comments ?? [])
  let prevBottom: number | null = null
  let prev: LElement | null = null
  for (const el of elements) {
    const size = el.kind === 'paragraph' ? el.size : bodySize
    if (el.kind === 'paragraph' && prev?.kind === 'paragraph' && el.lines[0].baseline > prev.lines[prev.lines.length - 1].baseline) {
      // Between paragraphs, from baseline to baseline minus a normal line of the new paragraph.
      const step = el.lines[0].baseline - prev.lines[prev.lines.length - 1].baseline
      el.spaceBefore = Math.max(0, Math.min(72, step - 1.17 * el.size))
    } else if (prevBottom !== null && el.y0 > prevBottom) el.spaceBefore = Math.max(0, Math.min(72, el.y0 - prevBottom - 0.25 * size))
    prevBottom = prevBottom === null ? el.y1 : Math.max(prevBottom, el.y1)
    prev = el
  }
  const tops = elements.map((e) => e.y0)
  const bottoms = elements.map((e) => e.y1)
  // The left margin is where the text starts; table borders and pictures may stick out a little.
  const textual = elements.filter((e): e is LParagraph => e.kind === 'paragraph' && !e.list && e.align !== 'center' && e.align !== 'right')
  const lefts = (textual.length ? textual : elements).map((e) => e.x0)
  const rights = elements.map((e) => e.x1)
  const clampMargin = (v: number) => Math.max(18, Math.min(108, Math.round(v)))
  const margins = elements.length
    ? {
        left: clampMargin(Math.min(...lefts)),
        right: clampMargin(content.width - Math.max(...rights)),
        top: clampMargin(Math.min(...tops)),
        bottom: clampMargin(content.height - Math.max(...bottoms))
      }
    : { left: 72, right: 72, top: 72, bottom: 72 }
  // Indents were measured from the leftmost text; express them from the margin.
  for (const el of elements) if (el.kind === 'paragraph') el.indent = Math.max(0, el.indent + left - margins.left)
  const graphics = content.images.length > 0 || content.rules.length > 0 || content.fills.length > 0 || content.drawings.length > 0
  return {
    index: content.index,
    width: content.width,
    height: content.height,
    margins,
    elements,
    graphics,
    decorations: content.decorations ?? [],
    erase: content.erase ?? []
  }
}

/**
 * Long horizontal lines on their own (a line under a title, a separator) become borders of the
 * paragraph just above or below them.
 */
function attachRules(elements: LElement[], content: PageContent, used: Set<XRule>, contentWidth: number) {
  const paras = elements.filter((e): e is LParagraph => e.kind === 'paragraph')
  const inside = (r: XRule, b: { x0: number; y0: number; x1: number; y1: number }) => r.x0 >= b.x0 - 2 && r.x1 <= b.x1 + 2 && r.y0 >= b.y0 - 2 && r.y0 <= b.y1 + 2
  for (const r of content.rules) {
    if (r.dir !== 'h' || used.has(r) || r.x1 - r.x0 < 0.3 * contentWidth) continue
    if (content.drawings.some((d) => inside(r, d)) || elements.some((e) => e.kind !== 'paragraph' && inside(r, e))) continue
    const overlaps = (p: LParagraph) => Math.min(p.x1, r.x1) - Math.max(p.x0, r.x0) > 0
    const above = paras.filter((p) => overlaps(p) && p.y1 <= r.y0 + 2 && r.y0 - p.y1 <= 14).sort((a, b) => b.y1 - a.y1)[0]
    const border = { width: Math.max(0.25, Math.min(6, r.width)), color: r.color }
    if (above && !above.borderBottom) {
      above.borderBottom = { ...border, gap: Math.max(0, r.y0 - above.y1) }
      continue
    }
    const below = paras.filter((p) => overlaps(p) && p.y0 >= r.y0 - 2 && p.y0 - r.y0 <= 14).sort((a, b) => a.y0 - b.y0)[0]
    if (below && !below.borderTop) below.borderTop = { ...border, gap: Math.max(0, below.y0 - r.y0) }
  }
}

/** Each comment goes with the paragraph it was made on (or the nearest one). */
function attachComments(elements: LElement[], comments: XComment[]) {
  const paras = elements.filter((e): e is LParagraph => e.kind === 'paragraph')
  if (!paras.length) return
  const target = new Map<number, LParagraph>()
  for (const c of comments) {
    if (c.parent !== null) continue
    let best: LParagraph | null = null
    let score = -Infinity
    for (const p of paras) {
      const ov = overlap(c, p)
      // Overlap wins; otherwise the nearest paragraph (vertical distance first).
      const dy = c.y0 > p.y1 ? c.y0 - p.y1 : p.y0 > c.y1 ? p.y0 - c.y1 : 0
      const dx = c.x0 > p.x1 ? c.x0 - p.x1 : p.x0 > c.x1 ? p.x0 - c.x1 : 0
      const sc = ov > 0 ? ov : -(dy * 4 + dx)
      if (sc > score) {
        score = sc
        best = p
      }
    }
    if (best) target.set(c.id, best)
  }
  for (const c of comments) {
    const p = target.get(c.parent ?? c.id)
    if (!p) continue
    ;(p.comments ??= []).push(c)
  }
}

/** Nesting depth of list items from their indentation; item values continue across items. */
function numberLists(elements: LElement[], left: number) {
  const levels: number[] = []
  for (const el of elements) {
    if (el.kind !== 'paragraph' || !el.list) {
      if (el.kind !== 'paragraph' || el.role !== 'list') levels.length = 0
      continue
    }
    const x = el.x0 - left
    let depth = levels.findIndex((lx) => Math.abs(lx - x) <= 4)
    if (depth < 0) {
      levels.push(x)
      levels.sort((a, b) => a - b)
      depth = levels.indexOf(x)
    }
    el.list.depth = Math.min(depth, 8)
  }
}

/** Heading levels for the whole document: the largest heading size is level 1. */
export function assignHeadings(pages: LPage[], structure = true) {
  const paras = pages.flatMap((p) => p.elements.filter((e): e is LParagraph => e.kind === 'paragraph'))
  if (!structure) return
  const sizes = cluster(
    paras.filter((p) => p.headingCandidate).map((p) => p.size),
    0.6
  ).sort((a, b) => b - a)
  for (const p of paras) {
    if (!p.headingCandidate) continue
    const i = sizes.findIndex((s) => Math.abs(s - p.size) <= 0.6)
    p.role = 'heading'
    p.level = Math.min(4, (i < 0 ? sizes.length : i) + 1)
  }
}

export function analyzeDocument(contents: PageContent[], opts: LayoutOptions = {}): DocLayout {
  const bodySize = bodyTextSize(contents)
  const pages = contents.map((c) => analyzePage(c, bodySize, opts))
  assignHeadings(pages, opts.structure !== false)
  return { pages, bodySize }
}

/** Text of a table cell, lines joined. */
export function cellText(cell: LCell): string {
  return plainText(flowRuns(cell.lines)).trim()
}

/** Pictures of vector artwork to render from the pages (see LImage.render). */
export function pendingPictures(layout: DocLayout): LImage[] {
  return layout.pages.flatMap((p) => p.elements.filter((e): e is LImage => e.kind === 'image' && !!e.render && !e.image.data.length))
}
