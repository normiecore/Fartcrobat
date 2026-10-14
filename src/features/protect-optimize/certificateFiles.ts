/**
 * Recipients' certificates for Protect > Encrypt with Certificate, read from files: .cer, .crt and
 * .pem (DER or PEM, one or several certificates), .p7b and .p7c (certs-only PKCS#7, DER or PEM) and
 * .p12 and .pfx (they need their password; only the public certificate is used). The kind is told
 * from the content, so a misnamed file still reads. Pure: no DOM, no IPC.
 */
import { sha1 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { fromBase64, isContext, isUniversal, parseAsn1, readOid, readSmallInt, TAG, toHex, type Asn1Node } from '@features/digital-signatures/lib/asn1'
import { describePublicKey } from '@features/digital-signatures/lib/crypto'
import { OID } from '@features/digital-signatures/lib/oids'
import { DigitalIdError, parseDigitalId, WrongPasswordError } from '@features/digital-signatures/lib/pkcs12'
import { displayName, dnGet, isSelfIssued, parseCertificate, type Certificate } from '@features/digital-signatures/lib/x509'

/** Only RSA keys can receive the file key (PKCS#1 v1.5 key transport). */
export type CertificateKeyType = 'rsa' | 'ec' | 'other'

/** A certificate as the Encrypt with Certificate dialog shows it. Public data only. */
export interface CertificateInfo {
  /** DER. */
  der: Uint8Array
  /** Uppercase hex: SHA-256 identifies Digital IDs, SHA-1 is the Windows store thumbprint. */
  sha256: string
  sha1: string
  /** Common name, else organization, else email. */
  name: string
  email: string
  organization: string
  /** Distinguished names as text, most specific first ("CN=Alice Test, O=Contoso"). */
  subject: string
  issuer: string
  /** The issuer's common name ("Contoso CA"). */
  issuerName: string
  /** Uppercase hex without leading zero bytes, as PubSecRecipient.serial. */
  serial: string
  notBefore: Date
  notAfter: Date
  keyType: CertificateKeyType
  /** "RSA 2048-bit", "ECDSA P-256". */
  keyDescription: string
  /** Its key usage allows encrypting keys for it (keyEncipherment), or it has no key usage at all. */
  keyEncipherment: boolean
  /** A certificate authority: listed, but not ticked by default. */
  isCA: boolean
}

export type CertificateFileErrorCode = 'NEEDS_PASSWORD' | 'WRONG_PASSWORD' | 'UNREADABLE' | 'NO_CERTIFICATES'

export class CertificateFileError extends Error {
  constructor(
    readonly code: CertificateFileErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'CertificateFileError'
  }
}

/** Extensions offered in the file dialog. */
export const CERTIFICATE_FILE_EXTENSIONS = ['cer', 'crt', 'pem', 'der', 'p7b', 'p7c', 'p12', 'pfx']

const hex = (b: Uint8Array) => toHex(b)

export function keyTypeOf(cert: Certificate): CertificateKeyType {
  // RSA-PSS keys may only sign (RFC 4055), so they cannot receive a key either.
  if (cert.publicKey.type === 'RSA') return 'rsa'
  if (cert.publicKey.type === 'EC') return 'ec'
  return 'other'
}

function stripLeadingZeros(b: Uint8Array): Uint8Array {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  return b.subarray(i)
}

/** Reads one DER certificate. Throws when it is not one. */
export function certificateInfo(der: Uint8Array): CertificateInfo {
  const cert = parseCertificate(der)
  return infoOf(cert)
}

function infoOf(cert: Certificate): CertificateInfo {
  const der = cert.der
  return {
    der,
    sha256: hex(sha256(der)),
    sha1: hex(sha1(der)),
    name: displayName(cert.subject),
    email: dnGet(cert.subject, 'E') || cert.subjectAltNames.find((n) => n.includes('@')) || '',
    organization: dnGet(cert.subject, 'O'),
    subject: cert.subject.text,
    issuer: cert.issuer.text,
    issuerName: displayName(cert.issuer),
    serial: hex(stripLeadingZeros(cert.serial)),
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
    keyType: keyTypeOf(cert),
    keyDescription: describePublicKey(cert.publicKey),
    keyEncipherment: !cert.keyUsage || cert.keyUsage.includes('Key encipherment'),
    isCA: !!cert.basicConstraints?.ca || (isSelfIssued(cert) && !!cert.keyUsage?.includes('Certificate signing'))
  }
}

export function isExpired(c: { notAfter: Date | string }, now: number = Date.now()): boolean {
  return new Date(c.notAfter).getTime() < now
}

export function isNotYetValid(c: { notBefore: Date | string }, now: number = Date.now()): boolean {
  return new Date(c.notBefore).getTime() > now
}

// ---- telling the kinds apart --------------------------------------------------------------------

export type CertificateFileKind = 'pem' | 'certificate' | 'pkcs7' | 'pkcs12'

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g

function asText(bytes: Uint8Array): string | null {
  // PEM is ASCII; a DER file starts with a SEQUENCE byte (0x30).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)))
  if (!head.includes('-----BEGIN ')) return null
  return new TextDecoder('latin1').decode(bytes)
}

function parseDer(bytes: Uint8Array): Asn1Node | null {
  try {
    return parseAsn1(bytes)
  } catch {
    return null
  }
}

function derKind(root: Asn1Node): 'certificate' | 'pkcs7' | 'pkcs12' | null {
  if (!isUniversal(root, TAG.SEQUENCE)) return null
  const [a, b, c] = root.children
  // Certificate ::= SEQUENCE { tbsCertificate SEQUENCE, signatureAlgorithm SEQUENCE, signature BIT STRING }
  if (isUniversal(a, TAG.SEQUENCE) && isUniversal(b, TAG.SEQUENCE) && isUniversal(c, TAG.BIT_STRING)) return 'certificate'
  // ContentInfo ::= SEQUENCE { contentType OID, [0] EXPLICIT content }
  if (isUniversal(a, TAG.OID) && isContext(b, 0)) {
    try {
      if (readOid(a) === OID.signedData) return 'pkcs7'
    } catch {}
    return null
  }
  // PFX ::= SEQUENCE { version INTEGER (3), authSafe ContentInfo, macData MacData OPTIONAL }
  if (isUniversal(a, TAG.INTEGER) && isUniversal(b, TAG.SEQUENCE)) {
    try {
      if (readSmallInt(a) === 3 && isUniversal(b.children[0], TAG.OID) && readOid(b.children[0]) === OID.data) return 'pkcs12'
    } catch {}
  }
  return null
}

/** What kind of certificate file the bytes are, or null when they are none of them. */
export function detectCertificateFile(bytes: Uint8Array): CertificateFileKind | null {
  if (asText(bytes)) return 'pem'
  const root = parseDer(bytes)
  return root ? derKind(root) : null
}

// ---- reading ------------------------------------------------------------------------------------

/** The certificates of a certs-only PKCS#7 SignedData (a .p7b), in file order. */
function pkcs7Certificates(root: Asn1Node): Uint8Array[] {
  const signedData = root.children[1]?.children[0]
  if (!signedData || !isUniversal(signedData, TAG.SEQUENCE)) throw new Error('not a PKCS#7 SignedData')
  const out: Uint8Array[] = []
  for (const child of signedData.children) {
    // certificates [0] IMPLICIT CertificateSet: plain certificates are SEQUENCEs (other choices are tagged).
    if (!isContext(child, 0) || !child.constructed) continue
    for (const c of child.children) if (isUniversal(c, TAG.SEQUENCE)) out.push(c.buf.slice(c.start, c.end))
  }
  return out
}

function readDer(bytes: Uint8Array, password: string | undefined): Uint8Array[] {
  const root = parseDer(bytes)
  const kind = root && derKind(root)
  if (!root || !kind) throw new CertificateFileError('UNREADABLE', 'This file is not a certificate, a .p7b or a .p12 file.')
  if (kind === 'certificate') return [root.buf.slice(root.start, root.end)]
  if (kind === 'pkcs7') {
    try {
      return pkcs7Certificates(root)
    } catch {
      throw new CertificateFileError('UNREADABLE', 'This .p7b file could not be read.')
    }
  }
  if (password === undefined) throw new CertificateFileError('NEEDS_PASSWORD', 'This file is protected with a password.')
  try {
    // The certificate of the key it holds: the person's own certificate.
    return [parseDigitalId(bytes, password).signer.der]
  } catch (err) {
    if (err instanceof WrongPasswordError) throw new CertificateFileError('WRONG_PASSWORD', 'The password is incorrect.')
    if (err instanceof DigitalIdError && /private key/i.test(err.message)) {
      throw new CertificateFileError('NO_CERTIFICATES', 'This file has no certificate with a private key. Use the person’s .cer file instead.')
    }
    throw new CertificateFileError('UNREADABLE', 'This .p12 or .pfx file could not be read.')
  }
}

function readPem(text: string): Uint8Array[] {
  const out: Uint8Array[] = []
  for (const m of text.matchAll(PEM_BLOCK)) {
    const label = m[1]
    if (label !== 'CERTIFICATE' && label !== 'X509 CERTIFICATE' && label !== 'TRUSTED CERTIFICATE' && label !== 'PKCS7' && label !== 'CMS') continue
    let der: Uint8Array
    try {
      der = fromBase64(m[2].replace(/^[A-Za-z-]+:.*$/gm, ''))
    } catch {
      continue
    }
    const root = parseDer(der)
    if (!root) continue
    if (label === 'PKCS7' || label === 'CMS') {
      try {
        out.push(...pkcs7Certificates(root))
      } catch {}
    } else {
      // Only the first element: a TRUSTED CERTIFICATE continues with OpenSSL's trust settings.
      out.push(root.buf.slice(root.start, root.end))
    }
  }
  return out
}

/**
 * The certificates in a file, each once, in file order. A .p12 or .pfx needs `password` (an empty
 * string is a valid password): without it this throws CertificateFileError NEEDS_PASSWORD.
 */
export function readCertificateFile(bytes: Uint8Array, opts: { password?: string } = {}): CertificateInfo[] {
  const text = asText(bytes)
  const ders = text ? readPem(text) : readDer(bytes, opts.password)
  const out: CertificateInfo[] = []
  for (const der of ders) {
    let info: CertificateInfo
    try {
      info = certificateInfo(der)
    } catch {
      continue
    }
    if (!out.some((c) => c.sha256 === info.sha256)) out.push(info)
  }
  if (!out.length) throw new CertificateFileError('NO_CERTIFICATES', 'This file does not contain a certificate.')
  return out
}
