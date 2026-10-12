import type { Matrix, Point, Rect } from '@shared/geometry'
import { hexToRgb, multiplyMatrix, normalizeRect, rgbToHex, transformPoint, transformRect } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import type { PDFAnnotation, PDFObject, Session } from '@engine/session'
import { annotInfo, FLAG_PRINT, type AnnotInfo } from '@engine/ops/annots'
import { viewMatrix } from '@engine/ops/render'
import { catalog, isNull, num, pageBoxes, pdfLiteral, readNumber, readString } from '@engine/util/pdf'
import {
  KIND_LABELS,
  KIND_SUBJECTS,
  measureShape,
  parseScale,
  polygonCentroid,
  realPerPoint,
  sanitizeScale,
  scaleToString,
  segmentLength,
  storeNumber,
  type MeasureKind,
  type MeasureScale
} from './measureMath'
import { BUILTIN_ASPECT } from './stampCatalog'

type MupdfImage = InstanceType<Session['mupdf']['Image']>
type MupdfPixmap = InstanceType<Session['mupdf']['Pixmap']>

/** Catalog key holding the document's measurement scale. */
export const SCALE_KEY = 'FartcrobatMeasure'
/** Marker put in appearance streams Fartcrobat draws itself (measurement labels). */
const AP_MARKER = 'FartcrobatAP'
const EXTRA_KEY = 'FartcrobatData'

export interface MeasurementSpec {
  kind: MeasureKind
  /** Page-space points: 2 for a distance, 2+ for a perimeter, 3+ for an area. */
  points: Point[]
  scale: MeasureScale
  /** #rrggbb */
  color?: string
  /** Line width in points. */
  width?: number
  /** Show the value on the page (line caption / label). Defaults to true. */
  showLabel?: boolean
}

export interface MeasurementInfo {
  id: number
  page: number
  kind: MeasureKind
  type: string
  points: Point[]
  /** Value in real units (square units for areas). */
  value: number
  unit: string
  /** e.g. "2 ft" */
  label: string
  /** e.g. "1 in = 1 ft" */
  scale: string
  precision: number
  color: string | null
  contents: string
  author: string
  created: string
  showLabel: boolean
  rect: Rect
  /** False for measurements made by other applications (read from their intent and contents). */
  ours: boolean
}

export interface StampSpec {
  /** Page-space rectangle. */
  rect: Rect
  /** PDF /Name (MuPDF draws known names itself). */
  name: string
  /** Shown as the annotation subject (e.g. "Approved"). */
  label: string
  /** #rrggbb */
  color?: string
  /** PNG/JPEG appearance. Without it the stamp is drawn by MuPDF from its name. */
  image?: Uint8Array
  contents?: string
  extra?: Record<string, string>
}

export interface SnapTargets {
  /** Packed page-space points [x0, y0, x1, y1, ...]. */
  points: Float32Array
  /** One entry per point: 0 end point, 1 midpoint, 2 text corner, 3 annotation point. */
  kinds: Uint8Array
}

const MAX_SNAP_POINTS = 60000
const DEFAULT_MEASURE_COLOR = '#D32F2F'

// ---- small helpers ---------------------------------------------------------------------------

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function finitePoint(p: unknown): p is Point {
  return Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1])
}

export function readExtra(annot: PDFAnnotation): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const d = annot.getObject().get(EXTRA_KEY)
    if (!isNull(d) && d.isDictionary()) d.forEach((v, k) => (out[String(k)] = readString(v)))
  } catch {}
  return out
}

function writeExtra(s: Session, annot: PDFAnnotation, data: Record<string, string>) {
  const obj = annot.getObject()
  let d = obj.get(EXTRA_KEY)
  if (isNull(d) || !d.isDictionary()) {
    obj.put(EXTRA_KEY, s.pdf.newDictionary())
    d = obj.get(EXTRA_KEY)
  }
  for (const [k, v] of Object.entries(data)) d.put(k, s.pdf.newString(v))
}

function pageRotation(s: Session, pageIndex: number): number {
  return pageBoxes(s.pdf, pageIndex).rotation
}

function colorOp(c: number[], stroke: boolean): string {
  const v = c.map((x) => num(x)).join(' ')
  if (c.length === 1) return `${v} ${stroke ? 'G' : 'g'}`
  if (c.length === 4) return `${v} ${stroke ? 'K' : 'k'}`
  return `${v} ${stroke ? 'RG' : 'rg'}`
}

let helvetica: InstanceType<Session['mupdf']['Font']> | null = null

/** Width of a string set in Helvetica at the given size. */
function textWidth(s: Session, text: string, size: number): number {
  if (!helvetica) helvetica = new s.mupdf.Font('Helvetica')
  let w = 0
  for (const ch of text) w += helvetica.advanceGlyph(helvetica.encodeCharacter(ch))
  return w * size
}

function isMeasureIntent(it: string): MeasureKind | null {
  if (it === 'LineDimension') return 'distance'
  if (it === 'PolyLineDimension') return 'perimeter'
  if (it === 'PolygonDimension') return 'area'
  return null
}

function rawIntent(annot: PDFAnnotation): string {
  return safe(() => {
    const v = annot.getObject().get('IT')
    return isNull(v) ? '' : readString(v)
  }, '')
}

function annotPoints(annot: PDFAnnotation, kind: MeasureKind): Point[] {
  if (kind === 'distance') return safe(() => annot.getLine() as Point[], [])
  return safe(() => annot.getVertices() as Point[], [])
}

/**
 * True when the normal appearance is still the one we drew. MuPDF redraws appearances in place
 * (sometimes reusing the same stream object) when another tool edits the annotation, so the marker
 * is a marked-content tag inside the content stream itself.
 */
function hasOurAppearance(annot: PDFAnnotation): boolean {
  return safe(() => {
    const ap = annot.getObject().get('AP')
    if (isNull(ap)) return false
    const n = ap.get('N')
    if (isNull(n) || !n.isStream()) return false
    return n.readStream().asString().includes(`/${AP_MARKER} BMC`)
  }, false)
}

function annotRect(annot: PDFAnnotation): Rect {
  return safe(() => (annot.hasRect() ? annot.getRect() : annot.getBounds()) as Rect, safe(() => annot.getBounds() as Rect, [0, 0, 0, 0]))
}

function measureLabelSize(s: Session, pageIndex: number): number {
  const b = s.pageBounds(pageIndex)
  const m = Math.min(b[2] - b[0], b[3] - b[1])
  // about 12 pt on a Letter or A4 page, like the captions MuPDF draws on distance lines
  return Math.max(9, Math.min(24, m / 51))
}

// ---- measurement appearance ----------------------------------------------------------------

/**
 * Draws a perimeter/area measurement ourselves (MuPDF does not draw labels for polylines and
 * polygons): the shape plus a label with the value, upright on the page whatever its rotation.
 */
function bakePolyAppearance(s: Session, pageIndex: number, annot: PDFAnnotation, label: string | null) {
  const doc = s.pdf
  const type = annot.getType()
  const verts = safe(() => annot.getVertices() as Point[], [])
  if (verts.length < 2) return
  const closed = type === 'Polygon'
  const stroke = safe(() => annot.getColor() as number[], [] as number[])
  const strokeColor = stroke.length ? stroke : hexToRgb(DEFAULT_MEASURE_COLOR)
  const fill = safe(() => (annot.hasInteriorColor() ? (annot.getInteriorColor() as number[]) : []), [] as number[])
  const width = Math.max(0, safe(() => (annot.hasBorder() ? annot.getBorderWidth() : 1), 1))
  const dashes = safe(() => (annot.hasBorder() ? (annot.getBorderDashPattern() as number[]) : []), [] as number[])
  const opacity = Math.max(0, Math.min(1, safe(() => annot.getOpacity(), 1)))

  const ops: string[] = [`/${AP_MARKER} BMC`, 'q']
  const gstates: Record<string, Record<string, number>> = {}
  if (opacity < 1) {
    gstates.FcGS0 = { CA: opacity, ca: opacity }
    ops.push('/FcGS0 gs')
  }
  ops.push(colorOp(strokeColor, true))
  if (fill.length) ops.push(colorOp(fill, false))
  ops.push(`${num(width)} w 1 J 1 j`)
  if (dashes.length) ops.push(`[${dashes.map((d) => num(d)).join(' ')}] 0 d`)
  verts.forEach((p, i) => ops.push(`${num(p[0])} ${num(-p[1])} ${i === 0 ? 'm' : 'l'}`))
  ops.push(closed ? (fill.length ? 'b' : 's') : 'S')
  ops.push('Q')

  const xs = verts.map((p) => p[0])
  const ys = verts.map((p) => p[1])
  const pad = width / 2 + 1
  let bbox: Rect = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]

  if (label) {
    const fs = measureLabelSize(s, pageIndex)
    const tw = textWidth(s, label, fs)
    let cx: number
    let cy: number
    if (closed) {
      ;[cx, cy] = polygonCentroid(verts)
    } else {
      // above the middle of the longest segment
      let best = 1
      for (let i = 2; i < verts.length; i++) {
        if (segmentLength(verts[i - 1], verts[i]) > segmentLength(verts[best - 1], verts[best])) best = i
      }
      const a = verts[best - 1]
      const b = verts[best]
      cx = (a[0] + b[0]) / 2
      cy = (a[1] + b[1]) / 2 - (fs * 0.6 + width / 2 + 3)
    }
    const hp = 3
    const box: Rect = [cx - tw / 2 - hp, cy - fs * 0.6 - hp / 2, cx + tw / 2 + hp, cy + fs * 0.6 + hp / 2]
    gstates.FcGS1 = { ca: 0.85 }
    ops.push('q /FcGS1 gs 1 1 1 rg')
    ops.push(`${num(box[0])} ${num(-box[3])} ${num(box[2] - box[0])} ${num(box[3] - box[1])} re f Q`)
    // black text on a light box, like the captions of distance lines
    ops.push(`q BT /FcHelv ${num(fs)} Tf 0 g`)
    ops.push(`${num(cx - tw / 2)} ${num(-(cy + fs * 0.35))} Td ${pdfLiteral(label)} Tj ET Q`)
    bbox = [Math.min(bbox[0], box[0]), Math.min(bbox[1], box[1]), Math.max(bbox[2], box[2]), Math.max(bbox[3], box[3])]
  }
  ops.push('EMC')

  const res = doc.newDictionary()
  if (label) {
    const font = doc.newDictionary()
    font.put('Type', doc.newName('Font'))
    font.put('Subtype', doc.newName('Type1'))
    font.put('BaseFont', doc.newName('Helvetica'))
    font.put('Encoding', doc.newName('WinAnsiEncoding'))
    const fonts = doc.newDictionary()
    fonts.put('FcHelv', doc.addObject(font))
    res.put('Font', fonts)
  }
  if (Object.keys(gstates).length) {
    const gs = doc.newDictionary()
    for (const [name, values] of Object.entries(gstates)) {
      const g = doc.newDictionary()
      g.put('Type', doc.newName('ExtGState'))
      for (const [k, v] of Object.entries(values)) g.put(k, v)
      gs.put(name, g)
    }
    res.put('ExtGState', gs)
  }
  // Content is written in "flipped page space" (x, -y) so text is upright on the page.
  const toUser = s.pageToUser(pageIndex)
  const matrix = multiplyMatrix([1, 0, 0, -1, 0, 0], toUser)
  const formBBox: Rect = [bbox[0], -bbox[3], bbox[2], -bbox[1]]
  annot.setAppearance(null, null, matrix, formBBox, res, ops.join('\n'))
  annot.getObject().put('Rect', normalizeRect(transformRect(bbox, toUser)))
}

function measureDict(s: Session, scale: MeasureScale) {
  const doc = s.pdf
  const fmt = (unit: string, c: number) => {
    const d = doc.newDictionary()
    d.put('Type', doc.newName('NumberFormat'))
    d.put('U', doc.newString(unit))
    d.put('C', c)
    d.put('F', doc.newName('D'))
    d.put('D', Math.pow(10, scale.precision))
    d.put('SS', doc.newString(''))
    return d
  }
  const arr = (item: PDFObject) => {
    const a = doc.newArray()
    a.push(item)
    return a
  }
  const m = doc.newDictionary()
  m.put('Type', doc.newName('Measure'))
  m.put('Subtype', doc.newName('RL'))
  m.put('R', doc.newString(scaleToString(scale)))
  m.put('X', arr(fmt(scale.realUnit, realPerPoint(scale))))
  m.put('D', arr(fmt(scale.realUnit, 1)))
  m.put('A', arr(fmt(`sq ${scale.realUnit}`, 1)))
  return m
}

/** Writes value, label, scale and /Measure for a measurement and refreshes its appearance. */
function applyMeasurement(
  s: Session,
  pageIndex: number,
  annot: PDFAnnotation,
  kind: MeasureKind,
  scale: MeasureScale,
  opts: { forceContents?: boolean } = {}
) {
  const extra = readExtra(annot)
  const r = measureShape(kind, annotPoints(annot, kind), scale)
  const contents = safe(() => annot.getContents(), '')
  if (opts.forceContents || !contents || contents === extra.label) annot.setContents(r.label)
  writeExtra(s, annot, {
    fartcrobat: 'measure',
    kind,
    value: storeNumber(r.value),
    unit: r.unit,
    scale: scaleToString(scale),
    precision: String(scale.precision),
    label: r.label
  })
  annot.getObject().put('Measure', measureDict(s, scale))
  const showLabel = readExtra(annot).labelHidden !== '1'
  if (kind === 'distance') {
    annot.update()
  } else {
    annot.update()
    bakePolyAppearance(s, pageIndex, annot, showLabel ? r.label : null)
  }
}

function measurementInfo(s: Session, annot: PDFAnnotation, pageIndex: number, position: number): MeasurementInfo | null {
  const extra = readExtra(annot)
  const type = safe(() => annot.getType(), '')
  const ours = extra.fartcrobat === 'measure'
  let kind: MeasureKind | null = null
  if (ours && (extra.kind === 'distance' || extra.kind === 'perimeter' || extra.kind === 'area')) kind = extra.kind
  if (!kind) {
    kind = isMeasureIntent(rawIntent(annot))
    if (!kind) return null
  }
  const expected = kind === 'distance' ? 'Line' : kind === 'perimeter' ? 'PolyLine' : 'Polygon'
  if (type !== expected) return null
  const points = annotPoints(annot, kind)
  const contents = safe(() => annot.getContents(), '')
  const precision = Number(extra.precision ?? 2)
  const scaleText = ours ? (extra.scale ?? '') : safe(() => readString(annot.getObject().get('Measure').get('R')), '')
  let value = Number(extra.value)
  let unit = extra.unit ?? ''
  let label = extra.label ?? contents
  if (!ours) {
    const parsed = /([-\d.,]+)\s*(.*)$/.exec(contents.trim())
    value = parsed ? parseFloat(parsed[1].replace(/,/g, '')) : NaN
    unit = parsed ? parsed[2] : ''
    label = contents
  }
  const showLabel =
    kind === 'distance' ? safe(() => !!annot.getLineCaption(), true) : ours ? extra.labelHidden !== '1' : true
  return {
    id: s.annotationId(annot, pageIndex, position),
    page: pageIndex,
    kind,
    type,
    points,
    value: Number.isFinite(value) ? value : 0,
    unit,
    label,
    scale: scaleText,
    precision: Number.isFinite(precision) ? precision : 2,
    color: safe(() => {
      const c = annot.getColor() as number[]
      return c.length ? rgbToHex(c) : null
    }, null),
    contents,
    author: safe(() => (annot.hasAuthor() ? annot.getAuthor() : ''), ''),
    created: safe(() => {
      const d = annot.getCreationDate()
      return d && !Number.isNaN(d.getTime()) ? d.toISOString() : ''
    }, ''),
    showLabel,
    rect: annotRect(annot),
    ours
  }
}

function listPageMeasurements(s: Session, pageIndex: number): MeasurementInfo[] {
  const out: MeasurementInfo[] = []
  s.page(pageIndex)
    .getAnnotations()
    .forEach((a, k) => {
      const m = measurementInfo(s, a, pageIndex, k)
      if (m) out.push(m)
    })
  return out
}

// ---- stamps ----------------------------------------------------------------------------------

/** Rotates a pixmap clockwise by 90, 180 or 270 degrees. */
function rotatePixmap(s: Session, src: MupdfPixmap, degrees: number): MupdfPixmap {
  const d = ((degrees % 360) + 360) % 360
  const w = src.getWidth()
  const h = src.getHeight()
  // components include the alpha channel
  const n = src.getNumberOfComponents()
  const swap = d === 90 || d === 270
  const W = swap ? h : w
  const H = swap ? w : h
  const cs = src.getColorSpace()
  const dst = cs
    ? new s.mupdf.Pixmap(cs, [0, 0, W, H], !!src.getAlpha())
    : new s.mupdf.Pixmap(s.mupdf.ColorSpace.DeviceGray, [0, 0, W, H], false)
  const sStride = src.getStride()
  const dStride = dst.getStride()
  // Views into WASM memory: take them after every allocation above.
  const sp = src.getPixels()
  const dp = dst.getPixels()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number
      let ny: number
      if (d === 90) {
        nx = h - 1 - y
        ny = x
      } else if (d === 180) {
        nx = w - 1 - x
        ny = h - 1 - y
      } else {
        nx = y
        ny = w - 1 - x
      }
      const si = y * sStride + x * n
      const di = ny * dStride + nx * n
      for (let c = 0; c < n; c++) dp[di + c] = sp[si + c]
    }
  }
  return dst
}

/** Rotates an image clockwise (keeping a separate soft mask, if any, in step). */
function rotateImage(s: Session, img: MupdfImage, degrees: number): MupdfImage {
  const d = ((degrees % 360) + 360) % 360
  if (d === 0) return img
  const pix = img.toPixmap()
  const rotated = rotatePixmap(s, pix, d)
  const mask = pix.getAlpha() ? null : img.getMask()
  if (mask) {
    const mp = mask.toPixmap()
    const rm = rotatePixmap(s, mp, d)
    return new s.mupdf.Image(rotated, new s.mupdf.Image(rm))
  }
  return new s.mupdf.Image(rotated)
}

/** Renders a stamp MuPDF draws from its name, in a scratch document. */
function renderBuiltinStamp(s: Session, name: string, color: string | undefined, scale: number): MupdfPixmap {
  const m = s.mupdf
  const doc = new m.PDFDocument()
  try {
    const pageObj = doc.addPage([0, 0, 260, 100], 0, doc.newDictionary(), '')
    doc.insertPage(-1, pageObj)
    const page = doc.loadPage(0)
    const a = page.createAnnotation('Stamp')
    a.setRect([10, 10, 10 + 190, 10 + 190 / BUILTIN_ASPECT])
    a.setIcon(name)
    if (color) a.setColor(hexToRgb(color))
    a.update()
    return a.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, true)
  } finally {
    doc.destroy()
  }
}

/** Renders a page (with its annotations) on a fully transparent background. */
function renderTransparent(s: Session, pageIndex: number, scale: number, clip?: Rect): MupdfPixmap {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const { ctm, bbox } = viewMatrix(s, pageIndex, scale, 0)
  const region: Rect = clip ?? bbox
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, region, true)
  // clear() without a value makes every pixel transparent (clear(0) would be opaque black).
  pix.clear()
  const dev = new m.DrawDevice(ctm, pix)
  try {
    page.runPageContents(dev, m.Matrix.identity)
    page.runPageAnnots(dev, m.Matrix.identity)
    page.runPageWidgets(dev, m.Matrix.identity)
    dev.close()
  } finally {
    dev.destroy()
  }
  return pix
}

function checkRect(r: unknown): Rect {
  if (!Array.isArray(r) || r.length !== 4 || r.some((v) => !Number.isFinite(v))) {
    throw new EngineError('The stamp needs a valid rectangle', 'BAD_SPEC')
  }
  const n = normalizeRect(r as Rect)
  if (n[2] - n[0] < 1 || n[3] - n[1] < 1) throw new EngineError('The stamp is too small', 'BAD_SPEC')
  return n
}

function snapTargets(s: Session, pageIndex: number): SnapTargets {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const pts: number[] = []
  const kinds: number[] = []
  const seen = new Set<number>()
  let full = false
  const add = (x: number, y: number, kind: number) => {
    if (full || !Number.isFinite(x) || !Number.isFinite(y)) return
    const key = Math.round(x * 2) * 100003 + Math.round(y * 2)
    if (seen.has(key)) return
    seen.add(key)
    pts.push(x, y)
    kinds.push(kind)
    if (kinds.length >= MAX_SNAP_POINTS) full = true
  }
  const walk = (path: InstanceType<typeof m.Path>, ctm: Matrix) => {
    let cur: Point | null = null
    let start: Point | null = null
    const tp = (x: number, y: number) => transformPoint([x, y], ctm)
    try {
      path.walk({
        moveTo(x, y) {
          cur = start = tp(x, y)
          add(cur[0], cur[1], 0)
        },
        lineTo(x, y) {
          const p = tp(x, y)
          add(p[0], p[1], 0)
          if (cur) add((cur[0] + p[0]) / 2, (cur[1] + p[1]) / 2, 1)
          cur = p
        },
        curveTo(_x1, _y1, _x2, _y2, x3, y3) {
          const p = tp(x3, y3)
          add(p[0], p[1], 0)
          cur = p
        },
        closePath() {
          if (cur && start && (cur[0] !== start[0] || cur[1] !== start[1])) add((cur[0] + start[0]) / 2, (cur[1] + start[1]) / 2, 1)
          cur = start
        }
      })
    } finally {
      path.destroy()
    }
  }
  const dev = new m.Device({
    fillPath(path, _evenOdd, ctm) {
      walk(path, ctm as Matrix)
    },
    strokePath(path, _stroke, ctm) {
      walk(path, ctm as Matrix)
    },
    fillImage(_image, ctm) {
      for (const c of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1]
      ] as Point[]) {
        const p = transformPoint(c, ctm as Matrix)
        add(p[0], p[1], 0)
      }
    }
  })
  try {
    page.runPageContents(dev, m.Matrix.identity)
    dev.close()
  } finally {
    dev.destroy()
  }
  // Corners of text lines.
  try {
    const st = page.toStructuredText('')
    st.walk({
      beginLine(bbox) {
        const b = bbox as Rect
        add(b[0], b[1], 2)
        add(b[2], b[1], 2)
        add(b[0], b[3], 2)
        add(b[2], b[3], 2)
      }
    })
    st.destroy()
  } catch {}
  // Points of existing annotations (to chain measurements).
  for (const a of page.getAnnotations()) {
    const t = safe(() => a.getType(), '')
    if (t === 'Line') safe(() => (a.getLine() as Point[]).forEach((p) => add(p[0], p[1], 3)), undefined)
    else if (t === 'Polygon' || t === 'PolyLine') safe(() => (a.getVertices() as Point[]).forEach((p) => add(p[0], p[1], 3)), undefined)
  }
  return { points: new Float32Array(pts), kinds: new Uint8Array(kinds) }
}

// ---- ops -------------------------------------------------------------------------------------

export default defineOps('stamps-measure', {
  // ---- measurement scale ----

  /** The document's measurement scale (from the catalog), or null when none was set. */
  getScale(s): MeasureScale | null {
    const d = catalog(s.pdf).get(SCALE_KEY)
    if (isNull(d) || !d.isDictionary()) return null
    return sanitizeScale({
      pageValue: readNumber(d.get('PageValue'), 1),
      pageUnit: readString(d.get('PageUnit')) as MeasureScale['pageUnit'],
      realValue: readNumber(d.get('RealValue'), 1),
      realUnit: readString(d.get('RealUnit')) as MeasureScale['realUnit'],
      precision: readNumber(d.get('Precision'), 2)
    })
  },

  /** Stores the measurement scale in the document catalog (/FartcrobatMeasure). */
  setScale: mutation('Set Measurement Scale', (s, scale: MeasureScale): MeasureScale => {
    const sc = sanitizeScale(scale)
    if (!sc) throw new EngineError('That scale is not valid. Use positive numbers and known units.', 'BAD_SCALE')
    const doc = s.pdf
    const d = doc.newDictionary()
    d.put('PageValue', sc.pageValue)
    d.put('PageUnit', doc.newName(sc.pageUnit))
    d.put('RealValue', sc.realValue)
    d.put('RealUnit', doc.newName(sc.realUnit))
    d.put('Precision', sc.precision)
    d.put('Ratio', doc.newString(scaleToString(sc)))
    catalog(doc).put(SCALE_KEY, d)
    s.documentChanged()
    return sc
  }),

  // ---- measurements ----

  /** Creates a distance (Line), perimeter (PolyLine) or area (Polygon) measurement. */
  addMeasurement: mutation(
    (_page: number, spec: MeasurementSpec) => `Add ${KIND_LABELS[spec?.kind] ?? ''} Measurement`.replace('  ', ' '),
    (s, pageIndex: number, spec: MeasurementSpec): MeasurementInfo => {
      const kind = spec?.kind
      if (kind !== 'distance' && kind !== 'perimeter' && kind !== 'area') throw new EngineError('Unknown measurement type', 'BAD_SPEC')
      const scale = sanitizeScale(spec.scale)
      if (!scale) throw new EngineError('That scale is not valid', 'BAD_SCALE')
      const points = (spec.points ?? []).filter(finitePoint).map((p) => [p[0], p[1]] as Point)
      const min = kind === 'distance' ? 2 : kind === 'perimeter' ? 2 : 3
      if (points.length < min) throw new EngineError(`A ${kind} measurement needs at least ${min} points`, 'BAD_SPEC')
      const page = s.page(pageIndex)
      const doc = s.pdf
      const type = kind === 'distance' ? 'Line' : kind === 'perimeter' ? 'PolyLine' : 'Polygon'
      const annot = page.createAnnotation(type)
      const author = s.state.get('author')
      if (typeof author === 'string' && author) annot.setAuthor(author)
      try {
        annot.setCreationDate(new Date())
        annot.setModificationDate(new Date())
      } catch {}
      annot.setFlags(FLAG_PRINT)
      annot.setColor(hexToRgb(spec.color || DEFAULT_MEASURE_COLOR))
      annot.setBorderWidth(Math.max(0.25, Math.min(12, spec.width ?? 1)))
      annot.setSubject(KIND_SUBJECTS[kind])
      if (kind === 'distance') {
        let [a, b] = [points[0], points[points.length - 1]]
        // Captions read along the line: keep them upright.
        if (a[0] > b[0] || (a[0] === b[0] && a[1] < b[1])) [a, b] = [b, a]
        annot.setLine(a, b)
        annot.setLineEndingStyles('OpenArrow', 'OpenArrow')
        annot.setIntent('LineDimension')
        annot.setLineCaption(spec.showLabel !== false)
      } else {
        annot.setVertices(points)
        annot.getObject().put('IT', doc.newName(kind === 'perimeter' ? 'PolyLineDimension' : 'PolygonDimension'))
      }
      if (spec.showLabel === false) writeExtra(s, annot, { labelHidden: '1' })
      applyMeasurement(s, pageIndex, annot, kind, scale, { forceContents: true })
      s.touch(pageIndex)
      s.documentChanged()
      const list = page.getAnnotations()
      return measurementInfo(s, annot, pageIndex, list.indexOf(annot))!
    }
  ),

  /** Measurements on one page (including ones made by other apps, read from their intent). */
  listMeasurements(s, pageIndex: number): MeasurementInfo[] {
    return listPageMeasurements(s, pageIndex)
  },

  /** Every measurement in the document (for export). */
  listAllMeasurements(s): MeasurementInfo[] {
    const out: MeasurementInfo[] = []
    const n = s.pageCount()
    for (let i = 0; i < n; i++) out.push(...listPageMeasurements(s, i))
    return out
  },

  /** Shows or hides the value drawn on the page (line caption or label). */
  setLineCaption: mutation(
    (_id: number, on: boolean) => (on ? 'Show Measurement Label' : 'Hide Measurement Label'),
    (s, id: number, on: boolean, hintPage?: number) => {
      const { annot, pageIndex } = s.requireAnnotation(id, hintPage)
      const type = annot.getType()
      const extra = readExtra(annot)
      if (type === 'Line') {
        annot.setLineCaption(on)
        if (extra.fartcrobat === 'measure') writeExtra(s, annot, { labelHidden: on ? '0' : '1' })
        annot.update()
      } else if ((type === 'Polygon' || type === 'PolyLine') && extra.fartcrobat === 'measure') {
        writeExtra(s, annot, { labelHidden: on ? '0' : '1' })
        bakePolyAppearance(s, pageIndex, annot, on ? (extra.label ?? safe(() => annot.getContents(), '')) : null)
      } else {
        throw new EngineError('Only measurements have labels to show or hide', 'BAD_ANNOT')
      }
      s.touch(pageIndex)
      s.documentChanged()
    }
  ),

  /** Recalculates measurements with a new scale. Returns how many were updated. */
  rescaleMeasurements: mutation('Change Measurement Scale', (s, ids: number[], scale: MeasureScale, hintPage?: number): number => {
    const sc = sanitizeScale(scale)
    if (!sc) throw new EngineError('That scale is not valid', 'BAD_SCALE')
    let count = 0
    for (const id of ids) {
      const found = s.findAnnotation(id, hintPage)
      if (!found) continue
      const extra = readExtra(found.annot)
      if (extra.fartcrobat !== 'measure') continue
      const kind = extra.kind as MeasureKind
      if (kind !== 'distance' && kind !== 'perimeter' && kind !== 'area') continue
      applyMeasurement(s, found.pageIndex, found.annot, kind, sc)
      s.touch(found.pageIndex)
      count++
    }
    s.documentChanged()
    return count
  }),

  /**
   * Brings measurements on a page up to date after another tool changed them (moved, resized,
   * recoloured): recalculates values from the new geometry and redraws labels MuPDF dropped.
   * The fix-up joins the undo step of the change that caused it. Returns the number fixed.
   */
  refreshMeasurements(s, pageIndex: number): number {
    if (!s.doc || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= s.pageCount()) return 0
    const doc = s.pdf
    // Never touch the history while there is something to redo (it would be discarded).
    if (safe(() => doc.canRedo(), false)) return 0
    const page = s.page(pageIndex)
    const work: (() => void)[] = []
    for (const annot of page.getAnnotations()) {
      const extra = readExtra(annot)
      if (extra.fartcrobat !== 'measure') continue
      const kind = extra.kind as MeasureKind
      if (kind !== 'distance' && kind !== 'perimeter' && kind !== 'area') continue
      const scale = parseScale(extra.scale ?? '', Number(extra.precision ?? 2))
      if (!scale) continue
      const pts = annotPoints(annot, kind)
      if (pts.length < 2) continue
      const r = measureShape(kind, pts, scale)
      const stored = Number(extra.value)
      const valueChanged = !Number.isFinite(stored) || Math.abs(r.value - stored) > 1e-6 * Math.max(1, Math.abs(r.value))
      const apStale = kind !== 'distance' && !hasOurAppearance(annot)
      if (!valueChanged && !apStale) continue
      work.push(() => {
        if (valueChanged) applyMeasurement(s, pageIndex, annot, kind, scale)
        else bakePolyAppearance(s, pageIndex, annot, extra.labelHidden === '1' ? null : (extra.label ?? r.label))
      })
    }
    if (!work.length) return 0
    let began = false
    try {
      doc.beginImplicitOperation()
      began = true
    } catch {}
    try {
      for (const w of work) w()
      if (began) doc.endOperation()
    } catch (err) {
      if (began) {
        try {
          doc.abandonOperation()
        } catch {}
      }
      s.invalidatePages()
      s.touchAll()
      throw err
    }
    s.touch(pageIndex)
    s.documentChanged()
    return work.length
  },

  /** End points, midpoints, image corners and text-line corners on a page, for snapping. */
  snapPoints(s, pageIndex: number) {
    const t = snapTargets(s, pageIndex)
    return withTransfer(t, [t.points.buffer as ArrayBuffer, t.kinds.buffer as ArrayBuffer])
  },

  // ---- stamps ----

  /**
   * Adds a Stamp annotation. Without an image MuPDF draws it from its /Name. On rotated pages the
   * appearance is turned so the stamp reads upright.
   */
  addStamp: mutation('Add Stamp', (s, pageIndex: number, spec: StampSpec): AnnotInfo => {
    if (!spec || typeof spec.name !== 'string' || !spec.name) throw new EngineError('The stamp needs a name', 'BAD_SPEC')
    const rect = checkRect(spec.rect)
    const page = s.page(pageIndex)
    const rotation = pageRotation(s, pageIndex)
    const m = s.mupdf
    let image: MupdfImage | null = null
    if (spec.image) {
      try {
        image = new m.Image(spec.image)
      } catch (err) {
        throw new EngineError(`The stamp image could not be read: ${(err as Error).message}`, 'BAD_IMAGE')
      }
    } else if (rotation !== 0) {
      // MuPDF draws named stamps unrotated; use an upright picture of it instead.
      const pix = renderBuiltinStamp(s, spec.name, spec.color, 8)
      image = new m.Image(pix)
    }
    if (image && rotation !== 0) image = rotateImage(s, image, 360 - rotation)
    const annot = page.createAnnotation('Stamp')
    const author = s.state.get('author')
    if (typeof author === 'string' && author) annot.setAuthor(author)
    try {
      annot.setCreationDate(new Date())
      annot.setModificationDate(new Date())
    } catch {}
    annot.setFlags(FLAG_PRINT)
    annot.setRect(rect)
    annot.setIcon(spec.name)
    if (spec.color) annot.setColor(hexToRgb(spec.color))
    annot.setSubject(spec.label || spec.name)
    if (spec.contents) annot.setContents(spec.contents)
    if (image) annot.setStampImage(image)
    writeExtra(s, annot, { fartcrobat: 'stamp', ...(spec.extra ?? {}) })
    annot.update()
    s.touch(pageIndex)
    s.documentChanged()
    return annotInfo(s, annot, pageIndex, page.getAnnotations().indexOf(annot))
  }),

  /** PNG of a stamp MuPDF draws from its name (for palette previews). */
  stampPreview(s, name: string, color: string | undefined, scale = 2) {
    const pix = renderBuiltinStamp(s, name, color, Math.max(0.5, Math.min(12, scale)))
    try {
      const png = pix.asPNG().slice()
      return withTransfer(png, [png.buffer as ArrayBuffer])
    } finally {
      pix.destroy()
    }
  },

  /**
   * PNG of a page for "Create custom stamp from a PDF page": transparent background, trimmed to the
   * page content when `trim` is set.
   */
  pageImage(s, pageIndex: number, opts: { maxPx?: number; trim?: boolean } = {}) {
    const b = s.pageBounds(pageIndex)
    const w = b[2] - b[0]
    const h = b[3] - b[1]
    const maxPx = Math.max(64, Math.min(4000, opts.maxPx ?? 1600))
    const scale = Math.min(maxPx / Math.max(w, h), 6)
    let pix = renderTransparent(s, pageIndex, scale)
    let crop: Rect | null = null
    if (opts.trim) {
      const pw = pix.getWidth()
      const ph = pix.getHeight()
      const n = pix.getNumberOfComponents()
      const stride = pix.getStride()
      const px = pix.getPixels()
      let x0 = pw
      let y0 = ph
      let x1 = -1
      let y1 = -1
      for (let y = 0; y < ph; y++) {
        const row = y * stride
        for (let x = 0; x < pw; x++) {
          if (px[row + x * n + n - 1] > 8) {
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
        }
      }
      if (x1 >= x0 && y1 >= y0) {
        const m = 2
        crop = [Math.max(0, x0 - m), Math.max(0, y0 - m), Math.min(pw, x1 + 1 + m), Math.min(ph, y1 + 1 + m)]
      }
    }
    if (crop) {
      pix.destroy()
      pix = renderTransparent(s, pageIndex, scale, crop)
    }
    try {
      const png = pix.asPNG().slice()
      return withTransfer(
        { png, width: pix.getWidth(), height: pix.getHeight(), empty: opts.trim ? !crop : false },
        [png.buffer as ArrayBuffer]
      )
    } finally {
      pix.destroy()
    }
  }
})
