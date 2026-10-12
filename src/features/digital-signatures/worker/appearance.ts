/**
 * Visible signature appearance (Acrobat style): the signer's name in large type or their
 * handwritten signature image on the left, the signature details on the right.
 */
import type { Mupdf, PDFDocument, PDFObject } from '@engine/session'
import { num, pdfLiteral } from '@engine/util/pdf'
import type { AppearanceContent } from '../types'

const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
}

function winAnsiCode(cp: number): number | null {
  if (cp >= 0x20 && cp <= 0x7e) return cp
  if (cp >= 0xa0 && cp <= 0xff) return cp
  return WIN_ANSI_EXTRA[cp] ?? null
}

/** "2026.10.11 14:22:05 +02'00'" like Acrobat. */
export function formatSignatureDate(time: number): string {
  const d = new Date(time)
  const pad = (v: number) => String(v).padStart(2, '0')
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(Math.abs(tz) / 60))}'${pad(Math.abs(tz) % 60)}'`
}

/** The text lines on the right-hand side. */
export function detailLines(c: AppearanceContent): string[] {
  const o = c.options
  const L = o.showLabels
  const lines: string[] = []
  if (o.showName && c.name) lines.push(L ? `Digitally signed by ${c.name}` : c.name)
  if (o.showDistinguishedName && c.distinguishedName) lines.push(L ? `DN: ${c.distinguishedName}` : c.distinguishedName)
  if (o.showReason && c.reason?.trim()) lines.push(L ? `Reason: ${c.reason.trim()}` : c.reason.trim())
  if (o.showLocation && c.location?.trim()) lines.push(L ? `Location: ${c.location.trim()}` : c.location.trim())
  if (o.showDate) lines.push(L ? `Date: ${formatSignatureDate(c.time)}` : formatSignatureDate(c.time))
  return lines
}

interface TextFont {
  key: string
  ref: PDFObject
  width: (s: string, size: number) => number
  encode: (s: string) => string
}

function makeFont(m: Mupdf, pdf: PDFDocument, texts: string[]): TextFont {
  const font = new m.Font('Helvetica')
  const advCache = new Map<number, number>()
  const adv = (cp: number) => {
    let v = advCache.get(cp)
    if (v === undefined) {
      const gid = font.encodeCharacter(cp)
      v = gid > 0 ? font.advanceGlyph(gid) : 0.5
      advCache.set(cp, v)
    }
    return v
  }
  const width = (s: string, size: number) => {
    let w = 0
    for (const ch of s) w += adv(ch.codePointAt(0)!)
    return w * size
  }
  const allWinAnsi = texts.every((t) => [...t].every((ch) => winAnsiCode(ch.codePointAt(0)!) !== null))
  if (allWinAnsi) {
    const dict = pdf.newDictionary()
    dict.put('Type', pdf.newName('Font'))
    dict.put('Subtype', pdf.newName('Type1'))
    dict.put('BaseFont', pdf.newName('Helvetica'))
    dict.put('Encoding', pdf.newName('WinAnsiEncoding'))
    const ref = pdf.addObject(dict)
    const encode = (s: string) => {
      let out = ''
      for (const ch of s) out += String.fromCharCode(winAnsiCode(ch.codePointAt(0)!) ?? 0x3f)
      return pdfLiteral(out)
    }
    return { key: 'Helv', ref, width, encode }
  }
  // Characters outside WinAnsi: embed the font (Identity-H, glyph ids).
  const ref = pdf.addFont(font)
  const encode = (s: string) => {
    let hex = ''
    for (const ch of s) hex += font.encodeCharacter(ch.codePointAt(0)!).toString(16).padStart(4, '0')
    return `<${hex}>`
  }
  return { key: 'FcSig', ref, width, encode }
}

/** Splits a line into lines no wider than maxWidth (breaking long words if needed). */
function wrap(text: string, maxWidth: number, size: number, width: TextFont['width']): string[] {
  if (width(text, size) <= maxWidth) return [text]
  const words = text.split(/\s+/)
  const out: string[] = []
  let cur = ''
  for (const word of words) {
    const candidate = cur ? `${cur} ${word}` : word
    if (width(candidate, size) <= maxWidth) {
      cur = candidate
      continue
    }
    if (cur) out.push(cur)
    if (width(word, size) <= maxWidth) {
      cur = word
      continue
    }
    // break an overlong word
    let piece = ''
    for (const ch of word) {
      if (width(piece + ch, size) > maxWidth && piece) {
        out.push(piece)
        piece = ch
      } else piece += ch
    }
    cur = piece
  }
  if (cur) out.push(cur)
  return out
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface BuiltAppearance {
  /** Content stream bytes (string characters are bytes: WinAnsi codes or hex glyph ids). */
  stream: Uint8Array
  resources: PDFObject
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/**
 * Builds the appearance content stream (in a W x H box, origin bottom-left) and its resources
 * inside `pdf`.
 */
export function buildAppearance(m: Mupdf, pdf: PDFDocument, c: AppearanceContent, W: number, H: number): BuiltAppearance {
  const o = c.options
  const lines = detailLines(c)
  const graphicName = o.graphic === 'name' ? c.name.trim() : ''
  let image: { ref: PDFObject; w: number; h: number } | null = null
  if (o.graphic === 'image' && o.image?.length) {
    try {
      const img = new m.Image(o.image)
      image = { ref: pdf.addImage(img), w: img.getWidth(), h: img.getHeight() }
    } catch {
      image = null
    }
  }
  const hasGraphic = !!graphicName || !!image
  const font = makeFont(m, pdf, [graphicName, ...lines])
  const resources = pdf.newDictionary()
  const fonts = pdf.newDictionary()
  fonts.put(font.key, font.ref)
  resources.put('Font', fonts)
  if (image) {
    const xo = pdf.newDictionary()
    xo.put('FcImg', image.ref)
    resources.put('XObject', xo)
  }
  const ops: string[] = []
  const pad = Math.max(1, Math.min(4, Math.min(W, H) * 0.05))
  const inner: Box = { x: pad, y: pad, w: Math.max(1, W - 2 * pad), h: Math.max(1, H - 2 * pad) }
  let graphicBox: Box | null = null
  let textBox: Box | null = null
  if (hasGraphic && lines.length) {
    const gap = Math.min(6, inner.w * 0.03)
    if (inner.w >= inner.h * 1.6) {
      const gw = (inner.w - gap) * 0.48
      graphicBox = { x: inner.x, y: inner.y, w: gw, h: inner.h }
      textBox = { x: inner.x + gw + gap, y: inner.y, w: inner.w - gw - gap, h: inner.h }
    } else {
      const gh = (inner.h - gap) * 0.45
      graphicBox = { x: inner.x, y: inner.y + inner.h - gh, w: inner.w, h: gh }
      textBox = { x: inner.x, y: inner.y, w: inner.w, h: inner.h - gh - gap }
    }
  } else if (hasGraphic) graphicBox = inner
  else if (lines.length) textBox = inner

  if (graphicBox && image) {
    const s = Math.min(graphicBox.w / image.w, graphicBox.h / image.h)
    const w = image.w * s
    const h = image.h * s
    const x = graphicBox.x + (graphicBox.w - w) / 2
    const y = graphicBox.y + (graphicBox.h - h) / 2
    ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /FcImg Do Q`)
  } else if (graphicBox && graphicName) {
    // One line, or two when that allows a much larger size.
    const one = Math.min(graphicBox.h * 0.72, (graphicBox.w * 0.96) / Math.max(0.01, font.width(graphicName, 1)))
    let rows = [graphicName]
    let size = one
    const words = graphicName.split(/\s+/)
    if (words.length > 1) {
      let best = 1
      let bestDiff = Infinity
      for (let k = 1; k < words.length; k++) {
        const diff = Math.abs(font.width(words.slice(0, k).join(' '), 1) - font.width(words.slice(k).join(' '), 1))
        if (diff < bestDiff) {
          bestDiff = diff
          best = k
        }
      }
      const two = [words.slice(0, best).join(' '), words.slice(best).join(' ')]
      const twoSize = Math.min((graphicBox.h * 0.8) / 2 / 1.05, (graphicBox.w * 0.96) / Math.max(...two.map((t) => font.width(t, 1))))
      if (twoSize > one * 1.35) {
        rows = two
        size = twoSize
      }
    }
    const lineH = size * 1.05
    const blockH = lineH * rows.length
    let baseline = graphicBox.y + (graphicBox.h + blockH) / 2 - size * 0.8
    for (const row of rows) {
      const x = graphicBox.x + (graphicBox.w - font.width(row, size)) / 2
      ops.push(`BT /${font.key} ${num(size)} Tf ${num(x)} ${num(baseline)} Td ${font.encode(row)} Tj ET`)
      baseline -= lineH
    }
  }
  if (textBox && lines.length) {
    const leading = 1.18
    let size = Math.min(14, textBox.h / (lines.length * leading))
    let wrapped = lines
    for (; size > 2.5; size -= 0.25) {
      wrapped = lines.flatMap((l) => wrap(l, textBox.w, size, font.width))
      if (wrapped.length * size * leading <= textBox.h) break
    }
    size = Math.max(2.5, size)
    const blockH = wrapped.length * size * leading
    let baseline = textBox.y + (textBox.h + blockH) / 2 - size * 0.95
    for (const row of wrapped) {
      ops.push(`BT /${font.key} ${num(size)} Tf ${num(textBox.x)} ${num(baseline)} Td ${font.encode(row)} Tj ET`)
      baseline -= size * leading
    }
  }
  const stream = latin1Bytes(`q 0 g\n${ops.join('\n')}\nQ\n`)
  return { stream, resources }
}

/** Form XObject /Matrix that keeps the appearance upright on a page with /Rotate. */
export function rotationMatrix(rotate: number): number[] {
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, 0, 0]
    case 180:
      return [-1, 0, 0, -1, 0, 0]
    case 270:
      return [0, -1, 1, 0, 0, 0]
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

/** Creates the appearance form XObject for a W x H (visual) box. */
export function addAppearanceXObject(m: Mupdf, pdf: PDFDocument, c: AppearanceContent | null, W: number, H: number, rotate: number): PDFObject {
  const dict = pdf.newDictionary()
  dict.put('Type', pdf.newName('XObject'))
  dict.put('Subtype', pdf.newName('Form'))
  const bbox = pdf.newArray()
  for (const v of [0, 0, W, H]) bbox.push(pdf.newReal(v))
  dict.put('BBox', bbox)
  const matrix = pdf.newArray()
  for (const v of rotationMatrix(rotate)) matrix.push(pdf.newInteger(v))
  dict.put('Matrix', matrix)
  if (!c || W <= 0 || H <= 0) {
    dict.put('Resources', pdf.newDictionary())
    return pdf.addStream('', dict)
  }
  const built = buildAppearance(m, pdf, c, W, H)
  dict.put('Resources', built.resources)
  return pdf.addStream(built.stream, dict)
}

/** Renders the appearance alone to a transparent PNG (live preview in the sign dialog). */
export function renderAppearancePng(m: Mupdf, c: AppearanceContent, W: number, H: number, scale: number): Uint8Array {
  const tmp = new m.PDFDocument()
  try {
    const built = buildAppearance(m, tmp, c, W, H)
    const pageObj = tmp.addPage([0, 0, W, H], 0, built.resources, built.stream)
    tmp.insertPage(-1, pageObj)
    const page = tmp.loadPage(0)
    const pix = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, true, false)
    const png = pix.asPNG().slice()
    pix.destroy()
    page.destroy()
    return png
  } finally {
    tmp.destroy()
  }
}
