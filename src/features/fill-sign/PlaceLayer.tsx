import { useEffect, useState } from 'react'
import type { Point, Rect } from '@shared/geometry'
import type formOps from '@engine/ops/forms'
import { usePageVersion, type PageLayerProps } from '@renderer/sdk'
import { clampRectToPage, rectAround, rectContains } from './shared'
import { useFillSign } from './state'
import { fieldPlacement, naturalSize, placeSignature } from './actions'

/** Unsigned signature fields of a page (page space), where a signature snaps into place. */
function useSignatureFields(props: PageLayerProps): Rect[] {
  const { doc, pageIndex } = props
  const version = usePageVersion(doc, pageIndex)
  const [fields, setFields] = useState<Rect[]>([])
  useEffect(() => {
    let alive = true
    doc
      .ops<typeof formOps>('forms')
      .list(pageIndex)
      .then((list) => {
        if (alive) setFields(list.filter((f) => f.type === 'signature' && !f.signed && !f.hidden && !f.readOnly).map((f) => f.rect))
      })
      .catch(() => alive && setFields([]))
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])
  return fields
}

/**
 * Tool layer of fillsign.place: the chosen signature follows the pointer as a ghost; a click
 * places it there. Over an unsigned signature field it snaps into the field (fitted and centred).
 * Esc switches back to the previous tool.
 */
export function PlaceLayer(props: PageLayerProps) {
  const { doc, pageIndex, geometry } = props
  const placing = useFillSign((s) => s.placing)
  const fields = useSignatureFields(props)
  const [point, setPoint] = useState<Point | null>(null)
  const local = (e: React.PointerEvent): Point => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return geometry.toPage([e.clientX - b.left, e.clientY - b.top])
  }
  if (!placing) return <div className="viewer-layer" />
  const field = point ? fields.find((f) => rectContains(f, point)) : undefined
  const rectAt = (p: Point, inField: Rect | undefined): Rect => {
    if (inField) return fieldPlacement(placing.image, inField)
    const [w, h] = naturalSize(placing.kind, placing.image, geometry.width)
    return clampRectToPage(rectAround(p, w, h), geometry.width, geometry.height)
  }
  const rect = point ? rectAt(point, field) : null
  const tl = rect ? geometry.toCss([rect[0], rect[1]]) : null
  const fieldCss = field ? geometry.rectToCss(field) : null
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
        const inField = fields.find((f) => rectContains(f, p))
        setPoint(null)
        void placeSignature(doc, pageIndex, p, inField ? rectAt(p, inField) : undefined)
      }}
    >
      {fieldCss && (
        <div
          className="fc-fill-sign-place-field"
          style={{ left: fieldCss.left, top: fieldCss.top, width: fieldCss.width, height: fieldCss.height }}
        />
      )}
      {tl && rect && (
        <img
          className={`fc-fill-sign-ghost-signature ${field ? 'is-in-field' : ''}`}
          src={placing.image.dataUrl}
          alt=""
          draggable={false}
          style={{
            left: tl[0],
            top: tl[1],
            width: (rect[2] - rect[0]) * geometry.scale,
            height: (rect[3] - rect[1]) * geometry.scale,
            transform: geometry.rotation ? `rotate(${geometry.rotation}deg)` : undefined
          }}
        />
      )}
    </div>
  )
}
