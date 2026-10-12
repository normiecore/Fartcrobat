/**
 * Minimal ASN.1 DER/BER reader and DER writer working on Uint8Array.
 *
 * The reader keeps byte offsets so callers can hash or re-tag exact encodings (CMS signed
 * attributes, TBSCertificate). It accepts BER indefinite lengths, which some signers still produce.
 */

export const CLASS_UNIVERSAL = 0
export const CLASS_APPLICATION = 1
export const CLASS_CONTEXT = 2
export const CLASS_PRIVATE = 3

export const TAG = {
  BOOLEAN: 1,
  INTEGER: 2,
  BIT_STRING: 3,
  OCTET_STRING: 4,
  NULL: 5,
  OID: 6,
  UTF8_STRING: 12,
  SEQUENCE: 16,
  SET: 17,
  NUMERIC_STRING: 18,
  PRINTABLE_STRING: 19,
  T61_STRING: 20,
  IA5_STRING: 22,
  UTC_TIME: 23,
  GENERALIZED_TIME: 24,
  VISIBLE_STRING: 26,
  UNIVERSAL_STRING: 28,
  BMP_STRING: 30
} as const

export interface Asn1Node {
  cls: number
  tag: number
  constructed: boolean
  /** Offset of the first identifier byte. */
  start: number
  /** Offset of the first content byte. */
  contentStart: number
  /** Offset just after the content (before an end-of-contents marker for indefinite lengths). */
  contentEnd: number
  /** Offset just after the whole element. */
  end: number
  indefinite: boolean
  children: Asn1Node[]
  /** The buffer the node was parsed from. */
  buf: Uint8Array
}

export class Asn1Error extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Asn1Error'
  }
}

const MAX_DEPTH = 64

/** Parses one element at `offset`. Children of constructed elements are parsed recursively. */
export function parseAsn1(buf: Uint8Array, offset = 0, limit = buf.length, depth = 0): Asn1Node {
  if (depth > MAX_DEPTH) throw new Asn1Error('ASN.1 nesting too deep')
  let p = offset
  if (p >= limit) throw new Asn1Error('Unexpected end of ASN.1 data')
  const first = buf[p++]
  const cls = first >> 6
  const constructed = (first & 0x20) !== 0
  let tag = first & 0x1f
  if (tag === 0x1f) {
    tag = 0
    let b: number
    do {
      if (p >= limit) throw new Asn1Error('Truncated ASN.1 tag')
      b = buf[p++]
      tag = tag * 128 + (b & 0x7f)
    } while (b & 0x80)
  }
  if (p >= limit) throw new Asn1Error('Truncated ASN.1 length')
  let len = buf[p++]
  let indefinite = false
  if (len === 0x80) {
    if (!constructed) throw new Asn1Error('Indefinite length on a primitive ASN.1 element')
    indefinite = true
  } else if (len & 0x80) {
    const n = len & 0x7f
    if (n > 6) throw new Asn1Error('ASN.1 length too large')
    len = 0
    for (let i = 0; i < n; i++) {
      if (p >= limit) throw new Asn1Error('Truncated ASN.1 length')
      len = len * 256 + buf[p++]
    }
  }
  const contentStart = p
  const node: Asn1Node = {
    cls,
    tag,
    constructed,
    start: offset,
    contentStart,
    contentEnd: contentStart,
    end: contentStart,
    indefinite,
    children: [],
    buf
  }
  if (indefinite) {
    let q = contentStart
    for (;;) {
      if (q + 1 >= limit) throw new Asn1Error('Unterminated indefinite-length ASN.1 element')
      if (buf[q] === 0 && buf[q + 1] === 0) {
        node.contentEnd = q
        node.end = q + 2
        break
      }
      const child = parseAsn1(buf, q, limit, depth + 1)
      node.children.push(child)
      q = child.end
    }
    return node
  }
  const contentEnd = contentStart + len
  if (contentEnd > limit) throw new Asn1Error('ASN.1 element runs past the end of the data')
  node.contentEnd = contentEnd
  node.end = contentEnd
  if (constructed) {
    let q = contentStart
    while (q < contentEnd) {
      const child = parseAsn1(buf, q, contentEnd, depth + 1)
      node.children.push(child)
      q = child.end
    }
  }
  return node
}

/** Content bytes of a primitive element (constructed strings are concatenated). */
export function contentOf(node: Asn1Node): Uint8Array {
  if (!node.constructed) return node.buf.subarray(node.contentStart, node.contentEnd)
  return concatBytes(node.children.map(contentOf))
}

/** The complete encoding of the element (identifier, length and content). */
export function rawOf(node: Asn1Node): Uint8Array {
  return node.buf.subarray(node.start, node.end)
}

export function isUniversal(node: Asn1Node | undefined, tag: number): boolean {
  return !!node && node.cls === CLASS_UNIVERSAL && node.tag === tag
}

export function isContext(node: Asn1Node | undefined, tag: number): boolean {
  return !!node && node.cls === CLASS_CONTEXT && node.tag === tag
}

export function expectUniversal(node: Asn1Node | undefined, tag: number, what: string): Asn1Node {
  if (!isUniversal(node, tag)) throw new Asn1Error(`Malformed ${what}`)
  return node!
}

export function readOid(node: Asn1Node): string {
  const b = contentOf(node)
  if (!b.length) throw new Asn1Error('Empty OID')
  const parts: number[] = []
  let v = 0
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f)
    if (!(b[i] & 0x80)) {
      if (!parts.length) {
        const first = v < 40 ? 0 : v < 80 ? 1 : 2
        parts.push(first, v - first * 40)
      } else parts.push(v)
      v = 0
    }
  }
  return parts.join('.')
}

/** INTEGER as big-endian bytes (two's complement as encoded). */
export function readIntegerBytes(node: Asn1Node): Uint8Array {
  return contentOf(node)
}

export function readBigInt(node: Asn1Node): bigint {
  const b = contentOf(node)
  if (!b.length) return 0n
  let v = 0n
  for (const x of b) v = (v << 8n) | BigInt(x)
  if (b[0] & 0x80) v -= 1n << BigInt(b.length * 8)
  return v
}

export function readSmallInt(node: Asn1Node): number {
  return Number(readBigInt(node))
}

export function readBoolean(node: Asn1Node): boolean {
  const b = contentOf(node)
  return b.length > 0 && b[0] !== 0
}

export function readBitString(node: Asn1Node): { unused: number; bytes: Uint8Array } {
  const b = contentOf(node)
  if (!b.length) return { unused: 0, bytes: new Uint8Array() }
  return { unused: b[0], bytes: b.subarray(1) }
}

const utf8 = new TextDecoder('utf-8', { fatal: false })
const latin1 = new TextDecoder('latin1')

/** Decodes the common ASN.1 string types to a JS string. */
export function readString(node: Asn1Node): string {
  const b = contentOf(node)
  switch (node.tag) {
    case TAG.BMP_STRING: {
      let s = ''
      for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1])
      return s
    }
    case TAG.UNIVERSAL_STRING: {
      let s = ''
      for (let i = 0; i + 3 < b.length; i += 4) {
        s += String.fromCodePoint(((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0)
      }
      return s
    }
    case TAG.T61_STRING:
      return latin1.decode(b)
    default:
      return utf8.decode(b)
  }
}

/** Reads UTCTime or GeneralizedTime. */
export function readTime(node: Asn1Node): Date {
  const s = latin1.decode(contentOf(node))
  const m =
    node.tag === TAG.UTC_TIME
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?(Z|[+-]\d{4})?$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})?(\d{2})?(?:[.,](\d+))?(Z|[+-]\d{4})?$/.exec(s)
  if (!m) throw new Asn1Error(`Bad time value ${s}`)
  let year = parseInt(m[1], 10)
  if (node.tag === TAG.UTC_TIME) year += year < 50 ? 2000 : 1900
  const [mo, d, h, mi, se] = [m[2], m[3], m[4], m[5] ?? '0', m[6] ?? '0'].map((x) => parseInt(x, 10))
  const zone = node.tag === TAG.UTC_TIME ? m[7] : m[8]
  let t = Date.UTC(year, mo - 1, d, h, mi, se)
  if (node.tag === TAG.GENERALIZED_TIME && m[7]) t += Math.round(parseFloat('0.' + m[7]) * 1000)
  if (zone && zone !== 'Z') {
    const sign = zone[0] === '+' ? 1 : -1
    const off = parseInt(zone.slice(1, 3), 10) * 60 + parseInt(zone.slice(3, 5), 10)
    t -= sign * off * 60000
  }
  return new Date(t)
}

// ---- writer --------------------------------------------------------------------------------

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function encodeLength(len: number): Uint8Array {
  if (len < 0x80) return Uint8Array.of(len)
  const bytes: number[] = []
  let v = len
  while (v > 0) {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  }
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

function identifier(cls: number, constructed: boolean, tag: number): Uint8Array {
  const lead = (cls << 6) | (constructed ? 0x20 : 0)
  if (tag < 31) return Uint8Array.of(lead | tag)
  const rest: number[] = []
  let v = tag
  rest.unshift(v & 0x7f)
  v = Math.floor(v / 128)
  while (v > 0) {
    rest.unshift(0x80 | (v & 0x7f))
    v = Math.floor(v / 128)
  }
  return Uint8Array.of(lead | 0x1f, ...rest)
}

/** Encodes an element from its parts. */
export function tlv(cls: number, constructed: boolean, tag: number, content: Uint8Array): Uint8Array {
  return concatBytes([identifier(cls, constructed, tag), encodeLength(content.length), content])
}

export const der = {
  sequence: (...items: (Uint8Array | null | undefined | false)[]) =>
    tlv(CLASS_UNIVERSAL, true, TAG.SEQUENCE, concatBytes(items.filter(Boolean) as Uint8Array[])),
  /** SET OF with DER ordering (elements sorted by their encodings). */
  set: (...items: (Uint8Array | null | undefined | false)[]) => {
    const list = (items.filter(Boolean) as Uint8Array[]).slice().sort(compareBytes)
    return tlv(CLASS_UNIVERSAL, true, TAG.SET, concatBytes(list))
  },
  /** SET whose element order must be kept (e.g. a single attribute value). */
  setUnsorted: (...items: Uint8Array[]) => tlv(CLASS_UNIVERSAL, true, TAG.SET, concatBytes(items)),
  integer: (v: number | bigint | Uint8Array) => tlv(CLASS_UNIVERSAL, false, TAG.INTEGER, integerContent(v)),
  boolean: (v: boolean) => tlv(CLASS_UNIVERSAL, false, TAG.BOOLEAN, Uint8Array.of(v ? 0xff : 0)),
  null: () => Uint8Array.of(0x05, 0x00),
  oid: (oid: string) => tlv(CLASS_UNIVERSAL, false, TAG.OID, oidContent(oid)),
  octetString: (b: Uint8Array) => tlv(CLASS_UNIVERSAL, false, TAG.OCTET_STRING, b),
  bitString: (b: Uint8Array, unused = 0) => tlv(CLASS_UNIVERSAL, false, TAG.BIT_STRING, concatBytes([Uint8Array.of(unused), b])),
  utf8: (s: string) => tlv(CLASS_UNIVERSAL, false, TAG.UTF8_STRING, new TextEncoder().encode(s)),
  printable: (s: string) => tlv(CLASS_UNIVERSAL, false, TAG.PRINTABLE_STRING, asciiBytes(s)),
  ia5: (s: string) => tlv(CLASS_UNIVERSAL, false, TAG.IA5_STRING, asciiBytes(s)),
  utcTime: (d: Date) => tlv(CLASS_UNIVERSAL, false, TAG.UTC_TIME, asciiBytes(formatTime(d, true))),
  generalizedTime: (d: Date) => tlv(CLASS_UNIVERSAL, false, TAG.GENERALIZED_TIME, asciiBytes(formatTime(d, false))),
  /** UTCTime for 1950-2049, GeneralizedTime otherwise (RFC 5280). */
  time: (d: Date) => {
    const y = d.getUTCFullYear()
    return y >= 1950 && y < 2050 ? der.utcTime(d) : der.generalizedTime(d)
  },
  /** [n] EXPLICIT wrapping. */
  explicit: (n: number, item: Uint8Array) => tlv(CLASS_CONTEXT, true, n, item),
  /** [n] IMPLICIT constructed, from already-encoded children. */
  implicitConstructed: (n: number, ...items: Uint8Array[]) => tlv(CLASS_CONTEXT, true, n, concatBytes(items)),
  /** [n] IMPLICIT primitive with raw content. */
  implicitPrimitive: (n: number, content: Uint8Array) => tlv(CLASS_CONTEXT, false, n, content)
}

function asciiBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f
  return out
}

function formatTime(d: Date, utc: boolean): string {
  const pad = (v: number, n = 2) => String(v).padStart(n, '0')
  const y = d.getUTCFullYear()
  const body = `${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  return utc ? `${pad(y % 100)}${body}` : `${pad(y, 4)}${body}`
}

function integerContent(v: number | bigint | Uint8Array): Uint8Array {
  if (v instanceof Uint8Array) {
    // Unsigned magnitude: strip leading zeros, add one back if the top bit is set.
    let i = 0
    while (i < v.length - 1 && v[i] === 0) i++
    const b = v.subarray(i)
    if (!b.length) return Uint8Array.of(0)
    return b[0] & 0x80 ? concatBytes([Uint8Array.of(0), b]) : b.slice()
  }
  let n = BigInt(v)
  if (n === 0n) return Uint8Array.of(0)
  const bytes: number[] = []
  if (n > 0n) {
    while (n > 0n) {
      bytes.unshift(Number(n & 0xffn))
      n >>= 8n
    }
    if (bytes[0] & 0x80) bytes.unshift(0)
  } else {
    // two's complement in the smallest number of bytes
    let len = 1
    while (n < -(1n << BigInt(len * 8 - 1))) len++
    let t = (1n << BigInt(len * 8)) + n
    for (let i = 0; i < len; i++) {
      bytes.unshift(Number(t & 0xffn))
      t >>= 8n
    }
  }
  return Uint8Array.from(bytes)
}

function oidContent(oid: string): Uint8Array {
  const parts = oid.split('.').map((x) => parseInt(x, 10))
  if (parts.length < 2 || parts.some((x) => !Number.isFinite(x) || x < 0)) throw new Asn1Error(`Bad OID ${oid}`)
  const out: number[] = []
  const push = (v: number) => {
    const tmp = [v & 0x7f]
    v = Math.floor(v / 128)
    while (v > 0) {
      tmp.unshift(0x80 | (v & 0x7f))
      v = Math.floor(v / 128)
    }
    out.push(...tmp)
  }
  push(parts[0] * 40 + parts[1])
  for (const p of parts.slice(2)) push(p)
  return Uint8Array.from(out)
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && compareBytes(a, b) === 0
}

export function toHex(b: Uint8Array, sep = ''): string {
  let s = ''
  for (let i = 0; i < b.length; i++) {
    if (i && sep) s += sep
    s += b[i].toString(16).padStart(2, '0')
  }
  return s.toUpperCase()
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const out = new Uint8Array(clean.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}

export function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
