/**
 * Reading CMS EnvelopedData (RFC 5652), the /Recipients entries of certificate-encrypted PDFs
 * (/Filter /Adobe.PubSec). Pure: no Node APIs, so the main process, the engine worker and the
 * renderer can all use it. Nothing here decrypts; the key sources in src/main/certkeys/ do that.
 *
 *   ContentInfo { contentType envelopedData, [0] EXPLICIT EnvelopedData }
 *   EnvelopedData { version, [0] originatorInfo OPTIONAL, recipientInfos SET, encryptedContentInfo,
 *                   [1] unprotectedAttrs OPTIONAL }
 *   RecipientInfo: KeyTransRecipientInfo (a SEQUENCE: RSA), [1] KeyAgreeRecipientInfo (ECDH),
 *                  [2] KEK, [3] password, [4] other
 *
 * PDF readers name a recipient's certificate by issuer and serial number, or by subject key
 * identifier. Issuer names are compared as DER bytes, never as text.
 *
 * SHA-1 comes from node-forge, not @noble/hashes: this module is in the main-process bundle, and
 * electron-vite's ESM shim (which defines __dirname there) is inserted after the last `import` it
 * finds by text, which can be one in @noble's doc comments (see main-bundle.test.ts).
 */
import forge from 'node-forge'
import {
  Asn1Error,
  bytesEqual,
  contentOf,
  expectUniversal,
  isContext,
  isUniversal,
  parseAsn1,
  rawOf,
  readBitString,
  readOid,
  readSmallInt,
  readString,
  TAG,
  toHex,
  type Asn1Node
} from './asn1'
import type { PubSecRecipient } from '@shared/certkeys'
import { DN_SHORT } from './oids'
import type { Certificate } from './x509'

export const ENVELOPE_OID = {
  envelopedData: '1.2.840.113549.1.7.3',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsaesOaep: '1.2.840.113549.1.1.7',
  mgf1: '1.2.840.113549.1.1.8',
  pSpecified: '1.2.840.113549.1.1.9',
  aes128Cbc: '2.16.840.1.101.3.4.1.2',
  aes192Cbc: '2.16.840.1.101.3.4.1.22',
  aes256Cbc: '2.16.840.1.101.3.4.1.42',
  desEde3Cbc: '1.2.840.113549.3.7',
  rc2Cbc: '1.2.840.113549.3.2',
  sha1: '1.3.14.3.2.26',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha512: '2.16.840.1.101.3.4.2.3'
} as const

/** How a RecipientInfo names the recipient's certificate. */
export type RecipientId =
  /** issuerAndSerialNumber: the issuer Name (DER, exactly as encoded) and the serial INTEGER's content bytes. */
  | { issuer: Uint8Array; serial: Uint8Array }
  /** subjectKeyIdentifier. */
  | { ski: Uint8Array }

export interface AlgorithmId {
  oid: string
  /** The parameters' DER, or null when absent. */
  params: Uint8Array | null
}

export interface EnvelopeRecipient {
  /** Position of the RecipientInfo in the envelope's recipientInfos. */
  index: number
  /** Key transport (RSA), key agreement (ECDH) or anything else (KEK, password, unknown). */
  kind: 'ktri' | 'kari' | 'other'
  /** Null for 'other'. */
  rid: RecipientId | null
  keyEncryption: AlgorithmId
  encryptedKey: Uint8Array
}

export interface ParsedEnvelope {
  /** One entry per RecipientInfo; a key agreement RecipientInfo gives one per recipient key. */
  recipientInfos: EnvelopeRecipient[]
  contentEncryption: AlgorithmId
  encryptedContent: Uint8Array
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvelopeError'
  }
}

function algorithm(node: Asn1Node | undefined, what: string): AlgorithmId {
  const seq = expectUniversal(node, TAG.SEQUENCE, what)
  const oidNode = expectUniversal(seq.children[0], TAG.OID, what)
  return { oid: readOid(oidNode), params: seq.children[1] ? rawOf(seq.children[1]).slice() : null }
}

/** issuerAndSerialNumber (a SEQUENCE) or subjectKeyIdentifier ([0] IMPLICIT OCTET STRING). */
function recipientId(node: Asn1Node | undefined): RecipientId {
  if (isUniversal(node, TAG.SEQUENCE)) {
    const name = expectUniversal(node!.children[0], TAG.SEQUENCE, 'recipient issuer')
    const serial = expectUniversal(node!.children[1], TAG.INTEGER, 'recipient serial number')
    return { issuer: rawOf(name).slice(), serial: contentOf(serial).slice() }
  }
  if (isContext(node, 0)) return { ski: contentOf(node!).slice() }
  throw new EnvelopeError('Malformed recipient identifier')
}

function keyTrans(ri: Asn1Node, index: number): EnvelopeRecipient {
  const [version, rid, alg, key] = ri.children
  expectUniversal(version, TAG.INTEGER, 'recipient version')
  return {
    index,
    kind: 'ktri',
    rid: recipientId(rid),
    keyEncryption: algorithm(alg, 'key encryption algorithm'),
    encryptedKey: contentOf(expectUniversal(key, TAG.OCTET_STRING, 'encrypted key')).slice()
  }
}

/** KeyAgreeRecipientInfo: version, [0] originator, [1] ukm OPTIONAL, algorithm, recipientEncryptedKeys. */
function keyAgree(ri: Asn1Node, index: number): EnvelopeRecipient[] {
  const kids = ri.children
  expectUniversal(kids[0], TAG.INTEGER, 'recipient version')
  if (!isContext(kids[1], 0)) throw new EnvelopeError('Malformed key agreement recipient')
  let i = 2
  if (isContext(kids[i], 1)) i++
  const keyEncryption = algorithm(kids[i++], 'key agreement algorithm')
  const keys = expectUniversal(kids[i], TAG.SEQUENCE, 'recipient encrypted keys')
  return keys.children.map((rek) => {
    expectUniversal(rek, TAG.SEQUENCE, 'recipient encrypted key')
    const [rid, key] = rek.children
    // KeyAgreeRecipientIdentifier: issuerAndSerialNumber, or [0] IMPLICIT RecipientKeyIdentifier
    // (a SEQUENCE starting with the subject key identifier).
    const id: RecipientId = isContext(rid, 0)
      ? {
          ski: contentOf(
            expectUniversal(rid.children[0], TAG.OCTET_STRING, 'recipient key identifier')
          ).slice()
        }
      : recipientId(rid)
    return {
      index,
      kind: 'kari' as const,
      rid: id,
      keyEncryption,
      encryptedKey: contentOf(expectUniversal(key, TAG.OCTET_STRING, 'encrypted key')).slice()
    }
  })
}

/** KEK, password and unknown recipients: kept so indexes match, never opened. */
function otherRecipient(ri: Asn1Node, index: number): EnvelopeRecipient {
  const kids = ri.constructed ? ri.children : []
  const alg =
    kids.length >= 2 && isUniversal(kids[kids.length - 2], TAG.SEQUENCE) ? kids[kids.length - 2] : undefined
  const key = kids[kids.length - 1]
  let keyEncryption: AlgorithmId = { oid: '', params: null }
  try {
    if (alg) keyEncryption = algorithm(alg, 'key encryption algorithm')
  } catch {}
  return {
    index,
    kind: 'other',
    rid: null,
    keyEncryption,
    encryptedKey: isUniversal(key, TAG.OCTET_STRING) ? contentOf(key).slice() : new Uint8Array()
  }
}

/** Reads one /Recipients entry (DER ContentInfo with EnvelopedData). Throws on malformed input. */
export function parseEnvelope(blob: Uint8Array): ParsedEnvelope {
  try {
    const ci = expectUniversal(parseAsn1(blob), TAG.SEQUENCE, 'content info')
    if (readOid(expectUniversal(ci.children[0], TAG.OID, 'content type')) !== ENVELOPE_OID.envelopedData)
      throw new EnvelopeError('Not an enveloped-data content info')
    if (!isContext(ci.children[1], 0)) throw new EnvelopeError('Missing enveloped data')
    const ed = expectUniversal(ci.children[1].children[0], TAG.SEQUENCE, 'enveloped data')
    const kids = ed.children
    expectUniversal(kids[0], TAG.INTEGER, 'enveloped data version')
    let i = 1
    if (isContext(kids[i], 0)) i++ // originatorInfo
    const infos = expectUniversal(kids[i++], TAG.SET, 'recipient infos')
    const eci = expectUniversal(kids[i], TAG.SEQUENCE, 'encrypted content info')
    expectUniversal(eci.children[0], TAG.OID, 'content type')
    const contentEncryption = algorithm(eci.children[1], 'content encryption algorithm')
    const content = eci.children[2]
    if (!isContext(content, 0)) throw new EnvelopeError('The envelope has no encrypted content')
    const recipientInfos: EnvelopeRecipient[] = []
    infos.children.forEach((ri, index) => {
      if (isUniversal(ri, TAG.SEQUENCE)) recipientInfos.push(keyTrans(ri, index))
      else if (isContext(ri, 1)) recipientInfos.push(...keyAgree(ri, index))
      else recipientInfos.push(otherRecipient(ri, index))
    })
    return { recipientInfos, contentEncryption, encryptedContent: contentOf(content).slice() }
  } catch (err) {
    if (err instanceof EnvelopeError) throw err
    throw new EnvelopeError(
      err instanceof Asn1Error ? `Damaged envelope: ${err.message}` : 'Damaged envelope'
    )
  }
}

// ---- describing recipients ---------------------------------------------------------------------

/** RFC 4514 escaping of an attribute value. */
function escapeValue(v: string): string {
  return v
    .replace(/[\\",+;<>]/g, (c) => `\\${c}`)
    .replace(/^[ #]/, (c) => `\\${c}`)
    .replace(/ $/, '\\ ')
}

/**
 * A Name (DER) as text, most specific first, as certificates show it elsewhere in the app
 * (DistinguishedName.text in ./x509): "CN=Contoso CA, O=Contoso". Values are RFC 4514-escaped.
 */
export function nameText(nameDer: Uint8Array): string {
  const node = parseAsn1(nameDer)
  const parts: string[] = []
  for (const rdn of node.children) {
    for (const atv of rdn.children) {
      const oid = readOid(atv.children[0])
      let value = ''
      try {
        value = readString(atv.children[1])
      } catch {}
      parts.push(`${DN_SHORT[oid] ?? oid}=${escapeValue(value)}`)
    }
  }
  return parts.reverse().join(', ')
}

/** Big-endian bytes without leading zero bytes (at least one byte stays). */
export function stripLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  return b.subarray(i)
}

function keyTypeOf(r: EnvelopeRecipient): PubSecRecipient['keyType'] {
  if (r.kind === 'kari') return 'ec'
  if (r.kind !== 'ktri') return 'other'
  if (r.keyEncryption.oid === ENVELOPE_OID.rsaEncryption) return 'rsa'
  if (r.keyEncryption.oid === ENVELOPE_OID.rsaesOaep) return 'rsa-oaep'
  return 'other'
}

/** Everyone the envelopes are for, as people are shown them. Damaged envelopes are skipped. */
export function summarizeRecipients(blobs: Uint8Array[]): PubSecRecipient[] {
  const out: PubSecRecipient[] = []
  blobs.forEach((blob, envelope) => {
    let parsed: ParsedEnvelope
    try {
      parsed = parseEnvelope(blob)
    } catch {
      return
    }
    for (const r of parsed.recipientInfos) {
      const item: PubSecRecipient = {
        envelope,
        index: r.index,
        idType:
          r.kind === 'kari'
            ? 'keyAgreement'
            : !r.rid
              ? 'other'
              : 'ski' in r.rid
                ? 'subjectKeyIdentifier'
                : 'issuerAndSerialNumber',
        keyType: keyTypeOf(r)
      }
      if (r.rid && 'ski' in r.rid) item.ski = toHex(r.rid.ski)
      else if (r.rid) {
        try {
          item.issuer = nameText(r.rid.issuer)
        } catch {}
        item.serial = toHex(stripLeadingZeros(r.rid.serial))
      }
      out.push(item)
    }
  })
  return out
}

// ---- matching certificates -------------------------------------------------------------------

/** The subjectPublicKey BIT STRING's bytes (without the unused-bits byte). */
function sha1(data: Uint8Array): Uint8Array {
  const md = forge.md.sha1.create()
  md.update(forge.util.binary.raw.encode(data))
  return forge.util.binary.raw.decode(md.digest().getBytes())
}

function subjectPublicKeyBits(cert: Certificate): Uint8Array | null {
  try {
    return readBitString(parseAsn1(cert.publicKey.spki).children[1]).bytes
  } catch {
    return null
  }
}

/**
 * Whether `certificate` is the one a recipient identifier names: the same issuer Name (DER bytes)
 * and serial number (ignoring leading zero bytes), or a subject key identifier equal to the
 * certificate's SubjectKeyIdentifier extension, to the SHA-1 of its public key bits (RFC 5280
 * method 1, what Windows uses for certificates without the extension) or to the SHA-1 of its whole
 * SubjectPublicKeyInfo.
 */
export function recipientMatches(rid: RecipientId | null, certificate: Certificate): boolean {
  if (!rid) return false
  if ('ski' in rid) {
    if (!rid.ski.length) return false
    if (certificate.subjectKeyId && bytesEqual(rid.ski, certificate.subjectKeyId)) return true
    if (rid.ski.length !== 20) return false
    const bits = subjectPublicKeyBits(certificate)
    if (bits && bytesEqual(rid.ski, sha1(bits))) return true
    return bytesEqual(rid.ski, sha1(certificate.publicKey.spki))
  }
  return (
    bytesEqual(rid.issuer, certificate.issuer.raw) &&
    bytesEqual(stripLeadingZeros(rid.serial), stripLeadingZeros(certificate.serial))
  )
}

// ---- algorithms ----------------------------------------------------------------------------

export type ContentCipherName = 'aes-128-cbc' | 'aes-192-cbc' | 'aes-256-cbc' | 'des-ede3-cbc' | 'rc2-cbc'

export interface ContentCipher {
  name: ContentCipherName
  /** Content key length in bytes; null for RC2 (any length). */
  keyLength: number | null
  iv: Uint8Array
  /** RC2 only: the effective key bits. */
  effectiveBits?: number
}

const AES: Record<string, [ContentCipherName, number]> = {
  [ENVELOPE_OID.aes128Cbc]: ['aes-128-cbc', 16],
  [ENVELOPE_OID.aes192Cbc]: ['aes-192-cbc', 24],
  [ENVELOPE_OID.aes256Cbc]: ['aes-256-cbc', 32]
}

/** RC2 parameter versions (RFC 2268, 6): effective key bits 40, 56, 64 and 128. */
const RC2_VERSIONS: Record<number, number> = { 160: 40, 52: 56, 120: 64, 58: 128 }

function ivOf(params: Uint8Array | null, size: number): Uint8Array {
  if (!params) throw new EnvelopeError('The envelope cipher has no IV')
  const iv = contentOf(expectUniversal(parseAsn1(params), TAG.OCTET_STRING, 'IV'))
  if (iv.length !== size) throw new EnvelopeError('The envelope cipher has a bad IV')
  return iv.slice()
}

/**
 * The cipher of the envelope's content: AES-128/192/256-CBC, DES-EDE3-CBC (Acrobat 7 to X) or
 * RC2-CBC. Null for any other algorithm; throws when a known algorithm has malformed parameters.
 */
export function contentCipher(alg: AlgorithmId): ContentCipher | null {
  const aes = AES[alg.oid]
  if (aes) return { name: aes[0], keyLength: aes[1], iv: ivOf(alg.params, 16) }
  if (alg.oid === ENVELOPE_OID.desEde3Cbc)
    return { name: 'des-ede3-cbc', keyLength: 24, iv: ivOf(alg.params, 8) }
  if (alg.oid === ENVELOPE_OID.rc2Cbc) {
    if (!alg.params) throw new EnvelopeError('The envelope cipher has no IV')
    const p = parseAsn1(alg.params)
    // RC2-CBCParameter: SEQUENCE { rc2ParameterVersion INTEGER OPTIONAL, iv }, or just the IV.
    if (isUniversal(p, TAG.OCTET_STRING))
      return { name: 'rc2-cbc', keyLength: null, iv: ivOf(alg.params, 8), effectiveBits: 32 }
    const seq = expectUniversal(p, TAG.SEQUENCE, 'RC2 parameters')
    const versionNode = isUniversal(seq.children[0], TAG.INTEGER) ? seq.children[0] : null
    const ivNode = expectUniversal(seq.children[versionNode ? 1 : 0], TAG.OCTET_STRING, 'IV')
    const iv = contentOf(ivNode)
    if (iv.length !== 8) throw new EnvelopeError('The envelope cipher has a bad IV')
    let effectiveBits = 32
    if (versionNode) {
      const version = readSmallInt(versionNode)
      effectiveBits = version >= 256 ? version : (RC2_VERSIONS[version] ?? 0)
      if (!effectiveBits || effectiveBits > 1024) return null
    }
    return { name: 'rc2-cbc', keyLength: null, iv: iv.slice(), effectiveBits }
  }
  return null
}

export type OaepHash = 'sha1' | 'sha256' | 'sha384' | 'sha512'

export interface OaepParams {
  hash: OaepHash
  mgf1Hash: OaepHash
  /** The OAEP label (pSpecified), usually empty. */
  label: Uint8Array
}

const OAEP_HASH: Record<string, OaepHash> = {
  [ENVELOPE_OID.sha1]: 'sha1',
  [ENVELOPE_OID.sha256]: 'sha256',
  [ENVELOPE_OID.sha384]: 'sha384',
  [ENVELOPE_OID.sha512]: 'sha512'
}

/**
 * RSAES-OAEP-params (RFC 8017, A.2.1): hashAlgorithm [0], maskGenAlgorithm [1] (MGF1 with a hash),
 * pSourceAlgorithm [2]; each defaults to SHA-1, MGF1-SHA-1 and an empty label. Null when it uses a
 * hash or mask generation function this app does not know.
 */
export function oaepParams(params: Uint8Array | null): OaepParams | null {
  const out: OaepParams = { hash: 'sha1', mgf1Hash: 'sha1', label: new Uint8Array() }
  if (!params) return out
  const seq = parseAsn1(params)
  if (isUniversal(seq, TAG.NULL)) return out
  expectUniversal(seq, TAG.SEQUENCE, 'OAEP parameters')
  for (const field of seq.children) {
    const inner = field.children[0]
    if (isContext(field, 0)) {
      const hash = OAEP_HASH[algorithm(inner, 'OAEP hash').oid]
      if (!hash) return null
      out.hash = hash
    } else if (isContext(field, 1)) {
      const mgf = algorithm(inner, 'OAEP mask generation')
      if (mgf.oid !== ENVELOPE_OID.mgf1 || !mgf.params) return null
      const hash = OAEP_HASH[algorithm(parseAsn1(mgf.params), 'MGF1 hash').oid]
      if (!hash) return null
      out.mgf1Hash = hash
    } else if (isContext(field, 2)) {
      const source = algorithm(inner, 'OAEP label')
      if (source.oid !== ENVELOPE_OID.pSpecified) return null
      out.label = source.params
        ? contentOf(expectUniversal(parseAsn1(source.params), TAG.OCTET_STRING, 'OAEP label')).slice()
        : new Uint8Array()
    }
  }
  return out
}
