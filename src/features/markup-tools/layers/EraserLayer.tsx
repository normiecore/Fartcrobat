/**
 * Eraser for free-form drawings: drag over Ink annotations to erase the parts of their strokes you
 * touch. Strokes are split where the eraser crosses them; a drawing with nothing left is deleted.
 * While erasing, the touched drawings are hidden from page rendering and drawn live in an overlay.
 */
import { useEffect, useRef, useState } from 'react'
import type { AnnotInfo } from '@engine/ops/annots'
import type { Point } from '@shared/geometry'
import { setHiddenAnnotations, showError, usePageVersion, type PageLayerProps } from '@renderer/sdk'
import { annotOps, markupOps } from '../actions'
import { eraseStrokes } from '../geometry'
import { InkPreview, PreviewSvg } from '../Preview'
import { pagePoint, useActiveToolAndStyle } from './shared'

/** How long the overlay stays after a pass is saved, while the page re-renders (avoids a flicker). */
const SETTLE_MS = 400

interface OverlayEntry {
  strokes: Point[][]
  color: string
  width: number
  opacity: number
  /** Eraser pass that produced it. */
  pass: number
}

interface Pass {
  id: number
  /** annotation id -> strokes left so far (only drawings this pass touched) */
  strokes: Map<number, Point[][]>
}

let passCounter = 0

export function EraserLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { style } = useActiveToolAndStyle()
  const version = usePageVersion(doc, pageIndex)
  /** Drawings on the page (updated right after each pass, then refreshed from the engine). */
  const inks = useRef<AnnotInfo[]>([])
  const pass = useRef<Pass | null>(null)
  const last = useRef<Point | null>(null)
  const [hover, setHover] = useState<Point | null>(null)
  const [overlay, setOverlay] = useState<Map<number, OverlayEntry>>(() => new Map())

  const refresh = () =>
    annotOps(doc)
      .list(pageIndex)
      .then((list) => {
        inks.current = list.filter((a) => a.type === 'Ink' && !a.hidden && !a.locked && a.ink.length > 0)
      })
      .catch(() => {})

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, pageIndex, version])

  // unhide everything if the layer goes away mid-erase
  useEffect(() => () => setHiddenAnnotations(doc, pageIndex, []), [doc, pageIndex])

  const radius = style.eraserSize / 2
  const hideCurrent = () => setHiddenAnnotations(doc, pageIndex, pass.current ? [...pass.current.strokes.keys()] : [])

  /** Applies one eraser segment to the current pass. */
  const erase = (from: Point, to: Point) => {
    const p = pass.current
    if (!p) return
    const touched: number[] = []
    let changed = false
    for (const a of inks.current) {
      const strokes = p.strokes.get(a.id) ?? a.ink
      const res = eraseStrokes(strokes, from === to ? [from] : [from, to], radius + a.borderWidth / 2)
      if (!res.changed) continue
      changed = true
      if (!p.strokes.has(a.id)) touched.push(a.id)
      p.strokes.set(a.id, res.strokes)
    }
    if (touched.length) hideCurrent()
    if (changed) {
      setOverlay((prev) => {
        const m = new Map(prev)
        for (const [id, strokes] of p.strokes) {
          const a = inks.current.find((x) => x.id === id)
          const old = m.get(id)
          m.set(id, {
            strokes,
            color: a?.color ?? old?.color ?? '#000000',
            width: a?.borderWidth || old?.width || 1,
            opacity: a?.opacity ?? old?.opacity ?? 1,
            pass: p.id
          })
        }
        return m
      })
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    ref.current!.setPointerCapture(e.pointerId)
    const p = pagePoint(e, ref.current!, geometry)
    last.current = p
    pass.current = { id: ++passCounter, strokes: new Map() }
    erase(p, p)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pagePoint(e, ref.current!, geometry)
    setHover(p)
    if (!pass.current || !last.current) return
    erase(last.current, p)
    last.current = p
  }

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    const done = pass.current
    pass.current = null
    last.current = null
    if (!done || !done.strokes.size) return
    // Later passes must start from what this one left.
    inks.current = inks.current.flatMap((a) => {
      const s = done.strokes.get(a.id)
      if (!s) return [a]
      const left = s.filter((st) => st.length >= 2)
      return left.length ? [{ ...a, ink: left }] : []
    })
    const changes = [...done.strokes.entries()].map(([id, ink]) => ({ id, ink }))
    void markupOps(doc)
      .erase(pageIndex, changes)
      .catch((err) => {
        showError(err, 'Could not erase')
        void refresh()
      })
      .finally(() => {
        hideCurrent()
        setTimeout(() => {
          setOverlay((prev) => {
            const m = new Map(prev)
            for (const [id, entry] of prev) if (entry.pass === done.id) m.delete(id)
            return m
          })
        }, SETTLE_MS)
      })
  }

  const c = hover ? geometry.toCss(hover) : null
  return (
    <div
      ref={ref}
      className="viewer-layer fc-markup-tools-layer fc-markup-tools-cursor-eraser"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHover(null)}
      onPointerCancel={() => {
        pass.current = null
        hideCurrent()
        setOverlay(new Map())
      }}
    >
      <PreviewSvg geometry={geometry}>
        {[...overlay.entries()].map(([id, o]) => (
          <InkPreview key={id} g={geometry} strokes={o.strokes} color={o.color} width={o.width} opacity={o.opacity} />
        ))}
        {c && <circle className="fc-markup-tools-eraser" cx={c[0]} cy={c[1]} r={Math.max(2, geometry.len(radius))} />}
      </PreviewSvg>
    </div>
  )
}
