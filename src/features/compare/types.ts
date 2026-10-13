import type { Rect } from '@shared/geometry'

/** What the user asked to compare (Compare files panel options). */
export interface CompareOptions {
  /** 'text' compares text only; 'text-images' also looks for changed images and graphics. */
  mode: 'text' | 'text-images'
  /** Differences in spacing and in how words are split by spaces are not reported. */
  ignoreWhitespace: boolean
  /** "Total" and "TOTAL" are the same word. */
  ignoreCase: boolean
  /** Report text whose font, size or colour changed while the words stayed the same. */
  formatting: boolean
}

export const DEFAULT_OPTIONS: CompareOptions = {
  mode: 'text-images',
  ignoreWhitespace: true,
  ignoreCase: false,
  formatting: true
}

/** One word (or punctuation mark) of a page, in reading order. */
export interface Token {
  /** Text as shown in the document (hyphenated words that were split over two lines are joined). */
  text: string
  /** Text normalised for comparison (NFKC, ligatures folded, soft hyphens removed). */
  norm: string
  /** Bounding boxes in page space (usually one; two for a word hyphenated over a line break). */
  rects: Rect[]
  /** Line number on the page. */
  line: number
  /**
   * Whitespace before the token on the same line ('' when the token is attached to the previous
   * one, e.g. punctuation; ' ' for the first token of a line).
   */
  ws: string
  font: string
  size: number
  /** 0xRRGGBB */
  color: number
  flags: number
}

/** Everything the comparison needs to know about one page. */
export interface PageTokens {
  /** Page index in its document. */
  page: number
  width: number
  height: number
  tokens: Token[]
  /** Text line boxes (masked out when looking for image/graphics differences). */
  textRects: Rect[]
  /** Image blocks on the page. */
  imageRects: Rect[]
  /** Tiny greyscale thumbnail (THUMB_W x THUMB_H) for pages without text, to align them visually. */
  thumb: Uint8Array | null
}

export const THUMB_W = 24
export const THUMB_H = 32

export type ChangeType =
  | 'replaced'
  | 'inserted'
  | 'deleted'
  | 'formatting'
  | 'image'
  | 'pageAdded'
  | 'pageRemoved'
  | 'pageMoved'

/** Filter groups shown in the results panel. */
export type ChangeCategory = 'replaced' | 'inserted' | 'deleted' | 'formatting' | 'image' | 'page'

export function categoryOf(type: ChangeType): ChangeCategory {
  return type === 'pageAdded' || type === 'pageRemoved' || type === 'pageMoved' ? 'page' : type
}

export const CATEGORY_LABELS: Record<ChangeCategory, string> = {
  replaced: 'Replaced',
  inserted: 'Inserted',
  deleted: 'Deleted',
  formatting: 'Formatting',
  image: 'Images',
  page: 'Pages'
}

export interface ChangeSide {
  /** Page index in that document. */
  page: number
  /** Areas in page space. */
  rects: Rect[]
  /**
   * True when the rects only mark a position (where text was inserted or deleted) rather than
   * content of this document.
   */
  anchor?: boolean
}

export interface Change {
  /** 1-based, in document order. */
  id: number
  type: ChangeType
  /** Text on the old side (replaced, deleted, formatting). */
  oldText: string
  /** Text on the new side (replaced, inserted, formatting). */
  newText: string
  /** Extra explanation ("Font changed from Helvetica to Times-Roman", "Image added"...). */
  detail: string
  old: ChangeSide | null
  new: ChangeSide | null
}

export type RowKind = 'match' | 'moved' | 'gap'

/** One row of the side-by-side view: pages shown next to each other. */
export interface AlignRow {
  old: number | null
  new: number | null
  kind: RowKind
}

export interface TextCompareResult {
  rows: AlignRow[]
  changes: Change[]
  /** Page pairs (old, new) whose images/graphics should be compared. */
  visualPairs: [number, number][]
  /** True when the documents were too different for a whole-document diff and were compared page by page. */
  pageByPage: boolean
}

export interface CompareResult extends TextCompareResult {
  options: CompareOptions
  /** Pages of each document that took part (page range). */
  oldPages: number[]
  newPages: number[]
  counts: Record<ChangeCategory, number>
  /** Milliseconds the comparison took. */
  elapsed: number
}

/** Pixels of a page rendered for the visual comparison (RGB, 3 bytes per pixel). */
export interface Raster {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

/** A region where the two renders differ outside text. */
export interface VisualRegion {
  oldRect: Rect
  newRect: Rect
  detail: string
}
