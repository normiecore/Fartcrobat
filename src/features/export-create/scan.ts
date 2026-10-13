/**
 * Scanned pages with recognized text (an invisible text layer over the picture of the page, as
 * Recognize Text writes it): the text is exported as text, so the scan itself must not come along
 * as well. What else the scan shows is kept: ruled lines (table borders, separators) become rules
 * and the rest (logos, photos, signatures, stamps) becomes pictures cut from the scan.
 */
import type * as MuPDF from 'mupdf'
import type { Session } from '@engine/session'
import type { XDrawing, XRule } from './content'

type Rect = [number, number, number, number]
type Matrix = [number, number, number, number, number, number]

/** Resolution the scans are examined at. */
const DPI = 100
/** Larger pages are examined at a lower resolution (pixels). */
const MAX_PIXELS = 12_000_000
/** Text drawn over a scan is erased with this margin (points). */
const ERASE_PAD = 1

export interface HiddenLine {
  bbox: Rect
  /** Characters of the line (pictures holding a lot of text are not cut out). */
  chars: number
  words: number
}

export interface ScanAnalysis {
  rules: XRule[]
  pictures: XDrawing[]
  /** Where the recognized text is on the scans, to erase from pictures of the page under editable text. */
  erase: Rect[]
}

function overlapArea(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
}

const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])

const centerIn = (r: Rect, box: Rect) => {
  const cx = (r[0] + r[2]) / 2
  const cy = (r[1] + r[3]) / 2
  return cx >= box[0] && cx <= box[2] && cy >= box[1] && cy <= box[3]
}

/** Page-space bounds of an image drawn with `ctm` (the unit square). */
function imageBounds(ctm: Matrix): Rect {
  const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]]
  const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/** A device that draws only the given images (and what clips or masks them). */
function scansOnlyDevice(m: Session['mupdf'], target: MuPDF.Device, keep: (bounds: Rect) => boolean): MuPDF.Device {
  let maskDepth = 0
  const t = target as any
  const callbacks: Record<string, (...args: any[]) => any> = {
    fillPath: (p, eo, ctm, cs, color, alpha) => {
      if (maskDepth > 0) t.fillPath(p, eo, ctm, cs, color, alpha)
    },
    strokePath: (p, st, ctm, cs, color, alpha) => {
      if (maskDepth > 0) t.strokePath(p, st, ctm, cs, color, alpha)
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
    fillShade: (shade, ctm, alpha) => {
      if (maskDepth > 0) t.fillShade(shade, ctm, alpha)
    },
    fillImage: (img, ctm, alpha) => {
      if (maskDepth > 0 || keep(imageBounds(ctm))) t.fillImage(img, ctm, alpha)
    },
    fillImageMask: (img, ctm, cs, color, alpha) => {
      if (maskDepth > 0 || keep(imageBounds(ctm))) t.fillImageMask(img, ctm, cs, color, alpha)
    },
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
    beginTile: (a, view, xs, ys, ctm, id, docId) => t.beginTile(a, view, xs, ys, ctm, id, docId),
    endTile: () => t.endTile(),
    beginLayer: (name) => t.beginLayer(name),
    endLayer: () => t.endLayer()
  }
  return new m.Device(callbacks as any)
}

/** Gray picture of the scans alone (white elsewhere). */
function renderScans(s: Session, pageIndex: number, scans: Rect[], scale: number): { gray: Uint8Array; width: number; height: number; origin: [number, number] } {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const b = page.getBounds() as Rect
  const width = Math.max(1, Math.round((b[2] - b[0]) * scale))
  const height = Math.max(1, Math.round((b[3] - b[1]) * scale))
  const pix = new m.Pixmap(m.ColorSpace.DeviceGray, [0, 0, width, height], false)
  try {
    pix.clear(255)
    const draw = new m.DrawDevice([scale, 0, 0, scale, -b[0] * scale, -b[1] * scale], pix)
    const dev = scansOnlyDevice(m, draw, (r) => scans.some((sc) => overlapArea(r, sc) >= 0.8 * Math.min(area(r), area(sc))))
    try {
      page.runPageContents(dev, m.Matrix.identity)
      dev.close()
      draw.close()
    } finally {
      dev.destroy()
      draw.destroy()
    }
    const stride = pix.getStride()
    const src = pix.getPixels()
    const gray = new Uint8Array(width * height)
    for (let y = 0; y < height; y++) gray.set(src.subarray(y * stride, y * stride + width), y * width)
    return { gray, width, height, origin: [b[0], b[1]] }
  } finally {
    pix.destroy()
  }
}

/** The most common light level of the scans: the paper. */
function paperLevel(gray: Uint8Array, inside: Uint8Array): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) if (inside[i]) hist[gray[i]]++
  let best = 255
  for (let v = 100; v < 256; v++) if (hist[v] > hist[best]) best = v
  return best
}

interface Run {
  a: number
  b: number
}

/** Runs of dark pixels along one row or column (gaps up to 2 pixels bridged). */
function darkRuns(dark: Uint8Array, start: number, step: number, count: number, minLength: number): Run[] {
  const out: Run[] = []
  let a = -1
  let last = -1
  for (let i = 0; i < count; i++) {
    if (dark[start + i * step]) {
      if (a < 0) a = i
      last = i
    } else if (a >= 0 && i - last > 2) {
      if (last - a + 1 >= minLength) out.push({ a, b: last })
      a = -1
    }
  }
  if (a >= 0 && last - a + 1 >= minLength) out.push({ a, b: last })
  return out
}

interface Stroke {
  a: number
  b: number
  from: number
  to: number
}

/** Stacks the runs of consecutive rows (or columns) into strokes; thin strokes are ruled lines. */
function strokes(runs: Run[][], maxThickness: number): Stroke[] {
  const done: Stroke[] = []
  let open: Stroke[] = []
  runs.forEach((list, k) => {
    const next: Stroke[] = []
    for (const r of list) {
      const s = open.find((o) => Math.min(o.b, r.b) - Math.max(o.a, r.a) >= 0.8 * Math.min(o.b - o.a, r.b - r.a))
      if (s) {
        open = open.filter((o) => o !== s)
        next.push({ a: Math.min(s.a, r.a), b: Math.max(s.b, r.b), from: s.from, to: k })
      } else next.push({ a: r.a, b: r.b, from: k, to: k })
    }
    done.push(...open)
    open = next
  })
  done.push(...open)
  return done.filter((s) => s.to - s.from + 1 <= maxThickness)
}

/**
 * Examines the scans under recognized text. `scans` are the scanned images (page space), `hidden`
 * the recognized text lines.
 */
export function analyzeScans(s: Session, pageIndex: number, scans: Rect[], hidden: HiddenLine[]): ScanAnalysis {
  const onScans = hidden.filter((l) => scans.some((sc) => centerIn(l.bbox, sc)))
  const erase = onScans.map((l): Rect => [l.bbox[0] - ERASE_PAD, l.bbox[1] - ERASE_PAD, l.bbox[2] + ERASE_PAD, l.bbox[3] + ERASE_PAD])
  const b = s.page(pageIndex).getBounds() as Rect
  const pageArea = Math.max(1, (b[2] - b[0]) * (b[3] - b[1]))
  const scale = Math.min(DPI / 72, Math.sqrt(MAX_PIXELS / pageArea))
  const { gray, width, height, origin } = renderScans(s, pageIndex, scans, scale)
  const px = (x: number) => Math.round((x - origin[0]) * scale)
  const py = (y: number) => Math.round((y - origin[1]) * scale)
  const toPage = (x: number, y: number): [number, number] => [origin[0] + x / scale, origin[1] + y / scale]

  // Only the scanned areas count; the recognized text on them is not a picture.
  const inside = new Uint8Array(width * height)
  for (const sc of scans) {
    const x0 = Math.max(0, px(sc[0]))
    const x1 = Math.min(width, px(sc[2]))
    for (let y = Math.max(0, py(sc[1])); y < Math.min(height, py(sc[3])); y++) inside.fill(1, y * width + x0, y * width + Math.max(x0, x1))
  }
  for (const r of erase) {
    const x0 = Math.max(0, px(r[0]))
    const x1 = Math.min(width, px(r[2]))
    for (let y = Math.max(0, py(r[1])); y < Math.min(height, py(r[3])); y++) inside.fill(0, y * width + x0, y * width + Math.max(x0, x1))
  }
  const paper = paperLevel(gray, inside)
  const threshold = paper - Math.max(48, paper * 0.25)
  const dark = new Uint8Array(width * height)
  let any = false
  for (let i = 0; i < dark.length; i++) {
    if (inside[i] && gray[i] < threshold) {
      dark[i] = 1
      any = true
    }
  }
  if (!any) return { rules: [], pictures: [], erase }

  // 1. Ruled lines: long thin strokes with nothing on either side (not the strokes of letters).
  const maxThickness = Math.max(2, Math.round(3.5 * scale))
  const level = (sum: number, n: number) => {
    const v = Math.max(0, Math.min(255, Math.round(sum / Math.max(1, n))))
    return (v << 16) | (v << 8) | v
  }
  const rows: Run[][] = []
  for (let y = 0; y < height; y++) rows.push(darkRuns(dark, y * width, 1, width, Math.round(26 * scale)))
  const cols: Run[][] = []
  for (let x = 0; x < width; x++) cols.push(darkRuns(dark, x, width, height, Math.round(16 * scale)))
  /** Share of dark pixels along a stroke, `d` pixels before and after it across. */
  const sides = (st: Stroke, horizontal: boolean, d: number) => {
    let n = 0
    let on = 0
    for (const k of [st.from - d, st.to + d]) {
      if (k < 0 || k >= (horizontal ? height : width)) continue
      for (let i = st.a; i <= st.b; i++) {
        n++
        if (dark[horizontal ? k * width + i : i * width + k]) on++
      }
    }
    return n ? on / n : 0
  }
  const hStrokes = strokes(rows, maxThickness).filter((st) => sides(st, true, 2) < 0.3)
  const vStrokes = strokes(cols, maxThickness).filter((st) => sides(st, false, 2) < 0.3)
  type Ruled = { rule: XRule; stroke: Stroke; horizontal: boolean }
  const ruled: Ruled[] = []
  for (const st of hStrokes) {
    let sum = 0
    let n = 0
    for (let y = st.from; y <= st.to; y++)
      for (let x = st.a; x <= st.b; x++) {
        sum += gray[y * width + x]
        n++
      }
    const [x0, y0] = toPage(st.a, st.from)
    const [x1, y1] = toPage(st.b + 1, st.to + 1)
    ruled.push({ rule: { x0, x1, y0: (y0 + y1) / 2, y1: (y0 + y1) / 2, dir: 'h', width: Math.max(0.5, y1 - y0), color: level(sum, n) }, stroke: st, horizontal: true })
  }
  for (const st of vStrokes) {
    let sum = 0
    let n = 0
    for (let x = st.from; x <= st.to; x++)
      for (let y = st.a; y <= st.b; y++) {
        sum += gray[y * width + x]
        n++
      }
    const [x0, y0] = toPage(st.from, st.a)
    const [x1, y1] = toPage(st.to + 1, st.b + 1)
    ruled.push({ rule: { x0: (x0 + x1) / 2, x1: (x0 + x1) / 2, y0, y1, dir: 'v', width: Math.max(0.5, x1 - x0), color: level(sum, n) }, stroke: st, horizontal: false })
  }
  // The lines are rules now, not part of pictures.
  for (const { stroke: st, horizontal } of ruled) {
    if (horizontal) for (let y = Math.max(0, st.from - 1); y <= Math.min(height - 1, st.to + 1); y++) dark.fill(0, y * width + st.a, y * width + st.b + 1)
    else for (let y = st.a; y <= st.b; y++) dark.fill(0, y * width + Math.max(0, st.from - 1), y * width + Math.min(width, st.to + 2))
  }

  // 2. What is left (pictures, and whatever the recognition did not read): groups of dark pixels
  // close together (4-pixel cells, 8-connected).
  const CELL = 4
  const cw = Math.ceil(width / CELL)
  const ch = Math.ceil(height / CELL)
  const cells = new Uint16Array(cw * ch)
  for (let y = 0; y < height; y++) {
    const row = y * width
    const crow = Math.floor(y / CELL) * cw
    for (let x = 0; x < width; x++) if (dark[row + x]) cells[crow + Math.floor(x / CELL)]++
  }
  const seen = new Uint8Array(cw * ch)
  const pixelArea = (72 / scale) ** 2
  const parts: Part[] = []
  const stack: number[] = []
  for (let i = 0; i < cells.length; i++) {
    if (!cells[i] || seen[i]) continue
    let x0 = cw
    let y0 = ch
    let x1 = -1
    let y1 = -1
    let ink = 0
    seen[i] = 1
    stack.push(i)
    while (stack.length) {
      const k = stack.pop()!
      const cx = k % cw
      const cy = (k - cx) / cw
      ink += cells[k]
      if (cx < x0) x0 = cx
      if (cx > x1) x1 = cx
      if (cy < y0) y0 = cy
      if (cy > y1) y1 = cy
      for (let dy = -1; dy <= 1; dy++) {
        const ny = cy + dy
        if (ny < 0 || ny >= ch) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx
          if (nx < 0 || nx >= cw) continue
          const nk = ny * cw + nx
          if (cells[nk] && !seen[nk]) {
            seen[nk] = 1
            stack.push(nk)
          }
        }
      }
    }
    const [px0, py0] = toPage(x0 * CELL, y0 * CELL)
    const [px1, py1] = toPage(Math.min(width, (x1 + 1) * CELL), Math.min(height, (y1 + 1) * CELL))
    const part = { r: [px0, py0, px1, py1] as Rect, ink: ink * pixelArea }
    // Specks of dust and noise.
    if (part.ink >= 2 || px1 - px0 >= 3 || py1 - py0 >= 3) parts.push(part)
  }
  // Parts close together are one picture: the words of a title the recognition missed, the
  // strokes of a signature.
  let areas = mergeParts(parts)

  // 3. A ruled table whose cells were not read is a picture of the table (rules and all).
  const recognizedWords = (r: Rect) => onScans.filter((l) => centerIn(l.bbox, r)).reduce((n, l) => n + l.words, 0)
  const unread: Rect[] = []
  for (const group of ruleGroups(ruled.map((x) => x.rule))) {
    const box: Rect = [Math.min(...group.map((r) => r.x0)), Math.min(...group.map((r) => r.y0)), Math.max(...group.map((r) => r.x1)), Math.max(...group.map((r) => r.y1))]
    const hs = group.filter((r) => r.dir === 'h').length
    const vs = group.filter((r) => r.dir === 'v').length
    // A frame around the whole page holds everything.
    if (hs < 2 || vs < 2 || area(box) > 0.6 * pageArea) continue
    const inner = areas.filter((a) => centerIn(a.r, box))
    if (!inner.length || inner.length <= recognizedWords(box)) continue
    unread.push(box)
    areas = areas.filter((a) => !inner.includes(a))
    areas.push({ r: [box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1], ink: inner.reduce((n, a) => n + a.ink, 0) + 1000 })
  }
  const inUnread = (r: XRule) => unread.some((b) => r.x0 >= b[0] - 0.5 && r.x1 <= b[2] + 0.5 && r.y0 >= b[1] - 0.5 && r.y1 <= b[3] + 0.5)
  const rules = ruled.map((x) => x.rule).filter((r) => !inUnread(r))

  const pictures: XDrawing[] = []
  for (const { r, ink } of areas) {
    const w = r[2] - r[0]
    const h = r[3] - r[1]
    // Marks too small to show anything (a dot the recognition left out).
    if (Math.max(w, h) < 8 || ink < 6) continue
    // Shadows along the edge of the scanned sheet.
    const scan = scans.find((sc) => centerIn(r, sc))
    if (scan && Math.min(w, h) < 24 && (r[0] - scan[0] < 3 || scan[2] - r[2] < 3 || r[1] - scan[1] < 3 || scan[3] - r[3] < 3)) continue
    // A picture covering a lot of the recognized text would show that text twice.
    const text = onScans.filter((l) => centerIn(l.bbox, r)).reduce((n, l) => n + l.chars, 0)
    if (text > 300) continue
    pictures.push({ x0: r[0], y0: r[1], x1: r[2], y1: r[3], art: true, scan: true })
  }
  return { rules, pictures, erase }
}

interface Part {
  r: Rect
  /** Dark area (square points). */
  ink: number
}

/** Joins parts that touch or nearly do, and parts side by side on one line (words). */
function mergeParts(parts: Part[]): Part[] {
  let list = parts.map((p) => ({ r: [...p.r] as Rect, ink: p.ink }))
  const near = (a: Rect, b: Rect) => {
    const gapX = Math.max(a[0], b[0]) - Math.min(a[2], b[2])
    const gapY = Math.max(a[1], b[1]) - Math.min(a[3], b[3])
    if (gapX <= 4 && gapY <= 4) return true
    // Side by side: overlapping rows, a word space apart.
    const ha = a[3] - a[1]
    const hb = b[3] - b[1]
    return -gapY >= 0.5 * Math.min(ha, hb) && gapX <= Math.max(8, 0.8 * Math.max(ha, hb))
  }
  let merged = true
  while (merged) {
    merged = false
    const out: Part[] = []
    for (const p of list) {
      const hit = out.find((o) => near(o.r, p.r))
      if (hit) {
        hit.r = [Math.min(hit.r[0], p.r[0]), Math.min(hit.r[1], p.r[1]), Math.max(hit.r[2], p.r[2]), Math.max(hit.r[3], p.r[3])]
        hit.ink += p.ink
        merged = true
      } else out.push(p)
    }
    list = out
  }
  return list
}

/** Rules that touch or cross each other (the borders of one table). */
function ruleGroups(rules: XRule[]): XRule[][] {
  const parent = rules.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const touch = (a: XRule, b: XRule) => a.x0 <= b.x1 + 2 && b.x0 <= a.x1 + 2 && a.y0 <= b.y1 + 2 && b.y0 <= a.y1 + 2
  for (let i = 0; i < rules.length; i++) for (let j = i + 1; j < rules.length; j++) if (touch(rules[i], rules[j])) parent[find(i)] = find(j)
  const groups = new Map<number, XRule[]>()
  for (let i = 0; i < rules.length; i++) {
    const g = groups.get(find(i))
    if (g) g.push(rules[i])
    else groups.set(find(i), [rules[i]])
  }
  return [...groups.values()]
}

/**
 * Paints the `erase` areas (page space) of an opaque pixmap with the colour around each of them:
 * the paper of a scan, without the text that is exported as text.
 */
export function eraseAreas(pix: MuPDF.Pixmap, erase: Rect[], scale: number, origin: [number, number]) {
  if (!erase.length) return
  // Components per pixel, alpha included.
  const n = pix.getNumberOfComponents()
  const stride = pix.getStride()
  const px0 = pix.getX()
  const py0 = pix.getY()
  const w = pix.getWidth()
  const h = pix.getHeight()
  const data = pix.getPixels()
  for (const r of erase) {
    const x0 = Math.max(0, Math.floor((r[0] - origin[0]) * scale) - px0)
    const y0 = Math.max(0, Math.floor((r[1] - origin[1]) * scale) - py0)
    const x1 = Math.min(w, Math.ceil((r[2] - origin[0]) * scale) - px0)
    const y1 = Math.min(h, Math.ceil((r[3] - origin[1]) * scale) - py0)
    if (x1 <= x0 || y1 <= y0) continue
    // The median colour of a frame two pixels outside the area.
    const samples: number[][] = Array.from({ length: n }, () => [])
    const sample = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= w || y >= h) return
      const o = y * stride + x * n
      for (let c = 0; c < n; c++) samples[c].push(data[o + c])
    }
    for (let x = x0 - 2; x < x1 + 2; x += 2) {
      sample(x, y0 - 2)
      sample(x, y1 + 1)
    }
    for (let y = y0; y < y1; y += 2) {
      sample(x0 - 2, y)
      sample(x1 + 1, y)
    }
    const fill = samples.map((list) => {
      if (!list.length) return 255
      list.sort((a, b) => a - b)
      return list[list.length >> 1]
    })
    for (let y = y0; y < y1; y++) {
      let o = y * stride + x0 * n
      for (let x = x0; x < x1; x++, o += n) for (let c = 0; c < n; c++) data[o + c] = fill[c]
    }
  }
}
