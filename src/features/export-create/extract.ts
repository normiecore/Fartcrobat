/**
 * Engine side of Export: reads the structure of a page (styled text, images, ruled lines, filled
 * boxes, links) into plain data for the layout analysis and the document builders.
 */
import type * as MuPDF from 'mupdf'
import type { Session } from '@engine/session'
import {
  FONT_BOLD,
  FONT_ITALIC,
  FONT_MONO,
  FONT_SERIF,
  type PageContent,
  type XComment,
  type XDrawing,
  type XFill,
  type XImage,
  type XLine,
  type XLink,
  type XRule,
  type XRun,
  type XSegment
} from './content'

type Mupdf = Session['mupdf']
type Matrix = [number, number, number, number, number, number]
type Rect = [number, number, number, number]

export interface ExtractOptions {
  /** Include the pixels of images (encoded PNG/JPEG); otherwise only where they are. */
  images?: boolean
  /** Images are downsampled above this resolution (pixels per inch at their size on the page). */
  maxImageDpi?: number
}

/** Stop collecting vector paths after this many (maps and charts can hold hundreds of thousands). */
const MAX_PATHS = 20000

export function colorToInt(c: ArrayLike<number> | undefined): number {
  if (!c || c.length === 0) return 0
  let r: number, g: number, b: number
  if (c.length === 1) r = g = b = c[0]
  else if (c.length === 4) {
    r = (1 - c[0]) * (1 - c[3])
    g = (1 - c[1]) * (1 - c[3])
    b = (1 - c[2]) * (1 - c[3])
  } else [r, g, b] = [c[0], c[1], c[2]]
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
  return (to(r) << 16) | (to(g) << 8) | to(b)
}

function luminance(color: number): number {
  const r = (color >> 16) & 255
  const g = (color >> 8) & 255
  const b = color & 255
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

// ---- vector paths -------------------------------------------------------------------------

interface PathPoint {
  x: number
  y: number
  move: boolean
}

function walkPath(path: MuPDF.Path, ctm: Matrix): { points: PathPoint[]; curved: boolean; bbox: Rect | null } {
  const points: PathPoint[] = []
  let curved = false
  let start: PathPoint | null = null
  let bbox: Rect | null = null
  const grow = (x: number, y: number) => {
    if (!bbox) bbox = [x, y, x, y]
    else {
      bbox[0] = Math.min(bbox[0], x)
      bbox[1] = Math.min(bbox[1], y)
      bbox[2] = Math.max(bbox[2], x)
      bbox[3] = Math.max(bbox[3], y)
    }
  }
  path.walk({
    moveTo(x, y) {
      const [px, py] = apply(ctm, x, y)
      start = { x: px, y: py, move: true }
      points.push(start)
      grow(px, py)
    },
    lineTo(x, y) {
      const [px, py] = apply(ctm, x, y)
      points.push({ x: px, y: py, move: false })
      grow(px, py)
    },
    curveTo(x1, y1, x2, y2, x3, y3) {
      curved = true
      // Control points bound the curve.
      for (const [x, y] of [
        [x1, y1],
        [x2, y2],
        [x3, y3]
      ]) {
        const [px, py] = apply(ctm, x, y)
        grow(px, py)
      }
      const [ex, ey] = apply(ctm, x3, y3)
      points.push({ x: ex, y: ey, move: false })
    },
    closePath() {
      if (start) points.push({ x: start.x, y: start.y, move: false })
    }
  })
  return { points, curved, bbox }
}

/** An axis-aligned rectangle when the points describe one (4 or 5 points, one subpath). */
function asRectangle(points: PathPoint[]): Rect | null {
  if (points.length < 4 || points.length > 5 || points.slice(1).some((p) => p.move)) return null
  const xs = [...new Set(points.map((p) => Math.round(p.x * 10)))]
  const ys = [...new Set(points.map((p) => Math.round(p.y * 10)))]
  if (xs.length > 2 || ys.length > 2) return null
  const x = points.map((p) => p.x)
  const y = points.map((p) => p.y)
  for (let i = 1; i < points.length; i++) {
    const dx = Math.abs(points[i].x - points[i - 1].x)
    const dy = Math.abs(points[i].y - points[i - 1].y)
    if (dx > 0.1 && dy > 0.1) return null
  }
  return [Math.min(...x), Math.min(...y), Math.max(...x), Math.max(...y)]
}

/** Groups overlapping or nearby boxes into areas. */
export function clusterBoxes(boxes: Rect[], gap: number): Rect[] {
  let list = boxes.map((b) => [...b] as Rect)
  let merged = true
  while (merged) {
    merged = false
    const out: Rect[] = []
    for (const b of list) {
      const hit = out.find((o) => b[0] <= o[2] + gap && b[2] >= o[0] - gap && b[1] <= o[3] + gap && b[3] >= o[1] - gap)
      if (hit) {
        hit[0] = Math.min(hit[0], b[0])
        hit[1] = Math.min(hit[1], b[1])
        hit[2] = Math.max(hit[2], b[2])
        hit[3] = Math.max(hit[3], b[3])
        merged = true
      } else out.push(b)
    }
    list = out
  }
  return list
}

interface Vectors {
  rules: XRule[]
  fills: XFill[]
  drawings: XDrawing[]
}

function collectVectors(s: Session, pageIndex: number, width: number, height: number): Vectors {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const rules: XRule[] = []
  const fills: XFill[] = []
  const art: Rect[] = []
  const artFlags: boolean[] = []
  let count = 0
  const addRule = (x0: number, y0: number, x1: number, y1: number, w: number, color: number): boolean => {
    const dx = Math.abs(x1 - x0)
    const dy = Math.abs(y1 - y0)
    if (dy <= 1 && dx >= 2) {
      const y = (y0 + y1) / 2
      rules.push({ x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: y, y1: y, dir: 'h', width: w, color })
      return true
    }
    if (dx <= 1 && dy >= 2) {
      const x = (x0 + x1) / 2
      rules.push({ x0: x, x1: x, y0: Math.min(y0, y1), y1: Math.max(y0, y1), dir: 'v', width: w, color })
      return true
    }
    return dx < 2 && dy < 2
  }
  const dev = new m.Device({
    fillPath(path, _evenOdd, ctm, _cs, color, alpha) {
      if (++count > MAX_PATHS || alpha < 0.05) return
      const c = colorToInt(color)
      const white = luminance(c) > 0.97
      const { points, curved, bbox } = walkPath(path, ctm as Matrix)
      if (!bbox) return
      const r = curved ? null : asRectangle(points)
      if (!r) {
        if (!white) art.push(bbox)
        if (!white) artFlags.push(true)
        return
      }
      if (white) return
      const w = r[2] - r[0]
      const h = r[3] - r[1]
      if (h <= 2.5 && w >= 2) rules.push({ x0: r[0], x1: r[2], y0: (r[1] + r[3]) / 2, y1: (r[1] + r[3]) / 2, dir: 'h', width: h, color: c })
      else if (w <= 2.5 && h >= 2) rules.push({ x0: (r[0] + r[2]) / 2, x1: (r[0] + r[2]) / 2, y0: r[1], y1: r[3], dir: 'v', width: w, color: c })
      else if (w > 2.5 && h > 2.5) {
        fills.push({ x0: r[0], y0: r[1], x1: r[2], y1: r[3], color: c })
        art.push(r)
        artFlags.push(false)
      }
    },
    strokePath(path, stroke, ctm, _cs, color, alpha) {
      if (++count > MAX_PATHS || alpha < 0.05) return
      const c = colorToInt(color)
      if (luminance(c) > 0.97) return
      const { points, curved, bbox } = walkPath(path, ctm as Matrix)
      const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 1
      const w = stroke.getLineWidth() * scale
      let other = curved
      for (let i = 1; i < points.length; i++) {
        if (points[i].move) continue
        if (!addRule(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, w, c)) other = true
      }
      if (other && bbox) {
        art.push([bbox[0] - w / 2, bbox[1] - w / 2, bbox[2] + w / 2, bbox[3] + w / 2])
        artFlags.push(true)
      }
    },
    fillShade(shade, ctm) {
      if (++count > MAX_PATHS) return
      try {
        const b = shade.getBounds() as Rect
        const pts = [apply(ctm as Matrix, b[0], b[1]), apply(ctm as Matrix, b[2], b[3]), apply(ctm as Matrix, b[0], b[3]), apply(ctm as Matrix, b[2], b[1])]
        const xs = pts.map((p) => p[0])
        const ys = pts.map((p) => p[1])
        const r: Rect = [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.min(width, Math.max(...xs)), Math.min(height, Math.max(...ys))]
        if (r[2] > r[0] && r[3] > r[1]) {
          art.push(r)
          artFlags.push(true)
        }
      } catch {}
    }
  })
  try {
    page.runPageContents(dev, m.Matrix.identity)
    dev.close()
  } finally {
    dev.destroy()
  }
  const pageArea = width * height
  const drawings = clusterBoxes(art, 6)
    .map((r): Rect => [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(width, r[2]), Math.min(height, r[3])])
    // Slivers and page-filling backgrounds are not pictures.
    .filter((r) => r[2] - r[0] >= 8 && r[3] - r[1] >= 8 && (r[2] - r[0]) * (r[3] - r[1]) >= 150 && (r[2] - r[0]) * (r[3] - r[1]) < 0.85 * pageArea)
    .map((r) => ({
      x0: r[0],
      y0: r[1],
      x1: r[2],
      y1: r[3],
      art: art.some((a, i) => artFlags[i] && a[0] >= r[0] - 1 && a[1] >= r[1] - 1 && a[2] <= r[2] + 1 && a[3] <= r[3] + 1)
    }))
  return { rules: mergeRules(rules), fills, drawings }
}

/** Joins collinear rules that touch (borders drawn cell by cell) and drops duplicates. */
export function mergeRules(rules: XRule[]): XRule[] {
  const out: XRule[] = []
  for (const dir of ['h', 'v'] as const) {
    const list = rules
      .filter((r) => r.dir === dir)
      .map((r) => ({ ...r }))
      .sort((a, b) => (dir === 'h' ? a.y0 - b.y0 || a.x0 - b.x0 : a.x0 - b.x0 || a.y0 - b.y0))
    let cur: XRule | null = null
    for (const r of list) {
      if (cur) {
        const sameLine = dir === 'h' ? Math.abs(r.y0 - cur.y0) <= 1 : Math.abs(r.x0 - cur.x0) <= 1
        const touches = dir === 'h' ? r.x0 <= cur.x1 + 1.5 : r.y0 <= cur.y1 + 1.5
        if (sameLine && touches) {
          if (dir === 'h') cur.x1 = Math.max(cur.x1, r.x1)
          else cur.y1 = Math.max(cur.y1, r.y1)
          cur.width = Math.max(cur.width, r.width)
          continue
        }
        out.push(cur)
      }
      cur = r
    }
    if (cur) out.push(cur)
  }
  return out
}

// ---- text ---------------------------------------------------------------------------------

export interface RawChar {
  c: string
  x0: number
  x1: number
  y0: number
  y1: number
  oy: number
  font: string
  size: number
  color: number
  flags: number
  link: string | undefined
  underline?: boolean
  strike?: boolean
}

export interface RawLine {
  block: number
  bbox: Rect
  rotated: boolean
  chars: RawChar[]
}

const SPACES = new Set([' ', '\t', '\u00a0', '\u2002', '\u2003', '\u2009', '\u202f'])

function isSpace(c: string) {
  return SPACES.has(c)
}

function sameStyle(a: RawChar, b: RawChar) {
  return (
    a.font === b.font &&
    Math.abs(a.size - b.size) < 0.05 &&
    a.color === b.color &&
    a.flags === b.flags &&
    a.link === b.link &&
    !!a.underline === !!b.underline &&
    !!a.strike === !!b.strike
  )
}

/** Splits a line's characters into segments at large gaps and trims surrounding spaces. */
function lineSegments(line: RawLine): XSegment[] {
  const groups: RawChar[][] = []
  let cur: RawChar[] = []
  let lastInk: RawChar | null = null
  for (const ch of line.chars) {
    if (!line.rotated && lastInk && !isSpace(ch.c)) {
      const gap = ch.x0 - lastInk.x1
      if (gap > Math.max(2.2 * Math.max(ch.size, lastInk.size), 18) && !cur.slice(cur.indexOf(lastInk) + 1).some((c) => isSpace(c.c))) {
        groups.push(cur)
        cur = []
      }
    }
    cur.push(ch)
    if (!isSpace(ch.c)) lastInk = ch
  }
  groups.push(cur)
  const out: XSegment[] = []
  for (const g of groups) {
    let a = 0
    let b = g.length
    while (a < b && isSpace(g[a].c)) a++
    while (b > a && isSpace(g[b - 1].c)) b--
    const chars = g.slice(a, b)
    if (!chars.length) continue
    const runs: XRun[] = []
    let run: XRun | null = null
    let prev: RawChar | null = null
    for (const ch of chars) {
      if (!run || !prev || !sameStyle(prev, ch)) {
        run = {
          text: '',
          font: ch.font,
          size: ch.size,
          color: ch.color,
          flags: ch.flags,
          x0: ch.x0,
          x1: ch.x1,
          ...(ch.link ? { link: ch.link } : {}),
          ...(ch.underline ? { underline: true } : {}),
          ...(ch.strike ? { strike: true } : {})
        }
        runs.push(run)
      }
      run.text += isSpace(ch.c) ? ' ' : ch.c
      run.x1 = Math.max(run.x1, ch.x1)
      prev = ch
    }
    const ink = chars.filter((c) => !isSpace(c.c))
    const first = ink[0] ?? chars[0]
    out.push({
      x0: Math.min(...chars.map((c) => c.x0)),
      x1: Math.max(...chars.map((c) => c.x1)),
      y0: line.rotated ? Math.min(...chars.map((c) => c.y0)) : line.bbox[1],
      y1: line.rotated ? Math.max(...chars.map((c) => c.y1)) : line.bbox[3],
      baseline: first.oy,
      runs
    })
  }
  return out
}

function dominantSize(segments: XSegment[]): number {
  const weight = new Map<number, number>()
  for (const s of segments) {
    for (const r of s.runs) {
      const k = Math.round(r.size * 2) / 2
      weight.set(k, (weight.get(k) ?? 0) + r.text.length)
    }
  }
  let best = 0
  let bestW = -1
  for (const [k, w] of weight) {
    if (w > bestW) {
      best = k
      bestW = w
    }
  }
  return best || 10
}

function makeLine(block: number, rotated: boolean, segments: XSegment[]): XLine {
  segments.sort((a, b) => a.x0 - b.x0)
  const size = dominantSize(segments)
  // The baseline of the line is the one of its largest text.
  const main = segments.reduce((best, s) => (s.runs[0].size > best.runs[0].size ? s : best), segments[0])
  return {
    x0: Math.min(...segments.map((s) => s.x0)),
    y0: Math.min(...segments.map((s) => s.y0)),
    x1: Math.max(...segments.map((s) => s.x1)),
    y1: Math.max(...segments.map((s) => s.y1)),
    baseline: main.baseline,
    size,
    block,
    rotated,
    segments
  }
}

function sameRow(a: { baseline: number; size: number; y0: number; y1: number }, b: { baseline: number; size: number; y0: number; y1: number }) {
  const tol = 0.3 * Math.min(a.size, b.size)
  const overlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return Math.abs(a.baseline - b.baseline) <= tol && overlap > 0
}

/** Groups the segments of each block into rows; merges one-row blocks that share a baseline. */
export function buildLines(rawLines: RawLine[]): XLine[] {
  const byBlock = new Map<number, RawLine[]>()
  for (const l of rawLines) {
    const list = byBlock.get(l.block)
    if (list) list.push(l)
    else byBlock.set(l.block, [l])
  }
  const lines: XLine[] = []
  for (const [block, raws] of byBlock) {
    const rows: { rotated: boolean; segments: XSegment[]; baseline: number; size: number; y0: number; y1: number }[] = []
    for (const raw of raws) {
      for (const seg of lineSegments(raw)) {
        const size = dominantSize([seg])
        const row = raw.rotated ? undefined : rows.find((r) => !r.rotated && sameRow(r, { baseline: seg.baseline, size, y0: seg.y0, y1: seg.y1 }))
        if (row) {
          row.segments.push(seg)
          row.y0 = Math.min(row.y0, seg.y0)
          row.y1 = Math.max(row.y1, seg.y1)
        } else rows.push({ rotated: raw.rotated, segments: [seg], baseline: seg.baseline, size, y0: seg.y0, y1: seg.y1 })
      }
    }
    for (const r of rows) lines.push(makeLine(block, r.rotated, r.segments))
  }
  // Blocks made of a single row (a bullet and its text, cells of a table row) that sit on the same
  // baseline belong to one visual line.
  const rowsPerBlock = new Map<number, number>()
  for (const l of lines) rowsPerBlock.set(l.block, (rowsPerBlock.get(l.block) ?? 0) + 1)
  const out: XLine[] = []
  for (const l of lines) {
    if (!l.rotated && rowsPerBlock.get(l.block) === 1) {
      const host = out.find(
        (o) => !o.rotated && rowsPerBlock.get(o.block) === 1 && sameRow(o, l) && (l.x0 >= o.x1 - 1 || l.x1 <= o.x0 + 1)
      )
      if (host) {
        const merged = makeLine(host.block, false, [...host.segments, ...l.segments])
        out[out.indexOf(host)] = merged
        continue
      }
    }
    out.push(l)
  }
  return out
}

/**
 * Marks the characters drawn over an underline or crossed by a strike-through line (so only those
 * words get the style) and returns the rules used for that: they are not table borders.
 */
export function decorateChars(lines: RawLine[], rules: XRule[]): Set<XRule> {
  const used = new Set<XRule>()
  const hRules = rules.filter((r) => r.dir === 'h' && r.width <= 3)
  if (!hRules.length) return used
  for (const line of lines) {
    if (line.rotated || !line.chars.length) continue
    const near = hRules.filter((r) => r.y0 >= line.bbox[1] - 2 && r.y0 <= line.bbox[3] + 4)
    for (const r of near) {
      const covered = line.chars.filter((ch) => !isSpace(ch.c) && (ch.x0 + ch.x1) / 2 >= r.x0 - 0.5 && (ch.x0 + ch.x1) / 2 <= r.x1 + 0.5)
      if (!covered.length) continue
      const x0 = Math.min(...covered.map((c) => c.x0))
      const x1 = Math.max(...covered.map((c) => c.x1))
      const size = covered[0].size
      // A border running far past the text it touches is not an underline.
      if (r.x1 - r.x0 > (x1 - x0) * 1.6 + 2 * size) continue
      const dy = r.y0 - covered[0].oy
      const underline = dy >= -0.05 * size && dy <= 0.3 * size + 1
      const strike = !underline && dy <= -0.15 * size && dy >= -0.45 * size
      if (!underline && !strike) continue
      used.add(r)
      for (const ch of line.chars) {
        const cx = (ch.x0 + ch.x1) / 2
        if (cx < x0 || cx > x1) continue
        if (underline) ch.underline = true
        else ch.strike = true
      }
    }
  }
  return used
}

// ---- images -------------------------------------------------------------------------------

interface EncodedImage {
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  width: number
  height: number
}

/** Looks at a sample of pixels: many distinct colours means a photo (JPEG), few means a graphic (PNG). */
function looksLikePhoto(pixels: Uint8ClampedArray, n: number, count: number): boolean {
  if (count < 40000) return false
  const seen = new Set<number>()
  const step = Math.max(1, Math.floor(count / 4096))
  for (let i = 0; i < count; i += step) {
    const o = i * n
    const key = n >= 3 ? (pixels[o] << 16) | (pixels[o + 1] << 8) | pixels[o + 2] : pixels[o]
    seen.add(key)
    if (seen.size > 512) return true
  }
  return false
}

function encodePixmap(pix: MuPDF.Pixmap, hasAlpha: boolean): EncodedImage {
  const w = pix.getWidth()
  const h = pix.getHeight()
  const n = pix.getNumberOfComponents()
  let data: Uint8Array
  let mime: EncodedImage['mime'] = 'image/png'
  if (!hasAlpha && looksLikePhoto(pix.getPixels(), n + pix.getAlpha(), w * h)) {
    data = pix.asJPEG(90).slice()
    mime = 'image/jpeg'
  } else data = pix.asPNG().slice()
  return { data, mime, width: w, height: h }
}

/**
 * Copies `src` (no alpha) into a new pixmap turned the way the image appears on the page, with
 * the soft mask (if any) as alpha. `uAlongX`: image columns run along the page's x axis.
 */
function orientPixmap(
  m: Mupdf,
  src: MuPDF.Pixmap,
  mask: MuPDF.Pixmap | null,
  t: Matrix,
  uAlongX: boolean
): MuPDF.Pixmap {
  const sw = src.getWidth()
  const sh = src.getHeight()
  const n = src.getNumberOfComponents()
  const ow = uAlongX ? sw : sh
  const oh = uAlongX ? sh : sw
  const cs = n === 1 ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB
  const out = new m.Pixmap(cs, [0, 0, ow, oh], !!mask)
  const on = n + (mask ? 1 : 0)
  const ostride = out.getStride()
  const sstride = src.getStride()
  const flipU = uAlongX ? t[0] < 0 : t[1] < 0
  const flipV = uAlongX ? t[3] < 0 : t[2] < 0
  const sp = src.getPixels()
  const mp = mask ? mask.getPixels() : null
  const mstride = mask ? mask.getStride() : 0
  const op = out.getPixels()
  for (let v = 0; v < sh; v++) {
    for (let u = 0; u < sw; u++) {
      const uu = flipU ? sw - 1 - u : u
      const vv = flipV ? sh - 1 - v : v
      const ox = uAlongX ? uu : vv
      const oy = uAlongX ? vv : uu
      const so = v * sstride + u * n
      const oo = oy * ostride + ox * on
      for (let k = 0; k < n; k++) op[oo + k] = sp[so + k]
      if (mp) op[oo + n] = mp[v * mstride + u]
    }
  }
  return out
}

function extractImage(
  s: Session,
  pageIndex: number,
  bbox: Rect,
  t: Matrix,
  image: MuPDF.Image,
  maxDpi: number
): EncodedImage | null {
  const m = s.mupdf
  const wPt = bbox[2] - bbox[0]
  const hPt = bbox[3] - bbox[1]
  const axisAligned = (Math.abs(t[1]) < 1e-3 && Math.abs(t[2]) < 1e-3) || (Math.abs(t[0]) < 1e-3 && Math.abs(t[3]) < 1e-3)
  if (!axisAligned || image.getImageMask()) {
    // Skewed images and stencil masks: take the page area as it looks.
    const pix = renderArea(s, pageIndex, Math.min(maxDpi, 200), { clip: bbox })
    try {
      return encodePixmap(pix, false)
    } finally {
      pix.destroy()
    }
  }
  const uAlongX = Math.abs(t[1]) < 1e-3
  const toFree: MuPDF.Pixmap[] = []
  try {
    const raw = image.toPixmap()
    toFree.push(raw)
    const rawCs = raw.getColorSpace()
    const gray = !!rawCs && rawCs.isGray()
    let base = raw
    if (raw.getAlpha() || !rawCs || !(rawCs.isGray() || rawCs.isRGB()) || rawCs.getType() === 'BGR') {
      base = raw.convertToColorSpace(gray ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB, false)
      toFree.push(base)
    }
    let maskPix: MuPDF.Pixmap | null = null
    const maskImage = image.getMask()
    if (maskImage) {
      let mp = maskImage.toPixmap()
      toFree.push(mp)
      if (mp.getNumberOfComponents() !== 1 || mp.getAlpha()) {
        mp = mp.convertToColorSpace(m.ColorSpace.DeviceGray, false)
        toFree.push(mp)
      }
      if (mp.getWidth() !== base.getWidth() || mp.getHeight() !== base.getHeight()) {
        const mw = mp.getWidth()
        const mh = mp.getHeight()
        mp = mp.warp(
          [
            [0, 0],
            [mw, 0],
            [mw, mh],
            [0, mh]
          ],
          base.getWidth(),
          base.getHeight()
        )
        toFree.push(mp)
      }
      maskPix = mp
    }
    let pix = base
    const upright = uAlongX && t[0] > 0 && t[3] > 0
    if (!upright || maskPix) {
      pix = orientPixmap(m, base, maskPix, t, uAlongX)
      toFree.push(pix)
    }
    // Downsample images far sharper than needed at their size on the page.
    const dpi = (pix.getWidth() / Math.max(1, wPt)) * 72
    if (dpi > maxDpi * 1.5 && wPt > 0 && hPt > 0) {
      const tw = Math.max(1, Math.round((wPt / 72) * maxDpi))
      const th = Math.max(1, Math.round((hPt / 72) * maxDpi))
      const pw = pix.getWidth()
      const ph = pix.getHeight()
      pix = pix.warp(
        [
          [0, 0],
          [pw, 0],
          [pw, ph],
          [0, ph]
        ],
        tw,
        th
      )
      toFree.push(pix)
    }
    return encodePixmap(pix, !!maskPix)
  } finally {
    for (const p of toFree) {
      try {
        p.destroy()
      } catch {}
    }
  }
}

// ---- page ---------------------------------------------------------------------------------

function fontInfo(font: MuPDF.Font): { name: string; flags: number } {
  let name = ''
  let flags = 0
  try {
    name = font.getName()
    if (font.isBold()) flags |= FONT_BOLD
    if (font.isItalic()) flags |= FONT_ITALIC
    if (font.isMono()) flags |= FONT_MONO
    if (font.isSerif()) flags |= FONT_SERIF
  } catch {}
  name = name.replace(/^[A-Z]{6}\+/, '')
  if (/bold|black|heavy|semibold|demi/i.test(name)) flags |= FONT_BOLD
  if (/italic|oblique/i.test(name)) flags |= FONT_ITALIC
  if (/courier|mono|consol/i.test(name)) flags |= FONT_MONO
  return { name, flags }
}

function readLinks(s: Session, pageIndex: number): XLink[] {
  const out: XLink[] = []
  try {
    for (const link of s.page(pageIndex).getLinks()) {
      try {
        const uri = link.getURI()
        if (uri && link.isExternal() && /^(https?|mailto|ftp|tel):/i.test(uri)) out.push({ rect: link.getBounds() as Rect, uri })
      } catch {}
    }
  } catch {}
  return out
}

/** Kinds of comments exported as Word comments (text boxes are already part of the page text). */
const COMMENT_TYPES = new Set(['Text', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Square', 'Circle', 'Line', 'Polygon', 'PolyLine', 'Ink', 'Stamp', 'Caret', 'FileAttachment', 'Sound', 'Redact'])

const TYPE_NAMES: Record<string, string> = {
  Text: 'Note',
  StrikeOut: 'Strikethrough',
  Square: 'Rectangle',
  Circle: 'Oval',
  PolyLine: 'Polyline',
  Ink: 'Drawing',
  Caret: 'Inserted text',
  FileAttachment: 'Attachment'
}

export function readComments(s: Session, pageIndex: number): XComment[] {
  const out: XComment[] = []
  let annots: MuPDF.PDFAnnotation[]
  try {
    annots = s.page(pageIndex).getAnnotations()
  } catch {
    return out
  }
  const index = new Map<number, number>()
  annots.forEach((a, i) => {
    try {
      const o = a.getObject()
      if (o.isIndirect()) index.set(o.asIndirect(), i)
    } catch {}
  })
  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch {
      return fallback
    }
  }
  const all = annots.map((a, i) => {
    const type = String(safe(() => a.getType(), ''))
    const irt = safe(() => a.getObject().get('IRT'), null)
    const parent = irt && irt.isIndirect() ? (index.get(irt.asIndirect()) ?? null) : null
    const rect = safe(() => a.getBounds() as Rect, [0, 0, 0, 0] as Rect)
    const date = safe(() => a.getModificationDate(), null) ?? safe(() => a.getCreationDate(), null)
    return {
      id: i,
      parent,
      x0: rect[0],
      y0: rect[1],
      x1: rect[2],
      y1: rect[3],
      type,
      author: safe(() => a.getAuthor(), '') || '',
      text: (safe(() => a.getContents(), '') || '').trim(),
      date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null
    }
  })
  const hasReplies = new Set(all.filter((c) => c.parent !== null && c.text).map((c) => c.parent))
  for (const c of all) {
    if (c.parent !== null) {
      // A reply goes with its comment.
      if (c.text && all[c.parent] && (COMMENT_TYPES.has(all[c.parent].type) || all[c.parent].type === 'FreeText')) out.push(c)
      continue
    }
    if (!COMMENT_TYPES.has(c.type) && !(c.type === 'FreeText' && hasReplies.has(c.id))) continue
    if (!c.text && !hasReplies.has(c.id)) continue
    out.push({ ...c, text: c.text || TYPE_NAMES[c.type] || c.type })
  }
  return out
}

export function extractPageContent(s: Session, pageIndex: number, opts: ExtractOptions = {}): PageContent {
  const page = s.page(pageIndex)
  const bounds = page.getBounds() as Rect
  const width = bounds[2] - bounds[0]
  const height = bounds[3] - bounds[1]
  const links = readLinks(s, pageIndex)
  const linkAt = (x: number, y: number) => {
    for (const l of links) if (x >= l.rect[0] && x <= l.rect[2] && y >= l.rect[1] && y <= l.rect[3]) return l.uri
    return undefined
  }
  const maxDpi = opts.maxImageDpi ?? 300
  const rawLines: RawLine[] = []
  const images: XImage[] = []
  const fonts = new Map<number, { name: string; flags: number }>()
  let blockIndex = 0
  let current: RawLine | null = null
  // Through a display list with the "extras" so filled-in form fields and comments that show
  // text (text boxes, stamps) come along, as they appear on the page.
  const list = page.toDisplayList(true)
  const stext = list.toStructuredText('preserve-whitespace,preserve-images')
  try {
    stext.walk({
      onImageBlock(bbox, transform, image) {
        const block = blockIndex++
        const b = bbox as Rect
        const w = b[2] - b[0]
        const h = b[3] - b[1]
        // Skip slivers and images entirely off the page.
        if (w < 3 || h < 3 || w * h < 36 || b[2] <= 0 || b[3] <= 0 || b[0] >= width || b[1] >= height) return
        if (opts.images === false) {
          // Where the images are, without their pixels.
          images.push({ x0: b[0], y0: b[1], x1: b[2], y1: b[3], block, data: new Uint8Array(0), mime: 'image/png', width: 0, height: 0 })
          return
        }
        try {
          const enc = extractImage(s, pageIndex, b, transform as Matrix, image, maxDpi)
          if (enc) images.push({ x0: b[0], y0: b[1], x1: b[2], y1: b[3], block, ...enc })
        } catch (err) {
          console.warn('[export] image skipped', err)
        }
      },
      beginTextBlock() {},
      beginLine(bbox, _wmode, dir) {
        current = {
          block: blockIndex,
          bbox: bbox as Rect,
          rotated: Math.abs(dir[0] - 1) > 0.05 || Math.abs(dir[1]) > 0.05,
          chars: []
        }
        rawLines.push(current)
      },
      onChar(c, origin, font, size, quad, color) {
        if (!current) return
        const key = (font as unknown as { pointer: number }).pointer
        let info = fonts.get(key)
        if (!info) {
          info = fontInfo(font)
          fonts.set(key, info)
        }
        const q = quad as number[]
        const x0 = Math.min(q[0], q[2], q[4], q[6])
        const x1 = Math.max(q[0], q[2], q[4], q[6])
        const y0 = Math.min(q[1], q[3], q[5], q[7])
        const y1 = Math.max(q[1], q[3], q[5], q[7])
        current.chars.push({
          c,
          x0,
          x1,
          y0,
          y1,
          oy: origin[1],
          font: info.name,
          size,
          color: colorToInt(color as number[]),
          flags: info.flags,
          link: links.length ? linkAt((x0 + x1) / 2, (y0 + y1) / 2) : undefined
        })
      },
      endLine() {
        current = null
      },
      endTextBlock() {
        blockIndex++
      }
    })
  } finally {
    stext.destroy()
    list.destroy()
  }
  const vectors = collectVectors(s, pageIndex, width, height)
  const textLines = rawLines.filter((l) => l.chars.some((c) => !isSpace(c.c)))
  const decorations = decorateChars(textLines, vectors.rules)
  const rules = vectors.rules.filter((r) => !decorations.has(r))
  const lines = buildLines(textLines)
  const decorationBoxes = [...decorations].map((r): [number, number, number, number] => [r.x0, r.y0 - r.width / 2, r.x1, r.y1 + r.width / 2])
  return {
    index: pageIndex,
    width,
    height,
    lines,
    images,
    rules,
    fills: vectors.fills,
    drawings: vectors.drawings,
    links,
    decorations: decorationBoxes,
    comments: readComments(s, pageIndex)
  }
}

// ---- rendering without text (PowerPoint backgrounds) --------------------------------------

/**
 * A device that passes everything except visible text to `target`: the page as a background
 * picture for editable text boxes. Text that only clips or builds a mask is kept.
 */
export function withoutTextDevice(m: Mupdf, target: MuPDF.Device, skipLines: Rect[] = []): MuPDF.Device {
  let maskDepth = 0
  const t = target as any
  /** Underlines and strike-through lines of the text are left out too (the text boxes draw their own). */
  const skip = (path: MuPDF.Path, ctm: Matrix) => {
    if (!skipLines.length || maskDepth > 0) return false
    const b = walkPath(path, ctm).bbox
    if (!b || b[3] - b[1] > 3.5) return false
    const w = Math.max(0.1, b[2] - b[0])
    return skipLines.some((r) => Math.abs((b[1] + b[3]) / 2 - (r[1] + r[3]) / 2) <= 1.5 && Math.min(b[2], r[2]) - Math.max(b[0], r[0]) >= 0.8 * w)
  }
  const callbacks: Record<string, (...args: any[]) => any> = {
    fillPath: (p, eo, ctm, cs, color, alpha) => {
      if (!skip(p, ctm)) t.fillPath(p, eo, ctm, cs, color, alpha)
    },
    strokePath: (p, st, ctm, cs, color, alpha) => {
      if (!skip(p, ctm)) t.strokePath(p, st, ctm, cs, color, alpha)
    },
    clipPath: (p, eo, ctm) => t.clipPath(p, eo, ctm),
    clipStrokePath: (p, st, ctm) => t.clipStrokePath(p, st, ctm),
    fillText: (text, ctm, cs, color, alpha) => {
      if (maskDepth > 0) t.fillText(text, ctm, cs, color, alpha)
    },
    strokeText: (text, st, ctm, cs, color, alpha) => {
      if (maskDepth > 0) t.strokeText(text, st, ctm, cs, color, alpha)
    },
    clipText: (text, ctm) => t.clipText(text, ctm),
    clipStrokeText: (text, st, ctm) => t.clipStrokeText(text, st, ctm),
    fillShade: (shade, ctm, alpha) => t.fillShade(shade, ctm, alpha),
    fillImage: (img, ctm, alpha) => t.fillImage(img, ctm, alpha),
    fillImageMask: (img, ctm, cs, color, alpha) => t.fillImageMask(img, ctm, cs, color, alpha),
    clipImageMask: (img, ctm) => t.clipImageMask(img, ctm),
    popClip: () => t.popClip(),
    beginMask: (bbox, lum, cs, color) => {
      maskDepth++
      t.beginMask(bbox, lum, cs, color)
    },
    endMask: () => {
      maskDepth = Math.max(0, maskDepth - 1)
      t.endMask()
    },
    beginGroup: (bbox, cs, isolated, knockout, blend, alpha) => t.beginGroup(bbox, cs, isolated, knockout, blend, alpha),
    endGroup: () => t.endGroup(),
    beginTile: (area, view, xs, ys, ctm, id, docId) => t.beginTile(area, view, xs, ys, ctm, id, docId),
    endTile: () => t.endTile(),
    beginLayer: (name) => t.beginLayer(name),
    endLayer: () => t.endLayer()
  }
  return new m.Device(callbacks as any)
}

/**
 * Renders a page (or the `clip` area of it, in page space) at `dpi`, with or without its text, as
 * an opaque pixmap (caller destroys it). Comments and form fields are included.
 */
export function renderArea(
  s: Session,
  pageIndex: number,
  dpi: number,
  opts: { text?: boolean; grayscale?: boolean; clip?: Rect; skipLines?: Rect[] } = {}
): MuPDF.Pixmap {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const scale = dpi / 72
  const b = page.getBounds() as Rect
  const full: Rect = [0, 0, Math.max(1, Math.round((b[2] - b[0]) * scale)), Math.max(1, Math.round((b[3] - b[1]) * scale))]
  let region = full
  if (opts.clip) {
    const c = opts.clip
    region = [
      Math.max(0, Math.floor((c[0] - b[0]) * scale)),
      Math.max(0, Math.floor((c[1] - b[1]) * scale)),
      Math.min(full[2], Math.ceil((c[2] - b[0]) * scale)),
      Math.min(full[3], Math.ceil((c[3] - b[1]) * scale))
    ]
    if (region[2] <= region[0] || region[3] <= region[1]) region = [0, 0, 1, 1]
  }
  if ((region[2] - region[0]) * (region[3] - region[1]) > 40_000_000) {
    throw new Error(`Page ${pageIndex + 1} is too large to render at ${dpi} dpi`)
  }
  const pix = new m.Pixmap(opts.grayscale ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB, region, false)
  pix.clear(255)
  const draw = new m.DrawDevice([scale, 0, 0, scale, -b[0] * scale, -b[1] * scale], pix)
  const dev = opts.text === false ? withoutTextDevice(m, draw, opts.skipLines) : draw
  try {
    page.runPageContents(dev, m.Matrix.identity)
    page.runPageAnnots(dev, m.Matrix.identity)
    page.runPageWidgets(dev, m.Matrix.identity)
    if (dev !== draw) dev.close()
    draw.close()
  } catch (err) {
    pix.destroy()
    throw err
  } finally {
    if (dev !== draw) dev.destroy()
    draw.destroy()
  }
  return pix
}

/** PNG for graphics, JPEG for photographs. */
export function encodeAuto(pix: MuPDF.Pixmap): { data: Uint8Array; mime: 'image/png' | 'image/jpeg' } {
  const n = pix.getNumberOfComponents() + pix.getAlpha()
  if (!pix.getAlpha() && looksLikePhoto(pix.getPixels(), n, pix.getWidth() * pix.getHeight())) return { data: pix.asJPEG(85).slice(), mime: 'image/jpeg' }
  return { data: pix.asPNG().slice(), mime: 'image/png' }
}

/** Plain text of a page, line by line, with filled-in form fields and comment text. */
export function pageText(s: Session, pageIndex: number): string {
  const list = s.page(pageIndex).toDisplayList(true)
  const st = list.toStructuredText('preserve-whitespace')
  try {
    return st.asText()
  } finally {
    st.destroy()
    list.destroy()
  }
}
