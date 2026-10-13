// Canvas helpers that turn typed names, drawings and photos into clean transparent signature PNGs.
import type { SignatureImage } from './state'

/** Handwriting fonts offered on the Type tab (bundled with the app through @fontsource). */
export const SIGNATURE_FONTS = [
  { family: 'Dancing Script', label: 'Dancing Script' },
  { family: 'Great Vibes', label: 'Great Vibes' },
  { family: 'Caveat', label: 'Caveat' },
  { family: 'Allura', label: 'Allura' }
] as const

export const INK_COLORS = [
  { value: '#000000', label: 'Black' },
  { value: '#1a3e9a', label: 'Blue' }
] as const

const MAX_HEIGHT = 300
const MAX_WIDTH = 1600

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(w))
  c.height = Math.max(1, Math.round(h))
  return c
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('Drawing is not available')
  return ctx
}

/** Bounding box of pixels with alpha above `threshold`, or null when the canvas is empty. */
export function contentBox(c: HTMLCanvasElement, threshold = 8): { x: number; y: number; w: number; h: number } | null {
  const { width, height } = c
  const data = ctx2d(c).getImageData(0, 0, width, height).data
  let x0 = width
  let y0 = height
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < height; y++) {
    const row = y * width * 4
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  if (x1 < 0) return null
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** Crops to the visible content plus a small margin and limits the size. Null if empty. */
export function trimToImage(c: HTMLCanvasElement, margin = 0.04): SignatureImage | null {
  const box = contentBox(c)
  if (!box) return null
  const pad = Math.max(2, Math.round(Math.max(box.w, box.h) * margin))
  const sx = Math.max(0, box.x - pad)
  const sy = Math.max(0, box.y - pad)
  const sw = Math.min(c.width - sx, box.w + pad * 2)
  const sh = Math.min(c.height - sy, box.h + pad * 2)
  const scale = Math.min(1, MAX_HEIGHT / sh, MAX_WIDTH / sw)
  const out = newCanvas(sw * scale, sh * scale)
  const octx = ctx2d(out)
  octx.imageSmoothingQuality = 'high'
  octx.drawImage(c, sx, sy, sw, sh, 0, 0, out.width, out.height)
  return { dataUrl: out.toDataURL('image/png'), width: out.width, height: out.height }
}

/** Renders a typed name in a handwriting font. Waits for the font to load first. */
export async function renderTyped(text: string, family: string, color: string): Promise<SignatureImage | null> {
  const value = text.trim()
  if (!value) return null
  const px = 140
  const font = `${px}px "${family}"`
  try {
    await document.fonts.load(font, value)
  } catch {}
  const probe = ctx2d(newCanvas(1, 1))
  probe.font = font
  const m = probe.measureText(value)
  const left = Math.ceil(m.actualBoundingBoxLeft || 0)
  const width = Math.ceil((m.actualBoundingBoxRight || m.width) + left) + px
  const ascent = Math.ceil(m.actualBoundingBoxAscent || px)
  const descent = Math.ceil(m.actualBoundingBoxDescent || px * 0.3)
  const c = newCanvas(width, ascent + descent + px * 0.5)
  const ctx = ctx2d(c)
  ctx.font = font
  ctx.fillStyle = color
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(value, left + px / 2, ascent + px * 0.25)
  return trimToImage(c)
}

/** Loads an image file (PNG/JPEG...) into a canvas. */
export function loadImage(bytes: Uint8Array, mime: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }))
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('This file is not an image Fartcrobat can read. Use a PNG or JPEG file.'))
    }
    img.src = url
  })
}

export function mimeFor(name: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'bmp') return 'image/bmp'
  return 'image/png'
}

/**
 * Cleans up a photo or scan of a signature: the paper becomes transparent (with soft edges so the
 * ink stays smooth) and the result is cropped to the ink. Images that already have a transparent
 * background keep it.
 */
export function cleanSignatureImage(img: HTMLImageElement | HTMLCanvasElement): SignatureImage | null {
  const w0 = img instanceof HTMLImageElement ? img.naturalWidth : img.width
  const h0 = img instanceof HTMLImageElement ? img.naturalHeight : img.height
  if (!w0 || !h0) return null
  // work at a bounded resolution
  const scale = Math.min(1, 2400 / Math.max(w0, h0))
  const c = newCanvas(w0 * scale, h0 * scale)
  const ctx = ctx2d(c)
  ctx.drawImage(img, 0, 0, c.width, c.height)
  const data = ctx.getImageData(0, 0, c.width, c.height)
  const px = data.data
  const n = c.width * c.height
  let transparent = 0
  const lums = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = px[i * 4]
    const g = px[i * 4 + 1]
    const b = px[i * 4 + 2]
    if (px[i * 4 + 3] < 16) transparent++
    lums[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }
  if (transparent / n < 0.3) {
    // Opaque background: estimate the paper brightness (90th percentile) and fade it out.
    const hist = new Uint32Array(256)
    for (let i = 0; i < n; i++) hist[lums[i]]++
    let acc = 0
    let bg = 255
    for (let v = 0; v < 256; v++) {
      acc += hist[v]
      if (acc >= n * 0.9) {
        bg = v
        break
      }
    }
    bg = Math.max(bg, 60)
    const lo = bg * 0.12 + 6
    const span = Math.max(30, bg * 0.38)
    for (let i = 0; i < n; i++) {
      const d = bg - lums[i] - lo
      const a = d <= 0 ? 0 : Math.min(1, d / span)
      px[i * 4 + 3] = Math.round(px[i * 4 + 3] * a)
    }
    ctx.putImageData(data, 0, 0)
  }
  return trimToImage(c, 0.03)
}

/** A canvas-backed drawing pad with smoothed strokes (quadratic curves through midpoints). */
export class DrawPad {
  private strokes: { color: string; points: [number, number][] }[] = []
  private current: { color: string; points: [number, number][] } | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    private lineWidth: number
  ) {}

  get isEmpty(): boolean {
    return this.strokes.every((s) => s.points.length === 0)
  }

  begin(x: number, y: number, color: string) {
    this.current = { color, points: [[x, y]] }
    this.strokes.push(this.current)
    this.redraw()
  }

  extend(x: number, y: number) {
    if (!this.current) return
    const pts = this.current.points
    const last = pts[pts.length - 1]
    if (Math.hypot(x - last[0], y - last[1]) < 1.2) return
    pts.push([x, y])
    this.redraw()
  }

  end() {
    this.current = null
  }

  clear() {
    this.strokes = []
    this.current = null
    this.redraw()
  }

  /** Recolours every stroke (the colour buttons apply to the whole drawing). */
  setColor(color: string) {
    for (const s of this.strokes) s.color = color
    this.redraw()
  }

  redraw(target: HTMLCanvasElement = this.canvas, scale = 1) {
    const ctx = ctx2d(target)
    ctx.clearRect(0, 0, target.width, target.height)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of this.strokes) {
      const p = s.points.map(([x, y]) => [x * scale, y * scale] as [number, number])
      if (!p.length) continue
      ctx.strokeStyle = s.color
      ctx.fillStyle = s.color
      ctx.lineWidth = this.lineWidth * scale
      if (p.length === 1) {
        ctx.beginPath()
        ctx.arc(p[0][0], p[0][1], (this.lineWidth * scale) / 2, 0, Math.PI * 2)
        ctx.fill()
        continue
      }
      ctx.beginPath()
      ctx.moveTo(p[0][0], p[0][1])
      for (let i = 1; i < p.length - 1; i++) {
        const mx = (p[i][0] + p[i + 1][0]) / 2
        const my = (p[i][1] + p[i + 1][1]) / 2
        ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my)
      }
      const last = p[p.length - 1]
      ctx.lineTo(last[0], last[1])
      ctx.stroke()
    }
  }

  /** The drawing as a trimmed transparent PNG (rendered at 2x for crisp printing). */
  toImage(): SignatureImage | null {
    if (this.isEmpty) return null
    const out = newCanvas(this.canvas.width * 2, this.canvas.height * 2)
    this.redraw(out, 2)
    return trimToImage(out)
  }
}
