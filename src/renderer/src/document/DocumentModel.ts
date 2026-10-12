import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { ClientOps, OpModule } from '@engine/define'
import type docOps from '@engine/ops/doc'
import type navOps from '@engine/ops/nav'
import type renderOps from '@engine/ops/render'
import type textOps from '@engine/ops/text'
import type { ChangeSet, DocInfo, JournalState, PageLayoutMode, SaveOptions, ZoomMode } from '@shared/types'
import { EngineClient, type CallOptions } from '../engine/EngineClient'
import type { PageText, SearchHit, SearchOptions, TextRange } from './textModel'
import { rangeRects, searchPage } from './textModel'

export type Selection =
  | { kind: 'none' }
  | { kind: 'text'; ranges: TextRange[] }
  | { kind: 'annotations'; page: number; ids: number[] }
  /** Feature-defined selections, e.g. a form field in "Prepare a form" or an image in "Edit". */
  | { kind: 'custom'; type: string; page: number; data: unknown }

export interface SearchState {
  query: string
  options: SearchOptions
  hits: SearchHit[]
  active: number
  running: boolean
  done: boolean
  pagesSearched: number
}

export interface DocState {
  info: DocInfo
  title: string
  filePath: string | null
  dirty: boolean
  journal: JournalState
  /** Per page id: bumps when that page needs re-rendering. */
  pageVersions: Record<number, number>
  /** Bumps when every page needs re-rendering. */
  globalVersion: number
  /** Bumps when document-level data (outline, attachments, form, signatures...) changed. */
  docVersion: number
  zoom: number
  zoomMode: ZoomMode
  layout: PageLayoutMode
  coverPage: boolean
  viewRotation: 0 | 90 | 180 | 270
  currentPage: number
  selection: Selection
  search: SearchState
  busy: string | null
  /** View > Show/Hide > Comments. Annotations are left out of rendering when false. */
  showAnnotations: boolean
}

/** Imperative view control, provided by the mounted Viewer. */
export interface ViewController {
  goToPage(
    index: number,
    opts?: { x?: number | null; y?: number | null; smooth?: boolean; fromHistory?: boolean }
  ): void
  scrollToRect(page: number, rect: [number, number, number, number], opts?: { center?: boolean }): void
  setZoom(zoom: number | ZoomMode, anchor?: { clientX: number; clientY: number }): void
  scrollBy(dx: number, dy: number): void
  getViewportElement(): HTMLElement | null
  /** Visible pages, most visible first. */
  visiblePages(): number[]
  /** Page and page-space point under a client (screen) position, or null. */
  hitTest(clientX: number, clientY: number): { pageIndex: number; point: [number, number] } | null
}

type Listener<T> = (v: T) => void

let docCounter = 0

const emptySearch = (): SearchState => ({
  query: '',
  options: {},
  hits: [],
  active: -1,
  running: false,
  done: false,
  pagesSearched: 0
})

/** Hits of both lists in document order (the inputs keep their object identity). */
function mergeHits(a: SearchHit[], b: SearchHit[]): SearchHit[] {
  return [...a, ...b].sort((x, y) => x.page - y.page || x.start - y.start)
}

/**
 * One open document (one tab). Owns its engine worker, reactive state, caches and the view
 * controller. Features reach it through `useActiveDoc()` or the `doc` passed to their components.
 */
export class DocumentModel {
  readonly id = `doc-${++docCounter}`
  readonly store: StoreApi<DocState>
  view: ViewController | null = null
  /** Page navigation history for View > Previous View / Next View. */
  readonly history = { back: [] as number[], forward: [] as number[] }

  private textCache = new Map<number, { version: number; promise: Promise<PageText> }>()
  private changeListeners = new Set<Listener<ChangeSet>>()
  private searchToken = 0
  private closed = false

  constructor(
    readonly engine: EngineClient,
    info: DocInfo,
    opts: { title: string; filePath: string | null; zoomMode?: ZoomMode; layout?: PageLayoutMode; dirty?: boolean }
  ) {
    this.store = createStore<DocState>(() => ({
      info,
      title: opts.title,
      filePath: opts.filePath,
      dirty: !!opts.dirty,
      journal: { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, position: 0 },
      pageVersions: {},
      globalVersion: 0,
      docVersion: 0,
      zoom: 1,
      zoomMode: opts.zoomMode ?? 'fit-width',
      layout: opts.layout ?? 'continuous',
      coverPage: false,
      viewRotation: 0,
      currentPage: 0,
      selection: { kind: 'none' },
      search: emptySearch(),
      busy: null,
      showAnnotations: true
    }))
    this.engine.onChanges((cs) => void this.applyChanges(cs))
  }

  // ---- state helpers -------------------------------------------------------------------

  get state(): DocState {
    return this.store.getState()
  }

  set(patch: Partial<DocState> | ((s: DocState) => Partial<DocState>)) {
    this.store.setState(patch as any)
  }

  get info(): DocInfo {
    return this.state.info
  }

  get pageCount(): number {
    return this.state.info.pageCount
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Typed operations of an engine module: `doc.ops<typeof import('./engine').default>('stamps')`. */
  ops<M extends OpModule>(namespace: string, opts?: CallOptions): ClientOps<M> {
    return this.engine.ops<M>(namespace, opts)
  }

  get core() {
    return {
      doc: this.ops<typeof docOps>('doc'),
      render: this.ops<typeof renderOps>('render'),
      text: this.ops<typeof textOps>('text'),
      nav: this.ops<typeof navOps>('nav')
    }
  }

  // ---- change handling ------------------------------------------------------------------

  private async applyChanges(cs: ChangeSet) {
    if (this.closed) return
    if (cs.structure) {
      try {
        const info = await this.core.doc.info()
        this.set({ info })
      } catch (err) {
        console.error('Could not refresh document info', err)
      }
    }
    const info = this.state.info
    // Keep the previous text of changed pages to tell whether character offsets moved.
    const previousText = new Map<number, Promise<PageText>>()
    if (!cs.all && !cs.structure) {
      for (const p of cs.pages) {
        const e = this.textCache.get(p)
        if (e) previousText.set(p, e.promise)
      }
    }
    if (cs.all) this.textCache.clear()
    for (const p of cs.pages) this.textCache.delete(p)
    this.set((s) => {
      const pageVersions = { ...s.pageVersions }
      for (const p of cs.pages) {
        const id = info.pages[p]?.id
        if (id !== undefined) pageVersions[id] = (pageVersions[id] ?? 0) + 1
      }
      const currentPage = Math.min(s.currentPage, Math.max(0, info.pageCount - 1))
      return {
        pageVersions,
        globalVersion: cs.all ? s.globalVersion + 1 : s.globalVersion,
        docVersion: cs.document || cs.structure ? s.docVersion + 1 : s.docVersion,
        journal: cs.journal,
        dirty: cs.dirty,
        currentPage
      }
    })
    if (cs.structure || cs.all) {
      // Search hits point at character offsets that may no longer exist.
      if (this.state.search.hits.length) this.set({ search: { ...this.state.search, hits: [], active: -1, done: false } })
      if (this.state.selection.kind !== 'none') this.set({ selection: { kind: 'none' } })
    } else if (cs.pages.length) {
      void this.revalidateTextOffsets(cs.pages, previousText)
    }
    for (const l of this.changeListeners) l(cs)
  }

  /**
   * After page-only changes (s.touch(page)), search hits and text selections on those pages are
   * character offsets into the old text. When the text really changed (Edit Text, redaction...),
   * re-run the search on those pages and drop the selection there; a change that leaves the text
   * alone (a new comment, a form value) keeps both.
   */
  private async revalidateTextOffsets(pages: number[], previousText: Map<number, Promise<PageText>>) {
    for (const p of pages) {
      const before = this.state
      const searching = !!before.search.query.trim()
      const sel = before.selection
      const selected = sel.kind === 'text' && sel.ranges.some((r) => r.page === p)
      if (!searching && !selected) continue
      const token = this.searchToken
      let prev: PageText | null = null
      try {
        prev = (await previousText.get(p)) ?? null
      } catch {}
      // The current text (again if the page changed once more while it loaded).
      let next: PageText | null = null
      let version: number
      do {
        version = this.pageVersion(p)
        try {
          next = await this.pageText(p)
        } catch {
          next = null
        }
      } while (!this.closed && version !== this.pageVersion(p))
      if (this.closed) return
      if (next && prev && next.text === prev.text) continue
      const cur = this.state.selection
      if (cur === sel && cur.kind === 'text') {
        const ranges = cur.ranges.filter((r) => r.page !== p)
        this.set({ selection: ranges.length ? { kind: 'text', ranges } : { kind: 'none' } })
      }
      if (searching && token === this.searchToken) {
        const s = this.state.search
        const found = next ? searchPage(next, s.query, s.options) : []
        const old = s.hits[s.active]
        const hits = mergeHits(
          s.hits.filter((h) => h.page !== p),
          found
        )
        let active = -1
        if (old && old.page !== p) active = hits.indexOf(old)
        else if (old) {
          const onPage = hits.filter((h) => h.page === p)
          const same = onPage.find((h) => h.start >= old.start) ?? onPage.at(-1)
          active = same ? hits.indexOf(same) : hits.length ? this.firstHitFrom(hits, p) : -1
        }
        this.set({ search: { ...s, hits, active } })
      }
    }
  }

  /** Called after every engine change (after the state was updated). */
  onChange(listener: Listener<ChangeSet>): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  pageVersion(index: number): number {
    const s = this.state
    const id = s.info.pages[index]?.id ?? -1
    return (s.pageVersions[id] ?? 0) * 1000003 + s.globalVersion
  }

  // ---- text -----------------------------------------------------------------------------

  /** Text of a page (cached until the page changes). */
  pageText(index: number): Promise<PageText> {
    const version = this.pageVersion(index)
    const hit = this.textCache.get(index)
    if (hit && hit.version === version) return hit.promise
    const promise = this.core.text.page(index)
    this.textCache.set(index, { version, promise })
    promise.catch(() => this.textCache.delete(index))
    return promise
  }

  // ---- selection ------------------------------------------------------------------------

  setSelection(selection: Selection) {
    this.set({ selection })
  }

  clearSelection() {
    if (this.state.selection.kind !== 'none') this.set({ selection: { kind: 'none' } })
  }

  async selectedText(): Promise<string> {
    const sel = this.state.selection
    if (sel.kind !== 'text') return ''
    const parts: string[] = []
    for (const r of sel.ranges) {
      const t = await this.pageText(r.page)
      parts.push(t.text.slice(r.start, r.end))
    }
    return parts
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim()
  }

  // ---- search ---------------------------------------------------------------------------

  async search(query: string, options: SearchOptions = {}, opts: { startPage?: number } = {}) {
    const token = ++this.searchToken
    const n = this.pageCount
    const running = !!query.trim()
    this.set({ search: { ...emptySearch(), query, options, running } })
    if (!running) return
    const start = opts.startPage ?? this.state.currentPage
    const stale = () => token !== this.searchToken || this.closed
    for (let k = 0; k < n; k++) {
      if (stale()) return
      const page = (start + k) % n
      let found: SearchHit[] = []
      try {
        found = searchPage(await this.pageText(page), query, options)
      } catch {}
      // A newer search (or closing the document) may have started while the text loaded.
      if (stale()) return
      const s = this.state.search
      // The pages are searched from the start page round to it, but hits are kept in document
      // order, so the active hit is tracked by identity rather than by index.
      const current = s.hits[s.active]
      const hits = found.length
        ? mergeHits(
            s.hits.filter((h) => h.page !== page),
            found
          )
        : s.hits
      const reveal = !current && hits.length > 0
      const active = current ? hits.indexOf(current) : reveal ? this.firstHitFrom(hits, start) : -1
      this.set({
        search: { ...s, hits, active, running: k < n - 1, done: k === n - 1, pagesSearched: k + 1 }
      })
      if (reveal) void this.revealHit(active)
      // yield to keep the UI responsive
      if (k % 4 === 3) await new Promise((r) => setTimeout(r, 0))
    }
  }

  private firstHitFrom(hits: SearchHit[], page: number): number {
    const i = hits.findIndex((h) => h.page >= page)
    return i >= 0 ? i : 0
  }

  cancelSearch() {
    this.searchToken++
    this.set({ search: emptySearch() })
  }

  async revealHit(index: number) {
    const hit = this.state.search.hits[index]
    if (!hit) return
    this.set({ search: { ...this.state.search, active: index } })
    const t = await this.pageText(hit.page)
    // Find Next, a newer search or an edit may have moved on while the text loaded.
    const s = this.state.search
    if (this.closed || s.hits[s.active] !== hit) return
    const rects = rangeRects(t, hit.start, hit.end)
    if (rects.length) this.view?.scrollToRect(hit.page, rects[0], { center: true })
    else this.view?.goToPage(hit.page)
  }

  nextHit(dir: 1 | -1 = 1) {
    const s = this.state.search
    if (!s.hits.length) return
    const next = (s.active + dir + s.hits.length) % s.hits.length
    void this.revealHit(next)
  }

  // ---- history & saving -----------------------------------------------------------------

  async undo() {
    await this.core.doc.undo()
  }

  async redo() {
    await this.core.doc.redo()
  }

  async saveBytes(opts: SaveOptions = {}): Promise<Uint8Array> {
    return this.core.doc.save(opts)
  }

  /** Runs fn while showing a busy indicator for this document. */
  async busyWhile<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.set({ busy: label })
    try {
      return await fn()
    } finally {
      this.set({ busy: null })
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.searchToken++
    this.changeListeners.clear()
    this.textCache.clear()
    this.engine.terminate()
  }
}

/** React hook: subscribe to a slice of a document's state. */
export function useDocState<T>(doc: DocumentModel, selector: (s: DocState) => T): T {
  return useStore(doc.store, selector)
}

/** Re-renders when the given page changes (returns its version). */
export function usePageVersion(doc: DocumentModel, pageIndex: number): number {
  return useStore(doc.store, (s) => {
    const id = s.info.pages[pageIndex]?.id ?? -1
    return (s.pageVersions[id] ?? 0) * 1000003 + s.globalVersion
  })
}
