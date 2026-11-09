import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Eye, X } from 'lucide-react'
import { usePopupEscape } from '@renderer/ui/Menu'
import { trapTab } from '@renderer/ui/Dialog'
import {
  Button,
  IconButton,
  drawResult,
  openDialog,
  renderQueueFor,
  useApp,
  useDocState,
  usePageVersion,
  type DocumentModel
} from '@renderer/sdk'
import { setFocusIndex, ORGANIZE_GROUP } from './store'
import { fitPage } from './Thumbnail'
import { MAX_PREVIEW_RENDER_PX, renderLongSide } from './zoom'

/** Room around the page in the preview, and the height of its header (CSS pixels). */
const MARGIN = 24
const HEADER = 48

/**
 * True while `el` is the modal shown on top. Dialogs render in the order they opened (DialogHost),
 * so a later modal in the document is above this one.
 */
export function isTopModal(el: HTMLElement): boolean {
  const all = document.querySelectorAll('[role="dialog"][aria-modal="true"]')
  return all[all.length - 1] === el
}

/**
 * Quick look: a large preview of one page over the Organize Pages grid, sized to the window.
 * Left/Right (and Page Up/Down, Home, End) move through the pages, Escape or Space closes it, Enter
 * opens the page in the document. The grid's focus follows the page shown.
 */
export function openQuickLook(doc: DocumentModel, index: number, openInViewer: (index: number) => void) {
  const grid = document.querySelector<HTMLElement>(`.fc-organize-pages-view[data-doc-id="${doc.id}"] .fc-organize-pages-scroll`)
  void openDialog<number>((close) => <QuickLook doc={doc} start={index} close={close} />, { preview: true }).then((open) => {
    if (open !== undefined) openInViewer(open)
    else if (grid) returnFocusToGrid(grid)
  })
}

/**
 * Gives the focus back to the grid once the quick look has closed. When it closed for another
 * dialog (an agent confirmation closes it to ask its question), that dialog keeps the focus, and
 * the grid gets it back only after every dialog has closed and the focus was left nowhere.
 */
export function returnFocusToGrid(grid: HTMLElement): void {
  const lost = () => {
    const active = document.activeElement
    return !active || active === document.body || !active.isConnected
  }
  const settle = () => {
    if (grid.isConnected && lost()) grid.focus({ preventScroll: true })
  }
  if (useApp.getState().dialogs.length === 0) {
    if (grid.isConnected) grid.focus({ preventScroll: true })
    return
  }
  const unsub = useApp.subscribe((s) => {
    if (s.dialogs.length > 0) return
    unsub()
    // After the last dialog's own clean-up has run (it may have put the focus somewhere itself).
    requestAnimationFrame(settle)
  })
}

function QuickLook({
  doc,
  start,
  close
}: {
  doc: DocumentModel
  start: number
  close: (openPage?: number) => void
}) {
  const pages = useDocState(doc, (s) => s.info.pages)
  const annots = useDocState(doc, (s) => s.showAnnotations)
  const [index, setIndex] = useState(start)
  const count = pages.length
  const i = Math.max(0, Math.min(count - 1, index))
  const page = pages[i]
  const version = usePageVersion(doc, i)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [win, setWin] = useState({ width: window.innerWidth, height: window.innerHeight })
  const [ready, setReady] = useState(false)

  usePopupEscape(true, () => close())

  useLayoutEffect(() => rootRef.current?.focus({ preventScroll: true }), [])

  useEffect(() => {
    const onResize = () => setWin({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // The grid behind follows the page shown, so closing leaves the person there.
  useEffect(() => {
    if (count && !doc.isClosed) setFocusIndex(doc, i)
  }, [doc, i, count])

  // Leaving Organize Pages, switching documents or closing this one ends the preview.
  useEffect(() => {
    const check = () => {
      const app = useApp.getState()
      if (doc.isClosed || app.activeDocId !== doc.id || app.toolGroupId !== ORGANIZE_GROUP) close()
    }
    check()
    return useApp.subscribe(check)
  }, [doc, close])
  useEffect(() => {
    if (!count) close()
  }, [count, close])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys belong to a dialog opened on top of the preview (Save changes? when the window
      // closes, say): leave them alone.
      const root = rootRef.current
      if (!root || !isTopModal(root)) return
      // A modal: Tab and Shift+Tab cycle through the preview's buttons and never reach the shell
      // or the Organize toolbar underneath (whose buttons would act on the grid).
      if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
        if (trapTab(root, e.shiftKey)) e.preventDefault()
        e.stopPropagation()
        return
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return
      let to: number | null = null
      if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') to = i - 1
      else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') to = i + 1
      else if (e.key === 'Home') to = 0
      else if (e.key === 'End') to = count - 1
      else if (e.key === ' ') {
        // A focused button keeps Space (keyboard and screen-reader users press buttons with it).
        if (e.target instanceof HTMLButtonElement) return
        e.preventDefault()
        e.stopPropagation()
        // Holding Space opened the preview: its auto-repeat must not close it again.
        if (e.repeat) return
        e.stopPropagation()
        close()
        return
      } else if (e.key === 'Enter') {
        // A focused button keeps Enter.
        if (e.target instanceof HTMLButtonElement) return
        e.preventDefault()
        e.stopPropagation()
        close(i)
        return
      }
      if (to === null) return
      e.preventDefault()
      e.stopPropagation()
      setIndex(Math.max(0, Math.min(count - 1, to)))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [i, count, close])

  const availW = Math.max(80, win.width - MARGIN * 2)
  const availH = Math.max(80, win.height - HEADER - MARGIN * 2)
  const box = page ? fitPage(page, availW, availH) : { width: 0, height: 0 }
  const scaleFor = (p: { width: number; height: number }) => {
    const b = fitPage(p, availW, availH)
    const px = renderLongSide(Math.max(b.width, b.height), window.devicePixelRatio || 1, MAX_PREVIEW_RENDER_PX)
    return px / Math.max(1, p.width, p.height)
  }
  const scale = page ? scaleFor(page) : 1

  useEffect(() => {
    if (!page) return
    setReady(false)
    const q = renderQueueFor(doc)
    const keyFor = (id: number, v: number, s: number) => `orgql:${id}:v${v}:s${s.toFixed(4)}:a${annots}`
    const req = q.request(keyFor(page.id, version, scale), i, { scale, annots }, -1)
    let alive = true
    void req.promise.then((r) => {
      if (!alive || !r || !canvasRef.current) return
      drawResult(canvasRef.current, r)
      setReady(true)
    })
    // The next page is likely to be shown next: render it after this one.
    const next = doc.state.info.pages[i + 1]
    const nextScale = next ? scaleFor(next) : 0
    const pre = next
      ? q.request(keyFor(next.id, doc.pageVersion(i + 1), nextScale), i + 1, { scale: nextScale, annots }, 0.5)
      : null
    return () => {
      alive = false
      req.cancel()
      pre?.cancel()
    }
    // scaleFor only depends on the window size, which `scale` already follows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page?.id, i, version, scale, annots, win])

  if (!page) return null
  const label = page.label && page.label !== String(i + 1) ? page.label : null
  return (
    <div
      ref={rootRef}
      className="fc-organize-pages-preview"
      role="dialog"
      aria-modal="true"
      aria-label={`Page ${i + 1} of ${count}`}
      tabIndex={-1}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('fc-organize-pages-preview-stage'))
          close()
      }}
    >
      <div className="fc-organize-pages-preview-bar">
        <span className="fc-organize-pages-preview-title" aria-live="polite">
          Page {i + 1} of {count}
          {label && <span className="shell-muted"> · labelled “{label}”</span>}
        </span>
        <div className="fc-organize-pages-preview-tools">
          <IconButton
            icon={ChevronLeft}
            label="Previous page"
            shortcut="Left"
            disabled={i <= 0}
            onClick={() => setIndex(i - 1)}
          />
          <IconButton
            icon={ChevronRight}
            label="Next page"
            shortcut="Right"
            disabled={i >= count - 1}
            onClick={() => setIndex(i + 1)}
          />
          <Button size="sm" variant="quiet" icon={Eye} onClick={() => close(i)} title="Open this page in the document (Enter)">
            Open in document
          </Button>
          <IconButton icon={X} label="Close preview" shortcut="Esc" onClick={() => close()} />
        </div>
      </div>
      <div className="fc-organize-pages-preview-stage">
        <div
          className={`fc-organize-pages-preview-page ${ready ? 'is-ready' : ''}`}
          style={{ width: box.width, height: box.height }}
          data-page-index={i}
        >
          <canvas ref={canvasRef} className="fc-organize-pages-canvas" />
        </div>
      </div>
    </div>
  )
}
