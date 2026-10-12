import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Files, ScanSearch, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react'
import type { Point, Rect } from '@shared/geometry'
import { rectFromPoints } from '@shared/geometry'
import {
  Button,
  caretAt,
  getLoadedText,
  isOverText,
  loadText,
  rangeRects,
  registry,
  showContextMenu,
  usePageVersion,
  wordAt,
  type ContextMenuItem,
  type DocumentModel,
  type PageLayerProps,
  type PageText,
  type TextRange
} from '@renderer/sdk'
import type { MarkInfo } from './shared'
import { deleteMarks, markArea, markRanges, openRedactPanel } from './actions'
import { applyRedactions, openPageRangeDialog } from './dialogs'
import { openMarkPropertiesDialog, openPropertiesDialog } from './PropertiesForm'
import { selectMarks, selectedMarkIds, useMarks, useRedactUi } from './store'
import { markAreas } from './geometry'

/** Live preview of a drag in progress (shared by every page's layer, so text drags can cross pages). */
interface DragPreview {
  docId: string | null
  ranges: TextRange[]
  area: { page: number; rect: Rect } | null
}

const useDragPreview = create<DragPreview>(() => ({ docId: null, ranges: [], area: null }))

interface Caret {
  page: number
  index: number
}

interface DragState {
  doc: DocumentModel
  page: number
  mode: 'text' | 'area'
  startClient: Point
  startPoint: Point
  anchor: Caret | null
  focus: Caret | null
  moved: boolean
  hit: MarkInfo | null
  shift: boolean
}

let drag: DragState | null = null

function rangesBetween(doc: DocumentModel, a: Caret, b: Caret): TextRange[] {
  const [s, e] = a.page < b.page || (a.page === b.page && a.index <= b.index) ? [a, b] : [b, a]
  if (s.page === e.page) return s.index === e.index ? [] : [{ page: s.page, start: s.index, end: e.index }]
  // pages whose text is not loaded yet: take everything (clamped when marking)
  const len = (p: number) => getLoadedText(doc, p)?.text.length ?? 1e9
  const out: TextRange[] = [{ page: s.page, start: s.index, end: len(s.page) }]
  for (let p = s.page + 1; p < e.page; p++) out.push({ page: p, start: 0, end: len(p) })
  out.push({ page: e.page, start: 0, end: e.index })
  return out.filter((r) => r.end > r.start)
}

/** The topmost mark under a point (page space). */
export function markAt(marks: MarkInfo[], page: number, p: Point, pad = 1.5): MarkInfo | null {
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i]
    if (m.page !== page) continue
    for (const r of markAreas(m)) {
      if (p[0] >= r[0] - pad && p[0] <= r[2] + pad && p[1] >= r[1] - pad && p[1] <= r[3] + pad) return m
    }
  }
  return null
}

function markMenu(doc: DocumentModel, mark: MarkInfo): ContextMenuItem[] {
  const ids = selectedMarkIds(doc).includes(mark.id) ? selectedMarkIds(doc) : [mark.id]
  const n = ids.length
  return [
    { id: 'redact-apply-mark', label: n > 1 ? `Apply ${n} Redactions…` : 'Apply Redaction…', icon: ShieldCheck, run: () => void applyRedactions(doc, ids) },
    { id: 'redact-mark-props', label: 'Properties…', icon: SlidersHorizontal, run: () => void openMarkPropertiesDialog(doc, ids) },
    { id: 'redact-delete-mark', label: n > 1 ? `Delete ${n} Marks` : 'Delete Mark', icon: Trash2, shortcut: 'Del', danger: true, run: () => void deleteMarks(doc, ids) }
  ]
}

/** Context menu entries for a mark under the pointer (also used by the select tool's menu). */
export function contextItemsAt(doc: DocumentModel, marks: MarkInfo[], page: number, p: Point): ContextMenuItem[] {
  const m = markAt(marks, page, p)
  return m ? markMenu(doc, m) : []
}

/** Pointer layer of the "Redact text & images" tool. */
export function MarkLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const marks = useMarks(doc)
  const version = usePageVersion(doc, pageIndex)
  const [text, setText] = useState<PageText | null>(() => getLoadedText(doc, pageIndex))
  const [cursor, setCursor] = useState('crosshair')
  const preview = useDragPreview()

  useEffect(() => {
    let alive = true
    void loadText(doc, pageIndex).then((t) => alive && setText(t))
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drag?.doc === doc) {
        drag = null
        useDragPreview.setState({ docId: null, ranges: [], area: null })
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [doc])

  const pagePoint = (e: { clientX: number; clientY: number }): Point => geometry.eventToPage(e, ref.current!)
  const clampToPage = (p: Point): Point => [Math.max(0, Math.min(geometry.width, p[0])), Math.max(0, Math.min(geometry.height, p[1]))]

  const setHover = (id: number | null) => {
    const cur = useRedactUi.getState().hover
    if (id === null ? cur === null : cur?.docId === doc.id && cur.id === id) return
    useRedactUi.setState({ hover: id === null ? null : { docId: doc.id, id } })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const p = pagePoint(e)
    const t = getLoadedText(doc, pageIndex) ?? text
    const hit = markAt(marks, pageIndex, p)
    const forceArea = e.ctrlKey || e.altKey || e.metaKey
    const textMode = !!t && !forceArea && isOverText(t, p)
    drag = {
      doc,
      page: pageIndex,
      mode: textMode ? 'text' : 'area',
      startClient: [e.clientX, e.clientY],
      startPoint: clampToPage(p),
      anchor: textMode && t ? { page: pageIndex, index: Math.max(0, caretAt(t, p)) } : null,
      focus: null,
      moved: false,
      hit,
      shift: e.shiftKey
    }
    ref.current?.setPointerCapture(e.pointerId)
    doc.view?.getViewportElement()?.focus({ preventScroll: true })
    e.preventDefault()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag
    if (!d || d.doc !== doc) {
      const p = pagePoint(e)
      const hit = markAt(marks, pageIndex, p)
      setHover(hit?.id ?? null)
      const t = getLoadedText(doc, pageIndex)
      const next = hit ? 'pointer' : t && isOverText(t, p) && !e.ctrlKey && !e.altKey ? 'text' : 'crosshair'
      if (next !== cursor) setCursor(next)
      return
    }
    if (d.page !== pageIndex) return
    if (!d.moved && Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]) < 4) return
    d.moved = true
    setHover(null)
    if (d.mode === 'area') {
      const q = clampToPage(pagePoint(e))
      useDragPreview.setState({ docId: doc.id, ranges: [], area: { page: pageIndex, rect: rectFromPoints(d.startPoint, q) } })
    } else if (d.anchor) {
      const hit = doc.view?.hitTest(e.clientX, e.clientY)
      if (hit) {
        const t = getLoadedText(doc, hit.pageIndex)
        if (!t) void loadText(doc, hit.pageIndex)
        else {
          d.focus = { page: hit.pageIndex, index: Math.max(0, caretAt(t, hit.point)) }
          useDragPreview.setState({ docId: doc.id, ranges: rangesBetween(doc, d.anchor, d.focus), area: null })
        }
      }
    }
    // scroll when dragging near the edges of the viewer
    const vp = doc.view?.getViewportElement()
    if (vp) {
      const b = vp.getBoundingClientRect()
      if (e.clientY < b.top + 24) doc.view?.scrollBy(0, -24)
      else if (e.clientY > b.bottom - 24) doc.view?.scrollBy(0, 24)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag
    drag = null
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    const pv = useDragPreview.getState()
    useDragPreview.setState({ docId: null, ranges: [], area: null })
    if (!d || d.doc !== doc) return
    if (!d.moved) {
      if (d.hit) {
        const cur = selectedMarkIds(doc)
        const ids = d.shift ? (cur.includes(d.hit.id) ? cur.filter((id) => id !== d.hit!.id) : [...cur, d.hit.id]) : [d.hit.id]
        selectMarks(doc, d.hit.page, ids)
      } else if (selectedMarkIds(doc).length) doc.clearSelection()
      return
    }
    if (d.mode === 'area' && pv.area) {
      const r = pv.area.rect
      if (r[2] - r[0] >= 3 && r[3] - r[1] >= 3) void markArea(doc, pv.area.page, r)
    } else if (d.mode === 'text' && pv.ranges.length) {
      void markRanges(doc, pv.ranges)
    }
  }

  /** Double-click marks the word under the pointer (or opens the properties of a mark). */
  const onDoubleClick = (e: React.MouseEvent) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const p = pagePoint(e)
    const hit = markAt(marks, pageIndex, p)
    if (hit) {
      void openMarkPropertiesDialog(doc, [hit.id])
      return
    }
    const t = getLoadedText(doc, pageIndex) ?? text
    if (!t || !isOverText(t, p)) return
    const idx = caretAt(t, p)
    if (idx < 0) return
    const w = wordAt(t, Math.min(idx, t.text.length - 1))
    if (w && t.text.slice(w.start, w.end).trim()) void markRanges(doc, [{ page: pageIndex, start: w.start, end: w.end }])
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const p = pagePoint(e)
    const hit = markAt(marks, pageIndex, p)
    let items: ContextMenuItem[]
    if (hit) {
      if (!selectedMarkIds(doc).includes(hit.id)) selectMarks(doc, pageIndex, [hit.id])
      items = markMenu(doc, hit)
    } else {
      items = [
        { id: 'redact-find', label: 'Find Text & Redact…', icon: ScanSearch, run: () => openRedactPanel('find') },
        { id: 'redact-pages', label: 'Mark Page Range…', icon: Files, run: () => void openPageRangeDialog(doc) },
        { id: 'redact-props', label: 'Redaction Properties…', icon: SlidersHorizontal, run: () => void openPropertiesDialog(doc) },
        { id: 'redact-apply-all', label: 'Apply All Redactions…', icon: ShieldCheck, disabled: marks.length === 0, run: () => void applyRedactions(doc) }
      ]
    }
    for (const c of registry.pageContextMenu) {
      if (c.id === 'redact') continue
      const more = c.items({ doc, pageIndex, point: p })
      if (more.length) items.push({ id: `sep-${c.id}`, label: '', separator: true }, ...more)
    }
    showContextMenu(e.clientX, e.clientY, items)
  }

  const showPreview = preview.docId === doc.id
  const rects: Rect[] = []
  if (showPreview) {
    for (const r of preview.ranges) {
      if (r.page !== pageIndex) continue
      const t = getLoadedText(doc, pageIndex) ?? text
      if (t) rects.push(...rangeRects(t, r.start, Math.min(r.end, t.text.length)))
    }
  }
  const area = showPreview && preview.area?.page === pageIndex ? preview.area.rect : null

  return (
    <div
      ref={ref}
      className="viewer-layer fc-redact-tool-layer"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => !drag && setHover(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      data-testid={`redact-layer-${pageIndex}`}
    >
      {rects.map((r, i) => {
        const c = geometry.rectToCss(r)
        return <div key={i} className="fc-redact-drag-text" style={{ left: c.left, top: c.top, width: c.width, height: c.height }} />
      })}
      {area &&
        (() => {
          const c = geometry.rectToCss(area)
          return <div className="fc-redact-drag-area" style={{ left: c.left, top: c.top, width: c.width, height: c.height }} />
        })()}
    </div>
  )
}

/** Contextual bar shown under the document toolbar while the tool is active. */
export function MarkToolbar({ doc }: { doc: DocumentModel }) {
  const marks = useMarks(doc)
  return (
    <div className="fc-redact-toolbar" role="toolbar" aria-label="Redact text and images">
      <span className="fc-redact-toolbar-hint">Drag across text or draw a box. Double-click a word to mark it.</span>
      <span className="fc-redact-toolbar-spacer" />
      <Button size="sm" variant="quiet" icon={Files} onClick={() => void openPageRangeDialog(doc)}>
        Mark page range
      </Button>
      <Button size="sm" variant="quiet" icon={SlidersHorizontal} onClick={() => void openPropertiesDialog(doc)}>
        Properties
      </Button>
      <Button size="sm" variant="danger" icon={ShieldCheck} disabled={!marks.length} onClick={() => void applyRedactions(doc)}>
        {marks.length ? `Apply (${marks.length})` : 'Apply'}
      </Button>
    </div>
  )
}
