/**
 * Plain data describing the content of a page, as gathered by the engine for export. Shared by
 * the extraction code (engine), the layout analysis and the document builders. All coordinates are
 * in page space (points, origin top-left, y down).
 */

export type Box = [number, number, number, number]

/** A run of characters with the same style on one line. */
export interface XRun {
  text: string
  /** Font name as written in the PDF, without the subset prefix ("Helvetica-Bold"). */
  font: string
  size: number
  /** 0xRRGGBB */
  color: number
  /** FONT_BOLD | FONT_ITALIC | FONT_MONO | FONT_SERIF */
  flags: number
  x0: number
  x1: number
  underline?: boolean
  strike?: boolean
  /** External link target (http:, https:, mailto:...). */
  link?: string
}

/** Text on one line between two large gaps (a table cell, a bullet, a label...). */
export interface XSegment {
  x0: number
  y0: number
  x1: number
  y1: number
  baseline: number
  runs: XRun[]
}

/** One visual line of text: segments that share a baseline, left to right. */
export interface XLine {
  x0: number
  y0: number
  x1: number
  y1: number
  baseline: number
  /** Dominant font size. */
  size: number
  /** Index of the MuPDF block it came from (text and image blocks share one sequence). */
  block: number
  /** Text that does not run left to right (rotated or vertical). */
  rotated: boolean
  segments: XSegment[]
}

export interface XImage {
  x0: number
  y0: number
  x1: number
  y1: number
  block: number
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  /** Pixel size of the encoded image. */
  width: number
  height: number
}

/** A straight line drawn on the page (table borders, underlines). */
export interface XRule {
  /** Horizontal rules: y0 == y1; vertical rules: x0 == x1. */
  x0: number
  y0: number
  x1: number
  y1: number
  dir: 'h' | 'v'
  /** Stroke width in points. */
  width: number
  color: number
}

/** A filled rectangle (cell shading, coloured boxes). */
export interface XFill {
  x0: number
  y0: number
  x1: number
  y1: number
  color: number
}

/** Area of vector artwork (charts, diagrams, shapes): exported as a picture. */
export interface XDrawing {
  x0: number
  y0: number
  x1: number
  y1: number
  /** Has curves, slanted lines or gradients (a chart or diagram), not only filled rectangles. */
  art: boolean
}

export interface XLink {
  rect: Box
  uri: string
}

export interface PageContent {
  index: number
  width: number
  height: number
  lines: XLine[]
  images: XImage[]
  rules: XRule[]
  fills: XFill[]
  drawings: XDrawing[]
  links: XLink[]
  /** Underlines and strike-through lines of the text (the runs carry them as styles). */
  decorations: Box[]
}

export const FONT_BOLD = 1
export const FONT_ITALIC = 2
export const FONT_MONO = 4
export const FONT_SERIF = 8

export function segmentText(seg: XSegment): string {
  return seg.runs.map((r) => r.text).join('')
}

export function lineText(line: XLine): string {
  return line.segments.map(segmentText).join(' ')
}

/** Raw page pixels (for TIFF). */
export interface PageRaster {
  width: number
  height: number
  /** 1 (gray) or 3 (RGB), no alpha. */
  channels: 1 | 3
  pixels: Uint8Array
}
