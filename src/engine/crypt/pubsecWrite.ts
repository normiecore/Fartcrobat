// Writing certificate-encrypted files ("encrypt in place"): make a decrypted full save of a copy of
// the document, encrypt every string and stream of it with the file key ourselves, and serialise
// it with a V5 /Adobe.PubSec encryption dictionary. Saving back uses the original seed and
// envelopes, so the same people open the result with the same keys; no private key is needed.
//
// Why not MuPDF's writer: it leaves empty strings unencrypted and mishandles EncryptMetadata false;
// for a document it did not open as encrypted it writes an /Encrypt we add as "0 0 R"; and its
// compression options would recompress data that is already encrypted.
import { EngineError } from '../define'
import type { Mupdf, PDFDocument, Session } from '../session'
import { writePdf, type WrittenObject } from '../util/pdfWriter'
import { collectStrings, hasCryptFilter, isNamed, rawStream } from './objects'
import { indexOfBytes, lastTrailer } from './pdfLex'
import { aesCbcEncrypt, bytesEqual, concat, randomBytes, toHex, toLatin1 } from './primitives'
import type { PubSecState, PubSecWriteKey } from './pubsecBridge'
import { readPubSec } from './pubsecRead'

function takeBuffer(buf: InstanceType<Mupdf['Buffer']>): Uint8Array {
  try {
    return buf.asUint8Array().slice()
  } finally {
    buf.destroy()
  }
}

export interface EncryptStats {
  objects: number
  strings: number
  streams: number
  skippedStreams: number
}

/**
 * Encrypts, in `doc` itself, every string (empty ones too) and every stream's raw (still
 * filtered) data with `fileKey`: AES-256-CBC with a random IV in front (AESV3). Exempt: signature
 * /Contents, streams with their own /Crypt filter, and /Type /Metadata streams when
 * `encryptMetadata` is false. `doc` must come from a plain full save with garbage=compact (no
 * object streams, no xref streams, no encryption, generation numbers 0).
 */
export function encryptObjectsInPlace(doc: PDFDocument, fileKey: Uint8Array, encryptMetadata = true): EncryptStats {
  const enc = (data: Uint8Array) => {
    const iv = randomBytes(16)
    return concat([iv, aesCbcEncrypt(fileKey, iv, data)])
  }
  const stats: EncryptStats = { objects: 0, strings: 0, streams: 0, skippedStreams: 0 }
  const n = doc.countObjects()
  for (let i = 1; i < n; i++) {
    const ref = doc.newIndirect(i)
    const obj = ref.resolve()
    if (obj.isNull()) continue
    stats.objects++
    if (obj.isString()) {
      ref.writeObject(doc.newByteString(enc(obj.asByteString())))
      stats.strings++
      continue
    }
    // isStream() has to be asked of the reference: a resolved stream is just its dictionary.
    if (ref.isStream()) {
      const type = obj.get('Type')
      if (isNamed(type, 'XRef') || isNamed(type, 'ObjStm')) throw new Error('Object streams must be removed before encrypting')
      if ((!encryptMetadata && isNamed(type, 'Metadata')) || hasCryptFilter(obj)) {
        stats.skippedStreams++
      } else {
        ref.writeRawStream(enc(rawStream(ref)))
        stats.streams++
      }
    }
    if (obj.isArray() || obj.isDictionary()) {
      for (const [container, key, bytes] of collectStrings(obj)) {
        container.put(key, doc.newByteString(enc(bytes)))
        stats.strings++
      }
    }
  }
  return stats
}

/** The /Encrypt dictionary of certificate-encrypted output (V5, AES-256), as PDF source. */
export function pubsecEncryptDict(recipients: Uint8Array[], encryptMetadata = true): string {
  const em = encryptMetadata ? 'true' : 'false'
  return (
    `<</Filter/Adobe.PubSec/SubFilter/adbe.pkcs7.s5/V 5/Length 256` +
    `/CF<</DefaultCryptFilter<</Type/CryptFilter/CFM/AESV3/AuthEvent/DocOpen/Length 256` +
    `/Recipients[${recipients.map((r) => `<${toHex(r)}>`).join('')}]/EncryptMetadata ${em}>>>>` +
    `/StmF/DefaultCryptFilter/StrF/DefaultCryptFilter/EncryptMetadata ${em}>>`
  )
}

/**
 * Writes `doc` object by object (raw stream data as it is, no recompression) and appends
 * `encryptDict` as the /Encrypt object, whose strings are therefore never encrypted. Keeps /ID[0].
 */
export function serialiseEncrypted(doc: PDFDocument, encryptDict: string): Uint8Array {
  const n = doc.countObjects()
  const objects: WrittenObject[] = [undefined]
  for (let i = 1; i < n; i++) {
    const ref = doc.newIndirect(i)
    const obj = ref.resolve()
    if (obj.isNull()) objects.push(undefined)
    else if (ref.isStream()) {
      const raw = rawStream(ref)
      obj.put('Length', raw.length)
      objects.push({ dict: obj.toString(true, true), stream: raw })
    } else objects.push({ body: obj.toString(true, true) })
  }
  objects.push({ body: encryptDict })
  const t = doc.getTrailer()
  const info = t.get('Info')
  const id = t.get('ID')
  const id0 = id.isArray() && id.length === 2 ? toHex(id.get(0).asByteString()) : toHex(randomBytes(16))
  const trailer =
    `<</Size ${objects.length}/Root ${t.get('Root').toString()}${info.isNull() ? '' : `/Info ${info.toString()}`}` +
    `/Encrypt ${objects.length - 1} 0 R/ID[<${id0}><${toHex(randomBytes(16))}>]>>`
  return writePdf(doc.getVersion() >= 20 ? '2.0' : '1.7', objects, trailer)
}

/** Options that would break encrypting in place (or that set security themselves). */
const REFUSED_OPTIONS = /^(objstms|linearize|incremental|encrypt|user-password|owner-password|permissions)\b/

/** `options` with garbage=compact at least (deduplicate is kept), for the plain pass. */
export function plainSaveOptions(options = ''): string {
  const parts = options
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  for (const p of parts) {
    if (REFUSED_OPTIONS.test(p)) throw new EngineError(`The save option “${p}” cannot be used with certificate security`, 'BAD_SAVE')
  }
  const dedupe = parts.some((p) => /^garbage=(deduplicate|3|4)$/.test(p))
  return [dedupe ? 'garbage=deduplicate' : 'garbage=compact', ...parts.filter((p) => !p.startsWith('garbage'))].join(',')
}

/**
 * A decrypted full save of a copy of `src` (which is not changed): its current content, saved with
 * `options` (no security options), without encryption. `password` opens `src` when it needs one
 * (a password-protected document, or the bridge user password of a certificate-encrypted one).
 */
export function decryptedSave(m: Mupdf, src: PDFDocument, options: string, password: string | null): Uint8Array {
  if (/(^|,)\s*(encrypt|incremental|user-password|owner-password|permissions)\b/.test(options)) {
    throw new EngineError('A decrypted save cannot set security', 'BAD_SAVE')
  }
  // First pass: a plain save that keeps the current encryption and leaves the live document
  // untouched (saving with encrypt=none or compaction rewrites the live document).
  const copy = new m.PDFDocument(takeBuffer(src.saveToBuffer('garbage=yes')))
  try {
    const encrypted = !copy.getTrailer().get('Encrypt').isNull()
    if (copy.needsPassword() && !(password && copy.authenticatePassword(password))) {
      throw new EngineError('The document password is needed to save it', 'ENCRYPTED')
    }
    return takeBuffer(copy.saveToBuffer([options, encrypted ? 'encrypt=none' : ''].filter(Boolean).join(',')))
  } finally {
    copy.destroy()
  }
}

export interface PubSecWriteOptions {
  /** Plain-pass options such as "compress,clean"; garbage=compact is always added. */
  saveOptions?: string
  /** Opens `src` when it is encrypted (see decryptedSave). */
  password?: string | null
}

/**
 * The bytes of `src` (not modified) as a certificate-encrypted file with `key`: decrypted full
 * save of a copy, encrypt in place, serialise. Saving back: the session's writeKey; new security:
 * writeKeyFor(new seed, new envelopes).
 */
export function writePubSecDocument(m: Mupdf, src: PDFDocument, key: PubSecWriteKey, opts: PubSecWriteOptions = {}): Uint8Array {
  const plain = decryptedSave(m, src, plainSaveOptions(opts.saveOptions), opts.password ?? null)
  const doc = new m.PDFDocument(plain)
  try {
    if (!doc.getTrailer().get('Encrypt').isNull()) throw new EngineError('The document could not be decrypted', 'SAVE_FAILED')
    encryptObjectsInPlace(doc, key.fileKey, key.encryptMetadata)
    return serialiseEncrypted(doc, pubsecEncryptDict(key.recipients, key.encryptMetadata))
  } finally {
    doc.destroy()
  }
}

/** What an output of a certificate-encrypted session is meant to be. */
export type OutputKind = 'pubsec' | 'plain' | 'password'

/**
 * Refuses output of a certificate-encrypted session that carries the bridge: its /U or /O values
 * or one-time passwords, a Standard handler where certificate security belongs ('pubsec', the
 * default), or any encryption where none belongs ('plain'). Throws BRIDGE_LEAK.
 */
export function assertNoBridge(bytes: Uint8Array, state: PubSecState | null, kind: OutputKind = 'pubsec'): void {
  const refuse = (what: string) => {
    throw new EngineError(`The file was not saved: it would have contained ${what}`, 'BRIDGE_LEAK')
  }
  const text = toLatin1(bytes)
  const bridge = state?.bridge
  if (bridge) {
    for (const v of [bridge.U, bridge.O]) {
      const hex = toHex(v)
      if (indexOfBytes(bytes, v) >= 0 || text.includes(hex) || text.includes(hex.toUpperCase())) refuse('temporary security data')
    }
    if (text.includes(bridge.userPassword) || text.includes(bridge.ownerPassword)) refuse('a temporary password')
  }
  if (kind === 'pubsec' && /\/Filter\s*\/Standard(?![^\0\t\n\f\r ()<>[\]{}/%])/.test(text)) refuse('password security')
  if (kind === 'plain') {
    let encrypted = true
    try {
      encrypted = lastTrailer(bytes).dict.has('Encrypt')
    } catch {}
    if (encrypted) refuse('encryption')
  }
}

/**
 * An output of a certificate-encrypted session that must keep its protection (Extract, Split...):
 * certificate-encrypted with the session's own envelopes, and without the bridge. Throws
 * PROTECT_FAILED otherwise, so such output never reaches the disk or a tab unprotected.
 */
export function assertCertificateOutput(bytes: Uint8Array, state: PubSecState): void {
  let info: ReturnType<typeof readPubSec> = null
  try {
    info = readPubSec(bytes)
  } catch {}
  const mine = state.writeKey.recipients
  if (!info || info.recipients.length !== mine.length || !info.recipients.every((r, i) => bytesEqual(r, mine[i]))) {
    throw new EngineError('Could not keep the certificate security on the new file', 'PROTECT_FAILED')
  }
  assertNoBridge(bytes, state)
}

/** The password MuPDF needs to read the session's document: the bridge's, or the document's own. */
export function sessionReadPassword(s: Session): string | null {
  return s.pubsec ? (s.pubsec.bridge?.userPassword ?? null) : s.password
}

/**
 * Plain (decrypted) bytes of the session's document with its unsaved changes, for any document:
 * plain, password-protected or certificate-encrypted. Never write them anywhere unprotected
 * unless that is what was asked (Remove Security).
 */
export function plainSessionBytes(s: Session, options = 'garbage=compact'): Uint8Array {
  return decryptedSave(s.mupdf, s.pdf, options, sessionReadPassword(s))
}

/** A decrypted working copy of the session's document (the caller destroys it). */
export function openPlainSessionCopy(s: Session, options = 'garbage=compact'): PDFDocument {
  return new s.mupdf.PDFDocument(plainSessionBytes(s, options))
}

/**
 * The session's certificate-encrypted document saved back with its own seed and envelopes
 * (always V5, AES-256), checked by assertNoBridge.
 */
export function writeSessionPubSec(s: Session, saveOptions?: string): Uint8Array {
  const state = s.pubsec
  if (!state) throw new EngineError('The document is not certificate-encrypted', 'BAD_STATE')
  const bytes = writePubSecDocument(s.mupdf, s.pdf, state.writeKey, { saveOptions, password: sessionReadPassword(s) })
  assertNoBridge(bytes, state)
  return bytes
}
