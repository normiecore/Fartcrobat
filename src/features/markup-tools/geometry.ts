/**
 * Pure geometry helpers for the comment drawing tools (page space, points, y down).
 * Kept free of DOM and engine imports so they can be unit-tested in Node.
 */
import type { Point, Quad, Rect } from '@shared/geometry'

export const dist = (a: Point, b: Point): number => Math.hypot(b[0] - a[0], b[1] - a[1])

const lerp = (a: Point, b: Point, t: number): Point => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

/** Distance from p to the segment ab. */
export function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return dist(p, a)
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Ramer–Douglas–Peucker polyline simplification. Keeps both end points. */
export function simplifyRdp(points: Point[], epsilon: number): Point[] {
  if (points.length <= 2) return points.slice()
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    let maxD = -1
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(points[i], points[s], points[e])
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (idx >= 0 && maxD > epsilon) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }
  return points.filter((_, i) => keep[i])
}

/** Light moving-average smoothing that keeps the end points (removes hand jitter). */
export function smoothPoints(points: Point[], passes = 2): Point[] {
  let pts = points.slice()
  for (let pass = 0; pass < passes; pass++) {
    if (pts.length < 3) return pts
    const out: Point[] = [pts[0]]
    for (let i = 1; i < pts.length - 1; i++) {
      out.push([(pts[i - 1][0] + 2 * pts[i][0] + pts[i + 1][0]) / 4, (pts[i - 1][1] + 2 * pts[i][1] + pts[i + 1][1]) / 4])
    }
    out.push(pts[pts.length - 1])
    pts = out
  }
  return pts
}

/** Inserts Catmull-Rom spline points so no segment is longer than maxSeg (smooth curves). */
export function densify(points: Point[], maxSeg: number): Point[] {
  if (points.length < 3 || maxSeg <= 0) return points.slice()
  const out: Point[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[Math.min(points.length - 1, i + 2)]
    out.push(p1)
    const n = Math.min(32, Math.floor(dist(p1, p2) / maxSeg))
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1)
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])])
    }
  }
  out.push(points[points.length - 1])
  return out
}

/** Removes consecutive duplicate points. */
export function dedupe(points: Point[], minDist = 0.01): Point[] {
  const out: Point[] = []
  for (const p of points) {
    if (!out.length || dist(out[out.length - 1], p) > minDist) out.push(p)
  }
  return out
}

/**
 * Turns raw pointer samples (page space) into a clean ink stroke: removes jitter, rounds corners
 * into smooth curves and drops redundant points. `pxPerPt` is the zoom (CSS px per point) so the
 * tolerance is about a quarter of a screen pixel at the zoom the stroke was drawn at.
 */
export function processStroke(raw: Point[], pxPerPt: number): Point[] {
  const pts = dedupe(raw, 0.05 / pxPerPt)
  if (pts.length <= 2) return pts.length === 1 ? [pts[0], [pts[0][0] + 0.01, pts[0][1]]] : pts
  const smooth = smoothPoints(pts, 2)
  const dense = densify(smooth, 2 / pxPerPt)
  return simplifyRdp(dense, 0.25 / pxPerPt).map(([x, y]) => [round2(x), round2(y)] as Point)
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** Shift-drag for rectangles and ovals: make the box square, keeping the drag direction. */
export function constrainSquare(a: Point, b: Point): Point {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const side = Math.max(Math.abs(dx), Math.abs(dy))
  return [a[0] + (dx < 0 ? -side : side), a[1] + (dy < 0 ? -side : side)]
}

/** Shift-drag for lines: snap the direction to multiples of `step` degrees (45 by default). */
export function snapAngle(a: Point, b: Point, step = 45): Point {
  const len = dist(a, b)
  if (len === 0) return b
  const ang = Math.atan2(b[1] - a[1], b[0] - a[0])
  const s = (step * Math.PI) / 180
  const q = Math.round(ang / s) * s
  return [a[0] + Math.cos(q) * len, a[1] + Math.sin(q) * len]
}

export function clampPoint(p: Point, width: number, height: number): Point {
  return [Math.max(0, Math.min(width, p[0])), Math.max(0, Math.min(height, p[1]))]
}

export function rectFrom(a: Point, b: Point): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
}

export function quadFromRect(r: Rect): Quad {
  // ul, ur, ll, lr
  return [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]
}

/** Moves a rect so it lies inside the page (shrinking it if it is larger than the page). */
export function fitRect(r: Rect, width: number, height: number): Rect {
  let w = Math.min(r[2] - r[0], width)
  let h = Math.min(r[3] - r[1], height)
  w = Math.max(w, 0)
  h = Math.max(h, 0)
  const x = Math.max(0, Math.min(width - w, r[0]))
  const y = Math.max(0, Math.min(height - h, r[1]))
  return [x, y, x + w, y + h]
}

/**
 * The leader line of a callout: from the arrow tip to a short "knee" and then to the middle of the
 * nearest side of the text box. Returns 2 or 3 points (tip first).
 */
export function calloutLine(tip: Point, box: Rect, knee = 18): Point[] {
  const cx = (box[0] + box[2]) / 2
  const cy = (box[1] + box[3]) / 2
  let conn: Point
  let k: Point
  if (tip[0] < box[0]) {
    conn = [box[0], cy]
    k = [box[0] - knee, cy]
  } else if (tip[0] > box[2]) {
    conn = [box[2], cy]
    k = [box[2] + knee, cy]
  } else if (tip[1] < box[1]) {
    conn = [cx, box[1]]
    k = [cx, box[1] - knee]
  } else {
    conn = [cx, box[3]]
    k = [cx, box[3] + knee]
  }
  // When the tip is (nearly) on the knee's side, a straight line looks better.
  const dTip = dist(tip, conn)
  if (dTip <= knee * 1.5 || dist(tip, k) >= dTip) return [tip, conn]
  return [tip, k, conn]
}

/**
 * Where the text box of a callout goes when the user releases the mouse at `at` after setting the
 * arrow tip: the box hangs off the release point, away from the tip.
 */
export function calloutBoxAt(tip: Point, at: Point, size: [number, number]): Rect {
  const [w, h] = size
  const x0 = at[0] >= tip[0] ? at[0] : at[0] - w
  const y0 = at[1] >= tip[1] ? at[1] - h / 2 : at[1] - h / 2
  return [x0, y0, x0 + w, y0 + h]
}

/** Signed area (positive = clockwise on screen, y down). */
export function signedArea(pts: Point[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

/** Points on an ellipse inscribed in a rect (for cloudy previews of ovals). */
export function ellipsePoints(r: Rect, n = 32): Point[] {
  const cx = (r[0] + r[2]) / 2
  const cy = (r[1] + r[3]) / 2
  const rx = (r[2] - r[0]) / 2
  const ry = (r[3] - r[1]) / 2
  const out: Point[] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    out.push([cx + rx * Math.cos(t), cy + ry * Math.sin(t)])
  }
  return out
}

/**
 * SVG path of a cloudy border around a closed polygon (CSS coordinates): a row of arcs that bulge
 * outwards along every edge, like Acrobat's cloud tool.
 */
export function cloudPath(poly: Point[], bump: number): string {
  if (poly.length < 2 || bump <= 0) return ''
  const cw = signedArea(poly) >= 0
  const parts: string[] = []
  let first = true
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const len = dist(a, b)
    if (len < 1e-6) continue
    const n = Math.max(1, Math.round(len / (bump * 1.6)))
    for (let k = 0; k < n; k++) {
      const p = lerp(a, b, k / n)
      const q = lerp(a, b, (k + 1) / n)
      const r = dist(p, q) / 2
      if (first) {
        parts.push(`M${p[0].toFixed(2)} ${p[1].toFixed(2)}`)
        first = false
      }
      parts.push(`A${(r * 1.05).toFixed(2)} ${(r * 1.05).toFixed(2)} 0 0 ${cw ? 1 : 0} ${q[0].toFixed(2)} ${q[1].toFixed(2)}`)
    }
  }
  parts.push('Z')
  return parts.join(' ')
}

// ---- eraser ---------------------------------------------------------------------------------

type Interval = [number, number]

/**
 * Parameter interval [t0, t1] (0..1) of segment p0→p1 that lies within distance r of the eraser
 * segment e0→e1 (a capsule), or null. The distance is a convex function of t, so the set is one
 * interval: find its minimum, then bisect to the two boundaries.
 */
export function capsuleInterval(p0: Point, p1: Point, e0: Point, e1: Point, r: number): Interval | null {
  const f = (t: number) => distToSegment(lerp(p0, p1, t), e0, e1)
  let lo = 0
  let hi = 1
  for (let i = 0; i < 48; i++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (f(m1) <= f(m2)) hi = m2
    else lo = m1
  }
  const tm = (lo + hi) / 2
  if (f(tm) > r) return null
  const bisect = (inside: number, outside: number) => {
    let a = inside
    let b = outside
    for (let i = 0; i < 40; i++) {
      const m = (a + b) / 2
      if (f(m) <= r) a = m
      else b = m
    }
    return (a + b) / 2
  }
  const t0 = f(0) <= r ? 0 : bisect(tm, 0)
  const t1 = f(1) <= r ? 1 : bisect(tm, 1)
  return [t0, t1]
}

function mergeIntervals(list: Interval[]): Interval[] {
  if (list.length < 2) return list
  const sorted = list.slice().sort((a, b) => a[0] - b[0])
  const out: Interval[] = [sorted[0].slice() as Interval]
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1]
    if (sorted[i][0] <= last[1]) last[1] = Math.max(last[1], sorted[i][1])
    else out.push(sorted[i].slice() as Interval)
  }
  return out
}

function bboxOf(pts: Point[]): Rect {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const p of pts) {
    x0 = Math.min(x0, p[0])
    y0 = Math.min(y0, p[1])
    x1 = Math.max(x1, p[0])
    y1 = Math.max(y1, p[1])
  }
  return [x0, y0, x1, y1]
}

const boxesTouch = (a: Rect, b: Rect, pad: number) =>
  a[0] - pad <= b[2] && a[2] + pad >= b[0] && a[1] - pad <= b[3] && a[3] + pad >= b[1]

/**
 * Erases the parts of ink strokes that lie within `radius` of the eraser path (a polyline; a single
 * point erases a disc). Strokes are split where the eraser crosses them; pieces shorter than
 * `minPiece` are dropped. Returns the new strokes and whether anything changed.
 */
export function eraseStrokes(
  strokes: Point[][],
  path: Point[],
  radius: number,
  minPiece = 0.75
): { strokes: Point[][]; changed: boolean } {
  if (!path.length) return { strokes, changed: false }
  const caps: [Point, Point][] = path.length === 1 ? [[path[0], path[0]]] : []
  for (let i = 0; i + 1 < path.length; i++) caps.push([path[i], path[i + 1]])
  const capBoxes = caps.map((c) => bboxOf(c))
  const pathBox = bboxOf(path)
  let changed = false
  const out: Point[][] = []
  for (const stroke of strokes) {
    if (!stroke.length) continue
    if (!boxesTouch(bboxOf(stroke), pathBox, radius)) {
      out.push(stroke)
      continue
    }
    if (stroke.length === 1) {
      if (caps.some(([a, b]) => distToSegment(stroke[0], a, b) <= radius)) changed = true
      else out.push(stroke)
      continue
    }
    let current: Point[] | null = null
    const pieces: Point[][] = []
    let strokeChanged = false
    for (let i = 0; i + 1 < stroke.length; i++) {
      const p0 = stroke[i]
      const p1 = stroke[i + 1]
      const segBox = bboxOf([p0, p1])
      const cut: Interval[] = []
      for (let c = 0; c < caps.length; c++) {
        if (!boxesTouch(segBox, capBoxes[c], radius)) continue
        const iv = capsuleInterval(p0, p1, caps[c][0], caps[c][1], radius)
        if (iv) cut.push(iv)
      }
      const removed = mergeIntervals(cut)
      if (!removed.length) {
        if (!current) current = [p0]
        current.push(p1)
        continue
      }
      strokeChanged = true
      // kept = [0,1] minus removed
      const kept: Interval[] = []
      let t = 0
      for (const [a, b] of removed) {
        if (a > t) kept.push([t, a])
        t = Math.max(t, b)
      }
      if (t < 1) kept.push([t, 1])
      if (!kept.length && current) {
        pieces.push(current)
        current = null
      }
      for (const [a, b] of kept) {
        const e = lerp(p0, p1, b)
        if (a === 0 && current) current.push(e)
        else {
          if (current) pieces.push(current)
          current = [lerp(p0, p1, a), e]
        }
        if (b < 1) {
          pieces.push(current)
          current = null
        }
      }
    }
    if (current) pieces.push(current)
    if (!strokeChanged) {
      out.push(stroke)
      continue
    }
    changed = true
    for (const piece of pieces) {
      const clean = dedupe(piece, 1e-6)
      let len = 0
      for (let i = 0; i + 1 < clean.length; i++) len += dist(clean[i], clean[i + 1])
      if (clean.length >= 2 && len >= minPiece) out.push(clean.map(([x, y]) => [round2(x), round2(y)] as Point))
    }
  }
  return { strokes: changed ? out : strokes, changed }
}

/** Bounding box of ink strokes, or null when empty. */
export function inkBounds(strokes: Point[][]): Rect | null {
  const pts = strokes.flat()
  return pts.length ? bboxOf(pts) : null
}
