/** UI state of the redact feature: default properties, marks per document, hover, find results. */
import { useEffect } from 'react'
import { create } from 'zustand'
import { scheduleMenuUpdate } from '@renderer/app/commands'
import { invoke, showError, useDocState, type DocumentModel } from '@renderer/sdk'
import { DEFAULT_PROPS, OVERLAY_FONTS, type MarkInfo, type RedactionProps } from './shared'
import type { FindQuery } from './patterns'

export const PROPS_KEY = 'redact:properties'

export interface FindResult {
  key: string
  page: number
  start: number
  end: number
  before: string
  match: string
  after: string
}

export interface FindState {
  query: FindQuery
  running: boolean
  done: boolean
  pagesSearched: number
  results: FindResult[]
  checked: Record<string, boolean>
  /** Result shown on the page with a stronger highlight. */
  active: string | null
}

export const emptyQuery: FindQuery = {
  mode: 'phrase',
  phrase: '',
  list: [],
  pattern: 'email',
  wholeWords: false,
  matchCase: false
}

interface RedactUiState {
  props: RedactionProps
  propsLoaded: boolean
  marks: Record<string, { version: number; list: MarkInfo[] }>
  /** Mark under the pointer (shows the redacted look on the page). */
  hover: { docId: string; id: number } | null
  /** Panel view. */
  view: 'main' | 'find'
  /** Find & redact state, per document. */
  find: Record<string, FindState>
  /** Message bar dismissed for a document (until its mark count changes). */
  barDismissed: Record<string, number>
}

export const useRedactUi = create<RedactUiState>(() => ({
  props: { ...DEFAULT_PROPS },
  propsLoaded: false,
  marks: {},
  hover: null,
  view: 'main',
  find: {},
  barDismissed: {}
}))

function sanitizeProps(v: unknown): RedactionProps {
  const p = { ...DEFAULT_PROPS, ...(v && typeof v === 'object' ? (v as Partial<RedactionProps>) : {}) }
  if (!OVERLAY_FONTS.some((f) => f.id === p.font)) p.font = DEFAULT_PROPS.font
  if (!(p.fontSize > 0 && p.fontSize <= 200)) p.fontSize = DEFAULT_PROPS.fontSize
  if (!['none', 'custom', 'code'].includes(p.overlay)) p.overlay = 'none'
  if (!['left', 'center', 'right'].includes(p.align)) p.align = 'center'
  return p
}

let propsPromise: Promise<RedactionProps> | null = null

/** Loads the saved default redaction properties (once). */
export function loadProps(): Promise<RedactionProps> {
  if (!propsPromise) {
    propsPromise = invoke('store:get', PROPS_KEY)
      .then((v) => {
        const props = sanitizeProps(v)
        useRedactUi.setState({ props, propsLoaded: true })
        return props
      })
      .catch(() => {
        useRedactUi.setState({ propsLoaded: true })
        return useRedactUi.getState().props
      })
  }
  return propsPromise
}

/** Current default properties for new marks. */
export function currentProps(): RedactionProps {
  return useRedactUi.getState().props
}

export async function saveProps(props: RedactionProps) {
  useRedactUi.setState({ props })
  try {
    await invoke('store:set', PROPS_KEY, props)
  } catch (err) {
    showError(err, 'Could not save the redaction properties')
  }
}

// ---- marks --------------------------------------------------------------------------------------

const inflight = new WeakMap<DocumentModel, { version: number; promise: Promise<MarkInfo[]> }>()
const reportedFailure = new WeakSet<DocumentModel>()
const EMPTY: MarkInfo[] = []

export function redactOps(doc: DocumentModel) {
  return doc.ops<typeof import('./engine').default>('redact')
}

/** Fetches the marks of a document (deduplicated per document version). */
export function refreshMarks(doc: DocumentModel): Promise<MarkInfo[]> {
  const version = doc.state.docVersion
  const cur = useRedactUi.getState().marks[doc.id]
  if (cur && cur.version === version) return Promise.resolve(cur.list)
  const pending = inflight.get(doc)
  if (pending && pending.version === version) return pending.promise
  const promise = redactOps(doc)
    .list()
    .then((list) => {
      if (!doc.isClosed) {
        const before = useRedactUi.getState().marks[doc.id]?.list.length ?? 0
        useRedactUi.setState((s) => ({ marks: { ...s.marks, [doc.id]: { version, list } } }))
        // Apply Redactions in the menu depends on whether there are marks.
        if ((before > 0) !== (list.length > 0)) scheduleMenuUpdate()
      }
      return list
    })
    .catch((err) => {
      if (!doc.isClosed && !reportedFailure.has(doc)) {
        reportedFailure.add(doc)
        showError(err, 'Could not read the redaction marks')
      }
      return EMPTY
    })
    .finally(() => {
      if (inflight.get(doc)?.promise === promise) inflight.delete(doc)
    })
  inflight.set(doc, { version, promise })
  return promise
}

/** Redaction marks of a document, kept up to date. */
export function useMarks(doc: DocumentModel): MarkInfo[] {
  const version = useDocState(doc, (s) => s.docVersion)
  useEffect(() => {
    void refreshMarks(doc)
  }, [doc, version])
  return useRedactUi((s) => s.marks[doc.id]?.list ?? EMPTY)
}

export function marksOf(doc: DocumentModel): MarkInfo[] {
  return useRedactUi.getState().marks[doc.id]?.list ?? EMPTY
}

export function forgetDoc(docId: string) {
  useRedactUi.setState((s) => {
    const marks = { ...s.marks }
    const find = { ...s.find }
    delete marks[docId]
    delete find[docId]
    return { marks, find }
  })
}

// ---- selection ----------------------------------------------------------------------------------

export const SELECTION_TYPE = 'redact:marks'

export interface MarkSelectionData {
  ids: number[]
}

export function selectedMarkIds(doc: DocumentModel | null): number[] {
  const sel = doc?.state.selection
  if (!sel || sel.kind !== 'custom' || sel.type !== SELECTION_TYPE) return []
  return ((sel.data as MarkSelectionData | undefined)?.ids ?? []).slice()
}

export function selectMarks(doc: DocumentModel, page: number, ids: number[]) {
  if (!ids.length) doc.clearSelection()
  else doc.setSelection({ kind: 'custom', type: SELECTION_TYPE, page, data: { ids } satisfies MarkSelectionData })
}

// ---- find ---------------------------------------------------------------------------------------

export function emptyFind(query: FindQuery = emptyQuery): FindState {
  return { query, running: false, done: false, pagesSearched: 0, results: [], checked: {}, active: null }
}

export function findStateOf(docId: string): FindState {
  return useRedactUi.getState().find[docId] ?? emptyFind()
}

export function setFind(docId: string, patch: Partial<FindState> | ((f: FindState) => Partial<FindState>)) {
  useRedactUi.setState((s) => {
    const cur = s.find[docId] ?? emptyFind()
    const p = typeof patch === 'function' ? patch(cur) : patch
    return { find: { ...s.find, [docId]: { ...cur, ...p } } }
  })
}
