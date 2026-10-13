/**
 * A small, tolerant PDF content-stream lexer and splice helper.
 *
 * Image edits rewrite only the bytes of the operators that paint an image (and the q/Q group that
 * belongs to it), leaving every other byte of the page content untouched. To do that we need the
 * byte range of every operator, which MuPDF does not expose, so we tokenize the stream ourselves.
 */

export type Operand =
  | { k: 'num'; v: number }
  | { k: 'name'; v: string }
  | { k: 'str'; n: number }
  | { k: 'arr'; items: Operand[] }
  | { k: 'dict'; entries: Record<string, Operand> }
  | { k: 'kw'; v: string }

export interface InlineImage {
  /** Image dictionary entries (abbreviated keys as written, e.g. W, H, CS, BPC, F). */
  dict: Record<string, Operand>
  dataStart: number
  dataEnd: number
}

export interface ContentOp {
  op: string
  args: Operand[]
  /** Byte offset of the first operand (or of the operator when it has none). */
  start: number
  /** Byte offset just after the operator (after `EI` for inline images). */
  end: number
  inline?: InlineImage
}

const WS = new Uint8Array(256)
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1
const DELIM = new Uint8Array(256)
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1

const isRegular = (c: number) => !WS[c] && !DELIM[c]

function ascii(b: Uint8Array, s: number, e: number): string {
  let out = ''
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i])
  return out
}

const HEX = (c: number) =>
  c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1

function decodeName(b: Uint8Array, s: number, e: number): string {
  let out = ''
  for (let i = s; i < e; i++) {
    const c = b[i]
    if (c === 35 /* # */ && i + 2 < e && HEX(b[i + 1]) >= 0 && HEX(b[i + 2]) >= 0) {
      out += String.fromCharCode(HEX(b[i + 1]) * 16 + HEX(b[i + 2]))
      i += 2
    } else out += String.fromCharCode(c)
  }
  return out
}

/** Returns the offset after a literal string starting at `i` (which points at '('). */
function skipLiteralString(b: Uint8Array, i: number): { end: number; length: number } {
  let depth = 0
  let length = 0
  const n = b.length
  for (; i < n; i++) {
    const c = b[i]
    if (c === 92 /* \ */) {
      i++
      length++
      // octal escapes count as one byte
      if (i < n && b[i] >= 48 && b[i] <= 55) {
        let k = 0
        while (k < 2 && i + 1 < n && b[i + 1] >= 48 && b[i + 1] <= 55) {
          i++
          k++
        }
      } else if (i < n && b[i] === 13 && b[i + 1] === 10) {
        i++
        length--
      } else if (i < n && (b[i] === 10 || b[i] === 13)) length--
      continue
    }
    if (c === 40) {
      depth++
      if (depth > 1) length++
    } else if (c === 41) {
      depth--
      if (depth === 0) return { end: i + 1, length }
      length++
    } else length++
  }
  return { end: n, length }
}

function skipHexString(b: Uint8Array, i: number): { end: number; length: number } {
  let digits = 0
  const n = b.length
  for (i++; i < n; i++) {
    if (b[i] === 62) return { end: i + 1, length: Math.ceil(digits / 2) }
    if (HEX(b[i]) >= 0) digits++
  }
  return { end: n, length: Math.ceil(digits / 2) }
}

class Lexer {
  i = 0
  constructor(readonly b: Uint8Array) {}

  skipSpace() {
    const b = this.b
    const n = b.length
    while (this.i < n) {
      const c = b[this.i]
      if (WS[c]) this.i++
      else if (c === 37) {
        while (this.i < n && b[this.i] !== 10 && b[this.i] !== 13) this.i++
      } else break
    }
  }

  /**
   * Reads one object or operator. Returns null at the end of the data. Operators are returned as
   * { k: 'kw' } with `op: true`.
   */
  next(): { tok: Operand; op: boolean; start: number } | { close: ']' | '>>'; start: number } | null {
    this.skipSpace()
    const b = this.b
    const n = b.length
    if (this.i >= n) return null
    const start = this.i
    const c = b[this.i]
    if (c === 47) {
      this.i++
      const s = this.i
      while (this.i < n && isRegular(b[this.i])) this.i++
      return { tok: { k: 'name', v: decodeName(b, s, this.i) }, op: false, start }
    }
    if (c === 40) {
      const r = skipLiteralString(b, this.i)
      this.i = r.end
      return { tok: { k: 'str', n: r.length }, op: false, start }
    }
    if (c === 60) {
      if (b[this.i + 1] === 60) {
        this.i += 2
        return { tok: this.readDict(), op: false, start }
      }
      const r = skipHexString(b, this.i)
      this.i = r.end
      return { tok: { k: 'str', n: r.length }, op: false, start }
    }
    if (c === 62) {
      if (b[this.i + 1] === 62) {
        this.i += 2
        return { close: '>>', start }
      }
      this.i++
      return this.next()
    }
    if (c === 91) {
      this.i++
      return { tok: this.readArray(), op: false, start }
    }
    if (c === 93) {
      this.i++
      return { close: ']', start }
    }
    if (c === 41 || c === 123 || c === 125) {
      // stray ')' or PostScript braces: ignore
      this.i++
      return this.next()
    }
    const s = this.i
    while (this.i < n && isRegular(b[this.i])) this.i++
    if (this.i === s) {
      this.i++
      return this.next()
    }
    const word = ascii(b, s, this.i)
    const first = word.charCodeAt(0)
    if ((first >= 48 && first <= 57) || first === 43 || first === 45 || first === 46) {
      const v = parseFloat(word)
      return { tok: { k: 'num', v: Number.isFinite(v) ? v : 0 }, op: false, start }
    }
    if (word === 'true' || word === 'false' || word === 'null') return { tok: { k: 'kw', v: word }, op: false, start }
    return { tok: { k: 'kw', v: word }, op: true, start }
  }

  readArray(): Operand {
    const items: Operand[] = []
    for (;;) {
      const t = this.next()
      if (!t) break
      if ('close' in t) {
        if (t.close === ']') break
        continue
      }
      items.push(t.tok)
    }
    return { k: 'arr', items }
  }

  readDict(): Operand {
    const entries: Record<string, Operand> = {}
    let key: string | null = null
    for (;;) {
      const t = this.next()
      if (!t) break
      if ('close' in t) {
        if (t.close === '>>') break
        continue
      }
      if (key === null) {
        if (t.tok.k === 'name') key = t.tok.v
      } else {
        entries[key] = t.tok
        key = null
      }
    }
    return { k: 'dict', entries }
  }
}

function num(o: Operand | undefined, fallback = 0): number {
  return o && o.k === 'num' ? o.v : fallback
}

function nameOf(o: Operand | undefined): string | null {
  return o && o.k === 'name' ? o.v : null
}

const COMPONENTS: Record<string, number> = {
  G: 1,
  DeviceGray: 1,
  CalGray: 1,
  RGB: 3,
  DeviceRGB: 3,
  CalRGB: 3,
  CMYK: 4,
  DeviceCMYK: 4,
  I: 1,
  Indexed: 1
}

/** Bytes of raw (unfiltered) inline image data, or -1 when it cannot be computed. */
function inlineDataLength(dict: Record<string, Operand>): number {
  const filter = dict.F ?? dict.Filter
  if (filter && !(filter.k === 'arr' && filter.items.length === 0)) return -1
  const len = dict.L ?? dict.Length
  if (len && len.k === 'num') return len.v
  const w = num(dict.W ?? dict.Width)
  const h = num(dict.H ?? dict.Height)
  const mask = dict.IM ?? dict.ImageMask
  const isMask = mask?.k === 'kw' && mask.v === 'true'
  const bpc = isMask ? 1 : num(dict.BPC ?? dict.BitsPerComponent, 8)
  let comps = 1
  if (!isMask) {
    const cs = dict.CS ?? dict.ColorSpace
    if (cs?.k === 'name') {
      const c = COMPONENTS[cs.v]
      if (!c) return -1
      comps = c
    } else if (cs?.k === 'arr' && cs.items[0]?.k === 'name' && (cs.items[0].v === 'I' || cs.items[0].v === 'Indexed')) comps = 1
    else if (cs) return -1
  }
  if (w <= 0 || h <= 0) return -1
  return h * Math.ceil((w * bpc * comps) / 8)
}

function firstFilter(dict: Record<string, Operand>): string | null {
  const f = dict.F ?? dict.Filter
  if (!f) return null
  if (f.k === 'name') return f.v
  if (f.k === 'arr' && f.items[0]?.k === 'name') return f.items[0].v
  return null
}

function looksLikeContent(b: Uint8Array, i: number): boolean {
  const end = Math.min(b.length, i + 48)
  for (let k = i; k < end; k++) {
    const c = b[k]
    if (!(c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127))) return false
  }
  return true
}

function isEIAt(b: Uint8Array, i: number): boolean {
  return b[i] === 69 && b[i + 1] === 73 && (i + 2 >= b.length || WS[b[i + 2]] === 1 || DELIM[b[i + 2]] === 1)
}

/** Finds the end of inline image data; returns [dataEnd, offsetAfterEI]. */
function findInlineEnd(b: Uint8Array, dataStart: number, dict: Record<string, Operand>): [number, number] {
  const n = b.length
  const exact = inlineDataLength(dict)
  if (exact >= 0) {
    let k = dataStart + exact
    while (k < n && WS[b[k]]) k++
    if (isEIAt(b, k)) return [dataStart + exact, k + 2]
  }
  const filter = firstFilter(dict)
  let from = dataStart
  if (filter === 'A85' || filter === 'ASCII85Decode') {
    for (let k = dataStart; k + 1 < n; k++) {
      if (b[k] === 126 && b[k + 1] === 62) {
        from = k + 2
        break
      }
    }
  } else if (filter === 'AHx' || filter === 'ASCIIHexDecode') {
    for (let k = dataStart; k < n; k++) {
      if (b[k] === 62) {
        from = k + 1
        break
      }
    }
  }
  for (let k = from; k + 1 < n; k++) {
    if (b[k] === 69 && b[k + 1] === 73 && (k === from || WS[b[k - 1]]) && isEIAt(b, k) && looksLikeContent(b, k + 2)) {
      let dataEnd = k
      while (dataEnd > dataStart && WS[b[dataEnd - 1]]) dataEnd--
      return [dataEnd, k + 2]
    }
  }
  return [n, n]
}

/** Tokenizes a content stream into operators with their byte ranges. */
export function parseContent(b: Uint8Array, maxOps = 4_000_000): ContentOp[] {
  const ops: ContentOp[] = []
  const lex = new Lexer(b)
  let args: Operand[] = []
  let argStart = -1
  for (;;) {
    const t = lex.next()
    if (!t) break
    if ('close' in t) continue
    if (argStart < 0) argStart = t.start
    if (!t.op) {
      args.push(t.tok)
      continue
    }
    const op = (t.tok as { v: string }).v
    if (op === 'BI') {
      // key/value pairs up to ID, then binary data up to EI
      const dict: Record<string, Operand> = {}
      let key: string | null = null
      let sawId = false
      for (;;) {
        const u = lex.next()
        if (!u) break
        if ('close' in u) continue
        if (u.op && (u.tok as { v: string }).v === 'ID') {
          sawId = true
          break
        }
        if (key === null) {
          if (u.tok.k === 'name') key = u.tok.v
        } else {
          dict[key] = u.tok
          key = null
        }
      }
      if (!sawId) break
      let ds = lex.i
      if (b[ds] === 13 && b[ds + 1] === 10) ds += 2
      else if (ds < b.length && WS[b[ds]]) ds += 1
      const [dataEnd, after] = findInlineEnd(b, ds, dict)
      lex.i = after
      ops.push({ op: 'BI', args, start: argStart, end: after, inline: { dict, dataStart: ds, dataEnd } })
    } else {
      ops.push({ op, args, start: argStart, end: lex.i })
    }
    args = []
    argStart = -1
    if (ops.length >= maxOps) break
  }
  return ops
}

export const opNum = num
export const opName = nameOf

// ---- splicing ------------------------------------------------------------------------------

/**
 * A replacement of bytes [start, end) by a list of parts: ASCII text, raw bytes, or a copy of an
 * original byte range [from, to).
 */
export interface Splice {
  start: number
  end: number
  parts: (string | Uint8Array | [number, number])[]
}

export interface SpliceResult {
  bytes: Uint8Array
  /** Maps an offset of the original data to the new data (null if the byte was dropped). */
  map(offset: number): number | null
  /** New offset where the i-th splice (in the order given) starts. */
  placed(i: number): number
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** Applies non-overlapping splices. Copied ranges inside parts may come from anywhere in `b`. */
export function applySplices(b: Uint8Array, splices: Splice[]): SpliceResult {
  const order = splices.map((sp, i) => ({ sp, i })).sort((x, y) => x.sp.start - y.sp.start || x.sp.end - y.sp.end)
  for (let k = 1; k < order.length; k++) {
    if (order[k].sp.start < order[k - 1].sp.end) throw new Error('Overlapping content edits')
  }
  const chunks: Uint8Array[] = []
  // segments: [origStart, origEnd, newStart] for copied original bytes
  const segments: [number, number, number][] = []
  const placed: number[] = new Array(splices.length).fill(0)
  let pos = 0
  let out = 0
  const copy = (s: number, e: number) => {
    if (e <= s) return
    chunks.push(b.subarray(s, e))
    segments.push([s, e, out])
    out += e - s
  }
  for (const { sp, i } of order) {
    copy(pos, sp.start)
    placed[i] = out
    for (const part of sp.parts) {
      if (typeof part === 'string' || part instanceof Uint8Array) {
        const enc = typeof part === 'string' ? asciiBytes(part) : part
        chunks.push(enc)
        out += enc.length
      } else copy(part[0], part[1])
    }
    pos = sp.end
  }
  copy(pos, b.length)
  const bytes = new Uint8Array(out)
  let o = 0
  for (const c of chunks) {
    bytes.set(c, o)
    o += c.length
  }
  return {
    bytes,
    map(offset: number) {
      for (const [s, e, ns] of segments) if (offset >= s && offset < e) return ns + (offset - s)
      return null
    },
    placed: (i: number) => placed[i]
  }
}

/** Formats a number for content streams. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const r = Math.round(n * 10000) / 10000
  const s = r.toFixed(4).replace(/\.?0+$/, '')
  return s === '-0' ? '0' : s || '0'
}

export function fmtMatrix(m: readonly number[]): string {
  return m.map(fmt).join(' ')
}

/** Concatenates content streams the way a PDF reader does (a newline between parts). */
export function concatStreams(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const p of parts) total += p.length + 1
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
    out[o++] = 10
  }
  return out
}
