import { useState } from 'react'
import type { Point } from '@shared/geometry'
import type { PageLayerProps } from '@renderer/sdk'
import { clampRectToPage, rectAround } from './shared'
import { useFillSign } from './state'
import { naturalSize, placeSignature } from './actions'

/**
 * Tool layer of fillsign.place: the chosen signature follows the pointer as a ghost; a click
 * places it there. Esc (handled by the core) switches back to the previous tool.
 */
export function PlaceLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const placing = useFillSign((s) => s.placing)
  const [point, setPoint] = useState<Point | null>(null)
  const local = (e: React.PointerEvent): Point => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return geometry.toPage([e.clientX - b.left, e.clientY - b.top])
  }
  if (!placing) return <div className="viewer-layer" />
  const [w, h] = naturalSize(placing.kind, placing.image, geometry.width)
  const rect = point ? clampRectToPage(rectAround(point, w, h), geometry.width, geometry.height) : null
  const tl = rect ? geometry.toCss([rect[0], rect[1]]) : null
  return (
    <div
      className="viewer-layer fc-fill-sign-place"
      onPointerMove={(e) => setPoint(local(e))}
      onPointerEnter={(e) => setPoint(local(e))}
      onPointerLeave={() => setPoint(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const p = local(e)
        setPoint(null)
        void placeSignature(doc, pageIndex, p)
      }}
    >
      {tl && (
        <img
          className="fc-fill-sign-ghost-signature"
          src={placing.image.dataUrl}
          alt=""
          draggable={false}
          style={{
            left: tl[0],
            top: tl[1],
            width: w * geometry.scale,
            height: h * geometry.scale,
            transform: geometry.rotation ? `rotate(${geometry.rotation}deg)` : undefined
          }}
        />
      )}
    </div>
  )
}
