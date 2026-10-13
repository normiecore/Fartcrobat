import { create } from 'zustand'
import { useApp, type DocumentModel } from '@renderer/sdk'

/** Organize Pages state for one document. Pages are tracked by id so selections survive reordering. */
export interface OrgDocState {
  /** Selected page ids, in selection order. */
  selected: number[]
  /** Page id where Shift+click ranges start. */
  anchor: number | null
  /** Page id with keyboard focus. */
  focus: number | null
}

interface OrgState {
  docs: Record<string, OrgDocState>
  /** Thumbnail size in CSS pixels (the long side of a page). */
  thumbSize: number
  /** Columns of the mounted grid (for keyboard navigation). */
  columns: number
}

export const MIN_THUMB = 80
export const MAX_THUMB = 360
export const DEFAULT_THUMB = 170

export const useOrganize = create<OrgState>(() => ({ docs: {}, thumbSize: DEFAULT_THUMB, columns: 4 }))

const EMPTY: OrgDocState = { selected: [], anchor: null, focus: null }

export const ORGANIZE_GROUP = 'organize'

export function orgState(docId: string): OrgDocState {
  return useOrganize.getState().docs[docId] ?? EMPTY
}

export function useOrgState(doc: DocumentModel): OrgDocState {
  return useOrganize((s) => s.docs[doc.id] ?? EMPTY)
}

export function patchOrg(docId: string, patch: Partial<OrgDocState>) {
  useOrganize.setState((s) => ({ docs: { ...s.docs, [docId]: { ...(s.docs[docId] ?? EMPTY), ...patch } } }))
}

/** True while the Organize Pages grid is shown for this document. */
export function isOrganizeOpen(doc: DocumentModel | null): boolean {
  if (!doc) return false
  const app = useApp.getState()
  return app.toolGroupId === ORGANIZE_GROUP && app.activeDocId === doc.id
}

function idIndex(doc: DocumentModel): Map<number, number> {
  const m = new Map<number, number>()
  doc.state.info.pages.forEach((p, i) => m.set(p.id, i))
  return m
}

/** Selected pages as sorted indices (pages that no longer exist are ignored). */
export function selectedIndices(doc: DocumentModel): number[] {
  const st = orgState(doc.id)
  if (!st.selected.length) return []
  const map = idIndex(doc)
  const out: number[] = []
  for (const id of st.selected) {
    const i = map.get(id)
    if (i !== undefined) out.push(i)
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

export function focusedIndex(doc: DocumentModel): number {
  const f = orgState(doc.id).focus
  if (f === null) return -1
  return doc.state.info.pages.findIndex((p) => p.id === f)
}

export function anchorIndex(doc: DocumentModel): number {
  const a = orgState(doc.id).anchor
  if (a === null) return -1
  return doc.state.info.pages.findIndex((p) => p.id === a)
}

/** Selects pages by index. `focus`/`anchor` default to the last/first selected page. */
export function selectIndices(
  doc: DocumentModel,
  indices: number[],
  opts: { focus?: number; anchor?: number; keepAnchor?: boolean } = {}
) {
  const pages = doc.state.info.pages
  const ids = indices.filter((i) => i >= 0 && i < pages.length).map((i) => pages[i].id)
  const prev = orgState(doc.id)
  const focus =
    opts.focus !== undefined ? (pages[opts.focus]?.id ?? null) : ids.length ? ids[ids.length - 1] : prev.focus
  const anchor = opts.keepAnchor
    ? prev.anchor
    : opts.anchor !== undefined
      ? (pages[opts.anchor]?.id ?? null)
      : ids.length
        ? ids[0]
        : prev.anchor
  patchOrg(doc.id, { selected: ids, focus, anchor })
  if (opts.focus !== undefined && opts.focus >= 0 && opts.focus < pages.length)
    doc.set({ currentPage: opts.focus })
}

export function clearSelection(doc: DocumentModel) {
  patchOrg(doc.id, { selected: [] })
}

export function setFocusIndex(doc: DocumentModel, index: number) {
  const id = doc.state.info.pages[index]?.id ?? null
  patchOrg(doc.id, { focus: id })
  if (index >= 0 && index < doc.pageCount) doc.set({ currentPage: index })
}

/** Pages an action applies to: the grid selection, otherwise the current page. */
export function targetPages(doc: DocumentModel): number[] {
  if (isOrganizeOpen(doc)) {
    const sel = selectedIndices(doc)
    if (sel.length) return sel
    const f = focusedIndex(doc)
    if (f >= 0) return [f]
    return []
  }
  return [doc.state.currentPage]
}

/** Where new pages go by default: after the selection (or the current page). */
export function defaultInsertionGap(doc: DocumentModel): number {
  const t = targetPages(doc)
  if (t.length) return t[t.length - 1] + 1
  return doc.pageCount
}
