// Minimal DER reading and writing: enough to take the issuer, serial number and public key out of
// an X.509 certificate byte-for-byte, and to build a CMS EnvelopedData. (The app has the same in
// src/features/digital-signatures/lib/asn1.ts: parseAsn1 / rawOf / der.)
import { concat } from './crypto.mjs'

/** Parses one TLV at `at`. Returns { tag, start, headerLen, len, end } (start..end = whole TLV). */
export function readTlv(buf, at = 0) {
  const tag = buf[at]
  let p = at + 1
  let len = buf[p++]
  if (len & 0x80) {
    const n = len & 0x7f
    if (n === 0 || n > 4) throw new Error('unsupported DER length')
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]
  }
  const end = p + len
  if (end > buf.length) throw new Error('DER length runs past the end')
  return { tag, start: at, headerLen: p - at, len, end, content: buf.subarray(p, end), raw: buf.subarray(at, end) }
}

/** The child TLVs of a constructed TLV. */
export function children(tlv) {
  const out = []
  const base = tlv.content
  let at = 0
  while (at < base.length) {
    const c = readTlv(base, at)
    out.push(c)
    at = c.end
  }
  return out
}

function lenBytes(n) {
  if (n < 0x80) return Uint8Array.of(n)
  const b = []
  while (n > 0) {
    b.unshift(n & 0xff)
    n = Math.floor(n / 256)
  }
  return Uint8Array.of(0x80 | b.length, ...b)
}

export const tlv = (tag, ...content) => {
  const body = concat(content)
  return concat([Uint8Array.of(tag), lenBytes(body.length), body])
}

function compareBytes(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

export const der = {
  seq: (...items) => tlv(0x30, ...items),
  /** SET OF, sorted as DER requires. */
  setOf: (...items) => tlv(0x31, ...[...items].sort(compareBytes)),
  int: (n) => tlv(0x02, Uint8Array.of(n)), // small non-negative ints only
  octets: (b) => tlv(0x04, b),
  null: () => Uint8Array.of(0x05, 0x00),
  oid: (dotted) => {
    const parts = dotted.split('.').map(Number)
    const out = [40 * parts[0] + parts[1]]
    for (const v of parts.slice(2)) {
      const enc = [v & 0x7f]
      for (let x = Math.floor(v / 128); x > 0; x = Math.floor(x / 128)) enc.unshift(0x80 | (x & 0x7f))
      out.push(...enc)
    }
    return tlv(0x06, Uint8Array.from(out))
  },
  /** [n] EXPLICIT (constructed). */
  explicit: (n, inner) => tlv(0xa0 | n, inner),
  /** [n] IMPLICIT primitive. */
  implicit: (n, content) => tlv(0x80 | n, content)
}

export const OID = {
  data: '1.2.840.113549.1.7.1',
  envelopedData: '1.2.840.113549.1.7.3',
  rsaEncryption: '1.2.840.113549.1.1.1',
  aes256Cbc: '2.16.840.1.101.3.4.1.42'
}

export function readOid(t) {
  const b = t.content
  const parts = [Math.floor(b[0] / 40), b[0] % 40]
  let v = 0
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f)
    if (!(b[i] & 0x80)) {
      parts.push(v)
      v = 0
    }
  }
  return parts.join('.')
}

/**
 * The parts of an X.509 certificate a CMS recipient needs, as the exact DER bytes found in the
 * certificate (so issuerAndSerialNumber matches the certificate store byte-for-byte).
 */
export function certificateParts(certDer) {
  const cert = readTlv(certDer)
  const [tbs] = children(cert)
  const f = children(tbs)
  let i = 0
  if (f[0].tag === 0xa0) i++ // [0] version
  const serial = f[i]
  const issuer = f[i + 2]
  const subject = f[i + 4]
  const spki = f[i + 5]
  const algId = children(spki)[0]
  const keyOid = readOid(children(algId)[0])
  return { serial: serial.raw, issuer: issuer.raw, subject: subject.raw, spki: spki.raw, keyOid }
}

export function pemToDer(pem) {
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem)
  const b64 = (m ? m[1] : pem).replace(/\s+/g, '')
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}
