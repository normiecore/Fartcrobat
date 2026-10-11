/**
 * Drag tools: rectangle, oval (Shift = square/circle), line and arrow (Shift snaps to 45°), text box,
 * highlight area, and the two-step callout (click the arrow tip, then click or drag the text box).
 */
import { useRef, useState } from 'react'
import type { Point, Rect } from '@shared/geometry'
import type { DocumentModel, PageLayerProps } from '@renderer/sdk'
import { createWith, finishCreate, textForNewComment } from '../actions'
import { calloutBoxAt, calloutLine, constrainSquare, dist, fitRect, rectFrom, snapAngle } from '../geometry'
import { CalloutPreview, LinePreview, PreviewSvg, RectPreview } from '../Preview'
import { getToolStyle, styleSpec } from '../style'
import type { MarkupTool } from '../tools'
import { measureText } from './ClickLayer'
import { createAreaHighlight } from './TextMarkupLayer'
import { pagePoint, useActiveToolAndStyle, useKeys } from './shared'

const TEXTBOX_SIZE: [number, number] = [180, 40]
const CALLOUT_SIZE: [number, number] = [150, 40]

interface Drag {
  a: Point
  b: Point
}

/** Applies the Shift constraint of the tool to the drag end point. */
function constrained(tool: MarkupTool, a: Point, b: Point, shift: boolean): Point {
  if (!shift) return b
  if (tool.kind === 'line') return snapAngle(a, b)
  if (tool.kind === 'rect' || tool.kind === 'textbox' || tool.kind === 'areaHighlight') return constrainSquare(a, b)
  return b
}

/** Grows a text box so typed-ahead text (when there is no inline editor) fits. */
function fitTextBox(box: Rect, text: string, tool: MarkupTool, page: { width: number; height: number }): Rect {
  if (!text) return box
  const st = getToolStyle(tool.key)
  const m = measureText(text, st.font, st.fontSize)
  const pad = st.width + 4
  const w = Math.max(box[2] - box[0], Math.min(page.width * 0.6, m.width + pad * 2 + st.fontSize * 0.5))
  const h = Math.max(box[3] - box[1], m.height + pad * 2 + st.fontSize * 0.3)
  return fitRect([box[0], box[1], box[0] + w, box[1] + h], page.width, page.height)
}

async function createShape(doc: DocumentModel, tool: MarkupTool, page: number, a: Point, b: Point, size: { width: number; height: number }) {
  const st = getToolStyle(tool.key)
  const spec = styleSpec(tool, st)
  if (tool.kind === 'line') {
    const created = await createWith(doc, tool, [{ page, spec: { type: 'Line', line: [a, b], ...spec } }])
    if (created) finishCreate(doc, tool, page, [created[0].id])
    return
  }
  if (tool.kind === 'rect') {
    const created = await createWith(doc, tool, [{ page, spec: { type: tool.shape!, rect: rectFrom(a, b), ...spec } }])
    if (created) finishCreate(doc, tool, page, [created[0].id])
    return
  }
  if (tool.kind === 'textbox') {
    const tiny = Math.abs(b[0] - a[0]) < 4 && Math.abs(b[1] - a[1]) < 4
    let box = tiny ? fitRect([a[0], a[1], a[0] + TEXTBOX_SIZE[0], a[1] + TEXTBOX_SIZE[1]], size.width, size.height) : rectFrom(a, b)
    const text = await textForNewComment(tool)
    if (text === null) return
    box = fitTextBox(box, text, tool, size)
    const created = await createWith(doc, tool, [{ page, spec: { type: 'FreeText', rect: box, contents: text, ...spec } }])
    if (created) finishCreate(doc, tool, page, [created[0].id], { edit: created[0].id })
  }
}

async function createCallout(doc: DocumentModel, tool: MarkupTool, page: number, tip: Point, box: Rect, size: { width: number; height: number }) {
  const text = await textForNewComment(tool)
  if (text === null) return
  const st = getToolStyle(tool.key)
  const fitted = fitTextBox(fitRect(box, size.width, size.height), text, tool, size)
  const created = await createWith(doc, tool, [
    {
      page,
      spec: { type: 'FreeText', rect: fitted, calloutLine: calloutLine(tip, fitted), contents: text, ...styleSpec(tool, st) },
      calloutStyle: st.endEnd
    }
  ])
  if (created) finishCreate(doc, tool, page, [created[0].id], { edit: created[0].id })
}

/** Callout tip waiting for its text box, shared so only one page shows it. */
let pendingTip: { docId: string; page: number; tip: Point } | null = null

export function ShapeLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { tool, style } = useActiveToolAndStyle()
  const [drag, setDrag] = useState<Drag | null>(null)
  const [tip, setTipState] = useState<Point | null>(() => (pendingTip && pendingTip.docId === doc.id && pendingTip.page === pageIndex ? pendingTip.tip : null))
  const [hover, setHover] = useState<Point | null>(null)
  const phase1 = useRef(false)
  const size = { width: geometry.width, height: geometry.height }

  const setTip = (p: Point | null) => {
    pendingTip = p ? { docId: doc.id, page: pageIndex, tip: p } : null
    setTipState(p)
  }

  useKeys(!!tip || !!drag, (e) => {
    if (e.key === 'Escape') {
      setTip(null)
      setDrag(null)
      return true
    }
    return false
  })

  if (!tool) return null
  const isCallout = tool.kind === 'callout'

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const el = ref.current!
    const p = pagePoint(e, el, geometry)
    el.setPointerCapture(e.pointerId)
    if (isCallout && !tip) {
      if (pendingTip && pendingTip.docId === doc.id && pendingTip.page !== pageIndex) pendingTip = null
      setTip(p)
      phase1.current = true
    } else phase1.current = false
    setDrag({ a: p, b: p })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pagePoint(e, ref.current!, geometry)
    setHover(p)
    if (!drag) return
    setDrag({ a: drag.a, b: constrained(tool, drag.a, p, e.shiftKey) })
  }

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    const d = drag
    setDrag(null)
    if (!d) return
    const b = constrained(tool, d.a, pagePoint(e, ref.current!, geometry), e.shiftKey)
    const tiny = dist(d.a, b) < 3
    if (isCallout) {
      const t = tip ?? d.a
      if (phase1.current) {
        phase1.current = false
        // a click sets the tip; a drag from the tip places the box where the mouse is released
        if (tiny) return
        setTip(null)
        void createCallout(doc, tool, pageIndex, t, calloutBoxAt(t, b, CALLOUT_SIZE), size)
        return
      }
      setTip(null)
      void createCallout(doc, tool, pageIndex, t, tiny ? calloutBoxAt(t, d.a, CALLOUT_SIZE) : rectFrom(d.a, b), size)
      return
    }
    if (tool.kind === 'areaHighlight') {
      const r = rectFrom(d.a, b)
      if (r[2] - r[0] >= 3 && r[3] - r[1] >= 3) void createAreaHighlight(doc, tool, pageIndex, r)
      return
    }
    if (tiny && tool.kind !== 'textbox') return
    void createShape(doc, tool, pageIndex, d.a, b, size)
  }

  // ---- preview
  let preview: React.ReactNode = null
  if (isCallout && tip) {
    const at = drag && !phase1.current ? null : (drag?.b ?? hover)
    const box = drag && !phase1.current ? rectFrom(drag.a, drag.b) : at ? calloutBoxAt(tip, at, CALLOUT_SIZE) : null
    preview = box ? <CalloutPreview g={geometry} line={calloutLine(tip, box)} box={box} st={style} /> : null
    if (!box) preview = <circle cx={geometry.toCss(tip)[0]} cy={geometry.toCss(tip)[1]} r={4} fill={style.fontColor} />
  } else if (drag && dist(drag.a, drag.b) > 0) {
    if (tool.kind === 'line') preview = <LinePreview g={geometry} points={[drag.a, drag.b]} st={style} start={style.startEnd} end={style.endEnd} />
    else if (tool.kind === 'rect') preview = <RectPreview g={geometry} rect={rectFrom(drag.a, drag.b)} st={style} oval={tool.shape === 'Circle'} />
    else if (tool.kind === 'textbox') preview = <RectPreview g={geometry} rect={rectFrom(drag.a, drag.b)} st={{ ...style, color: style.fontColor, width: Math.max(0.5, style.width) }} />
    else if (tool.kind === 'areaHighlight')
      preview = (
        <g className="fc-markup-tools-multiply">
          <RectPreview g={geometry} rect={rectFrom(drag.a, drag.b)} st={{ ...style, fill: style.color, width: 0, lineStyle: 'solid' }} />
        </g>
      )
  }

  return (
    <div
      ref={ref}
      className="viewer-layer fc-markup-tools-layer fc-markup-tools-cursor-draw"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onPointerCancel={() => setDrag(null)}
    >
      {preview && <PreviewSvg geometry={geometry}>{preview}</PreviewSvg>}
      {isCallout && tip && !drag && (
        <div className="fc-markup-tools-tip" style={{ left: geometry.toCss(tip)[0] + 10, top: geometry.toCss(tip)[1] + 10 }}>
          Now click or drag where the text box goes (Esc cancels)
        </div>
      )}
    </div>
  )
}
