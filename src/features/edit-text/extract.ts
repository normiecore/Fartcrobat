/**
 * Engine-side reading of page text for editing: characters with exact baseline origins, the
 * MuPDF font objects that drew them, and which fonts are embedded in the file.
 *
 * Only the page contents are read (not annotations or form fields), because only page content
 * can be edited and removed.
 */
import type * as MuPDF from 'mupdf'
import type { Matrix, Point, Quad, Rect } from '@shared/geometry'
import type { PDFObject, Session } from '@engine/session'
import { isNull, readName } from '@engine/util/pdf'

export interface RawChar {
  c: string
  /** Baseline origin in page space. */
  ox: number
  oy: number
  quad: Quad
  size: number
  /** Full font name as MuPDF reports it (may carry a subset prefix). */
  font: string
  color: number
  bold: boolean
  italic: boolean
  serif: boolean
  mono: boolean
}

export interface RawLine {
  /** Range [start, end) of the line's characters in the extracted text (a '\n' follows each line). */
  start: number
  end: number
  bbox: Rect
  wmode: number
  dir: Point
  chars: RawChar[]
}

export interface ContentText {
  lines: RawLine[]
  /** MuPDF font objects by name, for reusing embedded fonts. */
  fonts: Map<string, MuPDF.Font>
  text: string
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

/** Runs the page contents (without annotations) into a display list. */
export function contentsDisplayList(s: Session, pageIndex: number): MuPDF.DisplayList {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const list = new m.DisplayList(page.getBounds())
  const dev = new m.DisplayListDevice(list)
  try {
    page.runPageContents(dev, m.Matrix.identity)
    dev.close()
  } finally {
    dev.destroy()
  }
  return list
}

export function extractContentText(s: Session, pageIndex: number): ContentText {
  const list = contentsDisplayList(s, pageIndex)
  const stext = list.toStructuredText('preserve-whitespace')
  const lines: RawLine[] = []
  const fonts = new Map<string, MuPDF.Font>()
  const flagCache = new Map<string, { bold: boolean; italic: boolean; serif: boolean; mono: boolean }>()
  let count = 0
  let cur: RawLine | null = null
  const parts: string[] = []
  try {
    stext.walk({
      beginLine(bbox, wmode, dir) {
        cur = { start: count, end: count, bbox: bbox as Rect, wmode, dir: dir as Point, chars: [] }
      },
      onChar(c, origin, font, size, quad, color) {
        if (!cur) return
        const name = font.getName()
        if (!fonts.has(name)) fonts.set(name, font)
        let f = flagCache.get(name)
        if (!f) {
          const plain = name.replace(/^[A-Z]{6}\+/, '')
          f = {
            bold: safe(() => font.isBold(), false) || /bold|black|heavy|semibold|demi/i.test(plain),
            italic: safe(() => font.isItalic(), false) || /italic|oblique/i.test(plain),
            serif: safe(() => font.isSerif(), false),
            mono: safe(() => font.isMono(), false)
          }
          flagCache.set(name, f)
        }
        cur.chars.push({
          c,
          ox: origin[0],
          oy: origin[1],
          quad: quad as Quad,
          size,
          font: name,
          color: colorToInt(color as number[]),
          ...f
        })
        parts.push(c)
        count++
      },
      endLine() {
        if (!cur) return
        cur.end = count
        lines.push(cur)
        parts.push('\n')
        count++
        cur = null
      }
    })
  } finally {
    stext.destroy()
    list.destroy()
  }
  return { lines, fonts, text: parts.join('') }
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

// ---- font embedding ---------------------------------------------------------------------------

export interface FontFileInfo {
  embedded: boolean
  type3: boolean
}

function descriptorEmbedded(fd: PDFObject): boolean {
  if (isNull(fd) || !fd.isDictionary()) return false
  return ['FontFile', 'FontFile2', 'FontFile3'].some((k) => !isNull(fd.get(k)))
}

/** Embedding of every font reachable from the page resources (including form XObjects). */
export function pageFontFiles(s: Session, pageIndex: number): Map<string, FontFileInfo> {
  const out = new Map<string, FontFileInfo>()
  const seen = new Set<number>()
  const visitFonts = (fonts: PDFObject) => {
    if (isNull(fonts) || !fonts.isDictionary()) return
    fonts.forEach((ref) => {
      try {
        const f = ref.resolve()
        if (!f.isDictionary()) return
        const subtype = readName(f.get('Subtype'))
        const base = readName(f.get('BaseFont')) ?? ''
        if (subtype === 'Type3') {
          if (base) out.set(base, { embedded: false, type3: true })
          return
        }
        let embedded = descriptorEmbedded(f.get('FontDescriptor'))
        const names = [base]
        if (subtype === 'Type0') {
          const kids = f.get('DescendantFonts')
          if (!isNull(kids) && kids.isArray() && kids.length) {
            const d = kids.get(0).resolve()
            embedded = embedded || descriptorEmbedded(d.get('FontDescriptor'))
            const dn = readName(d.get('BaseFont'))
            if (dn) names.push(dn)
          }
        }
        for (const n of names) if (n && !out.get(n)?.embedded) out.set(n, { embedded, type3: false })
      } catch {}
    })
  }
  const visitResources = (res: PDFObject, depth: number) => {
    if (depth > 6 || isNull(res) || !res.isDictionary()) return
    visitFonts(res.get('Font'))
    const xobjs = res.get('XObject')
    if (isNull(xobjs) || !xobjs.isDictionary()) return
    xobjs.forEach((ref) => {
      try {
        if (ref.isIndirect()) {
          const num = ref.asIndirect()
          if (seen.has(num)) return
          seen.add(num)
        }
        const x = ref.resolve()
        if (readName(x.get('Subtype')) === 'Form') visitResources(x.get('Resources'), depth + 1)
      } catch {}
    })
  }
  visitResources(s.pdf.findPage(pageIndex).getInheritable('Resources'), 0)
  return out
}

// ---- glyph observation ------------------------------------------------------------------------

export interface ObservedGlyph {
  font: MuPDF.Font
  fontName: string
  gid: number
  uni: number
  /** Glyph space -> page space. */
  m: Matrix
  /** Fill colour as 0..1 RGB. */
  rgb: [number, number, number]
  alpha: number
  /** fill = normal text, invisible = render mode 3 (e.g. OCR layers), other = stroke/clip. */
  kind: 'fill' | 'invisible' | 'other'
  /** The glyph is a ligature standing for several characters (its unicode is only the first). */
  lig: boolean
}

function concat(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5]
  ]
}

export function toRgb(cs: MuPDF.ColorSpace | null, color: number[]): [number, number, number] {
  const n = color.length
  if (n === 1) return [color[0], color[0], color[0]]
  if (n === 3) return [color[0], color[1], color[2]]
  if (n === 4)
    return [(1 - color[0]) * (1 - color[3]), (1 - color[1]) * (1 - color[3]), (1 - color[2]) * (1 - color[3])]
  void cs
  return [0, 0, 0]
}

/** Releases wrappers created for device callbacks without double-dropping un-kept pointers. */
export function release(obj: { destroy(): void } | null | undefined) {
  try {
    obj?.destroy()
  } catch {}
}

/** Neutralises a wrapper whose pointer was not kept by mupdf.js (Shade in fillShade). */
export function forget(obj: unknown) {
  const o = obj as { constructor: { _finalizer?: FinalizationRegistry<unknown> }; pointer: number }
  try {
    o.constructor._finalizer?.unregister(o)
    o.pointer = 0
  } catch {}
}

/** Every glyph drawn by the page contents, with its exact placement and colour. */
export function observeGlyphs(s: Session, pageIndex: number): ObservedGlyph[] {
  const m = s.mupdf
  const out: ObservedGlyph[] = []
  const collect = (
    text: MuPDF.Text,
    ctm: Matrix,
    kind: ObservedGlyph['kind'],
    rgb: [number, number, number],
    alpha: number
  ) => {
    text.walk({
      showGlyph(font, trm, gid, uni) {
        if (gid < 0) {
          // continuation of a ligature: the previous glyph stands for several characters
          if (out.length) out[out.length - 1].lig = true
          return
        }
        out.push({
          font,
          fontName: font.getName(),
          gid,
          uni,
          m: concat(trm as Matrix, ctm),
          rgb,
          alpha,
          kind,
          lig: false
        })
      }
    })
  }
  const dev = new m.Device({
    fillText(text, ctm, cs, color, alpha) {
      collect(text, ctm as Matrix, 'fill', toRgb(cs, color), alpha)
      release(text)
      release(cs)
    },
    strokeText(text, stroke, ctm) {
      collect(text, ctm as Matrix, 'other', [0, 0, 0], 1)
      release(text)
      release(stroke)
    },
    clipText(text, ctm) {
      collect(text, ctm as Matrix, 'other', [0, 0, 0], 1)
      release(text)
    },
    clipStrokeText(text, stroke, ctm) {
      collect(text, ctm as Matrix, 'other', [0, 0, 0], 1)
      release(text)
      release(stroke)
    },
    ignoreText(text, ctm) {
      collect(text, ctm as Matrix, 'invisible', [0, 0, 0], 1)
      release(text)
    },
    fillPath: (p, _e, _c, cs) => (release(p), release(cs)),
    strokePath: (p, st, _c, cs) => (release(p), release(st), release(cs)),
    clipPath: (p) => release(p),
    clipStrokePath: (p, st) => (release(p), release(st)),
    fillShade: (sh) => forget(sh),
    fillImage: (img) => release(img),
    fillImageMask: (img, _c, cs) => (release(img), release(cs)),
    clipImageMask: (img) => release(img),
    beginMask: (_r, _l, cs) => release(cs),
    beginGroup: (_r, cs) => release(cs)
  })
  try {
    s.page(pageIndex).runPageContents(dev, m.Matrix.identity)
    dev.close()
  } finally {
    dev.destroy()
  }
  return out
}
