/**
 * The recipient envelopes of new certificate-encrypted files (Protect > Encrypt with Certificate):
 * one CMS EnvelopedData (RFC 5652) per permission group, holding the file's 20-byte seed and the
 * group's 4 permission bytes for every certificate in the group. Pure and synchronous: it runs in
 * the engine worker (saveDocument) and in Node, with no node-forge and no WebCrypto.
 *
 *   content        seed (20) || permissions (4, big-endian), AES-256-CBC with PKCS#7 padding under
 *                  a random content key and IV
 *   key transport  RSA PKCS#1 v1.5 (RFC 8017, 7.2.1) of the content key to each certificate's
 *                  public key, with BigInt arithmetic
 *   recipient id   issuerAndSerialNumber, version 0, with the issuer Name and the serial INTEGER
 *                  copied byte for byte from the certificate (node-forge re-encodes non-ASCII
 *                  names, and readers match these bytes exactly)
 *
 * This is what Acrobat, pyHanko and PDFBox write (docs/features/passwordless.md, D7).
 */
import { cbc } from '@noble/ciphers/aes.js'
import { CLASS_UNIVERSAL, TAG, concatBytes, der, tlv } from './asn1'
import { displayName, parseCertificate, type Certificate } from './x509'

const OID_DATA = '1.2.840.113549.1.7.1'
const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3'
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1'
const OID_AES256_CBC = '2.16.840.1.101.3.4.1.42'

/** Smallest RSA modulus accepted for a recipient. Shorter keys are broken or close to it. */
export const MIN_RSA_BITS = 1024

/** Why an envelope could not be built. `code` is the engine error code it becomes. */
export class EnvelopeBuildError extends Error {
  constructor(
    message: string,
    readonly code: 'UNSUPPORTED_KEY' | 'BAD_CERTIFICATE' | 'NO_RECIPIENTS'
  ) {
    super(message)
    this.name = 'EnvelopeBuildError'
  }
}

export type RandomSource = (n: number) => Uint8Array

const secureRandom: RandomSource = (n) => {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n
  let b = base % modulus
  let e = exponent
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus
    e >>= 1n
    b = (b * b) % modulus
  }
  return result
}

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n
  for (const x of b) n = (n << 8n) | BigInt(x)
  return n
}

function bigIntToBytes(n: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}

/** `n` random bytes, none of them zero (the padding string PS of RSAES-PKCS1-v1_5). */
function nonZeroBytes(n: number, random: RandomSource): Uint8Array {
  const out = new Uint8Array(n)
  let filled = 0
  while (filled < n) {
    for (const b of random(n - filled + 8)) {
      if (b !== 0 && filled < n) out[filled++] = b
    }
  }
  return out
}

/**
 * RSAES-PKCS1-v1_5 encryption (RFC 8017, 7.2.1): EM = 00 || 02 || PS || 00 || M, with at least 8
 * random non-zero padding bytes, then EM^e mod n written as k bytes (k = the modulus length).
 */
export function rsaPkcs1v15Encrypt(modulus: bigint, exponent: bigint, message: Uint8Array, random: RandomSource = secureRandom): Uint8Array {
  const k = Math.ceil(modulus.toString(16).length / 2)
  if (message.length > k - 11) throw new Error('The message is too long for this RSA key')
  const em = new Uint8Array(k)
  em[1] = 0x02
  em.set(nonZeroBytes(k - message.length - 3, random), 2)
  em[k - message.length - 1] = 0x00
  em.set(message, k - message.length)
  const c = modPow(bytesToBigInt(em), exponent, modulus)
  return bigIntToBytes(c, k)
}

function readCertificate(certDer: Uint8Array): Certificate {
  try {
    return parseCertificate(certDer)
  } catch (err) {
    throw new EnvelopeBuildError(`A recipient certificate could not be read (${(err as Error).message})`, 'BAD_CERTIFICATE')
  }
}

/** The RSA public key of a recipient certificate, or EnvelopeBuildError UNSUPPORTED_KEY naming its subject. */
export function recipientKey(cert: Certificate): { modulus: bigint; exponent: bigint } {
  const name = displayName(cert.subject)
  const key = cert.publicKey
  if (key.type !== 'RSA' || key.modulus === undefined || key.exponent === undefined) {
    const kind = key.type === 'EC' ? 'an EC key' : key.type === 'RSA-PSS' ? 'an RSA-PSS key (for signing only)' : 'a key type'
    throw new EnvelopeBuildError(
      `The certificate of “${name}” has ${kind} that cannot be used for certificate encryption. Only certificates with RSA keys can be recipients.`,
      'UNSUPPORTED_KEY'
    )
  }
  if (key.bits < MIN_RSA_BITS) {
    throw new EnvelopeBuildError(
      `The certificate of “${name}” has a ${key.bits}-bit RSA key, which is too short to protect a document. Use a key of at least ${MIN_RSA_BITS} bits.`,
      'UNSUPPORTED_KEY'
    )
  }
  return { modulus: key.modulus, exponent: key.exponent }
}

/** One KeyTransRecipientInfo, version 0: issuerAndSerialNumber copied from the certificate, rsaEncryption. */
function recipientInfo(cert: Certificate, contentKey: Uint8Array, random: RandomSource): Uint8Array {
  const { modulus, exponent } = recipientKey(cert)
  const encryptedKey = rsaPkcs1v15Encrypt(modulus, exponent, contentKey, random)
  return der.sequence(
    der.integer(0),
    // The issuer Name as encoded in the certificate, and its serialNumber INTEGER content as it is
    // (a leading 00 stays, negative serials stay negative).
    der.sequence(cert.issuer.raw, tlv(CLASS_UNIVERSAL, false, TAG.INTEGER, cert.serial)),
    der.sequence(der.oid(OID_RSA_ENCRYPTION), der.null()),
    der.octetString(encryptedKey)
  )
}

/** The 4 permission bytes, big-endian. */
export function permissionBytes(permissions: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, permissions >>> 0, false)
  return out
}

/**
 * One /Recipients entry: a DER ContentInfo with EnvelopedData that gives `seed` and `permissions`
 * to every certificate in `certificates` (DER X.509, RSA keys). Throws EnvelopeBuildError:
 * UNSUPPORTED_KEY for EC and other non-RSA keys (naming the certificate's subject), BAD_CERTIFICATE
 * for a certificate that cannot be read.
 */
export function buildEnvelopedData(
  certificates: Uint8Array[],
  seed: Uint8Array,
  permissions: number,
  random: RandomSource = secureRandom
): Uint8Array {
  if (seed.length !== 20) throw new Error('The seed must be 20 bytes')
  if (!certificates.length) throw new EnvelopeBuildError('Add at least one recipient', 'NO_RECIPIENTS')
  // Every certificate is checked before any key is used.
  const certs = certificates.map(readCertificate)
  for (const c of certs) recipientKey(c)
  const contentKey = random(32)
  const iv = random(16)
  const encryptedContent = cbc(contentKey, iv).encrypt(concatBytes([seed, permissionBytes(permissions)]))
  const infos = certs.map((c) => recipientInfo(c, contentKey, random))
  contentKey.fill(0)
  const envelopedData = der.sequence(
    der.integer(0),
    // RecipientInfos is a SET OF: der.set sorts the encodings (DER).
    der.set(...infos),
    der.sequence(
      der.oid(OID_DATA),
      der.sequence(der.oid(OID_AES256_CBC), der.octetString(iv)),
      der.implicitPrimitive(0, encryptedContent)
    )
  )
  return der.sequence(der.oid(OID_ENVELOPED_DATA), der.explicit(0, envelopedData))
}
