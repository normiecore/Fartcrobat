// Types and geometry shared by the Fill & Sign engine ops and its UI. No DOM, no MuPDF.
import type { Point, Rect } from '@shared/geometry'

export type TextKind = 'text' | 'date'
export type MarkKind = 'cross' | 'check' | 'dot' | 'line' | 'box'
export type SignatureKind = 'signature' | 'initials'
export type FillSignKind = TextKind | MarkKind | SignatureKind

/** Value of FartcrobatData/fartcrobat on every annotation this feature creates. */
export const FILLSIGN_TAG = 'fillsign'

/** Custom selection type used while a Fill & Sign item is selected. */
export const SELECTION_TYPE = 'fill-sign:item'

export const MARK_KINDS: MarkKind[] = ['cross', 'check', 'dot', 'line', 'box']
export const TEXT_KINDS: TextKind[] = ['text', 'date']
export const SIGNATURE_KINDS: SignatureKind[] = ['signature', 'initials']
export const ALL_KINDS: FillSignKind[] = [...TEXT_KINDS, ...MARK_KINDS, ...SIGNATURE_KINDS]

export const DEFAULT_TEXT_SIZE = 12
export const MIN_SIZE = 4
export const MAX_SIZE = 144
/** Sizes the A- / A+ buttons step through (points). */
export const SIZE_STEPS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 22, 24, 28, 32, 36, 42, 48, 60, 72, 96, 120, 144]

/** MuPDF lays out FreeText lines 1.2 x font size apart... */
export const LINE_HEIGHT = 1.2
/** ...with the first baseline 0.8 x font size below the top of the rectangle (no border). */
export const FIRST_BASELINE = 0.8
/** Extra width so MuPDF never wraps a line that was measured to fit exactly. */
export const TEXT_SLACK = 1

/** Natural height of a placed signature (0.5 in) and of initials. */
export const SIGNATURE_HEIGHT = 36
export const INITIALS_HEIGHT = 30

export const DEFAULT_COLOR = '#000000'
/** Colours offered in the Fill & Sign toolbar (Acrobat offers a similar short list). */
export const FILL_SIGN_COLORS = [
  { value: '#000000', label: 'Black' },
  { value: '#1a3e9a', label: 'Blue' },
  { value: '#c4161c', label: 'Red' }
]

export interface FillSignItem {
  /** Annotation id (object number). */
  id: number
  page: number
  kind: FillSignKind
  /** Visual box in page space: what the selection outline hugs. */
  rect: Rect
  /** Full annotation bounds (ink strokes are padded by MuPDF); used for drag previews. */
  bounds: Rect
  /** Text of text/date items, '' otherwise. */
  text: string
  /** Font size for text; nominal size for marks; height for signatures. */
  size: number
  /** #rrggbb */
  color: string
  /** Extra space between letters of text items, in points (0 = normal). */
  spacing: number
  locked: boolean
}

export function isTextKind(k: FillSignKind): k is TextKind {
  return k === 'text' || k === 'date'
}

export function isMarkKind(k: FillSignKind): k is MarkKind {
  return (MARK_KINDS as string[]).includes(k)
}

export function isSignatureKind(k: FillSignKind): k is SignatureKind {
  return k === 'signature' || k === 'initials'
}

export function isFillSignKind(k: string): k is FillSignKind {
  return (ALL_KINDS as string[]).includes(k)
}

/** Name used in menus and undo labels ("Add Check Mark"). */
export function kindLabel(kind: FillSignKind | string | undefined): string {
  switch (kind) {
    case 'text':
      return 'Text'
    case 'date':
      return 'Date'
    case 'cross':
      return 'Cross Mark'
    case 'check':
      return 'Check Mark'
    case 'dot':
      return 'Dot'
    case 'line':
      return 'Line'
    case 'box':
      return 'Rounded Box'
    case 'signature':
      return 'Signature'
    case 'initials':
      return 'Initials'
    default:
      return 'Item'
  }
}

/** Plain-language name for UI text ("check mark"). */
export function kindNoun(kind: FillSignKind): string {
  return kindLabel(kind).toLowerCase()
}

export function clampSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TEXT_SIZE
  return Math.round(Math.max(MIN_SIZE, Math.min(MAX_SIZE, size)) * 10) / 10
}

/** Next size up (dir 1) or down (dir -1) from SIZE_STEPS. */
export function stepSize(size: number, dir: 1 | -1): number {
  if (dir > 0) return SIZE_STEPS.find((s) => s > size + 0.01) ?? MAX_SIZE
  for (let i = SIZE_STEPS.length - 1; i >= 0; i--) if (SIZE_STEPS[i] < size - 0.01) return SIZE_STEPS[i]
  return MIN_SIZE
}

// ---- mark geometry -------------------------------------------------------------------------
// Every mark is drawn inside its visual box. Sizes are relative to the "font size" S so marks
// match the text around them, like Acrobat's Fill & Sign symbols.

/** Natural width/height of a mark at nominal size S. */
export function markDimensions(kind: MarkKind, size: number): [number, number] {
  switch (kind) {
    case 'check':
      return [size * 0.8, size * 0.7]
    case 'cross':
      return [size * 0.65, size * 0.65]
    case 'dot':
      return [size * 0.45, size * 0.45]
    case 'line':
      return [size * 4, lineWidthFor(size)]
    case 'box':
      return [size * 5, size * 2]
  }
}

/** Stroke width of ink marks at nominal size S. */
export function lineWidthFor(size: number): number {
  return Math.max(0.75, Math.round(size * 0.11 * 100) / 100)
}

/** Whether resizing keeps the width/height ratio. */
export function keepsAspect(kind: FillSignKind): boolean {
  return kind === 'check' || kind === 'cross' || kind === 'dot' || kind === 'signature' || kind === 'initials'
}

/** A rectangle of the given size centred on a point. */
export function rectAround(center: Point, w: number, h: number): Rect {
  return [center[0] - w / 2, center[1] - h / 2, center[0] + w / 2, center[1] + h / 2]
}

export function rectCenter(r: Rect): Point {
  return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]
}

/** Scales a rect around its centre. */
export function scaleRect(r: Rect, factor: number): Rect {
  const c = rectCenter(r)
  return rectAround(c, (r[2] - r[0]) * factor, (r[3] - r[1]) * factor)
}

/** Moves a rect (keeping its size) so it lies inside the page, as far as possible. */
export function clampRectToPage(r: Rect, pageWidth: number, pageHeight: number): Rect {
  const w = r[2] - r[0]
  const h = r[3] - r[1]
  let x = r[0]
  let y = r[1]
  if (x + w > pageWidth) x = pageWidth - w
  if (y + h > pageHeight) y = pageHeight - h
  if (x < 0) x = 0
  if (y < 0) y = 0
  return [x, y, x + w, y + h]
}

/**
 * Ink strokes of a mark filling `rect` (the visual box). Stroke centres are inset by half the
 * line width so the drawn stroke stays inside the box.
 */
export function markStrokes(kind: Exclude<MarkKind, 'dot'>, rect: Rect, lineWidth: number): Point[][] {
  const inset = kind === 'line' ? 0 : lineWidth / 2
  const x0 = rect[0] + inset
  const y0 = rect[1] + inset
  const x1 = rect[2] - inset
  const y1 = rect[3] - inset
  const w = Math.max(0.01, x1 - x0)
  const h = Math.max(0.01, y1 - y0)
  const at = (fx: number, fy: number): Point => [x0 + fx * w, y0 + fy * h]
  switch (kind) {
    case 'check':
      return [[at(0, 0.55), at(0.36, 1), at(1, 0)]]
    case 'cross':
      return [
        [at(0, 0), at(1, 1)],
        [at(1, 0), at(0, 1)]
      ]
    case 'line': {
      const cy = (rect[1] + rect[3]) / 2
      return [
        [
          [rect[0] + lineWidth / 2, cy],
          [rect[2] - lineWidth / 2, cy]
        ]
      ]
    }
    case 'box':
      return [roundedRectPath(x0, y0, x1, y1, Math.min(w, h) * 0.32)]
  }
}

/** Closed polyline approximating a rounded rectangle. */
export function roundedRectPath(x0: number, y0: number, x1: number, y1: number, radius: number): Point[] {
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2))
  const pts: Point[] = []
  const seg = 8
  const arc = (cx: number, cy: number, from: number) => {
    for (let i = 0; i <= seg; i++) {
      const a = from + (i / seg) * (Math.PI / 2)
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r])
    }
  }
  // y grows downwards: start at the top-left corner, go clockwise
  arc(x0 + r, y0 + r, Math.PI)
  arc(x1 - r, y0 + r, Math.PI * 1.5)
  arc(x1 - r, y1 - r, 0)
  arc(x0 + r, y1 - r, Math.PI / 2)
  pts.push(pts[0])
  return pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000])
}

/** Today's date in the user's locale (numeric, like Acrobat's Date field). */
export function formatToday(locale?: string, date = new Date()): string {
  try {
    return date.toLocaleDateString(locale, { year: 'numeric', month: '2-digit', day: '2-digit' })
  } catch {
    return date.toISOString().slice(0, 10)
  }
}
