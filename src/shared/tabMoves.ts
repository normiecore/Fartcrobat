// Moving a tab (an open document) between windows: the hand-off message and the pure decisions
// around it, shared by the renderer and the main process (see docs/features/windows-tabs.md).

/** A screen point or rectangle, in screen pixels (Electron's DIP coordinates). */
export interface ScreenPoint {
  x: number
  y: number
}
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

/** How the moved tab was showing, so it opens the same way in the other window. */
export interface MovedView {
  page: number
  zoom: number
  zoomMode: string
  layout: string
}

/**
 * Everything a window needs to show a document another window had open. `bytes` is the current
 * content (with its unsaved changes when `dirty`), protected as the file is. `password` and `unlock`
 * (which may hold a certificate key) only pass through the main process's memory, from the window
 * that had the document to the one that takes it; they are never written or logged.
 */
export interface DocumentHandOff {
  title: string
  filePath: string | null
  sourcePath: string | null
  dirty: boolean
  bytes: Uint8Array
  password: string | null
  /** The renderer's DocUnlock (how the document was unlocked), or null. */
  unlock: unknown
  view: MovedView
  /** The document had undo (or redo) steps, which stay behind. */
  hadHistory: boolean
  /** The tab in the window it came from: its document id and that window's load ("boot"). */
  from: { docId: string; boot: string }
}

/** Where a moved tab goes: another window (at a tab position), or a new window near a point. */
export type MoveTarget =
  | { kind: 'window'; windowId: number; index?: number }
  | { kind: 'new'; point?: ScreenPoint }

export type MoveResult = { ok: true; windowTitle: string } | { ok: false; message: string }

/** A window's answer once it opened (or could not open) a document moved to it. */
export type MoveSettlement = { ok: true; docId: string; boot: string } | { ok: false; message: string }

/** A move waiting in the window that takes the document. */
export interface IncomingMove {
  moveId: string
  handOff: DocumentHandOff
  index?: number
}

/** Another app window, as the tab menu lists it. */
export interface WindowSummary {
  id: number
  title: string
}

/** How far below a window's top edge its tab strip reaches (the top bar), in screen pixels. */
export const TAB_STRIP_HEIGHT = 48

/** The largest document a move hands over (the IPC message holds it twice on the way). */
export const MAX_HANDOFF_BYTES = 1024 * 1024 * 1024

const inside = (p: ScreenPoint, r: ScreenRect) => p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height

/**
 * Where a tab dragged out of its window and dropped at `point` goes. Inside the window it came from:
 * nowhere (the drag was given up). On another window's tab strip: into that window. Anywhere else
 * (the desktop, another window's pages, another app): a new window. `windows` lists the other app
 * windows front to back where known; the first whose strip holds the point wins.
 */
export function dropDestination(
  point: ScreenPoint,
  source: ScreenRect,
  windows: { id: number; bounds: ScreenRect }[]
): { kind: 'none' } | { kind: 'window'; windowId: number } | { kind: 'new'; point: ScreenPoint } {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { kind: 'none' }
  if (inside(point, source)) return { kind: 'none' }
  for (const w of windows) {
    const strip = { x: w.bounds.x, y: w.bounds.y, width: w.bounds.width, height: Math.min(TAB_STRIP_HEIGHT + 32, w.bounds.height) }
    if (inside(point, strip)) return { kind: 'window', windowId: w.id }
  }
  return { kind: 'new', point }
}

/**
 * The bounds of a window opened for a tab dropped at `point`: the size of the window it came from,
 * placed so the tab strip is under the pointer, and kept on the work area of that screen.
 */
export function newWindowBounds(point: ScreenPoint, size: { width: number; height: number }, workArea: ScreenRect): ScreenRect {
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  const x = Math.round(Math.max(workArea.x, Math.min(point.x - 120, workArea.x + workArea.width - width)))
  const y = Math.round(Math.max(workArea.y, Math.min(point.y - 16, workArea.y + workArea.height - height)))
  return { x, y, width, height }
}

/** "Move to …" labels for other windows: their title without " - Inkmoor", numbered when two read the same. */
export function windowChoiceLabels(windows: WindowSummary[]): { id: number; label: string }[] {
  const names = windows.map((w) => {
    const t = w.title.replace(/^•\s*/, '').replace(/\s+-\s+Inkmoor$/, '').trim()
    return !t || t === 'Inkmoor' ? 'Inkmoor window (Home)' : `“${t}” window`
  })
  const seen = new Map<string, number>()
  const total = new Map<string, number>()
  for (const n of names) total.set(n, (total.get(n) ?? 0) + 1)
  return windows.map((w, i) => {
    const n = names[i]
    const k = (seen.get(n) ?? 0) + 1
    seen.set(n, k)
    return { id: w.id, label: `Move to ${n}${(total.get(n) ?? 0) > 1 ? ` (${k})` : ''}` }
  })
}

/** What may stop a tab from moving now, as the window that has it sees it. */
export interface MoveBlockers {
  /** The document's busy label (saving, signing...), or null. */
  busy: string | null
  /** A dialog, the command palette or a progress bar is open in that window. */
  windowBusy: boolean
  /** Messages from features (an AI edit review open on the document...). */
  guards: (string | null | undefined)[]
}

/** Why the tab cannot move now (a sentence for the person), or null when it can. */
export function moveRefusal(title: string, b: MoveBlockers): string | null {
  const guard = b.guards.find((g) => !!g)
  if (guard) return guard
  if (b.busy) return `“${title}” is busy (${b.busy.replace(/…$/, '').toLowerCase()}). Move it when that has finished.`
  if (b.windowBusy) return `Finish what is open in the window of “${title}” first, then move it.`
  return null
}

/** The note shown after a move, or null when there is nothing to say. */
export function movedNote(title: string, h: { dirty: boolean; hadHistory: boolean }): string | null {
  if (!h.hadHistory) return null
  return h.dirty
    ? `“${title}” moved with its unsaved changes. Its undo history stayed behind, so earlier steps cannot be undone here.`
    : `“${title}” moved. Its undo history stayed behind, so earlier steps cannot be undone here.`
}

/** Checks a hand-off that arrived over IPC; returns the message to refuse it with, or null. */
export function handOffProblem(h: unknown): string | null {
  if (!h || typeof h !== 'object') return 'The document to move is missing.'
  const o = h as Partial<DocumentHandOff>
  if (!(o.bytes instanceof Uint8Array) || o.bytes.length === 0) return 'The document to move has no content.'
  if (o.bytes.length > MAX_HANDOFF_BYTES) return 'The document is too large to move to another window. Save it and open it there instead.'
  if (typeof o.title !== 'string' || !o.title) return 'The document to move has no name.'
  if (o.filePath !== null && typeof o.filePath !== 'string') return 'The document to move has an invalid path.'
  if (o.sourcePath !== null && typeof o.sourcePath !== 'string') return 'The document to move has an invalid source path.'
  if (typeof o.dirty !== 'boolean' || typeof o.hadHistory !== 'boolean') return 'The document to move is incomplete.'
  if (o.password !== null && typeof o.password !== 'string') return 'The document to move is incomplete.'
  const v = o.view
  if (!v || typeof v !== 'object' || !Number.isFinite(v.page) || !Number.isFinite(v.zoom)) return 'The document to move is incomplete.'
  const f = o.from
  if (!f || typeof f.docId !== 'string' || typeof f.boot !== 'string') return 'The document to move is incomplete.'
  return null
}

/** The positions of the tabs after moving the tab at `from` to sit before the tab at `to` (0..length). */
export function reorder<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return items
  const target = Math.max(0, Math.min(items.length, to))
  if (target === from || target === from + 1) return items
  const out = items.slice()
  const [moved] = out.splice(from, 1)
  out.splice(target > from ? target - 1 : target, 0, moved)
  return out
}

/** Where to insert a dragged tab in a strip, from the pointer's x and the tabs' left/width (client px). */
export function insertionIndex(x: number, tabs: { left: number; width: number }[]): number {
  for (let i = 0; i < tabs.length; i++) if (x < tabs[i].left + tabs[i].width / 2) return i
  return tabs.length
}

/** Second launches: whether files from another app open in the window used last or a new one. */
export type OpenFilesIn = 'current-window' | 'new-window'
