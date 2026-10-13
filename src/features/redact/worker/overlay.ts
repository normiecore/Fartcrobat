/**
 * Draws what replaces redacted content: the fill colour of each redacted area and the optional
 * overlay text, as a new content stream appended to the page (base-14 font, no embedding).
 */
import type { Quad, Rect } from '@shared/geometry'
import { hexToRgb, quadToRect } from '@shared/geometry'
import type { Session } from '@engine/session'
import { isNull, num } from '@engine/util/pdf'
import { overlayTextOf, type OverlayFont, type RedactionProps } from '../shared'

export interface OverlayArea {
  /** Polygon to fill (page space). */
  quad: Quad
  rect: Rect
  props: RedactionProps
}

// WinAnsiEncoding for the characters outside Latin-1 that it supports (0x80-0x9F block).
const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
}

/** Maps text to WinAnsi codes; characters the encoding lacks become '?'. */
export function toWinAnsi(text: string): { codes: number[]; chars: string } {
  const codes: number[] = []
  let chars = ''
  for (const ch of text) {
    const u = ch.codePointAt(0)!
    let c: number
    if ((u >= 0x20 && u <= 0x7e) || (u >= 0xa0 && u <= 0xff)) c = u
    else if (WIN_ANSI_EXTRA[u] !== undefined) c = WIN_ANSI_EXTRA[u]
    else if (u === 0x09) c = 0x20
    else c = 0x3f
    codes.push(c)
    chars += c === 0x3f && u !== 0x3f ? '?' : ch
  }
  return { codes, chars }
}

function literal(codes: number[]): string {
  let out = '('
  for (const c of codes) {
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c)
    else if (c < 0x20 || c > 0x7e) out += '\\' + c.toString(8).padStart(3, '0')
    else out += String.fromCharCode(c)
  }
  return out + ')'
}

type FontLike = { encodeCharacter(u: number): number; advanceGlyph(g: number, wmode?: number): number }

const fontCache = new Map<string, FontLike>()

function fontFor(s: Session, name: OverlayFont): FontLike {
  let f = fontCache.get(name)
  if (!f) {
    f = new s.mupdf.Font(name) as unknown as FontLike
    fontCache.set(name, f)
  }
  return f
}

/** Width of text in em units (multiply by the font size). */
export function textWidthEm(s: Session, font: OverlayFont, text: string): number {
  const f = fontFor(s, font)
  let w = 0
  for (const ch of text) {
    try {
      w += f.advanceGlyph(f.encodeCharacter(ch.codePointAt(0)!))
    } catch {
      w += 0.5
    }
  }
  return w
}

/** Approximate cap height of the base-14 fonts, in em. */
const CAP = 0.7
const LINE = 1.15

export interface TextLayout {
  size: number
  lines: { x: number; baseline: number; text: string }[]
}

/** Positions overlay text inside a rectangle (page space, y down), following the properties. */
export function layoutOverlay(s: Session, rect: Rect, p: RedactionProps, text: string): TextLayout | null {
  if (!text) return null
  const w = rect[2] - rect[0]
  const h = rect[3] - rect[1]
  if (w < 2 || h < 2) return null
  const pad = Math.min(2, w * 0.05)
  const avail = w - pad * 2
  const em = textWidthEm(s, p.font, text)
  if (em <= 0) return null
  let size = p.fontSize
  if (p.autoSize) size = p.repeat ? Math.min(h * 0.8, 12, avail / em) : Math.min(h * 0.8, avail / em, 72)
  size = Math.max(1, size)
  const lineH = size * LINE
  const baselineIn = (center: number) => center + (size * CAP) / 2
  const lines: TextLayout['lines'] = []
  if (p.repeat) {
    const gap = textWidthEm(s, p.font, '  ') * size
    const unitW = em * size + gap
    const count = Math.max(1, Math.floor((avail + gap) / unitW))
    const lineText = Array(count).fill(text).join('  ')
    const lineW = count * unitW - gap
    const rows = Math.max(1, Math.floor(h / lineH))
    const top = rect[1] + (h - rows * lineH) / 2
    for (let r = 0; r < rows; r++) {
      lines.push({ x: alignX(rect, pad, lineW, p.align), baseline: baselineIn(top + r * lineH + lineH / 2), text: lineText })
    }
  } else {
    lines.push({ x: alignX(rect, pad, em * size, p.align), baseline: baselineIn(rect[1] + h / 2), text })
  }
  return { size, lines }
}

function alignX(rect: Rect, pad: number, width: number, align: RedactionProps['align']): number {
  if (align === 'left') return rect[0] + pad
  if (align === 'right') return rect[2] - pad - width
  return (rect[0] + rect[2]) / 2 - width / 2
}

/** Adds (or finds) a font resource for a base-14 font on the page; returns its resource name. */
function ensureFont(s: Session, pageIndex: number, font: OverlayFont, cache: Map<string, string>): string {
  const hit = cache.get(font)
  if (hit) return hit
  const pageObj = s.pdf.findPage(pageIndex)
  let res = pageObj.get('Resources')
  if (isNull(res)) {
    const inherited = pageObj.getInheritable('Resources')
    const copy = s.pdf.newDictionary()
    if (!isNull(inherited)) inherited.resolve().forEach((v, k) => copy.put(String(k), v))
    pageObj.put('Resources', copy)
    res = pageObj.get('Resources')
  }
  let fonts = res.get('Font')
  if (isNull(fonts)) {
    res.put('Font', s.pdf.newDictionary())
    fonts = res.get('Font')
  }
  const dict = s.pdf.newDictionary()
  dict.put('Type', s.pdf.newName('Font'))
  dict.put('Subtype', s.pdf.newName('Type1'))
  dict.put('BaseFont', s.pdf.newName(font))
  dict.put('Encoding', s.pdf.newName('WinAnsiEncoding'))
  const ref = s.pdf.addObject(dict)
  let name = 'FcRedact' + font.replace(/[^A-Za-z]/g, '')
  let k = 1
  while (!isNull(fonts.get(name))) name = `FcRedact${font.replace(/[^A-Za-z]/g, '')}${k++}`
  fonts.put(name, ref)
  cache.set(font, name)
  return name
}

function rgb(hex: string): string {
  return hexToRgb(hex).map(num).join(' ')
}

/** Builds the content stream drawing fills and overlay text for the areas of one page. */
export function overlayContent(s: Session, pageIndex: number, areas: OverlayArea[]): string {
  const m = s.pageToUser(pageIndex)
  const fonts = new Map<string, string>()
  const ops: string[] = [`q ${m.map(num).join(' ')} cm`]
  for (const a of areas) {
    const q = a.quad
    if (a.props.fillColor) {
      ops.push(
        `${rgb(a.props.fillColor)} rg ${num(q[0])} ${num(q[1])} m ${num(q[2])} ${num(q[3])} l ${num(q[6])} ${num(q[7])} l ${num(q[4])} ${num(q[5])} l h f`
      )
    }
  }
  for (const a of areas) {
    const text = toWinAnsi(overlayTextOf(a.props)).chars
    if (!text) continue
    const layout = layoutOverlay(s, a.rect, a.props, text)
    if (!layout) continue
    const fontName = ensureFont(s, pageIndex, a.props.font, fonts)
    const r = a.rect
    ops.push(`q ${num(r[0])} ${num(r[1])} ${num(r[2] - r[0])} ${num(r[3] - r[1])} re W n BT /${fontName} ${num(layout.size)} Tf ${rgb(a.props.textColor)} rg`)
    for (const line of layout.lines) {
      ops.push(`1 0 0 -1 ${num(line.x)} ${num(line.baseline)} Tm ${literal(toWinAnsi(line.text).codes)} Tj`)
    }
    ops.push('ET Q')
  }
  ops.push('Q')
  return ops.join('\n') + '\n'
}

/** Wraps the existing page content in q/Q and appends a new content stream. */
export function appendContent(s: Session, pageIndex: number, content: string) {
  const pageObj = s.pdf.findPage(pageIndex)
  const contents = pageObj.get('Contents')
  const arr = s.pdf.newArray()
  const enc = new TextEncoder()
  arr.push(s.pdf.addStream(enc.encode('q\n'), s.pdf.newDictionary()))
  if (!isNull(contents)) {
    const c = contents.resolve()
    if (c.isArray()) for (let i = 0; i < c.length; i++) arr.push(c.get(i))
    else arr.push(contents)
  }
  arr.push(s.pdf.addStream(enc.encode('Q\n' + content), s.pdf.newDictionary()))
  pageObj.put('Contents', arr)
}

export function areasFor(quads: Quad[], rect: Rect, props: RedactionProps): OverlayArea[] {
  if (quads.length) return quads.map((q) => ({ quad: q, rect: quadToRect(q), props }))
  return [{ quad: [rect[0], rect[1], rect[2], rect[1], rect[0], rect[3], rect[2], rect[3]], rect, props }]
}

