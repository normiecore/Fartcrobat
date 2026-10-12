/**
 * State of the text being edited (one editing session at a time, app-wide) and the actions that
 * change it. The store owns the content; the in-place editor is a view of it that reports typing.
 */
import { create } from 'zustand'
import type { Point } from '@shared/geometry'
import { getActiveDoc, invoke, setTool, showError, toast, useApp, type DocumentModel } from '@renderer/sdk'
import type editOps from './engine'
import {
  applyStyle as applyStyleToRuns,
  DEFAULT_STYLE,
  editKey,
  normalizeRuns,
  replaceRange,
  runsLength,
  runsText,
  styleOf,
  type Align,
  type FontChoice,
  type Frame,
  type Run,
  type RunStyle,
  type TextBlockInfo,
  type TextEdit
} from './model'

export interface Sel {
  start: number
  end: number
}

export interface Defaults extends RunStyle {
  align: Align
  lineSpacing: number
}

interface Snapshot {
  runs: Run[]
  selection: Sel
  frame: Frame
  align: Align
  lineSpacing: number
  wrap: boolean
}

export interface EditSession {
  id: number
  doc: DocumentModel
  page: number
  /** The paragraph being edited, or null for new text. */
  block: TextBlockInfo | null
  frame: Frame
  wrap: boolean
  align: Align
  lineSpacing: number
  ascent: number
  runs: Run[]
  fonts: FontChoice[]
  initialKey: string
  /** Screen point where the user clicked (to put the caret there). */
  caret: Point | null
  selection: Sel
  /** Bumped when `runs` changed outside the editor, so the editor re-renders its content. */
  renderToken: number
  /** Bumped to ask the editor to take the keyboard focus. */
  focusToken: number
  status: 'editing' | 'committing'
  undo: Snapshot[]
  redo: Snapshot[]
  lastTyping: number
}

interface State {
  session: EditSession | null
  defaults: Defaults
}

const INITIAL_DEFAULTS: Defaults = { ...DEFAULT_STYLE, align: 'left', lineSpacing: 1.2 }

export const useEditText = create<State>(() => ({ session: null, defaults: INITIAL_DEFAULTS }))

const ops = (doc: DocumentModel) => doc.ops<typeof editOps>('edit-text')

let ids = 0
let committing: Promise<void> | null = null

function patchSession(patch: Partial<EditSession> | ((s: EditSession) => Partial<EditSession>)) {
  useEditText.setState((st) =>
    st.session ? { session: { ...st.session, ...(typeof patch === 'function' ? patch(st.session) : patch) } } : st
  )
}

function snapshot(s: EditSession): Snapshot {
  return { runs: s.runs, selection: s.selection, frame: s.frame, align: s.align, lineSpacing: s.lineSpacing, wrap: s.wrap }
}

function withUndo(s: EditSession): Pick<EditSession, 'undo' | 'redo'> {
  return { undo: [...s.undo.slice(-199), snapshot(s)], redo: [] }
}

export function isChanged(s: EditSession): boolean {
  return editKey(s) !== s.initialKey
}

// ---- blocks of a page (cached per page version) ---------------------------------------------

const blockCache = new WeakMap<DocumentModel, Map<number, { version: number; promise: Promise<TextBlockInfo[]> }>>()

export function loadBlocks(doc: DocumentModel, page: number): Promise<TextBlockInfo[]> {
  let m = blockCache.get(doc)
  if (!m) {
    m = new Map()
    blockCache.set(doc, m)
  }
  const version = doc.pageVersion(page)
  const hit = m.get(page)
  if (hit && hit.version === version) return hit.promise
  const promise = ops(doc).analyze(page)
  m.set(page, { version, promise })
  promise.catch(() => m!.delete(page))
  return promise
}

export function blockAt(blocks: TextBlockInfo[], p: Point, pad = 2): TextBlockInfo | null {
  let best: TextBlockInfo | null = null
  let bestArea = Infinity
  for (const b of blocks) {
    const r = b.bbox
    if (p[0] < r[0] - pad || p[0] > r[2] + pad || p[1] < r[1] - pad || p[1] > r[3] + pad) continue
    const area = (r[2] - r[0]) * (r[3] - r[1])
    if (area < bestArea) {
      best = b
      bestArea = area
    }
  }
  return best
}

// ---- starting and ending sessions -------------------------------------------------------------

function start(
  doc: DocumentModel,
  page: number,
  block: TextBlockInfo | null,
  init: { frame: Frame; wrap: boolean; align: Align; lineSpacing: number; ascent: number; runs: Run[]; fonts: FontChoice[] },
  caret: Point | null
) {
  const runs = normalizeRuns(init.runs)
  const s: EditSession = {
    id: ++ids,
    doc,
    page,
    block,
    ...init,
    runs,
    initialKey: '',
    caret,
    selection: { start: runsLength(runs), end: runsLength(runs) },
    renderToken: 1,
    focusToken: 1,
    status: 'editing',
    undo: [],
    redo: [],
    lastTyping: 0
  }
  s.initialKey = editKey(s)
  useEditText.setState({ session: s })
  doc.setSelection({ kind: 'custom', type: 'edit-text:block', page, data: { id: block?.id ?? 'new' } })
  if (block?.unreadable)
    toast('Some characters in this text cannot be read from the file, so they may change when you edit it.', { kind: 'warning', timeout: 6000 })
}

/** Opens the editor on a paragraph. When another edit is open it is saved first. */
export async function beginEdit(doc: DocumentModel, page: number, block: TextBlockInfo, caret: Point | null, pagePoint: Point | null) {
  const hadSession = !!useEditText.getState().session || !!committing
  await commitSession()
  let target: TextBlockInfo | null = block
  if (hadSession) {
    // the page may have changed: find the paragraph again
    try {
      const blocks = await loadBlocks(doc, page)
      target = pagePoint ? blockAt(blocks, pagePoint) : (blocks.find((b) => b.id === block.id && b.text === block.text) ?? null)
    } catch (err) {
      showError(err, 'Could not read the text on this page')
      return
    }
  }
  if (!target || useEditText.getState().session) return
  const { frame, wrap, align, lineSpacing, ascent, runs, fonts } = target
  start(doc, page, target, { frame, wrap, align, lineSpacing, ascent, runs, fonts }, caret)
}

/** Starts a new, empty text box (Add Text). */
export async function beginNewText(doc: DocumentModel, page: number, origin: Point, width: number | null) {
  await commitSession()
  if (useEditText.getState().session) return
  const d = useEditText.getState().defaults
  start(
    doc,
    page,
    null,
    {
      frame: { origin, dir: [1, 0], width: width ?? 0 },
      wrap: width !== null,
      align: d.align,
      lineSpacing: d.lineSpacing,
      ascent: 0.9,
      runs: [{ ...styleOf(d), text: '' }],
      fonts: []
    },
    null
  )
}

function close(s: EditSession) {
  useEditText.setState((st) => (st.session?.id === s.id ? { session: null } : st))
  const sel = s.doc.state.selection
  if (sel.kind === 'custom' && sel.type === 'edit-text:block') s.doc.clearSelection()
}

/** Closes the editor without saving, whatever its state (document closed, page replaced). */
export function dropSession() {
  const s = useEditText.getState().session
  if (!s) return
  close(s)
  void refreshDirty(s.doc)
}

/** Moves the box by an offset in page space (Alt+arrow keys). */
export function nudgeFrame(dx: number, dy: number) {
  const s = useEditText.getState().session
  if (!s || s.status !== 'editing') return
  const now = Date.now()
  const group = now - s.lastTyping < 800
  patchSession((cur) => ({
    ...(group ? {} : withUndo(cur)),
    frame: { ...cur.frame, origin: [cur.frame.origin[0] + dx, cur.frame.origin[1] + dy] },
    lastTyping: now
  }))
  markDirty(s.doc)
}

/** Discards the edit (Esc). */
export function cancelSession() {
  const s = useEditText.getState().session
  if (!s || s.status !== 'editing') return
  close(s)
  void refreshDirty(s.doc)
}

async function refreshDirty(doc: DocumentModel) {
  if (doc.isClosed) return
  try {
    const dirty = await doc.core.doc.isDirty()
    doc.set({ dirty })
  } catch {}
}

/** Writes the edit into the page (one undoable step). Resolves when done (or when nothing to do). */
export function commitSession(): Promise<void> {
  if (committing) return committing
  const s = useEditText.getState().session
  if (!s || s.status !== 'editing') return Promise.resolve()
  const text = runsText(s.runs)
  if (!isChanged(s) || (!s.block && !text.trim())) {
    close(s)
    if (!s.block) maybeReturnToEditTool()
    return Promise.resolve()
  }
  if (s.doc.isClosed) {
    close(s)
    return Promise.resolve()
  }
  patchSession({ status: 'committing' })
  const edit: TextEdit = {
    source: s.block ? { start: s.block.start, end: s.block.end, check: s.block.text } : null,
    frame: s.frame,
    runs: s.runs,
    align: s.align,
    lineSpacing: s.lineSpacing,
    wrap: s.wrap,
    ascent: s.ascent
  }
  committing = (async () => {
    try {
      const res = await s.doc.busyWhile('Saving text…', () => ops(s.doc).commit(s.page, edit))
      if (res.fallbackFonts.length)
        toast(
          `${res.fallbackFonts.join(', ')} does not include some of the characters you typed, so a standard font was used for that text.`,
          { kind: 'warning', timeout: 7000 }
        )
      if (res.unsupported.length)
        toast(`These characters cannot be shown with the available fonts and were replaced with “?”: ${res.unsupported.join(' ')}`, {
          kind: 'warning',
          timeout: 8000
        })
      // keep the edited text on screen until the page has been drawn again
      await new Promise((r) => setTimeout(r, 220))
      close(s)
      if (!s.block) maybeReturnToEditTool()
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'STALE_BLOCK' || code === 'CLOSED') {
        close(s)
        if (code === 'STALE_BLOCK') showError(err, 'Could not change the text')
      } else {
        showError(err, 'Could not change the text')
        patchSession({ status: 'editing' })
      }
    } finally {
      committing = null
    }
  })()
  return committing
}

function maybeReturnToEditTool() {
  const app = useApp.getState()
  if (app.toolId === 'edit.addText' && !app.prefs.keepToolSelected) setTool('edit.content')
}

// ---- editing ----------------------------------------------------------------------------

/** Content typed in the editor. Typing bursts are grouped into one undo step. */
export function editorChanged(runs: Run[], selection: Sel) {
  const s = useEditText.getState().session
  if (!s || s.status !== 'editing') return
  const now = Date.now()
  const group = now - s.lastTyping < 800
  const wasClean = !isChanged(s)
  patchSession((cur) => ({ ...(group ? {} : withUndo(cur)), runs: normalizeRuns(runs), selection, lastTyping: now }))
  if (wasClean) markDirty(s.doc)
}

function markDirty(doc: DocumentModel) {
  // unsaved typing counts as a change (e.g. for "Save changes?" when closing)
  if (!doc.state.dirty) doc.set({ dirty: true })
}

export function setSelection(selection: Sel) {
  const s = useEditText.getState().session
  if (!s || (s.selection.start === selection.start && s.selection.end === selection.end)) return
  patchSession({ selection })
}

function commandChange(fn: (s: EditSession) => Partial<EditSession>, focus = true) {
  const s = useEditText.getState().session
  if (!s || s.status !== 'editing') return
  patchSession((cur) => ({
    ...withUndo(cur),
    ...fn(cur),
    lastTyping: 0,
    renderToken: cur.renderToken + 1,
    focusToken: focus ? cur.focusToken + 1 : cur.focusToken
  }))
  markDirty(s.doc)
}

/** Applies formatting to the selected text, or to the whole box when nothing is selected. */
export function applyStyle(patch: Partial<RunStyle>, opts: { focus?: boolean } = {}) {
  const s = useEditText.getState().session
  if (!s) {
    setDefaults(patch)
    return
  }
  commandChange((cur) => ({ runs: applyStyleToRuns(cur.runs, cur.selection.start, cur.selection.end, patch) }), opts.focus !== false)
}

/** Toggles bold/italic/underline: on unless the whole target already has it. */
export function toggleStyle(key: 'bold' | 'italic' | 'underline') {
  const st = useEditText.getState()
  const s = st.session
  if (!s) {
    setDefaults({ [key]: !st.defaults[key] })
    return
  }
  const { start: a, end: b } = s.selection
  let pos = 0
  let all = true
  for (const r of s.runs) {
    const rs = pos
    pos += r.text.length
    const overlaps = b > a ? pos > a && rs < b : true
    if (overlaps && r.text.length && !r[key]) all = false
  }
  applyStyle({ [key]: !all })
}

export function setParagraph(patch: { align?: Align; lineSpacing?: number }) {
  const s = useEditText.getState().session
  if (!s) {
    setDefaults(patch)
    return
  }
  commandChange(() => patch)
}

export function insertText(text: string) {
  commandChange((cur) => {
    const runs = replaceRange(cur.runs, cur.selection.start, cur.selection.end, text)
    const at = cur.selection.start + text.length
    return { runs, selection: { start: at, end: at } }
  })
}

/** Moves or resizes the box (live while dragging: only the first call records an undo step). */
export function setFrame(frame: Frame, wrap: boolean, recordUndo: boolean) {
  const s = useEditText.getState().session
  if (!s || s.status !== 'editing') return
  patchSession((cur) => ({ ...(recordUndo ? withUndo(cur) : {}), frame, wrap }))
  markDirty(s.doc)
}

/** Removes all text: committing then deletes the original paragraph. */
export function clearBox() {
  commandChange((cur) => ({ runs: [{ ...styleOf(cur.runs[0]), text: '' }], selection: { start: 0, end: 0 } }))
}

export function deleteBox() {
  const s = useEditText.getState().session
  if (!s) return
  if (!s.block) {
    cancelSession()
    return
  }
  clearBox()
  void commitSession()
}

export function undoLocal(): boolean {
  const s = useEditText.getState().session
  if (!s || !s.undo.length) return false
  const prev = s.undo[s.undo.length - 1]
  patchSession((cur) => ({
    ...prev,
    undo: cur.undo.slice(0, -1),
    redo: [...cur.redo, snapshot(cur)],
    renderToken: cur.renderToken + 1,
    focusToken: cur.focusToken + 1,
    lastTyping: 0
  }))
  return true
}

export function redoLocal(): boolean {
  const s = useEditText.getState().session
  if (!s || !s.redo.length) return false
  const next = s.redo[s.redo.length - 1]
  patchSession((cur) => ({
    ...next,
    redo: cur.redo.slice(0, -1),
    undo: [...cur.undo, snapshot(cur)],
    renderToken: cur.renderToken + 1,
    focusToken: cur.focusToken + 1,
    lastTyping: 0
  }))
  return true
}

// ---- defaults for new text ------------------------------------------------------------------

export function setDefaults(patch: Partial<Defaults>) {
  const defaults = { ...useEditText.getState().defaults, ...patch }
  useEditText.setState({ defaults })
  invoke('store:set', 'edit-text:defaults', defaults).catch((err) => showError(err, 'Could not remember the text settings'))
}

export async function loadDefaults() {
  try {
    const v = (await invoke('store:get', 'edit-text:defaults')) as Partial<Defaults> | undefined
    if (v && typeof v === 'object') useEditText.setState({ defaults: { ...INITIAL_DEFAULTS, ...v, font: typeof v.font === 'string' && !v.font.startsWith('orig:') ? v.font : 'Helvetica' } })
  } catch {}
}

/** The session of the active document, if any. */
export function activeSession(): EditSession | null {
  const s = useEditText.getState().session
  return s && s.doc === getActiveDoc() ? s : null
}
