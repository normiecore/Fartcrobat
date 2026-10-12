/**
 * Highlight / Underline / Strikethrough / Squiggly / Replace text: drag across text (also across
 * pages) with a live preview of the markup; double-click marks one word. On pages without text the
 * Highlight tool falls back to highlighting a rectangular area.
 */
import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { Point, Quad, Rect } from '@shared/geometry'
import {
  caretAt,
  getLoadedText,
  rangeQuads,
  toast,
  usePageVersion,
  wordAt,
  type DocumentModel,
  type PageLayerProps,
  type PageText,
  type TextRange
} from '@renderer/sdk'
import { applyTextMarkup, createWith, finishCreate } from '../actions'
import { quadFromRect, rectFrom } from '../geometry'
import { MarkupPreview, PreviewSvg, RectPreview } from '../Preview'
import { getToolStyle, styleSpec } from '../style'
import { TOOL_BY_ID, type MarkupTool } from '../tools'
import { autoScroll, pagePoint, pageTextOrReport, useActiveToolAndStyle } from './shared'

interface Caret {
  page: number
  index: number
}

interface TextDrag {
  docId: string
  toolId: string
  anchor: Caret
  focus: Caret
  startClient: Point
  moved: boolean
}

/** One drag at a time, shared by the page layers so the preview can span pages. */
export const useTextDrag = create<{ drag: TextDrag | null }>(() => ({ drag: null }))

function hasText(t: PageText): boolean {
  return /\S/.test(t.text)
}

export function rangesBetween(doc: DocumentModel, a: Caret, b: Caret): TextRange[] {
  const [s, e] = a.page < b.page || (a.page === b.page && a.index <= b.index) ? [a, b] : [b, a]
  if (s.page === e.page) return s.index === e.index ? [] : [{ page: s.page, start: s.index, end: e.index }]
  const len = (p: number) => getLoadedText(doc, p)?.text.length ?? 1e9
  const ranges: TextRange[] = [{ page: s.page, start: s.index, end: len(s.page) }]
  for (let p = s.page + 1; p < e.page; p++) ranges.push({ page: p, start: 0, end: len(p) })
  ranges.push({ page: e.page, start: 0, end: e.index })
  return ranges.filter((r) => r.end > r.start)
}

let noTextHintShown = false

export function TextMarkupLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { tool, style } = useActiveToolAndStyle()
  const version = usePageVersion(doc, pageIndex)
  const [text, setText] = useState<PageText | null>(() => getLoadedText(doc, pageIndex))
  const drag = useTextDrag((s) => (s.drag && s.drag.docId === doc.id ? s.drag : null))
  const [area, setArea] = useState<{ a: Point; b: Point } | null>(null)

  useEffect(() => {
    let alive = true
    const cached = getLoadedText(doc, pageIndex)
    if (cached) setText(cached)
    else
      void pageTextOrReport(doc, pageIndex).then((t) => {
        if (alive && t) setText(t)
      })
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])

  if (!tool) return null
  const noText = text !== null && !hasText(text)
  const areaMode = noText && tool.markup === 'Highlight'

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const el = ref.current!
    const p = pagePoint(e, el, geometry)
    const t = getLoadedText(doc, pageIndex)
    if (!t) {
      // still loading: the next press works
      void pageTextOrReport(doc, pageIndex).then((tt) => tt && setText(tt))
      return
    }
    el.setPointerCapture(e.pointerId)
    if (!hasText(t)) {
      if (tool.markup === 'Highlight') {
        if (!noTextHintShown) {
          noTextHintShown = true
          toast('This page has no selectable text, so you can highlight an area instead. Use Scan & OCR to make the text selectable.')
        }
        setArea({ a: p, b: p })
      } else {
        toast('This page has no selectable text. Use Scan & OCR to make its text selectable.', { kind: 'warning' })
      }
      return
    }
    const index = Math.max(0, caretAt(t, p))
    useTextDrag.setState({
      drag: { docId: doc.id, toolId: tool.id, anchor: { page: pageIndex, index }, focus: { page: pageIndex, index }, startClient: [e.clientX, e.clientY], moved: false }
    })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const el = ref.current!
    if (area) {
      setArea({ a: area.a, b: pagePoint(e, el, geometry) })
      return
    }
    const d = useTextDrag.getState().drag
    if (!d || d.docId !== doc.id) {
      const t = getLoadedText(doc, pageIndex)
      el.style.cursor = !t || hasText(t) ? 'text' : tool.markup === 'Highlight' ? 'crosshair' : 'not-allowed'
      return
    }
    const moved = d.moved || Math.hypot(e.clientX - d.startClient[0], e.clientY - d.startClient[1]) >= 3
    if (!moved) return
    const hit = doc.view?.hitTest(e.clientX, e.clientY)
    if (!hit) return
    const t = getLoadedText(doc, hit.pageIndex)
    if (!t) {
      void pageTextOrReport(doc, hit.pageIndex)
      return
    }
    const focus = { page: hit.pageIndex, index: Math.max(0, caretAt(t, hit.point)) }
    useTextDrag.setState({ drag: { ...d, focus, moved: true } })
    autoScroll(doc, e)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    if (area) {
      const r = rectFrom(area.a, area.b)
      setArea(null)
      if (r[2] - r[0] >= 3 && r[3] - r[1] >= 3) void createAreaHighlight(doc, tool, pageIndex, r)
      return
    }
    const d = useTextDrag.getState().drag
    if (!d || d.docId !== doc.id) return
    useTextDrag.setState({ drag: null })
    if (!d.moved) return
    const ranges = rangesBetween(doc, d.anchor, d.focus)
    if (ranges.length) void applyTextMarkup(doc, TOOL_BY_ID.get(d.toolId) ?? tool, ranges)
  }

  // live preview of the markup on this page
  let quads: Quad[] = []
  if (drag && drag.moved && text) {
    const r = rangesBetween(doc, drag.anchor, drag.focus).find((x) => x.page === pageIndex)
    if (r) quads = rangeQuads(text, r.start, Math.min(r.end, text.text.length))
  }
  const kind = tool.markup ?? 'StrikeOut'

  return (
    <div
      ref={ref}
      className="viewer-layer fc-markup-tools-layer"
      style={{ cursor: areaMode ? 'crosshair' : 'text' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setArea(null)
        useTextDrag.setState({ drag: null })
      }}
      onDoubleClick={(e) => {
        // double-click marks the word under the pointer
        const t = getLoadedText(doc, pageIndex)
        if (!t || !hasText(t)) return
        const idx = caretAt(t, pagePoint(e, ref.current!, geometry))
        const w = idx >= 0 ? wordAt(t, Math.min(idx, t.text.length - 1)) : null
        if (w && /\S/.test(t.text.slice(w.start, w.end))) void applyTextMarkup(doc, tool, [{ page: pageIndex, start: w.start, end: w.end }])
      }}
    >
      {(quads.length > 0 || area) && (
        <PreviewSvg geometry={geometry}>
          {quads.length > 0 && <MarkupPreview g={geometry} quads={quads} kind={kind} color={style.color} opacity={kind === 'Highlight' ? Math.min(style.opacity, 0.85) : style.opacity} />}
          {area && (
            <g className="fc-markup-tools-multiply">
              <RectPreview g={geometry} rect={rectFrom(area.a, area.b)} st={{ ...style, fill: style.color, color: style.color, width: 0, lineStyle: 'solid' }} />
            </g>
          )}
        </PreviewSvg>
      )}
    </div>
  )
}

/** Highlight area: a Highlight annotation with one rectangular quad and a crisp appearance. */
export async function createAreaHighlight(doc: DocumentModel, tool: MarkupTool, page: number, rect: Rect) {
  const areaTool = TOOL_BY_ID.get('comment.areaHighlight')!
  // The Highlight text tool on a page without text uses its own colour; the area tool its own.
  const st = getToolStyle(tool.key)
  const created = await createWith(doc, tool.kind === 'areaHighlight' ? tool : { ...areaTool, undoLabel: 'Add Highlight' }, [
    {
      page,
      spec: { type: 'Highlight', quads: [quadFromRect(rect)], ...styleSpec(tool, st), extra: { fartcrobat: 'areaHighlight' } },
      rectAppearance: true
    }
  ])
  if (created) finishCreate(doc, tool, page, created.map((a) => a.id))
}
