import { useEffect, useRef } from 'react'
import type { Point } from '@shared/geometry'
import { showError, toast, useApp, type PageLayerProps } from '@renderer/sdk'
import { nearestPoint, segmentLength, snap45, type MeasureKind } from './measureMath'
import { openCalibrateDialog } from './MeasureControls'
import { liveReadout, measureOps, TOOL_KIND, useDocScale, useMeasure, useSnapTargets, type LiveMeasure } from './measureStore'

/** Snap radius in screen pixels. */
const SNAP_PX = 8

const MIN_POINTS: Record<MeasureKind, number> = { distance: 2, perimeter: 2, area: 3 }

/** Puts the readout beside the pointer, flipping it near the page edges (pages clip overflow). */
function readoutPosition(c: Point, w: number, h: number): React.CSSProperties {
  const flipX = c[0] > w - 170
  const flipY = c[1] > h - 44
  return {
    left: c[0] + (flipX ? -14 : 14),
    top: c[1] + (flipY ? -16 : 16),
    transform: `translate(${flipX ? '-100%' : '0'}, ${flipY ? '-100%' : '0'})`
  }
}

function cleanPoints(points: Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (!last || segmentLength(last, p) > 0.5) out.push(p)
  }
  return out
}

/** Distance, Perimeter and Area tools: click points on the page; the value is shown while you go. */
export function MeasureLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const ref = useRef<HTMLDivElement>(null)
  const toolId = useApp((s) => s.toolId)
  const kind: MeasureKind = TOOL_KIND[toolId] ?? 'distance'
  const live = useMeasure((s) => s.live)
  const settings = useMeasure((s) => s.settings)
  const calibrating = useMeasure((s) => s.calibrating)
  const scale = useDocScale(doc)
  const targets = useSnapTargets(doc, pageIndex, settings.snap)
  const mine: LiveMeasure | null = live && live.docId === doc.id && live.page === pageIndex && live.kind === kind ? live : null
  const calibratingDialog = useRef(false)

  const set = (l: LiveMeasure | null) => useMeasure.setState({ live: l })

  const finish = async (points: Point[]) => {
    const pts = cleanPoints(points)
    set(null)
    if (pts.length < MIN_POINTS[kind]) {
      if (pts.length > 1 || kind !== 'distance') toast(kind === 'area' ? 'An area needs at least 3 points.' : 'Click at least 2 points.')
      return
    }
    if (kind === 'distance' && useMeasure.getState().calibrating) {
      if (calibratingDialog.current) return
      calibratingDialog.current = true
      useMeasure.setState({ calibrating: false })
      try {
        await openCalibrateDialog(doc, segmentLength(pts[0], pts[1]), scale)
      } finally {
        calibratingDialog.current = false
      }
      return
    }
    try {
      // calls are queued by the engine, so quick successive measurements all land
      await measureOps(doc).addMeasurement(pageIndex, {
        kind,
        points: pts,
        scale,
        color: settings.color,
        showLabel: settings.showLabels
      })
    } catch (err) {
      showError(err, 'Could not add the measurement')
    }
  }
  const finishRef = useRef(finish)
  finishRef.current = finish

  // Keyboard while drawing: Esc cancels, Enter finishes, Backspace removes the last point.
  const hasPoints = !!mine && mine.points.length > 0
  useEffect(() => {
    if (!hasPoints) return
    const onKey = (e: KeyboardEvent) => {
      if (useApp.getState().dialogs.length) return
      const l = useMeasure.getState().live
      if (!l || l.docId !== doc.id || l.page !== pageIndex || !l.points.length) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        useMeasure.setState({ live: { ...l, points: [] } })
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        void finishRef.current(l.points)
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        e.stopPropagation()
        useMeasure.setState({ live: { ...l, points: l.points.slice(0, -1) } })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [hasPoints, doc, pageIndex])

  const pointFor = (e: React.PointerEvent, points: Point[]): { p: Point; snapped: boolean } => {
    let p = geometry.eventToPage(e, ref.current!)
    p = [Math.max(0, Math.min(geometry.width, p[0])), Math.max(0, Math.min(geometry.height, p[1]))]
    const from = points[points.length - 1]
    if (e.shiftKey && from) return { p: snap45(from, p), snapped: false }
    if (useMeasure.getState().settings.snap) {
      const radius = SNAP_PX / geometry.scale
      // closing an area on its first point wins over other targets
      if (kind === 'area' && points.length >= 3 && segmentLength(points[0], p) <= radius) return { p: points[0], snapped: true }
      if (targets) {
        const hit = nearestPoint(targets.points, p, radius)
        if (hit) return { p: hit.point, snapped: true }
      }
    }
    return { p, snapped: false }
  }

  const current = (): LiveMeasure => {
    const l = useMeasure.getState().live
    if (l && l.docId === doc.id && l.page === pageIndex && l.kind === kind) return l
    return { docId: doc.id, page: pageIndex, kind, points: [], cursor: null, snapped: false }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const l = current()
    const { p, snapped } = pointFor(e, l.points)
    set({ ...l, cursor: p, snapped })
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    const l = current()
    const { p, snapped } = pointFor(e, l.points)
    // Clicking the first point again closes an area.
    if (kind === 'area' && l.points.length >= 3 && segmentLength(l.points[0], p) <= SNAP_PX / geometry.scale) {
      void finish(l.points)
      return
    }
    const points = [...l.points, p]
    if (kind === 'distance' && points.length >= 2) {
      void finish(points)
      return
    }
    set({ ...l, points, cursor: p, snapped })
  }

  // Double-click finishes a perimeter or area (both clicks added the same point; duplicates are dropped).
  const onDoubleClick = () => {
    const l = useMeasure.getState().live
    if (kind === 'distance' || !l || l.docId !== doc.id || l.page !== pageIndex || !l.points.length) return
    void finish(l.points)
  }

  // ---- drawing ----
  const pts = mine ? (mine.cursor ? [...mine.points, mine.cursor] : mine.points) : []
  const css = pts.map((p) => geometry.toCss(p))
  const path = css.map((c) => `${c[0]},${c[1]}`).join(' ')
  const readout = mine && mine.cursor ? liveReadout(mine, scale) : null
  const cursorCss = mine?.cursor ? geometry.toCss(mine.cursor) : null
  const color = settings.color

  return (
    <div
      ref={ref}
      className="viewer-layer fc-stamps-measure-measure-layer"
      data-testid="measure-layer"
      onPointerMove={onPointerMove}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onPointerLeave={() => {
        const l = useMeasure.getState().live
        if (l && l.docId === doc.id && l.page === pageIndex) set(l.points.length ? { ...l, cursor: null } : null)
      }}
    >
      <svg className="fc-stamps-measure-svg" width={geometry.cssWidth} height={geometry.cssHeight} aria-hidden="true">
        {css.length >= 2 && kind === 'area' && (
          <polygon points={path} fill={color} fillOpacity={0.12} stroke={color} strokeWidth={1.5} strokeDasharray={mine?.points.length && mine.points.length >= 2 ? undefined : '4 3'} />
        )}
        {css.length >= 2 && kind !== 'area' && <polyline points={path} fill="none" stroke={color} strokeWidth={1.5} />}
        {mine?.points.map((p, i) => {
          const c = geometry.toCss(p)
          return <circle key={i} cx={c[0]} cy={c[1]} r={3} fill="#fff" stroke={color} strokeWidth={1.5} />
        })}
        {cursorCss && mine?.snapped && (
          <rect
            className="fc-stamps-measure-snap"
            x={cursorCss[0] - 5}
            y={cursorCss[1] - 5}
            width={10}
            height={10}
            fill="none"
            strokeWidth={1.5}
          />
        )}
      </svg>
      {readout && cursorCss && (mine!.points.length > 0 || (calibrating && kind === 'distance')) && (
        <div
          className="fc-stamps-measure-readout"
          style={readoutPosition(cursorCss, geometry.cssWidth, geometry.cssHeight)}
          role="status"
        >
          {calibrating && kind === 'distance'
            ? mine!.points.length
              ? `Calibrating: ${readout.headline}`
              : 'Click the start of a known length'
            : readout.headline}
        </div>
      )}
    </div>
  )
}
