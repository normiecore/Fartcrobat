/**
 * Draw free form: smooth free-hand ink. Strokes drawn within 1.5 s of each other (on the same page)
 * go into the same Ink annotation; the drawing is finished after the pause or when the tool changes.
 */
import { useRef, useState } from 'react'
import { create } from 'zustand'
import type { Point } from '@shared/geometry'
import { setTool, showError, useApp, type DocumentModel, type PageLayerProps } from '@renderer/sdk'
import { createWith, markupOps } from '../actions'
import { processStroke } from '../geometry'
import { InkPreview, PreviewSvg } from '../Preview'
import { getToolStyle, styleSpec, type ToolStyle } from '../style'
import { TOOL_BY_ID } from '../tools'
import { pagePoint, useActiveToolAndStyle } from './shared'

export const PENCIL_PAUSE_MS = 1500
/** How long committed strokes stay in the overlay while the page re-renders (avoids a flicker). */
const SETTLE_MS = 400

interface Session {
  doc: DocumentModel
  page: number
  toolId: string
  /** Resolves to the Ink annotation id once created (null when creating failed). */
  id: Promise<number | null>
  timer: ReturnType<typeof setTimeout> | null
}

let session: Session | null = null

interface PendingStroke {
  key: number
  docId: string
  page: number
  points: Point[]
  style: ToolStyle
}

/** Strokes already sent to the engine but maybe not painted on the page canvas yet. */
const usePending = create<{ strokes: PendingStroke[] }>(() => ({ strokes: [] }))
let strokeKey = 0

function settle(key: number) {
  setTimeout(() => usePending.setState((s) => ({ strokes: s.strokes.filter((x) => x.key !== key) })), SETTLE_MS)
}

/** Ends the current drawing. With `select`, returns to the Select tool and selects it (unless kept). */
export function endPencilSession(opts: { select?: boolean } = {}) {
  const s = session
  if (!s) return
  session = null
  if (s.timer) clearTimeout(s.timer)
  if (!opts.select) return
  void s.id.then((id) => {
    if (id === null || s.doc.isClosed) return
    const app = useApp.getState()
    if (app.prefs.keepToolSelected || app.toolId !== s.toolId) return
    setTool('select')
    s.doc.setSelection({ kind: 'annotations', page: s.page, ids: [id] })
  })
}

function commitStroke(doc: DocumentModel, page: number, toolId: string, points: Point[], style: ToolStyle) {
  const tool = TOOL_BY_ID.get(toolId)!
  const key = ++strokeKey
  usePending.setState((s) => ({ strokes: [...s.strokes, { key, docId: doc.id, page, points, style }] }))
  if (session && (session.doc !== doc || session.page !== page || session.toolId !== toolId)) endPencilSession()
  if (session?.timer) clearTimeout(session.timer)
  const spec = { type: 'Ink', ink: [points], ...styleSpec(tool, style) }
  const create = async (): Promise<number | null> => {
    const created = await createWith(doc, tool, [{ page, spec }])
    return created ? created[0].id : null
  }
  if (!session) {
    const id = create()
    session = { doc, page, toolId, id, timer: null }
  } else {
    const prev = session.id
    session.id = prev.then(async (id) => {
      if (id === null) return create()
      try {
        await markupOps(doc).appendInk(page, id, [points])
        return id
      } catch {
        // the drawing was undone or deleted meanwhile: start a new one
        return create()
      }
    })
  }
  const s = session
  void s.id
    .catch((err) => {
      showError(err, 'Could not add the drawing')
      return null
    })
    .finally(() => settle(key))
  s.timer = setTimeout(() => {
    if (session === s) endPencilSession({ select: true })
  }, PENCIL_PAUSE_MS)
}

export function PencilLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { tool, style } = useActiveToolAndStyle()
  const raw = useRef<Point[] | null>(null)
  const [, setTick] = useState(0)
  const frame = useRef(0)
  const allPending = usePending((s) => s.strokes)
  const pending = allPending.filter((x) => x.docId === doc.id && x.page === pageIndex)

  if (!tool) return null

  const redraw = () => {
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      setTick((t) => t + 1)
    })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ref.current!.setPointerCapture(e.pointerId)
    if (session?.timer) clearTimeout(session.timer)
    raw.current = [pagePoint(e, ref.current!, geometry)]
    redraw()
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!raw.current) return
    const events = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? []
    for (const ev of events.length ? events : [e]) raw.current.push(pagePoint(ev, ref.current!, geometry))
    redraw()
  }

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    const pts = raw.current
    raw.current = null
    redraw()
    if (!pts || !pts.length) return
    commitStroke(doc, pageIndex, tool.id, processStroke(pts, geometry.scale), getToolStyle(tool.key))
  }

  const live = raw.current
  return (
    <div
      ref={ref}
      className="viewer-layer fc-markup-tools-layer fc-markup-tools-cursor-pencil"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        raw.current = null
        redraw()
      }}
    >
      {(live || pending.length > 0) && (
        <PreviewSvg geometry={geometry}>
          {pending.map((p) => (
            <InkPreview key={p.key} g={geometry} strokes={[p.points]} color={p.style.color} width={p.style.width} opacity={p.style.opacity} />
          ))}
          {live && <InkPreview g={geometry} strokes={[live]} color={style.color} width={style.width} opacity={style.opacity} />}
        </PreviewSvg>
      )}
    </div>
  )
}
