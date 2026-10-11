/**
 * Draws stamps that MuPDF cannot draw by name (Sign Here, dynamic stamps, a few Standard Business
 * ones) with a canvas, and produces palette previews for every stamp.
 */
import { useEffect, useState } from 'react'
import { authorName, usePrefs, type DocumentModel } from '@renderer/sdk'
import type { StampDef } from './stampCatalog'
import { BUILTIN_ASPECT } from './stampCatalog'
import { customById } from './stampStore'

type StampOps = typeof import('./engine').default

const SERIF = "'Times New Roman', 'Liberation Serif', 'Nimbus Roman', Times, serif"
const SANS = "'Segoe UI', 'Helvetica Neue', Arial, 'Liberation Sans', Helvetica, sans-serif"

export interface StampBitmap {
  png: Uint8Array
  dataUrl: string
  width: number
  height: number
}

export interface DrawOptions {
  author: string
  date: Date
  /** Canvas pixels per PDF point. */
  pxPerPt: number
}

/** Size in points the drawing is designed at (the placed size is chosen separately). */
function designSize(def: StampDef): [number, number] {
  if (def.shape === 'box') return [190, 190 / BUILTIN_ASPECT]
  return [def.width, def.width / def.aspect]
}

export function formatStampTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function formatStampDate(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Second line of a dynamic stamp: "By Jane Smith at 3:45 PM, Oct 11, 2026". */
export function dynamicLine(author: string, date: Date): string {
  return `By ${author} at ${formatStampTime(date)}, ${formatStampDate(date)}`
}

/** Text stored in the contents of a dynamic stamp (shows in the comments list). */
export function dynamicContents(def: StampDef, author: string, date: Date): string {
  return `${def.label} by ${author} at ${formatStampTime(date)}, ${formatStampDate(date)}`
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.lineTo(x + w - rr, y)
  ctx.arcTo(x + w, y, x + w, y + rr, rr)
  ctx.lineTo(x + w, y + h - rr)
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr)
  ctx.lineTo(x + rr, y + h)
  ctx.arcTo(x, y + h, x, y + h - rr, rr)
  ctx.lineTo(x, y + rr)
  ctx.arcTo(x, y, x + rr, y, rr)
  ctx.closePath()
}

/** Largest font size (<= max) at which every line fits the width. */
function fitFont(ctx: CanvasRenderingContext2D, lines: string[], family: string, weight: string, maxSize: number, width: number): number {
  let size = maxSize
  for (const line of lines) {
    ctx.font = `${weight} ${size}px ${family}`
    const w = ctx.measureText(line).width
    if (w > width) size = Math.max(4, (size * width) / w)
  }
  return size
}

function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

function drawBox(ctx: CanvasRenderingContext2D, def: StampDef, w: number, h: number) {
  // Same look as MuPDF's named stamps: thin border, bold serif capitals, tilted a little.
  ctx.translate(w / 2, h / 2)
  ctx.rotate((-0.6 * Math.PI) / 180)
  ctx.translate(-w / 2, -h / 2)
  ctx.strokeStyle = def.color
  ctx.fillStyle = def.color
  ctx.lineWidth = 2
  roundRect(ctx, 3, 3, w - 6, h - 6, 4)
  ctx.stroke()
  const lines = def.lines ?? [def.label.toUpperCase()]
  const max = lines.length > 1 ? 17 : 30
  const size = fitFont(ctx, lines, SERIF, 'bold', max, w - 20)
  ctx.font = `bold ${size}px ${SERIF}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lh = size * 1.05
  const top = h / 2 - (lh * (lines.length - 1)) / 2
  lines.forEach((line, i) => ctx.fillText(line, w / 2, top + i * lh + size * 0.04))
}

function drawTag(ctx: CanvasRenderingContext2D, def: StampDef, w: number, h: number) {
  const tip = h * 0.48
  const r = 4
  ctx.fillStyle = def.color
  ctx.beginPath()
  ctx.moveTo(1, h / 2)
  ctx.lineTo(tip, 1)
  ctx.lineTo(w - 1 - r, 1)
  ctx.arcTo(w - 1, 1, w - 1, 1 + r, r)
  ctx.lineTo(w - 1, h - 1 - r)
  ctx.arcTo(w - 1, h - 1, w - 1 - r, h - 1, r)
  ctx.lineTo(tip, h - 1)
  ctx.closePath()
  ctx.fill()
  const lines = def.lines ?? [def.label.toUpperCase()]
  const size = fitFont(ctx, lines, SANS, 'bold', h * 0.46, w - tip - 10)
  ctx.fillStyle = '#ffffff'
  ctx.font = `bold ${size}px ${SANS}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(lines[0], tip + (w - tip) / 2 - 2, h / 2 + size * 0.04)
}

function drawBadge(ctx: CanvasRenderingContext2D, def: StampDef, w: number, h: number) {
  const r = Math.min(w, h) / 2 - 2
  const cx = w / 2
  const cy = h / 2
  ctx.fillStyle = withAlpha(def.color, 0.12)
  ctx.strokeStyle = def.color
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.lineWidth = 3.5
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  if (def.shape === 'check') {
    ctx.moveTo(cx - r * 0.45, cy + r * 0.02)
    ctx.lineTo(cx - r * 0.12, cy + r * 0.36)
    ctx.lineTo(cx + r * 0.48, cy - r * 0.34)
  } else {
    const k = r * 0.38
    ctx.moveTo(cx - k, cy - k)
    ctx.lineTo(cx + k, cy + k)
    ctx.moveTo(cx + k, cy - k)
    ctx.lineTo(cx - k, cy + k)
  }
  ctx.stroke()
}

function drawDynamic(ctx: CanvasRenderingContext2D, def: StampDef, w: number, h: number, opts: DrawOptions) {
  ctx.fillStyle = withAlpha(def.color, 0.07)
  ctx.strokeStyle = def.color
  ctx.lineWidth = 2.5
  roundRect(ctx, 2, 2, w - 4, h - 4, 8)
  ctx.fill()
  ctx.stroke()
  const word = (def.lines ?? [def.label.toUpperCase()])[0]
  const info = dynamicLine(opts.author, opts.date)
  ctx.fillStyle = def.color
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  const big = fitFont(ctx, [word], SANS, 'bold', h * 0.42, w - 18)
  ctx.font = `bold ${big}px ${SANS}`
  ctx.fillText(word, w / 2, h * 0.52)
  const small = fitFont(ctx, [info], SANS, '600', h * 0.17, w - 16)
  ctx.font = `600 ${small}px ${SANS}`
  ctx.fillText(info, w / 2, h * 0.8)
}

function canvasToBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Could not draw the stamp'))
        return
      }
      void blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject)
    }, 'image/png')
  })
}

/** Draws a canvas stamp (box, tag, badge or dynamic) to a transparent PNG. */
export async function drawStamp(def: StampDef, opts: DrawOptions): Promise<StampBitmap> {
  const [w, h] = designSize(def)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * opts.pxPerPt))
  canvas.height = Math.max(1, Math.round(h * opts.pxPerPt))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Drawing is not available')
  ctx.scale(canvas.width / w, canvas.height / h)
  if (def.shape === 'box') drawBox(ctx, def, w, h)
  else if (def.shape === 'tag') drawTag(ctx, def, w, h)
  else if (def.shape === 'check' || def.shape === 'cross') drawBadge(ctx, def, w, h)
  else if (def.shape === 'dynamic') drawDynamic(ctx, def, w, h, opts)
  else throw new Error(`The ${def.label} stamp is not drawn with a canvas`)
  const png = await canvasToBytes(canvas)
  return { png, dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height }
}

export function bytesToDataUrl(bytes: Uint8Array, mime = 'image/png'): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return `data:${mime};base64,${btoa(bin)}`
}

export function dataUrlToBytes(url: string): Uint8Array {
  const comma = url.indexOf(',')
  const bin = atob(url.slice(comma + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---- previews --------------------------------------------------------------------------------

const previewCache = new Map<string, string>()

function previewKey(def: StampDef, author: string, minute: number): string {
  if (def.shape === 'dynamic') return `${def.id}|${author}|${minute}`
  return def.id
}

/** A data URL showing the stamp as it will be placed. */
export async function stampPreviewUrl(def: StampDef, doc: DocumentModel | null, author: string, now = new Date()): Promise<string> {
  const key = previewKey(def, author, Math.floor(now.getTime() / 60000))
  const hit = previewCache.get(key)
  if (hit) return hit
  let url: string
  if (def.shape === 'image') {
    url = customById(def.id)?.dataUrl ?? ''
  } else if (def.shape === 'builtin') {
    if (!doc) throw new Error('Open a document to see this stamp')
    const png = await doc.ops<StampOps>('stamps-measure').stampPreview(def.name, def.color, 2)
    url = bytesToDataUrl(png)
  } else {
    url = (await drawStamp(def, { author, date: now, pxPerPt: 2 })).dataUrl
  }
  if (def.shape !== 'image') previewCache.set(key, url)
  return url
}

/** React hook: preview image of a stamp (null while it is being drawn). */
export function useStampPreview(def: StampDef, doc: DocumentModel | null): string | null {
  usePrefs() // re-render when the author name changes
  const author = authorName()
  const custom = def.shape === 'image' ? (customById(def.id)?.dataUrl ?? null) : null
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60000))
  const key = previewKey(def, author, minute)
  const [state, setState] = useState<{ key: string; url: string | null }>(() => ({ key, url: previewCache.get(key) ?? null }))

  // Dynamic stamps show the current time: refresh them every minute.
  useEffect(() => {
    if (def.shape !== 'dynamic') return
    const t = window.setInterval(() => setMinute(Math.floor(Date.now() / 60000)), 15000)
    return () => window.clearInterval(t)
  }, [def.shape])

  useEffect(() => {
    if (def.shape === 'image') return
    const cached = previewCache.get(key)
    if (cached) {
      setState((s) => (s.key === key && s.url === cached ? s : { key, url: cached }))
      return
    }
    let alive = true
    stampPreviewUrl(def, doc, author)
      .then((url) => {
        if (alive) setState({ key, url })
      })
      .catch((err) => console.warn(`Stamp preview for ${def.label} failed`, err))
    return () => {
      alive = false
    }
  }, [key, def, doc, author])

  if (custom !== null) return custom
  return state.key === key ? state.url : (previewCache.get(key) ?? null)
}
