import { useRef, useState } from 'react'
import { create } from 'zustand'
import type { Point, Rect } from '@shared/geometry'
import { rectFromPoints } from '@shared/geometry'
import { Button, openDialog, setTool, type DocumentModel, type PageLayerProps } from '@renderer/sdk'
import { useListing } from '../store'
import { toUnit, UNIT_LABELS } from '../shared'
import { PageBoxesDialog } from './PageBoxesDialog'
import { useUnit } from './common'
import { removeCrop } from '../actions'

/** The rectangle drawn with the Crop tool, kept on screen while the dialog is open. */
const useDraft = create<{ docId: string | null; page: number; rect: Rect | null }>(() => ({
  docId: null,
  page: -1,
  rect: null
}))

export async function openPageBoxes(doc: DocumentModel, page: number, selection?: Rect) {
  if (selection) useDraft.setState({ docId: doc.id, page, rect: selection })
  try {
    await openDialog<boolean>((close) => (
      <PageBoxesDialog doc={doc} initialPage={page} selection={selection} close={close} />
    ))
  } finally {
    useDraft.setState({ docId: null, page: -1, rect: null })
  }
}

export function CropLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ a: Point; b: Point } | null>(null)
  const draft = useDraft((s) => (s.docId === doc.id && s.page === pageIndex ? s.rect : null))
  const unit = useUnit()
  const clampToPage = (p: Point): Point => [
    Math.max(0, Math.min(geometry.width, p[0])),
    Math.max(0, Math.min(geometry.height, p[1]))
  ]
  const rect = drag ? rectFromPoints(drag.a, drag.b) : draft
  const css = rect ? geometry.rectToCss(rect) : null
  return (
    <div
      ref={ref}
      className="viewer-layer fc-page-marks-crop-layer"
      data-testid="crop-layer"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const p = clampToPage(geometry.eventToPage(e, ref.current!))
        setDrag({ a: p, b: p })
        ref.current!.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        if (!drag) return
        setDrag({ a: drag.a, b: clampToPage(geometry.eventToPage(e, ref.current!)) })
      }}
      onPointerCancel={() => setDrag(null)}
      onPointerUp={() => {
        if (!drag) return
        const r = rectFromPoints(drag.a, drag.b)
        setDrag(null)
        if (geometry.len(r[2] - r[0]) < 8 || geometry.len(r[3] - r[1]) < 8) return
        void openPageBoxes(doc, pageIndex, r)
      }}
    >
      {css && rect && (
        <div
          className="fc-page-marks-crop-rect"
          style={{ left: css.left, top: css.top, width: css.width, height: css.height }}
        >
          <span className="fc-page-marks-crop-size">
            {toUnit(rect[2] - rect[0], unit)} × {toUnit(rect[3] - rect[1], unit)} {UNIT_LABELS[unit]}
          </span>
        </div>
      )}
    </div>
  )
}

export function CropToolbar({ doc }: { doc: DocumentModel }) {
  const listing = useListing(doc)
  return (
    <div className="fc-page-marks-toolbar" role="group" aria-label="Crop pages">
      <span className="fc-page-marks-toolbar-hint">Drag a rectangle on a page to crop it.</span>
      <Button size="sm" onClick={() => void openPageBoxes(doc, doc.state.currentPage)}>
        Set Page Boxes…
      </Button>
      <Button size="sm" disabled={!listing.croppedPages.length} onClick={() => void removeCrop(doc)}>
        Remove Crop
      </Button>
      <Button size="sm" variant="primary" onClick={() => setTool('select')}>
        Done
      </Button>
    </div>
  )
}
