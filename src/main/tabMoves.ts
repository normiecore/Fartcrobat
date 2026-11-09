// Moving tabs between windows, main-process side (see docs/features/windows-tabs.md). The window
// that has a document hands it over (window:moveDocument); this file picks or opens the window
// that takes it, holds the hand-off in memory until that window's renderer can open it, and
// answers the first window once it did.
import { BrowserWindow, screen } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  dropDestination,
  handOffProblem,
  newWindowBounds,
  type DocumentHandOff,
  type IncomingMove,
  type MoveResult,
  type MoveSettlement,
  type MoveTarget
} from '@shared/tabMoves'
import { handle, send } from './ipc'
import { allWindows, closeWithoutAsking, createWindow, isAppWindow, isWindowReady, showWindow } from './windows'

/** A document moved between windows, for agent access to follow its handle (windowId: BrowserWindow.webContents.id). */
export interface DocumentMovedEvent {
  from: { webContentsId: number; boot: string; docId: string }
  to: { webContentsId: number; boot: string; docId: string }
}
const movedListeners = new Set<(e: DocumentMovedEvent) => void>()

/** Called after each completed move; returns a function that stops listening. */
export function onDocumentMoved(listener: (e: DocumentMovedEvent) => void): () => void {
  movedListeners.add(listener)
  return () => movedListeners.delete(listener)
}

interface PendingMove {
  id: string
  handOff: DocumentHandOff
  index?: number
  source: BrowserWindow
  sourceWcId: number
  target: BrowserWindow
  /** The target was opened for this move: it closes again when the move fails. */
  created: boolean
  /** Waiting for the target's renderer to take it (window:takeMovedDocuments). */
  queued: boolean
  settle(result: MoveResult): void
}
const pending = new Map<string, PendingMove>()

function windowTitle(win: BrowserWindow): string {
  return win.isDestroyed() ? 'Inkmoor' : win.getTitle() || 'Inkmoor'
}

function deliver(move: PendingMove) {
  const incoming: IncomingMove = { moveId: move.id, handOff: move.handOff, ...(move.index !== undefined ? { index: move.index } : {}) }
  if (isWindowReady(move.target)) {
    move.queued = false
    send(move.target, 'window:incomingDocument', incoming)
  } else move.queued = true
}

function fail(move: PendingMove, message: string) {
  if (pending.get(move.id) !== move) return
  pending.delete(move.id)
  if (move.created && isAppWindow(move.target)) closeWithoutAsking(move.target)
  move.settle({ ok: false, message })
}

function startMove(source: BrowserWindow, handOff: DocumentHandOff, target: MoveTarget): Promise<MoveResult> {
  const problem = handOffProblem(handOff)
  if (problem) return Promise.resolve({ ok: false, message: problem })
  let win: BrowserWindow | null = null
  let created = false
  let index: number | undefined
  if (target.kind === 'window') {
    const w = BrowserWindow.fromId(target.windowId)
    if (!w || w === source || !isAppWindow(w)) return Promise.resolve({ ok: false, message: 'That window is closed.' })
    win = w
    if (Number.isInteger(target.index) && (target.index as number) >= 0) index = target.index
  } else {
    let bounds: { x: number; y: number; width: number; height: number } | undefined
    const point = target.point
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      const [width, height] = source.isDestroyed() ? [1200, 800] : source.getSize()
      bounds = newWindowBounds(point, { width, height }, screen.getDisplayNearestPoint(point).workArea)
    }
    win = createWindow({ bounds })
    created = true
  }
  return new Promise<MoveResult>((resolve) => {
    const move: PendingMove = {
      id: randomUUID(),
      handOff,
      index,
      source,
      sourceWcId: source.webContents.id,
      target: win,
      created,
      queued: true,
      settle: resolve
    }
    pending.set(move.id, move)
    // The window that should take it closes or crashes first: the document stays where it was.
    const gone = () => fail(move, 'The other window closed before the document could move.')
    win.once('closed', gone)
    win.webContents.once('render-process-gone', gone)
    const done = move.settle
    move.settle = (r) => {
      if (!win.isDestroyed()) {
        win.removeListener('closed', gone)
        win.webContents.removeListener('render-process-gone', gone)
      }
      done(r)
    }
    deliver(move)
  })
}

function settle(sender: Electron.WebContents, moveId: string, s: MoveSettlement) {
  const move = pending.get(moveId)
  if (!move || move.target.isDestroyed() || move.target.webContents !== sender) return
  if (!s || typeof s !== 'object' || !s.ok) {
    fail(move, s && typeof s === 'object' && !s.ok && typeof s.message === 'string' ? s.message : 'The other window could not open the document.')
    return
  }
  pending.delete(move.id)
  showWindow(move.target)
  if (typeof s.docId === 'string' && typeof s.boot === 'string') {
    const event: DocumentMovedEvent = {
      from: { webContentsId: move.sourceWcId, boot: move.handOff.from.boot, docId: move.handOff.from.docId },
      to: { webContentsId: sender.id, boot: s.boot, docId: s.docId }
    }
    for (const l of movedListeners) {
      try {
        l(event)
      } catch (err) {
        console.error('Document move listener failed', err)
      }
    }
  }
  move.settle({ ok: true, windowTitle: windowTitle(move.target) })
}

export function registerTabMoveHandlers() {
  handle('window:id', (e) => BrowserWindow.fromWebContents(e.sender)?.id ?? -1)
  handle('window:list', (e) => {
    const self = BrowserWindow.fromWebContents(e.sender)
    return allWindows()
      .filter((w) => w !== self && isWindowReady(w))
      .map((w) => ({ id: w.id, title: windowTitle(w) }))
  })
  handle('window:moveDocument', (e, handOff, target): MoveResult | Promise<MoveResult> => {
    const source = BrowserWindow.fromWebContents(e.sender)
    if (!isAppWindow(source)) return { ok: false, message: 'This window cannot move documents.' }
    if (!target || (target.kind !== 'window' && target.kind !== 'new')) return { ok: false, message: 'No window to move the document to.' }
    return startMove(source, handOff, target)
  })
  handle('window:takeMovedDocuments', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const out: IncomingMove[] = []
    for (const move of pending.values()) {
      if (move.target !== win || !move.queued) continue
      move.queued = false
      out.push({ moveId: move.id, handOff: move.handOff, ...(move.index !== undefined ? { index: move.index } : {}) })
    }
    return out
  })
  handle('window:moveSettled', (e, moveId, s) => settle(e.sender, moveId, s))
  handle('window:requestTabMove', (e, fromWindowId, docId, index) => {
    const target = BrowserWindow.fromWebContents(e.sender)
    const source = typeof fromWindowId === 'number' ? BrowserWindow.fromId(fromWindowId) : null
    if (!isAppWindow(target) || !isAppWindow(source) || source === target || typeof docId !== 'string') return
    send(source, 'window:moveOut', docId, { kind: 'window', windowId: target.id, index: Number.isInteger(index) ? index : undefined })
  })
  handle('window:tabDropDestination', (e): MoveTarget | null => {
    const source = BrowserWindow.fromWebContents(e.sender)
    if (!isAppWindow(source)) return null
    const point = screen.getCursorScreenPoint()
    const others = allWindows()
      .filter((w) => w !== source && isWindowReady(w) && w.isVisible() && !w.isMinimized())
      // The focused window first: it is in front of the others.
      .sort((a, b) => Number(b.isFocused()) - Number(a.isFocused()))
      .map((w) => ({ id: w.id, bounds: w.getBounds() }))
    const dest = dropDestination(point, source.getBounds(), others)
    if (dest.kind === 'none') return null
    return dest.kind === 'window' ? { kind: 'window', windowId: dest.windowId } : { kind: 'new', point: dest.point }
  })
}
