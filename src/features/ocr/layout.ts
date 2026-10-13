/**
 * Turns Tesseract's result (pixel boxes in the rendered page image) into lines of words with
 * page-space quads, ready for the engine's addTextLayer.
 */
import type { Point, Quad } from '@shared/geometry'
import type { OcrLine, OcrPageImage, OcrWord } from './types'

/** The parts of Tesseract's `blocks` output that are used. */
export interface TessBox {
  x0: number
  y0: number
  x1: number
  y1: number
}
export interface TessWord {
  text: string
  confidence: number
  bbox: TessBox
}
export interface TessLine {
  words: TessWord[]
  bbox?: TessBox
}
export interface TessParagraph {
  lines: TessLine[]
}
export interface TessBlock {
  paragraphs?: TessParagraph[] | null
}

/** Words below this confidence are noise (specks, photos) rather than text. */
export const MIN_CONFIDENCE = 20
/** Words made only of punctuation or symbols need at least this confidence. */
export const MIN_SYMBOL_CONFIDENCE = 50

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u

/** Whether a recognized word is kept in the text layer. */
export function keepWord(text: string, confidence: number): boolean {
  const t = text.trim()
  if (!t) return false
  if (confidence < MIN_CONFIDENCE) return false
  if (!HAS_LETTER_OR_DIGIT.test(t) && confidence < MIN_SYMBOL_CONFIDENCE) return false
  return true
}

/**
 * Maps a point of the image Tesseract recognized back to page space. When Tesseract deskewed the
 * image first (rotateAuto), it rotated it about its centre by `rotateRadians`; undo that, then
 * scale pixels to points and move to the page origin.
 */
export function imageToPage(image: Pick<OcrPageImage, 'dpi' | 'width' | 'height' | 'origin'>, rotateRadians = 0) {
  const scale = 72 / image.dpi
  const cx = image.width / 2
  const cy = image.height / 2
  const cos = Math.cos(rotateRadians)
  const sin = Math.sin(rotateRadians)
  return (p: Point): Point => {
    const dx = p[0] - cx
    const dy = p[1] - cy
    const x = cx + cos * dx + sin * dy
    const y = cy - sin * dx + cos * dy
    return [image.origin[0] + x * scale, image.origin[1] + y * scale]
  }
}

export interface PageLines {
  lines: OcrLine[]
  /** Mean confidence of the kept words (0 when there are none). */
  confidence: number
  words: number
}

/**
 * Lines of words from Tesseract blocks. All words of a line get the line's full height (top of the
 * tallest word to the bottom of the lowest), so selections and search highlights look like those
 * of ordinary text; horizontally each word keeps its own extent.
 */
export function tesseractToLines(
  blocks: TessBlock[] | null | undefined,
  image: Pick<OcrPageImage, 'dpi' | 'width' | 'height' | 'origin'>,
  rotateRadians = 0
): PageLines {
  const toPage = imageToPage(image, rotateRadians)
  const lines: OcrLine[] = []
  let confSum = 0
  let count = 0
  for (const block of blocks ?? []) {
    for (const para of block.paragraphs ?? []) {
      for (const line of para.lines ?? []) {
        const kept = (line.words ?? []).filter((w) => w?.bbox && keepWord(w.text ?? '', w.confidence ?? 0))
        if (!kept.length) continue
        const top = Math.min(...kept.map((w) => w.bbox.y0))
        const bottom = Math.max(...kept.map((w) => w.bbox.y1))
        if (!(bottom > top)) continue
        const words: OcrWord[] = []
        for (const w of kept) {
          const x0 = Math.min(w.bbox.x0, w.bbox.x1)
          const x1 = Math.max(w.bbox.x0, w.bbox.x1)
          if (!(x1 > x0)) continue
          const ul = toPage([x0, top])
          const ur = toPage([x1, top])
          const ll = toPage([x0, bottom])
          const lr = toPage([x1, bottom])
          const quad: Quad = [ul[0], ul[1], ur[0], ur[1], ll[0], ll[1], lr[0], lr[1]]
          words.push({ text: w.text.trim(), quad, confidence: w.confidence })
          confSum += w.confidence
          count++
        }
        if (words.length) lines.push({ words })
      }
    }
  }
  return { lines, confidence: count ? confSum / count : 0, words: count }
}
