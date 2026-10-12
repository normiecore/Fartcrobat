import { useEffect, useMemo, useRef, useState } from 'react'
import type { Point, Rect } from '@shared/geometry'
import { normalizeRect } from '@shared/geometry'
import {
  setHiddenAnnotations,
  showContextMenu,
  showError,
  useApp,
  useDocState,
  usePrefs,
  type PageLayerProps
} from '@renderer/sdk'
import { DEFAULT_SIZE, TYPE_LABELS, type PFField } from '../model'
import { clearFieldSelection, createField, fieldSelection, pf, selectFields, TOOL_TYPES } from './actions'
import { usePageFields } from './hooks'
import { InlineNameBox } from './InlineNameBox'
import { fieldMenu, pageMenu } from './menus'
import { openProperties } from './PropertiesDialog'
import { usePF } from './state'

type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

type Drag =
  | { kind: 'create'; a: Point; b: Point; startClient: Point }
  | { kind: 'band'; a: Point; b: Point; base: number[] }
  | { kind: 'move'; ids: number[]; start: Point; dx: number; dy: number; moved: boolean; startClient: Point }
  | { kind: 'resize'; id: number; handle: Handle; orig: Rect; rect: Rect; start: Point }

const MIN = 6

function intersects(a: Rect, b: Rect) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

/**
 * The form editing layer (all "form.*" tools): every field is a blue box with its name; select,
 * move, resize, create and right-click fields here.
 */
export function FieldLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const toolId = useApp((s) => s.toolId)
  const prefs = usePrefs()
  const createType = TOOL_TYPES[toolId] ?? null
  const [fields, setFields] = usePageFields(doc, pageIndex)
  const selection = useDocState(doc, (s) => s.selection)
  const showTabs = usePF((s) => s.showTabNumbers)
  const inline = usePF((s) => s.inline)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag

  const sel = fieldSelection(selection)
  const selected = useMemo(() => (sel && sel.page === pageIndex ? sel.ids : []), [sel, pageIndex])
  const pageW = geometry.width
  const pageH = geometry.height

  const snap = (v: number) => (prefs.snapToGrid && prefs.gridSize > 0 ? Math.round(v / prefs.gridSize) * prefs.gridSize : v)
  const toPage = (e: { clientX: number; clientY: number }): Point => geometry.eventToPage(e, ref.current!)

  // Escape cancels a drag in progress.
  useEffect(() => {
    if (!drag) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setHiddenAnnotations(doc, pageIndex, [])
      setDrag(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drag, doc, pageIndex])

  // Leave nothing hidden behind when the layer goes away mid-drag.
  useEffect(() => () => setHiddenAnnotations(doc, pageIndex, []), [doc, pageIndex])

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const p = toPage(e)
    ref.current!.setPointerCapture(e.pointerId)
    if (createType) {
      setDrag({ kind: 'create', a: p, b: p, startClient: [e.clientX, e.clientY] })
      return
    }
    usePF.setState({ inline: null })
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    if (!additive) clearFieldSelection(doc)
    setDrag({ kind: 'band', a: p, b: p, base: additive ? selected : [] })
  }

  const onFieldDown = (e: React.PointerEvent, f: PFField) => {
    if (e.button !== 0 || createType) return
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).focus({ preventScroll: true })
    const multi = e.shiftKey || e.ctrlKey || e.metaKey
    let ids = selected
    if (multi) {
      ids = selected.includes(f.id) ? selected.filter((x) => x !== f.id) : [...selected, f.id]
      selectFields(doc, pageIndex, ids)
      if (!ids.includes(f.id)) return
    } else if (!selected.includes(f.id)) {
      ids = [f.id]
      selectFields(doc, pageIndex, ids)
    }
    if (inline && inline.id !== f.id) usePF.setState({ inline: null })
    ref.current!.setPointerCapture(e.pointerId)
    setDrag({ kind: 'move', ids, start: toPage(e), dx: 0, dy: 0, moved: false, startClient: [e.clientX, e.clientY] })
  }

  const onHandleDown = (e: React.PointerEvent, f: PFField, handle: Handle) => {
    if (e.button !== 0) return
    e.stopPropagation()
    ref.current!.setPointerCapture(e.pointerId)
    setHiddenAnnotations(doc, pageIndex, [f.id])
    setDrag({ kind: 'resize', id: f.id, handle, orig: f.rect, rect: f.rect, start: toPage(e) })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) {
      if (createType) setHover(toPage(e))
      return
    }
    const p = toPage(e)
    switch (d.kind) {
      case 'create':
        setDrag({ ...d, b: p })
        break
      case 'band': {
        const next = { ...d, b: p }
        setDrag(next)
        const band = normalizeRect([d.a[0], d.a[1], p[0], p[1]])
        const hit = fields.filter((f) => intersects(f.rect, band)).map((f) => f.id)
        const ids = [...new Set([...d.base, ...hit])]
        if (ids.length) selectFields(doc, pageIndex, ids)
        else clearFieldSelection(doc)
        break
      }
      case 'move': {
        const moved = d.moved || Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]) > 3
        if (!moved) return
        const group = fields.filter((f) => d.ids.includes(f.id))
        if (!group.length) return
        const primary = group[0].rect
        let dx = snap(primary[0] + p[0] - d.start[0]) - primary[0]
        let dy = snap(primary[1] + p[1] - d.start[1]) - primary[1]
        // keep the fields on the page
        const minX = Math.min(...group.map((f) => f.rect[0]))
        const maxX = Math.max(...group.map((f) => f.rect[2]))
        const minY = Math.min(...group.map((f) => f.rect[1]))
        const maxY = Math.max(...group.map((f) => f.rect[3]))
        dx = Math.max(-minX, Math.min(pageW - maxX, dx))
        dy = Math.max(-minY, Math.min(pageH - maxY, dy))
        if (!d.moved) setHiddenAnnotations(doc, pageIndex, d.ids)
        setDrag({ ...d, dx, dy, moved: true })
        break
      }
      case 'resize': {
        // the grabbed edge follows the pointer movement (grabbing a handle does not make it jump)
        let [x0, y0, x1, y1] = d.orig
        const dx = p[0] - d.start[0]
        const dy = p[1] - d.start[1]
        const ex = (v: number) => Math.max(0, Math.min(pageW, snap(v)))
        const ey = (v: number) => Math.max(0, Math.min(pageH, snap(v)))
        if (d.handle.includes('w')) x0 = Math.min(ex(x0 + dx), x1 - MIN)
        if (d.handle.includes('e')) x1 = Math.max(ex(x1 + dx), x0 + MIN)
        if (d.handle.includes('n')) y0 = Math.min(ey(y0 + dy), y1 - MIN)
        if (d.handle.includes('s')) y1 = Math.max(ey(y1 + dy), y0 + MIN)
        if (e.shiftKey && d.handle.length === 2) {
          // keep the proportions with Shift
          const ratio = (d.orig[2] - d.orig[0]) / Math.max(1, d.orig[3] - d.orig[1])
          const w = x1 - x0
          const h = w / ratio
          if (d.handle.includes('n')) y0 = y1 - h
          else y1 = y0 + h
        }
        setDrag({ ...d, rect: [x0, y0, x1, y1] })
        break
      }
    }
  }

  const finish = async (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    if (d.kind === 'create') {
      setDrag(null)
      const type = createType
      if (!type) return
      const dragged = Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]) > 4
      let rect: Rect
      if (dragged) {
        rect = normalizeRect([snap(d.a[0]), snap(d.a[1]), snap(d.b[0]), snap(d.b[1])])
        if (rect[2] - rect[0] < MIN) rect[2] = rect[0] + MIN
        if (rect[3] - rect[1] < MIN) rect[3] = rect[1] + MIN
      } else {
        const [w, h] = DEFAULT_SIZE[type]
        const x = Math.max(0, Math.min(pageW - w, snap(d.a[0])))
        const y = Math.max(0, Math.min(pageH - h, snap(d.a[1])))
        rect = [x, y, x + w, y + h]
      }
      setHover(null)
      await createField(doc, type, pageIndex, rect)
      return
    }
    if (d.kind === 'band') {
      setDrag(null)
      return
    }
    if (d.kind === 'move') {
      if (!d.moved || (Math.abs(d.dx) < 0.01 && Math.abs(d.dy) < 0.01)) {
        setDrag(null)
        setHiddenAnnotations(doc, pageIndex, [])
        return
      }
      // show the result right away, then let the engine catch up
      setFields(fields.map((f) => (d.ids.includes(f.id) ? { ...f, rect: [f.rect[0] + d.dx, f.rect[1] + d.dy, f.rect[2] + d.dx, f.rect[3] + d.dy] as Rect } : f)))
      setDrag(null)
      try {
        await pf(doc).move(d.ids, d.dx, d.dy)
      } catch (err) {
        showError(err, 'Could not move the field')
      } finally {
        setHiddenAnnotations(doc, pageIndex, [])
      }
      return
    }
    if (d.kind === 'resize') {
      const changed = d.rect.some((v, i) => Math.abs(v - d.orig[i]) > 0.01)
      if (changed) setFields(fields.map((f) => (f.id === d.id ? { ...f, rect: d.rect } : f)))
      setDrag(null)
      if (!changed) {
        setHiddenAnnotations(doc, pageIndex, [])
        return
      }
      try {
        await pf(doc).setRects([{ id: d.id, rect: d.rect }])
      } catch (err) {
        showError(err, 'Could not resize the field')
      } finally {
        setHiddenAnnotations(doc, pageIndex, [])
      }
    }
  }

  /** The topmost field under a pointer event (events can land on the layer while it holds the pointer). */
  const fieldAt = (e: { clientX: number; clientY: number }): PFField | undefined => {
    const [x, y] = toPage(e)
    for (let i = fields.length - 1; i >= 0; i--) {
      const r = fields[i].rect
      if (x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]) return fields[i]
    }
    return undefined
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    if (createType) return
    const f = fieldAt(e)
    if (!f) return
    e.stopPropagation()
    openProperties(doc, [f.id])
  }

  const onContextMenu = (e: React.MouseEvent, f?: PFField) => {
    e.preventDefault()
    e.stopPropagation()
    if (createType) return
    if (f) {
      let ids = selected
      if (!selected.includes(f.id)) {
        ids = [f.id]
        selectFields(doc, pageIndex, ids)
      }
      showContextMenu(e.clientX, e.clientY, fieldMenu(doc, pageIndex, ids, f.id))
    } else {
      showContextMenu(e.clientX, e.clientY, pageMenu(doc, pageIndex, toPage(e)))
    }
  }

  const rectFor = (f: PFField): Rect => {
    if (drag?.kind === 'move' && drag.moved && drag.ids.includes(f.id)) {
      return [f.rect[0] + drag.dx, f.rect[1] + drag.dy, f.rect[2] + drag.dx, f.rect[3] + drag.dy]
    }
    if (drag?.kind === 'resize' && drag.id === f.id) return drag.rect
    return f.rect
  }

  const single = selected.length === 1
  const inlineField = inline && inline.docId === doc.id && inline.page === pageIndex ? fields.find((f) => f.id === inline.id) : undefined

  let preview: React.ReactNode = null
  if (drag?.kind === 'create' && createType) {
    const r = geometry.rectToCss(normalizeRect([snap(drag.a[0]), snap(drag.a[1]), snap(drag.b[0]), snap(drag.b[1])]))
    preview = <div className="fc-prepare-form-ghost" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
  } else if (createType && hover && !drag) {
    const [w, h] = DEFAULT_SIZE[createType]
    const x = Math.max(0, Math.min(pageW - w, snap(hover[0])))
    const y = Math.max(0, Math.min(pageH - h, snap(hover[1])))
    const r = geometry.rectToCss([x, y, x + w, y + h])
    preview = (
      <div className="fc-prepare-form-ghost is-hover" style={{ left: r.left, top: r.top, width: r.width, height: r.height }}>
        {r.width > 50 && <span>{TYPE_LABELS[createType]}</span>}
      </div>
    )
  } else if (drag?.kind === 'band') {
    const r = geometry.rectToCss(normalizeRect([drag.a[0], drag.a[1], drag.b[0], drag.b[1]]))
    preview = <div className="fc-prepare-form-band" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
  }

  return (
    <div
      ref={ref}
      className={`viewer-layer fc-prepare-form-layer ${createType ? 'is-creating' : ''}`}
      onPointerDown={onBackgroundDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => onContextMenu(e, fieldAt(e))}
      data-page={pageIndex}
    >
      {fields.map((f) => {
        const r = geometry.rectToCss(rectFor(f))
        const isSel = selected.includes(f.id)
        const small = r.width < 44 || r.height < 13
        return (
          <div
            key={f.id}
            className={`fc-prepare-form-box ${isSel ? 'is-selected' : ''} ${isSel && single ? 'is-solo' : ''} ${small ? 'is-small' : ''} ${f.visibility === 'hidden' ? 'is-hidden' : ''} type-${f.type}`}
            style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            data-field-id={f.id}
            data-field-name={f.name}
            role="button"
            tabIndex={0}
            aria-pressed={isSel}
            aria-label={`${TYPE_LABELS[f.type]} ${f.name}${f.required ? ', required' : ''}`}
            title={`${TYPE_LABELS[f.type]}: ${f.name}${f.tooltip ? `\n${f.tooltip}` : ''}\nDouble-click for properties`}
            onPointerDown={(e) => onFieldDown(e, f)}
            onContextMenu={(e) => onContextMenu(e, f)}
            onFocus={() => {
              if (!selected.includes(f.id)) selectFields(doc, pageIndex, [f.id])
            }}
          >
            <span className="fc-prepare-form-name">
              {f.name}
              {f.required && <span className="fc-prepare-form-req">*</span>}
            </span>
            {showTabs && <span className="fc-prepare-form-tab">{f.tabIndex + 1}</span>}
            {isSel &&
              single &&
              !drag &&
              HANDLES.map((h) => (
                <span key={h} className={`fc-prepare-form-handle h-${h}`} onPointerDown={(e) => onHandleDown(e, f, h)} aria-hidden />
              ))}
          </div>
        )
      })}
      {preview}
      {inlineField && !drag && <InlineNameBox doc={doc} field={inlineField} geometry={geometry} />}
    </div>
  )
}
