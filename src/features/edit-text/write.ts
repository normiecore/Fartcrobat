/**
 * Low-level PDF writing for Edit Text: font resources, character codes, ToUnicode maps,
 * content streams and the text-only redaction used to remove original glyphs.
 */
import type * as MuPDF from 'mupdf'
import type { Matrix, Point, Quad } from '@shared/geometry'
import type { PDFObject, Session } from '@engine/session'
import { isNull, num, readName, readString } from '@engine/util/pdf'
import { withOwnContent } from './contents'

// ---- WinAnsi (the encoding of standard fonts written without embedding) ------------------

const WIN_ANSI_HIGH: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f
}

/** WinAnsiEncoding code of a code point, or -1. */
export function winAnsiCode(cp: number): number {
  if (cp >= 0x20 && cp <= 0x7e) return cp
  if (cp >= 0xa0 && cp <= 0xff) return cp
  return WIN_ANSI_HIGH[cp] ?? -1
}

export function hex2(n: number): string {
  return n.toString(16).padStart(2, '0')
}

export function hex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}

/** UTF-16BE hex of a character (for UCS2/UTF16 CJK encodings). */
export function utf16Hex(ch: string): string {
  let out = ''
  for (let i = 0; i < ch.length; i++) out += hex4(ch.charCodeAt(i))
  return out
}

// ---- font objects (process-wide, not tied to a document) ----------------------------------

const builtinFonts = new Map<string, MuPDF.Font>()

export function builtinFont(s: Session, name: string): MuPDF.Font {
  let f = builtinFonts.get(name)
  if (!f) {
    f = new s.mupdf.Font(name)
    builtinFonts.set(name, f)
  }
  return f
}

/** CJK fallback language for a character, or null when it is not CJK. */
export function cjkLanguage(cp: number): 'ja' | 'ko' | 'zh-Hans' | null {
  if ((cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x31f0 && cp <= 0x31ff) || (cp >= 0xff65 && cp <= 0xff9f))
    return 'ja'
  if ((cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3130 && cp <= 0x318f))
    return 'ko'
  if (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x3000 && cp <= 0x303f) ||
    (cp >= 0xff00 && cp <= 0xffef) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  )
    return 'zh-Hans'
  return null
}

const inkCache = new WeakMap<MuPDF.Font, Map<number, boolean>>()

/** True when a glyph draws something (subset fonts keep empty slots for unused glyphs). */
export function glyphHasInk(s: Session, font: MuPDF.Font, gid: number): boolean {
  let cache = inkCache.get(font)
  if (!cache) {
    cache = new Map()
    inkCache.set(font, cache)
  }
  const hit = cache.get(gid)
  if (hit !== undefined) return hit
  const m = s.mupdf
  const pix = new m.Pixmap(m.ColorSpace.DeviceGray, [0, 0, 32, 32], false)
  const dev = new m.DrawDevice(m.Matrix.identity, pix)
  const text = new m.Text()
  let ink = false
  try {
    pix.clear(255)
    text.showGlyph(font, [24, 0, 0, -24, 4, 24], gid, 0, 0)
    dev.fillText(text, m.Matrix.identity, m.ColorSpace.DeviceGray, [0], 1)
    dev.close()
    const px = pix.getPixels()
    for (let i = 0; i < px.length; i++) {
      if (px[i] < 200) {
        ink = true
        break
      }
    }
  } catch {
    ink = false
  } finally {
    dev.destroy()
    text.destroy()
    pix.destroy()
  }
  cache.set(gid, ink)
  return ink
}

// ---- page resources -----------------------------------------------------------------------

const MARKER = 'FartcrobatFont'
const TOUNI_MARKER = 'FartcrobatToUnicode'

/** The page's own /Resources /Font dictionary (created or copied from inherited resources). */
export function pageFontDict(s: Session, pageIndex: number): PDFObject {
  const doc = s.pdf
  const pageObj = doc.findPage(pageIndex)
  let res = pageObj.get('Resources')
  if (isNull(res) || !res.isDictionary()) {
    const inherited = pageObj.getInheritable('Resources')
    const own = doc.newDictionary()
    if (!isNull(inherited) && inherited.isDictionary()) inherited.forEach((v, k) => own.put(String(k), v))
    pageObj.put('Resources', own)
    res = pageObj.get('Resources')
  }
  let fonts = res.get('Font')
  if (isNull(fonts) || !fonts.isDictionary()) {
    res.put('Font', doc.newDictionary())
    fonts = res.get('Font')
  }
  return fonts
}

/**
 * Font resources used by one commit. Font objects are found again by a marker key on later
 * commits (and on other pages), so repeated edits do not embed the same font twice.
 */
export class FontBook {
  private names = new Map<string, string>()
  private fontDict: PDFObject | null = null

  constructor(
    private s: Session,
    private pageIndex: number
  ) {}

  private cache(): Map<string, number> {
    let c = this.s.state.get('edit-text:fonts') as Map<string, number> | undefined
    if (!c) {
      c = new Map()
      this.s.state.set('edit-text:fonts', c)
    }
    return c
  }

  private find(key: string): PDFObject | null {
    const doc = this.s.pdf
    const cached = this.cache().get(key)
    if (cached) {
      try {
        const ref = doc.newIndirect(cached)
        const o = ref.resolve()
        if (o.isDictionary() && readString(o.get(MARKER)) === key) return ref
      } catch {}
      this.cache().delete(key)
    }
    // look in the page's fonts
    const fonts = this.dict()
    let found: PDFObject | null = null
    fonts.forEach((ref) => {
      if (found) return
      try {
        const o = ref.resolve()
        if (o.isDictionary() && readString(o.get(MARKER)) === key && ref.isIndirect()) found = ref
      } catch {}
    })
    if (found) this.cache().set(key, (found as PDFObject).asIndirect())
    return found
  }

  private dict(): PDFObject {
    if (!this.fontDict) this.fontDict = pageFontDict(this.s, this.pageIndex)
    return this.fontDict
  }

  /** Resource name of the font with this key, creating the font object when needed. */
  resource(key: string, create: () => PDFObject): string {
    const known = this.names.get(key)
    if (known) return known
    let ref = this.find(key)
    if (!ref) {
      ref = create()
      const obj = ref.resolve()
      obj.put(MARKER, this.s.pdf.newString(key))
      if (ref.isIndirect()) this.cache().set(key, ref.asIndirect())
    }
    const fonts = this.dict()
    let name: string | null = null
    const target = ref.isIndirect() ? ref.asIndirect() : -1
    fonts.forEach((v, k) => {
      if (!name && v.isIndirect() && v.asIndirect() === target) name = String(k)
    })
    if (!name) {
      let i = 1
      while (!isNull(fonts.get(`FcT${i}`))) i++
      name = `FcT${i}`
      fonts.put(name, ref)
    }
    this.names.set(key, name)
    return name
  }

  /** The font object for a key (after resource() created it). */
  object(key: string): PDFObject | null {
    return this.find(key)
  }
}

// ---- ToUnicode for re-used embedded fonts ------------------------------------------------

function cmapString(map: Map<number, string>): string {
  const entries = [...map.entries()].sort((a, b) => a[0] - b[0])
  const chunks: string[] = []
  for (let i = 0; i < entries.length; i += 100) {
    const part = entries.slice(i, i + 100)
    chunks.push(
      `${part.length} beginbfchar\n${part.map(([g, u]) => `<${hex4(g)}> <${utf16Hex(u)}>`).join('\n')}\nendbfchar`
    )
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...chunks,
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end'
  ].join('\n')
}

function parseBfchar(text: string): Map<number, string> {
  const out = new Map<number, string>()
  const re = /<([0-9a-fA-F]{4})>\s*<([0-9a-fA-F]+)>/g
  const body = text.split('beginbfchar').slice(1).join(' ')
  for (const m of body.matchAll(re)) {
    const g = parseInt(m[1], 16)
    const hex = m[2]
    let str = ''
    for (let i = 0; i + 4 <= hex.length; i += 4) str += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16))
    out.set(g, str)
  }
  return out
}

/** Writes an exact glyph -> text mapping for a Type0 font we created from an embedded font. */
export function mergeToUnicode(s: Session, fontRef: PDFObject, add: Map<number, string>) {
  if (!add.size) return
  const font = fontRef.resolve()
  const current = font.get('ToUnicode')
  let map = new Map<number, string>()
  const marker = font.get(TOUNI_MARKER)
  if (!isNull(current) && marker.isBoolean() && marker.asBoolean()) {
    try {
      map = parseBfchar(current.readStream().asString())
    } catch {}
  }
  let changed = false
  for (const [g, u] of add) {
    if (map.get(g) !== u) {
      map.set(g, u)
      changed = true
    }
  }
  if (!changed && !isNull(current) && map.size) return
  const stream = s.pdf.addStream(cmapString(map), s.pdf.newDictionary())
  font.put('ToUnicode', stream)
  font.put(TOUNI_MARKER, s.pdf.newBoolean(true))
}

// ---- content streams --------------------------------------------------------------------

export function matrixString(m: Matrix): string {
  return m.map((v) => num(v)).join(' ')
}

export function colorOps(rgb: [number, number, number], stroke = false): string {
  return `${num(rgb[0])} ${num(rgb[1])} ${num(rgb[2])} ${stroke ? 'RG' : 'rg'}`
}

// ---- removal ------------------------------------------------------------------------------

const HELD_SUBTYPE = 'FartcrobatHeldRedact'

/**
 * Removes the glyphs touching the given page-space quads from the page content (text only:
 * images and vector graphics stay). Other redaction marks on the page are not applied, and links
 * that MuPDF drops with redactions are put back.
 */
export function removeTextUnder(s: Session, pageIndex: number, quads: Quad[]) {
  if (!quads.length) return
  // only the page's own content: page marks (headers, watermarks...) stay as they are
  withOwnContent(s, pageIndex, (unwrap) =>
    redactText(
      s,
      pageIndex,
      quads.map((q) => transformQuad(q, unwrap))
    )
  )
}

function transformQuad(q: Quad, m: Matrix): Quad {
  const out = [...q] as Quad
  for (let k = 0; k < 8; k += 2) {
    out[k] = q[k] * m[0] + q[k + 1] * m[2] + m[4]
    out[k + 1] = q[k] * m[1] + q[k + 1] * m[3] + m[5]
  }
  return out
}

function redactText(s: Session, pageIndex: number, quads: Quad[]) {
  const doc = s.pdf
  const page = s.page(pageIndex)
  const pageObj = page.getObject()
  const held: PDFObject[] = []
  for (const a of page.getAnnotations()) {
    try {
      if (a.getType() === 'Redact') {
        const o = a.getObject()
        o.put('Subtype', doc.newName(HELD_SUBTYPE))
        held.push(o)
      }
    } catch {}
  }
  const before: PDFObject[] = []
  const annots = pageObj.get('Annots')
  if (!isNull(annots) && annots.isArray()) for (let i = 0; i < annots.length; i++) before.push(annots.get(i))
  try {
    const r = page.createAnnotation('Redact')
    r.setQuadPoints(quads)
    r.update()
    page.applyRedactions(false, 0 /* image: none */, 0 /* line art: none */, 0 /* text: remove */)
  } finally {
    for (const o of held) o.put('Subtype', doc.newName('Redact'))
    // put back links (and anything else) the redaction dropped
    const after = new Set<number>()
    const now = pageObj.get('Annots')
    if (!isNull(now) && now.isArray())
      for (let i = 0; i < now.length; i++) if (now.get(i).isIndirect()) after.add(now.get(i).asIndirect())
    const missing = before.filter((ref) => {
      if (!ref.isIndirect() || after.has(ref.asIndirect())) return false
      const st = readName(ref.resolve().get('Subtype'))
      return st !== 'Redact' && st !== HELD_SUBTYPE
    })
    if (missing.length) {
      let arr = pageObj.get('Annots')
      if (isNull(arr) || !arr.isArray()) {
        pageObj.put('Annots', doc.newArray())
        arr = pageObj.get('Annots')
      }
      for (const ref of missing) arr.push(ref)
    }
    s.invalidatePages()
  }
}

/** Page-space quad of a rectangle given in a text frame (u along dir, v down). */
export function frameQuad(d: Point, u0: number, u1: number, v0: number, v1: number): Quad {
  const n: Point = [-d[1], d[0]]
  const P = (u: number, v: number): Point => [u * d[0] + v * n[0], u * d[1] + v * n[1]]
  const a = P(u0, v0)
  const b = P(u1, v0)
  const c = P(u0, v1)
  const e = P(u1, v1)
  return [a[0], a[1], b[0], b[1], c[0], c[1], e[0], e[1]]
}
