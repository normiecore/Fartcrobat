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

const SETTLE_MS = 400

export function EraserLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { style } = useActiveToolAndStyle()
  const version = usePageVersion(doc, pageIndex)
  const inks = useRef<AnnotInfo[]>([])
  const [hover, setHover] = useState<Point | null>(null)
  /** id -> strokes left so far in this pass (only drawings the eraser touched). */
  const [working, setWorking] = useState<Map<number, Point[][]> | null>(null)
  const last = useRef<Point | null>(null)
  const settling = useRef(false)

  useEffect(() => {
    let alive = true
    annotOps(doc)
      .list(pageIndex)
      .then((list) => {
        if (alive) inks.current = list.filter((a) => a.type === 'Ink' && !a.hidden && !a.locked && a.ink.length > 0)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])

  // unhide everything if the layer goes away mid-erase
  useEffect(() => () => setHiddenAnnotations(doc, pageIndex, []), [doc, pageIndex])

  const radius = style.eraserSize / 2

  const eraseSegment = (from: Point, to: Point, current: Map<number, Point[][]>) => {
    let changed = false
    const next = new Map(current)
    for (const a of inks.current) {
      const strokes = next.get(a.id) ?? a.ink
      const res = eraseStrokes(strokes, from === to ? [from] : [from, to], radius + a.borderWidth / 2)
      if (res.changed) {
        next.set(a.id, res.strokes)
        changed = true
      }
    }
    return changed ? next : current
  }

  const workingRef = useRef<Map<number, Point[][]> | null>(null)

  const update = (next: Map<number, Point[][]> | null) => {
    const prev = workingRef.current
    workingRef.current = next
    if (next && (!prev || next.size !== prev.size)) setHiddenAnnotations(doc, pageIndex, [...next.keys()])
    setWorking(next)
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || settling.current) return
    ref.current!.setPointerCapture(e.pointerId)
    const p = pagePoint(e, ref.current!, geometry)
    last.current = p
    workingRef.current = null
    update(eraseSegment(p, p, new Map()))
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const p = pagePoint(e, ref.current!, geometry)
    setHover(p)
    const cur = workingRef.current
    if (!cur || !last.current) return
    const next = eraseSegment(last.current, p, cur)
    last.current = p
    if (next !== cur) update(next)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    const w = workingRef.current
    last.current = null
    if (!w || !w.size) {
      workingRef.current = null
      setWorking(null)
      return
    }
    settling.current = true
    const changes = [...w.entries()].map(([id, ink]) => ({ id, ink }))
    void markupOps(doc)
      .erase(pageIndex, changes)
      .catch((err) => showError(err, 'Could not erase'))
      .finally(() => {
        setHiddenAnnotations(doc, pageIndex, [])
        setTimeout(() => {
          settling.current = false
          workingRef.current = null
          setWorking(null)
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
    >
      <PreviewSvg geometry={geometry}>
        {working &&
          [...working.entries()].map(([id, strokes]) => {
            const a = inks.current.find((x) => x.id === id)
            if (!a) return null
            return <InkPreview key={id} g={geometry} strokes={strokes} color={a.color ?? '#000000'} width={a.borderWidth || 1} opacity={a.opacity} />
          })}
        {c && <circle className="fc-markup-tools-eraser" cx={c[0]} cy={c[1]} r={Math.max(2, geometry.len(radius))} />}
      </PreviewSvg>
    </div>
  )
}
