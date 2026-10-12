/**
 * Page layer 'annotations': makes every comment on the page selectable and editable.
 * Invisible hit areas (quads for text markup, strokes for ink and lines, rects for the rest),
 * hover outline, selection box with resize handles, drag to move with a live preview.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { AnnotInfo } from '@engine/ops/annots'
import type { RenderResult } from '@engine/ops/render'
import type { Point, Rect } from '@shared/geometry'
import { normalizeRect } from '@shared/geometry'
import {
  setHiddenAnnotations,
  showContextMenu,
  showError,
  useDocState,
  usePageVersion,
  type PageGeometry,
  type PageLayerProps
} from '@renderer/sdk'
import { commentMenu } from './actions'
import { canMove, groupIds, isPageComment, resizeMode } from './model'
import { annotsOf, commentsOf, openPopup, startInlineEdit, useCommentPrefs, useCommentsUi } from './state'

type Preview = RenderResult & { bounds: Rect }

interface Drag {
  kind: 'move' | 'resize' | 'endpoint'
  ids: number[]
  origin: Record<number, Rect>
  handle: number
  startClient: Point
  start: Point
  active: boolean
  committed: boolean
  delta: Point
  rect: Rect | null
  line: [Point, Point] | null
}

/** Resize handles in page-space fractions of the rect: corners and edge midpoints. */
const HANDLES: [number, number][] = [
  [0, 0],
  [0.5, 0],
  [1, 0],
  [1, 0.5],
  [1, 1],
  [0.5, 1],
  [0, 1],
  [0, 0.5]
]

const MIN_SIZE = 4

/** CSS box for page-oriented content (rotated with the view). */
export function rotatedBox(geometry: PageGeometry, r: Rect): CSSProperties {
  const c = geometry.toCss([(r[0] + r[2]) / 2, (r[1] + r[3]) / 2])
  const w = (r[2] - r[0]) * geometry.scale
  const h = (r[3] - r[1]) * geometry.scale
  return {
    left: c[0] - w / 2,
    top: c[1] - h / 2,
    width: w,
    height: h,
    transform: geometry.rotation ? `rotate(${geometry.rotation}deg)` : undefined
  }
}

function mapRect(r: Rect, from: Rect, to: Rect): Rect {
  const sx = (to[2] - to[0]) / Math.max(1e-6, from[2] - from[0])
  const sy = (to[3] - to[1]) / Math.max(1e-6, from[3] - from[1])
  return [to[0] + (r[0] - from[0]) * sx, to[1] + (r[1] - from[1]) * sy, to[0] + (r[2] - from[0]) * sx, to[1] + (r[3] - from[1]) * sy]
}

function cursorFor(geometry: PageGeometry, r: Rect, h: [number, number]): string {
  if (h[0] === 0.5 && h[1] === 0.5) return 'move'
  const c = geometry.toCss([(r[0] + r[2]) / 2, (r[1] + r[3]) / 2])
  const p = geometry.toCss([r[0] + h[0] * (r[2] - r[0]), r[1] + h[1] * (r[3] - r[1])])
  const dx = Math.sign(Math.round(p[0] - c[0]))
  const dy = Math.sign(Math.round(p[1] - c[1]))
  if (dx && dy) return dx === dy ? 'nwse-resize' : 'nesw-resize'
  return dx ? 'ew-resize' : 'ns-resize'
}

function PreviewCanvas({ preview, rect, geometry }: { preview: Preview; rect: Rect; geometry: PageGeometry }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const c = ref.current
    if (!c) return
    c.width = preview.width
    c.height = preview.height
    const ctx = c.getContext('2d')
    if (!ctx) return
    if (preview.bitmap) ctx.drawImage(preview.bitmap, 0, 0)
    else if (preview.pixels) ctx.putImageData(new ImageData(new Uint8ClampedArray(preview.pixels), preview.width, preview.height), 0, 0)
  }, [preview])
  return <canvas ref={ref} className="fc-comments-preview" style={rotatedBox(geometry, rect)} />
}

function pointsAttr(geometry: PageGeometry, pts: Point[]): string {
  return pts.map((p) => geometry.toCss(p).map((v) => v.toFixed(1)).join(',')).join(' ')
}

/** The invisible shape that receives the pointer for one comment. */
function HitShape({
  a,
  geometry,
  handlers
}: {
  a: AnnotInfo
  geometry: PageGeometry
  handlers: React.SVGProps<SVGElement>
}) {
  const sw = Math.max(10, a.borderWidth * geometry.scale + 8)
  const common = { ...handlers, 'data-annot-id': a.id } as Record<string, unknown>
  const css = geometry.rectToCss(a.rect)
  const rectEl = (cls: string) => (
    <rect
      {...common}
      className={cls}
      x={css.left}
      y={css.top}
      width={Math.max(css.width, 4)}
      height={Math.max(css.height, 4)}
      strokeWidth={cls.includes('stroke') ? sw : undefined}
    />
  )
  if (a.quads.length) {
    return (
      <g {...common}>
        {a.quads.map((q, i) => (
          <polygon
            key={i}
            className="fc-comments-hit-fill"
            points={pointsAttr(geometry, [
              [q[0], q[1]],
              [q[2], q[3]],
              [q[6], q[7]],
              [q[4], q[5]]
            ])}
          />
        ))}
      </g>
    )
  }
  switch (a.type) {
    case 'Ink':
      if (!a.ink.length) return rectEl('fc-comments-hit-fill')
      return (
        <path
          {...common}
          className="fc-comments-hit-stroke"
          strokeWidth={sw}
          d={a.ink
            .map((stroke) =>
              stroke
                .map((p, i) => {
                  const c = geometry.toCss(p)
                  return `${i ? 'L' : 'M'}${c[0].toFixed(1)},${c[1].toFixed(1)}`
                })
                .join('')
            )
            .join(' ')}
        />
      )
    case 'Line': {
      if (!a.line) return rectEl('fc-comments-hit-fill')
      const p = geometry.toCss(a.line[0])
      const q = geometry.toCss(a.line[1])
      return <line {...common} className="fc-comments-hit-stroke" strokeWidth={sw} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />
    }
    case 'PolyLine':
      if (!a.vertices.length) return rectEl('fc-comments-hit-fill')
      return <polyline {...common} className="fc-comments-hit-stroke" strokeWidth={sw} points={pointsAttr(geometry, a.vertices)} />
    case 'Polygon':
      if (!a.vertices.length) return rectEl('fc-comments-hit-fill')
      return (
        <polygon
          {...common}
          className={a.interiorColor ? 'fc-comments-hit-all' : 'fc-comments-hit-stroke'}
          strokeWidth={sw + (a.cloudy ? 10 : 0)}
          points={pointsAttr(geometry, a.vertices)}
        />
      )
    case 'Square':
      return a.interiorColor ? rectEl('fc-comments-hit-all') : rectEl('fc-comments-hit-stroke')
    case 'Circle':
      if (a.interiorColor) return rectEl('fc-comments-hit-all')
      return (
        <ellipse
          {...common}
          className="fc-comments-hit-stroke"
          strokeWidth={sw}
          cx={css.left + css.width / 2}
          cy={css.top + css.height / 2}
          rx={Math.max(2, css.width / 2)}
          ry={Math.max(2, css.height / 2)}
        />
      )
    default:
      return rectEl('fc-comments-hit-fill')
  }
}

export function AnnotationLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const version = usePageVersion(doc, pageIndex)
  const show = useDocState(doc, (s) => s.showAnnotations)
  const selection = useDocState(doc, (s) => s.selection)
  const editing = useCommentsUi((s) => (s.editing?.docId === doc.id && s.editing.page === pageIndex ? s.editing.id : null))
  const [list, setList] = useState<AnnotInfo[]>([])
  const [hoverId, setHoverId] = useState<number | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [previews, setPreviews] = useState<Record<number, Preview>>({})
  const ref = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)

  useEffect(() => {
    let alive = true
    annotsOf(doc)
      .list(pageIndex)
      .then((l) => alive && setList(l))
      .catch((err) => {
        if (alive && !doc.isClosed) console.warn('Could not list comments', err)
      })
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])

  // Leave nothing hidden behind when the layer goes away mid-drag.
  useEffect(
    () => () => {
      if (dragRef.current?.active) setHiddenAnnotations(doc, pageIndex, [])
      useCommentsUi.setState({ dragging: false })
    },
    [doc, pageIndex]
  )

  if (!show) return null

  const visible = list.filter(isPageComment)
  const selectedIds = selection.kind === 'annotations' && selection.page === pageIndex ? selection.ids : []
  const selected = visible.filter((a) => selectedIds.includes(a.id))

  const focusViewport = () => {
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    doc.view?.getViewportElement()?.focus({ preventScroll: true })
  }

  /** Updates the selection for a click on `a`; returns the ids to drag, or null. */
  const select = (a: AnnotInfo, e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): number[] | null => {
    const ids = groupIds(list, a)
    const sel = doc.state.selection
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    if (additive && sel.kind === 'annotations' && sel.page === pageIndex) {
      const has = ids.every((id) => sel.ids.includes(id))
      const next = has ? sel.ids.filter((id) => !ids.includes(id)) : [...sel.ids, ...ids.filter((id) => !sel.ids.includes(id))]
      if (next.length) doc.setSelection({ kind: 'annotations', page: pageIndex, ids: next })
      else doc.clearSelection()
      return has ? null : next
    }
    if (sel.kind === 'annotations' && sel.page === pageIndex && sel.ids.includes(a.id)) return sel.ids
    doc.setSelection({ kind: 'annotations', page: pageIndex, ids })
    return ids
  }

  const requestPreviews = (ids: number[]) => {
    const scale = geometry.scale * (window.devicePixelRatio || 1)
    for (const id of ids) {
      commentsOf(doc)
        .preview(id, scale)
        .then((p) => {
          if (dragRef.current && dragRef.current.ids.includes(id)) setPreviews((cur) => ({ ...cur, [id]: p }))
        })
        .catch(() => {})
    }
  }

  const finish = (d: Drag) => {
    window.setTimeout(() => {
      if (dragRef.current !== d) return
      dragRef.current = null
      setDrag(null)
      setPreviews({})
    }, 400)
  }

  const commit = async (d: Drag) => {
    const ops = annotsOf(doc)
    if (d.kind === 'move') {
      if (Math.abs(d.delta[0]) < 0.01 && Math.abs(d.delta[1]) < 0.01) return
      await ops.move(d.ids, d.delta[0], d.delta[1], pageIndex)
    } else if (d.kind === 'resize' && d.rect) {
      await ops.transform([{ id: d.ids[0], rect: d.rect }], pageIndex)
    } else if (d.kind === 'endpoint' && d.line) {
      await ops.update(d.ids[0], { line: d.line }, pageIndex)
    }
  }

  const startDrag = (e: React.PointerEvent, kind: Drag['kind'], items: AnnotInfo[], handle = -1) => {
    const el = ref.current
    if (!el) return
    const origin: Record<number, Rect> = {}
    for (const a of items) origin[a.id] = a.rect
    const line = items[0]?.line ? ([[...items[0].line[0]], [...items[0].line[1]]] as [Point, Point]) : null
    const d: Drag = {
      kind,
      ids: items.map((a) => a.id),
      origin,
      handle,
      startClient: [e.clientX, e.clientY],
      start: geometry.eventToPage(e, el),
      active: false,
      committed: false,
      delta: [0, 0],
      rect: kind === 'resize' ? items[0].rect : null,
      line: kind === 'endpoint' ? line : null
    }
    dragRef.current = d
    setPreviews({})
    if (kind !== 'endpoint') requestPreviews(d.ids)
    const W = geometry.width
    const H = geometry.height

    const update = (ev: { clientX: number; clientY: number; shiftKey: boolean }) => {
      const cur = geometry.eventToPage(ev, el)
      let dx = cur[0] - d.start[0]
      let dy = cur[1] - d.start[1]
      if (kind === 'move') {
        if (ev.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        const rects = Object.values(origin)
        const u = [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))]
        dx = Math.max(-u[0], Math.min(W - u[2], dx))
        dy = Math.max(-u[1], Math.min(H - u[3], dy))
        d.delta = [dx, dy]
      } else if (kind === 'resize') {
        const o = origin[d.ids[0]]
        const [hx, hy] = HANDLES[handle]
        let x0 = o[0]
        let y0 = o[1]
        let x1 = o[2]
        let y1 = o[3]
        if (hx === 0) x0 += dx
        if (hx === 1) x1 += dx
        if (hy === 0) y0 += dy
        if (hy === 1) y1 += dy
        const keepAspect = ev.shiftKey !== (items[0].type === 'Stamp')
        if (keepAspect && hx !== 0.5 && hy !== 0.5) {
          const w0 = o[2] - o[0]
          const h0 = o[3] - o[1]
          const sc = Math.max(Math.abs(x1 - x0) / w0, Math.abs(y1 - y0) / h0)
          if (hx === 0) x0 = x1 - w0 * sc
          else x1 = x0 + w0 * sc
          if (hy === 0) y0 = y1 - h0 * sc
          else y1 = y0 + h0 * sc
        }
        let r = normalizeRect([x0, y0, x1, y1])
        if (r[2] - r[0] < MIN_SIZE) r = hx === 0 ? [r[2] - MIN_SIZE, r[1], r[2], r[3]] : [r[0], r[1], r[0] + MIN_SIZE, r[3]]
        if (r[3] - r[1] < MIN_SIZE) r = hy === 0 ? [r[0], r[3] - MIN_SIZE, r[2], r[3]] : [r[0], r[1], r[2], r[1] + MIN_SIZE]
        d.rect = [Math.max(0, r[0]), Math.max(0, r[1]), Math.min(W, r[2]), Math.min(H, r[3])]
      } else if (kind === 'endpoint' && line) {
        const moving = line[handle]
        const other = line[1 - handle]
        let p: Point = [Math.max(0, Math.min(W, moving[0] + dx)), Math.max(0, Math.min(H, moving[1] + dy))]
        if (ev.shiftKey) {
          const ang = Math.atan2(p[1] - other[1], p[0] - other[0])
          const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4)
          const len = Math.hypot(p[0] - other[0], p[1] - other[1])
          p = [other[0] + len * Math.cos(snap), other[1] + len * Math.sin(snap)]
        }
        d.line = handle === 0 ? [p, other] : [other, p]
      }
    }

    const onMove = (ev: PointerEvent) => {
      if (!d.active) {
        if (Math.hypot(ev.clientX - d.startClient[0], ev.clientY - d.startClient[1]) < 3) return
        d.active = true
        setHiddenAnnotations(doc, pageIndex, d.ids)
        useCommentsUi.setState({ dragging: true, hover: null })
      }
      update(ev)
      setDrag({ ...d })
      // keep the comment in view while dragging near the edges
      const vp = doc.view?.getViewportElement()
      if (vp) {
        const b = vp.getBoundingClientRect()
        if (ev.clientY < b.top + 20) doc.view?.scrollBy(0, -16)
        else if (ev.clientY > b.bottom - 20) doc.view?.scrollBy(0, 16)
      }
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey, true)
    }
    const onUp = (ev: PointerEvent) => {
      cleanup()
      if (!d.active) {
        dragRef.current = null
        setDrag(null)
        setPreviews({})
        return
      }
      update(ev)
      d.committed = true
      setDrag({ ...d })
      useCommentsUi.setState({ dragging: false })
      commit(d)
        .catch((err) => showError(err, d.kind === 'move' ? 'Could not move the comment' : 'Could not resize the comment'))
        .finally(() => {
          setHiddenAnnotations(doc, pageIndex, [])
          finish(d)
        })
    }
    const onCancel = () => {
      cleanup()
      if (d.active) setHiddenAnnotations(doc, pageIndex, [])
      useCommentsUi.setState({ dragging: false })
      dragRef.current = null
      setDrag(null)
      setPreviews({})
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      ev.stopPropagation()
      onCancel()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey, true)
  }

  const onPointerDown = (e: React.PointerEvent, a: AnnotInfo) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    focusViewport()
    useCommentsUi.setState({ hover: null })
    const ids = select(a, e)
    if (!ids) return
    const movable = list.filter((x) => ids.includes(x.id) && canMove(x))
    if (movable.length && canMove(a)) startDrag(e, 'move', movable)
  }

  const onDoubleClick = (e: React.MouseEvent, a: AnnotInfo) => {
    e.stopPropagation()
    e.preventDefault()
    if (a.type === 'FreeText' && !a.locked) startInlineEdit(doc, a)
    else {
      const root = groupIds(list, a)[0]
      openPopup(doc, list.find((x) => x.id === root) ?? a)
    }
  }

  const onContextMenu = (e: React.MouseEvent, a: AnnotInfo) => {
    e.preventDefault()
    e.stopPropagation()
    const sel = doc.state.selection
    if (!(sel.kind === 'annotations' && sel.page === pageIndex && sel.ids.includes(a.id))) {
      doc.setSelection({ kind: 'annotations', page: pageIndex, ids: groupIds(list, a) })
    }
    useCommentsUi.setState({ hover: null })
    showContextMenu(e.clientX, e.clientY, commentMenu(doc, a, list))
  }

  const hover = (a: AnnotInfo | null, e?: React.PointerEvent) => {
    setHoverId(a ? a.id : null)
    if (!a || dragRef.current?.active || !useCommentPrefs.getState().hoverPopups) {
      if (useCommentsUi.getState().hover?.docId === doc.id) useCommentsUi.setState({ hover: null })
      return
    }
    useCommentsUi.setState({ hover: { docId: doc.id, id: a.id, page: pageIndex, x: e!.clientX, y: e!.clientY } })
  }

  const handlersFor = (a: AnnotInfo) => ({
    onPointerDown: (e: React.PointerEvent) => onPointerDown(e, a),
    onDoubleClick: (e: React.MouseEvent) => onDoubleClick(e, a),
    onContextMenu: (e: React.MouseEvent) => onContextMenu(e, a),
    onPointerEnter: (e: React.PointerEvent) => hover(a, e),
    onPointerMove: (e: React.PointerEvent) => {
      const h = useCommentsUi.getState().hover
      if (h && h.id === a.id && h.docId === doc.id && Math.hypot(h.x - e.clientX, h.y - e.clientY) > 24) hover(a, e)
    },
    onPointerLeave: () => hover(null)
  })

  // Geometry of a selected comment, following an ongoing drag.
  const liveRect = (a: AnnotInfo): Rect => {
    if (!drag || !drag.ids.includes(a.id) || !drag.active) return a.rect
    if (drag.kind === 'move') return [a.rect[0] + drag.delta[0], a.rect[1] + drag.delta[1], a.rect[2] + drag.delta[0], a.rect[3] + drag.delta[1]]
    if (drag.kind === 'resize' && drag.rect) return drag.rect
    if (drag.kind === 'endpoint' && drag.line) {
      const pad = Math.max(1, a.borderWidth)
      return [
        Math.min(drag.line[0][0], drag.line[1][0]) - pad,
        Math.min(drag.line[0][1], drag.line[1][1]) - pad,
        Math.max(drag.line[0][0], drag.line[1][0]) + pad,
        Math.max(drag.line[0][1], drag.line[1][1]) + pad
      ]
    }
    return a.rect
  }

  // Segment of a selected line, following an ongoing drag.
  const liveLine = (a: AnnotInfo): [Point, Point] | null => {
    if (a.type !== 'Line' || !a.line) return null
    if (drag?.active && drag.ids.includes(a.id)) {
      if (drag.kind === 'endpoint' && drag.line) return drag.line
      if (drag.kind === 'move') {
        const [dx, dy] = drag.delta
        return [
          [a.line[0][0] + dx, a.line[0][1] + dy],
          [a.line[1][0] + dx, a.line[1][1] + dy]
        ]
      }
    }
    return a.line
  }

  const single = selected.length === 1 ? selected[0] : null
  const mode = single && !single.locked ? resizeMode(single) : 'none'
  const hovered = hoverId !== null && !selectedIds.includes(hoverId) ? visible.find((a) => a.id === hoverId) : undefined

  return (
    <div ref={ref} className="viewer-layer fc-comments-layer" data-page={pageIndex}>
      <svg className="fc-comments-hits" width={geometry.cssWidth} height={geometry.cssHeight}>
        {visible.map((a) => (
          <HitShape key={a.id} a={a} geometry={geometry} handlers={handlersFor(a) as unknown as React.SVGProps<SVGElement>} />
        ))}
      </svg>
      {hovered && !drag?.active && hovered.type === 'Line' && hovered.line && (
        <LineMark line={hovered.line} geometry={geometry} className="fc-comments-linehover" />
      )}
      {hovered && !drag?.active && !(hovered.type === 'Line' && hovered.line) && (
        <div className="fc-comments-hover" style={inflate(geometry.rectToCss(hovered.rect), 2)} />
      )}
      {drag?.active &&
        drag.kind !== 'endpoint' &&
        drag.ids.map((id) => {
          const p = previews[id]
          const a = list.find((x) => x.id === id)
          if (!p || !a) return null
          const target = drag.kind === 'move' ? offset(p.bounds, drag.delta) : mapRect(p.bounds, drag.origin[id], drag.rect ?? a.rect)
          return <PreviewCanvas key={id} preview={p} rect={target} geometry={geometry} />
        })}
      {drag?.active && drag.kind === 'endpoint' && drag.line && single && (
        <svg className="fc-comments-line-preview" width={geometry.cssWidth} height={geometry.cssHeight}>
          <line
            x1={geometry.toCss(drag.line[0])[0]}
            y1={geometry.toCss(drag.line[0])[1]}
            x2={geometry.toCss(drag.line[1])[0]}
            y2={geometry.toCss(drag.line[1])[1]}
            stroke={single.color ?? '#000'}
            strokeOpacity={single.opacity}
            strokeWidth={Math.max(1, single.borderWidth * geometry.scale)}
          />
        </svg>
      )}
      {selected.map((a) => {
        // Lines are selected along the segment (a box would grab clicks far away from them).
        const seg = liveLine(a)
        if (seg) return <LineMark key={a.id} line={seg} geometry={geometry} className={`fc-comments-linesel ${a.locked ? 'is-locked' : ''}`} />
        const box = inflate(geometry.rectToCss(liveRect(a)), 3)
        const movable = canMove(a)
        return (
          <div
            key={a.id}
            className={`fc-comments-selbox ${a.locked ? 'is-locked' : ''} ${editing === a.id ? 'is-editing' : ''}`}
            style={{ ...box, cursor: movable ? 'move' : 'default' }}
            data-annot-id={a.id}
            {...handlersFor(a)}
          />
        )
      })}
      {single && mode === 'rect' && !drag?.committed && editing !== single.id &&
        HANDLES.map((h, i) => {
          const r = liveRect(single)
          const c = geometry.toCss([r[0] + h[0] * (r[2] - r[0]), r[1] + h[1] * (r[3] - r[1])])
          return (
            <div
              key={i}
              className="fc-comments-handle"
              style={{ left: c[0], top: c[1], cursor: cursorFor(geometry, r, h) }}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                e.preventDefault()
                startDrag(e, 'resize', [single], i)
              }}
            />
          )
        })}
      {single && mode === 'line' && single.line && !drag?.committed &&
        [0, 1].map((i) => {
          const line = drag?.active && drag.line ? drag.line : single.line!
          const c = geometry.toCss(line[i])
          return (
            <div
              key={i}
              className="fc-comments-handle is-round"
              style={{ left: c[0], top: c[1], cursor: 'crosshair' }}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.stopPropagation()
                e.preventDefault()
                startDrag(e, 'endpoint', [single], i)
              }}
            />
          )
        })}
    </div>
  )
}

/** Highlight along a line segment (selection or hover of Line comments). */
function LineMark({ line, geometry, className }: { line: [Point, Point]; geometry: PageGeometry; className: string }) {
  const p = geometry.toCss(line[0])
  const q = geometry.toCss(line[1])
  return (
    <svg className={`fc-comments-linemark ${className}`} width={geometry.cssWidth} height={geometry.cssHeight} aria-hidden>
      <line className="fc-comments-linemark-halo" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />
      <line className="fc-comments-linemark-core" x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />
    </svg>
  )
}

function inflate(c: { left: number; top: number; width: number; height: number }, d: number) {
  return { left: c.left - d, top: c.top - d, width: c.width + d * 2, height: c.height + d * 2 }
}

function offset(r: Rect, d: Point): Rect {
  return [r[0] + d[0], r[1] + d[1], r[2] + d[0], r[3] + d[1]]
}
