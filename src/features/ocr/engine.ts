import type { Rect } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import { MAX_RENDER_PIXELS, viewMatrix } from '@engine/ops/render'
import type { Session } from '@engine/session'
import { ALMOST_NO_TEXT, MOSTLY_IMAGE } from './constants'
import { ocrLayers, removeOcrLayers, RunFont, writeOcrLayer } from './textLayer'
import type {
  OcrApplyOptions,
  OcrApplySummary,
  OcrPageImage,
  OcrPageResult,
  PageOcrStatus,
  ScanDetection
} from './types'

/** Pixels a page image for recognition may have (keeps memory in check on poster-sized pages). */
export const MAX_OCR_PIXELS = Math.min(36_000_000, MAX_RENDER_PIXELS)

/** Highest resolution (≤ dpi) at which the page stays within MAX_OCR_PIXELS. */
export function effectiveDpi(width: number, height: number, dpi: number): number {
  const area = Math.max(1, (width / 72) * (height / 72))
  const limit = Math.floor(Math.sqrt(MAX_OCR_PIXELS / area))
  return Math.max(36, Math.min(Math.round(dpi), limit))
}

/** Fraction of `bounds` covered by the union of `rects` (sampled on a 40x40 grid). */
function coverage(bounds: Rect, rects: Rect[]): number {
  if (!rects.length) return 0
  const n = 40
  const w = bounds[2] - bounds[0]
  const h = bounds[3] - bounds[1]
  if (w <= 0 || h <= 0) return 0
  let hit = 0
  for (let i = 0; i < n; i++) {
    const y = bounds[1] + ((i + 0.5) / n) * h
    for (let j = 0; j < n; j++) {
      const x = bounds[0] + ((j + 0.5) / n) * w
      if (rects.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3])) hit++
    }
  }
  return hit / (n * n)
}

function pageStatus(s: Session, pageIndex: number): PageOcrStatus {
  const page = s.page(pageIndex)
  const bounds = page.getBounds() as Rect
  const images: Rect[] = []
  let textChars = 0
  const st = page.toStructuredText('preserve-images')
  try {
    st.walk({
      onImageBlock(bbox) {
        images.push(bbox as Rect)
      },
      onChar(c) {
        if (!/\s/.test(c)) textChars++
      }
    })
  } finally {
    st.destroy()
  }
  const layers = ocrLayers(s.pdf.findPage(pageIndex))
  return {
    page: pageIndex,
    textChars,
    hasOcrLayer: layers.length > 0,
    ocrChars: layers.reduce((n, l) => n + l.chars, 0),
    imageCoverage: coverage(bounds, images)
  }
}

/** Up to three pages spread over the document: first, middle, last. */
export function samplePages(count: number): number[] {
  if (count <= 0) return []
  return [...new Set([0, Math.floor((count - 1) / 2), count - 1])]
}

export function looksScanned(st: PageOcrStatus): boolean {
  return !st.hasOcrLayer && st.textChars < ALMOST_NO_TEXT && st.imageCoverage >= MOSTLY_IMAGE
}

function checkPages(s: Session, pages: number[]): number[] {
  const n = s.pageCount()
  for (const p of pages) {
    if (!Number.isInteger(p) || p < 0 || p >= n) throw new EngineError(`Page ${p + 1} does not exist`, 'BAD_PAGE')
  }
  return pages
}

export default defineOps('ocr', {
  /** What each page holds: text, an earlier OCR layer, images. All pages when `pages` is omitted. */
  status(s, pages?: number[]): PageOcrStatus[] {
    const list = pages ? checkPages(s, pages) : [...Array(s.pageCount()).keys()]
    return list.map((p) => pageStatus(s, p))
  },

  /**
   * Looks at up to three pages: the document is "scanned" when most of them are covered by
   * images and have (almost) no text, and none has been recognized yet.
   */
  detectScanned(s): ScanDetection {
    const sampled = samplePages(s.pageCount()).map((p) => pageStatus(s, p))
    const scannedPages = sampled.filter(looksScanned).length
    const recognized = sampled.some((p) => p.hasOcrLayer)
    return { scanned: !recognized && sampled.length > 0 && scannedPages * 2 > sampled.length, sampled }
  },

  /** Renders a page (without comments or form fields) as a grayscale PNG for recognition. */
  renderPage(s, pageIndex: number, opts: { dpi: number }) {
    checkPages(s, [pageIndex])
    const m = s.mupdf
    const bounds = s.pageBounds(pageIndex)
    const dpi = effectiveDpi(bounds[2] - bounds[0], bounds[3] - bounds[1], opts.dpi)
    const { ctm, bbox } = viewMatrix(s, pageIndex, dpi / 72, 0)
    // Drawn straight into an opaque gray pixmap: what Tesseract reads, and the smallest PNG.
    const pix = new m.Pixmap(m.ColorSpace.DeviceGray, bbox, false)
    let png: Uint8Array
    try {
      pix.clear(255)
      const dev = new m.DrawDevice(ctm, pix)
      try {
        s.page(pageIndex).runPageContents(dev, m.Matrix.identity)
        dev.close()
      } finally {
        dev.destroy()
      }
      png = pix.asPNG().slice()
    } finally {
      pix.destroy()
    }
    const image: OcrPageImage = { png, dpi, width: bbox[2], height: bbox[3], origin: [bounds[0], bounds[1]] }
    return withTransfer(image, [png.buffer as ArrayBuffer])
  },

  /**
   * Writes recognized text as an invisible text layer on each page (replacing an earlier OCR
   * layer of that page). One undoable step for the whole run.
   */
  addTextLayer: mutation(
    'Recognize Text',
    (s, results: OcrPageResult[], opts: OcrApplyOptions = {}): OcrApplySummary[] => {
      checkPages(
        s,
        results.map((r) => r.page)
      )
      const font = new RunFont(s.pdf)
      const out: OcrApplySummary[] = []
      results.forEach((r, i) => {
        out.push(writeOcrLayer(s, r, font, { skipExistingText: opts.skipExistingText !== false }))
        s.progress((i + 1) / results.length, `Adding text to page ${r.page + 1}`)
      })
      font.finish()
      return out
    }
  ),

  /** Removes the text layer added by Recognize Text from the given pages. Returns the pages changed. */
  removeTextLayer: mutation('Remove Recognized Text', (s, pages: number[]): number[] => {
    const changed: number[] = []
    for (const p of checkPages(s, pages)) {
      if (removeOcrLayers(s, p)) {
        changed.push(p)
        s.touch(p)
      }
    }
    return changed
  })
})
