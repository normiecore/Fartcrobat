import type { Matrix, Point, Rect } from '@shared/geometry'
import { defineOps, withTransfer } from '../define'
import type { Session } from '../session'

export const FONT_BOLD = 1
export const FONT_ITALIC = 2
export const FONT_MONO = 4
export const FONT_SERIF = 8

export interface TextLine {
  /** Range [start, end) into PageText.text. */
  start: number
  end: number
  bbox: Rect
  wmode: number
  dir: Point
  block: number
}

export interface TextSpan {
  start: number
  end: number
  font: string
  size: number
  /** 0xRRGGBB */
  color: number
  flags: number
}

export interface TextBlock {
  start: number
  end: number
  bbox: Rect
  lineStart: number
  lineEnd: number
}

export interface ImageBlock {
  bbox: Rect
  transform: Matrix
  width: number
  height: number
}

/**
 * The text of one page in reading order. `text` contains every character; a '\n' is inserted
 * after each line. `quads` holds 8 numbers per character of `text` (the quad of a synthetic
 * newline repeats the end of its line, with zero width).
 */
export interface PageText {
  pageIndex: number
  text: string
  quads: Float32Array
  lines: TextLine[]
  spans: TextSpan[]
  blocks: TextBlock[]
  images: ImageBlock[]
}

function colorToInt(c: number[] | undefined): number {
  if (!c || c.length === 0) return 0
  let r: number, g: number, b: number
  if (c.length === 1) r = g = b = c[0]
  else if (c.length === 4) {
    r = (1 - c[0]) * (1 - c[3])
    g = (1 - c[1]) * (1 - c[3])
    b = (1 - c[2]) * (1 - c[3])
  } else [r, g, b] = c
  const to = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
  return (to(r) << 16) | (to(g) << 8) | to(b)
}

export function extractPageText(s: Session, pageIndex: number, opts = 'preserve-whitespace,preserve-images'): PageText {
  const page = s.page(pageIndex)
  const stext = page.toStructuredText(opts)
  const chars: string[] = []
  const quads: number[] = []
  const lines: TextLine[] = []
  const spans: TextSpan[] = []
  const blocks: TextBlock[] = []
  const images: ImageBlock[] = []

  let blockStart = 0
  let blockLineStart = 0
  let blockBbox: Rect = [0, 0, 0, 0]
  let lineStart = 0
  let lineBbox: Rect = [0, 0, 0, 0]
  let lineWmode = 0
  let lineDir: Point = [1, 0]
  let lastQuad: number[] | null = null
  let span: TextSpan | null = null
  const fontCache = new Map<unknown, { name: string; flags: number }>()

  const fontInfo = (font: any) => {
    const key = font?.pointer ?? font
    let info = fontCache.get(key)
    if (!info) {
      let name = ''
      let flags = 0
      try {
        name = font.getName()
        if (font.isBold()) flags |= FONT_BOLD
        if (font.isItalic()) flags |= FONT_ITALIC
        if (font.isMono()) flags |= FONT_MONO
        if (font.isSerif()) flags |= FONT_SERIF
      } catch {}
      // Font names often carry a subset prefix ("ABCDEF+Helvetica").
      name = name.replace(/^[A-Z]{6}\+/, '')
      if (/bold|black|heavy|semibold/i.test(name)) flags |= FONT_BOLD
      if (/italic|oblique/i.test(name)) flags |= FONT_ITALIC
      info = { name, flags }
      fontCache.set(key, info)
    }
    return info
  }

  stext.walk({
    onImageBlock(bbox, transform, image) {
      images.push({
        bbox: bbox as Rect,
        transform: transform as Matrix,
        width: image.getWidth(),
        height: image.getHeight()
      })
    },
    beginTextBlock(bbox) {
      blockStart = chars.length
      blockLineStart = lines.length
      blockBbox = bbox as Rect
    },
    beginLine(bbox, wmode, direction) {
      lineStart = chars.length
      lineBbox = bbox as Rect
      lineWmode = wmode
      lineDir = direction as Point
      lastQuad = null
      span = null
    },
    onChar(c, _origin, font, size, quad, color) {
      const info = fontInfo(font)
      const col = colorToInt(color as number[])
      const idx = chars.length
      if (!span || span.font !== info.name || span.size !== size || span.color !== col || span.flags !== info.flags) {
        span = { start: idx, end: idx, font: info.name, size, color: col, flags: info.flags }
        spans.push(span)
      }
      chars.push(c)
      quads.push(...(quad as number[]))
      lastQuad = quad as number[]
      span.end = idx + 1
    },
    endLine() {
      const end = chars.length
      // Synthetic newline with a zero-width quad at the end of the line.
      const q = lastQuad
      chars.push('\n')
      if (q) quads.push(q[2], q[3], q[2], q[3], q[6], q[7], q[6], q[7])
      else quads.push(lineBbox[2], lineBbox[1], lineBbox[2], lineBbox[1], lineBbox[2], lineBbox[3], lineBbox[2], lineBbox[3])
      lines.push({ start: lineStart, end, bbox: lineBbox, wmode: lineWmode, dir: lineDir, block: blocks.length })
      span = null
    },
    endTextBlock() {
      blocks.push({ start: blockStart, end: chars.length, bbox: blockBbox, lineStart: blockLineStart, lineEnd: lines.length })
    }
  })
  stext.destroy()
  return {
    pageIndex,
    text: chars.join(''),
    quads: new Float32Array(quads),
    lines,
    spans,
    blocks,
    images
  }
}

export default defineOps('text', {
  page(s, pageIndex: number) {
    const t = extractPageText(s, pageIndex)
    return withTransfer(t, [t.quads.buffer as ArrayBuffer])
  },

  plain(s, pageIndex: number): string {
    const st = s.page(pageIndex).toStructuredText('preserve-whitespace')
    try {
      return st.asText()
    } finally {
      st.destroy()
    }
  },

  html(s, pageIndex: number): string {
    const st = s.page(pageIndex).toStructuredText('preserve-whitespace,preserve-images')
    try {
      return st.asHTML(pageIndex)
    } finally {
      st.destroy()
    }
  },

  /** Whole-document plain text (Export > Text, Read Out Loud, Compare). */
  all(s): string[] {
    const out: string[] = []
    const n = s.pageCount()
    for (let i = 0; i < n; i++) {
      const st = s.page(i).toStructuredText('preserve-whitespace')
      out.push(st.asText())
      st.destroy()
      s.progress((i + 1) / n)
    }
    return out
  }
})
