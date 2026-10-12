import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  Crop,
  Download,
  TrianglesCenterlineDashedVertical,
  TrianglesCenterlineDashedHorizontal,
  Layers,
  Replace,
  RotateCcw,
  RotateCw,
  Trash2,
  X
} from 'lucide-react'
import type { Point } from '@shared/geometry'
import {
  IconButton,
  showContextMenu,
  useActiveDoc,
  useDocState,
  usePageVersion,
  type CssRect,
  type DocumentModel,
  type PageLayerProps
} from '@renderer/sdk'
import type { PageImage } from './engine'
import {
  IMAGE_SELECTION,
  imageKey,
  keyboardTaken,
  ops,
  rectCenter,
  rectToRect,
  rotationAbout,
  selectImage,
  translation,
  useUi
} from './common'
import {
  arrangeItems,
  cropImage,
  deleteImage,
  flipImage,
  imageMenu,
  replaceImage,
  rotateImage,
  saveImageAs,
  startCrop,
  transformImage
} from './imageActions'

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const MIN = 6

type Drag =
  | { mode: 'move'; img: PageImage; start: Point; dx: number; dy: number; snap: string | null; done?: boolean }
  | { mode: 'resize'; img: PageImage; handle: Handle; start: Point; from: CssRect; rect: CssRect; snap: string | null; done?: boolean }
  | { mode: 'rotate'; img: PageImage; center: Point; a0: number; angle: number; snap: string | null; done?: boolean }

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))

/** Copies the rendered pixels under a CSS rectangle of the page (for drag previews). */
function grabSnapshot(layer: HTMLElement | null, css: CssRect): string | null {
  const page = layer?.parentElement
  const base = page?.querySelector<HTMLCanvasElement>('canvas.viewer-page-canvas')
  if (!page || !base || !base.width || !page.clientWidth) return null
  const fx = base.width / page.clientWidth
  const fy = base.height / page.clientHeight
  const sx = Math.max(0, css.left * fx)
  const sy = Math.max(0, css.top * fy)
  const sw = Math.min(base.width - sx, css.width * fx)
  const sh = Math.min(base.height - sy, css.height * fy)
  if (sw < 1 || sh < 1) return null
  try {
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.round(sw))
    c.height = Math.max(1, Math.round(sh))
    c.getContext('2d')!.drawImage(base, sx, sy, sw, sh, 0, 0, c.width, c.height)
    return c.toDataURL()
  } catch {
    return null
  }
}

function resizeRect(from: CssRect, h: Handle, dx: number, dy: number, keepAspect: boolean): CssRect {
  let l = from.left
  let t = from.top
  let r = from.left + from.width
  let b = from.top + from.height
  if (h.includes('w')) l = Math.min(l + dx, r - MIN)
  if (h.includes('e')) r = Math.max(r + dx, l + MIN)
  if (h.includes('n')) t = Math.min(t + dy, b - MIN)
  if (h.includes('s')) b = Math.max(b + dy, t + MIN)
  if (keepAspect && h.length === 2 && from.width > 0 && from.height > 0) {
    const s = Math.max((r - l) / from.width, (b - t) / from.height)
    const w = Math.max(MIN, from.width * s)
    const hh = Math.max(MIN, from.height * s)
    if (h.includes('w')) l = r - w
    else r = l + w
    if (h.includes('n')) t = b - hh
    else b = t + hh
  }
  return { left: l, top: t, width: r - l, height: b - t }
}

function handleStyle(h: Handle, css: CssRect): React.CSSProperties {
  const x = h.includes('w') ? 0 : h.includes('e') ? css.width : css.width / 2
  const y = h.includes('n') ? 0 : h.includes('s') ? css.height : css.height / 2
  const cursor = h === 'n' || h === 's' ? 'ns-resize' : h === 'e' || h === 'w' ? 'ew-resize' : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize'
  return { left: x, top: y, cursor }
}

function snapAngle(deg: number, fine: boolean): number {
  if (fine) return Math.round(deg / 15) * 15
  const near = Math.round(deg / 90) * 90
  return Math.abs(deg - near) < 4 ? near : Math.round(deg)
}

/** True when the image's edges are parallel to the page edges (0, 90, 180 or 270 degrees). */
function rightAngled(img: PageImage): boolean {
  return img.rotation % 90 === 0
}

function sameImage(a: PageImage, b: PageImage): boolean {
  return a.xref === b.xref && a.loc.join() === b.loc.join() && a.visible.every((v, i) => Math.abs(v - b.visible[i]) < 0.01) && a.index === b.index
}

export function ImageLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const version = usePageVersion(doc, pageIndex)
  const selection = useDocState(doc, (s) => s.selection)
  const activeDoc = useActiveDoc()
  const crop = useUi((s) => s.crop)
  const busyKey = useUi((s) => s.busyKey)
  const [images, setImages] = useState<PageImage[]>([])
  const [drag, setDrag] = useState<Drag | null>(null)
  const [nudge, setNudge] = useState<{ dx: number; dy: number } | null>(null)
  const [cropRect, setCropRect] = useState<CssRect | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const nudgeTimer = useRef<number | null>(null)
  const sel =
    selection.kind === 'custom' && selection.type === IMAGE_SELECTION && selection.page === pageIndex ? (selection.data as PageImage) : null
  const cropping = !!sel && !!crop && crop.docId === doc.id && crop.page === pageIndex && crop.key === imageKey(sel)

  // Load the images of this page whenever it changes, and keep the selection in sync.
  useEffect(() => {
    let alive = true
    ops(doc)
      .images(pageIndex)
      .then((list) => {
        if (!alive) return
        setImages(list)
        const cur = doc.state.selection
        if (cur.kind === 'custom' && cur.type === IMAGE_SELECTION && cur.page === pageIndex) {
          const old = cur.data as PageImage
          const match =
            list.find((i) => imageKey(i) === imageKey(old)) ?? list.find((i) => i.index === old.index && i.xref === old.xref) ?? null
          if (!match) doc.clearSelection()
          else if (!sameImage(match, old)) selectImage(doc, pageIndex, match)
        }
      })
      .catch((err) => {
        if (alive) console.warn('Could not list images', err)
      })
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])

  // An image selected with the keyboard takes the focus (its hit box is replaced by the frame).
  const focusFrame = useRef(false)
  useEffect(() => {
    if (!sel || !focusFrame.current) return
    focusFrame.current = false
    frameRef.current?.focus({ preventScroll: true })
  }, [sel])

  // Drop a finished drag preview once the page has re-rendered with the change.
  useEffect(() => {
    if (!drag?.done) return
    const t = window.setTimeout(() => setDrag(null), 180)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  // Leaving crop mode when the selection changes.
  useEffect(() => {
    if (!cropping) setCropRect(null)
    else if (sel && !cropRect) setCropRect(geometry.rectToCss(sel.visible))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropping, sel?.xref, sel?.loc.join()])

  // Arrow-key moves are collected for a moment and committed as one undoable step.
  const nudgeRef = useRef<{ dx: number; dy: number } | null>(null)
  const nudgeBusy = useRef(false)
  const commitNudge = useCallback(() => {
    if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current)
    nudgeTimer.current = null
    const n = nudgeRef.current
    const done = () => {
      nudgeRef.current = null
      nudgeBusy.current = false
      setNudge(null)
    }
    if (!n || !sel || (!n.dx && !n.dy)) return done()
    nudgeBusy.current = true
    void transformImage(doc, pageIndex, sel, translation(n.dx, n.dy), 'move').finally(done)
  }, [doc, pageIndex, sel])

  // Keyboard: arrows nudge the selected image, Enter/Escape finish cropping.
  useEffect(() => {
    if (!sel || activeDoc !== doc) return
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || keyboardTaken(e) || e.ctrlKey || e.metaKey || e.altKey) return
      // Enter on a focused button belongs to the button
      if (e.key === 'Enter' && e.target instanceof HTMLButtonElement) return
      if (cropping && (e.key === 'Escape' || e.key === 'Enter')) {
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Enter' && cropRect) void cropImage(doc, pageIndex, sel, geometry.cssToRect(cropRect))
        useUi.setState({ crop: null })
        return
      }
      if (e.key === 'Escape') {
        // Escape first deselects the image; a second Escape leaves the tool (core shortcut)
        e.preventDefault()
        e.stopPropagation()
        selectImage(doc, pageIndex, null)
        return
      }
      const step = e.shiftKey ? 10 : 1
      const d: Record<string, Point> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
      const v = d[e.key]
      if (!v || cropping) return
      e.preventDefault()
      e.stopPropagation()
      // presses while the previous move is being written are dropped (the image is about to jump)
      if (nudgeBusy.current) return
      // arrows move in screen directions: convert to page space for rotated views
      const o = geometry.toPage([0, 0])
      const p = geometry.toPage([v[0] * geometry.scale, v[1] * geometry.scale])
      const n = nudgeRef.current
      nudgeRef.current = { dx: (n?.dx ?? 0) + (p[0] - o[0]), dy: (n?.dy ?? 0) + (p[1] - o[1]) }
      setNudge(nudgeRef.current)
      if (nudgeTimer.current) window.clearTimeout(nudgeTimer.current)
      nudgeTimer.current = window.setTimeout(commitNudge, 450)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [sel, activeDoc, doc, cropping, cropRect, geometry, pageIndex, commitNudge])

  // Clicking elsewhere on the pages deselects the image.
  useEffect(() => {
    if (!sel) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement | null
      if (!t || t.closest('[data-fc-eil]') || !t.closest('.viewer-scroll')) return
      if (cropping) useUi.setState({ crop: null })
      selectImage(doc, pageIndex, null)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [sel, doc, pageIndex, cropping])

  const local = (e: { clientX: number; clientY: number }): Point => {
    const b = layerRef.current!.getBoundingClientRect()
    return [e.clientX - b.left, e.clientY - b.top]
  }

  // While dragging, follow the pointer anywhere in the window.
  const dragRef = useRef<Drag | null>(null)
  dragRef.current = drag
  const active = !!drag && !drag.done
  useEffect(() => {
    if (!active) return
    const move = (e: PointerEvent) => onMoveRef.current(e)
    const up = () => onUpRef.current()
    const cancel = () => setDrag(null)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
    }
  }, [active])

  const startMove = (e: React.PointerEvent, img: PageImage) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    if (!sel || imageKey(sel) !== imageKey(img)) selectImage(doc, pageIndex, img)
    if (cropping) return
    frameRef.current?.focus({ preventScroll: true })
    setDrag({ mode: 'move', img, start: local(e), dx: 0, dy: 0, snap: null })
  }

  const startResize = (e: React.PointerEvent, h: Handle) => {
    if (e.button !== 0 || !sel) return
    e.stopPropagation()
    e.preventDefault()
    const from = geometry.rectToCss(sel.visible)
    setDrag({ mode: 'resize', img: sel, handle: h, start: local(e), from, rect: from, snap: grabSnapshot(layerRef.current, from) })
  }

  const startRotate = (e: React.PointerEvent) => {
    if (e.button !== 0 || !sel) return
    e.stopPropagation()
    e.preventDefault()
    const css = geometry.rectToCss(sel.visible)
    const center: Point = [css.left + css.width / 2, css.top + css.height / 2]
    const p = local(e)
    setDrag({ mode: 'rotate', img: sel, center, a0: Math.atan2(p[1] - center[1], p[0] - center[0]), angle: 0, snap: grabSnapshot(layerRef.current, css) })
  }

  const onMove = (e: PointerEvent) => {
    const drag = dragRef.current
    if (!drag || drag.done) return
    const p = local(e)
    if (drag.mode === 'move') {
      let dx = p[0] - drag.start[0]
      let dy = p[1] - drag.start[1]
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0
        else dx = 0
      }
      // keep the centre of the image on the page
      const css = geometry.rectToCss(drag.img.visible)
      const cx = css.left + css.width / 2
      const cy = css.top + css.height / 2
      dx = Math.max(-cx, Math.min(geometry.cssWidth - cx, dx))
      dy = Math.max(-cy, Math.min(geometry.cssHeight - cy, dy))
      const snap = drag.snap ?? (Math.hypot(dx, dy) > 2 ? grabSnapshot(layerRef.current, css) : null)
      setDrag({ ...drag, dx, dy, snap })
    } else if (drag.mode === 'resize') {
      // images turned by an odd angle always keep their proportions (a free resize would skew them)
      const keep = !e.shiftKey || !rightAngled(drag.img)
      setDrag({ ...drag, rect: resizeRect(drag.from, drag.handle, p[0] - drag.start[0], p[1] - drag.start[1], keep) })
    } else {
      const a = Math.atan2(p[1] - drag.center[1], p[0] - drag.center[0])
      setDrag({ ...drag, angle: snapAngle(((a - drag.a0) * 180) / Math.PI, e.shiftKey) })
    }
  }

  const onUp = () => {
    const drag = dragRef.current
    if (!drag || drag.done) return
    const img = drag.img
    let commit: Promise<void> | null = null
    if (drag.mode === 'move' && Math.hypot(drag.dx, drag.dy) >= 1) {
      const a = geometry.toPage(drag.start)
      const b = geometry.toPage([drag.start[0] + drag.dx, drag.start[1] + drag.dy])
      commit = transformImage(doc, pageIndex, img, translation(b[0] - a[0], b[1] - a[1]), 'move')
    } else if (drag.mode === 'resize') {
      const to = geometry.cssToRect(drag.rect)
      const from = img.visible
      if (to.some((v, i) => Math.abs(v - from[i]) > 0.3)) commit = transformImage(doc, pageIndex, img, rectToRect(from, to), 'resize')
    } else if (drag.mode === 'rotate') {
      const angle = ((drag.angle % 360) + 360) % 360
      if (angle > 0.5 && angle < 359.5) {
        const [cx, cy] = rectCenter(img.visible)
        commit = transformImage(doc, pageIndex, img, rotationAbout(drag.angle, cx, cy), 'rotate')
      }
    }
    if (commit) {
      setDrag({ ...drag, done: true } as Drag)
      void commit.then(() => {
        // if nothing on the page changed (error), drop the preview right away
        window.setTimeout(() => setDrag((d) => (d && d.done ? null : d)), 1500)
      })
    } else setDrag(null)
  }

  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove
  const onUpRef = useRef(onUp)
  onUpRef.current = onUp

  const onContextMenu = (e: React.MouseEvent, img: PageImage) => {
    e.preventDefault()
    e.stopPropagation()
    selectImage(doc, pageIndex, img)
    showContextMenu(e.clientX, e.clientY, imageMenu(doc, pageIndex, img))
  }

  // ---- crop handles ----
  const startCropHandle = (e: React.PointerEvent, h: Handle) => {
    if (e.button !== 0 || !cropRect || !sel) return
    e.stopPropagation()
    e.preventDefault()
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const start = local(e)
    const from = cropRect
    const bounds = geometry.rectToCss(sel.bbox)
    const move = (ev: PointerEvent) => {
      const p = local(ev)
      const r = resizeRect(from, h, p[0] - start[0], p[1] - start[1], false)
      const l = Math.max(bounds.left, r.left)
      const t = Math.max(bounds.top, r.top)
      const rr = Math.min(bounds.left + bounds.width, r.left + r.width)
      const bb = Math.min(bounds.top + bounds.height, r.top + r.height)
      setCropRect({ left: l, top: t, width: Math.max(MIN, rr - l), height: Math.max(MIN, bb - t) })
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const applyCrop = () => {
    if (sel && cropRect) void cropImage(doc, pageIndex, sel, geometry.cssToRect(cropRect))
    useUi.setState({ crop: null })
  }

  // ---- rendering ----
  const selCss = sel ? geometry.rectToCss(sel.visible) : null
  let frame: CssRect | null = selCss
  let rotate = 0
  if (drag && sel && imageKey(drag.img) === imageKey(sel)) {
    const css = geometry.rectToCss(drag.img.visible)
    if (drag.mode === 'move') frame = { ...css, left: css.left + drag.dx, top: css.top + drag.dy }
    else if (drag.mode === 'resize') frame = drag.rect
    else {
      frame = css
      rotate = drag.angle
    }
  } else if (nudge && selCss) {
    const a = geometry.toCss([0, 0])
    const b = geometry.toCss([nudge.dx, nudge.dy])
    frame = { ...selCss, left: selCss.left + b[0] - a[0], top: selCss.top + b[1] - a[1] }
  }
  const dragging = !!drag
  const busy = !!sel && busyKey === imageKey(sel)
  const preview = drag && drag.snap && (drag.mode !== 'move' || drag.dx || drag.dy) ? drag.snap : null
  const origin = drag ? geometry.rectToCss(drag.img.visible) : null

  return (
    <div ref={layerRef} className="viewer-layer fc-edit-images-links-layer">
      {images.map((img) => {
        if (sel && imageKey(sel) === imageKey(img)) return null
        const c = geometry.rectToCss(img.visible)
        if (c.width < 1 || c.height < 1) return null
        const w = Math.max(c.width, MIN)
        const h = Math.max(c.height, MIN)
        return (
          <div
            key={imageKey(img)}
            data-fc-eil=""
            role="button"
            tabIndex={0}
            aria-label={`Image, ${img.width} by ${img.height} pixels`}
            className={`fc-edit-images-links-hit ${hover === img.index ? 'is-hover' : ''}`}
            style={{ left: c.left - (w - c.width) / 2, top: c.top - (h - c.height) / 2, width: w, height: h }}
            onPointerEnter={() => setHover(img.index)}
            onPointerLeave={() => setHover((v) => (v === img.index ? null : v))}
            onPointerDown={(e) => startMove(e, img)}
            onContextMenu={(e) => onContextMenu(e, img)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                // keep keyboard focus on the selection so Tab reaches its toolbar
                focusFrame.current = true
                selectImage(doc, pageIndex, img)
              }
            }}
          />
        )
      })}
      {origin && preview && <div className="fc-edit-images-links-origin" style={{ ...origin }} />}
      {sel && frame && (
        <div
          ref={frameRef}
          data-fc-eil=""
          tabIndex={-1}
          role="group"
          aria-label="Selected image"
          className={`fc-edit-images-links-frame ${cropping ? 'is-cropping' : ''} ${busy ? 'is-busy' : ''}`}
          style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height, transform: rotate ? `rotate(${rotate}deg)` : undefined }}
          onPointerDown={(e) => !cropping && startMove(e, sel)}
          onContextMenu={(e) => onContextMenu(e, sel)}
        >
          {preview && <img className="fc-edit-images-links-preview" src={preview} alt="" draggable={false} />}
          {!cropping &&
            HANDLES.filter((h) => h.length === 2 || rightAngled(sel)).map((h) => (
              <div
                key={h}
                className={`fc-edit-images-links-handle fc-edit-images-links-handle-${h}`}
                style={handleStyle(h, frame!)}
                onPointerDown={(e) => startResize(e, h)}
              />
            ))}
          {!cropping && (
            <>
              <div className="fc-edit-images-links-rotate-stem" />
              <div
                className="fc-edit-images-links-rotate"
                title="Drag to rotate (hold Shift to snap to 15°)"
                onPointerDown={startRotate}
              />
            </>
          )}
          {drag?.mode === 'rotate' && <div className="fc-edit-images-links-angle">{Math.round(drag.angle)}°</div>}
        </div>
      )}
      {sel && cropping && cropRect && (
        <>
          <CropShade bounds={geometry.rectToCss(sel.bbox)} crop={cropRect} />
          <div data-fc-eil="" className="fc-edit-images-links-crop" style={{ ...cropRect }}>
            {HANDLES.map((h) => (
              <div
                key={h}
                className={`fc-edit-images-links-handle fc-edit-images-links-handle-${h}`}
                style={handleStyle(h, cropRect)}
                onPointerDown={(e) => startCropHandle(e, h)}
              />
            ))}
          </div>
        </>
      )}
      {sel && frame && !dragging && (
        <ImageToolbar
          doc={doc}
          page={pageIndex}
          img={sel}
          frame={cropping && cropRect ? cropRect : frame}
          pageSize={[geometry.cssWidth, geometry.cssHeight]}
          cropping={cropping}
          onApplyCrop={applyCrop}
        />
      )}
    </div>
  )
}

/** Dims the parts of the image that the crop will hide (only inside the image). */
function CropShade({ bounds, crop }: { bounds: CssRect; crop: CssRect }) {
  return (
    <div className="fc-edit-images-links-crop-bounds" style={{ ...bounds }}>
      <div
        className="fc-edit-images-links-crop-shade"
        style={{ left: crop.left - bounds.left, top: crop.top - bounds.top, width: crop.width, height: crop.height }}
      />
    </div>
  )
}

function ImageToolbar({
  doc,
  page,
  img,
  frame,
  pageSize,
  cropping,
  onApplyCrop
}: {
  doc: DocumentModel
  page: number
  img: PageImage
  frame: CssRect
  pageSize: [number, number]
  cropping: boolean
  onApplyCrop: () => void
}) {
  const width = cropping ? 220 : 330
  const height = 38
  const below = frame.top + frame.height + 12
  const above = frame.top - height - 34
  const top = below + height <= pageSize[1] - 4 ? below : above >= 4 ? above : Math.max(4, frame.top + 8)
  const left = Math.max(4, Math.min(pageSize[0] - width - 4, frame.left + frame.width / 2 - width / 2))
  const stop = (e: React.PointerEvent) => e.stopPropagation()
  return (
    <div
      data-fc-eil=""
      role="toolbar"
      aria-label="Image tools"
      className="fc-edit-images-links-toolbar"
      style={{ left, top }}
      onPointerDown={stop}
      onContextMenu={(e) => e.stopPropagation()}
    >
      {cropping ? (
        <>
          <span className="fc-edit-images-links-toolbar-label">Drag the handles to crop</span>
          <IconButton icon={Check} label="Apply crop" shortcut="Enter" onClick={onApplyCrop} />
          <IconButton icon={X} label="Cancel crop" shortcut="Esc" onClick={() => useUi.setState({ crop: null })} />
        </>
      ) : (
        <>
          <IconButton icon={RotateCcw} label="Rotate counterclockwise" size={17} onClick={() => void rotateImage(doc, page, img, -90)} />
          <IconButton icon={RotateCw} label="Rotate clockwise" size={17} onClick={() => void rotateImage(doc, page, img, 90)} />
          <IconButton icon={TrianglesCenterlineDashedVertical} label="Flip horizontal" size={17} onClick={() => void flipImage(doc, page, img, 'horizontal')} />
          <IconButton icon={TrianglesCenterlineDashedHorizontal} label="Flip vertical" size={17} onClick={() => void flipImage(doc, page, img, 'vertical')} />
          <span className="fc-edit-images-links-sep" />
          <IconButton icon={Crop} label="Crop image" size={17} onClick={() => startCrop(doc, page, img)} />
          <IconButton icon={Replace} label="Replace image" size={17} onClick={() => void replaceImage(doc, page, img)} />
          <IconButton
            icon={Layers}
            label="Arrange"
            size={17}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
              showContextMenu(r.left, r.bottom + 4, arrangeItems(doc, page, img))
            }}
          />
          <IconButton icon={Download} label="Save image as" size={17} onClick={() => void saveImageAs(doc, page, img)} />
          <span className="fc-edit-images-links-sep" />
          <IconButton icon={Trash2} label="Delete image" shortcut="Del" size={17} onClick={() => void deleteImage(doc, page, img)} />
        </>
      )}
    </div>
  )
}

