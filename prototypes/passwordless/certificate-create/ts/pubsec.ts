// Public-key security handler (/Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5, V5, AESV3):
// recipient envelopes, file key, /Encrypt dictionary, and unwrapping a seed with a private key.
// Proposed home: src/features/protect-optimize/pubsec.ts (pure; runs in the engine worker and in
// the main process).
//
//   seed        20 random bytes, the only secret
//   envelope    CMS EnvelopedData (DER ContentInfo) with content seed(20) || permissions(4, BE),
//               AES-256-CBC under a random content key, which is RSA-encrypted (PKCS#1 v1.5,
//               issuerAndSerialNumber) to every certificate of the permission group
//   file key    SHA-256(seed || envelope[0] || envelope[1] ... || [FF FF FF FF if !EncryptMetadata])
import forge from 'node-forge'
import { CLASS_UNIVERSAL, TAG, contentOf, der, isUniversal, parseAsn1, rawOf, readOid, tlv } from '@features/digital-signatures/lib/asn1'
import { parseCertificate } from '@features/digital-signatures/lib/x509'
import { aesCbcDecrypt, aesCbcEncrypt, concat, randomBytes, sha, toHex, toLatin1 } from './pdfCrypto'

const OID_DATA = '1.2.840.113549.1.7.1'
const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3'
const OID_RSA = '1.2.840.113549.1.1.1'
const OID_AES256_CBC = '2.16.840.1.101.3.4.1.42'

/** Public-key handler permission bits (ISO 32000-2 table 24). */
export const PUBSEC_PERMISSION = {
  changeSecurity: 1 << 1,
  print: 1 << 2,
  modify: 1 << 3,
  copy: 1 << 4,
  annotate: 1 << 5,
  fillForms: 1 << 8,
  accessibility: 1 << 9,
  assemble: 1 << 10,
  printHighRes: 1 << 11
} as const
export type PubSecPermission = keyof typeof PUBSEC_PERMISSION

/** Permission bits; anything not set to false is allowed. Bit 1 is always set (Acrobat). */
export function pubsecPermissionBits(allow: Partial<Record<PubSecPermission, boolean>> = {}): number {
  let bits = 0xffffe0c1 | (1 << 12) // reserved bits, plus "tolerate missing ISO 32004 MAC"
  for (const [name, bit] of Object.entries(PUBSEC_PERMISSION)) if (allow[name as PubSecPermission] !== false) bits |= bit
  return bits >>> 0
}

export interface RecipientGroup {
  /** DER X.509 certificates (RSA keys). */
  certs: Uint8Array[]
  /** From pubsecPermissionBits(); everything allowed by default. */
  permissions?: number
}

export interface PubSecKey {
  seed: Uint8Array
  recipients: Uint8Array[]
  fileKey: Uint8Array
  encryptMetadata: boolean
}

export class PubSecError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PubSecError'
  }
}

const bin = (b: Uint8Array) => toLatin1(b)
/** The certificate's serialNumber INTEGER re-wrapped without normalising (negative serials exist). */
const serialTlv = (content: Uint8Array) => tlv(CLASS_UNIVERSAL, false, TAG.INTEGER, content)
const unbin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

/** One envelope (DER ContentInfo) holding seed||permissions for every certificate in `certs`. */
export async function buildRecipientEnvelope(certs: Uint8Array[], seed: Uint8Array, permissions: number): Promise<Uint8Array> {
  if (seed.length !== 20) throw new PubSecError('The seed must be 20 bytes')
  const perms = new Uint8Array(4)
  new DataView(perms.buffer).setUint32(0, permissions >>> 0, false)
  const contentKey = randomBytes(32)
  const iv = randomBytes(16)
  const encryptedContent = await aesCbcEncrypt(contentKey, iv, concat([seed, perms]))
  const infos = certs.map((certDer) => {
    const cert = parseCertificate(certDer)
    if (cert.publicKey.type !== 'RSA') {
      throw new PubSecError(`${cert.subject.text}: only RSA certificates can be used for certificate encryption`)
    }
    const pub = forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(bin(cert.publicKey.spki)))
    const encryptedKey = unbin(pub.encrypt(bin(contentKey), 'RSAES-PKCS1-V1_5'))
    return der.sequence(
      der.integer(0),
      der.sequence(cert.issuer.raw, serialTlv(cert.serial)), // exact bytes from the certificate
      der.sequence(der.oid(OID_RSA), der.null()),
      der.octetString(encryptedKey)
    )
  })
  const envelopedData = der.sequence(
    der.integer(0),
    der.set(...infos),
    der.sequence(der.oid(OID_DATA), der.sequence(der.oid(OID_AES256_CBC), der.octetString(iv)), der.implicitPrimitive(0, encryptedContent))
  )
  return der.sequence(der.oid(OID_ENVELOPED_DATA), der.explicit(0, envelopedData))
}

export async function pubsecFileKey(seed: Uint8Array, recipients: Uint8Array[], encryptMetadata = true): Promise<Uint8Array> {
  const parts = [seed, ...recipients]
  if (!encryptMetadata) parts.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff))
  return sha(256, concat(parts))
}

/** New key material: one shared seed, one envelope per recipient group. */
export async function newPubSecKey(groups: RecipientGroup[], encryptMetadata = true): Promise<PubSecKey> {
  if (!groups.some((g) => g.certs.length)) throw new PubSecError('Add at least one recipient')
  const seed = randomBytes(20)
  const recipients: Uint8Array[] = []
  for (const g of groups) {
    if (g.certs.length) recipients.push(await buildRecipientEnvelope(g.certs, seed, g.permissions ?? 0xffffffff))
  }
  return { seed, recipients, fileKey: await pubsecFileKey(seed, recipients, encryptMetadata), encryptMetadata }
}

/** The /Encrypt dictionary as PDF source. Strings in it are never encrypted. */
export function pubsecEncryptDict(recipients: Uint8Array[], encryptMetadata = true): string {
  const em = encryptMetadata ? 'true' : 'false'
  return (
    `<</Filter/Adobe.PubSec/SubFilter/adbe.pkcs7.s5/V 5/Length 256` +
    `/CF<</DefaultCryptFilter<</Type/CryptFilter/CFM/AESV3/AuthEvent/DocOpen/Length 256` +
    `/Recipients[${recipients.map((r) => `<${toHex(r)}>`).join('')}]/EncryptMetadata ${em}>>>>` +
    `/StmF/DefaultCryptFilter/StrF/DefaultCryptFilter/EncryptMetadata ${em}>>`
  )
}

/** RSA PKCS#1 v1.5 decryption of a wrapped content key (certificate store, smart card, .p12). */
export type KeyDecrypter = (wrapped: Uint8Array) => Promise<Uint8Array>

/**
 * Finds the envelope addressed to `certDer` (by issuer and serial number) and returns its seed
 * and permissions, or null when the certificate is not a recipient.
 */
export async function unwrapSeed(
  recipients: Uint8Array[],
  certDer: Uint8Array,
  decrypt: KeyDecrypter
): Promise<{ seed: Uint8Array; permissions: number | null } | null> {
  const me = parseCertificate(certDer)
  const myIssuer = toHex(me.issuer.raw)
  const mySerial = toHex(serialTlv(me.serial))
  for (const blob of recipients) {
    const ci = parseAsn1(blob)
    if (readOid(ci.children[0]) !== OID_ENVELOPED_DATA) continue
    const ed = ci.children[1].children[0]
    const [, recipientInfos, eci] = ed.children
    for (const ri of recipientInfos.children) {
      const rid = ri.children[1]
      if (!isUniversal(rid, TAG.SEQUENCE)) continue // subjectKeyIdentifier ([0]) is not used by Acrobat
      if (toHex(rawOf(rid.children[0])) !== myIssuer || toHex(rawOf(rid.children[1])) !== mySerial) continue
      const contentKey = await decrypt(contentOf(ri.children[3]))
      const alg = eci.children[1]
      if (readOid(alg.children[0]) !== OID_AES256_CBC) throw new PubSecError('Unsupported envelope cipher')
      const content = await aesCbcDecrypt(contentKey, contentOf(alg.children[1]), contentOf(eci.children[2]))
      return {
        seed: content.slice(0, 20),
        permissions: content.length >= 24 ? new DataView(content.buffer, content.byteOffset + 20, 4).getUint32(0, false) : null
      }
    }
  }
  return null
}
