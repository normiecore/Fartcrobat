/**
 * Draws imposed sheets onto a canvas from page images rendered by the print engine op. The same
 * code draws the live preview and the 300 dpi sheets sent to the printer, so the preview shows
 * exactly what prints.
 */
import type { DocumentModel } from '@renderer/sdk'
import type printOps from './engine'
import type { Sheet } from './imposition'
import { sheetNeedsTurn } from './imposition'
import type { PrintContent } from './settings'

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface DrawOptions {
  /** Lighten everything to use less ink or toner. */
  saveInk: boolean
  /** Thrown away as soon as this returns true (a newer preview superseded it, or the job was cancelled). */
  cancelled?: () => boolean
}

export class PrintCancelled extends Error {
  constructor() {
    super('Printing was cancelled')
    this.name = 'PrintCancelled'
  }
}

/** Fraction of ink removed by "Save ink/toner". */
export const SAVE_INK_LIGHTEN = 0.4

/**
 * Renders page images for printing and keeps the most recent ones (posters reuse a page for every
 * tile; previews revisit the same sheets).
 */
export class PageImageCache {
  private entries = new Map<string, Promise<ImageBitmap>>()

  /**
   * `max` limits how many images are kept; evicted ones are only dropped (not closed), because a
   * preview that is still drawing may hold them. The print job frees images itself with keepOnly().
   */
  constructor(
    private readonly doc: DocumentModel,
    private readonly content: PrintContent,
    private readonly grayscale: boolean,
    private readonly max = Infinity
  ) {}

  private key(page: number, scale: number) {
    return `${page}:${this.doc.pageVersion(page)}:${quantize(scale)}`
  }

  get(page: number, scale: number): Promise<ImageBitmap> {
    const key = this.key(page, scale)
    const hit = this.entries.get(key)
    if (hit) {
      this.entries.delete(key)
      this.entries.set(key, hit)
      return hit
    }
    const ops = this.doc.ops<typeof printOps>('print')
    const promise = ops.renderPage(page, { scale: quantize(scale), content: this.content, grayscale: this.grayscale }).then((r) => {
      if (!r.bitmap) throw new Error('The page image could not be created')
      return r.bitmap
    })
    promise.catch(() => this.entries.delete(key))
    this.entries.set(key, promise)
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string
      this.entries.delete(oldest)
    }
    return promise
  }

  /** Closes every image except those for the given (page, scale) pairs. */
  keepOnly(needed: [page: number, scale: number][]) {
    const keep = new Set(needed.map(([p, s]) => this.key(p, s)))
    for (const [key, p] of this.entries) {
      if (keep.has(key)) continue
      this.entries.delete(key)
      void p.then((b) => b.close()).catch(() => {})
    }
  }

  clear() {
    this.keepOnly([])
  }
}

function quantize(scale: number) {
  return Math.max(0.001, Math.round(scale * 1000) / 1000)
}

/** The (page, render scale) pairs a sheet needs at `k` pixels per point. */
export function sheetImages(sheet: Sheet | undefined, k: number): [number, number][] {
  return sheet ? sheet.placements.map((p) => [p.page, k * p.scale]) : []
}

export type PageImageSource = (page: number, scale: number) => Promise<CanvasImageSource>

/**
 * Draws a sheet with `k` device pixels per point. The context must already be transformed so that
 * sheet point (0, 0) is at the origin.
 */
export async function drawSheet(ctx: Ctx2D, sheet: Sheet, k: number, source: PageImageSource, opts: DrawOptions): Promise<void> {
  const W = sheet.width * k
  const H = sheet.height * k
  // Fetch every page image first so the sheet is drawn in one go (no half-drawn previews).
  const images: CanvasImageSource[] = []
  for (const p of sheet.placements) {
    if (opts.cancelled?.()) throw new PrintCancelled()
    images.push(await source(p.page, k * p.scale))
  }
  if (opts.cancelled?.()) throw new PrintCancelled()
  ctx.save()
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  sheet.placements.forEach((p, i) => {
    ctx.save()
    if (p.clip) {
      ctx.beginPath()
      ctx.rect(p.clip[0] * k, p.clip[1] * k, (p.clip[2] - p.clip[0]) * k, (p.clip[3] - p.clip[1]) * k)
      ctx.clip()
    }
    const turned = p.rotate === 90 || p.rotate === 270
    const dw = (turned ? p.height : p.width) * k
    const dh = (turned ? p.width : p.height) * k
    ctx.translate((p.x + p.width / 2) * k, (p.y + p.height / 2) * k)
    ctx.rotate((p.rotate * Math.PI) / 180)
    ctx.drawImage(images[i], -dw / 2, -dh / 2, dw, dh)
    ctx.restore()
  })
  if (opts.saveInk) {
    // Blend toward white: dark areas use 40% less ink; white paper stays white.
    ctx.globalAlpha = SAVE_INK_LIGHTEN
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, W, H)
    ctx.globalAlpha = 1
  }
  if (sheet.border) {
    ctx.strokeStyle = '#000000'
    ctx.lineWidth = Math.max(1, 0.5 * k)
    for (const p of sheet.placements) {
      const lw = ctx.lineWidth
      ctx.strokeRect(p.x * k + lw / 2, p.y * k + lw / 2, p.width * k - lw, p.height * k - lw)
    }
  }
  if (sheet.cutMarks) drawCutMarks(ctx, sheet.cutMarks, k)
  if (sheet.label) {
    ctx.fillStyle = '#000000'
    const size = Math.max(6, 7 * k)
    ctx.font = `${size}px sans-serif`
    ctx.textBaseline = 'alphabetic'
    const x = (sheet.cutMarks ? sheet.cutMarks[0] : 18) * k
    const y = Math.max(size, (sheet.cutMarks ? sheet.cutMarks[1] : 18) * k - 4 * k)
    ctx.fillText(sheet.label, x + 12 * k, y, W - x * 2 - 24 * k)
  }
  ctx.restore()
}

function drawCutMarks(ctx: Ctx2D, trim: [number, number, number, number], k: number) {
  const [x0, y0, x1, y1] = trim.map((v) => v * k)
  const len = 12 * k
  const gap = 2 * k
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = Math.max(1, 0.5 * k)
  ctx.beginPath()
  for (const [x, dx] of [
    [x0, -1],
    [x1, 1]
  ] as const) {
    for (const [y, dy] of [
      [y0, -1],
      [y1, 1]
    ] as const) {
      // horizontal and vertical ticks pointing away from each corner of the trim box
      ctx.moveTo(x + dx * gap, y)
      ctx.lineTo(x + dx * (gap + len), y)
      ctx.moveTo(x, y + dy * gap)
      ctx.lineTo(x, y + dy * (gap + len))
    }
  }
  ctx.stroke()
}

export interface EncodedSheet {
  data: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  /** Size of the paper side in points, in the job's orientation. */
  widthPt: number
  heightPt: number
}

/** Above this size a sheet is also tried as JPEG (photos compress far better that way). */
const PNG_LIMIT = 3 * 1024 * 1024

/** Renders one sheet at `dpi` for the printer, turned to the job's paper orientation when needed. */
export async function renderSheetForPrint(
  sheet: Sheet,
  dpi: number,
  orientation: 'portrait' | 'landscape',
  source: PageImageSource,
  opts: DrawOptions
): Promise<EncodedSheet> {
  const k = dpi / 72
  const turn = sheetNeedsTurn(sheet, orientation)
  const widthPt = turn ? sheet.height : sheet.width
  const heightPt = turn ? sheet.width : sheet.height
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(widthPt * k)), Math.max(1, Math.round(heightPt * k)))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not create a drawing surface for printing')
  if (turn) {
    // A quarter turn counter-clockwise: the top of the sheet ends up on the left edge of the paper.
    ctx.translate(0, canvas.height)
    ctx.rotate(-Math.PI / 2)
  }
  await drawSheet(ctx, sheet, k, source, opts)
  let blob = await canvas.convertToBlob({ type: 'image/png' })
  let mime: EncodedSheet['mime'] = 'image/png'
  if (blob.size > PNG_LIMIT) {
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
    if (jpeg.size < blob.size) {
      blob = jpeg
      mime = 'image/jpeg'
    }
  }
  const data = new Uint8Array(await blob.arrayBuffer())
  canvas.width = 0
  canvas.height = 0
  return { data, mime, widthPt, heightPt }
}
