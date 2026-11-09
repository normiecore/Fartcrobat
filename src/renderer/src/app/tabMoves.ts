// Moving tabs between windows, renderer side (see docs/features/windows-tabs.md and
// src/main/tabMoves.ts). The window that has the document checks it may move, takes its current
// bytes and unlock from the engine, and hands them to the main process; the window that takes it
// opens them as a new tab and answers. Only once that answer says it opened is the tab closed here.
import {
  moveRefusal,
  movedNote,
  reorder,
  type DocumentHandOff,
  type IncomingMove,
  type MoveSettlement,
  type MoveTarget,
  type WindowSummary
} from '@shared/tabMoves'
import type { DocumentModel } from '../document/DocumentModel'
import { invoke, onMainEvent, platform } from '../platform'
import { pathKey } from '@shared/paths'
import { openBytes, removeDocument } from './actions'
import { WINDOW_BOOT } from './boot'
import { commandsAllowed, commitActiveEditors, hasActiveEditors } from './commands'
import { registry } from './registry'
import { useApp } from './store'
import { showError, toast } from './ui-services'
import type { DocUnlock } from './unlock'

/** The MIME type of a tab being dragged; its data is a TabDragData as JSON. */
export const TAB_MIME = 'application/x-inkmoor-tab'

export interface TabDragData {
  windowId: number
  boot: string
  docId: string
}

let ownWindowId: number | null = null

/** This window's id (BrowserWindow.id); asked once. */
export async function windowId(): Promise<number> {
  if (ownWindowId === null) ownWindowId = await invoke('window:id')
  return ownWindowId
}

/** Documents being moved out of this window (one move at a time per document). */
const moving = new Set<DocumentModel>()

export function isMoving(doc: DocumentModel): boolean {
  return moving.has(doc)
}

/** Why `doc` cannot move now, or null. Commits typing in an in-place editor first. */
async function refusal(doc: DocumentModel): Promise<string | null> {
  if (moving.has(doc)) return `“${doc.state.title}” is already moving to another window.`
  if (hasActiveEditors()) await commitActiveEditors()
  const guards = registry.moveGuards.map((g) => {
    try {
      return g(doc)
    } catch {
      return null
    }
  })
  return moveRefusal(doc.state.title, { busy: doc.state.busy, windowBusy: !commandsAllowed(), guards })
}

/**
 * Moves a tab to another window or a new one. Unsaved changes, the file path, the password or
 * certificate key it was opened with, and the page and zoom go along; undo history does not (the
 * person is told when there was some). `closeEmpty`: close this window when it has no tab left
 * (a tab dragged out). Resolves with whether the document moved.
 */
export async function moveDocument(doc: DocumentModel, target: MoveTarget, opts: { closeEmpty?: boolean } = {}): Promise<boolean> {
  if (doc.isClosed || !useApp.getState().docs.includes(doc)) return false
  const refused = await refusal(doc)
  if (refused) {
    toast(refused, { kind: 'error' })
    return false
  }
  moving.add(doc)
  try {
    const s = doc.state
    // While it is on its way nothing may change it here: the other window gets these bytes.
    const result = await doc.busyWhile('Moving to another window…', async () => {
      const out = await doc.core.doc.handOff()
      const handOff: DocumentHandOff = {
        title: s.title,
        filePath: s.filePath,
        sourcePath: doc.sourcePath,
        dirty: s.dirty,
        bytes: out.bytes,
        password: out.password,
        unlock: s.unlock ? { ...s.unlock, ...(out.certificateKey ? { certificateKey: out.certificateKey } : {}) } : null,
        view: { page: s.currentPage, zoom: s.zoom, zoomMode: s.zoomMode, layout: s.layout },
        hadHistory: s.journal.canUndo || s.journal.canRedo,
        from: { docId: doc.id, boot: WINDOW_BOOT }
      }
      const moved = await invoke('window:moveDocument', handOff, target)
      return { moved, version: out.version }
    })
    if (!result.moved.ok) {
      showError(new Error(result.moved.message), `Could not move “${s.title}”`)
      return false
    }
    // An AI app changed it while it was moving: the other window has the earlier state, so this
    // tab stays open with the later one rather than losing it.
    if ((await doc.core.doc.editVersion()) !== result.version) {
      toast(`“${s.title}” changed while it was moving, so it is still open here as well, with the newer changes.`, { kind: 'error' })
      return true
    }
    await removeDocument(doc)
    if (opts.closeEmpty && useApp.getState().docs.length === 0) await invoke('app:quitConfirmed')
    return true
  } catch (err) {
    showError(err, `Could not move “${doc.state.title}”`)
    return false
  } finally {
    moving.delete(doc)
  }
}

/** Opens a document another window handed over, then tells the main process how that went. */
async function receive(move: IncomingMove) {
  const h = move.handOff
  const answer = (settlement: MoveSettlement) =>
    invoke('window:moveSettled', move.moveId, settlement).catch(() => {})
  try {
    if (h.filePath) {
      const key = pathKey(h.filePath, platform)
      if (useApp.getState().docs.some((d) => d.state.filePath && pathKey(d.state.filePath, platform) === key)) {
        await answer({ ok: false, message: `“${h.title}” is already open in that window.` })
        return
      }
    }
    let error: unknown = null
    const doc = await openBytes(h.bytes, h.title, {
      filePath: h.filePath,
      sourcePath: h.sourcePath,
      dirty: h.dirty,
      password: h.password ?? undefined,
      moved: { unlock: (h.unlock as DocUnlock | null) ?? null, view: h.view, index: move.index },
      onError: (err) => (error = err)
    })
    if (!doc) {
      await answer({ ok: false, message: error instanceof Error ? error.message : 'The document could not be opened in the other window.' })
      return
    }
    // Once the viewer is mounted (it scrolls to currentPage itself; this covers a late mount).
    requestAnimationFrame(() => {
      if (!doc.isClosed && doc.state.currentPage !== h.view.page) doc.view?.goToPage(Math.min(h.view.page, doc.pageCount - 1))
    })
    await answer({ ok: true, docId: doc.id, boot: WINDOW_BOOT })
    const note = movedNote(h.title, h)
    if (note) toast(note, { timeout: 8000 })
  } catch (err) {
    await answer({ ok: false, message: err instanceof Error ? err.message : String(err) })
  }
}

/** The other app windows, for "Move to …". */
export async function otherWindows(): Promise<WindowSummary[]> {
  try {
    return await invoke('window:list')
  } catch {
    return []
  }
}

/** Moves a tab of this window to another place in its strip. */
export function reorderTab(docId: string, index: number) {
  useApp.setState((s) => {
    const from = s.docs.findIndex((d) => d.id === docId)
    const docs = reorder(s.docs, from, index)
    return docs === s.docs ? {} : { docs }
  })
}

let installed = false

/** Listens for documents moved to this window and for tabs another window took by drag. */
export function installTabMoves() {
  if (installed) return
  installed = true
  onMainEvent('window:incomingDocument', (move) => void receive(move))
  onMainEvent('window:moveOut', (docId, target) => {
    const doc = useApp.getState().docs.find((d) => d.id === docId)
    // Dropped on another window's strip: like a tab dragged out, the window closes when it was the last.
    if (doc) void moveDocument(doc, target, { closeEmpty: true })
  })
}

/** After the window booted: documents moved to it while it was loading. */
export async function takeMovedDocuments() {
  const list = await invoke('window:takeMovedDocuments').catch(() => [] as IncomingMove[])
  for (const move of list) await receive(move)
}
