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
  /** Offset of the cross-reference section (table or stream). */
  offset: number
  /** Offset just after the %%EOF that ends this update. */
  eofEnd: number
  /** Objects defined by this update. Null when the section could not be read. */
  entries: Map<number, XrefEntryType> | null
  size: number
  prev: number | null
}

export interface RevisionInfo {
  /** One per revision, in file order. */
  sections: XrefSection[]
}

function readNumberAfter(bytes: Uint8Array, pos: number): number | null {
  let p = pos
  while (p < bytes.length && isWs(bytes[p])) p++
  let s = ''
  while (p < bytes.length && isDigit(bytes[p])) s += String.fromCharCode(bytes[p++])
  return s ? parseInt(s, 10) : null
}

function dictInt(text: string, key: string): number | null {
  const m = new RegExp(`/${key}\\s+(\\d+)`).exec(text)
  return m ? parseInt(m[1], 10) : null
}

function parseClassicXref(bytes: Uint8Array, offset: number): { entries: Map<number, XrefEntryType>; trailer: string } {
  const trailerPos = indexOfBytes(bytes, 'trailer', offset)
  if (trailerPos < 0) throw new Error('xref without trailer')
  const text = latin1.decode(bytes.subarray(offset + 4, trailerPos))
  const entries = new Map<number, XrefEntryType>()
  const tokens = text.split(/\s+/).filter(Boolean)
  let i = 0
  while (i + 1 < tokens.length) {
    const start = parseInt(tokens[i], 10)
    const count = parseInt(tokens[i + 1], 10)
    if (!Number.isFinite(start) || !Number.isFinite(count)) break
    i += 2
    for (let k = 0; k < count && i + 2 < tokens.length + 1; k++) {
      const type = tokens[i + 2]
      if (type === 'n' || type === 'f') entries.set(start + k, type)
      i += 3
    }
  }
  const sx = indexOfBytes(bytes, 'startxref', trailerPos)
  const trailer = latin1.decode(bytes.subarray(trailerPos, sx > 0 ? sx : Math.min(bytes.length, trailerPos + 4096)))
  return { entries, trailer }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as any).DecompressionStream
  if (!DS) throw new Error('DecompressionStream unavailable')
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DS('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
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

async function parseXrefStream(bytes: Uint8Array, offset: number): Promise<{ entries: Map<number, XrefEntryType>; trailer: string }> {
  const streamKw = indexOfBytes(bytes, 'stream', offset, Math.min(bytes.length, offset + 8192))
  if (streamKw < 0) throw new Error('xref stream not found')
  const dict = latin1.decode(bytes.subarray(offset, streamKw))
  if (!/\/Type\s*\/XRef/.test(dict)) throw new Error('not an xref stream')
  const w = /\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(dict)
  if (!w) throw new Error('xref stream without /W')
  const widths = [parseInt(w[1], 10), parseInt(w[2], 10), parseInt(w[3], 10)]
  const size = dictInt(dict, 'Size') ?? 0
  const idx = /\/Index\s*\[([\d\s]+)\]/.exec(dict)
  const index = idx ? idx[1].trim().split(/\s+/).map((x) => parseInt(x, 10)) : [0, size]
  let start = streamKw + 6
  if (bytes[start] === 0x0d) start++
  if (bytes[start] === 0x0a) start++
  const lenMatch = /\/Length\s+(\d+)(\s+\d+\s+R)?/.exec(dict)
  let len = lenMatch && !lenMatch[2] ? parseInt(lenMatch[1], 10) : -1
  if (len < 0) {
    const endKw = indexOfBytes(bytes, 'endstream', start)
    len = endKw - start
    while (len > 0 && isWs(bytes[start + len - 1])) len--
  }
  let data = bytes.subarray(start, start + len)
  if (/\/Filter\s*(\[\s*)?\/FlateDecode/.test(dict)) data = await inflate(data)
  else if (/\/Filter/.test(dict)) throw new Error('unsupported xref stream filter')
  const pred = /\/Predictor\s+(\d+)/.exec(dict)
  if (pred && parseInt(pred[1], 10) >= 10) {
    const cols = /\/Columns\s+(\d+)/.exec(dict)
    data = unpredictPng(data, cols ? parseInt(cols[1], 10) : 1)
  }
  const entryLen = widths[0] + widths[1] + widths[2]
  const entries = new Map<number, XrefEntryType>()
  let p = 0
  const field = (n: number) => {
    let v = 0
    for (let k = 0; k < n; k++) v = v * 256 + data[p++]
    return v
  }
  for (let i = 0; i + 1 < index.length; i += 2) {
    for (let k = 0; k < index[i + 1]; k++) {
      if (p + entryLen > data.length) break
      const type = widths[0] === 0 ? 1 : field(widths[0])
      field(widths[1])
      field(widths[2])
      entries.set(index[i] + k, type === 0 ? 'f' : type === 2 ? 'c' : 'n')
    }
  }
  return { entries, trailer: dict }
}

/**
 * Lists the revisions of a file: every "startxref ... %%EOF" marks the end of one (the original
 * file or an incremental update), with the objects its cross-reference section defines.
 */
export async function readRevisions(bytes: Uint8Array): Promise<RevisionInfo> {
  const sections: XrefSection[] = []
  const head = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
  const linearized = /\/Linearized\b/.test(head)
  let pos = 0
  for (;;) {
    const eof = indexOfBytes(bytes, '%%EOF', pos)
    if (eof < 0) break
    let eofEnd = eof + 5
    if (bytes[eofEnd] === 0x0d) eofEnd++
    if (bytes[eofEnd] === 0x0a) eofEnd++
    pos = eof + 5
    const sx = lastIndexOfBytes(bytes, 'startxref', eof, Math.max(0, eof - 1024))
    if (sx < 0) continue
    const offset = readNumberAfter(bytes, sx + 9)
    if (offset === null || offset === 0 || offset >= bytes.length) continue
    let entries: Map<number, XrefEntryType> | null = null
    let size = 0
    let prev: number | null = null
    try {
      let p = offset
      while (isWs(bytes[p])) p++
      const isTable = latin1.decode(bytes.subarray(p, p + 4)) === 'xref'
      const parsed = isTable ? parseClassicXref(bytes, p) : await parseXrefStream(bytes, p)
      entries = parsed.entries
      size = dictInt(parsed.trailer, 'Size') ?? 0
      prev = dictInt(parsed.trailer, 'Prev')
      const xrefStm = isTable ? dictInt(parsed.trailer, 'XRefStm') : null
      if (xrefStm) {
        const hybrid = await parseXrefStream(bytes, xrefStm)
        for (const [k, v] of hybrid.entries) entries.set(k, v)
      }
    } catch {
      entries = null
    }
    sections.push({ offset, eofEnd, entries, size, prev })
  }
  // A linearized file has a first-page section that is not a revision of its own.
  if (linearized && sections.length > 1 && sections[0].eofEnd < sections[1].offset && sections[0].offset < 2048) {
    sections.shift()
  }
  return { sections }
}

/** 1-based revision number of the revision ending at (or just after) `end`. */
export function revisionNumberAt(info: RevisionInfo, end: number): number {
  for (let i = 0; i < info.sections.length; i++) if (info.sections[i].eofEnd >= end - 2) return i + 1
  return info.sections.length || 1
}

/** Objects defined by the updates written after `end`, or null if any could not be read. */
export function objectsChangedAfter(info: RevisionInfo, end: number): Map<number, XrefEntryType> | null {
  const out = new Map<number, XrefEntryType>()
  for (const s of info.sections) {
    if (s.offset < end) continue
    if (!s.entries) return null
    for (const [k, v] of s.entries) if (k !== 0) out.set(k, v)
  }
  return out
}

/** /Size of the revision that ends at `end` (objects numbered at or above it were added later). */
export function sizeAt(info: RevisionInfo, end: number): number {
  let size = 0
  for (const s of info.sections) if (s.offset < end) size = Math.max(size, s.size)
  return size
}
