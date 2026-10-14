// A small reader for the PDF bytes MuPDF refuses to open (it throws "unknown encryption handler" on
// /Adobe.PubSec files): objects, the newest trailer, the cross-reference data (classic tables and
// xref streams, following /Prev), and single top-level objects. Enough to find the encryption
// dictionary, append an update section and walk every object; not a general PDF parser.
// ISO 32000-2, 7.2 (lexical conventions), 7.3 (objects), 7.5 (file structure).
import { Inflate, Unzlib } from 'fflate'
import { latin1, toLatin1 } from './primitives'

export class PdfName {
  constructor(readonly name: string) {}
}

export class PdfString {
  constructor(readonly bytes: Uint8Array) {}
}

export class PdfRef {
  constructor(
    readonly num: number,
    readonly gen: number
  ) {}
}

export type PdfDict = Map<string, PdfValue>
export type PdfValue = null | boolean | number | PdfName | PdfString | PdfRef | PdfValue[] | PdfDict

export class PdfSyntaxError extends Error {
  constructor(message: string, at: number) {
    super(`${message} at byte ${at}`)
    this.name = 'PdfSyntaxError'
  }
}

// Character classes (ISO 32000-2, 7.2.3): 1 whitespace, 2 delimiter, 0 regular.
const CLASS = new Uint8Array(256)
for (const c of [0, 9, 10, 12, 13, 32]) CLASS[c] = 1
for (const c of '()<>[]{}/%') CLASS[c.charCodeAt(0)] = 2

const CR = 13
const LF = 10

const isDigit = (c: number) => c >= 0x30 && c <= 0x39
const hexValue = (c: number) => (c >= 0x30 && c <= 0x39 ? c - 0x30 : c >= 0x41 && c <= 0x46 ? c - 55 : c >= 0x61 && c <= 0x66 ? c - 87 : -1)

/** Skips whitespace and comments. */
export function skipWs(b: Uint8Array, i: number): number {
  for (;;) {
    while (i < b.length && CLASS[b[i]] === 1) i++
    if (i >= b.length || b[i] !== 0x25) return i
    while (i < b.length && b[i] !== LF && b[i] !== CR) i++
  }
}

/** A run of regular characters (a number or a keyword). */
function token(b: Uint8Array, i: number): [string, number] {
  const start = i
  while (i < b.length && CLASS[b[i]] === 0) i++
  return [toLatin1(b.subarray(start, i)), i]
}

function startsWith(b: Uint8Array, i: number, word: string): boolean {
  if (i + word.length > b.length) return false
  for (let k = 0; k < word.length; k++) if (b[i + k] !== word.charCodeAt(k)) return false
  return true
}

/** `word` at `i`, followed by a non-regular character or the end. */
function keywordAt(b: Uint8Array, i: number, word: string): boolean {
  return startsWith(b, i, word) && (i + word.length >= b.length || CLASS[b[i + word.length]] !== 0)
}

class ByteBuilder {
  private buf = new Uint8Array(64)
  length = 0
  push(c: number) {
    if (this.length === this.buf.length) {
      const next = new Uint8Array(this.buf.length * 2)
      next.set(this.buf)
      this.buf = next
    }
    this.buf[this.length++] = c
  }
  bytes(): Uint8Array {
    return this.buf.slice(0, this.length)
  }
}

function literalString(b: Uint8Array, i: number): [PdfString, number] {
  const start = i
  const out = new ByteBuilder()
  let depth = 1
  i++
  while (i < b.length) {
    const c = b[i++]
    if (c === 0x5c) {
      if (i >= b.length) break
      const e = b[i++]
      if (e === 0x6e) out.push(LF)
      else if (e === 0x72) out.push(CR)
      else if (e === 0x74) out.push(9)
      else if (e === 0x62) out.push(8)
      else if (e === 0x66) out.push(12)
      else if (e >= 0x30 && e <= 0x37) {
        let v = e - 0x30
        for (let k = 0; k < 2 && i < b.length && b[i] >= 0x30 && b[i] <= 0x37; k++) v = v * 8 + (b[i++] - 0x30)
        out.push(v & 0xff)
      } else if (e === CR) {
        // A backslash before an end of line continues the string on the next line.
        if (b[i] === LF) i++
      } else if (e !== LF) {
        // \( \) \\ and any unknown escape: the character itself.
        out.push(e)
      }
    } else if (c === 0x28) {
      depth++
      out.push(c)
    } else if (c === 0x29) {
      if (--depth === 0) return [new PdfString(out.bytes()), i]
      out.push(c)
    } else if (c === CR) {
      // An unescaped end of line (CR, LF or CR LF) is read as a single LF.
      if (b[i] === LF) i++
      out.push(LF)
    } else {
      out.push(c)
    }
  }
  throw new PdfSyntaxError('Unterminated string', start)
}

function hexString(b: Uint8Array, i: number): [PdfString, number] {
  const start = i
  const out = new ByteBuilder()
  let high = -1
  i++
  for (;;) {
    if (i >= b.length) throw new PdfSyntaxError('Unterminated hex string', start)
    const c = b[i++]
    if (c === 0x3e) break
    if (CLASS[c] === 1) continue
    const v = hexValue(c)
    if (v < 0) throw new PdfSyntaxError('Bad character in hex string', i - 1)
    if (high < 0) high = v
    else {
      out.push((high << 4) | v)
      high = -1
    }
  }
  // An odd number of digits: the last one is followed by 0.
  if (high >= 0) out.push(high << 4)
  return [new PdfString(out.bytes()), i]
}

function nameAt(b: Uint8Array, i: number): [PdfName, number] {
  i++
  const out = new ByteBuilder()
  while (i < b.length && CLASS[b[i]] === 0) {
    const c = b[i]
    if (c === 0x23 && i + 2 < b.length && hexValue(b[i + 1]) >= 0 && hexValue(b[i + 2]) >= 0) {
      out.push((hexValue(b[i + 1]) << 4) | hexValue(b[i + 2]))
      i += 3
    } else {
      out.push(c)
      i++
    }
  }
  return [new PdfName(toLatin1(out.bytes())), i]
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/

/** Reads an unsigned integer token at `i` (after whitespace), or null. */
function uintAt(b: Uint8Array, i: number): [number, number] | null {
  i = skipWs(b, i)
  const start = i
  while (i < b.length && isDigit(b[i])) i++
  if (i === start || (i < b.length && CLASS[b[i]] === 0)) return null
  return [Number(toLatin1(b.subarray(start, i))), i]
}

/** Parses one object at `i` (leading whitespace and comments allowed). Returns [value, end]. */
export function parseValue(b: Uint8Array, i: number, depth = 0): [PdfValue, number] {
  if (depth > 256) throw new PdfSyntaxError('Objects nested too deeply', i)
  i = skipWs(b, i)
  if (i >= b.length) throw new PdfSyntaxError('Unexpected end of data', i)
  const c = b[i]
  if (c === 0x2f) return nameAt(b, i)
  if (c === 0x28) return literalString(b, i)
  if (c === 0x3c) {
    if (b[i + 1] !== 0x3c) return hexString(b, i)
    const dict: PdfDict = new Map()
    i += 2
    for (;;) {
      i = skipWs(b, i)
      if (i >= b.length) throw new PdfSyntaxError('Unterminated dictionary', i)
      if (b[i] === 0x3e && b[i + 1] === 0x3e) return [dict, i + 2]
      const [key, j] = parseValue(b, i, depth + 1)
      if (!(key instanceof PdfName)) throw new PdfSyntaxError('Dictionary key is not a name', i)
      const [value, k] = parseValue(b, j, depth + 1)
      dict.set(key.name, value)
      i = k
    }
  }
  if (c === 0x5b) {
    const arr: PdfValue[] = []
    i++
    for (;;) {
      i = skipWs(b, i)
      if (i >= b.length) throw new PdfSyntaxError('Unterminated array', i)
      if (b[i] === 0x5d) return [arr, i + 1]
      const [value, j] = parseValue(b, i, depth + 1)
      arr.push(value)
      i = j
    }
  }
  if (CLASS[c] !== 0) throw new PdfSyntaxError(`Unexpected ${String.fromCharCode(c)}`, i)
  const [t, j] = token(b, i)
  if (t === 'true') return [true, j]
  if (t === 'false') return [false, j]
  if (t === 'null') return [null, j]
  if (NUMBER.test(t)) {
    // "num gen R" is a reference.
    if (/^\d+$/.test(t)) {
      const gen = uintAt(b, j)
      if (gen) {
        const k = skipWs(b, gen[1])
        if (keywordAt(b, k, 'R')) return [new PdfRef(Number(t), gen[0]), k + 1]
      }
    }
    return [Number(t), j]
  }
  throw new PdfSyntaxError(`Unexpected ${JSON.stringify(t)}`, i)
}

// ---- serialising ------------------------------------------------------------------------------

function escapeName(name: string): string {
  let out = ''
  for (const byte of latin1(name)) {
    out += byte > 0x20 && byte < 0x7f && CLASS[byte] === 0 && byte !== 0x23 ? String.fromCharCode(byte) : `#${byte.toString(16).padStart(2, '0')}`
  }
  return out
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
}

/** PDF source text for a value (strings are written as hex). */
export function serialise(v: PdfValue): string {
  if (v === null) return 'null'
  if (typeof v === 'boolean') return String(v)
  if (typeof v === 'number') return formatNumber(v)
  if (v instanceof PdfRef) return `${v.num} ${v.gen} R`
  if (v instanceof PdfName) return `/${escapeName(v.name)}`
  if (v instanceof PdfString) return `<${Array.from(v.bytes, (x) => x.toString(16).padStart(2, '0')).join('')}>`
  if (Array.isArray(v)) return `[${v.map(serialise).join(' ')}]`
  return `<<${[...v].map(([k, x]) => `/${escapeName(k)} ${serialise(x)}`).join('')}>>`
}

// ---- small accessors --------------------------------------------------------------------------

export const asDict = (v: PdfValue | undefined): PdfDict | null => (v instanceof Map ? v : null)
export const asName = (v: PdfValue | undefined): string | null => (v instanceof PdfName ? v.name : null)
export const asNumber = (v: PdfValue | undefined): number | null => (typeof v === 'number' ? v : null)

// ---- file structure ---------------------------------------------------------------------------

export type XrefEntry =
  | { type: 0 }
  | { type: 1; offset: number; gen: number }
  | { type: 2; stream: number; index: number }

export interface Xref {
  /** The newest entry of every object number (newer sections win over their /Prev). */
  entries: Map<number, XrefEntry>
  /** The newest trailer: a classic `trailer` dictionary or the xref stream's dictionary. */
  trailer: PdfDict
  /** Every trailer, newest first. */
  trailers: PdfDict[]
  /** Offset of the newest cross-reference section (the value of the last `startxref`). */
  startxref: number
  kind: 'table' | 'stream'
  /** The cross-reference data could not be read: entries come from scanning for object headers. */
  damaged: boolean
}

/** True when the bytes start like a PDF file (the header may follow up to 1 KB of junk). */
export function isPdfBytes(b: Uint8Array): boolean {
  return toLatin1(b.subarray(0, 1024)).includes('%PDF-')
}

/** Offset of `needle` in `hay` at or after `from`, or -1. */
export function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  if (!needle.length) return from
  const last = hay.length - needle.length
  for (let i = hay.indexOf(needle[0], from); i !== -1 && i <= last; i = hay.indexOf(needle[0], i + 1)) {
    let k = 1
    while (k < needle.length && hay[i + k] === needle[k]) k++
    if (k === needle.length) return i
  }
  return -1
}

/** Offset of the last `needle` in `hay`, or -1. */
function lastIndexOfBytes(hay: Uint8Array, needle: Uint8Array): number {
  for (let i = hay.length - needle.length; i >= 0; i--) {
    if (hay[i] !== needle[0]) continue
    let k = 1
    while (k < needle.length && hay[i + k] === needle[k]) k++
    if (k === needle.length) return i
  }
  return -1
}

const STARTXREF = latin1('startxref')
const ENDSTREAM = latin1('endstream')

/** The value of the LAST `startxref` of the file (the newest revision when there are several). */
function lastStartxref(b: Uint8Array): number {
  const at = lastIndexOfBytes(b, STARTXREF)
  if (at < 0) throw new PdfSyntaxError('No startxref', b.length)
  const n = uintAt(b, at + STARTXREF.length)
  if (!n) throw new PdfSyntaxError('Bad startxref', at)
  return n[0]
}

interface Section {
  kind: 'table' | 'stream'
  entries: Map<number, XrefEntry>
  trailer: PdfDict
  /** Where the section's data ends (after the trailer, or the xref stream's data). */
  end: number
}

/** The highest object number MuPDF (and so this reader) accepts. */
export const MAX_OBJECT_NUMBER = 8388607

/**
 * How much cross-reference data one file may make the reader go through. Sections of a sound file
 * do not overlap and list each object a few times at most, and even a dense file spends more than
 * a byte on each object. More than that (sections inside one another, millions of entries packed
 * into a few kilobytes) is damaged or hostile, and the reader gives up rather than spend seconds
 * and gigabytes on it.
 */
class XrefBudget {
  private bytes: number
  private entries: number
  constructor(b: Uint8Array) {
    this.bytes = 2 * b.length + 65536
    this.entries = Math.max(1 << 19, b.length)
  }
  /** Entries a section is about to list. */
  takeEntries(n: number, at: number) {
    this.entries -= n
    if (this.entries < 0) throw new PdfSyntaxError('Too many cross-reference entries', at)
  }
  /** Bytes from `start` to `end` that a section was read from. */
  takeBytes(start: number, end: number) {
    this.bytes -= end - start
    if (this.bytes < 0) throw new PdfSyntaxError('Too much cross-reference data', start)
  }
}

/** `num gen obj` at `i` (after whitespace): [num, gen, end of the header] or null. */
function objHeader(b: Uint8Array, i: number): [number, number, number] | null {
  const num = uintAt(b, i)
  if (!num) return null
  const gen = uintAt(b, num[1])
  if (!gen) return null
  const k = skipWs(b, gen[1])
  return keywordAt(b, k, 'obj') ? [num[0], gen[0], k + 3] : null
}

function readTableSection(b: Uint8Array, i: number): Section {
  const entries = new Map<number, XrefEntry>()
  i += 4
  for (;;) {
    i = skipWs(b, i)
    if (keywordAt(b, i, 'trailer')) {
      const [trailer, end] = parseValue(b, i + 7)
      if (!(trailer instanceof Map)) throw new PdfSyntaxError('Trailer is not a dictionary', i)
      return { kind: 'table', entries, trailer, end }
    }
    const first = uintAt(b, i)
    const count = first && uintAt(b, first[1])
    if (!first || !count) throw new PdfSyntaxError('Bad cross-reference subsection', i)
    i = count[1]
    for (let k = 0; k < count[0]; k++) {
      const offset = uintAt(b, i)
      const gen = offset && uintAt(b, offset[1])
      if (!offset || !gen) throw new PdfSyntaxError('Bad cross-reference entry', i)
      const at = skipWs(b, gen[1])
      const kind = b[at]
      if ((kind !== 0x6e && kind !== 0x66) || !(at + 1 >= b.length || CLASS[b[at + 1]] !== 0)) {
        throw new PdfSyntaxError('Bad cross-reference entry type', at)
      }
      const num = first[0] + k
      if (!entries.has(num)) entries.set(num, kind === 0x6e ? { type: 1, offset: offset[0], gen: gen[0] } : { type: 0 })
      i = at + 1
    }
  }
}

/** A sane bound on a predictor's /Columns. */
const MAX_PREDICTOR_COLUMNS = 1 << 24

/** Applies a PNG (10 to 15) or TIFF (2) predictor to decoded data (ISO 32000-2, 7.4.4.4). */
function unpredict(data: Uint8Array, parms: PdfDict | null): Uint8Array {
  const predictor = asNumber(parms?.get('Predictor')) ?? 1
  // 1 and values the standard does not define: no predictor.
  if (predictor !== 2 && !(Number.isInteger(predictor) && predictor >= 10 && predictor <= 15)) return data
  const colors = asNumber(parms?.get('Colors')) ?? 1
  const bpc = asNumber(parms?.get('BitsPerComponent')) ?? 8
  const columns = asNumber(parms?.get('Columns')) ?? 1
  // The file sets these: a row of 0 bytes (or fewer) would never move the TIFF loop forward.
  const whole = (n: number, max: number) => Number.isInteger(n) && n >= 1 && n <= max
  if (!whole(colors, 32) || ![1, 2, 4, 8, 16].includes(bpc) || !whole(columns, MAX_PREDICTOR_COLUMNS)) {
    throw new Error('Bad predictor parameters')
  }
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowBytes = Math.ceil((colors * bpc * columns) / 8)
  if (predictor === 2) {
    if (bpc !== 8) throw new Error('Unsupported TIFF predictor depth')
    const out = data.slice()
    for (let row = 0; row < out.length; row += rowBytes) {
      for (let k = bpp; k < rowBytes && row + k < out.length; k++) out[row + k] = (out[row + k] + out[row + k - bpp]) & 255
    }
    return out
  }
  const rows = Math.floor(data.length / (rowBytes + 1))
  const out = new Uint8Array(rows * rowBytes)
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)]
    const src = r * (rowBytes + 1) + 1
    const dst = r * rowBytes
    for (let k = 0; k < rowBytes; k++) {
      const raw = data[src + k]
      const left = k >= bpp ? out[dst + k - bpp] : 0
      const up = r > 0 ? out[dst - rowBytes + k] : 0
      const upLeft = r > 0 && k >= bpp ? out[dst - rowBytes + k - bpp] : 0
      let v: number
      if (type === 0) v = raw
      else if (type === 1) v = raw + left
      else if (type === 2) v = raw + up
      else if (type === 3) v = raw + ((left + up) >> 1)
      else if (type === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        v = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
      } else throw new Error(`Bad PNG predictor ${type}`)
      out[dst + k] = v & 255
    }
  }
  return out
}

/** Most bytes decodeStream produces unless told otherwise. */
export const MAX_DECODED_LENGTH = 64 * 1024 * 1024

class TooLong extends Error {}

/**
 * Inflates zlib (or, with `raw`, bare deflate) data, stopping as soon as the output passes
 * `maxLength`: the input goes in in small pieces, so a small stream that inflates to gigabytes
 * costs no more than `maxLength` of work and memory.
 */
function inflateBounded(data: Uint8Array, maxLength: number, raw: boolean): Uint8Array {
  const chunks: Uint8Array[] = []
  let length = 0
  const sink = (chunk: Uint8Array) => {
    length += chunk.length
    if (length > maxLength) throw new TooLong('Stream data too long')
    chunks.push(chunk)
  }
  const stream = raw ? new Inflate(sink) : new Unzlib(sink)
  const PIECE = 4096
  for (let at = 0; ; at += PIECE) {
    const end = Math.min(at + PIECE, data.length)
    stream.push(data.subarray(at, end), end === data.length)
    if (end === data.length) break
  }
  const out = new Uint8Array(length)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/**
 * Decodes stream data with FlateDecode and predictors (enough for xref streams). Throws when the
 * data would decode to more than `maxLength` bytes.
 */
export function decodeStream(data: Uint8Array, dict: PdfDict, maxLength = MAX_DECODED_LENGTH): Uint8Array {
  const filter = dict.get('Filter')
  const filters = Array.isArray(filter) ? filter.map(asName) : filter === undefined || filter === null ? [] : [asName(filter)]
  const parmsValue = dict.get('DecodeParms')
  const parms = Array.isArray(parmsValue) ? parmsValue.map((p) => asDict(p)) : [asDict(parmsValue)]
  let out = data
  filters.forEach((f, k) => {
    if (f !== 'FlateDecode' && f !== 'Fl') throw new Error(`Unsupported filter ${f}`)
    try {
      out = inflateBounded(out, maxLength, false)
    } catch (err) {
      if (err instanceof TooLong) throw err
      // Some writers leave out or damage the zlib header or checksum.
      out = inflateBounded(out.subarray(2), maxLength, true)
    }
    out = unpredict(out, parms[k] ?? null)
  })
  if (out.length > maxLength) throw new TooLong('Stream data too long')
  return out
}

/** Where a stream's data is: `start` is after the EOL that follows `stream`, `end` before `endstream`'s EOL. */
function streamSpan(b: Uint8Array, dict: PdfDict, at: number, resolveLength: (ref: PdfRef) => number | null): { start: number; end: number } {
  let start = at + 6
  if (b[start] === CR && b[start + 1] === LF) start += 2
  else if (b[start] === LF || b[start] === CR) start += 1
  const lengthValue = dict.get('Length')
  const length = lengthValue instanceof PdfRef ? resolveLength(lengthValue) : asNumber(lengthValue)
  if (length !== null && length >= 0 && start + length <= b.length) {
    const k = skipWs(b, start + length)
    if (keywordAt(b, k, 'endstream')) return { start, end: start + length }
  }
  // A missing or wrong /Length: the data ends before `endstream` and its end of line.
  const found = indexOfBytes(b, ENDSTREAM, start)
  if (found < 0) throw new PdfSyntaxError('Stream without endstream', at)
  let end = found
  if (end > start && b[end - 1] === LF) end--
  if (end > start && b[end - 1] === CR) end--
  return { start, end }
}

export interface TopLevelObject {
  num: number
  gen: number
  value: PdfValue
  /** Stream data, raw (still encrypted and filtered). */
  stream: { dict: PdfDict; start: number; end: number } | null
  /** Where the value (for a stream, its data) ends. */
  end: number
}

/** Parses the indirect object whose header is at `offset` (null when it is not object `expected`). */
function indirectAt(
  b: Uint8Array,
  offset: number,
  resolveLength: (ref: PdfRef) => number | null,
  expected?: number
): TopLevelObject | null {
  const header = objHeader(b, offset)
  if (!header) return null
  const [num, gen, at] = header
  // Checked before the value is parsed: entries that point at another object cost nothing.
  if (expected !== undefined && num !== expected) return null
  const [value, end] = parseValue(b, at)
  const k = skipWs(b, end)
  if (value instanceof Map && keywordAt(b, k, 'stream')) {
    const span = streamSpan(b, value, k, resolveLength)
    return { num, gen, value, stream: { dict: value, ...span }, end: span.end }
  }
  return { num, gen, value, stream: null, end }
}

/** A free entry (shared: a section can list millions). */
const FREE: XrefEntry = Object.freeze({ type: 0 as const })

/**
 * An xref stream (ISO 32000-2, 7.5.8). Everything the file controls is checked before the data is
 * decoded: /W, /Size and /Index (as MuPDF checks them, and no more entries than /Size), and the
 * data may not decode to more than those entries need.
 */
function readStreamSection(b: Uint8Array, offset: number, budget: XrefBudget): Section {
  const obj = indirectAt(b, offset, () => null)
  if (!obj?.stream || asName(obj.stream.dict.get('Type')) !== 'XRef') {
    throw new PdfSyntaxError('startxref does not point at a cross-reference section', offset)
  }
  const dict = obj.stream.dict
  const w = dict.get('W')
  if (!Array.isArray(w) || w.length < 3 || !w.every((x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 8)) {
    throw new PdfSyntaxError('Bad /W in cross-reference stream', offset)
  }
  const [w0, w1, w2] = w as number[]
  const width = w0 + w1 + w2
  if (width < 1) throw new PdfSyntaxError('Bad /W in cross-reference stream', offset)
  const size = asNumber(dict.get('Size')) ?? 0
  if (!Number.isInteger(size) || size < 0 || size > MAX_OBJECT_NUMBER + 1) throw new PdfSyntaxError('Bad /Size in cross-reference stream', offset)
  const indexValue = dict.get('Index')
  const index = Array.isArray(indexValue) ? (indexValue as PdfValue[]).map((x) => asNumber(x) ?? 0) : [0, size]
  let total = 0
  for (let s = 0; s + 1 < index.length; s += 2) {
    const [first, count] = [index[s], index[s + 1]]
    if (!Number.isInteger(first) || !Number.isInteger(count) || first < 0 || count < 0 || first + count > MAX_OBJECT_NUMBER + 1) {
      throw new PdfSyntaxError('Cross-reference subsection out of range', offset)
    }
    total += count
  }
  if (total > size) throw new PdfSyntaxError('Cross-reference stream has more entries than /Size', offset)
  budget.takeEntries(total, offset)
  // Predictors add a byte to each row, more when a row is shorter than an entry; allow some slack.
  const data = decodeStream(b.subarray(obj.stream.start, obj.stream.end), dict, 2 * total * width + 65536)
  if (total * width > data.length) throw new PdfSyntaxError('Cross-reference stream too short', offset)
  const entries = new Map<number, XrefEntry>()
  let pos = 0
  const field = (n: number) => {
    let v = 0
    for (let k = 0; k < n; k++) v = v * 256 + data[pos++]
    return v
  }
  for (let s = 0; s + 1 < index.length; s += 2) {
    for (let k = 0; k < index[s + 1]; k++) {
      const type = w0 ? field(w0) : 1
      const f1 = field(w1)
      const f2 = field(w2)
      const num = index[s] + k
      if (entries.has(num)) continue
      if (type === 0) entries.set(num, FREE)
      else if (type === 1) entries.set(num, { type: 1, offset: f1, gen: w2 ? f2 : 0 })
      else if (type === 2) entries.set(num, { type: 2, stream: f1, index: f2 })
      // Other types are reserved: treated as references to the null object.
    }
  }
  return { kind: 'stream', entries, trailer: dict, end: obj.stream.end }
}

function readSection(b: Uint8Array, offset: number, budget = new XrefBudget(b)): Section {
  if (!Number.isInteger(offset) || offset < 0 || offset >= b.length) throw new PdfSyntaxError('Cross-reference offset out of range', offset)
  const i = skipWs(b, offset)
  let section: Section
  if (keywordAt(b, i, 'xref')) {
    section = readTableSection(b, i)
    budget.takeEntries(section.entries.size, i)
  } else section = readStreamSection(b, i, budget)
  budget.takeBytes(i, section.end)
  return section
}

/**
 * The newest trailer: the section the LAST `startxref` of the file points at. For a hybrid file
 * this is the classic trailer, which names its xref stream in /XRefStm.
 */
export function lastTrailer(b: Uint8Array): { dict: PdfDict; offset: number; kind: 'table' | 'stream' } {
  const offset = lastStartxref(b)
  const section = readSection(b, offset)
  return { dict: section.trailer, offset, kind: section.kind }
}

/** Reads the whole cross-reference chain (newest entries win); scans the file when it is damaged. */
export function readXref(b: Uint8Array): Xref {
  try {
    const startxref = lastStartxref(b)
    const entries = new Map<number, XrefEntry>()
    const trailers: PdfDict[] = []
    let kind: 'table' | 'stream' = 'table'
    const seen = new Set<number>()
    // One budget for the whole chain: a chain of many sections is no cheaper to make than one.
    const budget = new XrefBudget(b)
    for (let offset: number | null = startxref; offset !== null; ) {
      if (seen.has(offset)) break
      seen.add(offset)
      const section = readSection(b, offset, budget)
      if (!trailers.length) kind = section.kind
      trailers.push(section.trailer)
      const own = section.entries
      // Hybrid files: the table lists objects in object streams as free; the stream named by
      // /XRefStm has their real entries (ISO 32000-2, 7.5.8.4).
      const stm = asNumber(section.trailer.get('XRefStm'))
      if (section.kind === 'table' && stm !== null && !seen.has(stm)) {
        seen.add(stm)
        for (const [num, e] of readSection(b, stm, budget).entries) {
          const t = own.get(num)
          if (!t || t.type === 0) own.set(num, e)
        }
      }
      for (const [num, e] of own) if (!entries.has(num)) entries.set(num, e)
      offset = asNumber(section.trailer.get('Prev'))
    }
    return { entries, trailer: trailers[0], trailers, startxref, kind, damaged: false }
  } catch {
    return scanXref(b)
  }
}

/**
 * Damaged files: every `num gen obj` header (the last definition of a number wins) and the last
 * trailer that names a catalog. Object streams are not looked into. Takes time linear in the size
 * of the file, whatever it holds.
 */
export function scanXref(b: Uint8Array): Xref {
  const text = toLatin1(b)
  const entries = new Map<number, XrefEntry>()
  // Object headers and `trailer` keywords, in file order. A header starts after white space or a
  // delimiter: the lookbehind is checked first, so the pattern never starts inside a run of digits
  // (rescanning the rest of the run from every digit made long runs take quadratic time).
  const marks: { at: number; from: number; header: boolean }[] = []
  for (const m of text.matchAll(/(?<![^\0\t\n\f\r ()<>[\]{}/%])(\d+)[\0\t\n\f\r ]+(\d+)[\0\t\n\f\r ]+obj(?![^\0\t\n\f\r ()<>[\]{}/%])/g)) {
    entries.set(Number(m[1]), { type: 1, offset: m.index, gen: Number(m[2]) })
    marks.push({ at: m.index, from: m.index + m[0].length, header: true })
  }
  for (const m of text.matchAll(/trailer/g)) marks.push({ at: m.index, from: m.index + 7, header: false })
  marks.sort((x, y) => x.at - y.at)
  // A dictionary after a header (an xref stream's) or a trailer is read only up to the next mark:
  // damaged data such as an unterminated string then costs its own stretch of the file, not the
  // rest of the file once per mark.
  const candidates: { at: number; dict: PdfDict }[] = []
  marks.forEach((mark, k) => {
    const part = b.subarray(0, k + 1 < marks.length ? marks[k + 1].at : b.length)
    const i = skipWs(part, mark.from)
    if (part[i] !== 0x3c || part[i + 1] !== 0x3c) return
    try {
      const [value] = parseValue(part, i)
      if (value instanceof Map && (!mark.header || asName(value.get('Type')) === 'XRef')) candidates.push({ at: mark.at, dict: value })
    } catch {}
  })
  candidates.sort((x, y) => y.at - x.at)
  const trailers = candidates.filter((c) => c.dict.has('Root')).map((c) => c.dict)
  let startxref = 0
  try {
    startxref = lastStartxref(b)
  } catch {}
  return { entries, trailer: trailers[0] ?? new Map(), trailers, startxref, kind: 'table', damaged: true }
}

/**
 * A top-level object (not one inside an object stream) through the cross-reference data: its value
 * and, for a stream, where its raw data is (/Length direct or indirect). Null when the object is
 * free, inside an object stream, or not where the xref says.
 */
export function objectAt(b: Uint8Array, xref: Xref, num: number, depth = 0): TopLevelObject | null {
  const e = xref.entries.get(num)
  if (!e || e.type !== 1 || depth > 8) return null
  const resolveLength = (ref: PdfRef) => {
    const v = objectAt(b, xref, ref.num, depth + 1)?.value
    return typeof v === 'number' ? v : null
  }
  try {
    return indirectAt(b, e.offset, resolveLength, num)
  } catch {
    return null
  }
}

/** Follows a reference to a top-level object's value (one level); other values as they are. */
export function resolve(b: Uint8Array, xref: Xref, v: PdfValue | undefined): PdfValue {
  if (v === undefined) return null
  if (v instanceof PdfRef) return objectAt(b, xref, v.num)?.value ?? null
  return v
}
