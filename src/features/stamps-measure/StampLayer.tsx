import { useEffect, useRef, useState } from 'react'
import type { Point, Rect } from '@shared/geometry'
import { useDocState, type PageLayerProps } from '@renderer/sdk'
import { clickRect, dragRect, placeStamp } from './stampPlace'
import { useStampPreview } from './stampRender'
import { loadStamps, useCurrentStamp } from './stampStore'

/** Stamp tool: shows the stamp under the pointer; click places it, drag sets its size. */
export function StampLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const def = useCurrentStamp()
  const preview = useStampPreview(def, doc)
  const viewRotation = useDocState(doc, (s) => s.viewRotation)
  const [hover, setHover] = useState<Point | null>(null)
  const [drag, setDrag] = useState<{ a: Point; b: Point; moved: boolean } | null>(null)
  const busy = useRef(false)

  useEffect(() => {
    void loadStamps()
  }, [])

  const toPage = (e: { clientX: number; clientY: number }): Point => {
    const p = geometry.eventToPage(e, ref.current!)
    return [Math.max(0, Math.min(geometry.width, p[0])), Math.max(0, Math.min(geometry.height, p[1]))]
  }

  let ghost: Rect | null = null
  if (drag?.moved) ghost = dragRect(def, drag.a, drag.b, geometry.width, geometry.height)
  else if (hover && !drag) ghost = clickRect(def, hover, geometry.width, geometry.height)

  const place = async (rect: Rect) => {
    if (busy.current) return
    busy.current = true
    try {
      await placeStamp(doc, pageIndex, def, rect)
    } finally {
      busy.current = false
    }
  }

  let ghostEl = null
  if (ghost && preview) {
    const css = geometry.rectToCss(ghost)
    // The image is drawn upright on the page: turn it with the view.
    const w = geometry.len(ghost[2] - ghost[0])
    const h = geometry.len(ghost[3] - ghost[1])
    ghostEl = (
      <img
        className="fc-stamps-measure-ghost"
        src={preview}
        alt=""
        draggable={false}
        style={{
          left: css.left + css.width / 2,
          top: css.top + css.height / 2,
          width: w,
          height: h,
          transform: `translate(-50%, -50%) rotate(${viewRotation}deg)`
        }}
      />
    )
  }

  return (
    <div
      ref={ref}
      className="viewer-layer fc-stamps-measure-stamp-layer"
      data-testid="stamp-layer"
      onPointerMove={(e) => {
        const p = toPage(e)
        if (drag) {
          // a drag starts once the pointer moved more than 4 screen pixels
          const dist = geometry.len(Math.hypot(p[0] - drag.a[0], p[1] - drag.a[1]))
          setDrag({ a: drag.a, b: p, moved: drag.moved || dist > 4 })
        } else setHover(p)
      }}
      onPointerLeave={() => !drag && setHover(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const p = toPage(e)
        setDrag({ a: p, b: p, moved: false })
        ref.current?.setPointerCapture(e.pointerId)
      }}
      onPointerUp={(e) => {
        if (!drag) return
        const d = drag
        setDrag(null)
        const p = toPage(e)
        const rect = d.moved ? dragRect(def, d.a, p, geometry.width, geometry.height) : clickRect(def, d.a, geometry.width, geometry.height)
        setHover(null)
        void place(rect)
      }}
      onPointerCancel={() => setDrag(null)}
    >
      {ghostEl}
      {drag?.moved && ghost && (
        <div className="fc-stamps-measure-ghost-frame" style={{ ...geometry.rectToCss(ghost) }} />
      )}
    </div>
  )
}
