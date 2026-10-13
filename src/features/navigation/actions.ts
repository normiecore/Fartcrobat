import type { DocumentModel } from '@renderer/sdk'
import { openRightPanel, showError, toast, useApp } from '@renderer/sdk'
import type navigationOps from './engine'
import type { Bookmark, BookmarkDest, BookmarkTarget } from './types'
import { insertionPoint, titleFromText } from './outlineModel'
import { bookmarkUi, setBookmarkUi } from './state'

export const navOps = (doc: DocumentModel) => doc.ops<typeof navigationOps>('navigation')
export const pageOps = (doc: DocumentModel) => doc.ops<typeof import('@engine/ops/pages').default>('pages')
export const annotOps = (doc: DocumentModel) => doc.ops<typeof import('@engine/ops/annots').default>('annots')

export const NAV_PANELS = ['thumbnails', 'bookmarks', 'attachments', 'layers', 'search'] as const

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

/**
 * Shows a page. Without a page viewer (a tool such as Organize Pages replaces it) the page becomes
 * the current one, and the viewer opens there when it comes back.
 */
export function showPage(doc: DocumentModel, index: number) {
  const page = Math.max(0, Math.min(doc.pageCount - 1, index))
  if (doc.view) doc.view.goToPage(page)
  else doc.set({ currentPage: page })
}

/** Navigates to a bookmark destination, applying its magnification like Acrobat does. */
export async function goToDest(doc: DocumentModel, dest: BookmarkDest) {
  const view = doc.view
  const page = Math.max(0, Math.min(doc.pageCount - 1, dest.page))
  if (!view) {
    showPage(doc, page)
    return
  }
  let mode: 'fit-page' | 'fit-width' | null = null
  if (dest.type === 'Fit' || dest.type === 'FitB') mode = 'fit-page'
  else if (dest.type === 'FitH' || dest.type === 'FitBH') mode = 'fit-width'
  if (mode && doc.state.zoomMode !== mode) {
    view.setZoom(mode)
    // let the viewer settle on the new zoom before scrolling
    await nextFrame()
    await nextFrame()
  } else if (dest.type === 'XYZ' && dest.zoom && Math.abs(dest.zoom - doc.state.zoom) > 0.001) {
    doc.set({ zoom: Math.max(0.08, Math.min(64, dest.zoom)), zoomMode: 'custom' })
  }
  const y = dest.type === 'FitV' || dest.type === 'Fit' || dest.type === 'FitB' ? null : dest.y
  doc.view?.goToPage(page, { x: dest.x, y })
}

/** The page view at the top-left of the viewport, as a bookmark destination. */
export function currentViewTarget(doc: DocumentModel): BookmarkTarget {
  const page = doc.state.currentPage
  const zoom = doc.state.zoomMode === 'custom' ? Math.round(doc.state.zoom * 10000) / 10000 : null
  const view = doc.view
  const el = view?.getViewportElement()
  let x: number | null = null
  let y: number | null = null
  if (view && el) {
    const r = el.getBoundingClientRect()
    const hit = view.hitTest(r.left + 2, r.top + 2)
    if (hit && hit.pageIndex === page) {
      const rotated = doc.state.viewRotation !== 0
      y = Math.max(0, Math.round(hit.point[1]))
      if (rotated || el.scrollLeft > 0) x = Math.max(0, Math.round(hit.point[0]))
      if (y < 2) y = 0
    } else if (hit && hit.pageIndex < page) {
      y = 0
    }
  }
  return { page, x, y, zoom }
}

/** Ctrl+B: adds a bookmark for the current view, named from the selected text, and starts renaming it. */
export async function addBookmarkForCurrentView(
  doc: DocumentModel,
  opts: { asChildOf?: number; target?: BookmarkTarget } = {}
) {
  try {
    openRightPanel('bookmarks')
    const ops = navOps(doc)
    const [selected, tree] = await Promise.all([doc.selectedText().catch(() => ''), ops.outline()])
    const title = titleFromText(selected) || 'Untitled'
    const target = opts.target ?? currentViewTarget(doc)
    const at =
      opts.asChildOf !== undefined
        ? { parentId: opts.asChildOf, index: -1 }
        : insertionPoint(tree, bookmarkUi(doc.id).selected, target.page, target.y)
    const id = await ops.addBookmark(at.parentId, at.index, title, target)
    setBookmarkUi(doc.id, (s) => {
      const expanded = new Set(s.expanded)
      if (at.parentId !== null) expanded.add(at.parentId)
      return { selected: id, editing: id, expanded }
    })
  } catch (err) {
    showError(err, 'Could not add the bookmark')
  }
}

/** Opens a right-side panel and remembers it as the last navigation pane. */
export function showPanel(id: string) {
  lastNavPanel = id
  openRightPanel(id)
}

let lastNavPanel = 'thumbnails'

export function rememberNavPanel(id: string | null) {
  if (id && (NAV_PANELS as readonly string[]).includes(id)) lastNavPanel = id
}

/** View > Show/Hide > Navigation Panes. */
export function toggleNavigationPanes() {
  const cur = useApp.getState().rightPanelId
  if (cur) useApp.setState({ rightPanelId: null })
  else openRightPanel(lastNavPanel)
}

/** Resolves once the document info differs from `before` (it is refetched after structural changes). */
export function infoChanged(
  doc: DocumentModel,
  before: DocumentModel['state']['info'],
  timeout = 3000
): Promise<void> {
  if (doc.state.info !== before) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, timeout)
    const unsub = doc.store.subscribe((s) => {
      if (s.info !== before) done()
    })
    function done() {
      clearTimeout(timer)
      unsub()
      resolve()
    }
  })
}

export function bookmarkCount(tree: Bookmark[]): number {
  return tree.reduce((n, b) => n + 1 + bookmarkCount(b.children), 0)
}

export function undoToast(doc: DocumentModel, message: string) {
  toast(message, { kind: 'success', action: { label: 'Undo', run: () => void doc.undo() } })
}
