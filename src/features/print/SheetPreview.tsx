import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { DocumentModel } from '@renderer/sdk'
import { drawSheet, PageImageCache, PrintCancelled } from './compose'
import type { Sheet } from './imposition'
import type { PrintContent } from './settings'

const PAD = 12

/**
 * Live preview of one sheet, drawn with the same code that renders sheets for the printer.
 */
export function SheetPreview({
  doc,
  sheet,
  content,
  grayscale,
  saveInk,
  message,
  label
}: {
  doc: DocumentModel
  sheet: Sheet | null
  content: PrintContent
  grayscale: boolean
  saveInk: boolean
  /** Shown instead of a sheet (e.g. an invalid page range). */
  message: string | null
  label: string
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const token = useRef(0)
  const cache = useMemo(() => new PageImageCache(doc, content, grayscale, 48), [doc, content, grayscale])
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => () => cache.clear(), [cache])

  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fit = sheet && box.w > 0 && box.h > 0 ? Math.min((box.w - 2 * PAD) / sheet.width, (box.h - 2 * PAD) / sheet.height) : 0
  const cssW = sheet ? Math.max(1, Math.round(sheet.width * fit)) : 0
  const cssH = sheet ? Math.max(1, Math.round(sheet.height * fit)) : 0

  useEffect(() => {
    const my = ++token.current
    if (!sheet || fit <= 0) {
      setBusy(false)
      return
    }
    setBusy(true)
    const timer = setTimeout(async () => {
      const dpr = window.devicePixelRatio || 1
      const k = fit * dpr
      try {
        const off = new OffscreenCanvas(Math.max(1, Math.round(sheet.width * k)), Math.max(1, Math.round(sheet.height * k)))
        const octx = off.getContext('2d')
        if (!octx) throw new Error('Could not draw the preview')
        await drawSheet(octx, sheet, k, (page, scale) => cache.get(page, scale), {
          saveInk,
          cancelled: () => token.current !== my
        })
        if (token.current !== my) return
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = off.width
        canvas.height = off.height
        canvas.getContext('2d')!.drawImage(off, 0, 0)
        setError(null)
        setShown(true)
        setBusy(false)
      } catch (err) {
        if (err instanceof PrintCancelled || token.current !== my) return
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      }
    }, 40)
    return () => clearTimeout(timer)
  }, [sheet, fit, cache, saveInk])

  const text = message ?? error
  return (
    <div className="fc-print-preview-box" ref={boxRef}>
      {text && (
        <div className="fc-print-preview-message" role="status">
          {text}
        </div>
      )}
      <canvas
        ref={canvasRef}
        hidden={!!text || !sheet}
        className={`fc-print-preview-canvas ${shown ? '' : 'is-pending'}`}
        role="img"
        aria-label={label}
        data-pages={sheet?.placements.length ?? 0}
        data-busy={busy ? 'true' : 'false'}
        style={{ width: cssW, height: cssH }}
      />
      {busy && !text && <div className="fc-print-preview-spinner" aria-hidden="true" />}
    </div>
  )
}
