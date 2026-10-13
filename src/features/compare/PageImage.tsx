import { useEffect, useRef } from 'react'
import { drawResult, renderQueueFor, usePageVersion, type DocumentModel } from '@renderer/sdk'

/** Largest bitmap drawn for one page (pixels); beyond this the page is scaled up by CSS. */
const MAX_PIXELS = 12_000_000

/**
 * A rendered page (contents and form fields, no comments), sized `cssWidth` x `cssHeight`.
 * Uses the document's render queue and cache.
 */
export function PageImage({
  doc,
  pageIndex,
  pageWidth,
  pageHeight,
  cssWidth,
  cssHeight,
  priority = 1,
  className
}: {
  doc: DocumentModel
  pageIndex: number
  pageWidth: number
  pageHeight: number
  cssWidth: number
  cssHeight: number
  priority?: number
  className?: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const version = usePageVersion(doc, pageIndex)
  const dpr = window.devicePixelRatio || 1
  const wanted = (cssWidth / Math.max(1, pageWidth)) * dpr
  const scale = Math.min(wanted, Math.sqrt(MAX_PIXELS / Math.max(1, pageWidth * pageHeight)))
  // Re-render only when the scale changes noticeably (zooming).
  const bucket = Math.round(Math.log2(Math.max(scale, 0.01)) * 8) / 8
  useEffect(() => {
    if (doc.isClosed) return
    const s = Math.pow(2, bucket)
    const key = `compare:p${pageIndex}:v${version}:s${s.toFixed(4)}`
    const req = renderQueueFor(doc).request(key, pageIndex, { scale: s, annots: false }, priority)
    let alive = true
    req.promise.then((r) => {
      if (alive && r && ref.current) drawResult(ref.current, r)
    })
    return () => {
      alive = false
      req.cancel()
    }
    // priority changes should not restart renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageIndex, version, bucket])
  return <canvas ref={ref} className={className} style={{ width: cssWidth, height: cssHeight }} aria-hidden="true" />
}
