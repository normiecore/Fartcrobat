/**
 * Engine namespace 'comments': what the core annots module does not cover — stacking order,
 * deleting every comment at once, XFDF/FDF interchange, the comment summary and drag previews.
 */
import type { Rect } from '@shared/geometry'
import { multiplyMatrix, scaleMatrix, translateMatrix } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import type { RenderResult } from '@engine/ops/render'
import type { Session } from '@engine/session'
import { buildFdf, importFdfInto, type ImportSummary } from './fdf'
import { exportRecords, importRecordsInto } from './records'
import { buildSummary, type SummaryOptions } from './summary'
import type { CommentRecord } from './shared'

export type { ImportSummary } from './fdf'
export type { SummaryOptions } from './summary'

const NON_COMMENT = new Set(['Link', 'Widget', 'Popup'])

type Arrange = 'front' | 'back'

function arrangeLabel(_ids: number[], where: Arrange) {
  return where === 'front' ? 'Bring to Front' : 'Send to Back'
}

function countComments(s: Session): number {
  let n = 0
  for (let p = 0; p < s.pageCount(); p++) {
    for (const a of s.page(p).getAnnotations()) {
      try {
        if (!NON_COMMENT.has(a.getType())) n++
      } catch {}
    }
  }
  return n
}

/** Largest preview bitmap (device pixels) so huge stamps don't stall the drag. */
const MAX_PREVIEW_PIXELS = 16_000_000

/**
 * Converts MuPDF's premultiplied RGBA into the straight alpha that ImageData expects, so
 * anti-aliased edges and translucent comments don't come out darker than on the page.
 */
export function unpremultiply(px: Uint8ClampedArray): Uint8ClampedArray {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]
    if (a === 0 || a === 255) continue
    const k = 255 / a
    px[i] = Math.min(255, Math.round(px[i] * k))
    px[i + 1] = Math.min(255, Math.round(px[i + 1] * k))
    px[i + 2] = Math.min(255, Math.round(px[i + 2] * k))
  }
  return px
}

/** Renders one annotation on a transparent background (drag previews). */
export function renderAnnotationPreview(s: Session, id: number, scale: number): { result: RenderResult; bounds: Rect } {
  const { annot } = s.requireAnnotation(id)
  const m = s.mupdf
  const bounds = annot.getBounds() as Rect
  const w = Math.max(1e-3, bounds[2] - bounds[0])
  const h = Math.max(1e-3, bounds[3] - bounds[1])
  const k = Math.min(scale, Math.sqrt(MAX_PREVIEW_PIXELS / (w * h)))
  const ctm = multiplyMatrix(translateMatrix(-bounds[0], -bounds[1]), scaleMatrix(k))
  const region: Rect = [0, 0, Math.max(1, Math.ceil(w * k)), Math.max(1, Math.ceil(h * k))]
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, region, true)
  try {
    // clear() without a value leaves alpha at 0; clear(0) would paint opaque black
    pix.clear()
    const dev = new m.DrawDevice(ctm, pix)
    try {
      annot.run(dev, m.Matrix.identity)
      dev.close()
    } finally {
      dev.destroy()
    }
    const pixels = unpremultiply(new Uint8ClampedArray(pix.getPixels()))
    return { result: { width: region[2], height: region[3], x: 0, y: 0, pixels }, bounds }
  } finally {
    pix.destroy()
  }
}

export default defineOps('comments', {
  /**
   * Bitmap of one annotation (transparent background) plus its bounds in page space, for the
   * live preview while dragging. `scale` is device pixels per point.
   */
  async preview(s, id: number, scale: number) {
    const { result, bounds } = renderAnnotationPreview(s, id, scale)
    const pixels = result.pixels!
    if (typeof createImageBitmap === 'function' && typeof ImageData === 'function') {
      const bitmap = await createImageBitmap(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, result.width, result.height), {
        premultiplyAlpha: 'premultiply'
      })
      return withTransfer({ width: result.width, height: result.height, x: 0, y: 0, bitmap, bounds } as RenderResult & { bounds: Rect }, [bitmap])
    }
    return withTransfer({ ...result, bounds } as RenderResult & { bounds: Rect }, [pixels.buffer as ArrayBuffer])
  },

  /** Moves annotations to the top (drawn last) or the bottom of their page's stacking order. */
  arrange: mutation(arrangeLabel, (s, ids: number[], where: Arrange, hintPage?: number) => {
    const byPage = new Map<number, Set<number>>()
    for (const id of ids) {
      const found = s.requireAnnotation(id, hintPage)
      const num = found.annot.getObject().asIndirect()
      if (num <= 0) continue
      byPage.set(found.pageIndex, (byPage.get(found.pageIndex) ?? new Set()).add(num))
    }
    for (const [pageIndex, nums] of byPage) {
      const pageObj = s.pdf.findPage(pageIndex)
      const arr = pageObj.get('Annots')
      if (!arr.isArray()) continue
      const moving: ReturnType<typeof arr.get>[] = []
      const rest: ReturnType<typeof arr.get>[] = []
      for (let i = 0; i < arr.length; i++) {
        const item = arr.get(i)
        if (item.isIndirect() && nums.has(item.asIndirect())) moving.push(item)
        else rest.push(item)
      }
      const next = s.pdf.newArray()
      for (const item of where === 'front' ? [...rest, ...moving] : [...moving, ...rest]) next.push(item)
      pageObj.put('Annots', next)
      s.touch(pageIndex)
    }
    // MuPDF keeps the annotation list of loaded pages; reload them.
    s.invalidatePages()
    s.documentChanged()
  }),

  /** Deletes every comment (and its replies and pop-ups). Returns how many were removed. */
  deleteAll: mutation('Delete All Comments', (s): number => {
    let removed = 0
    for (let p = 0; p < s.pageCount(); p++) {
      const page = s.page(p)
      const annots = page.getAnnotations().filter((a) => {
        try {
          return !NON_COMMENT.has(a.getType())
        } catch {
          return false
        }
      })
      if (!annots.length) continue
      for (const a of annots) {
        page.deleteAnnotation(a)
        removed++
      }
      // Pop-ups only belong to comments, so any that are left are orphans now.
      for (const a of [...page.getAnnotations()]) {
        try {
          if (a.getType() === 'Popup') page.deleteAnnotation(a)
        } catch {}
      }
      s.touch(p)
    }
    if (!removed) throw new EngineError('There are no comments to delete', 'NO_COMMENTS')
    s.invalidatePages()
    s.documentChanged()
    return removed
  }),

  /** Number of comment annotations (including replies) in the document. */
  count(s): number {
    return countComments(s)
  },

  /** All comments as user-space records, for XFDF export (the UI writes the XML). */
  exportRecords(s): CommentRecord[] {
    return exportRecords(s)
  },

  /** Creates comments from records (XFDF import). One undo step. */
  importRecords: mutation('Import Comments', (s, records: CommentRecord[]): ImportSummary => {
    const res = importRecordsInto(s, records)
    if (!res.imported && !res.duplicates) throw new EngineError('The file does not contain any comments that fit this document', 'NO_COMMENTS')
    return res
  }),

  /** FDF file with every comment. */
  exportFdf(s, fileName: string) {
    const { bytes, count } = buildFdf(s, fileName)
    return withTransfer({ bytes, count }, [bytes.buffer as ArrayBuffer])
  },

  /** Imports the comments of an FDF file. One undo step. */
  importFdf: mutation('Import Comments', (s, bytes: Uint8Array): ImportSummary => {
    const res = importFdfInto(s, bytes)
    if (!res.imported && !res.duplicates) throw new EngineError('The file does not contain any comments that fit this document', 'NO_COMMENTS')
    return res
  }),

  /** A new PDF summarising the comments (Comment > Summarize Comments). */
  summary(s, opts: SummaryOptions) {
    const bytes = buildSummary(s, opts)
    return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
  }
})
