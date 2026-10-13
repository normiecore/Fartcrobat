import type * as MuPDF from 'mupdf'
import type { ChangeSet, JournalState } from '@shared/types'
import type { Matrix, Rect } from '@shared/geometry'
import { invertMatrix } from '@shared/geometry'
import { EngineError } from './define'
import { countSignatures } from './util/pdf'

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
  /** The pending document should open as unsaved (see doc.open's `dirty`). */
  pendingDirty = false
  fileName = ''
  /**
   * The exact bytes the document was opened (or last reloaded, or last saved incrementally) from.
   * Needed to validate signatures.
   */
  sourceBytes: Uint8Array | null = null
  sourceFormat = 'PDF'
  converted = false
  /** Extra documents opened by operations (e.g. "insert pages from file"), keyed by caller id. */
  readonly scratch = new Map<string, PDFDocument>()
  /** Scratch space for features that need to keep state between calls. */
  readonly state = new Map<string, unknown>()
  /**
   * Keys of `state` that hold settings of the tab rather than facts about the document (the
   * default comment author...). They survive `doc.reload`; everything else in `state` is cleared
   * because object numbers change with new bytes. Features may add their own keys.
   */
  readonly persistentState = new Set<string>(['author'])
  /** The password the document was opened with (null when none was needed). Used to reopen it. */
  password: string | null = null
  /** The document had signed signature fields when it was opened (or last reloaded). */
  signedOnOpen = false

  private pageCache = new Map<number, PDFPage>()
  private changedPages = new Set<number>()
  private changedAll = false
  private changedStructure = false
  private changedDocument = false
  /** Journal position of the state that is on disk; -1 when that state can no longer be reached. */
  private savedPosition = 0
  private forcedDirty = false
  /** Added to MuPDF's journal position so positions keep counting up across `rebase()`. */
  private journalOffset = 0
  /** Journal position seen by the last `noteJournal()`. */
  private knownPosition = 0
  /** Bumps on every change to the document content (edits, undo, redo, reload, forced dirty). */
  private editCounter = 0
  private opDepth = 0
  private progressSink: ((fraction: number, message?: string) => void) | null = null

  constructor(public readonly mupdf: Mupdf) {}

  /** The open PDF document. Throws when no document is open. */
  get pdf(): PDFDocument {
    if (!this.doc) throw new EngineError('No document is open', 'NO_DOCUMENT')
    return this.doc
  }

  /**
   * Makes `doc` the open document. `dirty` marks it as unsaved (documents that only exist in
   * memory); `keepSettings` keeps the `persistentState` entries of `state` (used by reload).
   */
  setDocument(
    doc: PDFDocument,
    opts: { fileName?: string; sourceFormat?: string; converted?: boolean; dirty?: boolean; keepSettings?: boolean } = {}
  ) {
    const kept = opts.keepSettings ? [...this.state].filter(([k]) => this.persistentState.has(k)) : []
    this.closeDocument()
    for (const [k, v] of kept) this.state.set(k, v)
    this.doc = doc
    this.fileName = opts.fileName ?? this.fileName
    this.sourceFormat = opts.sourceFormat ?? 'PDF'
    this.converted = opts.converted ?? false
    try {
      doc.enableJournal()
    } catch {
      // Journalling can fail on badly broken files; the document stays usable without undo.
    }
    this.journalOffset = 0
    this.savedPosition = this.journalPosition()
    this.knownPosition = this.savedPosition
    this.forcedDirty = !!opts.converted || !!opts.dirty
    this.editCounter++
    this.signedOnOpen = safe(() => countSignatures(doc) > 0, false)
    this.changedStructure = true
    this.changedAll = true
    this.changedDocument = true
  }

  /**
   * Re-opens the document from `bytes`, which must hold exactly the current document: the output
   * of an incremental save. MuPDF builds every incremental save on the bytes it was opened from,
   * so without this a second incremental save writes a broken /Prev chain.
   * Object numbers, page ids, feature state and the dirty state are kept; the undo history is not
   * (MuPDF cannot move it to another document). Throws, and leaves everything as it was, when
   * the bytes do not reopen cleanly.
   */
  rebase(bytes: Uint8Array) {
    if (this.opDepth > 0) throw new EngineError('The document cannot be reopened during an operation', 'BAD_STATE')
    const old = this.pdf
    const fresh = new this.mupdf.PDFDocument(bytes)
    try {
      if (fresh.needsPassword() && !(this.password && fresh.authenticatePassword(this.password))) {
        throw new EngineError('The saved document could not be reopened: its password is not known', 'ENCRYPTED')
      }
      if (fresh.wasRepaired() || fresh.countPages() !== old.countPages()) {
        throw new EngineError('The incremental save produced a damaged file', 'SAVE_FAILED')
      }
    } catch (err) {
      fresh.destroy()
      throw err
    }
    const position = this.journalPosition()
    const clean = !this.isDirty()
    this.invalidatePages()
    try {
      old.destroy()
    } catch {}
    this.doc = fresh
    try {
      fresh.enableJournal()
    } catch {}
    this.journalOffset = 0
    this.journalOffset = position - this.journalPosition()
    this.knownPosition = position
    // A saved state other than the current one cannot be reached any more.
    this.savedPosition = clean ? position : -1
    // A copy: the caller usually transfers `bytes` to the UI thread, which detaches them here.
    this.sourceBytes = bytes.slice()
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

  /** Forgets one cached page (see invalidatePages). */
  invalidatePage(index: number) {
    const p = this.pageCache.get(index)
    if (!p) return
    try {
      p.destroy()
    } catch {}
    this.pageCache.delete(index)
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
    this.editCounter++
  }

  /**
   * Version of the document content: changes whenever an edit, undo, redo or reload happens.
   * Record it together with the bytes you save and pass it to `markSaved`.
   */
  editVersion(): number {
    return this.editCounter
  }

  /**
   * Records that the document was written to disk. With `version` (from `editVersion()` taken when
   * the bytes were produced), changes made after that point keep the document dirty, because the
   * file does not contain them.
   */
  markSaved(version?: number) {
    this.noteJournal()
    // When the content changed after the bytes were produced, the file holds an earlier state
    // that no journal position identifies reliably any more: stay dirty until the next save.
    this.savedPosition = version === undefined || version === this.editCounter ? this.journalPosition() : -1
    this.forcedDirty = false
    this.changedDocument = true
  }

  isDirty(): boolean {
    if (!this.doc) return false
    this.noteJournal()
    return this.forcedDirty || this.journalPosition() !== this.savedPosition
  }

  private journalPosition(): number {
    try {
      return (this.doc ? this.doc.getJournal().position : 0) + this.journalOffset
    } catch {
      return this.journalOffset
    }
  }

  /**
   * Notices journal steps committed since the last call. A step committed while the saved state
   * sat in the redo history discards that history: the saved state can never come back, even
   * when a later step lands on the same position.
   */
  private noteJournal() {
    const position = this.journalPosition()
    if (position !== this.knownPosition && this.knownPosition < this.savedPosition) this.savedPosition = -1
    this.knownPosition = position
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
      position: position + this.journalOffset
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
    // MuPDF pages cache their annotation and widget lists, so operations that add or remove
    // annotations at the C level (redaction, new form fields...) leave a cached page stale. The
    // operation is over and nobody holds these pages any more: drop them, they reload on demand.
    if (this.changedAll) this.invalidatePages()
    else for (const p of this.changedPages) this.invalidatePage(p)
    this.changedPages.clear()
    this.changedAll = false
    this.changedStructure = false
    this.changedDocument = false
    return cs
  }

  // ---- journalled operations ----------------------------------------------------------

  /** True while a mutation (runMutation) is running. */
  get inOperation(): boolean {
    return this.opDepth > 0
  }

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
    const before = this.journalPosition()
    try {
      const result = fn()
      if (result instanceof Promise) {
        throw new EngineError('Mutations must be synchronous', 'ASYNC_MUTATION')
      }
      if (began) doc.endOperation()
      if (this.journalPosition() !== before) this.editCounter++
      return result
    } catch (err) {
      this.editCounter++
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
    this.noteJournal()
    doc.undo()
    this.knownPosition = this.journalPosition()
    this.editCounter++
    this.afterHistoryJump()
  }

  redo() {
    const doc = this.pdf
    if (!doc.canRedo()) return
    this.noteJournal()
    doc.redo()
    this.knownPosition = this.journalPosition()
    this.editCounter++
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
