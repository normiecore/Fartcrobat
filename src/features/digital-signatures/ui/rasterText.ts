/**
 * Draws appearance text that MuPDF has no font for (Arabic, Hebrew, Indic scripts...) with the
 * system fonts, so the signature appearance shows it correctly shaped. The engine embeds the
 * images in place of the text.
 */
import type { DocumentModel } from '@renderer/sdk'
import type { AppearanceContent, RasterText } from '../types'
import { sigOps } from './store'

const FONT_PX = 96
const FONT_STACK = `${FONT_PX}px "Segoe UI", "Noto Sans", "DejaVu Sans", Tahoma, Arial, system-ui, sans-serif`
const cache = new Map<string, Promise<RasterText | null>>()

async function draw(text: string): Promise<RasterText | null> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.font = FONT_STACK
  const metrics = ctx.measureText(text)
  const ascent = Math.ceil(Math.max(FONT_PX * 0.95, metrics.actualBoundingBoxAscent || 0))
  const descent = Math.ceil(Math.max(FONT_PX * 0.3, metrics.actualBoundingBoxDescent || 0))
  const pad = Math.ceil(FONT_PX * 0.04)
  const width = Math.max(1, Math.ceil(Math.max(metrics.width, (metrics.actualBoundingBoxRight || 0) + (metrics.actualBoundingBoxLeft || 0))) + 2 * pad)
  canvas.width = Math.min(16384, width)
  canvas.height = ascent + descent
  // Resizing the canvas resets its state.
  ctx.font = FONT_STACK
  ctx.fillStyle = '#000'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, pad, ascent)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return null
  return { png: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height, fontPx: FONT_PX, ascentPx: ascent }
}

/** The text drawn as a transparent PNG (cached). */
export function rasterizeText(text: string): Promise<RasterText | null> {
  let p = cache.get(text)
  if (!p) {
    p = draw(text).catch(() => null)
    cache.set(text, p)
    if (cache.size > 64) cache.delete(cache.keys().next().value!)
  }
  return p
}

/**
 * The appearance with images for the texts the engine cannot draw with its fonts (unchanged when
 * every text can be drawn).
 */
export async function withRasterText(doc: DocumentModel, content: AppearanceContent): Promise<AppearanceContent> {
  const { rasterText: _old, ...plain } = content
  const missing = await sigOps(doc).textsNeedingRaster({ ...plain, options: { ...plain.options, image: null } })
  if (!missing.length) return plain
  const rasterText: Record<string, RasterText> = {}
  for (const t of missing) {
    const r = await rasterizeText(t)
    if (r) rasterText[t] = r
  }
  return { ...plain, rasterText }
}
