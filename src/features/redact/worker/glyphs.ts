/**
 * Runs a page through a MuPDF device to find text that cannot be seen: invisible text (render
 * mode 3, as written by OCR software) and text that is completely covered by an opaque box or image
 * drawn on top of it. Also removes such glyphs precisely with MuPDF's redaction filter.
 */
import type { Matrix, Quad, Rect } from '@shared/geometry'
import { transformPoint } from '@shared/geometry'
import type { Session } from '@engine/session'
import { isNull, readName } from '@engine/util/pdf'

export interface Glyph {
  /** Unicode character (for reports and matching). */
  ch: string
  /** Glyph box (page space). */
  box: Quad
  /** Core of the glyph (inner part of its box) used to remove it without touching neighbours. */
  core: Quad
  /** Where the glyph's ink usually is (baseline to cap height), to decide whether it is covered. */
  ink: Quad
  /** Paint order of the text object that drew it. */
  order: number
}

export interface PageGlyphs {
  visible: Glyph[]
  invisible: Glyph[]
  /** Opaque rectangles painted on the page, in paint order. */
  covers: { rect: Rect; order: number }[]
}

type MuMatrix = Matrix
interface MuFont {
  advanceGlyph(g: number, wmode?: number): number
}
interface MuText {
  walk(w: { showGlyph?(font: MuFont, trm: MuMatrix, glyph: number, unicode: number, wmode: number): void }): void
}
interface MuPath {
  walk(w: { moveTo?(x: number, y: number): void; lineTo?(x: number, y: number): void; curveTo?(...a: number[]): void; closePath?(): void }): void
}
interface MuImage {
  getMask(): unknown
  getImageMask(): boolean
}

function concat(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5]
  ]
}

function quadOf(m: Matrix, x0: number, y0: number, x1: number, y1: number): Quad {
  // text space has y up: the upper edge is y1
  const ul = transformPoint([x0, y1], m)
  const ur = transformPoint([x1, y1], m)
  const ll = transformPoint([x0, y0], m)
  const lr = transformPoint([x1, y0], m)
  return [ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]]
}

export function quadBounds(q: Quad): Rect {
  const xs = [q[0], q[2], q[4], q[6]]
  const ys = [q[1], q[3], q[5], q[7]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function glyphsOf(text: MuText, ctm: Matrix, order: number): Glyph[] {
  const out: Glyph[] = []
  text.walk({
    showGlyph(font, trm, glyph, unicode, wmode) {
      const m = concat(trm as Matrix, ctm)
      let adv = 0.5
      try {
        adv = font.advanceGlyph(glyph, wmode) || 0.5
      } catch {}
      out.push({
        ch: unicode > 0 ? String.fromCodePoint(unicode) : '',
        box: quadOf(m, 0, -0.2, adv, 0.8),
        core: quadOf(m, adv * 0.3, 0.1, adv * 0.7, 0.45),
        ink: quadOf(m, adv * 0.1, 0, adv * 0.9, 0.7),
        order
      })
    }
  })
  return out
}

/** Axis-aligned rectangle drawn by a path, or null when the path is anything else. */
function pathRect(path: MuPath, ctm: Matrix): Rect | null {
  const pts: [number, number][] = []
  let subpaths = 0
  let curved = false
  path.walk({
    moveTo(x, y) {
      subpaths++
      pts.push(transformPoint([x, y], ctm))
    },
    lineTo(x, y) {
      pts.push(transformPoint([x, y], ctm))
    },
    curveTo() {
      curved = true
    },
    closePath() {}
  })
  if (curved || subpaths !== 1) return null
  if (pts.length === 5 && Math.hypot(pts[4][0] - pts[0][0], pts[4][1] - pts[0][1]) < 0.01) pts.pop()
  if (pts.length !== 4) return null
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const r: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  const eps = 0.05
  const onCorner = (p: [number, number]) =>
    (Math.abs(p[0] - r[0]) < eps || Math.abs(p[0] - r[2]) < eps) && (Math.abs(p[1] - r[1]) < eps || Math.abs(p[1] - r[3]) < eps)
  if (!pts.every(onCorner)) return null
  // the four points must be four different corners
  const keys = new Set(pts.map((p) => `${Math.abs(p[0] - r[0]) < eps ? 0 : 1}${Math.abs(p[1] - r[1]) < eps ? 0 : 1}`))
  if (keys.size !== 4) return null
  return r
}

function intersect(a: Rect, b: Rect): Rect {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
}

/** Collects visible and invisible glyphs and opaque covering rectangles of a page. */
export function collectPageGlyphs(s: Session, pageIndex: number): PageGlyphs {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const result: PageGlyphs = { visible: [], invisible: [], covers: [] }
  let order = 0
  // clip stack: a rectangle, or null for a clip we cannot reason about
  const clips: (Rect | null)[] = []
  const groups: boolean[] = []
  let maskDef = 0
  let tiles = 0
  const opaqueContext = () => maskDef === 0 && tiles === 0 && groups.every((g) => g)
  const addCover = (r: Rect | null) => {
    if (!r || !opaqueContext()) return
    let rect = r
    for (const c of clips) {
      if (!c) return
      rect = intersect(rect, c)
    }
    if (rect[2] - rect[0] > 0.5 && rect[3] - rect[1] > 0.5) result.covers.push({ rect, order: order++ })
  }
  const dev = new m.Device({
    fillText: (text: unknown, ctm: Matrix) => {
      result.visible.push(...glyphsOf(text as MuText, ctm, order++))
    },
    strokeText: (text: unknown, _stroke: unknown, ctm: Matrix) => {
      result.visible.push(...glyphsOf(text as MuText, ctm, order++))
    },
    ignoreText: (text: unknown, ctm: Matrix) => {
      result.invisible.push(...glyphsOf(text as MuText, ctm, order++))
    },
    fillPath: (path: unknown, _eo: boolean, ctm: Matrix, _cs: unknown, _color: number[], alpha: number) => {
      if (alpha < 0.999) {
        order++
        return
      }
      addCover(pathRect(path as MuPath, ctm))
    },
    fillImage: (image: unknown, ctm: Matrix, alpha: number) => {
      const img = image as MuImage
      let opaque = alpha >= 0.999
      try {
        if (img.getMask() || img.getImageMask()) opaque = false
      } catch {
        opaque = false
      }
      const aligned = (Math.abs(ctm[1]) < 1e-6 && Math.abs(ctm[2]) < 1e-6) || (Math.abs(ctm[0]) < 1e-6 && Math.abs(ctm[3]) < 1e-6)
      if (!opaque || !aligned) {
        order++
        return
      }
      const p = [transformPoint([0, 0], ctm), transformPoint([1, 1], ctm)]
      addCover([Math.min(p[0][0], p[1][0]), Math.min(p[0][1], p[1][1]), Math.max(p[0][0], p[1][0]), Math.max(p[0][1], p[1][1])])
    },
    clipPath: (path: unknown, _eo: boolean, ctm: Matrix) => {
      clips.push(pathRect(path as MuPath, ctm))
    },
    clipStrokePath: () => clips.push(null),
    clipText: () => clips.push(null),
    clipStrokeText: () => clips.push(null),
    clipImageMask: () => clips.push(null),
    popClip: () => {
      clips.pop()
    },
    beginMask: () => {
      maskDef++
      clips.push(null)
    },
    endMask: () => {
      maskDef = Math.max(0, maskDef - 1)
    },
    beginGroup: (_bbox: Rect, _cs: unknown, _isolated: boolean, _knockout: boolean, blendmode: string, alpha: number) => {
      groups.push(alpha >= 0.999 && (blendmode === 'Normal' || !blendmode))
    },
    endGroup: () => {
      groups.pop()
    },
    beginTile: () => {
      tiles++
      return 0
    },
    endTile: () => {
      tiles = Math.max(0, tiles - 1)
    }
  } as any)
  try {
    page.runPageContents(dev, m.Matrix.identity)
    dev.close()
  } finally {
    dev.destroy()
  }
  return result
}

function contains(outer: Rect, inner: Rect, tol = 0.5): boolean {
  return inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol
}

/** Visible glyphs completely covered by an opaque rectangle painted later. */
export function coveredGlyphs(g: PageGlyphs): Glyph[] {
  if (!g.covers.length) return []
  return g.visible.filter((gl) => {
    const ink = quadBounds(gl.ink)
    return g.covers.some((c) => c.order > gl.order && contains(c.rect, ink))
  })
}

/** Keys identifying a glyph by character and position (for comparing two runs of a page). */
export function glyphKey(gl: Glyph): string {
  const b = quadBounds(gl.box)
  return `${gl.ch}@${Math.round(b[0] * 4)},${Math.round(b[1] * 4)}`
}

/** Link annotation references of a page (MuPDF's redaction removes links it overlaps). */
function linkRefs(s: Session, pageIndex: number): unknown[] {
  const annots = s.pdf.findPage(pageIndex).get('Annots')
  const out: unknown[] = []
  if (isNull(annots)) return out
  const arr = annots.resolve()
  if (!arr.isArray()) return out
  for (let i = 0; i < arr.length; i++) {
    const a = arr.get(i)
    if (readName(a.resolve().get('Subtype')) === 'Link') out.push(a)
  }
  return out
}

/**
 * Removes the glyphs whose core quads are given, using a temporary Redact annotation that only
 * removes text (images and drawings stay). Links on the page are kept.
 */
export function removeGlyphs(s: Session, pageIndex: number, quads: Quad[]): number {
  if (!quads.length) return 0
  const links = linkRefs(s, pageIndex)
  const page = s.page(pageIndex)
  const annot = page.createAnnotation('Redact')
  annot.setQuadPoints(quads)
  annot.update()
  // black boxes off, images untouched, line art untouched, text removed
  annot.applyRedaction(0, 0, 0, 0)
  // restore any link the redaction filter dropped
  const pageObj = s.pdf.findPage(pageIndex)
  if (links.length) {
    let annots = pageObj.get('Annots')
    if (isNull(annots)) {
      pageObj.put('Annots', s.pdf.newArray())
      annots = pageObj.get('Annots')
    }
    const arr = annots.resolve()
    const present = new Set<number>()
    for (let i = 0; i < arr.length; i++) {
      const o = arr.get(i)
      if (o.isIndirect()) present.add(o.asIndirect())
    }
    for (const l of links as { isIndirect(): boolean; asIndirect(): number }[]) {
      if (l.isIndirect() && !present.has(l.asIndirect())) arr.push(l)
    }
  }
  s.invalidatePages()
  return quads.length
}
