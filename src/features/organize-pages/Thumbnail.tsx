import { memo, useEffect, useRef } from 'react'
import { FilePlus2, RotateCcw, RotateCw, Trash2 } from 'lucide-react'
import { drawResult, renderQueueFor, useDocState, usePageVersion, type DocumentModel } from '@renderer/sdk'
import type { PageInfo } from '@shared/types'

export interface ThumbProps {
  doc: DocumentModel
  index: number
  page: PageInfo
  left: number
  top: number
  cellWidth: number
  thumb: number
  selected: boolean
  focused: boolean
  dragging: boolean
  priority: number
  onQuick: (
    action: 'rotateLeft' | 'rotateRight' | 'delete' | 'insertAfter',
    index: number,
    e: React.MouseEvent
  ) => void
}

/** Size of the page image inside a thumb x thumb box. */
export function fitPage(page: { width: number; height: number }, thumb: number) {
  const w = Math.max(1, page.width)
  const h = Math.max(1, page.height)
  return w >= h
    ? { width: thumb, height: Math.max(8, Math.round((thumb * h) / w)) }
    : { width: Math.max(8, Math.round((thumb * w) / h)), height: thumb }
}

export const Thumbnail = memo(function Thumbnail({
  doc,
  index,
  page,
  left,
  top,
  cellWidth,
  thumb,
  selected,
  focused,
  dragging,
  priority,
  onQuick
}: ThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawnSize = useRef('')
  const version = usePageVersion(doc, index)
  const annots = useDocState(doc, (s) => s.showAnnotations)
  const box = fitPage(page, thumb)
  const dpr = window.devicePixelRatio || 1
  // Render at the displayed size, rounded to steps so small slider moves reuse bitmaps.
  const step = Math.max(40, Math.ceil(Math.max(box.width, box.height) / 40) * 40)
  const scale = (step * dpr) / Math.max(page.width, page.height)
  const sizeKey = `${Math.round(page.width)}x${Math.round(page.height)}`

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    if (drawnSize.current !== sizeKey) canvas.style.opacity = '0'
    const req = renderQueueFor(doc).request(
      `org:${page.id}:v${version}:s${scale.toFixed(4)}:a${annots}`,
      index,
      { scale, annots },
      priority
    )
    let alive = true
    void req.promise.then((r) => {
      if (!alive || !r || !canvasRef.current) return
      drawResult(canvasRef.current, r)
      canvasRef.current.style.opacity = '1'
      drawnSize.current = sizeKey
    })
    return () => {
      alive = false
      req.cancel()
    }
    // priority only orders the queue; changing it should not restart rendering
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page.id, index, version, scale, annots, sizeKey])

  const label = page.label && page.label !== String(index + 1) ? page.label : null
  const quick = (action: Parameters<ThumbProps['onQuick']>[0], title: string, Icon: typeof RotateCw) => (
    <button
      type="button"
      className="fc-organize-pages-quick-btn"
      data-quick
      title={title}
      aria-label={`${title} (page ${index + 1})`}
      tabIndex={-1}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation()
        onQuick(action, index, e)
      }}
    >
      <Icon size={15} />
    </button>
  )

  return (
    <div
      id={`fc-organize-pages-cell-${doc.id}-${page.id}`}
      className={`fc-organize-pages-cell ${selected ? 'is-selected' : ''} ${focused ? 'is-focused' : ''} ${dragging ? 'is-dragging' : ''}`}
      style={{ left, top, width: cellWidth }}
      data-org-index={index}
      role="option"
      aria-selected={selected}
      aria-label={`Page ${index + 1}${label ? ` (${label})` : ''}${page.rotation ? `, rotated ${page.rotation}°` : ''}`}
      title={`Page ${index + 1}${label ? ` — labelled “${label}”` : ''} · ${Math.round((page.width / 72) * 100) / 100} × ${Math.round((page.height / 72) * 100) / 100} in`}
    >
      <div className="fc-organize-pages-box" style={{ height: thumb + 12 }}>
        <div className="fc-organize-pages-page" style={{ width: box.width, height: box.height }}>
          <canvas ref={canvasRef} className="fc-organize-pages-canvas" />
        </div>
        <div className="fc-organize-pages-quick" role="toolbar" aria-label={`Page ${index + 1} actions`}>
          {quick('rotateLeft', 'Rotate counterclockwise', RotateCcw)}
          {quick('rotateRight', 'Rotate clockwise', RotateCw)}
          {quick('delete', 'Delete page', Trash2)}
          {quick('insertAfter', 'Insert pages after this page', FilePlus2)}
        </div>
      </div>
      <div className="fc-organize-pages-label">
        <span className="fc-organize-pages-num">{label ?? index + 1}</span>
        {label && <span className="fc-organize-pages-sub">{index + 1}</span>}
      </div>
    </div>
  )
})
