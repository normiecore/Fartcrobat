import type { Quad } from '@shared/geometry'

/** One recognized word, positioned in page space. */
export interface OcrWord {
  text: string
  /**
   * Where the word is on the page (page space, MuPDF quad order ul, ur, ll, lr). The baseline
   * runs from ll to lr; the text is fitted so its characters exactly cover this quad.
   */
  quad: Quad
  /** Tesseract's confidence, 0..100. */
  confidence?: number
}

/** A line of words in reading order. Words of a line should share one baseline and height. */
export interface OcrLine {
  words: OcrWord[]
}

/** The recognized text of one page, ready to be written as an invisible text layer. */
export interface OcrPageResult {
  page: number
  lines: OcrLine[]
  /** Tesseract language string, e.g. "eng" or "eng+fra". */
  language?: string
  /** Resolution the page was recognized at. */
  dpi?: number
  /** Mean word confidence, 0..100. */
  confidence?: number
}

export interface OcrApplyOptions {
  /**
   * Drop recognized words that lie on text the page already has (other than an earlier OCR
   * layer, which is always replaced), so mixed pages do not get every word twice. Default true.
   */
  skipExistingText?: boolean
}

export interface OcrApplySummary {
  page: number
  words: number
  /** Words left out because the page already had real text there. */
  skipped: number
}

/** What a page holds, for "Skip pages that already have text" and scanned-document detection. */
export interface PageOcrStatus {
  page: number
  /** Non-whitespace characters of all text on the page (recognized text included). */
  textChars: number
  /** The page has a text layer added by Recognize Text. */
  hasOcrLayer: boolean
  /** Non-whitespace characters of that layer. */
  ocrChars: number
  /** Fraction of the page area covered by images (0..1). */
  imageCoverage: number
}

export interface ScanDetection {
  scanned: boolean
  /** Pages that were looked at. */
  sampled: PageOcrStatus[]
}

/** A page rendered for recognition. */
export interface OcrPageImage {
  png: Uint8Array
  /** Resolution actually used (lowered for very large pages). */
  dpi: number
  width: number
  height: number
  /** Page-space position of the image's top-left pixel. */
  origin: [number, number]
}
