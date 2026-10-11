/**
 * Pure measuring maths shared by the engine (creating/updating measurement annotations) and the
 * UI (live readouts). No DOM, no MuPDF.
 *
 * All input geometry is in page space (points, y down).
 */
import type { Point } from '@shared/geometry'

export type MeasureKind = 'distance' | 'perimeter' | 'area'
export type PageUnit = 'pt' | 'in' | 'mm' | 'cm'
export type RealUnit = 'pt' | 'in' | 'ft' | 'yd' | 'mi' | 'mm' | 'cm' | 'm' | 'km'

/** "pageValue pageUnit = realValue realUnit", e.g. 1 in = 1 ft, plus display precision. */
export interface MeasureScale {
  pageValue: number
  pageUnit: PageUnit
  realValue: number
  realUnit: RealUnit
  /** Number of decimals shown (0-4). */
  precision: number
}

export const PAGE_UNITS: { value: PageUnit; label: string }[] = [
  { value: 'in', label: 'in' },
  { value: 'cm', label: 'cm' },
  { value: 'mm', label: 'mm' },
  { value: 'pt', label: 'pt' }
]

export const REAL_UNITS: { value: RealUnit; label: string }[] = [
  { value: 'in', label: 'in' },
  { value: 'ft', label: 'ft' },
  { value: 'yd', label: 'yd' },
  { value: 'mi', label: 'mi' },
  { value: 'mm', label: 'mm' },
  { value: 'cm', label: 'cm' },
  { value: 'm', label: 'm' },
  { value: 'km', label: 'km' },
  { value: 'pt', label: 'pt' }
]

export const PRECISIONS: { value: number; label: string }[] = [
  { value: 0, label: '1' },
  { value: 1, label: '0.1' },
  { value: 2, label: '0.01' },
  { value: 3, label: '0.001' },
  { value: 4, label: '0.0001' }
]

/** Points per page unit. */
export const POINTS_PER_UNIT: Record<PageUnit, number> = {
  pt: 1,
  in: 72,
  cm: 72 / 2.54,
  mm: 72 / 25.4
}

/** Length of one real unit in metres (to convert between real units). */
const METRES_PER_REAL: Record<RealUnit, number> = {
  pt: 0.0254 / 72,
  in: 0.0254,
  ft: 0.3048,
  yd: 0.9144,
  mi: 1609.344,
  mm: 0.001,
  cm: 0.01,
  m: 1,
  km: 1000
}

const PAGE_UNIT_SET = new Set<string>(PAGE_UNITS.map((u) => u.value))
const REAL_UNIT_SET = new Set<string>(REAL_UNITS.map((u) => u.value))

export function isPageUnit(u: unknown): u is PageUnit {
  return typeof u === 'string' && PAGE_UNIT_SET.has(u)
}

export function isRealUnit(u: unknown): u is RealUnit {
  return typeof u === 'string' && REAL_UNIT_SET.has(u)
}

/** Scale used when a document has none: 1:1 in the unit chosen in Preferences. */
export function defaultScale(unit: PageUnit = 'in'): MeasureScale {
  return { pageValue: 1, pageUnit: unit, realValue: 1, realUnit: unit, precision: 2 }
}

/** Checks and normalizes a scale. Returns null when it cannot be used. */
export function sanitizeScale(s: Partial<MeasureScale> | null | undefined): MeasureScale | null {
  if (!s) return null
  const pageValue = Number(s.pageValue)
  const realValue = Number(s.realValue)
  if (!(pageValue > 0) || !(realValue > 0) || !Number.isFinite(pageValue) || !Number.isFinite(realValue)) return null
  if (!isPageUnit(s.pageUnit) || !isRealUnit(s.realUnit)) return null
  const precision = Math.max(0, Math.min(4, Math.round(Number(s.precision ?? 2))))
  return { pageValue, pageUnit: s.pageUnit, realValue, realUnit: s.realUnit, precision: Number.isFinite(precision) ? precision : 2 }
}

/** Real-world units per PDF point. */
export function realPerPoint(s: MeasureScale): number {
  return s.realValue / s.pageValue / POINTS_PER_UNIT[s.pageUnit]
}

/** Converts a value between real units (e.g. ft -> m). */
export function convertReal(value: number, from: RealUnit, to: RealUnit): number {
  return (value * METRES_PER_REAL[from]) / METRES_PER_REAL[to]
}

function trimNumber(n: number): string {
  // Up to 6 significant decimals, no exponent, no trailing zeros.
  const s = n.toFixed(6).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s
}

/** "1 in = 1 ft" */
export function scaleToString(s: MeasureScale): string {
  return `${trimNumber(s.pageValue)} ${s.pageUnit} = ${trimNumber(s.realValue)} ${s.realUnit}`
}

/** Parses "1 in = 1 ft", "1/4in=1ft", "0.25 in = 1 ft" or a ratio like "1:100" (1 cm = 1 m). */
export function parseScale(text: string, precision = 2): MeasureScale | null {
  const t = text.trim()
  const m = /^([\d./]+)\s*([a-z]+)\s*=\s*([\d./]+)\s*([a-z]+)$/i.exec(t)
  if (m) {
    return sanitizeScale({
      pageValue: parseFraction(m[1]),
      pageUnit: m[2].toLowerCase() as PageUnit,
      realValue: parseFraction(m[3]),
      realUnit: m[4].toLowerCase() as RealUnit,
      precision
    })
  }
  const r = /^([\d.]+)\s*:\s*([\d.]+)$/.exec(t)
  if (r) {
    // A pure ratio: 1:100 means 1 cm on paper is 100 cm in reality; shown in metres.
    const a = parseFloat(r[1])
    const b = parseFloat(r[2])
    if (!(a > 0) || !(b > 0)) return null
    return sanitizeScale({ pageValue: a, pageUnit: 'cm', realValue: b / 100, realUnit: 'm', precision })
  }
  return null
}

/** "0.25" or "1/4" -> 0.25 (NaN when invalid). */
export function parseFraction(s: string): number {
  const t = s.trim()
  const f = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/.exec(t)
  if (f) {
    const d = parseFloat(f[2])
    return d > 0 ? parseFloat(f[1]) / d : NaN
  }
  return /^\d*\.?\d+$/.test(t) ? parseFloat(t) : NaN
}

/** Common scales offered as presets (architectural, engineering and metric). */
export const SCALE_PRESETS: { label: string; scale: Omit<MeasureScale, 'precision'> }[] = [
  { label: 'Actual size (1:1)', scale: { pageValue: 1, pageUnit: 'in', realValue: 1, realUnit: 'in' } },
  { label: '1/8 in = 1 ft', scale: { pageValue: 0.125, pageUnit: 'in', realValue: 1, realUnit: 'ft' } },
  { label: '1/4 in = 1 ft', scale: { pageValue: 0.25, pageUnit: 'in', realValue: 1, realUnit: 'ft' } },
  { label: '1/2 in = 1 ft', scale: { pageValue: 0.5, pageUnit: 'in', realValue: 1, realUnit: 'ft' } },
  { label: '1 in = 1 ft', scale: { pageValue: 1, pageUnit: 'in', realValue: 1, realUnit: 'ft' } },
  { label: '1 in = 10 ft', scale: { pageValue: 1, pageUnit: 'in', realValue: 10, realUnit: 'ft' } },
  { label: '1 in = 20 ft', scale: { pageValue: 1, pageUnit: 'in', realValue: 20, realUnit: 'ft' } },
  { label: '1 in = 50 ft', scale: { pageValue: 1, pageUnit: 'in', realValue: 50, realUnit: 'ft' } },
  { label: '1 in = 100 ft', scale: { pageValue: 1, pageUnit: 'in', realValue: 100, realUnit: 'ft' } },
  { label: '1:20 (1 cm = 20 cm)', scale: { pageValue: 1, pageUnit: 'cm', realValue: 0.2, realUnit: 'm' } },
  { label: '1:50 (1 cm = 0.5 m)', scale: { pageValue: 1, pageUnit: 'cm', realValue: 0.5, realUnit: 'm' } },
  { label: '1:100 (1 cm = 1 m)', scale: { pageValue: 1, pageUnit: 'cm', realValue: 1, realUnit: 'm' } },
  { label: '1:200 (1 cm = 2 m)', scale: { pageValue: 1, pageUnit: 'cm', realValue: 2, realUnit: 'm' } },
  { label: '1:500 (1 cm = 5 m)', scale: { pageValue: 1, pageUnit: 'cm', realValue: 5, realUnit: 'm' } },
  { label: '1:1000 (1 cm = 10 m)', scale: { pageValue: 1, pageUnit: 'cm', realValue: 10, realUnit: 'm' } }
]

export function sameScale(a: MeasureScale | null, b: MeasureScale | null): boolean {
  if (!a || !b) return a === b
  return (
    Math.abs(a.pageValue - b.pageValue) < 1e-9 &&
    a.pageUnit === b.pageUnit &&
    Math.abs(a.realValue - b.realValue) < 1e-9 &&
    a.realUnit === b.realUnit &&
    a.precision === b.precision
  )
}

// ---- geometry ----------------------------------------------------------------------------

export function segmentLength(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1])
}

/** Total length of an open polyline. */
export function polylineLength(points: Point[]): number {
  let total = 0
  for (let i = 1; i < points.length; i++) total += segmentLength(points[i - 1], points[i])
  return total
}

/** Perimeter of a closed polygon. */
export function polygonPerimeter(points: Point[]): number {
  if (points.length < 2) return 0
  return polylineLength(points) + segmentLength(points[points.length - 1], points[0])
}

/** Signed area (shoelace). Positive when the vertices run clockwise on screen (y down). */
export function signedArea(points: Point[]): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a / 2
}

/** Area enclosed by a polygon, in square points. */
export function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0
  return Math.abs(signedArea(points))
}

/** Centroid of a polygon (falls back to the vertex average for degenerate shapes). */
export function polygonCentroid(points: Point[]): Point {
  const a = signedArea(points)
  if (points.length < 3 || Math.abs(a) < 1e-9) {
    const n = Math.max(1, points.length)
    return [points.reduce((s, p) => s + p[0], 0) / n, points.reduce((s, p) => s + p[1], 0) / n]
  }
  let cx = 0
  let cy = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    const f = p[0] * q[1] - q[0] * p[1]
    cx += (p[0] + q[0]) * f
    cy += (p[1] + q[1]) * f
  }
  return [cx / (6 * a), cy / (6 * a)]
}

/** Angle of the segment a->b in degrees, counter-clockwise from the positive x axis as seen on screen (0-360). */
export function angleDegrees(a: Point, b: Point): number {
  const deg = (Math.atan2(a[1] - b[1], b[0] - a[0]) * 180) / Math.PI
  const d = deg < 0 ? deg + 360 : deg
  return d === 0 || d === 360 ? 0 : d
}

/** Constrains b so that a->b is a multiple of 45 degrees (Shift while drawing). */
export function snap45(a: Point, b: Point): Point {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len === 0) return [b[0], b[1]]
  const step = Math.PI / 4
  const ang = Math.round(Math.atan2(dy, dx) / step) * step
  // Project onto the constrained direction so the pointer stays "under" the line.
  const ux = Math.cos(ang)
  const uy = Math.sin(ang)
  const proj = dx * ux + dy * uy
  const x = a[0] + ux * proj
  const y = a[1] + uy * proj
  return [Math.abs(x - a[0]) < 1e-9 ? a[0] : x, Math.abs(y - a[1]) < 1e-9 ? a[1] : y]
}

/** Nearest candidate within maxDist of p, or null. Candidates are packed as [x0, y0, x1, y1, ...]. */
export function nearestPoint(
  candidates: ArrayLike<number>,
  p: Point,
  maxDist: number
): { point: Point; index: number; dist: number } | null {
  let best = -1
  let bestD = maxDist * maxDist
  for (let i = 0; i + 1 < candidates.length; i += 2) {
    const dx = candidates[i] - p[0]
    const dy = candidates[i + 1] - p[1]
    const d = dx * dx + dy * dy
    if (d <= bestD) {
      bestD = d
      best = i
    }
  }
  if (best < 0) return null
  return { point: [candidates[best], candidates[best + 1]], index: best / 2, dist: Math.sqrt(bestD) }
}

// ---- values and labels ----------------------------------------------------------------------

const numberFormats = new Map<number, Intl.NumberFormat>()

/** Formats a value with up to `decimals` decimals, grouping thousands and dropping trailing zeros. */
export function formatNumber(value: number, decimals: number): string {
  const d = Math.max(0, Math.min(6, Math.round(decimals)))
  let f = numberFormats.get(d)
  if (!f) {
    f = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: d })
    numberFormats.set(d, f)
  }
  const s = f.format(value)
  return s === '-0' ? '0' : s
}

export function areaUnit(unit: RealUnit): string {
  return `sq ${unit}`
}

/** Unit shown for a measurement kind ("ft" or "sq ft"). */
export function unitFor(kind: MeasureKind, scale: MeasureScale): string {
  return kind === 'area' ? areaUnit(scale.realUnit) : scale.realUnit
}

export function formatMeasure(value: number, unit: string, precision: number): string {
  return `${formatNumber(value, precision)} ${unit}`
}

/** Converts a length in points to real units. */
export function toRealLength(points: number, scale: MeasureScale): number {
  return points * realPerPoint(scale)
}

/** Converts an area in square points to square real units. */
export function toRealArea(squarePoints: number, scale: MeasureScale): number {
  const f = realPerPoint(scale)
  return squarePoints * f * f
}

export interface MeasureResult {
  kind: MeasureKind
  /** Value in real units (square units for area). */
  value: number
  unit: string
  label: string
  /** Total length in real units (distance length, perimeter, or the polygon's perimeter for areas). */
  length: number
  /** Area in square real units (areas only, else 0). */
  area: number
}

/** Measures a shape in page space with a scale. */
export function measureShape(kind: MeasureKind, points: Point[], scale: MeasureScale): MeasureResult {
  let length = 0
  let area = 0
  let value = 0
  if (kind === 'distance') {
    length = points.length >= 2 ? toRealLength(segmentLength(points[0], points[points.length - 1]), scale) : 0
    value = length
  } else if (kind === 'perimeter') {
    length = toRealLength(polylineLength(points), scale)
    value = length
  } else {
    length = toRealLength(polygonPerimeter(points), scale)
    area = toRealArea(polygonArea(points), scale)
    value = area
  }
  const unit = unitFor(kind, scale)
  return { kind, value, unit, label: formatMeasure(value, unit, scale.precision), length, area }
}

/** Rounds a number for storage (keeps 6 decimals, no exponent). */
export function storeNumber(n: number): string {
  return trimNumber(n)
}

export const KIND_LABELS: Record<MeasureKind, string> = {
  distance: 'Distance',
  perimeter: 'Perimeter',
  area: 'Area'
}

/** Annotation subjects, as Acrobat names its measurement markups. */
export const KIND_SUBJECTS: Record<MeasureKind, string> = {
  distance: 'Distance Measurement',
  perimeter: 'Perimeter Measurement',
  area: 'Area Measurement'
}
