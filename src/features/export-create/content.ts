/**
 * Plain data describing the content of a page, as gathered by the engine for export. Shared by
 * the extraction code (engine), the layout analysis and the document builders.
 */

export type Box = [number, number, number, number]

/** A run of characters with the same style on one line. */
export interface XRun {
  text: string
  font: string
  size: number
  /** 0xRRGGBB */
  color: number
  /** FONT_BOLD | FONT_ITALIC | FONT_MONO | FONT_SERIF (see engine/ops/text.ts) */
  flags: number
  /** Left edge of every character (same length as text). */
  xs: number[]
  /** Right edge of the last character. */
  x1: number
  underline?: boolean
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
  /** Whitespace that came before this segment on the same text line ('' for the first). */
  lead: string
  /** Index of the MuPDF line it came from. */
  line: number
}

export interface XLine {
  x0: number
  y0: number
  x1: number
  y1: number
  baseline: number
  /** Dominant font size. */
  size: number
  /** Index of the MuPDF block (text and image blocks share one sequence). */
  block: number
  /** Text that does not run left to right (rotated or vertical); kept as one segment. */
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

/** A straight line or the edge of a box drawn on the page (table borders, underlines). */
export interface XRule {
  /** Horizontal rules: y0 == y1 (centre line); vertical: x0 == x1. */
  x0: number
  y0: number
  x1: number
  y1: number
  dir: 'h' | 'v'
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
  links: XLink[]
  blockCount: number
}

export const FONT_BOLD = 1
export const FONT_ITALIC = 2
export const FONT_MONO = 4
export const FONT_SERIF = 8

export function segmentText(seg: XSegment): string {
  return seg.runs.map((r) => r.text).join('')
}

export function lineText(line: XLine): string {
  return line.segments.map((s, i) => (i ? s.lead || ' ' : '') + segmentText(s)).join('')
}
