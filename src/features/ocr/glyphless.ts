/**
 * The font used for the invisible OCR text layer: a "glyphless" CID font in the style of the one
 * Tesseract and OCRmyPDF write. Every character code is a 16-bit CID; a ToUnicode CMap maps the
 * CID back to the character, so any script (Latin, Cyrillic, Greek, CJK, Arabic...) can be stored
 * without embedding real glyphs. Every glyph is 500/1000 em wide and spans from the baseline
 * (descent 0) to 1 em above it (ascent 1000), so a word drawn at font size H with horizontal
 * scaling covers exactly the box it was fitted to, in MuPDF and in other viewers.
 *
 * The embedded TrueType program is generated here (two empty glyphs); all CIDs map to glyph 1
 * through CIDToGIDMap because some viewers refuse to select text drawn with glyph 0 (.notdef).
 */

/** Advance width of every glyph, in thousandths of an em. */
export const GLYPH_WIDTH = 500
/** Ascent and descent of the font, in thousandths of an em (baseline to top of the quad). */
export const GLYPH_ASCENT = 1000
export const GLYPH_DESCENT = 0

export const GLYPHLESS_FONT_NAME = 'GlyphLessFont'

// ---- TrueType program ------------------------------------------------------------------------

class Writer {
  private bytes: number[] = []
  u8(v: number) {
    this.bytes.push(v & 0xff)
    return this
  }
  u16(v: number) {
    return this.u8(v >> 8).u8(v)
  }
  i16(v: number) {
    return this.u16(v < 0 ? v + 0x10000 : v)
  }
  u32(v: number) {
    return this.u16(Math.floor(v / 0x10000) & 0xffff).u16(v & 0xffff)
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.bytes.push(b[i] & 0xff)
    return this
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.bytes.push(0)
    return this
  }
  get length() {
    return this.bytes.length
  }
  done(): Uint8Array {
    return new Uint8Array(this.bytes)
  }
}

function checksum(b: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < b.length; i += 4) {
    const v = ((b[i] ?? 0) << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0)
    sum = (sum + (v >>> 0)) >>> 0
  }
  return sum
}

function utf16be(s: string): number[] {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out.push(c >> 8, c & 0xff)
  }
  return out
}

function nameTable(): Uint8Array {
  const names: [number, string][] = [
    [1, GLYPHLESS_FONT_NAME],
    [2, 'Regular'],
    [4, GLYPHLESS_FONT_NAME],
    [6, GLYPHLESS_FONT_NAME]
  ]
  const w = new Writer()
  const strings = names.map(([, s]) => utf16be(s))
  w.u16(0).u16(names.length).u16(6 + names.length * 12)
  let offset = 0
  names.forEach(([id], i) => {
    w.u16(3).u16(1).u16(0x409).u16(id).u16(strings[i].length).u16(offset)
    offset += strings[i].length
  })
  for (const s of strings) w.raw(s)
  return w.done()
}

let fontProgram: Uint8Array | null = null

/** A minimal, valid TrueType font with two empty glyphs (500 wide, ascent 1000, descent 0). */
export function glyphLessFontProgram(): Uint8Array {
  if (fontProgram) return fontProgram
  const tables: Record<string, Uint8Array> = {}
  tables['head'] = new Writer()
    .u32(0x00010000) // version
    .u32(0x00010000) // fontRevision
    .u32(0) // checkSumAdjustment (patched below)
    .u32(0x5f0f3cf5) // magicNumber
    .u16(0x000b) // flags
    .u16(1000) // unitsPerEm
    .zeros(16) // created, modified
    .i16(0)
    .i16(0)
    .i16(GLYPH_WIDTH)
    .i16(GLYPH_ASCENT) // xMin yMin xMax yMax
    .u16(0) // macStyle
    .u16(3) // lowestRecPPEM
    .i16(2) // fontDirectionHint
    .i16(0) // indexToLocFormat: short
    .i16(0) // glyphDataFormat
    .done()
  tables['hhea'] = new Writer()
    .u32(0x00010000)
    .i16(GLYPH_ASCENT)
    .i16(GLYPH_DESCENT)
    .i16(0) // lineGap
    .u16(GLYPH_WIDTH) // advanceWidthMax
    .i16(0)
    .i16(0)
    .i16(0) // minLSB, minRSB, xMaxExtent
    .i16(1)
    .i16(0)
    .i16(0) // caret slope rise/run/offset
    .zeros(8) // reserved
    .i16(0) // metricDataFormat
    .u16(2) // numberOfHMetrics
    .done()
  tables['maxp'] = new Writer().u32(0x00010000).u16(2).u16(0).u16(0).u16(0).u16(0).u16(1).zeros(16).done()
  tables['hmtx'] = new Writer().u16(GLYPH_WIDTH).i16(0).u16(GLYPH_WIDTH).i16(0).done()
  tables['loca'] = new Writer().u16(0).u16(0).u16(0).done()
  tables['glyf'] = new Uint8Array(0)
  // cmap: a single empty format 4 subtable (CIDToGIDMap selects the glyphs).
  tables['cmap'] = new Writer()
    .u16(0)
    .u16(1)
    .u16(3)
    .u16(1)
    .u32(12)
    .u16(4) // format
    .u16(24) // length
    .u16(0) // language
    .u16(2) // segCountX2
    .u16(2) // searchRange
    .u16(0) // entrySelector
    .u16(0) // rangeShift
    .u16(0xffff) // endCode
    .u16(0) // reservedPad
    .u16(0xffff) // startCode
    .i16(1) // idDelta
    .u16(0) // idRangeOffset
    .done()
  tables['name'] = nameTable()
  tables['post'] = new Writer().u32(0x00030000).u32(0).i16(-100).i16(50).u32(1).zeros(16).done()
  tables['OS/2'] = new Writer()
    .u16(1) // version
    .i16(GLYPH_WIDTH) // xAvgCharWidth
    .u16(400) // usWeightClass
    .u16(5) // usWidthClass
    .u16(0) // fsType: installable embedding
    .zeros(20) // sub/superscript and strikeout metrics
    .i16(0) // sFamilyClass
    .zeros(10) // panose
    .zeros(16) // ulUnicodeRange1-4
    .raw([0x46, 0x43, 0x42, 0x54]) // achVendID "FCBT"
    .u16(0x40) // fsSelection: REGULAR
    .u16(0x20) // usFirstCharIndex
    .u16(0xffff) // usLastCharIndex
    .i16(GLYPH_ASCENT) // sTypoAscender
    .i16(GLYPH_DESCENT) // sTypoDescender
    .i16(0) // sTypoLineGap
    .u16(GLYPH_ASCENT) // usWinAscent
    .u16(-GLYPH_DESCENT) // usWinDescent
    .u32(1) // ulCodePageRange1 (Latin 1)
    .u32(0)
    .done()

  const tags = Object.keys(tables).sort()
  const n = tags.length
  let pow = 1
  let log = 0
  while (pow * 2 <= n) {
    pow *= 2
    log++
  }
  const header = new Writer().u32(0x00010000).u16(n).u16(pow * 16).u16(log).u16(n * 16 - pow * 16)
  let offset = 12 + n * 16
  const records: { tag: string; offset: number; data: Uint8Array }[] = []
  for (const tag of tags) {
    records.push({ tag, offset, data: tables[tag] })
    offset += Math.ceil(tables[tag].length / 4) * 4
  }
  for (const r of records) {
    header.raw([...r.tag].map((c) => c.charCodeAt(0)))
    header.u32(checksum(r.data)).u32(r.offset).u32(r.data.length)
  }
  const out = new Uint8Array(offset)
  out.set(header.done(), 0)
  for (const r of records) out.set(r.data, r.offset)
  const headOffset = records.find((r) => r.tag === 'head')!.offset
  const adjust = (0xb1b0afba - checksum(out)) >>> 0
  out[headOffset + 8] = adjust >>> 24
  out[headOffset + 9] = (adjust >>> 16) & 0xff
  out[headOffset + 10] = (adjust >>> 8) & 0xff
  out[headOffset + 11] = adjust & 0xff
  fontProgram = out
  return out
}

// ---- CIDToGIDMap -----------------------------------------------------------------------------

/**
 * zlib (FlateDecode) data of a CIDToGIDMap that maps every CID 0..65535 to glyph 1: 65536
 * big-endian 16-bit 1s. Precomputed (zlib level 9) so the stream stays 150 bytes in memory and in
 * incremental saves.
 */
const CIDTOGID_ALL_ONE_FLATE =
  'eNrtwgEJAAAAAqD6fzpoh2gaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgBsA/wAQ'

export function cidToGidMapFlate(): Uint8Array {
  return base64ToBytes(CIDTOGID_ALL_ONE_FLATE)
}

function base64ToBytes(b64: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const clean = b64.replace(/=+$/, '')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const ch of clean) {
    const v = alphabet.indexOf(ch)
    if (v < 0) continue
    buffer = (buffer << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

// ---- character codes ---------------------------------------------------------------------------

/** First and last CID used for characters outside the Basic Multilingual Plane. */
const ASTRAL_FIRST = 0xd800
const ASTRAL_LAST = 0xdfff

/**
 * Assigns 16-bit CIDs to text. BMP characters use their own code point; characters outside the
 * BMP (rare in OCR output: emoji, CJK extension B...) get CIDs from the surrogate range, which
 * never holds characters by itself, and are listed separately in the ToUnicode CMap.
 */
export class CidEncoder {
  private astral = new Map<number, number>()

  /** CIDs for the characters of `text` (one per code point). Unmappable characters are dropped. */
  encode(text: string): number[] {
    const cids: number[] = []
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      if (cp < 0x20 && cp !== 0x09) continue
      if (cp <= 0xffff) {
        if (cp >= ASTRAL_FIRST && cp <= ASTRAL_LAST) continue // lone surrogate
        cids.push(cp)
        continue
      }
      let cid = this.astral.get(cp)
      if (cid === undefined) {
        if (ASTRAL_FIRST + this.astral.size > ASTRAL_LAST) continue
        cid = ASTRAL_FIRST + this.astral.size
        this.astral.set(cp, cid)
      }
      cids.push(cid)
    }
    return cids
  }

  /** The ToUnicode CMap for every CID this encoder handed out. */
  toUnicodeCMap(): string {
    const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, '0')
    const lines = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange',
      '2 beginbfrange',
      '<0000> <D7FF> <0000>',
      '<E000> <FFFF> <E000>',
      'endbfrange'
    ]
    const astral = [...this.astral.entries()]
    for (let i = 0; i < astral.length; i += 100) {
      const chunk = astral.slice(i, i + 100)
      lines.push(`${chunk.length} beginbfchar`)
      for (const [cp, cid] of chunk) {
        const v = cp - 0x10000
        const hi = 0xd800 + (v >> 10)
        const lo = 0xdc00 + (v & 0x3ff)
        lines.push(`<${hex4(cid)}> <${hex4(hi)}${hex4(lo)}>`)
      }
      lines.push('endbfchar')
    }
    lines.push('endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end', '')
    return lines.join('\n')
  }
}

export function cidsToHex(cids: number[]): string {
  let s = ''
  for (const c of cids) s += c.toString(16).toUpperCase().padStart(4, '0')
  return s
}
