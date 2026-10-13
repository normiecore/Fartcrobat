import { useEffect, useRef, useState } from 'react'
import { ImagePlus } from 'lucide-react'
import type { Point, Rect } from '@shared/geometry'
import { Button, basename, getActiveDoc, registry, showError, useApp, type DocumentModel, type PageLayerProps } from '@renderer/sdk'
import { ADD_IMAGE_TOOL, EDIT_CONTENT_TOOL, ops, returnToEditTool, selectImage, useUi, type PendingImage } from './common'
import { loadImageBytes, pickImageFile } from './imageActions'

/** Margin kept free around an image that is scaled down to fit the page. */
const FIT_MARGIN = 18

let choosing = false

/** Asks for an image file and keeps it ready to be placed. Returns false when cancelled. */
export async function chooseImageToAdd(doc: DocumentModel | null): Promise<boolean> {
  if (!doc || choosing) return false
  choosing = true
  try {
    const file = await pickImageFile('Add Image')
    if (!file) return false
    const info = await loadImageBytes(doc, file.bytes)
    const blob = new Blob([info.bytes as Uint8Array<ArrayBuffer>])
    const prev = useUi.getState().pending
    if (prev) URL.revokeObjectURL(prev.url)
    useUi.setState({
      pending: {
        bytes: info.bytes,
        name: basename(file.path),
        width: info.width,
        height: info.height,
        dpiX: info.dpiX,
        dpiY: info.dpiY,
        url: URL.createObjectURL(blob)
      }
    })
    return true
  } catch (err) {
    showError(err, 'Could not add the image')
    return false
  } finally {
    choosing = false
  }
}

export function clearPending() {
  const p = useUi.getState().pending
  if (p) URL.revokeObjectURL(p.url)
  useUi.setState({ pending: null })
}

/** Called when the Add Image tool is activated: pick a file, or go back when cancelled. */
export async function activateAddImage() {
  if (useUi.getState().pending) return
  const ok = await chooseImageToAdd(getActiveDoc())
  if (!ok && useApp.getState().toolId === ADD_IMAGE_TOOL) returnToEditTool()
}

/** Natural size in points (from the image's resolution), scaled down to fit the page. */
export function naturalSize(p: PendingImage, pageW: number, pageH: number): [number, number] {
  let w = (p.width * 72) / (p.dpiX || 72)
  let h = (p.height * 72) / (p.dpiY || 72)
  const maxW = Math.max(10, pageW - 2 * FIT_MARGIN)
  const maxH = Math.max(10, pageH - 2 * FIT_MARGIN)
  const s = Math.min(1, maxW / w, maxH / h)
  w *= s
  h *= s
  return [w, h]
}

/** Places the image with its top-left corner at `at`, kept inside the page. */
function placeAt(at: Point, size: [number, number], pageW: number, pageH: number): Rect {
  const x = Math.max(0, Math.min(pageW - size[0], at[0]))
  const y = Math.max(0, Math.min(pageH - size[1], at[1]))
  return [x, y, x + size[0], y + size[1]]
}

async function place(doc: DocumentModel, page: number, rect: Rect) {
  const pending = useUi.getState().pending
  if (!pending) return
  try {
    const img = await ops(doc).addImage(page, pending.bytes, rect)
    clearPending()
    returnToEditTool()
    // the new image is shown selected in Edit text & images mode
    if (img && registry.tools.has(EDIT_CONTENT_TOOL)) selectImage(doc, page, img)
  } catch (err) {
    showError(err, 'Could not add the image')
  }
}

export function AddImageLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const pending = useUi((s) => s.pending)
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const [drag, setDrag] = useState<{ a: Point; b: Point; free: boolean } | null>(null)
  const pageW = geometry.width
  const pageH = geometry.height

  useEffect(() => {
    if (!pending) setDrag(null)
  }, [pending])

  if (!pending) return <div className="viewer-layer" />
  const natural = naturalSize(pending, pageW, pageH)
  const toPage = (e: { clientX: number; clientY: number }): Point => geometry.eventToPage(e, ref.current!)

  // Rectangle being dragged, with the image's proportions unless Shift is held.
  const dragRect = (d: { a: Point; b: Point; free: boolean }): Rect => {
    let w = Math.abs(d.b[0] - d.a[0])
    let h = Math.abs(d.b[1] - d.a[1])
    if (!d.free) {
      const ratio = natural[0] / natural[1]
      if (w / Math.max(h, 1e-6) > ratio) h = w / ratio
      else w = h * ratio
    }
    const x = d.b[0] < d.a[0] ? d.a[0] - w : d.a[0]
    const y = d.b[1] < d.a[1] ? d.a[1] - h : d.a[1]
    return [Math.max(0, x), Math.max(0, y), Math.min(pageW, x + w), Math.min(pageH, y + h)]
  }

  let ghost: Rect | null = null
  if (drag) ghost = dragRect(drag)
  else if (hover) ghost = placeAt(hover, natural, pageW, pageH)
  const css = ghost ? geometry.rectToCss(ghost) : null

  return (
    <div
      ref={ref}
      className="viewer-layer fc-edit-images-links-addlayer"
      onPointerMove={(e) => {
        const p = toPage(e)
        if (drag) setDrag({ ...drag, b: p, free: e.shiftKey })
        else setHover(p)
      }}
      onPointerLeave={() => !drag && setHover(null)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        ref.current?.setPointerCapture(e.pointerId)
        const p = toPage(e)
        setDrag({ a: p, b: p, free: e.shiftKey })
      }}
      onPointerUp={(e) => {
        if (!drag) return
        const d = drag
        setDrag(null)
        try {
          ref.current?.releasePointerCapture(e.pointerId)
        } catch {}
        const moved = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * geometry.scale
        const rect = moved > 6 ? dragRect(d) : placeAt(d.a, natural, pageW, pageH)
        if (rect[2] - rect[0] < 2 || rect[3] - rect[1] < 2) return
        void place(doc, pageIndex, rect)
      }}
    >
      {css && (
        <div className={`fc-edit-images-links-ghost ${drag ? 'is-drawing' : ''}`} style={{ ...css }}>
          <img src={pending.url} alt="" draggable={false} />
        </div>
      )}
    </div>
  )
}

export function AddImageToolbar({ doc }: { doc: DocumentModel }) {
  const pending = useUi((s) => s.pending)
  return (
    <div className="fc-edit-images-links-optbar">
      <ImagePlus size={16} />
      {pending ? (
        <>
          <span>
            <b>{pending.name}</b> ({pending.width} × {pending.height} px). Click on a page to place it at its original size, or drag to draw the area it
            should fill. Hold Shift while dragging to change its proportions.
          </span>
          <Button size="sm" onClick={() => void chooseImageToAdd(doc)}>
            Choose another image…
          </Button>
        </>
      ) : (
        <span>Choose an image to add to the page.</span>
      )}
      <Button
        size="sm"
        variant="quiet"
        onClick={() => {
          clearPending()
          returnToEditTool()
        }}
      >
        Cancel
      </Button>
    </div>
  )
}

