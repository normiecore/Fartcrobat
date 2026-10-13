/**
 * Polygon, connected lines and cloud: click to add points (Shift snaps to 45°), double-click,
 * Enter or clicking the first point finishes, Backspace removes the last point, Esc cancels.
 * A rubber band follows the pointer.
 */
import { useRef, useState } from 'react'
import { create } from 'zustand'
import type { Point } from '@shared/geometry'
import { toast, type DocumentModel, type PageLayerProps } from '@renderer/sdk'
import { createWith, finishCreate } from '../actions'
import { dist, snapAngle } from '../geometry'
import { LinePreview, PreviewSvg } from '../Preview'
import { getToolStyle, styleSpec } from '../style'
import { TOOL_BY_ID, type MarkupTool } from '../tools'
import { pagePoint, useActiveToolAndStyle, useKeys } from './shared'

interface PolyDraft {
  docId: string
  page: number
  toolId: string
  points: Point[]
}

/** The shape being drawn (one at a time); the toolbar's Finish button reads it too. */
export const usePolyDraft = create<{ draft: PolyDraft | null }>(() => ({ draft: null }))

export function cancelPolyDraft() {
  usePolyDraft.setState({ draft: null })
}

const minPoints = (tool: MarkupTool) => (tool.shape === 'PolyLine' ? 2 : 3)

/** Creates the annotation from the current draft. */
export async function finishPolyDraft(doc: DocumentModel) {
  const draft = usePolyDraft.getState().draft
  if (!draft || draft.docId !== doc.id) return
  const tool = TOOL_BY_ID.get(draft.toolId)
  if (!tool) return
  const points = draft.points.filter((p, i, all) => i === 0 || dist(p, all[i - 1]) > 0.5)
  if (points.length < minPoints(tool)) {
    toast(tool.shape === 'PolyLine' ? 'Add at least two points.' : 'Add at least three corners.', { kind: 'warning' })
    return
  }
  usePolyDraft.setState({ draft: null })
  const spec = styleSpec(tool, getToolStyle(tool.key))
  const created = await createWith(doc, tool, [{ page: draft.page, spec: { type: tool.shape!, vertices: points, ...spec } }])
  if (created) finishCreate(doc, tool, draft.page, [created[0].id])
}

export function PolyLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { tool, style } = useActiveToolAndStyle()
  const draft = usePolyDraft((s) => (s.draft && s.draft.docId === doc.id ? s.draft : null))
  const [hover, setHover] = useState<Point | null>(null)
  const mine = draft && draft.page === pageIndex ? draft : null

  useKeys(!!mine, (e) => {
    if (e.key === 'Escape') {
      cancelPolyDraft()
      return true
    }
    if (e.key === 'Enter') {
      void finishPolyDraft(doc)
      return true
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      const d = usePolyDraft.getState().draft
      if (d) usePolyDraft.setState({ draft: d.points.length > 1 ? { ...d, points: d.points.slice(0, -1) } : null })
      return true
    }
    return false
  })

  if (!tool) return null
  const closed = tool.shape === 'Polygon'

  const nextPoint = (e: { clientX: number; clientY: number; shiftKey: boolean }): Point => {
    const p = pagePoint(e, ref.current!, geometry)
    const last = mine?.points[mine.points.length - 1]
    return last && e.shiftKey ? snapAngle(last, p) : p
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if (draft && draft.page !== pageIndex) {
      toast('Finish or cancel the shape on the other page first (Enter finishes, Esc cancels).')
      return
    }
    const p = nextPoint(e)
    if (!mine || mine.toolId !== tool.id) {
      usePolyDraft.setState({ draft: { docId: doc.id, page: pageIndex, toolId: tool.id, points: [p] } })
      return
    }
    // clicking the first point closes the shape
    const first = mine.points[0]
    if (closed && mine.points.length >= 3 && dist(geometry.toCss(first), geometry.toCss(p)) <= 8) {
      void finishPolyDraft(doc)
      return
    }
    usePolyDraft.setState({ draft: { ...mine, points: [...mine.points, p] } })
  }

  const pts = mine ? [...mine.points, ...(hover ? [hover] : [])] : []
  const nearFirst = !!(mine && hover && closed && mine.points.length >= 3 && dist(geometry.toCss(mine.points[0]), geometry.toCss(hover)) <= 8)

  return (
    <div
      ref={ref}
      className="viewer-layer fc-markup-tools-layer fc-markup-tools-cursor-draw"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => setHover(nextPoint(e))}
      onPointerLeave={() => setHover(null)}
      onDoubleClick={() => {
        // the two clicks of the double-click already added the last point (duplicates are dropped)
        if (mine) void finishPolyDraft(doc)
      }}
      onContextMenu={(e) => {
        if (!mine) return
        e.preventDefault()
        void finishPolyDraft(doc)
      }}
    >
      {mine && (
        <PreviewSvg geometry={geometry}>
          {pts.length >= 2 && (
            <LinePreview
              g={geometry}
              points={nearFirst ? mine.points : pts}
              st={tool.key === 'cloud' ? { ...style, lineStyle: 'cloudy' } : style}
              closed={closed && (pts.length >= 3 || nearFirst)}
              start={closed ? undefined : style.startEnd}
              end={closed ? undefined : style.endEnd}
            />
          )}
          {mine.points.map((p, i) => {
            const c = geometry.toCss(p)
            return <circle key={i} className={`fc-markup-tools-vertex ${i === 0 && nearFirst ? 'is-target' : ''}`} cx={c[0]} cy={c[1]} r={i === 0 && nearFirst ? 6 : 3.5} />
          })}
        </PreviewSvg>
      )}
    </div>
  )
}
