import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  Copy,
  FileOutput,
  FilePlus2,
  Hash,
  Plus,
  Redo2,
  Replace,
  RotateCcw,
  RotateCw,
  Scissors,
  SquareDashedMousePointer,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import {
  Button,
  DropdownMenu,
  IconButton,
  displayShortcut,
  invoke,
  isMac,
  openToolGroup,
  pathForFile,
  runCommand,
  showContextMenu,
  useApp,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { copyPagesToDocument, deletePages, duplicatePages, insertPaths, movePages, rotatePages } from './actions'
import { openExtractDialog } from './dialogs/ExtractDialog'
import { openLabelsDialog } from './dialogs/LabelsDialog'
import { openReplaceFlow } from './dialogs/ReplaceDialog'
import { openSplitDialog } from './dialogs/SplitDialog'
import { backgroundMenu, insertItems, pageMenu, selectBy, selectItems } from './menus'
import { cellPosition, cellsInRect, gapAt, gridMetrics, navigate, nudgeTarget, spanIndices } from './order'
import { countLabel, formatPageRange } from './ranges'
import {
  anchorIndex,
  focusedIndex,
  MAX_THUMB,
  MIN_THUMB,
  patchOrg,
  selectIndices,
  selectedIndices,
  setFocusIndex,
  ORGANIZE_GROUP,
  useOrganize,
  useOrgState
} from './store'
import { Thumbnail } from './Thumbnail'

const OVERSCAN_ROWS = 2
const EDGE = 56

interface TabTarget {
  docId: string
  title: string
  left: number
  top: number
  width: number
  height: number
}

interface DragState {
  /** Page ids being dragged. */
  ids: number[]
  gap: { gap: number; left: number; top: number } | null
  /** Another document's tab under the pointer: the pages are copied to that document. */
  tab: TabTarget | null
  x: number
  y: number
  copy: boolean
}

interface Marquee {
  x0: number
  y0: number
  x1: number
  y1: number
}

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName === 'INPUT')
    return !['checkbox', 'radio', 'button', 'range'].includes((el as HTMLInputElement).type)
  return false
}

function modKey(e: { ctrlKey: boolean; metaKey: boolean }) {
  return isMac ? e.metaKey : e.ctrlKey
}

/** The tab of another open document under a screen point (dragging pages to another document). */
function tabTargetAt(source: DocumentModel, x: number, y: number): TabTarget | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.shell-tabs .shell-tab')
  if (!el) return null
  // Tabs are rendered in the order of the open documents.
  const tabs = [...document.querySelectorAll<HTMLElement>('.shell-tabs .shell-tab')]
  const docs = useApp.getState().docs
  const target = tabs.length === docs.length ? docs[tabs.indexOf(el)] : undefined
  if (!target || target.id === source.id || target.isClosed) return null
  const r = el.getBoundingClientRect()
  return { docId: target.id, title: target.state.title, left: r.left, top: r.top, width: r.width, height: r.height }
}

/** Leaves the grid and shows the page in the normal view. */
export function openPageInViewer(doc: DocumentModel, index: number) {
  doc.set({ currentPage: Math.max(0, Math.min(doc.pageCount - 1, index)) })
  openToolGroup(null)
}

/**
 * After the grid closes, scrolls the page viewer to the current page once it has mounted and
 * picked its zoom (the viewer's first layout uses a provisional size).
 */
function revealInViewer(doc: DocumentModel, page: number) {
  let tries = 0
  const attempt = () => {
    if (doc.isClosed || useApp.getState().toolGroupId === ORGANIZE_GROUP) return
    if (!doc.view) {
      if (tries++ < 30) window.setTimeout(attempt, 20)
      return
    }
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (!doc.isClosed && page < doc.pageCount) doc.view?.goToPage(page)
      })
    )
  }
  window.setTimeout(attempt, 0)
}

function setThumbSize(size: number) {
  const v = Math.max(MIN_THUMB, Math.min(MAX_THUMB, Math.round(size)))
  useOrganize.setState({ thumbSize: v })
  void invoke('store:set', 'organize-pages:thumbSize', v).catch(() => {})
}

function ThumbSizeControl() {
  const thumb = useOrganize((s) => s.thumbSize)
  return (
    <div className="fc-organize-pages-zoom" title="Thumbnail size (Ctrl + mouse wheel)">
      <IconButton
        icon={ZoomOut}
        size={15}
        label="Smaller thumbnails"
        onClick={() => setThumbSize(thumb - 30)}
        disabled={thumb <= MIN_THUMB}
      />
      <input
        type="range"
        aria-label="Thumbnail size"
        min={MIN_THUMB}
        max={MAX_THUMB}
        step={10}
        value={thumb}
        onChange={(e) => setThumbSize(parseFloat(e.target.value))}
      />
      <IconButton
        icon={ZoomIn}
        size={15}
        label="Larger thumbnails"
        onClick={() => setThumbSize(thumb + 30)}
        disabled={thumb >= MAX_THUMB}
      />
    </div>
  )
}

/** Toolbar button text; hidden when the toolbar is narrow (the button keeps its aria-label). */
function Label({ children }: { children: string }) {
  return <span className="fc-organize-pages-btn-text">{children}</span>
}

function Toolbar({ doc, selected }: { doc: DocumentModel; selected: number[] }) {
  const journal = useDocState(doc, (s) => s.journal)
  const none = selected.length === 0
  const n = selected.length
  const gap = n ? selected[n - 1] + 1 : doc.pageCount
  return (
    <div className="fc-organize-pages-toolbar" role="toolbar" aria-label="Organize pages">
      <div className="fc-organize-pages-tools">
        <DropdownMenu
          items={() => selectItems(doc)}
          trigger={(p) => (
            <Button
              variant="quiet"
              size="sm"
              icon={SquareDashedMousePointer}
              {...p}
              aria-label="Select"
              title="Select pages (all, even, odd, a page range…)"
            >
              <Label>Select</Label>
              <ChevronDown size={14} className="fc-organize-pages-caret" />
            </Button>
          )}
        />
        <span className="shell-sep" />
        <IconButton
          icon={RotateCcw}
          label="Rotate counterclockwise"
          disabled={none}
          onClick={() => void rotatePages(doc, selected, -90)}
        />
        <IconButton
          icon={RotateCw}
          label="Rotate clockwise"
          shortcut={displayShortcut('Mod+Shift+R')}
          disabled={none}
          onClick={() => void rotatePages(doc, selected, 90)}
        />
        <IconButton
          icon={Trash2}
          label="Delete pages"
          shortcut="Delete"
          disabled={none || n >= doc.pageCount}
          onClick={() => void deletePages(doc, selected)}
        />
        <IconButton
          icon={Copy}
          label="Duplicate pages"
          disabled={none}
          onClick={() => void duplicatePages(doc, selected)}
        />
        <span className="shell-sep" />
        <DropdownMenu
          items={() => insertItems(doc, gap)}
          trigger={(p) => (
            <Button
              variant="quiet"
              size="sm"
              icon={FilePlus2}
              {...p}
              aria-label="Insert"
              title={n ? `Insert pages after page ${gap}` : 'Insert pages at the end'}
            >
              <Label>Insert</Label>
              <ChevronDown size={14} className="fc-organize-pages-caret" />
            </Button>
          )}
        />
        <Button
          variant="quiet"
          size="sm"
          icon={FileOutput}
          aria-label="Extract"
          title="Extract pages as a new PDF"
          onClick={() => void openExtractDialog(doc, selected)}
        >
          <Label>Extract</Label>
        </Button>
        <Button
          variant="quiet"
          size="sm"
          icon={Scissors}
          aria-label="Split"
          title="Split the document into several files"
          onClick={() => void openSplitDialog(doc)}
        >
          <Label>Split</Label>
        </Button>
        <Button
          variant="quiet"
          size="sm"
          icon={Replace}
          aria-label="Replace"
          title="Replace pages with pages from another file"
          onClick={() => void openReplaceFlow(doc, selected)}
        >
          <Label>Replace</Label>
        </Button>
        <Button
          variant="quiet"
          size="sm"
          icon={Hash}
          aria-label="Page labels"
          title="Page labels (page numbering)"
          onClick={() => void openLabelsDialog(doc, selected)}
        >
          <Label>Page labels</Label>
        </Button>
        <span className="shell-sep" />
        <IconButton
          icon={Undo2}
          label={journal.undoLabel ? `Undo ${journal.undoLabel}` : 'Undo'}
          shortcut={displayShortcut('Mod+Z')}
          disabled={!journal.canUndo}
          onClick={() => void runCommand('edit.undo')}
        />
        <IconButton
          icon={Redo2}
          label={journal.redoLabel ? `Redo ${journal.redoLabel}` : 'Redo'}
          shortcut={displayShortcut('Mod+Shift+Z')}
          disabled={!journal.canRedo}
          onClick={() => void runCommand('edit.redo')}
        />
      </div>
      <div className="fc-organize-pages-tools">
        <Button
          size="sm"
          icon={X}
          aria-label="Close"
          onClick={() => openToolGroup(null)}
          title="Close Organize Pages (back to the document)"
        >
          <Label>Close</Label>
        </Button>
      </div>
    </div>
  )
}

export function OrganizeView({ doc }: { doc: DocumentModel }) {
  const info = useDocState(doc, (s) => s.info)
  const pages = info.pages
  const count = pages.length
  const thumb = useOrganize((s) => s.thumbSize)
  const org = useOrgState(doc)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 900, height: 600 })
  const [scrollTop, setScrollTop] = useState(0)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const [fileDrop, setFileDrop] = useState<{ gap: number; left: number; top: number } | null>(null)
  /** Shows the keyboard focus ring only while the keyboard is used. */
  const [keyboard, setKeyboard] = useState(false)
  /** Animates thumbnails to their new places after pages were reordered. */
  const [animating, setAnimating] = useState(false)
  const prevOrder = useRef<number[]>([])
  const m = useMemo(() => gridMetrics(count, viewport.width, thumb), [count, viewport.width, thumb])
  const mRef = useRef(m)
  mRef.current = m
  const dragRef = useRef<DragState | null>(null)
  dragRef.current = drag

  const selectedSet = useMemo(() => new Set(org.selected), [org.selected])
  const idToIndex = useMemo(() => {
    const map = new Map<number, number>()
    pages.forEach((p, i) => map.set(p.id, i))
    return map
  }, [pages])
  const selected = useMemo(
    () =>
      [
        ...new Set(org.selected.map((id) => idToIndex.get(id)).filter((i): i is number => i !== undefined))
      ].sort((a, b) => a - b),
    [org.selected, idToIndex]
  )
  const focusIndex = org.focus !== null ? (idToIndex.get(org.focus) ?? -1) : -1

  useLayoutEffect(() => {
    const ids = pages.map((p) => p.id)
    const prev = prevOrder.current
    prevOrder.current = ids
    if (!prev.length || prev.length !== ids.length || prev.every((id, i) => id === ids[i])) return
    const set = new Set(prev)
    if (!ids.every((id) => set.has(id))) return
    setAnimating(true)
    const t = window.setTimeout(() => setAnimating(false), 260)
    return () => window.clearTimeout(t)
  }, [pages])

  // Restore the remembered thumbnail size once.
  useEffect(() => {
    void invoke('store:get', 'organize-pages:thumbSize')
      .then((v) => {
        if (typeof v === 'number' && v >= MIN_THUMB && v <= MAX_THUMB) useOrganize.setState({ thumbSize: v })
      })
      .catch(() => {})
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewport({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    setViewport({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    useOrganize.setState({ columns: m.columns })
  }, [m.columns])

  // On open: focus the grid and start at the page the user was reading.
  useEffect(() => {
    doc.clearSelection()
    const el = scrollRef.current
    el?.focus({ preventScroll: true })
    if (focusedIndex(doc) < 0 && doc.pageCount)
      setFocusIndex(doc, Math.min(doc.state.currentPage, doc.pageCount - 1))
    const f = focusedIndex(doc)
    if (el && f >= 0) {
      const p = cellPosition(mRef.current, f)
      if (p.top + mRef.current.cellHeight > el.clientHeight) el.scrollTop = p.top - el.clientHeight / 3
    }
    return () => revealInViewer(doc, doc.state.currentPage)
  }, [doc])

  // Keep the focused page visible (keyboard navigation, inserted pages).
  useEffect(() => {
    const el = scrollRef.current
    if (!el || focusIndex < 0 || dragRef.current) return
    const p = cellPosition(mRef.current, focusIndex)
    const h = mRef.current.cellHeight
    if (p.top < el.scrollTop) el.scrollTop = p.top - 12
    else if (p.top + h > el.scrollTop + el.clientHeight) el.scrollTop = p.top + h - el.clientHeight + 12
  }, [focusIndex, org.focus, thumb])

  const toContent = useCallback((clientX: number, clientY: number) => {
    const el = scrollRef.current!
    const r = el.getBoundingClientRect()
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop }
  }, [])

  // ---- auto-scroll while dragging -------------------------------------------------------
  const pointerRef = useRef<{ x: number; y: number } | null>(null)
  const autoScroll = useRef<number | null>(null)
  const onAutoScroll = useRef<() => void>(() => {})
  const startAutoScroll = useCallback(() => {
    if (autoScroll.current !== null) return
    const tick = () => {
      const el = scrollRef.current
      const pt = pointerRef.current
      if (!el || !pt) {
        autoScroll.current = null
        return
      }
      const r = el.getBoundingClientRect()
      let dy = 0
      // Above the grid only the first band scrolls, so pages can be dragged up to the tabs.
      if (dragRef.current?.tab) dy = 0
      else if (pt.y < r.top + EDGE && pt.y > r.top - EDGE)
        dy = -Math.ceil(((r.top + EDGE - pt.y) / EDGE) * 18)
      else if (pt.y > r.bottom - EDGE) dy = Math.ceil(((pt.y - (r.bottom - EDGE)) / EDGE) * 18)
      if (dy) {
        const before = el.scrollTop
        el.scrollTop += dy
        if (el.scrollTop !== before) onAutoScroll.current()
      }
      autoScroll.current = requestAnimationFrame(tick)
    }
    autoScroll.current = requestAnimationFrame(tick)
  }, [])
  const stopAutoScroll = useCallback(() => {
    if (autoScroll.current !== null) cancelAnimationFrame(autoScroll.current)
    autoScroll.current = null
    pointerRef.current = null
  }, [])
  useEffect(() => stopAutoScroll, [stopAutoScroll])

  // ---- pointer interaction ----------------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('[data-quick], [data-gap], button, input')) return
    const el = scrollRef.current!
    // Clicks on the scrollbar.
    if (e.clientX - el.getBoundingClientRect().left > el.clientWidth) return
    if (e.button !== 0) return
    setKeyboard(false)
    el.focus({ preventScroll: true })
    const cell = target.closest<HTMLElement>('[data-org-index]')
    const mod = modKey(e)
    if (cell) {
      const idx = parseInt(cell.dataset.orgIndex!, 10)
      onCellPointerDown(e, idx, mod)
    } else {
      onBackgroundPointerDown(e, mod)
    }
  }

  const onCellPointerDown = (e: React.PointerEvent, idx: number, mod: boolean) => {
    const current = selectedIndices(doc)
    const isSelected = current.includes(idx)
    let selectOnlyOnClick = false
    if (e.shiftKey) {
      const a = anchorIndex(doc)
      const span = spanIndices(a >= 0 ? a : idx, idx)
      selectIndices(doc, mod ? [...new Set([...current, ...span])] : span, {
        focus: idx,
        keepAnchor: a >= 0,
        anchor: idx
      })
    } else if (mod) {
      const next = isSelected ? current.filter((i) => i !== idx) : [...current, idx]
      selectIndices(doc, next, { focus: idx, anchor: idx })
    } else if (!isSelected) {
      selectIndices(doc, [idx], { focus: idx, anchor: idx })
    } else {
      selectOnlyOnClick = true
      setFocusIndex(doc, idx)
    }
    const start = { x: e.clientX, y: e.clientY }
    let dragging = false
    const move = (ev: PointerEvent) => {
      pointerRef.current = { x: ev.clientX, y: ev.clientY }
      if (!dragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return
        const sel = selectedIndices(doc)
        if (!sel.includes(idx)) return
        dragging = true
        startAutoScroll()
      }
      updateDrag(ev.clientX, ev.clientY, modKey(ev) || ev.altKey)
    }
    const up = (ev: PointerEvent) => {
      cleanup()
      if (dragging) {
        const d = dragRef.current
        setDrag(null)
        if (d?.tab && ev.type === 'pointerup') {
          const target = useApp.getState().docs.find((x) => x.id === d.tab!.docId)
          const indices = d.ids
            .map((id) => doc.state.info.pages.findIndex((p) => p.id === id))
            .filter((i) => i >= 0)
          if (target) void copyPagesToDocument(doc, indices, target)
        } else if (d?.gap && ev.type === 'pointerup') {
          const indices = d.ids
            .map((id) => doc.state.info.pages.findIndex((p) => p.id === id))
            .filter((i) => i >= 0)
          void movePages(doc, indices, d.gap.gap, d.copy)
        }
      } else if (selectOnlyOnClick && ev.type === 'pointerup') {
        selectIndices(doc, [idx], { focus: idx, anchor: idx })
      }
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && dragging) {
        ev.preventDefault()
        ev.stopPropagation()
        dragging = false
        setDrag(null)
        cleanup()
      } else if ((ev.key === 'Control' || ev.key === 'Meta' || ev.key === 'Alt') && dragRef.current) {
        setDrag({ ...dragRef.current, copy: modKey(ev) || ev.altKey })
      }
    }
    const keyUp = (ev: KeyboardEvent) => {
      if (dragRef.current && (ev.key === 'Control' || ev.key === 'Meta' || ev.key === 'Alt'))
        setDrag({ ...dragRef.current, copy: modKey(ev) || ev.altKey })
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('keyup', keyUp, true)
      stopAutoScroll()
    }
    onAutoScroll.current = () => {
      const pt = pointerRef.current
      if (pt && dragRef.current) updateDrag(pt.x, pt.y, dragRef.current.copy)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('keydown', key, true)
    window.addEventListener('keyup', keyUp, true)
  }

  const updateDrag = (clientX: number, clientY: number, copy: boolean) => {
    const { x, y } = toContent(clientX, clientY)
    const tab = tabTargetAt(doc, clientX, clientY)
    const gap = tab ? null : gapAt(mRef.current, doc.pageCount, x, y)
    const ids = dragRef.current?.ids ?? selectedIndices(doc).map((i) => doc.state.info.pages[i].id)
    setDrag({ ids, gap, tab, x: clientX, y: clientY, copy })
  }

  const onBackgroundPointerDown = (e: React.PointerEvent, mod: boolean) => {
    const base = mod || e.shiftKey ? selectedIndices(doc) : []
    if (!mod && !e.shiftKey) selectIndices(doc, [])
    const p0 = toContent(e.clientX, e.clientY)
    let active = false
    const update = (clientX: number, clientY: number) => {
      const p = toContent(clientX, clientY)
      const mq = { x0: p0.x, y0: p0.y, x1: p.x, y1: p.y }
      setMarquee(mq)
      const hits = cellsInRect(mRef.current, doc.pageCount, {
        left: Math.min(mq.x0, mq.x1),
        top: Math.min(mq.y0, mq.y1),
        right: Math.max(mq.x0, mq.x1),
        bottom: Math.max(mq.y0, mq.y1)
      })
      const all = [...new Set([...base, ...hits])]
      selectIndices(
        doc,
        all,
        hits.length ? { focus: hits[hits.length - 1], anchor: hits[0] } : { keepAnchor: true }
      )
    }
    const move = (ev: PointerEvent) => {
      pointerRef.current = { x: ev.clientX, y: ev.clientY }
      if (!active) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return
        active = true
        startAutoScroll()
      }
      update(ev.clientX, ev.clientY)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      stopAutoScroll()
      setMarquee(null)
    }
    onAutoScroll.current = () => {
      const pt = pointerRef.current
      if (pt) update(pt.x, pt.y)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-org-index]')
    if (!cell || (e.target as HTMLElement).closest('[data-quick]')) return
    openPageInViewer(doc, parseInt(cell.dataset.orgIndex!, 10))
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-org-index]')
    if (cell) {
      const idx = parseInt(cell.dataset.orgIndex!, 10)
      let sel = selectedIndices(doc)
      if (!sel.includes(idx)) {
        selectIndices(doc, [idx], { focus: idx, anchor: idx })
        sel = [idx]
      }
      showContextMenu(
        e.clientX,
        e.clientY,
        pageMenu(doc, sel, idx, (i) => openPageInViewer(doc, i))
      )
    } else {
      const { x, y } = toContent(e.clientX, e.clientY)
      showContextMenu(e.clientX, e.clientY, backgroundMenu(doc, gapAt(mRef.current, doc.pageCount, x, y).gap))
    }
  }

  const onQuick = useCallback(
    (action: 'rotateLeft' | 'rotateRight' | 'delete' | 'insertAfter', index: number, e: React.MouseEvent) => {
      // Quick buttons act on the selection when the page is part of it, otherwise on that page.
      const sel = selectedIndices(doc)
      const targets = sel.includes(index) ? sel : [index]
      if (action === 'rotateLeft') void rotatePages(doc, targets, -90)
      else if (action === 'rotateRight') void rotatePages(doc, targets, 90)
      else if (action === 'delete') void deletePages(doc, targets)
      else {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        showContextMenu(r.left, r.bottom + 4, insertItems(doc, index + 1))
      }
    },
    [doc]
  )

  // ---- files dropped from the desktop -----------------------------------------------------
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const { x, y } = toContent(e.clientX, e.clientY)
    const g = gapAt(mRef.current, doc.pageCount, x, y)
    setFileDrop((prev) =>
      prev && prev.gap === g.gap && prev.left === g.left && prev.top === g.top ? prev : g
    )
    pointerRef.current = { x: e.clientX, y: e.clientY }
  }
  const onDragLeave = (e: React.DragEvent) => {
    const el = scrollRef.current
    if (el && e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
    setFileDrop(null)
  }
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.files.length) return
    e.preventDefault()
    const { x, y } = toContent(e.clientX, e.clientY)
    const gap = gapAt(mRef.current, doc.pageCount, x, y).gap
    setFileDrop(null)
    const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean)
    if (paths.length) void insertPaths(doc, gap, paths)
  }

  // ---- keyboard -----------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const app = useApp.getState()
      if (app.dialogs.length || app.paletteOpen || app.contextMenu || app.activeDocId !== doc.id) return
      if (isTypingTarget(e.target)) return
      const target = e.target instanceof HTMLElement ? e.target : null
      if (target?.closest('.ui-dialog, .ui-menu')) return
      // An open dropdown or context menu keeps its keys.
      if (document.querySelector('.ui-popover-scrim')) return
      /** Focus is on the grid (or nowhere), not on a toolbar button or panel control. */
      const inGrid = !target || target === document.body || !!scrollRef.current?.contains(target)
      /** Sliders, checkboxes and lists use the arrow keys themselves. */
      const onControl = !!target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')
      const mod = modKey(e)
      const n = doc.pageCount
      const cols = mRef.current.columns
      const handled = () => {
        e.preventDefault()
        e.stopPropagation()
        setKeyboard(true)
        if (!inGrid) scrollRef.current?.focus({ preventScroll: true })
      }
      const nav = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']
      if (nav.includes(e.key)) {
        if (onControl) return
        const sel = selectedIndices(doc)
        if (e.altKey && e.key.startsWith('Arrow')) {
          const delta =
            e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -cols : cols
          const to = nudgeTarget(n, sel, delta)
          handled()
          if (to !== null) void movePages(doc, sel, to)
          return
        }
        if (e.altKey) return
        const el = scrollRef.current
        const rows = el
          ? Math.max(1, Math.floor(el.clientHeight / (mRef.current.cellHeight + mRef.current.gapY)))
          : 3
        const from = focusedIndex(doc)
        const to = navigate(from, e.key, cols, n, rows)
        handled()
        if (to < 0) return
        if (e.shiftKey) {
          const a = anchorIndex(doc)
          selectIndices(doc, spanIndices(a >= 0 ? a : to, to), { focus: to, keepAnchor: a >= 0, anchor: to })
        } else if (mod) setFocusIndex(doc, to)
        else selectIndices(doc, [to], { focus: to, anchor: to })
        return
      }
      if (e.key === ' ' && !e.altKey) {
        // Space and Enter activate a focused button rather than acting on pages.
        if (!inGrid) return
        const f = focusedIndex(doc)
        handled()
        if (f < 0) return
        const sel = selectedIndices(doc)
        if (mod)
          selectIndices(doc, sel.includes(f) ? sel.filter((i) => i !== f) : [...sel, f], {
            focus: f,
            anchor: f
          })
        else if (!sel.includes(f)) selectIndices(doc, [f], { focus: f, anchor: f })
        return
      }
      if (e.key === 'Enter' && !mod && !e.altKey) {
        if (!inGrid) return
        const f = focusedIndex(doc)
        if (f < 0) return
        handled()
        openPageInViewer(doc, f)
        return
      }
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        handled()
        selectBy(doc, 'all')
        return
      }
      if (e.key === 'Escape' && selectedIndices(doc).length) {
        handled()
        selectIndices(doc, [], { keepAnchor: true })
        return
      }
      if (mod && !e.altKey && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
        handled()
        setThumbSize(useOrganize.getState().thumbSize + 30)
        return
      }
      if (mod && !e.altKey && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        handled()
        setThumbSize(useOrganize.getState().thumbSize - 30)
        return
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [doc])

  // Ctrl + wheel resizes thumbnails.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      setThumbSize(useOrganize.getState().thumbSize * Math.exp(-e.deltaY * 0.002))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Forget ids of pages that no longer exist.
  useEffect(() => {
    const st = useOrganize.getState().docs[doc.id]
    if (!st) return
    const alive = st.selected.filter((id) => idToIndex.has(id))
    const focus =
      st.focus !== null && idToIndex.has(st.focus)
        ? st.focus
        : st.focus === null
          ? null
          : (pages[Math.min(doc.state.currentPage, pages.length - 1)]?.id ?? null)
    if (alive.length !== st.selected.length || focus !== st.focus)
      patchOrg(doc.id, { selected: alive, focus })
  }, [doc, idToIndex, pages])

  // ---- rendering ----------------------------------------------------------------------------
  const rowH = m.cellHeight + m.gapY
  const firstRow = Math.max(0, Math.floor((scrollTop - m.padY) / rowH) - OVERSCAN_ROWS)
  const lastRow = Math.min(
    m.rows - 1,
    Math.ceil((scrollTop + viewport.height - m.padY) / rowH) + OVERSCAN_ROWS
  )
  const firstIndex = firstRow * m.columns
  const lastIndex = Math.min(count - 1, (lastRow + 1) * m.columns - 1)
  const center = scrollTop + viewport.height / 2
  const draggingIds = drag ? new Set(drag.ids) : null
  const indicator = drag?.gap ?? fileDrop
  const cells = []
  const gaps = []
  for (let i = firstIndex; i <= lastIndex; i++) {
    const p = pages[i]
    const pos = cellPosition(m, i)
    cells.push(
      <Thumbnail
        key={p.id}
        doc={doc}
        index={i}
        page={p}
        left={pos.left}
        top={pos.top}
        cellWidth={m.cellWidth}
        thumb={thumb}
        selected={selectedSet.has(p.id)}
        focused={focusIndex === i}
        dragging={!!draggingIds?.has(p.id) && !drag?.copy && !drag?.tab}
        priority={Math.abs(pos.top + m.cellHeight / 2 - center) / 10000}
        onQuick={onQuick}
      />
    )
    if (!drag && !marquee) {
      gaps.push(
        <GapButton
          key={`g${i}`}
          doc={doc}
          gap={i}
          left={pos.left - m.gapX / 2}
          top={pos.top}
          height={thumb + 12}
        />
      )
      if (i === count - 1)
        gaps.push(
          <GapButton
            key="g-end"
            doc={doc}
            gap={count}
            left={pos.left + m.cellWidth + m.gapX / 2}
            top={pos.top}
            height={thumb + 12}
          />
        )
    }
  }

  const activeId = focusIndex >= 0 ? `fc-organize-pages-cell-${doc.id}-${pages[focusIndex].id}` : undefined

  return (
    <div className="fc-organize-pages-view" data-doc-id={doc.id}>
      <Toolbar doc={doc} selected={selected} />
      <div
        ref={scrollRef}
        className={`fc-organize-pages-scroll ${drag ? 'is-dragging' : ''} ${marquee ? 'is-marquee' : ''} ${keyboard ? 'is-keyboard' : ''}`}
        tabIndex={0}
        role="listbox"
        aria-multiselectable
        aria-label={`Pages of ${doc.state.title}`}
        aria-activedescendant={activeId}
        onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
        onPointerDown={onPointerDown}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div
          className={`fc-organize-pages-content ${animating ? 'is-animating' : ''}`}
          style={{ height: m.contentHeight }}
        >
          {cells}
          {gaps}
          {indicator && (
            <div
              className={`fc-organize-pages-indicator ${fileDrop ? 'is-file' : ''}`}
              style={{ left: indicator.left - 2, top: indicator.top, height: thumb + 34 }}
            />
          )}
          {marquee && (
            <div
              className="fc-organize-pages-marquee"
              style={{
                left: Math.min(marquee.x0, marquee.x1),
                top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0),
                height: Math.abs(marquee.y1 - marquee.y0)
              }}
            />
          )}
        </div>
      </div>
      <div className="fc-organize-pages-status" aria-live="polite">
        <span>
          {countLabel(count)}
          {selected.length ? ` · ${selected.length} selected (${formatPageRange(selected)})` : ''}
        </span>
        <span className="shell-muted fc-organize-pages-hint">
          {selected.length
            ? `Drag to move · ${isMac ? '⌥' : 'Ctrl'}+drag to copy · Alt+arrows to move`
            : 'Click a page to select it · drop files here to insert them'}
        </span>
        <ThumbSizeControl />
      </div>
      {drag?.tab && (
        <>
          <div
            className="fc-organize-pages-tab-target"
            style={{ left: drag.tab.left, top: drag.tab.top, width: drag.tab.width, height: drag.tab.height }}
          />
          <div className="fc-organize-pages-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
            Copy {countLabel(drag.ids.length)} to the end of {drag.tab.title}
          </div>
        </>
      )}
      {drag && drag.gap && (
        <div className="fc-organize-pages-ghost" style={{ left: drag.x + 14, top: drag.y + 14 }}>
          {drag.copy ? 'Copy' : 'Move'} {countLabel(drag.ids.length)}
          {drag.gap.gap === 0
            ? ' to the start'
            : drag.gap.gap >= count
              ? ' to the end'
              : ` before page ${drag.gap.gap + 1}`}
        </div>
      )}
    </div>
  )
}

function GapButton({
  doc,
  gap,
  left,
  top,
  height
}: {
  doc: DocumentModel
  gap: number
  left: number
  top: number
  height: number
}) {
  return (
    <div className="fc-organize-pages-gap" data-gap style={{ left: left - 12, top, height }}>
      <span className="fc-organize-pages-gap-line" />
      <button
        type="button"
        className="fc-organize-pages-gap-btn"
        tabIndex={-1}
        title={gap === 0 ? 'Insert pages at the beginning' : `Insert pages after page ${gap}`}
        aria-label={gap === 0 ? 'Insert pages at the beginning' : `Insert pages after page ${gap}`}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          showContextMenu(r.left, r.bottom + 4, insertItems(doc, gap))
        }}
      >
        <Plus size={14} />
      </button>
    </div>
  )
}
