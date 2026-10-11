import { useEffect, useRef } from 'react'
import { usePageVersion, type DocumentModel } from '../document/DocumentModel'
import { useApp } from '../app/store'
import type { PageGeometry } from './geometry'
import { drawResult, renderQueueFor } from './renderQueue'
import type { CssRect } from './geometry'

/** Max pixels for the full-page base bitmap; above this, a sharp detail tile covers the viewport. */
const MAX_BASE_PIXELS = 8_000_000

export function PageCanvas({
  doc,
  pageIndex,
  geometry,
  priority,
  visibleRect,
  hidden
}: {
  doc: DocumentModel
  pageIndex: number
  geometry: PageGeometry
  priority: number
  /** Visible part of the page in CSS px (relative to the page), for the detail tile. */
  visibleRect: CssRect | null
  /** Annotation ids to hide (while being dragged). */
  hidden?: number[]
}) {
  const baseRef = useRef<HTMLCanvasElement>(null)
  const detailRef = useRef<HTMLCanvasElement>(null)
  const version = usePageVersion(doc, pageIndex)
  const colorMode = useApp((s) => s.prefs.pageColors)
  const dpr = window.devicePixelRatio || 1
  const desired = geometry.scale * dpr
  const area = geometry.width * geometry.height
  const baseScale = Math.min(desired, Math.sqrt(MAX_BASE_PIXELS / Math.max(1, area)))
  const needsDetail = baseScale < desired * 0.97
  const hiddenKey = hidden?.length ? hidden.join(',') : ''

  // Base layer: whole page.
  useEffect(() => {
    const q = renderQueueFor(doc)
    const key = `p${pageIndex}:v${version}:s${baseScale.toFixed(4)}:r${geometry.rotation}:${colorMode}:h${hiddenKey}`
    const req = q.request(
      key,
      pageIndex,
      { scale: baseScale, rotate: geometry.rotation, colorMode, hide: hidden },
      priority
    )
    let alive = true
    req.promise.then((r) => {
      if (alive && r && baseRef.current) drawResult(baseRef.current, r)
    })
    return () => {
      alive = false
      req.cancel()
    }
    // priority intentionally excluded: re-prioritising should not restart renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageIndex, version, baseScale, geometry.rotation, colorMode, hiddenKey])

  // Detail tile: sharp rendering of the visible region at high zoom.
  const vr = visibleRect
  const tileKey = needsDetail && vr ? [vr.left, vr.top, vr.width, vr.height].map((v) => Math.round(v / 64)).join(',') : ''
  useEffect(() => {
    const canvas = detailRef.current
    if (!canvas) return
    if (!needsDetail || !vr) {
      canvas.style.display = 'none'
      return
    }
    const margin = 128
    const clip = {
      left: Math.max(0, vr.left - margin),
      top: Math.max(0, vr.top - margin),
      right: Math.min(geometry.cssWidth, vr.left + vr.width + margin),
      bottom: Math.min(geometry.cssHeight, vr.top + vr.height + margin)
    }
    const q = renderQueueFor(doc)
    const key = `d${pageIndex}:v${version}:s${desired.toFixed(4)}:r${geometry.rotation}:${colorMode}:${tileKey}:h${hiddenKey}`
    let alive = true
    const timer = window.setTimeout(() => {
      const req = q.request(
        key,
        pageIndex,
        {
          scale: desired,
          rotate: geometry.rotation,
          colorMode,
          hide: hidden,
          clip: [clip.left * dpr, clip.top * dpr, clip.right * dpr, clip.bottom * dpr]
        },
        priority - 0.5
      )
      cancel = req.cancel
      req.promise.then((r) => {
        if (!alive || !r || !detailRef.current) return
        drawResult(detailRef.current, r)
        const c = detailRef.current
        c.style.display = 'block'
        c.style.left = `${r.x / dpr}px`
        c.style.top = `${r.y / dpr}px`
        c.style.width = `${r.width / dpr}px`
        c.style.height = `${r.height / dpr}px`
      })
    }, 120)
    let cancel = () => {}
    return () => {
      alive = false
      window.clearTimeout(timer)
      cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageIndex, version, desired, needsDetail, tileKey, geometry.rotation, colorMode, hiddenKey])

  return (
    <>
      <canvas ref={baseRef} className="viewer-page-canvas" style={{ width: geometry.cssWidth, height: geometry.cssHeight }} />
      <canvas ref={detailRef} className="viewer-page-detail" style={{ display: 'none' }} />
    </>
  )
}
