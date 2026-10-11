import type { Point, Rect } from '@shared/geometry'
import { hexToRgb, normalizeRect, rgbToHex } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import type { RenderResult } from '@engine/ops/render'
import type { PDFAnnotation, PDFPage, Session } from '@engine/session'
import { FLAG_LOCKED, FLAG_PRINT, transformAnnotation } from '@engine/ops/annots'
import { isNull, pageBoxes, readString } from '@engine/util/pdf'
import {
  clampSize,
  DEFAULT_COLOR,
  DEFAULT_TEXT_SIZE,
  FILLSIGN_TAG,
  isFillSignKind,
  isMarkKind,
  isSignatureKind,
  isTextKind,
  kindLabel,
  LINE_HEIGHT,
  lineWidthFor,
  markDimensions,
  markStrokes,
  rectAround,
  rectCenter,
  TEXT_SLACK,
  type FillSignItem,
  type FillSignKind,
  type MarkKind,
  type SignatureKind,
  type TextKind
} from './shared'

/**
 * Fill & Sign engine operations (namespace 'fill-sign'). Every item is an ordinary PDF annotation
 * (FreeText for text, Ink/Circle for marks, Stamp with an image for signatures) tagged with
 * FartcrobatData { fartcrobat: 'fillsign', kind, size } so it opens in any PDF viewer and Fartcrobat
 * can still recognise and edit it.
 */

interface Found {
  annot: PDFAnnotation
  page: PDFPage
  pageIndex: number
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function readData(annot: PDFAnnotation): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const d = annot.getObject().get('FartcrobatData')
    if (!isNull(d) && d.isDictionary()) d.forEach((v, k) => (out[String(k)] = readString(v)))
  } catch {}
  return out
}

function writeData(s: Session, annot: PDFAnnotation, data: Record<string, string>) {
  const obj = annot.getObject()
  let d = obj.get('FartcrobatData')
  if (isNull(d) || !d.isDictionary()) {
    obj.put('FartcrobatData', s.pdf.newDictionary())
    d = obj.get('FartcrobatData')
  }
  for (const [k, v] of Object.entries(data)) d.put(k, s.pdf.newString(v))
}

function colorOf(annot: PDFAnnotation, kind: FillSignKind): string {
  if (isTextKind(kind)) {
    const da = safe(() => annot.getDefaultAppearance() as { color: number[] }, null)
    if (da?.color?.length) return rgbToHex(da.color.length === 1 ? [da.color[0], da.color[0], da.color[0]] : da.color)
    return DEFAULT_COLOR
  }
  const c = safe(() => annot.getColor() as number[], [])
  return c.length ? rgbToHex(c.length === 1 ? [c[0], c[0], c[0]] : c) : DEFAULT_COLOR
}

function rgb(hex: string | undefined): [number, number, number] {
  try {
    return hexToRgb(hex || DEFAULT_COLOR)
  } catch {
    return [0, 0, 0]
  }
}

function inkBox(annot: PDFAnnotation): Rect | null {
  const ink = safe(() => (annot.hasInkList() ? (annot.getInkList() as Point[][]) : []), [])
  let box: Rect | null = null
  for (const stroke of ink)
    for (const [x, y] of stroke) {
      if (!box) box = [x, y, x, y]
      else box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]
    }
  return box
}

/** The visual box of an item (what the user sees and drags). */
function visualRect(annot: PDFAnnotation, kind: FillSignKind): Rect {
  if (kind === 'check' || kind === 'cross' || kind === 'line' || kind === 'box') {
    const box = inkBox(annot)
    if (box) {
      const lw = safe(() => annot.getBorderWidth(), 1)
      return [box[0] - lw / 2, box[1] - lw / 2, box[2] + lw / 2, box[3] + lw / 2]
    }
  }
  return (safe(() => annot.hasRect(), false) ? annot.getRect() : annot.getBounds()) as Rect
}

/** Size derived from the geometry, used when the stored size is missing or stale. */
function derivedSize(kind: FillSignKind, rect: Rect, annot: PDFAnnotation): number {
  const w = rect[2] - rect[0]
  const h = rect[3] - rect[1]
  switch (kind) {
    case 'check':
      return h / 0.7
    case 'cross':
      return h / 0.65
    case 'dot':
      return w / 0.45
    case 'box':
      return h / 2
    case 'line':
      return safe(() => annot.getBorderWidth(), 1.32) / 0.11
    case 'signature':
    case 'initials':
      return h
    default: {
      const da = safe(() => annot.getDefaultAppearance() as { size: number }, null)
      return da?.size || DEFAULT_TEXT_SIZE
    }
  }
}

function sizeOf(annot: PDFAnnotation, kind: FillSignKind, rect: Rect, data: Record<string, string>): number {
  const derived = derivedSize(kind, rect, annot)
  if (isTextKind(kind)) return Math.round(derived * 100) / 100
  const stored = parseFloat(data.size)
  if (Number.isFinite(stored) && stored > 0 && Math.abs(stored - derived) / Math.max(derived, 0.01) < 0.06) return stored
  return Math.round(derived * 100) / 100
}

function itemOf(s: Session, annot: PDFAnnotation, pageIndex: number, position: number): FillSignItem | null {
  const data = readData(annot)
  if (data.fartcrobat !== FILLSIGN_TAG || !isFillSignKind(data.kind)) return null
  const kind = data.kind
  const rect = visualRect(annot, kind)
  return {
    id: s.annotationId(annot, pageIndex, position),
    page: pageIndex,
    kind,
    rect,
    bounds: safe(() => annot.getBounds() as Rect, rect),
    text: isTextKind(kind) ? safe(() => annot.getContents(), '') : '',
    size: sizeOf(annot, kind, rect, data),
    color: colorOf(annot, kind),
    locked: (safe(() => annot.getFlags(), 0) & FLAG_LOCKED) !== 0
  }
}

function find(s: Session, id: number, hintPage?: number): Found {
  const found = s.findAnnotation(id, hintPage)
  if (!found) throw new EngineError('That item no longer exists. It may have been deleted.', 'NO_ANNOTATION')
  const data = readData(found.annot)
  if (data.fartcrobat !== FILLSIGN_TAG) throw new EngineError('That annotation was not added with Fill & Sign', 'NOT_FILLSIGN')
  return found
}

function describe(s: Session, f: Found): FillSignItem {
  const position = f.page.getAnnotations().indexOf(f.annot)
  const item = itemOf(s, f.annot, f.pageIndex, position)
  if (!item) throw new EngineError('That annotation was not added with Fill & Sign', 'NOT_FILLSIGN')
  return item
}

function kindOf(f: Found): FillSignKind {
  const k = readData(f.annot).kind
  if (!isFillSignKind(k)) throw new EngineError('Unknown Fill & Sign item', 'BAD_KIND')
  return k
}

function stamp(s: Session, annot: PDFAnnotation, kind: FillSignKind, size: number) {
  writeData(s, annot, { fartcrobat: FILLSIGN_TAG, kind, size: String(Math.round(size * 100) / 100) })
  const author = s.state.get('author')
  if (typeof author === 'string' && author && safe(() => annot.hasAuthor(), false)) annot.setAuthor(author)
  if (safe(() => annot.hasSubject(), false)) annot.setSubject(kindLabel(kind))
  try {
    annot.setModificationDate(new Date())
  } catch {}
}

function changed(s: Session, ...pages: number[]) {
  s.touch(...pages)
  s.documentChanged()
}

function assertUnlocked(f: Found) {
  if ((safe(() => f.annot.getFlags(), 0) & FLAG_LOCKED) !== 0) {
    throw new EngineError('This item is locked and cannot be changed', 'LOCKED')
  }
}

// ---- text ------------------------------------------------------------------------------------

function lineCount(text: string): number {
  return Math.max(1, text.split('\n').length)
}

/** Width of the widest line as MuPDF lays it out (handles fallback fonts for any script). */
function measureText(annot: PDFAnnotation, x: number, y: number, text: string, size: number): number {
  if (!text.trim()) return 0
  annot.setRect([x, y, x + 20000, y + (lineCount(text) + 2) * size * LINE_HEIGHT])
  annot.update()
  let maxX = x
  const list = annot.toDisplayList()
  try {
    const st = list.toStructuredText('preserve-whitespace')
    try {
      st.walk({
        onChar(_c, _origin, _font, _size, quad) {
          maxX = Math.max(maxX, quad[0], quad[2], quad[4], quad[6])
        }
      })
    } finally {
      st.destroy()
    }
  } finally {
    list.destroy()
  }
  return Math.max(0, maxX - x)
}

/** Sets contents, font and colour of a FreeText item and fits its rect to the text (top-left fixed). */
function layoutText(annot: PDFAnnotation, x: number, y: number, text: string, size: number, color: string) {
  annot.setDefaultAppearance('Helv', size, rgb(color))
  annot.setContents(text)
  const width = measureText(annot, x, y, text, size)
  const w = Math.max(width + TEXT_SLACK, size * 0.6)
  const h = lineCount(text) * size * LINE_HEIGHT
  annot.setRect([x, y, x + w, y + h])
  annot.update()
}

function createText(s: Session, page: PDFPage, topLeft: Point, kind: TextKind, text: string, size: number, color: string) {
  const annot = page.createAnnotation('FreeText')
  try {
    annot.setCreationDate(new Date())
  } catch {}
  annot.setFlags(FLAG_PRINT)
  if (safe(() => annot.hasBorder(), false)) annot.setBorderWidth(0)
  annot.setColor([])
  stamp(s, annot, kind, size)
  layoutText(annot, topLeft[0], topLeft[1], text, size, color)
  return annot
}

// ---- marks -----------------------------------------------------------------------------------

/** (Re)draws a mark so that its visual box is `rect`. */
function drawMark(annot: PDFAnnotation, kind: MarkKind, rect: Rect, size: number, color: string) {
  const c = rgb(color)
  if (kind === 'dot') {
    annot.setRect(rect)
    annot.setColor(c)
    annot.setInteriorColor(c)
    annot.setBorderWidth(0)
  } else {
    const lw = lineWidthFor(size)
    annot.setColor(c)
    annot.setBorderWidth(lw)
    annot.setInkList(markStrokes(kind, rect, lw))
  }
  annot.update()
}

function createMark(s: Session, page: PDFPage, rect: Rect, kind: MarkKind, size: number, color: string) {
  const annot = page.createAnnotation(kind === 'dot' ? 'Circle' : 'Ink')
  try {
    annot.setCreationDate(new Date())
  } catch {}
  annot.setFlags(FLAG_PRINT)
  stamp(s, annot, kind, size)
  drawMark(annot, kind, rect, size, color)
  return annot
}

// ---- signatures ------------------------------------------------------------------------------

type MupdfImage = InstanceType<Session['mupdf']['Image']>

/**
 * Stamp appearances are drawn in unrotated PDF space, so on a page with /Rotate the image would
 * show sideways. Turning the image the other way first keeps it upright on screen, and it stays
 * correct whoever later moves or resizes the stamp (MuPDF regenerates the same appearance).
 */
function uprightImage(s: Session, image: MupdfImage, pageRotation: number): MupdfImage {
  const angle = (360 - (((pageRotation % 360) + 360) % 360)) % 360
  if (!angle) return image
  const m = s.mupdf
  const w = image.getWidth()
  const h = image.getHeight()
  const swap = angle === 90 || angle === 270
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, swap ? h : w, swap ? w : h], true)
  try {
    pix.clear()
    let ctm = m.Matrix.concat([w, 0, 0, h, 0, 0], m.Matrix.rotate(angle))
    const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]]
    const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]]
    ctm = m.Matrix.concat(ctm, m.Matrix.translate(-Math.min(...xs), -Math.min(...ys)))
    const dev = new m.DrawDevice(m.Matrix.identity, pix)
    try {
      dev.fillImage(image, ctm, 1)
      dev.close()
    } finally {
      dev.destroy()
    }
    return new m.Image(pix.asPNG())
  } finally {
    pix.destroy()
  }
}

function createSignature(s: Session, page: PDFPage, pageIndex: number, rect: Rect, png: Uint8Array, kind: SignatureKind) {
  if (!png || !png.length) throw new EngineError('The signature image is empty', 'BAD_IMAGE')
  let image: MupdfImage
  try {
    image = uprightImage(s, new s.mupdf.Image(png), pageBoxes(s.pdf, pageIndex).rotation)
  } catch (err) {
    throw new EngineError(`The signature image could not be read: ${(err as Error).message}`, 'BAD_IMAGE')
  }
  const annot = page.createAnnotation('Stamp')
  try {
    annot.setCreationDate(new Date())
  } catch {}
  annot.setFlags(FLAG_PRINT)
  annot.setRect(normalizeRect(rect))
  annot.setStampImage(image)
  stamp(s, annot, kind, rect[3] - rect[1])
  annot.update()
  return annot
}

// ---- generic changes -------------------------------------------------------------------------

/** Moves/resizes any item so that its visual box becomes `rect`. */
function applyRect(s: Session, f: Found, kind: FillSignKind, rect: Rect, size?: number) {
  const annot = f.annot
  const r = normalizeRect(rect)
  if (isTextKind(kind)) {
    const old = visualRect(annot, kind)
    const oldSize = sizeOf(annot, kind, old, readData(annot))
    const newSize = size ?? clampSize(oldSize * ((r[3] - r[1]) / Math.max(0.01, old[3] - old[1])))
    layoutText(annot, r[0], r[1], safe(() => annot.getContents(), ''), newSize, colorOf(annot, kind))
    stamp(s, annot, kind, newSize)
  } else if (isMarkKind(kind)) {
    const old = visualRect(annot, kind)
    const oldSize = sizeOf(annot, kind, old, readData(annot))
    let newSize = size
    if (newSize === undefined) {
      if (kind === 'line') newSize = oldSize
      else {
        const before = Math.min(old[2] - old[0], old[3] - old[1])
        const after = Math.min(r[2] - r[0], r[3] - r[1])
        newSize = clampSize(oldSize * (after / Math.max(0.01, before)))
      }
    }
    let target = r
    if (kind === 'line') {
      // a line keeps its stroke width as height
      const lw = lineWidthFor(newSize)
      const cy = (r[1] + r[3]) / 2
      target = [r[0], cy - lw / 2, r[2], cy + lw / 2]
    }
    stamp(s, annot, kind, newSize)
    drawMark(annot, kind, target, newSize, colorOf(annot, kind))
  } else {
    annot.setRect(r)
    stamp(s, annot, kind, r[3] - r[1])
    annot.update()
  }
  changed(s, f.pageIndex)
}

function topLeftForText(at: Point, size: number): Point {
  // the click point is where the first line's text starts, vertically centred on it
  return [at[0], at[1] - (size * LINE_HEIGHT) / 2]
}

function pageSize(s: Session, pageIndex: number): [number, number] {
  const b = s.pageBounds(pageIndex)
  return [b[2] - b[0], b[3] - b[1]]
}

function fitInside(s: Session, pageIndex: number, r: Rect): Rect {
  const [pw, ph] = pageSize(s, pageIndex)
  const w = r[2] - r[0]
  const h = r[3] - r[1]
  let x = Math.min(r[0], pw - w)
  let y = Math.min(r[1], ph - h)
  x = Math.max(0, x)
  y = Math.max(0, y)
  return [x, y, x + w, y + h]
}

export interface AddTextOptions {
  kind?: TextKind
  text?: string
  size?: number
  color?: string
  /** Treat `at` as the top-left corner instead of the click point. */
  topLeft?: boolean
}

/** Straight (non-premultiplied) RGBA, as ImageData expects. */
function unpremultiply(px: Uint8ClampedArray) {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]
    if (a === 0 || a === 255) continue
    px[i] = Math.min(255, Math.round((px[i] * 255) / a))
    px[i + 1] = Math.min(255, Math.round((px[i + 1] * 255) / a))
    px[i + 2] = Math.min(255, Math.round((px[i + 2] * 255) / a))
  }
}

export default defineOps('fill-sign', {
  /** Fill & Sign items on a page, in drawing order. */
  list(s, pageIndex: number): FillSignItem[] {
    const page = s.page(pageIndex)
    const out: FillSignItem[] = []
    page.getAnnotations().forEach((a, k) => {
      const item = itemOf(s, a, pageIndex, k)
      if (item) out.push(item)
    })
    return out
  },

  /** Every Fill & Sign item in the document. */
  listAll(s): FillSignItem[] {
    const out: FillSignItem[] = []
    const n = s.pageCount()
    for (let p = 0; p < n; p++) {
      s.page(p)
        .getAnnotations()
        .forEach((a, k) => {
          const item = itemOf(s, a, p, k)
          if (item) out.push(item)
        })
    }
    return out
  },

  get(s, id: number, hintPage?: number): FillSignItem {
    return describe(s, find(s, id, hintPage))
  },

  /**
   * Transparent image of one item (its full bounds) at `scale` pixels per point, for the live
   * preview while it is dragged or resized.
   */
  async preview(s, id: number, scale: number, hintPage?: number) {
    const f = find(s, id, hintPage)
    const m = s.mupdf
    const z = Math.max(0.05, Math.min(16, scale))
    const pix = f.annot.toPixmap([z, 0, 0, z, 0, 0], m.ColorSpace.DeviceRGB, true)
    try {
      const width = pix.getWidth()
      const height = pix.getHeight()
      const pixels = new Uint8ClampedArray(pix.getPixels())
      unpremultiply(pixels)
      if (typeof createImageBitmap === 'function' && typeof ImageData === 'function') {
        const bitmap = await createImageBitmap(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height))
        const result: RenderResult = { width, height, x: pix.getX(), y: pix.getY(), bitmap }
        return withTransfer(result, [bitmap])
      }
      const result: RenderResult = { width, height, x: pix.getX(), y: pix.getY(), pixels }
      return withTransfer(result, [pixels.buffer as ArrayBuffer])
    } finally {
      pix.destroy()
    }
  },

  /** Adds a text (or date) item. `at` is the click point: text starts there, centred on the first line. */
  addText: mutation(
    (_page: number, _at: Point, opts: AddTextOptions = {}) => `Add ${kindLabel(opts.kind ?? 'text')}`,
    (s, pageIndex: number, at: Point, opts: AddTextOptions = {}): FillSignItem => {
      const page = s.page(pageIndex)
      const size = clampSize(opts.size ?? DEFAULT_TEXT_SIZE)
      const kind = opts.kind ?? 'text'
      const tl = opts.topLeft ? at : topLeftForText(at, size)
      const [pw, ph] = pageSize(s, pageIndex)
      const x = Math.max(0, Math.min(tl[0], pw - size))
      const y = Math.max(0, Math.min(tl[1], ph - size * LINE_HEIGHT))
      const annot = createText(s, page, [x, y], kind, opts.text ?? '', size, opts.color ?? DEFAULT_COLOR)
      changed(s, pageIndex)
      return describe(s, { annot, page, pageIndex })
    }
  ),

  /** Replaces the text of a text/date item and refits its box (the top-left corner stays put). */
  setText: mutation('Edit Text', (s, id: number, text: string, hintPage?: number): FillSignItem => {
    const f = find(s, id, hintPage)
    const kind = kindOf(f)
    if (!isTextKind(kind)) throw new EngineError('Only text items have text', 'BAD_KIND')
    assertUnlocked(f)
    const r = visualRect(f.annot, kind)
    const size = sizeOf(f.annot, kind, r, readData(f.annot))
    layoutText(f.annot, r[0], r[1], text.replace(/\r\n?/g, '\n'), size, colorOf(f.annot, kind))
    stamp(s, f.annot, kind, size)
    changed(s, f.pageIndex)
    return describe(s, f)
  }),

  /** Adds a check/cross/dot/line/rounded box centred on a point. */
  addMark: mutation(
    (_page: number, _center: Point, kind: MarkKind) => `Add ${kindLabel(kind)}`,
    (s, pageIndex: number, center: Point, kind: MarkKind, opts: { size?: number; color?: string } = {}): FillSignItem => {
      if (!isMarkKind(kind)) throw new EngineError(`Unknown mark ${kind}`, 'BAD_KIND')
      const page = s.page(pageIndex)
      const size = clampSize(opts.size ?? DEFAULT_TEXT_SIZE)
      const [w, h] = markDimensions(kind, size)
      const rect = fitInside(s, pageIndex, rectAround(center, w, h))
      const annot = createMark(s, page, rect, kind, size, opts.color ?? DEFAULT_COLOR)
      changed(s, pageIndex)
      return describe(s, { annot, page, pageIndex })
    }
  ),

  /** Places a signature or initials image (transparent PNG) in `rect`. */
  addSignature: mutation(
    (_page: number, _rect: Rect, _png: Uint8Array, kind: SignatureKind = 'signature') => `Add ${kindLabel(kind)}`,
    (s, pageIndex: number, rect: Rect, png: Uint8Array, kind: SignatureKind = 'signature'): FillSignItem => {
      if (!isSignatureKind(kind)) throw new EngineError(`Unknown signature kind ${kind}`, 'BAD_KIND')
      const page = s.page(pageIndex)
      const annot = createSignature(s, page, pageIndex, fitInside(s, pageIndex, normalizeRect(rect)), png, kind)
      changed(s, pageIndex)
      return describe(s, { annot, page, pageIndex })
    }
  ),

  /** Moves an item by an offset (page space). `kind` only names the undo step. */
  move: mutation(
    (_id: number, _dx: number, _dy: number, kind?: FillSignKind) => `Move ${kindLabel(kind)}`,
    (s, id: number, dx: number, dy: number, _kind?: FillSignKind, hintPage?: number): FillSignItem => {
      const f = find(s, id, hintPage)
      assertUnlocked(f)
      const kind = kindOf(f)
      if (isTextKind(kind) || kind === 'signature' || kind === 'initials' || kind === 'dot') {
        const r = f.annot.getRect() as Rect
        f.annot.setRect([r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy])
        f.annot.update()
      } else {
        const b = f.annot.getBounds() as Rect
        transformAnnotation(f.annot, [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy])
        f.annot.update()
      }
      try {
        f.annot.setModificationDate(new Date())
      } catch {}
      changed(s, f.pageIndex)
      return describe(s, f)
    }
  ),

  /** Moves/resizes an item to a new visual box. Text scales its font; marks are redrawn crisply. */
  resize: mutation(
    (_id: number, _rect: Rect, kind?: FillSignKind) => `Resize ${kindLabel(kind)}`,
    (s, id: number, rect: Rect, _kind?: FillSignKind, hintPage?: number): FillSignItem => {
      const f = find(s, id, hintPage)
      assertUnlocked(f)
      applyRect(s, f, kindOf(f), rect)
      return describe(s, f)
    }
  ),

  /** Sets the font size of text, or the size of a mark/signature (scaled around its centre). */
  setSize: mutation(
    (_id: number, _size: number, kind?: FillSignKind) => (kind && isTextKind(kind) ? 'Change Text Size' : `Resize ${kindLabel(kind)}`),
    (s, id: number, size: number, _kind?: FillSignKind, hintPage?: number): FillSignItem => {
      const f = find(s, id, hintPage)
      assertUnlocked(f)
      const kind = kindOf(f)
      const target = clampSize(size)
      const r = visualRect(f.annot, kind)
      const current = sizeOf(f.annot, kind, r, readData(f.annot))
      if (isTextKind(kind)) {
        applyRect(s, f, kind, r, target)
      } else {
        const factor = target / Math.max(0.01, current)
        const c = rectCenter(r)
        const scaled = rectAround(c, (r[2] - r[0]) * factor, (r[3] - r[1]) * factor)
        applyRect(s, f, kind, fitInside(s, f.pageIndex, scaled), isMarkKind(kind) ? target : undefined)
      }
      return describe(s, f)
    }
  ),

  /** Changes the colour of a text item or a mark. */
  setColor: mutation('Change Colour', (s, id: number, color: string, hintPage?: number): FillSignItem => {
    const f = find(s, id, hintPage)
    assertUnlocked(f)
    const kind = kindOf(f)
    if (isTextKind(kind)) {
      const r = visualRect(f.annot, kind)
      layoutText(f.annot, r[0], r[1], safe(() => f.annot.getContents(), ''), sizeOf(f.annot, kind, r, readData(f.annot)), color)
    } else if (isMarkKind(kind)) {
      const r = visualRect(f.annot, kind)
      drawMark(f.annot, kind, r, sizeOf(f.annot, kind, r, readData(f.annot)), color)
    } else {
      throw new EngineError('The colour of a signature cannot be changed here', 'BAD_KIND')
    }
    try {
      f.annot.setModificationDate(new Date())
    } catch {}
    changed(s, f.pageIndex)
    return describe(s, f)
  }),

  /**
   * Turns an item into another kind of mark (or into text), at the same place and size, like the
   * mark menu on Acrobat's Fill & Sign field toolbar.
   */
  convert: mutation(
    (_id: number, kind: FillSignKind) => `Change to ${kindLabel(kind)}`,
    (s, id: number, kind: TextKind | MarkKind, opts: { text?: string } = {}, hintPage?: number): FillSignItem => {
      const f = find(s, id, hintPage)
      assertUnlocked(f)
      const from = kindOf(f)
      if (isSignatureKind(from)) throw new EngineError('Signatures cannot be changed into marks', 'BAD_KIND')
      if (!isTextKind(kind) && !isMarkKind(kind)) throw new EngineError(`Cannot change an item into ${kind}`, 'BAD_KIND')
      const r = visualRect(f.annot, from)
      const size = clampSize(sizeOf(f.annot, from, r, readData(f.annot)))
      const color = colorOf(f.annot, from)
      const text = isTextKind(from) ? safe(() => f.annot.getContents(), '') : ''
      let annot: PDFAnnotation
      if (isTextKind(kind)) {
        // keep the left edge; centre the first line on the old item's middle
        const c = rectCenter(r)
        annot = createText(s, f.page, topLeftForText([r[0], c[1]], size), kind, opts.text ?? text, size, color)
      } else {
        const [w, h] = markDimensions(kind, size)
        const c: Point = isTextKind(from) ? [r[0] + w / 2, rectCenter(r)[1]] : rectCenter(r)
        annot = createMark(s, f.page, fitInside(s, f.pageIndex, rectAround(c, w, h)), kind, size, color)
      }
      f.page.deleteAnnotation(f.annot)
      changed(s, f.pageIndex)
      return describe(s, { annot, page: f.page, pageIndex: f.pageIndex })
    }
  ),

  /** Deletes items. */
  remove: mutation(
    (ids: number[], kind?: FillSignKind) => (ids.length > 1 ? 'Delete Items' : `Delete ${kindLabel(kind)}`),
    (s, ids: number[], _kind?: FillSignKind, hintPage?: number) => {
      for (const id of ids) {
        const f = find(s, id, hintPage)
        assertUnlocked(f)
        f.page.deleteAnnotation(f.annot)
        s.touch(f.pageIndex)
      }
      s.documentChanged()
    }
  )
})
