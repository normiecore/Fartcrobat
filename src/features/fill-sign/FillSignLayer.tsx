import { useEffect, useRef, useState } from 'react'
import type { Point, Rect } from '@shared/geometry'
import {
  drawResult,
  registry,
  showContextMenu,
  type ContextMenuItem,
  useApp,
  useDocState,
  usePageVersion,
  usePrefs,
  type DocumentModel,
  type PageGeometry,
  type PageLayerProps
} from '@renderer/sdk'
import {
  isMarkKind,
  isTextKind,
  keepsAspect,
  kindLabel,
  lineWidthFor,
  markDimensions,
  markStrokes,
  rectAround,
  SELECTION_TYPE,
  type FillSignItem,
  type MarkKind,
  type TextKind
} from './shared'
import { fsOps, hideItem, selectItem, unhideItem, useFillSign, waitForRepaint } from './state'
import { changeSize, createAt, moveItem, resizeItem, startEditing, TOOL_KIND } from './actions'
import { commitActiveEditor, TextEditor } from './TextEditor'
import { hitBox, itemContextMenu, MiniToolbar } from './MiniToolbar'

const DRAG_THRESHOLD = 3
const MIN_SIZE_PT = 4

interface Gesture {
  type: 'move' | 'resize'
  item: FillSignItem
  pointerId: number
  start: Point
  /** Resize: pointer position minus the item's corner (CSS px), so the corner does not jump. */
  grab: Point
  moved: boolean
  wasSelected: boolean
}


interface Live {
  id: number
  rect: Rect
}

/** Maps `r` (inside `from`) to the corresponding rect inside `to`. */
function mapRect(r: Rect, from: Rect, to: Rect): Rect {
  const sx = (to[2] - to[0]) / Math.max(1e-6, from[2] - from[0])
  const sy = (to[3] - to[1]) / Math.max(1e-6, from[3] - from[1])
  return [to[0] + (r[0] - from[0]) * sx, to[1] + (r[1] - from[1]) * sy, to[0] + (r[2] - from[0]) * sx, to[1] + (r[3] - from[1]) * sy]
}

function clampMove(r: Rect, dx: number, dy: number, w: number, h: number): [number, number] {
  return [Math.max(-r[0], Math.min(w - r[2], dx)), Math.max(-r[1], Math.min(h - r[3], dy))]
}

/** New visual rect while dragging the bottom-right handle to page point `p`. */
function resizedRect(item: FillSignItem, p: Point, pageW: number, pageH: number): Rect {
  const r = item.rect
  const w = r[2] - r[0]
  const h = r[3] - r[1]
  const px = Math.min(pageW, Math.max(r[0] + MIN_SIZE_PT, p[0]))
  const py = Math.min(pageH, Math.max(r[1] + MIN_SIZE_PT, p[1]))
  if (item.kind === 'line') return [r[0], r[1], px, r[3]]
  if (isTextKind(item.kind)) {
    // text grows with its font: the height decides, the width follows
    const f = Math.max(MIN_SIZE_PT / h, (py - r[1]) / h)
    return [r[0], r[1], r[0] + w * f, r[1] + h * f]
  }
  if (keepsAspect(item.kind)) {
    const f = Math.max((px - r[0]) / w, (py - r[1]) / h, MIN_SIZE_PT / Math.min(w, h))
    const fx = Math.min(f, (pageW - r[0]) / w, (pageH - r[1]) / h)
    return [r[0], r[1], r[0] + w * fx, r[1] + h * fx]
  }
  return [r[0], r[1], px, py]
}

/** Live image of an item while it is dragged or resized (rendered by MuPDF, so it looks exact). */
function DragPreview({
  doc,
  geometry,
  item,
  rect,
  onReady
}: {
  doc: DocumentModel
  geometry: PageGeometry
  item: FillSignItem
  rect: Rect
  onReady: () => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const pageColors = usePrefs().pageColors
  useEffect(() => {
    let alive = true
    const scale = geometry.scale * (window.devicePixelRatio || 1)
    fsOps(doc)
      .preview(item.id, scale, item.page)
      .then((r) => {
        if (!alive || !ref.current) return
        drawResult(ref.current, r)
        onReady()
      })
      .catch(() => {})
    return () => {
      alive = false
    }
    // render once per gesture
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, item.id])
  const b = mapRect(item.bounds, item.rect, rect)
  const tl = geometry.toCss([b[0], b[1]])
  return (
    <canvas
      ref={ref}
      className={`fc-fill-sign-preview ${pageColors !== 'document' ? 'is-inverted' : ''}`}
      style={{
        left: tl[0],
        top: tl[1],
        width: (b[2] - b[0]) * geometry.scale,
        height: (b[3] - b[1]) * geometry.scale,
        transform: geometry.rotation ? `rotate(${geometry.rotation}deg)` : undefined
      }}
    />
  )
}

/** Faint preview of the mark that a click would add (Acrobat shows the symbol at the cursor). */
function MarkGhost({ geometry, kind, point }: { geometry: PageGeometry; kind: MarkKind; point: Point }) {
  const size = useFillSign((s) => s.textSize)
  const color = useFillSign((s) => s.color)
  const [w, h] = markDimensions(kind, size)
  const rect = rectAround(point, w, h)
  const c = geometry.rectToCss(rect)
  if (kind === 'dot') {
    return (
      <svg className="fc-fill-sign-ghost" width={geometry.cssWidth} height={geometry.cssHeight}>
        <ellipse cx={c.left + c.width / 2} cy={c.top + c.height / 2} rx={c.width / 2} ry={c.height / 2} fill={color} />
      </svg>
    )
  }
  const lw = lineWidthFor(size)
  const strokes = markStrokes(kind, rect, lw)
  return (
    <svg className="fc-fill-sign-ghost" width={geometry.cssWidth} height={geometry.cssHeight}>
      {strokes.map((s, i) => (
        <polyline
          key={i}
          points={s.map((p) => geometry.toCss(p).join(',')).join(' ')}
          fill="none"
          stroke={color}
          strokeWidth={lw * geometry.scale}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}

/**
 * Page layer (order 45) for Fill & Sign items: select, drag to move, corner handle to resize,
 * double-click (or Enter) to edit text, mini toolbar, context menu. While a Fill & Sign tool is
 * active it also catches clicks on empty space to add text or marks. Other comments are left
 * alone: only items tagged by Fill & Sign get hit areas.
 */
export function FillSignLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const toolId = useApp((s) => s.toolId)
  const createKind: TextKind | MarkKind | undefined = TOOL_KIND[toolId]
  const version = usePageVersion(doc, pageIndex)
  const showAnnots = useDocState(doc, (s) => s.showAnnotations)
  const selection = useDocState(doc, (s) => s.selection)
  const editing = useFillSign((s) => (s.editing && s.editing.docId === doc.id && s.editing.page === pageIndex ? s.editing : null))
  const [items, setItems] = useState<FillSignItem[]>([])
  const [live, setLive] = useState<Live | null>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const gesture = useRef<Gesture | null>(null)
  /** Id of the item whose drag preview may hide the real rendering (cleared when the gesture ends). */
  const previewFor = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    fsOps(doc)
      .list(pageIndex)
      .then((list) => alive && setItems(list))
      .catch((err) => {
        if (!doc.isClosed) console.warn('Fill & Sign: could not list items', err)
      })
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])

  const selectedId =
    selection.kind === 'custom' && selection.type === SELECTION_TYPE && selection.page === pageIndex
      ? (selection.data as { id: number }).id
      : null
  const findItem = (id: number | null | undefined) => (id == null ? undefined : items.find((i) => i.id === id))
  const editingItem = editing ? (findItem(editing.id) ?? editing.item) : null
  const selected = findItem(selectedId) ?? (editing && editing.id === selectedId ? editing.item : undefined)

  // Keyboard focus follows the selection when nothing else has it (e.g. after a menu or the text
  // editor closed), so Delete, the arrow keys and Esc act on the selected item.
  const selectedInList = selectedId != null && items.some((i) => i.id === selectedId)
  useEffect(() => {
    if (!selectedInList || editing) return
    const active = document.activeElement
    if (active && active !== document.body) return
    rootRef.current?.querySelector<HTMLElement>(`[data-fill-sign-id="${selectedId}"]`)?.focus({ preventScroll: true })
  }, [selectedId, selectedInList, editing])

  const local = (e: { clientX: number; clientY: number }): Point => {
    const b = rootRef.current!.getBoundingClientRect()
    return [e.clientX - b.left, e.clientY - b.top]
  }

  // ---- creating ----------------------------------------------------------------------------

  const onRootContextMenu = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    e.preventDefault()
    const point = geometry.toPage(local(e))
    const menu: ContextMenuItem[] = []
    for (const c of registry.pageContextMenu) {
      const more = c.items({ doc, pageIndex, point })
      if (!more.length) continue
      if (menu.length) menu.push({ id: `sep-${c.id}`, label: '', separator: true })
      menu.push(...more)
    }
    showContextMenu(e.clientX, e.clientY, menu)
  }

  const onRootPointerDown = (e: React.PointerEvent) => {
    if (!createKind || e.button !== 0 || e.target !== e.currentTarget) return
    const point = geometry.toPage(local(e))
    e.preventDefault()
    const kind = createKind
    if (!doc.state.showAnnotations) doc.set({ showAnnotations: true })
    void commitActiveEditor().then(() => createAt(doc, pageIndex, point, kind))
  }

  // ---- items -------------------------------------------------------------------------------

  const endPreview = async (id: number) => {
    if (previewFor.current === id) previewFor.current = null
    unhideItem(doc, pageIndex, id)
    await waitForRepaint(doc)
    setLive((l) => (l && l.id === id ? null : l))
  }

  const onItemPointerDown = (e: React.PointerEvent, item: FillSignItem, type: Gesture['type']) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const wasSelected = selectedId === item.id
    if (!wasSelected) selectItem(doc, pageIndex, item.id, item.kind)
    if (editing && editing.id === item.id && type === 'move') return // clicks inside the edited text
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (type === 'move') (e.currentTarget as HTMLElement).focus({ preventScroll: true })
    const start = local(e)
    const corner = geometry.toCss([item.rect[2], item.rect[3]])
    const grab: Point = type === 'resize' ? [start[0] - corner[0], start[1] - corner[1]] : [0, 0]
    gesture.current = { type, item, pointerId: e.pointerId, start, grab, moved: false, wasSelected }
  }

  const onItemPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g || g.pointerId !== e.pointerId) return
    const p = local(e)
    if (!g.moved) {
      if (Math.hypot(p[0] - g.start[0], p[1] - g.start[1]) < DRAG_THRESHOLD || g.item.locked) return
      g.moved = true
      previewFor.current = g.item.id
    }
    if (g.type === 'move') {
      const a = geometry.toPage(g.start)
      const b = geometry.toPage(p)
      const [dx, dy] = clampMove(g.item.rect, b[0] - a[0], b[1] - a[1], geometry.width, geometry.height)
      const r = g.item.rect
      setLive({ id: g.item.id, rect: [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy] })
    } else {
      const to: Point = [p[0] - g.grab[0], p[1] - g.grab[1]]
      setLive({ id: g.item.id, rect: resizedRect(g.item, geometry.toPage(to), geometry.width, geometry.height) })
    }
  }

  const onItemPointerUp = async (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g || g.pointerId !== e.pointerId) return
    gesture.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {}
    if (!g.moved) {
      // a click: with the Add text tool, or on already selected text, start typing
      if (g.type === 'move' && isTextKind(g.item.kind) && (g.wasSelected || createKind === 'text' || createKind === 'date')) {
        await commitActiveEditor()
        startEditing(doc, g.item)
      }
      return
    }
    const p = local(e)
    if (g.type === 'move') {
      const a = geometry.toPage(g.start)
      const b = geometry.toPage(p)
      const [dx, dy] = clampMove(g.item.rect, b[0] - a[0], b[1] - a[1], geometry.width, geometry.height)
      await moveItem(doc, g.item, dx, dy)
    } else {
      const to: Point = [p[0] - g.grab[0], p[1] - g.grab[1]]
      await resizeItem(doc, g.item, resizedRect(g.item, geometry.toPage(to), geometry.width, geometry.height))
    }
    await endPreview(g.item.id)
  }

  const onItemKeyDown = (e: React.KeyboardEvent, item: FillSignItem) => {
    const step = e.shiftKey ? 10 : 1
    let dx = 0
    let dy = 0
    if (e.key === 'ArrowLeft') dx = -step
    else if (e.key === 'ArrowRight') dx = step
    else if (e.key === 'ArrowUp') dy = -step
    else if (e.key === 'ArrowDown') dy = step
    if (dx || dy) {
      e.preventDefault()
      e.stopPropagation()
      if (item.locked) return
      // arrows are in screen directions: convert through the view rotation
      const o = geometry.toPage([0, 0])
      const t = geometry.toPage([dx * geometry.scale, dy * geometry.scale])
      const [cx, cy] = clampMove(item.rect, t[0] - o[0], t[1] - o[1], geometry.width, geometry.height)
      void moveItem(doc, item, cx, cy)
      return
    }
    if (e.key === 'Escape') {
      // first Esc deselects the item (a second one leaves the tool, as everywhere else)
      e.preventDefault()
      e.stopPropagation()
      doc.clearSelection()
      doc.view?.getViewportElement()?.focus({ preventScroll: true })
      return
    }
    if ((e.key === 'Enter' || e.key === 'F2') && isTextKind(item.kind)) {
      e.preventDefault()
      e.stopPropagation()
      startEditing(doc, item)
    } else if ((e.key === '+' || e.key === '=') && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      void changeSize(doc, item, 1)
    } else if (e.key === '-' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      e.stopPropagation()
      void changeSize(doc, item, -1)
    }
  }

  const liveItem = live ? findItem(live.id) : undefined
  const creating = !!createKind
  const tracksHover = !!createKind && isMarkKind(createKind)
  const markHover = tracksHover && hover ? (createKind as MarkKind) : null

  return (
    <div
      ref={rootRef}
      className={`viewer-layer fc-fill-sign-layer ${creating ? `is-creating is-${createKind}` : ''}`}
      onPointerDown={onRootPointerDown}
      onContextMenu={creating ? onRootContextMenu : undefined}
      onPointerMove={tracksHover ? (e) => setHover(e.target === e.currentTarget ? geometry.toPage(local(e)) : null) : undefined}
      onPointerLeave={tracksHover ? () => setHover(null) : undefined}
    >
      {showAnnots &&
        items.map((item) => {
          const box = hitBox(geometry, live && live.id === item.id ? live.rect : item.rect)
          const isSel = selectedId === item.id
          const isEditing = editing?.id === item.id
          return (
            <div
              key={item.id}
              className={`fc-fill-sign-item is-${item.kind} ${isSel ? 'is-selected' : ''} ${isEditing ? 'is-editing' : ''} ${item.locked ? 'is-locked' : ''}`}
              style={box}
              tabIndex={0}
              role="button"
              aria-label={`${kindLabel(item.kind)}${item.text ? `: ${item.text}` : ''}`}
              aria-pressed={isSel}
              data-fill-sign-id={item.id}
              onPointerDown={(e) => onItemPointerDown(e, item, 'move')}
              onPointerMove={onItemPointerMove}
              onPointerUp={(e) => void onItemPointerUp(e)}
              onPointerCancel={() => {
                gesture.current = null
                previewFor.current = null
                setLive(null)
                unhideItem(doc, pageIndex, item.id)
              }}
              onDoubleClick={(e) => {
                e.stopPropagation()
                if (isTextKind(item.kind) && !isEditing) startEditing(doc, item)
              }}
              onFocus={() => {
                if (selectedId !== item.id) selectItem(doc, pageIndex, item.id, item.kind)
              }}
              onKeyDown={(e) => onItemKeyDown(e, item)}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                selectItem(doc, pageIndex, item.id, item.kind)
                showContextMenu(e.clientX, e.clientY, itemContextMenu(doc, item))
              }}
            />
          )
        })}
      {live && liveItem && (
        <DragPreview
          doc={doc}
          geometry={geometry}
          item={liveItem}
          rect={live.rect}
          onReady={() => {
            if (previewFor.current === liveItem.id) hideItem(doc, pageIndex, liveItem.id)
          }}
        />
      )}
      {selected && showAnnots && !editingItem && (
        <SelectionFrame
          geometry={geometry}
          item={selected}
          rect={live && live.id === selected.id ? live.rect : selected.rect}
          dragging={!!live}
          onHandleDown={(e) => onItemPointerDown(e, selected, 'resize')}
          onHandleMove={onItemPointerMove}
          onHandleUp={(e) => void onItemPointerUp(e)}
        />
      )}
      {editingItem && <TextEditor key={editingItem.id} doc={doc} geometry={geometry} item={editingItem} />}
      {selected && showAnnots && !live && <MiniToolbar doc={doc} geometry={geometry} item={editingItem && editingItem.id === selected.id ? editingItem : selected} />}
      {markHover && hover && <MarkGhost geometry={geometry} kind={markHover} point={hover} />}
    </div>
  )
}

function SelectionFrame({
  geometry,
  item,
  rect,
  dragging,
  onHandleDown,
  onHandleMove,
  onHandleUp
}: {
  geometry: PageGeometry
  item: FillSignItem
  rect: Rect
  dragging: boolean
  onHandleDown: (e: React.PointerEvent) => void
  onHandleMove: (e: React.PointerEvent) => void
  onHandleUp: (e: React.PointerEvent) => void
}) {
  const c = hitBox(geometry, rect)
  const pad = 3
  // The handle drags the item's bottom-right corner (in page space): put it on the frame corner
  // on that side, wherever the view rotation turned it.
  const corner = geometry.toCss([rect[2], rect[3]])
  const cx = c.left + c.width / 2
  const cy = c.top + c.height / 2
  const hx = cx + Math.sign(corner[0] - cx || 1) * (c.width / 2 + pad)
  const hy = cy + Math.sign(corner[1] - cy || 1) * (c.height / 2 + pad)
  const horizontal = item.kind === 'line' && geometry.rotation % 180 === 0
  const vertical = item.kind === 'line' && geometry.rotation % 180 !== 0
  return (
    <>
      <div
        className={`fc-fill-sign-frame ${dragging ? 'is-dragging' : ''}`}
        style={{ left: c.left - pad, top: c.top - pad, width: c.width + pad * 2, height: c.height + pad * 2 }}
      />
      {!item.locked && (
        <div
          className={`fc-fill-sign-handle ${horizontal ? 'is-horizontal' : ''} ${vertical ? 'is-vertical' : ''}`}
          style={{ left: hx, top: hy }}
          role="presentation"
          title={item.kind === 'line' ? 'Drag to make longer or shorter' : 'Drag to resize'}
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
        />
      )}
    </>
  )
}
