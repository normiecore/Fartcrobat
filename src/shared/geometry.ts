// Geometry primitives shared by the engine, the viewer and features.
// All page coordinates use MuPDF "page space": points (1/72 in), origin at the
// top-left of the visible page box, y growing downwards, page /Rotate applied.

export type Point = [number, number]
export type Rect = [number, number, number, number] // x0, y0, x1, y1
export type Quad = [number, number, number, number, number, number, number, number] // ul, ur, ll, lr
export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export function normalizeRect(r: Rect): Rect {
  return [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]
}

export function rectFromPoints(a: Point, b: Point): Rect {
  return normalizeRect([a[0], a[1], b[0], b[1]])
}

export function rectWidth(r: Rect): number {
  return r[2] - r[0]
}

export function rectHeight(r: Rect): number {
  return r[3] - r[1]
}

export function rectContains(r: Rect, p: Point, pad = 0): boolean {
  return p[0] >= r[0] - pad && p[0] <= r[2] + pad && p[1] >= r[1] - pad && p[1] <= r[3] + pad
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]
}

export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const r: Rect = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]
  return r[0] < r[2] && r[1] < r[3] ? r : null
}

export function rectUnion(a: Rect, b: Rect): Rect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}

export function inflateRect(r: Rect, dx: number, dy = dx): Rect {
  return [r[0] - dx, r[1] - dy, r[2] + dx, r[3] + dy]
}

export function offsetRect(r: Rect, dx: number, dy: number): Rect {
  return [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy]
}

export function quadToRect(q: Quad): Rect {
  const xs = [q[0], q[2], q[4], q[6]]
  const ys = [q[1], q[3], q[5], q[7]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

export function rectToQuad(r: Rect): Quad {
  return [r[0], r[1], r[2], r[1], r[0], r[3], r[2], r[3]]
}

export function multiplyMatrix(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5]
  ]
}

export function invertMatrix(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-12) return [...IDENTITY] as Matrix
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -m[4] * a - m[5] * c, -m[4] * b - m[5] * d]
}

export function transformPoint(p: Point, m: Matrix): Point {
  return [p[0] * m[0] + p[1] * m[2] + m[4], p[0] * m[1] + p[1] * m[3] + m[5]]
}

export function transformRect(r: Rect, m: Matrix): Rect {
  const pts = [
    transformPoint([r[0], r[1]], m),
    transformPoint([r[2], r[1]], m),
    transformPoint([r[0], r[3]], m),
    transformPoint([r[2], r[3]], m)
  ]
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

export function scaleMatrix(sx: number, sy = sx): Matrix {
  return [sx, 0, 0, sy, 0, 0]
}

export function translateMatrix(tx: number, ty: number): Matrix {
  return [1, 0, 0, 1, tx, ty]
}

/** Rotation by a multiple of 90 degrees, clockwise on screen (y down). */
export function rotateMatrix(degrees: number): Matrix {
  const d = ((degrees % 360) + 360) % 360
  switch (d) {
    case 90:
      return [0, 1, -1, 0, 0, 0]
    case 180:
      return [-1, 0, 0, -1, 0, 0]
    case 270:
      return [0, -1, 1, 0, 0, 0]
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Converts a CSS-ish color (#rrggbb or #rgb) to MuPDF 0..1 RGB. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim()
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h.slice(0, 6), 16)
  if (Number.isNaN(n)) return [0, 0, 0]
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

export function rgbToHex(c: number[] | null | undefined): string {
  if (!c || c.length === 0) return 'transparent'
  let rgb: number[]
  if (c.length === 1) rgb = [c[0], c[0], c[0]]
  else if (c.length === 4) rgb = [(1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3])]
  else rgb = c
  return (
    '#' +
    rgb
      .map((v) =>
        Math.round(clamp(v, 0, 1) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
  )
}

export const POINTS_PER_INCH = 72
/** CSS pixels per PDF point at 100% zoom (same convention as Acrobat and PDF.js). */
export const CSS_PX_PER_POINT = 96 / 72
