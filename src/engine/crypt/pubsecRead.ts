// Reading the public-key security handler (/Filter /Adobe.PubSec) of a file MuPDF refuses to
// open: what it encrypts with, the /Recipients envelopes, and the trailer facts needed to append an
// update section (pubsecBridge.ts). ISO 32000-2, 7.6.5 and tables 20, 23 and 25.
import { PUBSEC_RECIPIENT_LIMITS, type CertificateLock } from '@shared/certkeys'
import { EngineError } from '../define'
import {
  asDict,
  asName,
  asNumber,
  isPdfBytes,
  objectAt,
  PdfRef,
  PdfString,
  readXref,
  resolve,
  type PdfDict,
  type PdfValue,
  type Xref
} from './pdfLex'

export type PubSecCipher = 'RC4' | 'AESV2' | 'AESV3'

export interface PubSecInfo {
  /** /V of the encryption dictionary: 1, 2, 4 or 5. */
  version: number
  subFilter: string | null
  /** How strings and streams are encrypted (the stream crypt filter's /CFM from V4 on). */
  cipher: PubSecCipher
  /** File key length in bytes. */
  keyLength: number
  /** The /Recipients entries (DER CMS ContentInfo), in file order. */
  recipients: Uint8Array[]
  encryptMetadata: boolean
  /** The encryption dictionary's object, or null when it is a direct dictionary in the trailer. */
  encryptRef: PdfRef | null
  encryptDict: PdfDict
  /** The file's cross-reference data (also used by the decrypt pass). */
  xref: Xref
  /** What an appended update section needs from the newest trailer. */
  trailer: {
    size: number
    root: PdfValue
    info: PdfValue
    id: PdfValue
    /** Offset of the newest cross-reference section, for /Prev. */
    prev: number
  }
}

/** The first of the trailers (newest first) that has `key`. */
function fromTrailers(xref: Xref, key: string): PdfValue {
  for (const t of xref.trailers) if (t.has(key)) return t.get(key) ?? null
  return null
}

/** /Length of a crypt filter or the handler: bits from 40 up, but some writers give bytes. */
function lengthBytes(v: PdfValue): number | null {
  const n = asNumber(v)
  if (n === null || n <= 0) return null
  return n <= 32 ? Math.round(n) : Math.round(n / 8)
}

/** A file whose /Recipients are over PUBSEC_RECIPIENT_LIMITS (the main process would refuse them). */
export function tooManyRecipients(): EngineError {
  return new EngineError(
    'This certificate-encrypted document has more recipients than Fartcrobat can read ' +
      `(at most ${PUBSEC_RECIPIENT_LIMITS.envelopes} envelopes and ${PUBSEC_RECIPIENT_LIMITS.totalBytes / 1024 / 1024} MB).`,
    'CERTIFICATE_UNSUPPORTED'
  )
}

function stringsOf(b: Uint8Array, xref: Xref, v: PdfValue): Uint8Array[] {
  const value = resolve(b, xref, v)
  const items = Array.isArray(value) ? value : [value]
  const out: Uint8Array[] = []
  let total = 0
  for (const item of items) {
    const s = resolve(b, xref, item)
    if (!(s instanceof PdfString)) continue
    total += s.bytes.length
    if (
      out.length >= PUBSEC_RECIPIENT_LIMITS.envelopes ||
      s.bytes.length > PUBSEC_RECIPIENT_LIMITS.envelopeBytes ||
      total > PUBSEC_RECIPIENT_LIMITS.totalBytes
    )
      throw tooManyRecipients()
    out.push(s.bytes)
  }
  return out
}

/**
 * The public-key security of a file, or null when the newest trailer has no /Encrypt, the handler
 * is not Adobe.PubSec, or its encryption cannot be understood (MuPDF then reports the file itself).
 * Throws CERTIFICATE_UNSUPPORTED (tooManyRecipients) when its /Recipients are over
 * PUBSEC_RECIPIENT_LIMITS.
 */
export function readPubSec(bytes: Uint8Array): PubSecInfo | null {
  if (!isPdfBytes(bytes)) return null
  const xref = readXref(bytes)
  const enc = xref.trailer.get('Encrypt')
  if (enc === undefined || enc === null) return null
  // The encryption dictionary is never inside an object stream (ISO 32000-2, 7.5.7).
  const encryptRef = enc instanceof PdfRef ? enc : null
  const dict = asDict(encryptRef ? objectAt(bytes, xref, encryptRef.num)?.value : enc)
  if (!dict || asName(dict.get('Filter')) !== 'Adobe.PubSec') return null
  const get = (d: PdfDict | null, key: string) => (d ? resolve(bytes, xref, d.get(key)) : null)
  const version = asNumber(get(dict, 'V')) ?? 0
  let cipher: PubSecCipher
  let keyLength: number
  let recipients = stringsOf(bytes, xref, dict.get('Recipients') ?? null)
  let encryptMetadata = get(dict, 'EncryptMetadata')
  if (version >= 4) {
    const filters = asDict(get(dict, 'CF'))
    const cf = asDict(filters ? resolve(bytes, xref, filters.get(asName(get(dict, 'StmF')) ?? 'Identity')) : null)
    if (!cf) return null
    const cfm = asName(get(cf, 'CFM'))
    if (cfm === 'AESV3' || (version >= 5 && cfm === null)) {
      cipher = 'AESV3'
      keyLength = 32
    } else if (cfm === 'AESV2') {
      cipher = 'AESV2'
      keyLength = 16
    } else if (cfm === 'V2') {
      cipher = 'RC4'
      keyLength = lengthBytes(get(cf, 'Length')) ?? lengthBytes(get(dict, 'Length')) ?? 5
    } else {
      return null
    }
    const own = stringsOf(bytes, xref, cf.get('Recipients') ?? null)
    if (own.length) recipients = own
    const em = get(cf, 'EncryptMetadata')
    if (typeof em === 'boolean') encryptMetadata = em
  } else if (version === 1 || version === 2 || version === 3) {
    cipher = 'RC4'
    keyLength = version === 1 ? 5 : (lengthBytes(get(dict, 'Length')) ?? 5)
  } else {
    return null
  }
  if (version >= 5) keyLength = 32
  else keyLength = Math.max(5, Math.min(16, keyLength))
  if (!recipients.length) return null
  return {
    version,
    subFilter: asName(get(dict, 'SubFilter')),
    cipher,
    keyLength,
    recipients,
    encryptMetadata: encryptMetadata !== false,
    encryptRef,
    encryptDict: dict,
    xref,
    trailer: {
      size: Math.max(0, ...xref.trailers.map((t) => asNumber(t.get('Size')) ?? 0)),
      root: fromTrailers(xref, 'Root'),
      info: fromTrailers(xref, 'Info'),
      id: fromTrailers(xref, 'ID'),
      prev: xref.startxref
    }
  }
}

/** What the renderer is told about a certificate-encrypted file (public data only). */
export function certificateLockOf(info: Pick<PubSecInfo, 'recipients' | 'version' | 'cipher' | 'keyLength'>): CertificateLock {
  return {
    recipients: info.recipients.map((r) => r.slice()),
    version: info.version,
    cipher: info.cipher,
    keyBits: info.keyLength * 8
  }
}
