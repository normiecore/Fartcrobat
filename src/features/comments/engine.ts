/**
 * Engine namespace 'comments': what the core annots module does not cover — stacking order,
 * deleting every comment at once, XFDF/FDF interchange, the comment summary and drag previews.
 */
import type { Rect } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import renderOps from '@engine/ops/render'
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

export default defineOps('comments', {
  /**
   * Bitmap of one annotation plus its bounds in page space (live preview while dragging).
   * `scale` is device pixels per point.
   */
  async preview(s, id: number, scale: number) {
    const { annot } = s.requireAnnotation(id)
    const bounds = annot.getBounds() as Rect
    const res = await renderOps.ops.annotation(s, id, scale)
    return withTransfer({ ...res.value, bounds }, res.transferables)
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
