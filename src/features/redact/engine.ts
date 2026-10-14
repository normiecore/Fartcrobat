/**
 * Redact engine operations (namespace 'redact'): redaction marks (Redact annotations), applying
 * them with MuPDF's redaction filter, and removing hidden information.
 */
import type { Rect } from '@shared/geometry'
import { normalizeRect, rectIntersection } from '@shared/geometry'
import type { SaveOptions } from '@shared/types'
import { defineOps, EngineError, mutation } from '@engine/define'
import { REQUIRED_SAVE_OPTIONS } from '@engine/ops/doc'
import type { PDFAnnotation, Session } from '@engine/session'
import { isNull } from '@engine/util/pdf'
import type { ApplyReport, HiddenScan, MarkInfo, MarkSpec, RedactionProps, SanitizeOptions, SanitizeReport } from './shared'
import { markAreas, markInfo, pageMarks, pagesWithMarks, setMarkKind, writeProps } from './worker/marks'
import { appendContent, areasFor, overlayContent, type OverlayArea } from './worker/overlay'
import { sanitize, scanHidden } from './worker/hidden'
import { cleanRedactedPage, cleanStructureTree, snapshotPage } from './worker/tagged'

/** MuPDF redaction methods (see PDFPage.REDACT_*). */
const IMAGE_PIXELS = 2
const LINE_ART_IF_COVERED = 1
const TEXT_REMOVE = 0

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/**
 * From now on every save of this session rewrites the whole file, drops unused objects and cleans
 * the content streams, so removed content cannot survive in an incremental update or as an
 * orphaned object. (Encrypted documents keep their encryption: the core writes them from a copy.)
 */
export function requireCleanSave(s: Session) {
  const opts: SaveOptions = { mode: 'full', garbage: 'deduplicate', clean: true, sanitize: true }
  s.state.set(REQUIRED_SAVE_OPTIONS, opts)
}

function listMarks(s: Session): MarkInfo[] {
  const out: MarkInfo[] = []
  for (const p of pagesWithMarks(s)) for (const m of pageMarks(s, p)) out.push(markInfo(s, m.annot, p, m.position))
  return out
}

function overlaps(r: Rect, areas: Rect[]): boolean {
  return areas.some((a) => rectIntersection(r, a) !== null)
}

/** Deletes comments (and their replies and pop-ups) that lie in the redacted areas of a page. */
function removeAnnotationsIn(s: Session, pageIndex: number, areas: Rect[]): number {
  const page = s.page(pageIndex)
  // copy: MuPDF's list shrinks as annotations are deleted
  const annots = [...page.getAnnotations()]
  const num = (a: PDFAnnotation) => safe(() => a.getObject().asIndirect(), 0)
  const doomed = new Set<number>()
  for (const a of annots) {
    const type = safe(() => a.getType(), '')
    if (type === 'Redact' || type === 'Popup' || type === 'Link' || type === 'Widget') continue
    const r = safe(() => (a.hasRect() ? a.getRect() : a.getBounds()) as Rect, null)
    if (r && overlaps(normalizeRect(r), areas)) doomed.add(num(a))
  }
  if (!doomed.size) return 0
  // replies and pop-ups of removed comments go too
  let grew = true
  while (grew) {
    grew = false
    for (const a of annots) {
      const n = num(a)
      if (!n || doomed.has(n)) continue
      const obj = a.getObject()
      for (const key of ['IRT', 'Parent']) {
        const ref = obj.get(key)
        if (!isNull(ref) && ref.isIndirect() && doomed.has(ref.asIndirect())) {
          doomed.add(n)
          grew = true
        }
      }
    }
  }
  let count = 0
  for (const a of annots) {
    if (!doomed.has(num(a))) continue
    if (safe(() => a.getType(), '') !== 'Popup') count++
    page.deleteAnnotation(a)
  }
  return count
}

/** Deletes form fields whose widgets lie in the redacted areas of a page. */
function removeFieldsIn(s: Session, pageIndex: number, areas: Rect[]): number {
  const page = s.page(pageIndex)
  let count = 0
  for (const w of [...page.getWidgets()]) {
    const r = safe(() => w.getRect() as Rect, null)
    if (!r || !overlaps(normalizeRect(r), areas)) continue
    page.deleteAnnotation(w)
    count++
  }
  return count
}

/** Drops areas lying inside a bigger redacted area (e.g. a mark on a page that is redacted whole). */
function withoutNested(areas: OverlayArea[]): OverlayArea[] {
  const inside = (a: Rect, b: Rect) => a[0] >= b[0] - 0.5 && a[1] >= b[1] - 0.5 && a[2] <= b[2] + 0.5 && a[3] <= b[3] + 0.5
  const size = (r: Rect) => (r[2] - r[0]) * (r[3] - r[1])
  return areas.filter((a, i) => !areas.some((b, j) => j !== i && size(b.rect) > size(a.rect) && inside(a.rect, b.rect)))
}

interface PageResult {
  marks: number
  annots: number
  fields: number
  /** MCIDs of the page whose content changed (for the structure tree). */
  changedMcids: Set<number> | 'all'
}

function applyOnPage(s: Session, pageIndex: number, ids: Set<number> | null): PageResult {
  const all = pageMarks(s, pageIndex)
  const chosen = all.filter((m) => !ids || ids.has(s.annotationId(m.annot, pageIndex, m.position)))
  if (!chosen.length) return { marks: 0, annots: 0, fields: 0, changedMcids: new Set() }
  const infos = chosen.map((m) => markInfo(s, m.annot, pageIndex, m.position))
  const areas = infos.flatMap((i) => markAreas(i))
  const annots = removeAnnotationsIn(s, pageIndex, areas)
  const fields = removeFieldsIn(s, pageIndex, areas)
  // (a page whose content cannot be read is still redacted; its tagged text is then all removed)
  const tagged = safe(() => snapshotPage(s, pageIndex), null)
  const page = s.page(pageIndex)
  if (chosen.length === all.length) {
    page.applyRedactions(false, IMAGE_PIXELS, LINE_ART_IF_COVERED, TEXT_REMOVE)
  } else {
    // apply only the chosen marks, one at a time (annotation objects change after each)
    const wanted = new Set(infos.map((i) => i.id))
    for (;;) {
      const next = pageMarks(s, pageIndex).find((m) => wanted.has(s.annotationId(m.annot, pageIndex, m.position)))
      if (!next) break
      wanted.delete(s.annotationId(next.annot, pageIndex, next.position))
      next.annot.applyRedaction(0, IMAGE_PIXELS, LINE_ART_IF_COVERED, TEXT_REMOVE)
    }
  }
  // tagged text standing in for the removed content (/ActualText, /Alt...) goes too
  const changedMcids = safe(() => cleanRedactedPage(s, pageIndex, tagged), 'all' as const)
  // an embedded page thumbnail still shows the page as it was
  const pageObj = s.pdf.findPage(pageIndex)
  if (!isNull(pageObj.get('Thumb'))) pageObj.delete('Thumb')
  const overlay = withoutNested(infos.flatMap((i) => areasFor(i.quads, i.rect, i.props)))
  if (overlay.some((a) => a.props.fillColor || a.props.overlay !== 'none')) {
    appendContent(s, pageIndex, overlayContent(s, pageIndex, overlay))
  }
  s.touch(pageIndex)
  return { marks: chosen.length, annots, fields, changedMcids }
}

export default defineOps('redact', {
  /** Every redaction mark in the document, in page order. */
  list(s): MarkInfo[] {
    return listMarks(s)
  },

  /** Adds redaction marks (text quads or areas), signed with the session's author unless `by` is given. */
  mark: mutation(
    (specs: MarkSpec[]) => (specs.length > 1 ? 'Mark for Redaction' : specs[0]?.kind === 'page' ? 'Mark Page for Redaction' : 'Mark for Redaction'),
    (s, specs: MarkSpec[], props: RedactionProps, by?: string): MarkInfo[] => {
      const created: { page: number; num: number }[] = []
      const author = by || s.state.get('author')
      for (const spec of specs) {
        const page = s.page(spec.page)
        const hasQuads = !!spec.quads && spec.quads.length > 0
        if (!hasQuads && !spec.rect) throw new EngineError('A redaction mark needs text or an area', 'BAD_SPEC')
        const annot = page.createAnnotation('Redact')
        if (typeof author === 'string' && author) safe(() => annot.setAuthor(author), undefined)
        safe(() => annot.setCreationDate(new Date()), undefined)
        safe(() => annot.setModificationDate(new Date()), undefined)
        if (hasQuads) annot.setQuadPoints(spec.quads!)
        else annot.setRect(normalizeRect(spec.rect!))
        writeProps(s, annot, props)
        setMarkKind(s, annot, spec.kind)
        annot.update()
        created.push({ page: spec.page, num: annot.getObject().asIndirect() })
        s.touch(spec.page)
      }
      s.documentChanged()
      const wanted = new Set(created.map((c) => c.num))
      return listMarks(s).filter((m) => wanted.has(m.id))
    }
  ),

  /** Changes the overlay/appearance properties of marks. */
  update: mutation('Change Redaction Properties', (s, ids: number[], props: RedactionProps) => {
    for (const id of ids) {
      const { annot, pageIndex } = s.requireAnnotation(id)
      writeProps(s, annot, props)
      safe(() => annot.setModificationDate(new Date()), undefined)
      annot.update()
      s.touch(pageIndex)
    }
    s.documentChanged()
  }),

  /** Deletes redaction marks (without applying them). */
  remove: mutation(
    (ids: number[]) => (ids.length > 1 ? 'Delete Redaction Marks' : 'Delete Redaction Mark'),
    (s, ids: number[]) => {
      for (const id of ids) {
        const found = s.findAnnotation(id)
        if (!found) continue
        found.page.deleteAnnotation(found.annot)
        s.touch(found.pageIndex)
      }
      s.documentChanged()
    }
  ),

  /**
   * Applies redaction marks (all, or the given ids): removes the text, image pixels and drawings
   * under them, removes comments and form fields there, then fills the areas and draws overlay text.
   */
  apply: mutation('Apply Redactions', (s, ids?: number[] | null): ApplyReport => {
    const idSet = ids && ids.length ? new Set(ids) : null
    const pages = pagesWithMarks(s)
    const report: ApplyReport = { marks: 0, pages: [], removedAnnotations: 0, removedFields: 0 }
    const changed = new Map<number, Set<number> | 'all'>()
    pages.forEach((p, k) => {
      const r = applyOnPage(s, p, idSet)
      if (r.marks) {
        report.marks += r.marks
        report.pages.push(p)
        report.removedAnnotations += r.annots
        report.removedFields += r.fields
        changed.set(s.pdf.findPage(p).asIndirect(), r.changedMcids)
      }
      s.progress((k + 1) / pages.length, `Applying redactions on page ${p + 1}…`)
    })
    if (!report.marks) throw new EngineError('There are no redaction marks to apply', 'NO_MARKS')
    cleanStructureTree(s, changed)
    s.invalidatePages()
    s.documentChanged()
    requireCleanSave(s)
    return report
  }),

  /** Finds hidden information (metadata, attachments, hidden text...) without changing anything. */
  scanHidden(s): HiddenScan {
    return scanHidden(s)
  },

  /** Removes the selected kinds of hidden information. */
  sanitize: mutation('Remove Hidden Information', (s, opts: SanitizeOptions): SanitizeReport => {
    const report = sanitize(s, opts)
    s.structureChanged()
    s.documentChanged()
    requireCleanSave(s)
    return report
  }),

  /** True once redactions were applied or hidden information removed in this session. */
  needsCleanSave(s): boolean {
    return s.state.has(REQUIRED_SAVE_OPTIONS)
  }
})
