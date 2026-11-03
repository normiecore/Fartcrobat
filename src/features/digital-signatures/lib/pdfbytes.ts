/**
 * Byte-level PDF helpers for signatures: locating and patching the /ByteRange and /Contents
 * placeholders, extracting signed data, and reading the incremental-update structure (revisions
 * and the objects each update changed). Works on raw file bytes; no MuPDF needed.
 */

const latin1 = new TextDecoder('latin1')

function bytesOf(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

export function indexOfBytes(hay: Uint8Array, needle: string | Uint8Array, from = 0, to = hay.length): number {
  const n = typeof needle === 'string' ? bytesOf(needle) : needle
  if (!n.length) return from
  const first = n[0]
  const last = Math.min(to, hay.length) - n.length
  outer: for (let i = Math.max(0, from); i <= last; i++) {
    if (hay[i] !== first) continue
    for (let k = 1; k < n.length; k++) if (hay[i + k] !== n[k]) continue outer
    return i
  }
  return -1
}

export function lastIndexOfBytes(hay: Uint8Array, needle: string | Uint8Array, before = hay.length, from = 0): number {
  const n = typeof needle === 'string' ? bytesOf(needle) : needle
  outer: for (let i = Math.min(before, hay.length) - n.length; i >= from; i--) {
    for (let k = 0; k < n.length; k++) if (hay[i + k] !== n[k]) continue outer
    return i
  }
  return -1
}

const isWs = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00
const isDigit = (c: number) => c >= 0x30 && c <= 0x39
const isHex = (c: number) => isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)

export interface Placeholder {
  objStart: number
  objEnd: number
  /** Offsets of '[' and just after ']' of the /ByteRange array. */
  byteRangeStart: number
  byteRangeEnd: number
  /** Offset of '<' and just after '>' of the /Contents string. */
  contentsStart: number
  contentsEnd: number
}

export class SignaturePlaceholderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignaturePlaceholderError'
  }
}

/** Finds the latest definition of object `num` ("num 0 obj"). Returns its offset or -1. */
export function findObject(bytes: Uint8Array, num: number, gen = 0, before = bytes.length): number {
  const needle = `${num} ${gen} obj`
  let pos = before
  for (;;) {
    pos = lastIndexOfBytes(bytes, needle, pos)
    if (pos < 0) return -1
    const prev = pos > 0 ? bytes[pos - 1] : 0x0a
    const next = bytes[pos + needle.length]
    if ((pos === 0 || isWs(prev)) && (next === undefined || isWs(next) || next === 0x3c)) return pos
    pos = pos + needle.length - 1
  }
}

/** Locates the placeholders of the signature dictionary written as object `num`. */
export function locatePlaceholder(bytes: Uint8Array, num: number): Placeholder {
  const objStart = findObject(bytes, num)
  if (objStart < 0) throw new SignaturePlaceholderError('The signature dictionary was not written to the file')
  const objEnd = indexOfBytes(bytes, 'endobj', objStart)
  if (objEnd < 0) throw new SignaturePlaceholderError('The signature dictionary is incomplete')
  const br = indexOfBytes(bytes, '/ByteRange', objStart, objEnd)
  const ct = indexOfBytes(bytes, '/Contents', objStart, objEnd)
  if (br < 0 || ct < 0) throw new SignaturePlaceholderError('The signature placeholders were not found')
  let p = br + '/ByteRange'.length
  while (isWs(bytes[p])) p++
  if (bytes[p] !== 0x5b) throw new SignaturePlaceholderError('Malformed /ByteRange placeholder')
  const byteRangeStart = p
  const close = indexOfBytes(bytes, ']', p, objEnd)
  if (close < 0) throw new SignaturePlaceholderError('Malformed /ByteRange placeholder')
  let q = ct + '/Contents'.length
  while (isWs(bytes[q])) q++
  if (bytes[q] !== 0x3c) throw new SignaturePlaceholderError('Malformed /Contents placeholder')
  const contentsStart = q
  let r = q + 1
  while (r < objEnd && isHex(bytes[r])) r++
  if (bytes[r] !== 0x3e) throw new SignaturePlaceholderError('Malformed /Contents placeholder')
  return { objStart, objEnd, byteRangeStart, byteRangeEnd: close + 1, contentsStart, contentsEnd: r + 1 }
}

/** Writes the real byte range over the placeholder (same width) and returns it. */
export function patchByteRange(bytes: Uint8Array, ph: Placeholder): [number, number, number, number] {
  const range: [number, number, number, number] = [0, ph.contentsStart, ph.contentsEnd, bytes.length - ph.contentsEnd]
  const width = ph.byteRangeEnd - ph.byteRangeStart
  let text = `[${range.join(' ')}`
  if (text.length + 1 > width) throw new SignaturePlaceholderError('The /ByteRange placeholder is too small')
  text = text.padEnd(width - 1, ' ') + ']'
  bytes.set(bytesOf(text), ph.byteRangeStart)
  return range
}

/** Capacity of the /Contents placeholder in bytes. */
export function placeholderCapacity(ph: Placeholder): number {
  return Math.floor((ph.contentsEnd - ph.contentsStart - 2) / 2)
}

/** Writes the hex-encoded signature into the /Contents placeholder (zero padded). */
export function writeContents(bytes: Uint8Array, ph: Placeholder, cms: Uint8Array) {
  const cap = placeholderCapacity(ph)
  if (cms.length > cap) throw new SignaturePlaceholderError(`The signature (${cms.length} bytes) does not fit the reserved space (${cap} bytes)`)
  const digits = '0123456789ABCDEF'
  let o = ph.contentsStart + 1
  for (const b of cms) {
    bytes[o++] = digits.charCodeAt(b >> 4)
    bytes[o++] = digits.charCodeAt(b & 15)
  }
}

/** The data covered by a byte range, concatenated. */
export function signedBytes(bytes: Uint8Array, br: number[]): Uint8Array {
  const out = new Uint8Array(br[1] + br[3])
  out.set(bytes.subarray(br[0], br[0] + br[1]), 0)
  out.set(bytes.subarray(br[2], br[2] + br[3]), br[1])
  return out
}

export interface ByteRangeCheck {
  ok: boolean
  problem?: string
  /** Offset just after the signed revision. */
  end: number
  /** Decoded /Contents (with zero padding). */
  contents: Uint8Array | null
}

/** Sanity checks of a /ByteRange against the file and reads the signature value from the gap. */
export function checkByteRange(bytes: Uint8Array, br: number[]): ByteRangeCheck {
  const bad = (problem: string): ByteRangeCheck => ({ ok: false, problem, end: 0, contents: null })
  if (br.length !== 4 || br.some((v) => !Number.isInteger(v) || v < 0)) return bad('The signature byte range is malformed.')
  const [a, b, c, d] = br
  if (a !== 0) return bad('The signature does not start at the beginning of the file.')
  if (c <= b) return bad('The signature byte range is malformed.')
  if (c + d > bytes.length) return bad('The file is shorter than the signed byte range (it was truncated).')
  if (bytes[b] !== 0x3c || bytes[c - 1] !== 0x3e) return bad('The signature value is not where the byte range says it is.')
  const hex: number[] = []
  for (let i = b + 1; i < c - 1; i++) {
    const ch = bytes[i]
    if (isWs(ch)) continue
    if (!isHex(ch)) return bad('The signature value contains unexpected data.')
    hex.push(ch)
  }
  const out = new Uint8Array(hex.length >> 1)
  const val = (ch: number) => (ch <= 0x39 ? ch - 0x30 : (ch | 0x20) - 0x57)
  for (let i = 0; i < out.length; i++) out[i] = (val(hex[2 * i]) << 4) | val(hex[2 * i + 1])
  // The gap must be the /Contents value of a dictionary.
  let p = b - 1
  while (p > 0 && isWs(bytes[p])) p--
  if (latin1.decode(bytes.subarray(Math.max(0, p - 8), p + 1)) !== '/Contents') {
    return bad('The signed byte range excludes data other than the signature value.')
  }
  return { ok: true, end: c + d, contents: out }
}

/** Object number of the indirect object that contains `offset` ("N G obj ... endobj"). */
export function objectAt(bytes: Uint8Array, offset: number): number | null {
  const start = lastIndexOfBytes(bytes, ' obj', offset, Math.max(0, offset - 65536))
  if (start < 0) return null
  if (indexOfBytes(bytes, 'endobj', start, offset) >= 0) return null
  const head = latin1.decode(bytes.subarray(Math.max(0, start - 24), start))
  const m = /(\d+)\s+(\d+)\s*$/.exec(head)
  return m ? parseInt(m[1], 10) : null
}

/** True when nothing but whitespace (or a "%%EOF" comment line) follows `end`. */
export function onlyWhitespaceAfter(bytes: Uint8Array, end: number): boolean {
  for (let i = end; i < bytes.length; i++) if (!isWs(bytes[i])) return false
  return true
}


// ---- incremental updates ------------------------------------------------------------------

export type XrefEntryType = 'n' | 'f' | 'c'

export interface XrefSection {
  /** Offset of the cross-reference section (table or stream), as the pointer to it says. */
  offset: number
  /** Offset just after the %%EOF that ends this update. */
  eofEnd: number
  /** Objects defined by this section (and its /XRefStm). Null when the section could not be read. */
  entries: Map<number, XrefEntryType> | null
  /** [object number, file offset] of every object the section says is stored in the file. */
  offsets: [number, number][] | null
  size: number
  prev: number | null
  /** Offset of the cross-reference stream of a hybrid-reference file (/XRefStm). */
  xrefStm: number | null
}

export interface RevisionInfo {
  /** One per revision, in file order. */
  sections: XrefSection[]
  /**
   * The cross-reference sections a reader uses, newest first: from the last startxref, following
   * /Prev (with /XRefStm), the way MuPDF reads the file. Ends early when a section is unreadable.
   */
  chain: XrefSection[]
  /** Why the file's cross-reference information cannot be trusted at all, or null. */
  problem: string | null
}

const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25

function startsWith(bytes: Uint8Array, p: number, s: string): boolean {
  if (p < 0 || p + s.length > bytes.length) return false
  for (let i = 0; i < s.length; i++) if (bytes[p + i] !== s.charCodeAt(i)) return false
  return true
}

/** Skips whitespace and comments. */
function skipWs(bytes: Uint8Array, p: number, limit = bytes.length): number {
  for (;;) {
    while (p < limit && isWs(bytes[p])) p++
    if (p < limit && bytes[p] === 0x25) {
      while (p < limit && bytes[p] !== 0x0a && bytes[p] !== 0x0d) p++
      continue
    }
    return p
  }
}

function readNumberAfter(bytes: Uint8Array, pos: number): number | null {
  let p = pos
  while (p < bytes.length && isWs(bytes[p])) p++
  let s = ''
  while (p < bytes.length && isDigit(bytes[p])) s += String.fromCharCode(bytes[p++])
  return s ? parseInt(s, 10) : null
}

/** Skips one PDF value (or keyword) starting at `p`; returns the offset just after it. */
function skipValue(bytes: Uint8Array, p: number, limit: number): number {
  const c = bytes[p]
  if (c === 0x28) {
    let depth = 0
    for (; p < limit; p++) {
      const d = bytes[p]
      if (d === 0x5c) p++
      else if (d === 0x28) depth++
      else if (d === 0x29 && --depth === 0) return p + 1
    }
    return limit
  }
  if (c === 0x3c && bytes[p + 1] === 0x3c) {
    p += 2
    for (;;) {
      p = skipWs(bytes, p, limit)
      if (p >= limit) return limit
      if (bytes[p] === 0x3e && bytes[p + 1] === 0x3e) return p + 2
      p = skipValue(bytes, p, limit)
    }
  }
  if (c === 0x3c) {
    while (p < limit && bytes[p] !== 0x3e) p++
    return Math.min(limit, p + 1)
  }
  if (c === 0x5b) {
    p++
    for (;;) {
      p = skipWs(bytes, p, limit)
      if (p >= limit) return limit
      if (bytes[p] === 0x5d) return p + 1
      p = skipValue(bytes, p, limit)
    }
  }
  if (c === 0x2f) p++
  else if (isDelim(c)) return p + 1
  while (p < limit && !isWs(bytes[p]) && !isDelim(bytes[p])) p++
  return p
}

/** The values of an array or dictionary body from `p` up to `close`, as raw text; "n g R" is one value. */
function readValues(bytes: Uint8Array, p: number, limit: number, close: string): string[] {
  const out: string[] = []
  for (;;) {
    p = skipWs(bytes, p, limit)
    if (p >= limit || startsWith(bytes, p, close)) return out
    const end = skipValue(bytes, p, limit)
    if (end <= p) return out
    let text = latin1.decode(bytes.subarray(p, end))
    p = end
    if (/^\d+$/.test(text)) {
      const m = /^\s+(\d+)\s+R(?=[\s()<>[\]{}/%]|$)/.exec(latin1.decode(bytes.subarray(p, Math.min(limit, p + 32))))
      if (m) {
        text = `${text} ${m[1]} R`
        p += m[0].length
      }
    }
    out.push(text)
  }
}

interface ParsedDict {
  entries: Map<string, string>
  /** Offset just after the closing '>>'. */
  end: number
}

/** Top-level entries of the dictionary that starts at `p` ('<<'); a repeated key keeps the last value. */
function parseDict(bytes: Uint8Array, p: number): ParsedDict {
  if (!startsWith(bytes, p, '<<')) throw new Error('dictionary expected')
  const end = skipValue(bytes, p, bytes.length)
  if (!startsWith(bytes, end - 2, '>>')) throw new Error('unterminated dictionary')
  const values = readValues(bytes, p + 2, end - 2, '>>')
  if (values.length % 2) throw new Error('malformed dictionary')
  const entries = new Map<string, string>()
  for (let i = 0; i + 1 < values.length; i += 2) {
    if (!values[i].startsWith('/')) throw new Error('malformed dictionary')
    entries.set(values[i].slice(1), values[i + 1])
  }
  return { entries, end }
}

function intValue(v: string | undefined): number | null {
  return v !== undefined && /^\d+$/.test(v) ? parseInt(v, 10) : null
}

function arrayValues(v: string | undefined): string[] {
  if (v === undefined) return []
  const b = bytesOf(v)
  if (b[0] !== 0x5b) return [v]
  return readValues(b, 1, b.length, ']')
}

function dictValue(v: string | undefined): Map<string, string> | null {
  if (v === undefined || !v.startsWith('<<')) return null
  return parseDict(bytesOf(v), 0).entries
}

interface ParsedXref {
  entries: Map<number, XrefEntryType>
  offsets: [number, number][]
  trailer: Map<string, string>
}

function parseClassicXref(bytes: Uint8Array, offset: number): ParsedXref & { end: number } {
  const trailerPos = indexOfBytes(bytes, 'trailer', offset)
  if (trailerPos < 0) throw new Error('xref without trailer')
  const text = latin1.decode(bytes.subarray(offset + 4, trailerPos))
  if (!/^[\s0-9nf]*$/.test(text)) throw new Error('malformed xref table')
  const entries = new Map<number, XrefEntryType>()
  const offsets: [number, number][] = []
  const tokens = text.split(/\s+/).filter(Boolean)
  let i = 0
  while (i < tokens.length) {
    if (i + 1 >= tokens.length) throw new Error('malformed xref table')
    const start = parseInt(tokens[i], 10)
    const count = parseInt(tokens[i + 1], 10)
    if (!Number.isFinite(start) || !Number.isFinite(count)) throw new Error('malformed xref table')
    i += 2
    for (let k = 0; k < count; k++) {
      if (i + 2 >= tokens.length) throw new Error('truncated xref table')
      const type = tokens[i + 2]
      if (type !== 'n' && type !== 'f') throw new Error('malformed xref table')
      entries.set(start + k, type)
      const off = parseInt(tokens[i], 10)
      if (type === 'n' && off > 0) offsets.push([start + k, off])
      i += 3
    }
  }
  const dict = parseDict(bytes, skipWs(bytes, trailerPos + 7))
  return { entries, offsets, trailer: dict.entries, end: dict.end }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream
  if (!DS) throw new Error('DecompressionStream unavailable')
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DS('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let hi = -1
  for (const c of data) {
    if (c === 0x3e) break
    if (isWs(c)) continue
    if (!isHex(c)) throw new Error('bad ASCIIHex data')
    const v = c <= 0x39 ? c - 0x30 : (c | 0x20) - 0x57
    if (hi < 0) hi = v
    else {
      out.push((hi << 4) | v)
      hi = -1
    }
  }
  if (hi >= 0) out.push(hi << 4)
  return new Uint8Array(out)
}

function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  const group: number[] = []
  const flush = (n: number) => {
    let v = 0
    for (let i = 0; i < 5; i++) v = v * 85 + (i < group.length ? group[i] : 84)
    const b = [Math.floor(v / 0x1000000) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
    for (let i = 0; i < n; i++) out.push(b[i])
    group.length = 0
  }
  let i = data[0] === 0x3c && data[1] === 0x7e ? 2 : 0
  for (; i < data.length; i++) {
    const c = data[i]
    if (c === 0x7e) break
    if (isWs(c)) continue
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    if (c < 0x21 || c > 0x75) throw new Error('bad ASCII85 data')
    group.push(c - 0x21)
    if (group.length === 5) flush(4)
  }
  if (group.length === 1) throw new Error('bad ASCII85 data')
  if (group.length) flush(group.length - 1)
  return new Uint8Array(out)
}

function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    const n = data[i++]
    if (n === 128) break
    if (n < 128) {
      for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++])
    } else {
      const b = data[i++]
      for (let k = 0; k < 257 - n; k++) out.push(b)
    }
  }
  return new Uint8Array(out)
}

function lzwDecode(data: Uint8Array, earlyChange: number): Uint8Array {
  const out: number[] = []
  let table: number[][] = []
  const reset = () => {
    table = []
    for (let i = 0; i < 256; i++) table.push([i])
    table.push([], [])
  }
  reset()
  let bits = 9
  let buf = 0
  let nbits = 0
  let prev: number[] | null = null
  let i = 0
  for (;;) {
    while (nbits < bits && i < data.length) {
      buf = ((buf << 8) | data[i++]) >>> 0
      nbits += 8
    }
    if (nbits < bits) break
    const code = (buf >>> (nbits - bits)) & ((1 << bits) - 1)
    nbits -= bits
    buf &= (1 << nbits) - 1
    if (code === 256) {
      reset()
      bits = 9
      prev = null
      continue
    }
    if (code === 257) break
    let entry: number[]
    if (code < table.length && table[code].length) entry = table[code]
    else if (prev && code === table.length) entry = [...prev, prev[0]]
    else throw new Error('bad LZW data')
    for (const b of entry) out.push(b)
    if (prev && table.length < 4096) table.push([...prev, entry[0]])
    prev = entry
    const next = table.length + earlyChange
    bits = next >= 2048 ? 12 : next >= 1024 ? 11 : next >= 512 ? 10 : 9
  }
  return new Uint8Array(out)
}

function unpredictPng(data: Uint8Array, columns: number): Uint8Array {
  const rowLen = columns + 1
  const rows = Math.floor(data.length / rowLen)
  const out = new Uint8Array(rows * columns)
  const prev = new Uint8Array(columns)
  for (let r = 0; r < rows; r++) {
    const filter = data[r * rowLen]
    const row = data.subarray(r * rowLen + 1, r * rowLen + 1 + columns)
    const cur = new Uint8Array(columns)
    for (let i = 0; i < columns; i++) {
      const left = i > 0 ? cur[i - 1] : 0
      const up = prev[i]
      const ul = i > 0 ? prev[i - 1] : 0
      let v = row[i]
      if (filter === 1) v += left
      else if (filter === 2) v += up
      else if (filter === 3) v += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - ul
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - ul)
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul
      }
      cur[i] = v & 0xff
    }
    out.set(cur, r * columns)
    prev.set(cur)
  }
  return out
}

/** Decodes stream data through its filter chain (the filters MuPDF accepts for xref streams). */
async function decodeStream(data: Uint8Array, dict: Map<string, string>): Promise<Uint8Array> {
  const filters = arrayValues(dict.get('Filter'))
  const rawParms = dict.get('DecodeParms')
  const parmList = rawParms?.startsWith('[') ? arrayValues(rawParms) : filters.map(() => rawParms)
  let out = data
  for (let i = 0; i < filters.length; i++) {
    const parms = dictValue(parmList[i]) ?? new Map<string, string>()
    switch (filters[i]) {
      case '/FlateDecode':
      case '/Fl':
        out = await inflate(out)
        break
      case '/LZWDecode':
      case '/LZW':
        out = lzwDecode(out, intValue(parms.get('EarlyChange')) ?? 1)
        break
      case '/ASCIIHexDecode':
      case '/AHx':
        out = asciiHexDecode(out)
        continue
      case '/ASCII85Decode':
      case '/A85':
        out = ascii85Decode(out)
        continue
      case '/RunLengthDecode':
      case '/RL':
        out = runLengthDecode(out)
        continue
      default:
        throw new Error('unsupported xref stream filter')
    }
    // Predictors apply to Flate and LZW only.
    const predictor = intValue(parms.get('Predictor')) ?? 1
    if (predictor === 1) continue
    const colors = intValue(parms.get('Colors')) ?? 1
    const bpc = intValue(parms.get('BitsPerComponent')) ?? 8
    if (predictor < 10 || bpc !== 8) throw new Error('unsupported predictor')
    out = unpredictPng(out, (intValue(parms.get('Columns')) ?? 1) * colors)
  }
  return out
}

/**
 * The data of the stream whose 'stream' keyword is at `kw` ([start, dataEnd)) and the offset just
 * after its 'endstream'.
 */
function streamExtent(bytes: Uint8Array, kw: number, length: number | null, limit = bytes.length): { start: number; dataEnd: number; end: number } {
  let start = kw + 6
  if (bytes[start] === 0x0d) start++
  if (bytes[start] === 0x0a) start++
  if (length !== null && start + length <= limit) {
    const after = skipWs(bytes, start + length, limit)
    if (startsWith(bytes, after, 'endstream')) return { start, dataEnd: start + length, end: after + 9 }
  }
  const endKw = indexOfBytes(bytes, 'endstream', start, limit)
  if (endKw < 0) throw new Error('unterminated stream')
  let dataEnd = endKw
  if (bytes[dataEnd - 1] === 0x0a && dataEnd > start) dataEnd--
  if (bytes[dataEnd - 1] === 0x0d && dataEnd > start) dataEnd--
  return { start, dataEnd, end: endKw + 9 }
}

const OBJ_HEAD = /^(\d+)\s+(\d+)\s+obj(?=[\s()<>[\]{}/%])/

/** The object number and the offset after "N G obj" when an object starts at `p`. */
function objectHeader(bytes: Uint8Array, p: number): { num: number; body: number } | null {
  const m = OBJ_HEAD.exec(latin1.decode(bytes.subarray(p, Math.min(bytes.length, p + 48))))
  return m ? { num: parseInt(m[1], 10), body: p + m[0].length } : null
}

async function parseXrefStream(bytes: Uint8Array, offset: number): Promise<ParsedXref> {
  const head = objectHeader(bytes, skipWs(bytes, offset))
  if (!head) throw new Error('xref stream not found')
  const parsed = parseDict(bytes, skipWs(bytes, head.body))
  const dict = parsed.entries
  if (dict.get('Type') !== '/XRef') throw new Error('not an xref stream')
  const kw = skipWs(bytes, parsed.end)
  if (!startsWith(bytes, kw, 'stream')) throw new Error('xref stream without data')
  const widths = arrayValues(dict.get('W')).map((x) => intValue(x))
  if (widths.length !== 3 || widths.some((x) => x === null || x > 8)) throw new Error('xref stream without /W')
  const [w0, w1, w2] = widths as number[]
  const size = intValue(dict.get('Size')) ?? 0
  const idx = dict.has('Index') ? arrayValues(dict.get('Index')).map((x) => intValue(x)) : [0, size]
  if (idx.some((x) => x === null) || idx.length % 2) throw new Error('malformed /Index')
  const index = idx as number[]
  const { start, dataEnd } = streamExtent(bytes, kw, intValue(dict.get('Length')))
  const data = await decodeStream(bytes.subarray(start, dataEnd), dict)
  const entryLen = w0 + w1 + w2
  const entries = new Map<number, XrefEntryType>()
  const offsets: [number, number][] = []
  let p = 0
  const field = (n: number) => {
    let v = 0
    for (let k = 0; k < n; k++) v = v * 256 + data[p++]
    return v
  }
  for (let i = 0; i + 1 < index.length; i += 2) {
    for (let k = 0; k < index[i + 1]; k++) {
      if (p + entryLen > data.length) throw new Error('truncated xref stream')
      const type = w0 === 0 ? 1 : field(w0)
      const f2 = field(w1)
      field(w2)
      const num = index[i] + k
      if (type === 0) entries.set(num, 'f')
      else if (type === 2) entries.set(num, 'c')
      else if (type === 1) {
        entries.set(num, 'n')
        if (f2 > 0) offsets.push([num, f2])
      }
    }
  }
  return { entries, offsets, trailer: dict }
}

/** Reads the cross-reference section at `offset`; its entries are null when it cannot be read. */
async function readSection(bytes: Uint8Array, offset: number): Promise<XrefSection> {
  const sec: XrefSection = { offset, eofEnd: bytes.length, entries: null, offsets: null, size: 0, prev: null, xrefStm: null }
  const eof = indexOfBytes(bytes, '%%EOF', offset)
  if (eof >= 0) {
    let eofEnd = eof + 5
    if (bytes[eofEnd] === 0x0d) eofEnd++
    if (bytes[eofEnd] === 0x0a) eofEnd++
    sec.eofEnd = eofEnd
  }
  try {
    const p = skipWs(bytes, offset)
    const isTable = startsWith(bytes, p, 'xref')
    const parsed = isTable ? parseClassicXref(bytes, p) : await parseXrefStream(bytes, p)
    const { entries, offsets } = parsed
    sec.size = intValue(parsed.trailer.get('Size')) ?? 0
    sec.prev = intValue(parsed.trailer.get('Prev'))
    if (parsed.trailer.has('Prev') && sec.prev === null) throw new Error('bad /Prev')
    if (isTable && parsed.trailer.has('XRefStm')) {
      const xrefStm = intValue(parsed.trailer.get('XRefStm'))
      if (xrefStm === null || xrefStm <= 0 || xrefStm >= bytes.length) throw new Error('bad /XRefStm')
      const hybrid = await parseXrefStream(bytes, xrefStm)
      for (const [k, v] of hybrid.entries) if (!entries.has(k) || entries.get(k) === 'f') entries.set(k, v)
      offsets.push(...hybrid.offsets)
      sec.xrefStm = xrefStm
    }
    sec.entries = entries
    sec.offsets = offsets
  } catch {
    sec.entries = null
    sec.offsets = null
  }
  return sec
}

/** Revisions from cross-reference sections: sections that end at the same %%EOF form one revision. */
function revisionsFromSections(bytes: Uint8Array, list: XrefSection[]): XrefSection[] {
  const byEnd = new Map<number, XrefSection>()
  for (const s of [...list].sort((a, b) => a.offset - b.offset)) {
    const rev = byEnd.get(s.eofEnd)
    if (!rev) {
      byEnd.set(s.eofEnd, { ...s, entries: s.entries && new Map(s.entries), offsets: s.offsets && [...s.offsets] })
      continue
    }
    if (rev.entries && s.entries) for (const [k, v] of s.entries) rev.entries.set(k, v)
    else rev.entries = null
    if (rev.offsets && s.offsets) rev.offsets.push(...s.offsets)
    else rev.offsets = null
    rev.size = Math.max(rev.size, s.size)
  }
  const sections = [...byEnd.values()].sort((a, b) => a.eofEnd - b.eofEnd)
  const head = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
  // A linearized file has a first-page section that is not a revision of its own.
  if (/\/Linearized\b/.test(head) && sections.length > 1 && sections[0].eofEnd < sections[1].offset && sections[0].offset < 2048) {
    sections.shift()
  }
  return sections
}

/** Fallback for files whose sections cannot be followed: every "startxref ... %%EOF" ends one. */
async function scanSections(bytes: Uint8Array): Promise<XrefSection[]> {
  const sections: XrefSection[] = []
  let pos = 0
  for (;;) {
    const eof = indexOfBytes(bytes, '%%EOF', pos)
    if (eof < 0) break
    pos = eof + 5
    const sx = lastIndexOfBytes(bytes, 'startxref', eof, Math.max(0, eof - 1024))
    if (sx < 0) continue
    const offset = readNumberAfter(bytes, sx + 9)
    if (offset === null || offset === 0 || offset >= bytes.length) continue
    sections.push(await readSection(bytes, offset))
  }
  return revisionsFromSections(bytes, sections)
}

/**
 * Lists the revisions of a file (the original file and each incremental update) and the chain of
 * cross-reference sections a reader uses: from the last startxref through every /Prev and
 * /XRefStm, including sections that have no "startxref ... %%EOF" of their own.
 */
export async function readRevisions(bytes: Uint8Array): Promise<RevisionInfo> {
  const chain: XrefSection[] = []
  let problem: string | null = null
  const sx = lastIndexOfBytes(bytes, 'startxref')
  let next = sx >= 0 ? readNumberAfter(bytes, sx + 9) : null
  if (next === null || next <= 0 || next >= bytes.length) {
    problem = 'The file does not say where its cross-reference information is.'
    next = null
  }
  let complete = next !== null
  const seen = new Set<number>()
  while (next !== null) {
    if (next <= 0 || next >= bytes.length || seen.has(next) || chain.length >= 100000) {
      complete = false
      break
    }
    seen.add(next)
    const sec = await readSection(bytes, next)
    chain.push(sec)
    if (!sec.entries) {
      complete = false
      break
    }
    next = sec.prev
  }
  const sections = complete ? revisionsFromSections(bytes, chain) : await scanSections(bytes)
  return { sections, chain, problem }
}

/** 1-based revision number of the revision ending at (or just after) `end`. */
export function revisionNumberAt(info: RevisionInfo, end: number): number {
  for (let i = 0; i < info.sections.length; i++) if (info.sections[i].eofEnd >= end - 2) return i + 1
  return info.sections.length || 1
}

/** Skips whitespace, comments (%%EOF included) and "startxref N" lines. */
function skipFiller(bytes: Uint8Array, p: number, limit: number): number {
  for (;;) {
    p = skipWs(bytes, p, limit)
    if (p + 9 > limit || !startsWith(bytes, p, 'startxref')) return p
    let q = skipWs(bytes, p + 9, limit)
    if (q >= limit || !isDigit(bytes[q])) return p
    while (q < limit && isDigit(bytes[q])) q++
    p = q
  }
}

/** Offset just after the "endobj" of the object at `p`, or -1 when it is not well formed. */
function objectEnd(bytes: Uint8Array, p: number, limit: number): number {
  const head = objectHeader(bytes, p)
  if (!head) return -1
  const body = skipWs(bytes, head.body, limit)
  let after: number
  if (startsWith(bytes, body, '<<')) {
    let dict: ParsedDict
    try {
      dict = parseDict(bytes, body)
    } catch {
      return -1
    }
    if (dict.end > limit) return -1
    after = skipWs(bytes, dict.end, limit)
    if (startsWith(bytes, after, 'stream')) {
      try {
        after = skipWs(bytes, streamExtent(bytes, after, intValue(dict.entries.get('Length')), limit).end, limit)
      } catch {
        return -1
      }
    }
  } else {
    after = indexOfBytes(bytes, 'endobj', body, limit)
    if (after < 0) return -1
  }
  return startsWith(bytes, after, 'endobj') && after + 6 <= limit ? after + 6 : -1
}

/**
 * Whether the bytes from `end` to the end of the file consist only of what the given
 * cross-reference sections account for: the objects they list, the sections themselves and the
 * trailer lines, and every object they list (in the update or in the signed revision) starts
 * where they say. Anything else (objects no section lists, stray sections, entries that point to
 * another object) makes them untrustworthy.
 */
function tailAccounted(bytes: Uint8Array, end: number, newer: XrefSection[]): boolean {
  const starts = new Set<number>()
  for (const s of newer) {
    starts.add(skipWs(bytes, s.offset))
    if (s.xrefStm !== null && s.xrefStm >= end) starts.add(skipWs(bytes, s.xrefStm))
    for (const [num, off] of s.offsets!) {
      // Every entry must point to that object, also when it points into the signed revision:
      // otherwise a reader repairs the file and may pick up objects no section lists.
      if (off >= bytes.length) return false
      const at = skipWs(bytes, off)
      if (objectHeader(bytes, at)?.num !== num) return false
      if (off >= end) starts.add(at)
    }
  }
  const sorted = [...starts].sort((a, b) => a - b)
  let p = end
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]
    if (start < end || skipFiller(bytes, p, start) !== start) return false
    const limit = i + 1 < sorted.length ? sorted[i + 1] : bytes.length
    let after = -1
    if (startsWith(bytes, start, 'xref')) {
      try {
        after = parseClassicXref(bytes, start).end
      } catch {}
    } else after = objectEnd(bytes, start, limit)
    if (after < 0 || after > limit) return false
    p = after
  }
  return skipFiller(bytes, p, bytes.length) === bytes.length
}

/** Offset the startxref of the revision ending at `end` points to, or null. */
function startxrefBefore(bytes: Uint8Array, end: number): number | null {
  const sx = lastIndexOfBytes(bytes, 'startxref', end, Math.max(0, end - 1024))
  return sx < 0 ? null : readNumberAfter(bytes, sx + 9)
}

/**
 * Objects defined by the updates written after `end` (the end of a signed revision), with their
 * newest type. Null when they cannot be determined reliably: the file's cross-reference
 * information is damaged, the updates do not lead back to the signed revision's own
 * cross-reference section, a section cannot be read, or the updates hold bytes their
 * cross-reference sections do not account for.
 */
export function objectsChangedAfter(bytes: Uint8Array, info: RevisionInfo, end: number): Map<number, XrefEntryType> | null {
  if (info.problem) return null
  const signedXref = startxrefBefore(bytes, end)
  if (signedXref === null) return null
  const out = new Map<number, XrefEntryType>()
  let i = 0
  for (; i < info.chain.length && info.chain[i].offset >= end; i++) {
    const s = info.chain[i]
    if (!s.entries || !s.offsets) return null
    for (const [k, v] of s.entries) if (k !== 0 && !out.has(k)) out.set(k, v)
  }
  // The oldest update must chain to the signed revision's own cross-reference section.
  if (i >= info.chain.length || info.chain[i].offset !== signedXref) return null
  if (!tailAccounted(bytes, end, info.chain.slice(0, i))) return null
  return out
}

/** /Size of the revision that ends at `end` (objects numbered at or above it were added later). */
export function sizeAt(info: RevisionInfo, end: number): number {
  const signed = info.chain.find((s) => s.offset < end)
  if (signed) return signed.size
  let size = 0
  for (const s of info.sections) if (s.offset < end) size = Math.max(size, s.size)
  return size
}
