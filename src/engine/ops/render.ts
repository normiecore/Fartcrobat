import type { Matrix, Rect } from '@shared/geometry'
import { multiplyMatrix, rotateMatrix, scaleMatrix, transformRect, translateMatrix } from '@shared/geometry'
import { defineOps, withTransfer } from '../define'
import type { Session } from '../session'

export interface RenderOptions {
  /** Device pixels per PDF point. */
  scale: number
  /** Extra view rotation (View > Rotate View), clockwise. */
  rotate?: 0 | 90 | 180 | 270
  /** Region to render, in device pixels relative to the top-left of the full rendered page. */
  clip?: Rect
  annots?: boolean
  widgets?: boolean
  /** Annotation ids to leave out (e.g. while the user drags them). */
  hide?: number[]
  colorMode?: 'document' | 'dark' | 'high-contrast'
  /** Transparent background instead of white (used for overlays). */
  transparent?: boolean
}

export interface RenderResult {
  width: number
  height: number
  /** Offset of the rendered region inside the full page, in device pixels. */
  x: number
  y: number
  /** ImageBitmap in the browser worker; raw RGBA pixels in Node. */
  bitmap?: ImageBitmap
  pixels?: Uint8ClampedArray
}

export const MAX_RENDER_PIXELS = 40_000_000

/** Page space -> device pixel matrix for a given scale and view rotation, origin at the top-left. */
export function viewMatrix(s: Session, pageIndex: number, scale: number, rotate = 0): { ctm: Matrix; bbox: Rect } {
  const bounds = s.pageBounds(pageIndex)
  let ctm = multiplyMatrix(scaleMatrix(scale), rotateMatrix(rotate))
  const box = transformRect(bounds, ctm)
  ctm = multiplyMatrix(ctm, translateMatrix(-box[0], -box[1]))
  const bbox: Rect = [0, 0, Math.max(1, Math.round(box[2] - box[0])), Math.max(1, Math.round(box[3] - box[1]))]
  return { ctm, bbox }
}

export function renderToPixmap(s: Session, pageIndex: number, opts: RenderOptions) {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const { ctm, bbox } = viewMatrix(s, pageIndex, opts.scale, opts.rotate ?? 0)
  let region: Rect = bbox
  if (opts.clip) {
    region = [
      Math.max(0, Math.floor(opts.clip[0])),
      Math.max(0, Math.floor(opts.clip[1])),
      Math.min(bbox[2], Math.ceil(opts.clip[2])),
      Math.min(bbox[3], Math.ceil(opts.clip[3]))
    ]
    if (region[2] <= region[0] || region[3] <= region[1]) region = [0, 0, 1, 1]
  }
  const w = region[2] - region[0]
  const h = region[3] - region[1]
  if (w * h > MAX_RENDER_PIXELS) {
    throw new Error(`Render region too large (${w}x${h})`)
  }
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, region, true)
  pix.clear(opts.transparent ? 0 : 255)
  const hidden: { setHiddenForEditing(v: boolean): void }[] = []
  if (opts.hide?.length) {
    const ids = new Set(opts.hide)
    const all = [...page.getAnnotations(), ...page.getWidgets()]
    all.forEach((a, k) => {
      if (ids.has(s.annotationId(a, pageIndex, k))) {
        a.setHiddenForEditing(true)
        hidden.push(a)
      }
    })
  }
  const dev = new m.DrawDevice(ctm, pix)
  try {
    page.runPageContents(dev, m.Matrix.identity)
    if (opts.annots !== false) page.runPageAnnots(dev, m.Matrix.identity)
    if (opts.widgets !== false) page.runPageWidgets(dev, m.Matrix.identity)
    dev.close()
  } finally {
    dev.destroy()
    for (const a of hidden) a.setHiddenForEditing(false)
  }
  if (opts.colorMode === 'dark') pix.invertLuminance()
  else if (opts.colorMode === 'high-contrast') {
    pix.invertLuminance()
    pix.gamma(0.6)
  }
  return { pix, region }
}

async function toResult(pixels: Uint8ClampedArray, region: Rect) {
  const width = region[2] - region[0]
  const height = region[3] - region[1]
  if (typeof createImageBitmap === 'function' && typeof ImageData === 'function') {
    const bitmap = await createImageBitmap(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height))
    const result: RenderResult = { width, height, x: region[0], y: region[1], bitmap }
    return withTransfer(result, [bitmap])
  }
  const result: RenderResult = { width, height, x: region[0], y: region[1], pixels }
  return withTransfer(result, [pixels.buffer as ArrayBuffer])
}

export type ImageFormat = 'png' | 'jpeg'

/** Encodes a page as PNG or JPEG at the given DPI (export, print, OCR). */
export function encodePage(
  s: Session,
  pageIndex: number,
  opts: {
    dpi: number
    format: ImageFormat
    quality?: number
    annots?: boolean
    widgets?: boolean
    grayscale?: boolean
  }
): Uint8Array {
  const { pix } = renderToPixmap(s, pageIndex, {
    scale: opts.dpi / 72,
    annots: opts.annots,
    widgets: opts.widgets
  })
  let out = pix
  try {
    // JPEG and grayscale output need an opaque pixmap.
    const cs = opts.grayscale ? s.mupdf.ColorSpace.DeviceGray : s.mupdf.ColorSpace.DeviceRGB
    out = pix.convertToColorSpace(cs, opts.format === 'png' && !opts.grayscale)
    const data = opts.format === 'png' ? out.asPNG() : out.asJPEG(opts.quality ?? 90)
    return data.slice()
  } finally {
    if (out !== pix) out.destroy()
    pix.destroy()
  }
}

export default defineOps('render', {
  async page(s, pageIndex: number, opts: RenderOptions) {
    const { pix, region } = renderToPixmap(s, pageIndex, opts)
    try {
      const pixels = new Uint8ClampedArray(pix.getPixels())
      return await toResult(pixels, region)
    } finally {
      pix.destroy()
    }
  },

  /** Renders a single annotation's appearance (for drag previews). */
  async annotation(s, id: number, scale: number) {
    const { annot } = s.requireAnnotation(id)
    const m = s.mupdf
    const rect = annot.getBounds() as Rect
    const ctm = multiplyMatrix(scaleMatrix(scale), translateMatrix(-rect[0] * scale, -rect[1] * scale))
    const region: Rect = [
      0,
      0,
      Math.max(1, Math.ceil((rect[2] - rect[0]) * scale)),
      Math.max(1, Math.ceil((rect[3] - rect[1]) * scale))
    ]
    const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, region, true)
    pix.clear(0)
    const dev = new m.DrawDevice(ctm, pix)
    try {
      annot.run(dev, m.Matrix.identity)
      dev.close()
    } finally {
      dev.destroy()
    }
    try {
      return await toResult(new Uint8ClampedArray(pix.getPixels()), region)
    } finally {
      pix.destroy()
    }
  },

  /** Encoded image of a page (PNG/JPEG), e.g. for printing or export. */
  image(
    s,
    pageIndex: number,
    opts: { dpi: number; format: ImageFormat; quality?: number; annots?: boolean; widgets?: boolean; grayscale?: boolean }
  ) {
    const data = encodePage(s, pageIndex, opts)
    return withTransfer(data, [data.buffer as ArrayBuffer])
  }
})
