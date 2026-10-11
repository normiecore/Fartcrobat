import type * as MuPDF from 'mupdf'
import type { ChangeSet, JournalState } from '@shared/types'
import type { Matrix, Rect } from '@shared/geometry'
import { invertMatrix } from '@shared/geometry'
import { EngineError } from './define'

export type Mupdf = typeof MuPDF
export type PDFDocument = MuPDF.PDFDocument
export type PDFPage = MuPDF.PDFPage
export type PDFAnnotation = MuPDF.PDFAnnotation
export type PDFWidget = MuPDF.PDFWidget
export type PDFObject = MuPDF.PDFObject

export interface FoundAnnotation {
  pageIndex: number
  page: PDFPage
  annot: PDFAnnotation
}

/**
 * Holds one open document inside the engine and everything the operations need to work on it:
 * the MuPDF document, a page cache, change tracking for the UI, and undo bookkeeping.
 */
export class Session {
  doc: PDFDocument | null = null
  /** A document waiting for a password. */
  pending: MuPDF.Document | null = null
  pendingBytes: Uint8Array | null = null
  fileName = ''
  /** The exact bytes the document was opened (or last reloaded) from. Needed to validate signatures. */
  sourceBytes: Uint8Array | null = null
  sourceFormat = 'PDF'
  converted = false
  /** Extra documents opened by operations (e.g. "insert pages from file"), keyed by caller id. */
  readonly scratch = new Map<string, PDFDocument>()
  /** Scratch space for features that need to keep state between calls. */
  readonly state = new Map<string, unknown>()

  private pageCache = new Map<number, PDFPage>()
  private changedPages = new Set<number>()
  private changedAll = false
  private changedStructure = false
  private changedDocument = false
  private savedPosition = 0
  private forcedDirty = false
  private opDepth = 0
  private progressSink: ((fraction: number, message?: string) => void) | null = null

  constructor(public readonly mupdf: Mupdf) {}

  /** The open PDF document. Throws when no document is open. */
  get pdf(): PDFDocument {
    if (!this.doc) throw new EngineError('No document is open', 'NO_DOCUMENT')
    return this.doc
  }

  setDocument(doc: PDFDocument, opts: { fileName?: string; sourceFormat?: string; converted?: boolean } = {}) {
    this.closeDocument()
    this.doc = doc
    this.fileName = opts.fileName ?? this.fileName
    this.sourceFormat = opts.sourceFormat ?? 'PDF'
    this.converted = opts.converted ?? false
    try {
      doc.enableJournal()
    } catch {
      // Journalling can fail on badly broken files; the document stays usable without undo.
    }
    this.savedPosition = this.journalPosition()
    this.forcedDirty = !!opts.converted
    this.changedStructure = true
    this.changedAll = true
    this.changedDocument = true
  }

  closeDocument() {
    this.invalidatePages()
    for (const d of this.scratch.values()) {
      try {
        d.destroy()
      } catch {}
    }
    this.scratch.clear()
    this.state.clear()
    if (this.doc) {
      try {
        this.doc.destroy()
      } catch {}
    }
    this.doc = null
  }

  pageCount(): number {
    return this.pdf.countPages()
  }

  /** Returns a loaded page, cached until the next structural change or undo/redo. */
  page(index: number): PDFPage {
    const count = this.pageCount()
    if (!Number.isInteger(index) || index < 0 || index >= count) {
      throw new EngineError(`Page ${index + 1} does not exist (document has ${count} pages)`, 'BAD_PAGE')
    }
    let p = this.pageCache.get(index)
    if (!p) {
      p = this.pdf.loadPage(index)
      this.pageCache.set(index, p)
    }
    return p
  }

  /** Stable id of a page: its PDF object number. */
  pageId(index: number): number {
    return this.pdf.findPage(index).asIndirect()
  }

  /** Index of the page with the given object number, or -1. */
  pageIndexById(id: number): number {
    const n = this.pageCount()
    for (let i = 0; i < n; i++) if (this.pageId(i) === id) return i
    return -1
  }

  /** Matrix that maps PDF user space (as used in content streams) to page space. */
  userToPage(index: number): Matrix {
    return this.page(index).getTransform() as Matrix
  }

  /** Matrix that maps page space to PDF user space. */
  pageToUser(index: number): Matrix {
    return invertMatrix(this.userToPage(index))
  }

  pageBounds(index: number): Rect {
    return this.page(index).getBounds() as Rect
  }

  /**
   * Forget cached pages (after page structure changes or undo/redo). Pages are destroyed so MuPDF
   * reloads them; while a page object is alive MuPDF keeps returning it with stale annotations.
   */
  invalidatePages() {
    for (const p of this.pageCache.values()) {
      try {
        p.destroy()
      } catch {}
    }
    this.pageCache.clear()
  }

  // ---- change tracking ---------------------------------------------------------------

  touch(...pages: number[]) {
    for (const p of pages) this.changedPages.add(p)
  }

  touchAll() {
    this.changedAll = true
  }

  structureChanged() {
    this.changedStructure = true
    this.changedAll = true
    this.invalidatePages()
  }

  documentChanged() {
    this.changedDocument = true
  }

  /** Marks the document as modified even though no journalled change happened. */
  markDirty() {
    this.forcedDirty = true
  }

  markSaved() {
    this.savedPosition = this.journalPosition()
    this.forcedDirty = false
    this.changedDocument = true
  }

  isDirty(): boolean {
    if (!this.doc) return false
    return this.forcedDirty || this.journalPosition() !== this.savedPosition
  }

  private journalPosition(): number {
    try {
      return this.doc ? this.doc.getJournal().position : 0
    } catch {
      return 0
    }
  }

  journal(): JournalState {
    if (!this.doc) return { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, position: 0 }
    let steps: string[] = []
    let position = 0
    try {
      const j = this.doc.getJournal()
      steps = j.steps
      position = j.position
    } catch {}
    const canUndo = safe(() => this.doc!.canUndo(), false)
    const canRedo = safe(() => this.doc!.canRedo(), false)
    return {
      canUndo,
      canRedo,
      undoLabel: canUndo ? (steps[position - 1] ?? null) : null,
      redoLabel: canRedo ? (steps[position] ?? null) : null,
      position
    }
  }

  takeChanges(): ChangeSet {
    const cs: ChangeSet = {
      pages: [...this.changedPages].sort((a, b) => a - b),
      all: this.changedAll,
      structure: this.changedStructure,
      document: this.changedDocument,
      journal: this.journal(),
      dirty: this.isDirty()
    }
    this.changedPages.clear()
    this.changedAll = false
    this.changedStructure = false
    this.changedDocument = false
    return cs
  }

  // ---- journalled operations ----------------------------------------------------------

  /** Runs fn as one undoable step. Nested calls join the outer step. */
  runMutation<R>(label: string, fn: () => R): R {
    const doc = this.pdf
    if (this.opDepth > 0) return fn()
    this.opDepth++
    let began = false
    try {
      doc.beginOperation(label)
      began = true
    } catch {}
    try {
      const result = fn()
      if (result instanceof Promise) {
        throw new EngineError('Mutations must be synchronous', 'ASYNC_MUTATION')
      }
      if (began) doc.endOperation()
      return result
    } catch (err) {
      if (began) {
        try {
          doc.abandonOperation()
        } catch {}
      }
      // The document may be partially modified; make the UI refresh everything.
      this.invalidatePages()
      this.touchAll()
      throw err
    } finally {
      this.opDepth--
    }
  }

  undo() {
    const doc = this.pdf
    if (!doc.canUndo()) return
    doc.undo()
    this.afterHistoryJump()
  }

  redo() {
    const doc = this.pdf
    if (!doc.canRedo()) return
    doc.redo()
    this.afterHistoryJump()
  }

  private afterHistoryJump() {
    this.structureChanged()
    this.changedDocument = true
  }

  // ---- progress -----------------------------------------------------------------------

  setProgressSink(sink: ((fraction: number, message?: string) => void) | null) {
    this.progressSink = sink
  }

  /** Reports progress (0..1) of a long operation to the UI. */
  progress(fraction: number, message?: string) {
    this.progressSink?.(fraction, message)
  }

  // ---- annotations --------------------------------------------------------------------

  /**
   * Stable id for an annotation: its PDF object number. Annotations stored as direct objects
   * (rare) get a negative id derived from their position.
   */
  annotationId(annot: PDFAnnotation, pageIndex: number, position: number): number {
    const num = annot.getObject().asIndirect()
    return num > 0 ? num : -(pageIndex * 100000 + position + 1)
  }

  /** Finds an annotation (including form widgets) by id. Searches `hintPage` first. */
  findAnnotation(id: number, hintPage?: number): FoundAnnotation | null {
    const n = this.pageCount()
    const order: number[] = []
    if (hintPage !== undefined && hintPage >= 0 && hintPage < n) order.push(hintPage)
    for (let i = 0; i < n; i++) if (i !== hintPage) order.push(i)
    for (const pageIndex of order) {
      const page = this.page(pageIndex)
      const annots = page.getAnnotations()
      for (let k = 0; k < annots.length; k++) {
        if (this.annotationId(annots[k], pageIndex, k) === id) return { pageIndex, page, annot: annots[k] }
      }
      const widgets = page.getWidgets()
      for (let k = 0; k < widgets.length; k++) {
        if (this.annotationId(widgets[k], pageIndex, k + 50000) === id)
          return { pageIndex, page, annot: widgets[k] }
      }
    }
    return null
  }

  requireAnnotation(id: number, hintPage?: number): FoundAnnotation {
    const found = this.findAnnotation(id, hintPage)
    if (!found) throw new EngineError(`Annotation ${id} not found`, 'NO_ANNOTATION')
    return found
  }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
