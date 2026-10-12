import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { FileOutput, FilePlus2, RotateCcw, RotateCw, Trash2 } from 'lucide-react'
import type { PageInfo } from '@shared/types'
import {
  basename,
  drawResult,
  IconButton,
  PDF_FILTER,
  renderQueueFor,
  saveBytesAs,
  showContextMenu,
  showError,
  Slider,
  stripExtension,
  toast,
  useApp,
  useDocState,
  usePageVersion,
  type ContextMenuItem,
  type DocumentModel
} from '@renderer/sdk'
import { pageOps, undoToast } from './actions'
import { loadNavSettings, setThumbSize, useNavSettings, type ThumbSize } from './state'
import { describePages, dropIndexAt, pagesFileSuffix, thumbLayout, visibleRange, type ThumbLayout } from './util'

/** Thumbnail widths in CSS px for small / medium / large. */
export const THUMB_WIDTHS = [92, 140, 210]
const SIZE_LABELS = ['Small', 'Medium', 'Large']

const ThumbCanvas = memo(function ThumbCanvas({
  doc,
  index,
  page,
  width,
  height
}: {
  doc: DocumentModel
  index: number
  page: PageInfo
  width: number
  height: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const version = usePageVersion(doc, index)
  const colorMode = useApp((s) => s.prefs.pageColors)
  const annots = useDocState(doc, (s) => s.showAnnotations)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const dpr = window.devicePixelRatio || 1
    const scale = (width * dpr) / Math.max(1, page.width)
    const key = `fc-navigation-thumb:${page.id}:${version}:${scale.toFixed(4)}:${colorMode}:${annots}`
    const req = renderQueueFor(doc).request(key, index, { scale, colorMode, annots }, 50 + index / 100000)
    let alive = true
    void req.promise.then((r) => {
      if (!alive || !r || !ref.current) return
      drawResult(ref.current, r)
      setReady(true)
    })
    return () => {
      alive = false
      req.cancel()
    }
  }, [doc, index, page.id, page.width, version, width, colorMode, annots])
  return (
    <canvas
      ref={ref}
      className={`fc-navigation-thumb-canvas ${ready ? 'is-ready' : ''}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  )
})

interface DragState {
  /** Page ids being dragged. */
  ids: number[]
  /** Insertion point 0..pageCount. */
  drop: number
  x: number
  y: number
}

export function ThumbnailsPanel({ doc }: { doc: DocumentModel }) {
  const info = useDocState(doc, (s) => s.info)
  const current = useDocState(doc, (s) => s.currentPage)
  const title = useDocState(doc, (s) => s.title)
  const size = useNavSettings((s) => s.thumbSize)
  const width = THUMB_WIDTHS[size]
  const layout: ThumbLayout = useMemo(() => thumbLayout(info.pages, width), [info.pages, width])
  const scrollRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 600 })
  const [selectedIds, setSelectedIds] = useState<number[]>(() => [info.pages[current]?.id].filter((v) => v !== undefined))
  const [active, setActive] = useState(current)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const anchorRef = useRef<number>(current)
  const suppressClick = useRef(false)
  const n = info.pageCount

  useEffect(() => {
    void loadNavSettings()
  }, [])

  // Selection is kept as page ids so it survives reordering; drop ids of deleted pages.
  const idToIndex = useMemo(() => new Map(info.pages.map((p, i) => [p.id, i])), [info.pages])
  const selected = useMemo(
    () =>
      selectedIds
        .map((id) => idToIndex.get(id))
        .filter((i): i is number => i !== undefined)
        .sort((a, b) => a - b),
    [selectedIds, idToIndex]
  )
  const selectedSet = useMemo(() => new Set(selected), [selected])

  // A single selection follows the current page (like Acrobat); a multi-selection stays put.
  useEffect(() => {
    setSelectedIds((ids) => (ids.length <= 1 && info.pages[current] ? [info.pages[current].id] : ids))
    setActive(current)
    anchorRef.current = current
  }, [current, info.pages])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setView({ top: el.scrollTop, height: el.clientHeight }))
    ro.observe(el)
    setView({ top: el.scrollTop, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Keep the current page's thumbnail in view.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || dragRef.current || current >= layout.tops.length) return
    const top = layout.tops[current]
    const h = layout.heights[current]
    if (top < el.scrollTop || top + h > el.scrollTop + el.clientHeight) {
      el.scrollTop = Math.max(0, top - Math.max(8, (el.clientHeight - h) / 2))
      setView({ top: el.scrollTop, height: el.clientHeight })
    }
  }, [current, layout])

  const targets = useCallback((): number[] => (selected.length ? selected : [current]), [selected, current])

  // ---- page operations -------------------------------------------------------------------------

  const rotate = async (indices: number[], degrees: number) => {
    try {
      await pageOps(doc).rotate(indices, degrees)
    } catch (err) {
      showError(err, 'Could not rotate')
    }
  }

  const remove = async (indices: number[]) => {
    if (indices.length >= n) {
      toast('A document must keep at least one page.', { kind: 'warning' })
      return
    }
    try {
      await pageOps(doc).delete(indices)
      undoToast(doc, `Deleted ${describePages(indices)}`)
    } catch (err) {
      showError(err, 'Could not delete')
    }
  }

  const insertAfter = async (index: number) => {
    try {
      await pageOps(doc).insertBlank(index + 1)
      const id = doc.state.info.pages[index + 1]?.id
      if (id !== undefined) setSelectedIds([id])
      doc.view?.goToPage(index + 1)
    } catch (err) {
      showError(err, 'Could not insert a page')
    }
  }

  const extract = async (indices: number[]) => {
    try {
      const bytes = await pageOps(doc).extract(indices)
      const path = await saveBytesAs(
        bytes,
        `${stripExtension(title)} (${pagesFileSuffix(indices)}).pdf`,
        [PDF_FILTER],
        'Extract Pages'
      )
      if (path) toast(`Saved ${basename(path)}`, { kind: 'success' })
    } catch (err) {
      showError(err, 'Could not extract')
    }
  }

  const menuFor = (indices: number[]): ContextMenuItem[] => {
    const what = indices.length > 1 ? 'Pages' : 'Page'
    return [
      { id: 'insert', label: 'Insert Blank Page After', icon: FilePlus2, run: () => void insertAfter(indices[indices.length - 1]) },
      { id: 'sep1', label: '', separator: true },
      { id: 'rotate-cw', label: `Rotate ${what} Clockwise`, icon: RotateCw, run: () => void rotate(indices, 90) },
      { id: 'rotate-ccw', label: `Rotate ${what} Counterclockwise`, icon: RotateCcw, run: () => void rotate(indices, -90) },
      { id: 'sep2', label: '', separator: true },
      { id: 'extract', label: `Extract ${what}…`, icon: FileOutput, run: () => void extract(indices) },
      {
        id: 'delete',
        label: `Delete ${what}`,
        icon: Trash2,
        danger: true,
        shortcut: 'Del',
        disabled: indices.length >= n,
        run: () => void remove(indices)
      }
    ]
  }

  // ---- selection & keyboard -----------------------------------------------------------------------

  const selectIndex = (i: number, opts: { toggle?: boolean; range?: boolean; navigate?: boolean } = {}) => {
    const idx = Math.max(0, Math.min(n - 1, i))
    const id = info.pages[idx].id
    if (opts.range) {
      const a = Math.min(anchorRef.current, idx)
      const b = Math.max(anchorRef.current, idx)
      setSelectedIds(info.pages.slice(a, b + 1).map((p) => p.id))
    } else if (opts.toggle) {
      setSelectedIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))
      anchorRef.current = idx
    } else {
      setSelectedIds([id])
      anchorRef.current = idx
    }
    setActive(idx)
    if (opts.navigate !== false && !opts.toggle && !opts.range) doc.view?.goToPage(idx)
    else scrollIntoView(idx)
  }

  const scrollIntoView = (idx: number) => {
    const el = scrollRef.current
    if (!el) return
    const top = layout.tops[idx]
    const h = layout.heights[idx]
    if (top < el.scrollTop) el.scrollTop = top - 6
    else if (top + h > el.scrollTop + el.clientHeight) el.scrollTop = top + h - el.clientHeight + 6
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey
    const step = (d: number) => {
      e.preventDefault()
      selectIndex(active + d, { range: e.shiftKey })
    }
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        return step(1)
      case 'ArrowUp':
      case 'ArrowLeft':
        return step(-1)
      case 'PageDown':
        return step(5)
      case 'PageUp':
        return step(-5)
      case 'Home':
        e.preventDefault()
        return selectIndex(0, { range: e.shiftKey })
      case 'End':
        e.preventDefault()
        return selectIndex(n - 1, { range: e.shiftKey })
      case 'Enter':
      case ' ':
        e.preventDefault()
        doc.view?.goToPage(active)
        return
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        e.stopPropagation()
        void remove(targets())
        return
      case 'ContextMenu':
      case 'F10':
        if (e.key === 'F10' && !e.shiftKey) return
        e.preventDefault()
        openMenuAt(active)
        return
      case 'a':
      case 'A':
        if (mod) {
          e.preventDefault()
          e.stopPropagation()
          setSelectedIds(info.pages.map((p) => p.id))
        }
        return
    }
  }

  const openMenuAt = (idx: number, x?: number, y?: number) => {
    const indices = selectedSet.has(idx) ? selected : [idx]
    if (!selectedSet.has(idx)) {
      setSelectedIds([info.pages[idx].id])
      anchorRef.current = idx
      setActive(idx)
    }
    const el = scrollRef.current
    const r = el?.getBoundingClientRect()
    const px = x ?? (r ? r.left + 40 : 100)
    const py = y ?? (r ? r.top + layout.tops[idx] - (el?.scrollTop ?? 0) + 40 : 100)
    showContextMenu(px, py, menuFor(indices))
  }

  // ---- drag to reorder ----------------------------------------------------------------------------

  const startPointer = (e: React.PointerEvent, idx: number) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    let last = { x: startX, y: startY }
    const dropAt = (clientY: number) => {
      const r = el.getBoundingClientRect()
      return dropIndexAt(layout, clientY - r.top + el.scrollTop)
    }
    const tick = () => {
      const d = dragRef.current
      if (!d) return
      const r = el.getBoundingClientRect()
      const edge = 36
      let dy = 0
      if (last.y < r.top + edge) dy = -Math.ceil((r.top + edge - last.y) / 3)
      else if (last.y > r.bottom - edge) dy = Math.ceil((last.y - (r.bottom - edge)) / 3)
      if (dy) {
        el.scrollTop += dy
        const next = { ...d, drop: dropAt(last.y) }
        dragRef.current = next
        setDrag(next)
      }
      raf = requestAnimationFrame(tick)
    }
    const move = (ev: PointerEvent) => {
      last = { x: ev.clientX, y: ev.clientY }
      if (!dragRef.current) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return
        const indices = selectedSet.has(idx) ? selected : [idx]
        const ids = indices.map((i) => info.pages[i].id)
        if (!selectedSet.has(idx)) setSelectedIds(ids)
        dragRef.current = { ids, drop: dropAt(ev.clientY), x: ev.clientX, y: ev.clientY }
        raf = requestAnimationFrame(tick)
      }
      const next = { ...dragRef.current, drop: dropAt(ev.clientY), x: ev.clientX, y: ev.clientY }
      dragRef.current = next
      setDrag(next)
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', esc, true)
      cancelAnimationFrame(raf)
      const d = dragRef.current
      dragRef.current = null
      setDrag(null)
      if (!d) return
      suppressClick.current = true
      setTimeout(() => (suppressClick.current = false), 0)
      if (!commit) return
      const indices = d.ids
        .map((id) => idToIndex.get(id))
        .filter((i): i is number => i !== undefined)
        .sort((a, b) => a - b)
      const contiguousNoop =
        indices.every((v, i) => i === 0 || v === indices[i - 1] + 1) && d.drop >= indices[0] && d.drop <= indices[indices.length - 1] + 1
      if (!indices.length || contiguousNoop) return
      void pageOps(doc)
        .move(indices, d.drop)
        .catch((err) => showError(err, 'Could not move pages'))
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && dragRef.current) {
        ev.preventDefault()
        ev.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', esc, true)
  }

  const [first, last] = visibleRange(layout, view.top, view.height)
  const items: number[] = []
  for (let i = first; i <= last; i++) items.push(i)
  const ops = targets()
  const dropY = drag ? (drag.drop < n ? layout.tops[drag.drop] : layout.total) - 4 : 0

  return (
    <div className="fc-navigation-panel fc-navigation-thumbs">
      <div className="fc-navigation-toolbar" role="toolbar" aria-label="Page thumbnail actions">
        <IconButton icon={FilePlus2} label="Insert blank page after" onClick={() => void insertAfter(ops[ops.length - 1])} />
        <IconButton icon={RotateCcw} label="Rotate counterclockwise" onClick={() => void rotate(ops, -90)} />
        <IconButton icon={RotateCw} label="Rotate clockwise" onClick={() => void rotate(ops, 90)} />
        <IconButton icon={FileOutput} label="Extract pages…" onClick={() => void extract(ops)} />
        <IconButton icon={Trash2} label="Delete pages" disabled={ops.length >= n} onClick={() => void remove(ops)} />
        <span className="fc-navigation-toolbar-note" aria-live="polite">
          {selected.length > 1 ? `${selected.length} selected` : ''}
        </span>
      </div>
      <div
        ref={scrollRef}
        className={`fc-navigation-thumbs-scroll ${drag ? 'is-dragging' : ''}`}
        role="listbox"
        aria-label="Page thumbnails"
        aria-multiselectable="true"
        aria-activedescendant={`fc-navigation-thumb-${doc.id}-${active}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onScroll={(e) => setView({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
      >
        <div className="fc-navigation-thumbs-content" style={{ height: layout.total }}>
          {items.map((i) => {
            const p = info.pages[i]
            const isSel = selectedSet.has(i)
            const dragging = drag?.ids.includes(p.id)
            return (
              <div
                key={p.id}
                id={`fc-navigation-thumb-${doc.id}-${i}`}
                role="option"
                aria-selected={isSel}
                aria-label={`Page ${p.label}${p.label !== String(i + 1) ? ` (${i + 1})` : ''}`}
                data-page-index={i}
                className={`fc-navigation-thumb ${isSel ? 'is-selected' : ''} ${i === current ? 'is-current' : ''} ${
                  i === active ? 'is-active' : ''
                } ${dragging ? 'is-dragged' : ''}`}
                style={{ top: layout.tops[i], height: layout.heights[i] }}
                title={`Page ${i + 1}${p.label !== String(i + 1) ? ` (${p.label})` : ''}`}
                onPointerDown={(e) => startPointer(e, i)}
                onClick={(e) => {
                  if (suppressClick.current) return
                  scrollRef.current?.focus({ preventScroll: true })
                  selectIndex(i, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey })
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  openMenuAt(i, e.clientX, e.clientY)
                }}
              >
                <div className="fc-navigation-thumb-frame" style={{ width, height: layout.imageHeights[i] }}>
                  <ThumbCanvas doc={doc} index={i} page={p} width={width} height={layout.imageHeights[i]} />
                </div>
                <div className="fc-navigation-thumb-label">{p.label}</div>
              </div>
            )
          })}
          {drag && <div className="fc-navigation-drop-line" style={{ top: dropY }} aria-hidden="true" />}
        </div>
      </div>
      {drag && (
        <div className="fc-navigation-drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 }} aria-hidden="true">
          {drag.ids.length > 1 ? `${drag.ids.length} pages` : `Page ${(idToIndex.get(drag.ids[0]) ?? 0) + 1}`}
        </div>
      )}
      <label className="fc-navigation-footer">
        <span className="fc-navigation-footer-label">Thumbnail size</span>
        <Slider
          value={size}
          min={0}
          max={2}
          step={1}
          format={(v) => SIZE_LABELS[v] ?? ''}
          onChange={(v) => setThumbSize(Math.round(v) as ThumbSize)}
        />
      </label>
    </div>
  )
}
