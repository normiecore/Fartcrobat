/**
 * Live previews drawn while a tool is in use. Everything is computed in page space and mapped to
 * CSS pixels with the page's PageGeometry, so previews line up at any zoom and view rotation.
 */
import type { ReactNode } from 'react'
import type { LineEnding } from '@engine/ops/annots'
import type { Point, Quad, Rect } from '@shared/geometry'
import type { PageGeometry } from '@renderer/sdk'
import { cloudPath, ellipsePoints } from './geometry'
import { dashFor, type ToolStyle } from './style'

export function PreviewSvg({ geometry, children, className }: { geometry: PageGeometry; children: ReactNode; className?: string }) {
  return (
    <svg
      className={`fc-markup-tools-svg ${className ?? ''}`}
      width={geometry.cssWidth}
      height={geometry.cssHeight}
      viewBox={`0 0 ${geometry.cssWidth} ${geometry.cssHeight}`}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

const pts = (g: PageGeometry, list: Point[]) =>
  list
    .map((p) => {
      const c = g.toCss(p)
      return `${c[0].toFixed(2)},${c[1].toFixed(2)}`
    })
    .join(' ')

function strokeProps(g: PageGeometry, st: ToolStyle, color: string | null = st.color) {
  const w = Math.max(1, g.len(st.width))
  return {
    stroke: color ?? 'none',
    strokeWidth: w,
    strokeDasharray: st.lineStyle === 'dashed' ? dashFor(st.width).map((d) => g.len(d)).join(' ') : undefined,
    strokeLinejoin: 'round' as const,
    strokeLinecap: 'butt' as const
  }
}

/** Corners of a page-space rect in CSS space (handles view rotation). */
function rectCorners(g: PageGeometry, r: Rect): Point[] {
  return [g.toCss([r[0], r[1]]), g.toCss([r[2], r[1]]), g.toCss([r[2], r[3]]), g.toCss([r[0], r[3]])]
}

function cloudBump(g: PageGeometry, st: ToolStyle) {
  return g.len(4 + st.width * 1.5)
}

export function RectPreview({ g, rect, st, oval }: { g: PageGeometry; rect: Rect; st: ToolStyle; oval?: boolean }) {
  const c = g.rectToCss(rect)
  const sp = strokeProps(g, st)
  if (st.lineStyle === 'cloudy') {
    const poly = oval ? ellipsePoints([c.left, c.top, c.left + c.width, c.top + c.height], 28) : rectCorners(g, rect)
    return <path d={cloudPath(poly, cloudBump(g, st))} fill={st.fill ?? 'none'} {...sp} strokeDasharray={undefined} opacity={st.opacity} />
  }
  if (oval)
    return (
      <ellipse
        cx={c.left + c.width / 2}
        cy={c.top + c.height / 2}
        rx={Math.max(0, c.width / 2)}
        ry={Math.max(0, c.height / 2)}
        fill={st.fill ?? 'none'}
        {...sp}
        opacity={st.opacity}
      />
    )
  return <rect x={c.left} y={c.top} width={c.width} height={c.height} fill={st.fill ?? 'none'} {...sp} opacity={st.opacity} />
}

/** SVG for a line ending at `tip`, with the line arriving from `from` (CSS space). */
function Ending({ kind, tip, from, w, color }: { kind: LineEnding; tip: Point; from: Point; w: number; color: string }) {
  if (kind === 'None') return null
  const ang = Math.atan2(tip[1] - from[1], tip[0] - from[0])
  const rot = (dx: number, dy: number): Point => [tip[0] + dx * Math.cos(ang) - dy * Math.sin(ang), tip[1] + dx * Math.sin(ang) + dy * Math.cos(ang)]
  const r = Math.max(1, w)
  const p = (list: Point[]) => list.map((q) => `${q[0].toFixed(2)},${q[1].toFixed(2)}`).join(' ')
  switch (kind) {
    case 'OpenArrow':
      return <polyline points={p([rot(-8.8 * r, -4.5 * r), tip, rot(-8.8 * r, 4.5 * r)])} fill="none" stroke={color} strokeWidth={w} strokeLinejoin="miter" />
    case 'ClosedArrow':
      return <polygon points={p([rot(-8.8 * r, -4.5 * r), tip, rot(-8.8 * r, 4.5 * r)])} fill={color} stroke={color} strokeWidth={w} />
    case 'ROpenArrow':
      return <polyline points={p([rot(8.8 * r, -4.5 * r), tip, rot(8.8 * r, 4.5 * r)])} fill="none" stroke={color} strokeWidth={w} />
    case 'RClosedArrow':
      return <polygon points={p([rot(8.8 * r, -4.5 * r), tip, rot(8.8 * r, 4.5 * r)])} fill={color} stroke={color} strokeWidth={w} />
    case 'Circle':
      return <circle cx={tip[0]} cy={tip[1]} r={3 * r} fill="none" stroke={color} strokeWidth={w} />
    case 'Square':
      return <polygon points={p([rot(-3 * r, -3 * r), rot(3 * r, -3 * r), rot(3 * r, 3 * r), rot(-3 * r, 3 * r)])} fill="none" stroke={color} strokeWidth={w} />
    case 'Diamond':
      return <polygon points={p([rot(-4 * r, 0), rot(0, -4 * r), rot(4 * r, 0), rot(0, 4 * r)])} fill="none" stroke={color} strokeWidth={w} />
    case 'Butt':
      return <polyline points={p([rot(0, -4.5 * r), rot(0, 4.5 * r)])} stroke={color} strokeWidth={w} />
    case 'Slash':
      return <polyline points={p([rot(-2.6 * r, 4.5 * r), rot(2.6 * r, -4.5 * r)])} stroke={color} strokeWidth={w} />
    default:
      return null
  }
}

export function LinePreview({ g, points, st, closed, start, end }: { g: PageGeometry; points: Point[]; st: ToolStyle; closed?: boolean; start?: LineEnding; end?: LineEnding }) {
  if (points.length < 2) return null
  const sp = strokeProps(g, st)
  const css = points.map((p) => g.toCss(p))
  const w = Math.max(1, g.len(st.width))
  return (
    <g opacity={st.opacity}>
      {closed ? (
        st.lineStyle === 'cloudy' ? (
          <path d={cloudPath(css, cloudBump(g, st))} fill={st.fill ?? 'none'} {...sp} strokeDasharray={undefined} />
        ) : (
          <polygon points={pts(g, points)} fill={st.fill ?? 'none'} {...sp} />
        )
      ) : (
        <polyline points={pts(g, points)} fill="none" {...sp} />
      )}
      {!closed && start && <Ending kind={start} tip={css[0]} from={css[1]} w={w} color={st.color} />}
      {!closed && end && <Ending kind={end} tip={css[css.length - 1]} from={css[css.length - 2]} w={w} color={st.color} />}
    </g>
  )
}

export function InkPreview({ g, strokes, color, width, opacity }: { g: PageGeometry; strokes: Point[][]; color: string; width: number; opacity: number }) {
  const w = Math.max(1, g.len(width))
  return (
    <g opacity={opacity} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round">
      {strokes.map((s, i) =>
        s.length === 1 ? (
          <circle key={i} cx={g.toCss(s[0])[0]} cy={g.toCss(s[0])[1]} r={w / 2} fill={color} stroke="none" />
        ) : (
          <polyline key={i} points={pts(g, s)} />
        )
      )}
    </g>
  )
}

/** Preview of a text markup annotation over the given quads. */
export function MarkupPreview({ g, quads, kind, color, opacity }: { g: PageGeometry; quads: Quad[]; kind: 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'; color: string; opacity: number }) {
  return (
    <g opacity={opacity} className={kind === 'Highlight' ? 'fc-markup-tools-multiply' : undefined}>
      {quads.map((q, i) => {
        const ul = g.toCss([q[0], q[1]])
        const ur = g.toCss([q[2], q[3]])
        const ll = g.toCss([q[4], q[5]])
        const lr = g.toCss([q[6], q[7]])
        const h = Math.hypot(ll[0] - ul[0], ll[1] - ul[1])
        const lw = Math.max(1, h / 14)
        if (kind === 'Highlight')
          return <polygon key={i} points={[ul, ur, lr, ll].map((p) => p.join(',')).join(' ')} fill={color} />
        if (kind === 'Underline') {
          const a: Point = [ll[0] + (ul[0] - ll[0]) * 0.07, ll[1] + (ul[1] - ll[1]) * 0.07]
          const b: Point = [lr[0] + (ur[0] - lr[0]) * 0.07, lr[1] + (ur[1] - lr[1]) * 0.07]
          return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={lw} />
        }
        if (kind === 'StrikeOut') {
          const a: Point = [(ul[0] + ll[0]) / 2, (ul[1] + ll[1]) / 2 + h * 0.08]
          const b: Point = [(ur[0] + lr[0]) / 2, (ur[1] + lr[1]) / 2 + h * 0.08]
          return <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={lw} />
        }
        // Squiggly: zig-zag along the bottom edge
        const len = Math.hypot(lr[0] - ll[0], lr[1] - ll[1])
        const ux = (lr[0] - ll[0]) / (len || 1)
        const uy = (lr[1] - ll[1]) / (len || 1)
        const amp = Math.max(1, h / 12)
        const step = amp * 2
        const pts2: string[] = []
        for (let d = 0, k = 0; d <= len; d += step, k++) {
          const off = k % 2 ? -amp : 0
          pts2.push(`${(ll[0] + ux * d - uy * off).toFixed(2)},${(ll[1] + uy * d + ux * off - amp).toFixed(2)}`)
        }
        return <polyline key={i} points={pts2.join(' ')} fill="none" stroke={color} strokeWidth={lw} />
      })}
    </g>
  )
}

/** A callout: leader line with arrow, plus the text box. */
export function CalloutPreview({ g, line, box, st }: { g: PageGeometry; line: Point[]; box: Rect | null; st: ToolStyle }) {
  const lineStyle: ToolStyle = { ...st, color: st.fontColor, lineStyle: 'solid', width: Math.max(0.75, st.width) }
  return (
    <g>
      {box && <RectPreview g={g} rect={box} st={{ ...st, color: st.fontColor }} />}
      {line.length >= 2 && <LinePreview g={g} points={line} st={lineStyle} start={st.endEnd} />}
    </g>
  )
}
