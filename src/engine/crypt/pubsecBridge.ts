// Opening certificate-encrypted (/Adobe.PubSec) files in MuPDF, which only knows the Standard
// security handler. With the seed a person's key unwrapped and the file key K derived from it:
//
//   V5 (AES-256) with EncryptMetadata true: the bridge. Append one update section that redefines
//   the encryption dictionary as a Standard V5/R6 one wrapping the same K under one-time passwords,
//   and open that with the user password. Appending never moves existing bytes, so this works the
//   same for classic tables, xref streams, object streams and incremental updates.
//
//   V2/V4 (RC4, AES-128), and V5 with EncryptMetadata false (MuPDF ignores the flag when reading):
//   the decrypt pass. Append an update whose trailer has no /Encrypt, open it (MuPDF then sees a
//   plain file that still holds ciphertext) and decrypt every string and stream ourselves.
//
// The bridged bytes and the one-time passwords never leave the worker and never reach disk: every
// output is written by pubsecWrite.ts with the original seed and envelopes (assertNoBridge checks).
import type { CertificateKey } from '@shared/certkeys'
import type { PasswordAccess } from '@shared/types'
import { EngineError } from '../define'
import type { Mupdf, PDFDocument } from '../session'
import { certificatePermissions } from './keys'
import { collectStrings, hasCryptFilter, isNamed, rawStream } from './objects'
import { asName, objectAt, PdfRef, readBudget, serialise, type PdfDict, type PdfValue, type ReadMeter, type Xref } from './pdfLex'
import {
  aesCbcDecryptNoPad,
  bytesEqual,
  concat,
  latin1,
  md5,
  pkcs7Length,
  rc4,
  sha1,
  sha256
} from './primitives'
import type { PubSecCipher, PubSecInfo } from './pubsecRead'
import { oneTimePassword, standardR6Dict } from './standardR6'

/** The key every output of a certificate-encrypted document is written with (always V5, AES-256). */
export interface PubSecWriteKey {
  seed: Uint8Array
  /** The /Recipients envelopes, in order. */
  recipients: Uint8Array[]
  /** SHA-256(seed || recipients || [FF FF FF FF when EncryptMetadata is false]). */
  fileKey: Uint8Array
  encryptMetadata: boolean
}

/** Certificate security of an open document (Session.pubsec). Holds secrets: never log or send it. */
export interface PubSecState {
  /** The key that opened it. */
  key: CertificateKey
  seed: Uint8Array
  /** The envelope's permission bytes (big-endian, unsigned), null when it has none. */
  permissions: number | null
  access: PasswordAccess
  recipients: Uint8Array[]
  /** EncryptMetadata of the document's file (as opened, or as last saved to it). */
  encryptMetadata: boolean
  /** The encryption of the document's file: /V, cipher and key length (V5 AES-256 once saved to it). */
  source: { version: number; cipher: PubSecCipher; keyBits: number }
  /** What outputs are written with: the original seed and envelopes, V5, EncryptMetadata true. */
  writeKey: PubSecWriteKey
  /** 'bridge': MuPDF holds the document as Standard R6 around K; 'decrypted': as a plain document. */
  route: 'bridge' | 'decrypted'
  /** The bridge's one-time passwords and its /U and /O (null for 'decrypted'). */
  bridge: { userPassword: string; ownerPassword: string; U: Uint8Array; O: Uint8Array } | null
}

const NO_METADATA = Uint8Array.of(0xff, 0xff, 0xff, 0xff)

/**
 * The file key (ISO 32000-2, 7.6.5.3): SHA-256 for V5, SHA-1 truncated to the key length before,
 * over the seed, every /Recipients entry as written, and FF FF FF FF when metadata is in clear.
 */
export function fileKey(info: Pick<PubSecInfo, 'version' | 'recipients' | 'encryptMetadata' | 'keyLength'>, seed: Uint8Array): Uint8Array {
  const data = concat([seed, ...info.recipients, ...(info.encryptMetadata ? [] : [NO_METADATA])])
  return info.version >= 5 ? sha256(data) : sha1(data).slice(0, info.keyLength)
}

/** The V5 file key of new or saved-back output. */
export function pubsecFileKey(seed: Uint8Array, recipients: Uint8Array[], encryptMetadata = true): Uint8Array {
  return fileKey({ version: 5, recipients, encryptMetadata, keyLength: 32 }, seed)
}

/** The write key for `seed` and `recipients` (EncryptMetadata true unless asked otherwise). */
export function writeKeyFor(seed: Uint8Array, recipients: Uint8Array[], encryptMetadata = true): PubSecWriteKey {
  const r = recipients.map((x) => x.slice())
  return { seed: seed.slice(), recipients: r, fileKey: pubsecFileKey(seed, r, encryptMetadata), encryptMetadata }
}

/** The key of one object: K itself for V5, else MD5(K, num, gen[, "sAlT"]) (algorithm 1). */
function objectKey(K: Uint8Array, cipher: PubSecCipher, num: number, gen: number): Uint8Array {
  if (cipher === 'AESV3') return K
  const parts = [K, Uint8Array.of(num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255)]
  if (cipher === 'AESV2') parts.push(latin1('sAlT'))
  return md5(concat(parts)).slice(0, Math.min(K.length + 5, 16))
}

/** Decrypts one string or stream. AES data is a 16-byte IV then CBC with PKCS#7 padding; bad padding is kept, as readers do. */
function decryptData(key: Uint8Array, cipher: PubSecCipher, data: Uint8Array): Uint8Array {
  if (cipher === 'RC4') return rc4(key, data)
  const blocks = Math.floor((data.length - 16) / 16)
  if (blocks <= 0) return new Uint8Array(0)
  const plain = aesCbcDecryptNoPad(key, data.subarray(0, 16), data.subarray(16, 16 + blocks * 16))
  const n = pkcs7Length(plain)
  return n >= 0 ? plain.subarray(0, n) : plain
}

/** Appends an update section: `objects` as PDF source, and the trailer with `edits` (undefined removes a key). */
export function appendUpdate(
  bytes: Uint8Array,
  info: PubSecInfo,
  objects: { num: number; gen: number; source: string }[],
  edits: Record<string, PdfValue | undefined> = {}
): Uint8Array {
  const last = bytes[bytes.length - 1]
  const base = last === 10 || last === 13 ? bytes : concat([bytes, latin1('\n')])
  let body = ''
  let xref = 'xref\n0 1\n0000000000 65535 f\r\n'
  let size = info.trailer.size
  for (const o of [...objects].sort((a, b) => a.num - b.num)) {
    const at = base.length + body.length
    body += `${o.num} ${o.gen} obj\n${o.source}\nendobj\n`
    xref += `${o.num} 1\n${String(at).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n\r\n`
    size = Math.max(size, o.num + 1)
  }
  const trailer: PdfDict = new Map()
  trailer.set('Size', size)
  if (info.trailer.root !== null) trailer.set('Root', info.trailer.root)
  if (info.trailer.info !== null) trailer.set('Info', info.trailer.info)
  if (info.trailer.id !== null) trailer.set('ID', info.trailer.id)
  trailer.set('Encrypt', info.encryptRef ?? info.encryptDict)
  for (const [k, v] of Object.entries(edits)) {
    if (v === undefined) trailer.delete(k)
    else trailer.set(k, v)
  }
  trailer.set('Prev', info.trailer.prev)
  const xrefAt = base.length + body.length
  // Object sources are ASCII (hex strings), so string length is byte length.
  return concat([base, latin1(`${body}${xref}trailer\n${serialise(trailer)}\nstartxref\n${xrefAt}\n%%EOF\n`)])
}

export interface Bridge {
  bytes: Uint8Array
  userPassword: string
  ownerPassword: string
  U: Uint8Array
  O: Uint8Array
}

/**
 * V5: the file with an update that redefines its encryption dictionary as Standard R6 around `K`.
 * A direct /Encrypt dictionary gets a new object. `standardP` (/P) is what the user password gives.
 */
export function bridgeV5(bytes: Uint8Array, info: PubSecInfo, K: Uint8Array, standardP: number): Bridge {
  const userPassword = oneTimePassword()
  const ownerPassword = oneTimePassword()
  const std = standardR6Dict(K, userPassword, ownerPassword, { permissions: standardP, encryptMetadata: info.encryptMetadata })
  let out: Uint8Array
  if (info.encryptRef) {
    out = appendUpdate(bytes, info, [{ num: info.encryptRef.num, gen: info.encryptRef.gen, source: std.source }])
  } else {
    const num = Math.max(1, info.trailer.size)
    out = appendUpdate(bytes, info, [{ num, gen: 0, source: std.source }], { Encrypt: new PdfRef(num, 0) })
  }
  return { bytes: out, userPassword, ownerPassword, U: std.U, O: std.O }
}

/** V2/V4 (and V5 without encrypted metadata): the file with an update whose trailer has no /Encrypt. */
export function neutralise(bytes: Uint8Array, info: PubSecInfo): Uint8Array {
  return appendUpdate(bytes, info, [], { Encrypt: undefined })
}

/** Stream data the document key does not apply to, from the raw dictionary. */
function exemptStream(dict: PdfDict, encryptMetadata: boolean): boolean {
  const type = asName(dict.get('Type'))
  if (type === 'XRef' || (type === 'Metadata' && !encryptMetadata)) return true
  const f = dict.get('Filter')
  return (Array.isArray(f) ? f : [f]).some((x) => asName(x) === 'Crypt')
}

/** Most of the bytes are text (content streams, XMP): what plaintext looks like, unlike RC4 noise. */
function looksLikeText(data: Uint8Array): boolean {
  let text = 0
  for (const c of data) if (c === 9 || c === 10 || c === 12 || c === 13 || (c >= 32 && c < 127)) text++
  return text >= data.length * 0.75
}

/**
 * Cheap check that K is right, before anything is opened. Looks at up to 8 streams that tell, and
 * accepts when most of them pass (files with no suitable stream pass):
 * - AES: the data must end in valid PKCS#7 padding, which a wrong key gives 1 time in 256.
 * - RC4: a Flate stream must start with a zlib header (a wrong key gives one about 1 time in 500),
 *   and an unfiltered stream that reads as text passes. Unfiltered binary data (images, fonts...)
 *   is binary with the right key too, so it does not tell: it only decides against the key when
 *   no stream told (a wrong key turns text into binary).
 */
export function verifyFileKey(bytes: Uint8Array, info: PubSecInfo, K: Uint8Array): boolean {
  let good = 0
  let bad = 0
  let binary = 0
  // Objects whose data overlaps, or that do not parse (each read to the end of the file), must not
  // make the walk quadratic in a hostile file: every object read counts, parsed or not.
  const meter: ReadMeter = { scanned: 0 }
  const budget = readBudget(bytes)
  for (const [num, e] of info.xref.entries) {
    if (good + bad >= 8 || meter.scanned > budget) break
    if (e.type !== 1 || num === info.encryptRef?.num) continue
    const obj = objectAt(bytes, info.xref, num, 0, meter)
    if (!obj) continue
    if (!obj.stream || exemptStream(obj.stream.dict, info.encryptMetadata)) continue
    const data = bytes.subarray(obj.stream.start, obj.stream.end)
    const key = objectKey(K, info.cipher, num, e.gen)
    if (info.cipher === 'RC4') {
      const filter = obj.stream.dict.get('Filter')
      const first = Array.isArray(filter) ? filter[0] : filter
      if (asName(first) === 'FlateDecode' && data.length >= 2) {
        const [cmf, flg] = rc4(key, data.subarray(0, 2))
        if ((cmf & 0x0f) === 8 && (cmf * 256 + flg) % 31 === 0) good++
        else bad++
      } else if ((first === undefined || first === null) && data.length >= 16) {
        if (looksLikeText(rc4(key, data.subarray(0, 256)))) good++
        else binary++
      }
    } else {
      if (data.length < 32 || data.length % 16) continue
      const last = aesCbcDecryptNoPad(key, data.subarray(data.length - 32, data.length - 16), data.subarray(data.length - 16))
      if (pkcs7Length(last) >= 0) good++
      else bad++
    }
  }
  return good + bad > 0 ? bad <= good : binary === 0
}

export interface DecryptStats {
  objectStreams: number
  streams: number
  strings: number
}

/**
 * Decrypts, in `doc` (opened from neutralise()), every string and stream encrypted with K. Object
 * streams first, so nothing inside them is parsed before it is plaintext; their members (known from
 * the file's own cross-reference data, never by scanning) hold no separately encrypted strings.
 * Skipped: the encryption dictionary, xref streams, signature /Contents, streams with their own
 * /Crypt filter, and /Type /Metadata streams when EncryptMetadata is false.
 */
export function decryptAll(doc: PDFDocument, info: PubSecInfo, K: Uint8Array, xref: Xref = info.xref): DecryptStats {
  const stats: DecryptStats = { objectStreams: 0, streams: 0, strings: 0 }
  const entries = xref.entries
  const objectStreams = new Set<number>()
  for (const e of entries.values()) if (e.type === 2) objectStreams.add(e.stream)
  const decrypt = (num: number, gen: number, data: Uint8Array) => decryptData(objectKey(K, info.cipher, num, gen), info.cipher, data)
  for (const num of objectStreams) {
    const e = entries.get(num)
    if (e?.type !== 1) continue
    const ref = doc.newIndirect(num)
    if (!ref.isStream()) continue
    ref.writeRawStream(decrypt(num, e.gen, rawStream(ref)))
    stats.objectStreams++
  }
  for (const [num, e] of entries) {
    if (e.type !== 1 || num === 0 || num === info.encryptRef?.num || objectStreams.has(num)) continue
    const ref = doc.newIndirect(num)
    const obj = ref.resolve()
    if (obj.isNull()) continue
    if (obj.isString()) {
      ref.writeObject(doc.newByteString(decrypt(num, e.gen, obj.asByteString())))
      stats.strings++
      continue
    }
    if (ref.isStream()) {
      const type = obj.get('Type')
      if (isNamed(type, 'XRef')) continue
      if (!(isNamed(type, 'Metadata') && !info.encryptMetadata) && !hasCryptFilter(obj)) {
        ref.writeRawStream(decrypt(num, e.gen, rawStream(ref)))
        stats.streams++
      }
    }
    if (obj.isArray() || obj.isDictionary()) {
      for (const [container, key, data] of collectStrings(obj)) {
        container.put(key, doc.newByteString(decrypt(num, e.gen, data)))
        stats.strings++
      }
    }
  }
  return stats
}

/**
 * Opens a certificate-encrypted file with `key`: the bridge for V5 with EncryptMetadata true, the
 * decrypt pass otherwise. Throws CERTIFICATE_KEY_MISMATCH when the key's envelope is not among the
 * file's /Recipients or its seed does not give the file key, and CERTIFICATE_OPEN_FAILED when the
 * result is not a usable document (no pages, or MuPDF had to repair it).
 */
export function openPubSec(m: Mupdf, bytes: Uint8Array, info: PubSecInfo, key: CertificateKey): { doc: PDFDocument; state: PubSecState } {
  if (!info.recipients.some((r) => bytesEqual(r, key.envelope))) {
    throw new EngineError('This certificate is not one of the document’s recipients', 'CERTIFICATE_KEY_MISMATCH')
  }
  const K = fileKey(info, key.seed)
  if (!verifyFileKey(bytes, info, K)) {
    throw new EngineError('This certificate key does not open the document', 'CERTIFICATE_KEY_MISMATCH')
  }
  const perms = certificatePermissions(key.permissions)
  let doc: PDFDocument | null = null
  let bridge: PubSecState['bridge'] = null
  try {
    if (info.version >= 5 && info.encryptMetadata) {
      const b = bridgeV5(bytes, info, K, perms.standardP)
      doc = new m.PDFDocument(b.bytes)
      if (!doc.needsPassword() || !doc.authenticatePassword(b.userPassword)) throw new Error('the key was refused')
      bridge = { userPassword: b.userPassword, ownerPassword: b.ownerPassword, U: b.U, O: b.O }
    } else {
      doc = new m.PDFDocument(neutralise(bytes, info))
      decryptAll(doc, info, K)
    }
    if (doc.countPages() < 1) throw new Error('it has no pages')
    if (doc.wasRepaired()) throw new Error('it is damaged')
  } catch (err) {
    try {
      doc?.destroy()
    } catch {}
    const reason = err instanceof Error ? err.message : String(err)
    throw new EngineError(`This certificate-encrypted document could not be opened: ${reason}`, 'CERTIFICATE_OPEN_FAILED')
  }
  const recipients = info.recipients.map((r) => r.slice())
  const state: PubSecState = {
    key: { envelope: key.envelope.slice(), seed: key.seed.slice(), permissions: key.permissions },
    seed: key.seed.slice(),
    permissions: key.permissions,
    access: perms.access,
    recipients,
    encryptMetadata: info.encryptMetadata,
    source: { version: info.version, cipher: info.cipher, keyBits: info.keyLength * 8 },
    writeKey: writeKeyFor(key.seed, recipients),
    route: bridge ? 'bridge' : 'decrypted',
    bridge
  }
  return { doc, state }
}

/**
 * Opens the file with the first of `keys` that belongs to it, or returns null when none does.
 * A key that belongs to it but finds the file unusable throws CERTIFICATE_OPEN_FAILED.
 */
export function openWithKeys(
  m: Mupdf,
  bytes: Uint8Array,
  info: PubSecInfo,
  keys: CertificateKey[]
): { doc: PDFDocument; state: PubSecState } | null {
  for (const key of keys) {
    try {
      return openPubSec(m, bytes, info, key)
    } catch (err) {
      if ((err as EngineError).code !== 'CERTIFICATE_KEY_MISMATCH') throw err
    }
  }
  return null
}

/** True when one of `keys` belongs to the file and gives its file key (nothing is opened). */
export function keysOpen(bytes: Uint8Array, info: PubSecInfo, keys: CertificateKey[]): boolean {
  return keys.some((k) => info.recipients.some((r) => bytesEqual(r, k.envelope)) && verifyFileKey(bytes, info, fileKey(info, k.seed)))
}
