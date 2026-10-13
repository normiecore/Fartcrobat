import { defineOps, EngineError, withTransfer } from '@engine/define'
import { viewMatrix } from '@engine/ops/render'
import type { PDFAnnotation, Session } from '@engine/session'
import { isNull, readString } from '@engine/util/pdf'
import type { PrintContent } from './settings'

/** Largest page image the print renderer produces; bigger requests are rendered at a lower resolution. */
export const MAX_PRINT_PIXELS = 24_000_000

export interface PrintRenderOptions {
  /** Device pixels per point. */
  scale: number
  /** What "Comments & Forms" prints. */
  content: PrintContent
  grayscale?: boolean
}

export interface PrintRenderResult {
  width: number
  height: number
  /** Scale actually used (lower than requested when the page would be too large). */
  scale: number
  /** ImageBitmap in the browser worker; raw RGBA pixels in Node (tests). */
  bitmap?: ImageBitmap
  pixels?: Uint8ClampedArray
}

export type AnnotPrintKind = 'document' | 'stamp' | 'markup' | 'none'

/** Annotation types that are part of the page itself rather than review comments. */
const DOCUMENT_TYPES = new Set(['Widget', 'Watermark', 'PrinterMark', 'TrapNet'])
/** Never drawn by MuPDF anyway. */
const INVISIBLE_TYPES = new Set(['Popup', 'Link'])
/** Fartcrobat features whose annotations are document content (Fill & Sign text and signatures). */
const DOCUMENT_FEATURES = new Set(['fillsign'])

function featureOf(annot: PDFAnnotation): string {
  try {
    const d = annot.getObject().get('FartcrobatData')
    if (!isNull(d) && d.isDictionary()) return readString(d.get('fartcrobat'))
  } catch {}
  return ''
}

/** How Acrobat's Comments & Forms choices treat an annotation. */
export function annotPrintKind(annot: PDFAnnotation): AnnotPrintKind {
  let type = ''
  try {
    type = annot.getType()
  } catch {
    return 'markup'
  }
  if (INVISIBLE_TYPES.has(type)) return 'none'
  if (DOCUMENT_TYPES.has(type) || DOCUMENT_FEATURES.has(featureOf(annot))) return 'document'
  if (type === 'Stamp') return 'stamp'
  return 'markup'
}

export function keepForContent(kind: AnnotPrintKind, content: PrintContent): boolean {
  switch (content) {
    case 'markups':
      return true
    case 'document':
      return kind === 'document'
    case 'stamps':
      return kind === 'document' || kind === 'stamp'
    case 'forms':
      return false
  }
}

/** True when an annotation's flags say it prints (PDF "Print" flag set, not hidden). */
export function printsByFlags(flags: number, m: Session['mupdf']): boolean {
  const A = m.PDFAnnotation
  return (flags & A.IS_PRINT) !== 0 && (flags & (A.IS_HIDDEN | A.IS_INVISIBLE)) === 0
}

/** RGB or gray pixmap samples -> RGBA. */
function toRgba(samples: ArrayLike<number>, components: number, count: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(count * 4)
  if (components === 1) {
    for (let i = 0, j = 0; i < count; i++, j += 4) {
      const v = samples[i]
      out[j] = v
      out[j + 1] = v
      out[j + 2] = v
      out[j + 3] = 255
    }
  } else {
    for (let i = 0, j = 0, k = 0; i < count; i++, j += 4, k += components) {
      out[j] = samples[k]
      out[j + 1] = samples[k + 1]
      out[j + 2] = samples[k + 2]
      out[j + 3] = 255
    }
  }
  return out
}

/**
 * Renders a page the way it prints: optional content uses its Print state, annotations follow
 * their Print flag and the Comments & Forms choice.
 */
export function renderPrintPixmap(s: Session, pageIndex: number, opts: PrintRenderOptions) {
  const m = s.mupdf
  const page = s.page(pageIndex)
  let scale = opts.scale
  if (!(scale > 0) || !Number.isFinite(scale)) throw new EngineError('Invalid print scale', 'BAD_ARGS')
  const bounds = s.pageBounds(pageIndex)
  const pixels = (bounds[2] - bounds[0]) * (bounds[3] - bounds[1]) * scale * scale
  if (pixels > MAX_PRINT_PIXELS) scale *= Math.sqrt(MAX_PRINT_PIXELS / pixels)
  const { ctm, bbox } = viewMatrix(s, pageIndex, scale, 0)
  const cs = opts.grayscale ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB

  if (opts.content === 'forms') {
    // Only the form fields: no page content, no comments (for pre-printed forms).
    const pix = new m.Pixmap(cs, bbox, false)
    pix.clear(255)
    const dev = new m.DrawDevice(ctm, pix)
    try {
      for (const w of page.getWidgets()) {
        let flags = 0
        try {
          flags = w.getFlags()
        } catch {}
        if (printsByFlags(flags, m)) w.run(dev, m.Matrix.identity)
      }
      dev.close()
    } finally {
      dev.destroy()
    }
    return { pix, scale }
  }

  const hidden: PDFAnnotation[] = []
  try {
    for (const a of page.getAnnotations()) {
      if (!keepForContent(annotPrintKind(a), opts.content)) {
        a.setHiddenForEditing(true)
        hidden.push(a)
      }
    }
    const pix = page.toPixmap(ctm, cs, false, true, 'Print', 'CropBox')
    return { pix, scale }
  } finally {
    for (const a of hidden) {
      try {
        a.setHiddenForEditing(false)
      } catch {}
    }
  }
}

export default defineOps('print', {
  /** A page rendered for printing, as an RGBA image. */
  async renderPage(s, pageIndex: number, opts: PrintRenderOptions) {
    const { pix, scale } = renderPrintPixmap(s, pageIndex, opts)
    try {
      const width = pix.getWidth()
      const height = pix.getHeight()
      const rgba = toRgba(pix.getPixels(), pix.getNumberOfComponents(), width * height)
      if (typeof createImageBitmap === 'function' && typeof ImageData === 'function') {
        const bitmap = await createImageBitmap(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, height))
        const result: PrintRenderResult = { width, height, scale, bitmap }
        return withTransfer(result, [bitmap])
      }
      const result: PrintRenderResult = { width, height, scale, pixels: rgba }
      return withTransfer(result, [rgba.buffer as ArrayBuffer])
    } finally {
      pix.destroy()
    }
  },

  /** How many annotations of each kind the pages carry (to explain the Comments & Forms choice). */
  contentSummary(s, pages: number[]) {
    const out = { markups: 0, stamps: 0, documentAnnots: 0, fields: 0 }
    for (const p of pages) {
      if (p < 0 || p >= s.pageCount()) continue
      const page = s.page(p)
      for (const a of page.getAnnotations()) {
        const kind = annotPrintKind(a)
        if (kind === 'markup') out.markups++
        else if (kind === 'stamp') out.stamps++
        else if (kind === 'document') out.documentAnnots++
      }
      out.fields += page.getWidgets().length
    }
    return out
  }
})
