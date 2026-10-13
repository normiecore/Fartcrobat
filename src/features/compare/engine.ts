import type { Rect } from '@shared/geometry'
import { defineOps, EngineError, withTransfer } from '@engine/define'
import type { Session } from '@engine/session'
import { extractPageText } from '@engine/ops/text'
import { viewMatrix } from '@engine/ops/render'
import { extractToBytes } from '@engine/ops/pages'
import { tokenizePage } from './tokens'
import { buildReport, type ReportInput } from './report'
import { THUMB_H, THUMB_W, type PageTokens, type Raster } from './types'

/** Renders page contents and form fields (no comments) into an opaque pixmap. */
function renderOpaque(s: Session, pageIndex: number, scale: number, gray: boolean) {
  const m = s.mupdf
  const { ctm, bbox } = viewMatrix(s, pageIndex, scale, 0)
  const pix = new m.Pixmap(gray ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB, bbox, false)
  pix.clear(255)
  const page = s.page(pageIndex)
  const dev = new m.DrawDevice(ctm, pix)
  try {
    page.runPageContents(dev, m.Matrix.identity)
    page.runPageWidgets(dev, m.Matrix.identity)
    dev.close()
  } finally {
    dev.destroy()
  }
  return pix
}

/** A THUMB_W x THUMB_H greyscale thumbnail, to recognise pages that have no text. */
function thumbnail(s: Session, pageIndex: number, width: number): Uint8Array {
  const pix = renderOpaque(s, pageIndex, (THUMB_W * 2) / Math.max(1, width), true)
  try {
    const w = pix.getWidth()
    const h = pix.getHeight()
    const stride = pix.getStride()
    const px = pix.getPixels()
    const out = new Uint8Array(THUMB_W * THUMB_H)
    for (let y = 0; y < THUMB_H; y++)
      for (let x = 0; x < THUMB_W; x++) {
        // average the source block that maps onto this thumbnail pixel
        const x0 = Math.floor((x * w) / THUMB_W)
        const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / THUMB_W))
        const y0 = Math.floor((y * h) / THUMB_H)
        const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / THUMB_H))
        let sum = 0
        let n = 0
        for (let yy = y0; yy < Math.min(h, y1); yy++)
          for (let xx = x0; xx < Math.min(w, x1); xx++) {
            sum += px[yy * stride + xx]
            n++
          }
        out[y * THUMB_W + x] = n ? Math.round(sum / n) : 255
      }
    return out
  } finally {
    pix.destroy()
  }
}

/** Words with positions and formatting, line and image boxes for one page. */
export function pageTokens(s: Session, pageIndex: number): PageTokens {
  const t = extractPageText(s, pageIndex)
  const bounds = s.pageBounds(pageIndex)
  const width = bounds[2] - bounds[0]
  const height = bounds[3] - bounds[1]
  const tokens = tokenizePage(t)
  return {
    page: pageIndex,
    width,
    height,
    tokens,
    textRects: t.lines.map((l) => l.bbox as Rect),
    imageRects: t.images.map((im) => im.bbox as Rect),
    thumb: tokens.length === 0 ? thumbnail(s, pageIndex, width) : null
  }
}

export default defineOps('compare', {
  /** Text tokens of the given pages (reports progress per page). */
  extract(s, pages: number[]): PageTokens[] {
    const count = s.pageCount()
    const out: PageTokens[] = []
    pages.forEach((p, k) => {
      if (!Number.isInteger(p) || p < 0 || p >= count) throw new EngineError(`Page ${p + 1} does not exist`, 'BAD_PAGE')
      out.push(pageTokens(s, p))
      s.progress((k + 1) / pages.length, `Reading page ${p + 1}`)
    })
    return out
  },

  /** RGB pixels of a page `pixelWidth` pixels wide, for the image/graphics comparison. */
  raster(s, pageIndex: number, pixelWidth: number) {
    const b = s.pageBounds(pageIndex)
    const pix = renderOpaque(s, pageIndex, pixelWidth / Math.max(1, b[2] - b[0]), false)
    try {
      const w = pix.getWidth()
      const h = pix.getHeight()
      const stride = pix.getStride()
      const src = pix.getPixels()
      let data: Uint8Array
      if (stride === w * 3) data = new Uint8Array(src)
      else {
        data = new Uint8Array(w * h * 3)
        for (let y = 0; y < h; y++) data.set(src.subarray(y * stride, y * stride + w * 3), y * w * 3)
      }
      const r: Raster = { width: w, height: h, data }
      return withTransfer(r, [data.buffer as ArrayBuffer])
    } finally {
      pix.destroy()
    }
  },

  /** A new, unencrypted PDF holding copies of the given pages (removed pages for the report). */
  copyPages(s, pages: number[]) {
    const bytes = extractToBytes(s, pages)
    return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
  },

  /**
   * Builds the compare report from this (the new) document: a summary followed by annotated
   * copies of the changed pages. Does not modify the open document.
   */
  report(s, input: ReportInput) {
    const bytes = buildReport(s, input)
    return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
  }
})
