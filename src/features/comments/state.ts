/**
 * UI state of the comments feature: open pop-up notes, the inline text box editor, hover,
 * Comments panel filters, Commenting preferences, and a shared per-document cache of all comments.
 */
import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { Point } from '@shared/geometry'
import type { AnnotInfo } from '@engine/ops/annots'
import { invoke, showError, useDocState, type DocState, type DocumentModel } from '@renderer/sdk'
import { buildThreads, type Thread } from './shared'

export type CommentThread = Thread<AnnotInfo>

export const annotsOf = (doc: DocumentModel) => doc.ops<typeof import('@engine/ops/annots').default>('annots')
export const commentsOf = (doc: DocumentModel) => doc.ops<typeof import('./engine').default>('comments')

// ---- UI state ---------------------------------------------------------------------------------

export interface PopupEntry {
  docId: string
  id: number
  page: number
  /** Top-left corner in page space once the user moved it; null = next to the comment. */
  pos: Point | null
  width: number
  height: number | null
  z: number
  /** What to focus when it opens. */
  focus: 'contents' | 'reply' | null
}

export interface InlineEdit {
  docId: string
  id: number
  page: number
  /** Freshly created by a tool: an empty box is removed when editing ends. */
  isNew: boolean
}

export interface HoverInfo {
  docId: string
  id: number
  page: number
  x: number
  y: number
}

export type PanelSort = 'page' | 'date' | 'author' | 'type' | 'color'

export interface PanelFilter {
  query: string
  types: string[]
  authors: string[]
  statuses: string[]
  colors: string[]
  checkmark: 'any' | 'checked' | 'unchecked'
}

export const EMPTY_FILTER: PanelFilter = { query: '', types: [], authors: [], statuses: [], colors: [], checkmark: 'any' }

interface UiState {
  popups: PopupEntry[]
  editing: InlineEdit | null
  hover: HoverInfo | null
  /** A comment is being dragged (hides the floating properties bar). */
  dragging: boolean
  /** Expanded cards in the Comments panel, per document. */
  expanded: Record<string, number[]>
  filters: Record<string, PanelFilter>
  sort: PanelSort
  zTop: number
}

export const useCommentsUi = create<UiState>(() => ({
  popups: [],
  editing: null,
  hover: null,
  dragging: false,
  expanded: {},
  filters: {},
  sort: 'page',
  zTop: 1
}))

export function openPopup(doc: DocumentModel, a: { id: number; page: number }, focus: PopupEntry['focus'] = 'contents') {
  useCommentsUi.setState((s) => {
    const z = s.zTop + 1
    const existing = s.popups.find((p) => p.docId === doc.id && p.id === a.id)
    if (existing) return { zTop: z, popups: s.popups.map((p) => (p === existing ? { ...p, z, focus } : p)) }
    return { zTop: z, popups: [...s.popups, { docId: doc.id, id: a.id, page: a.page, pos: null, width: 300, height: null, z, focus }] }
  })
}

export function closePopup(docId: string, id: number) {
  useCommentsUi.setState((s) => ({ popups: s.popups.filter((p) => !(p.docId === docId && p.id === id)) }))
}

export function closePopupsFor(docId: string, ids: number[]) {
  useCommentsUi.setState((s) => ({ popups: s.popups.filter((p) => !(p.docId === docId && ids.includes(p.id))) }))
}

export function updatePopup(docId: string, id: number, patch: Partial<PopupEntry>) {
  useCommentsUi.setState((s) => ({ popups: s.popups.map((p) => (p.docId === docId && p.id === id ? { ...p, ...patch } : p)) }))
}

export function raisePopup(docId: string, id: number) {
  useCommentsUi.setState((s) => {
    const p = s.popups.find((x) => x.docId === docId && x.id === id)
    if (!p || p.z === s.zTop) return {}
    const z = s.zTop + 1
    return { zTop: z, popups: s.popups.map((x) => (x === p ? { ...x, z } : x)) }
  })
}

export function startInlineEdit(doc: DocumentModel, a: { id: number; page: number }, isNew = false) {
  useCommentsUi.setState({ editing: { docId: doc.id, id: a.id, page: a.page, isNew } })
}

export function setExpanded(docId: string, ids: number[]) {
  useCommentsUi.setState((s) => ({ expanded: { ...s.expanded, [docId]: ids } }))
}

export function toggleExpanded(docId: string, id: number, on?: boolean) {
  useCommentsUi.setState((s) => {
    const cur = s.expanded[docId] ?? []
    const has = cur.includes(id)
    const want = on ?? !has
    if (want === has) return {}
    return { expanded: { ...s.expanded, [docId]: want ? [...cur, id] : cur.filter((x) => x !== id) } }
  })
}

export function setFilter(docId: string, patch: Partial<PanelFilter>) {
  useCommentsUi.setState((s) => ({ filters: { ...s.filters, [docId]: { ...(s.filters[docId] ?? EMPTY_FILTER), ...patch } } }))
}

/** Forgets per-document UI state of documents that were closed. */
export function pruneDocs(openIds: string[]) {
  const keep = new Set(openIds)
  useCommentsUi.setState((s) => ({
    popups: s.popups.filter((p) => keep.has(p.docId)),
    editing: s.editing && keep.has(s.editing.docId) ? s.editing : null,
    hover: s.hover && keep.has(s.hover.docId) ? s.hover : null,
    expanded: Object.fromEntries(Object.entries(s.expanded).filter(([k]) => keep.has(k))),
    filters: Object.fromEntries(Object.entries(s.filters).filter(([k]) => keep.has(k)))
  }))
  useCommentData.setState((s) => ({ byDoc: Object.fromEntries(Object.entries(s.byDoc).filter(([k]) => keep.has(k))) }))
}

// ---- Commenting preferences --------------------------------------------------------------------

export interface CommentPrefs {
  /** Show a pop-up preview when the pointer rests on a comment. */
  hoverPopups: boolean
  /** Open the pop-up note right after a sticky note (or other comment) is created. */
  openPopupOnCreate: boolean
}

const PREFS_KEY = 'comments:prefs'

export const useCommentPrefs = create<CommentPrefs & { loaded: boolean }>(() => ({
  hoverPopups: true,
  openPopupOnCreate: true,
  loaded: false
}))

export async function loadCommentPrefs() {
  try {
    const v = (await invoke('store:get', PREFS_KEY)) as Partial<CommentPrefs> | undefined
    useCommentPrefs.setState({ ...(v && typeof v === 'object' ? v : {}), loaded: true })
  } catch {
    useCommentPrefs.setState({ loaded: true })
  }
}

export async function setCommentPrefs(patch: Partial<CommentPrefs>) {
  useCommentPrefs.setState(patch)
  const { hoverPopups, openPopupOnCreate } = useCommentPrefs.getState()
  try {
    await invoke('store:set', PREFS_KEY, { hoverPopups, openPopupOnCreate })
  } catch (err) {
    showError(err, 'Could not save the Commenting preferences')
  }
}

/**
 * Default properties per kind of comment, shared with the comment tools (markup-tools):
 * store key `comments:defaults:<kind>` where kind is the PDF subtype ("Square", "Line", "Ink",
 * "FreeText", "Highlight", "Text"...) or one of the variants "Arrow", "Cloud", "Callout",
 * "Typewriter", "Distance", "Perimeter", "Area" (see defaultsKind). The value is a partial
 * AnnotSpec with any of color, interiorColor, opacity, borderWidth, borderStyle, dashes, cloudy,
 * lineEndings, fontSize, textColor, quadding, icon.
 */
export const defaultsKey = (kind: string) => `comments:defaults:${kind}`

// ---- comment data cache ---------------------------------------------------------------------------

/**
 * Changes whenever comments may have changed: document-level changes (every annots mutation
 * reports one), undo/redo, and page re-renders (features that edit a page without reporting a
 * document change).
 */
export function commentsVersion(s: DocState): string {
  let pages = 0
  for (const v of Object.values(s.pageVersions)) pages += v
  return `${s.docVersion}:${s.globalVersion}:${pages}`
}

const useCommentData = create<{ byDoc: Record<string, { version: string; list: AnnotInfo[] }> }>(() => ({ byDoc: {} }))
const inflight = new Map<string, string>()
const EMPTY: AnnotInfo[] = []

/** Fetches every comment of the document unless the cache is current. */
export async function refreshComments(doc: DocumentModel): Promise<void> {
  const version = commentsVersion(doc.state)
  const cur = useCommentData.getState().byDoc[doc.id]
  if ((cur && cur.version === version) || inflight.get(doc.id) === version || doc.isClosed) return
  inflight.set(doc.id, version)
  try {
    const list = await annotsOf(doc).listAll()
    if (doc.isClosed) return
    useCommentData.setState((s) => ({ byDoc: { ...s.byDoc, [doc.id]: { version, list } } }))
  } catch (err) {
    if (!doc.isClosed) console.warn('Could not list comments', err)
  } finally {
    if (inflight.get(doc.id) === version) inflight.delete(doc.id)
  }
  if (!doc.isClosed && commentsVersion(doc.state) !== version) await refreshComments(doc)
}

/** Every comment of the document (refreshed when the document changes). */
export function useCommentList(doc: DocumentModel): { list: AnnotInfo[]; fresh: boolean } {
  const version = useDocState(doc, commentsVersion)
  const entry = useCommentData((s) => s.byDoc[doc.id])
  useEffect(() => {
    void refreshComments(doc)
  }, [doc, version])
  return { list: entry?.list ?? EMPTY, fresh: entry?.version === version }
}

export function useThreads(doc: DocumentModel): { threads: CommentThread[]; list: AnnotInfo[]; fresh: boolean } {
  const { list, fresh } = useCommentList(doc)
  const threads = useMemo(() => buildThreads(list), [list])
  return { threads, list, fresh }
}

/** Current comments of a document without subscribing (may be slightly stale). */
export function cachedComments(doc: DocumentModel): AnnotInfo[] {
  return useCommentData.getState().byDoc[doc.id]?.list ?? EMPTY
}
