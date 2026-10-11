import { useRef, useState } from 'react'
import { Hand, MousePointer2, ZoomIn } from 'lucide-react'
import type { PageLayerProps, ToolDefinition } from '../app/registry'
import { CSS_PX_PER_POINT, rectFromPoints, type Point } from '@shared/geometry'

/** Hand tool: drag to pan. */
function HandLayer({ doc }: PageLayerProps) {
  const last = useRef<Point | null>(null)
  const [grabbing, setGrabbing] = useState(false)
  return (
    <div
      className="viewer-layer"
      style={{ cursor: grabbing ? 'grabbing' : 'grab' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        last.current = [e.clientX, e.clientY]
        setGrabbing(true)
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!last.current) return
        doc.view?.scrollBy(last.current[0] - e.clientX, last.current[1] - e.clientY)
        last.current = [e.clientX, e.clientY]
      }}
      onPointerUp={() => {
        last.current = null
        setGrabbing(false)
      }}
    />
  )
}

/** Marquee zoom: drag a rectangle to zoom into it; click to zoom in, Alt+click to zoom out. */
function ZoomLayer({ doc, geometry, pageIndex }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ a: Point; b: Point } | null>(null)
  const toLocal = (e: React.PointerEvent): Point => {
    const r = ref.current!.getBoundingClientRect()
    return [e.clientX - r.left, e.clientY - r.top]
  }
  return (
    <div
      ref={ref}
      className="viewer-layer"
      style={{ cursor: 'zoom-in' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        const p = toLocal(e)
        setDrag({ a: p, b: p })
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => drag && setDrag({ a: drag.a, b: toLocal(e) })}
      onPointerUp={(e) => {
        if (!drag) return
        const d = drag
        setDrag(null)
        const w = Math.abs(d.b[0] - d.a[0])
        const h = Math.abs(d.b[1] - d.a[1])
        const z = doc.state.zoom
        if (w < 6 || h < 6) {
          doc.view?.setZoom(e.altKey ? z / 1.5 : z * 1.5, { clientX: e.clientX, clientY: e.clientY })
          return
        }
        const vp = doc.view?.getViewportElement()
        if (!vp) return
        const factor = Math.min(vp.clientWidth / w, vp.clientHeight / h) * 0.95
        const nz = z * factor
        const rect = rectFromPoints(geometry.toPage(d.a), geometry.toPage(d.b))
        doc.view?.setZoom(nz)
        requestAnimationFrame(() => {
          const s = nz * CSS_PX_PER_POINT
          doc.view?.goToPage(pageIndex, { x: rect[0], y: rect[1] - 8 / s })
        })
      }}
    >
      {drag && (
        <div
          className="viewer-marquee"
          style={{
            left: Math.min(drag.a[0], drag.b[0]),
            top: Math.min(drag.a[1], drag.b[1]),
            width: Math.abs(drag.b[0] - drag.a[0]),
            height: Math.abs(drag.b[1] - drag.a[1])
          }}
        />
      )}
    </div>
  )
}

export const coreTools: ToolDefinition[] = [
  {
    id: 'select',
    label: 'Select text and objects',
    icon: MousePointer2,
    shortcut: 'V',
    allowDefaultInteractions: true
  },
  { id: 'hand', label: 'Hand tool', icon: Hand, shortcut: 'H', layer: HandLayer, cursor: 'grab' },
  { id: 'zoom', label: 'Marquee zoom', icon: ZoomIn, shortcut: 'Z', layer: ZoomLayer, cursor: 'zoom-in' }
]
