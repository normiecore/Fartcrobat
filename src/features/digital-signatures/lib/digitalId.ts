/** Creating self-signed Digital IDs (X.509 certificate + private key in a PKCS#12 file). */
import { der, parseAsn1, readBitString } from './asn1'
import { digest, randomBytes, signBytes, subtle, type KeyAlg } from './crypto'
import { OID } from './oids'
import { createPkcs12 } from './pkcs12'

export interface NewDigitalIdOptions {
  name: string
  organization?: string
  unit?: string
  email?: string
  /** Two-letter ISO 3166 country code. */
  country?: string
  keyType: 'RSA' | 'EC'
  /** Validity in years. */
  years: number
  password: string
  now?: Date
}

export interface NewDigitalId {
  p12: Uint8Array
  certificate: Uint8Array
  pkcs8: Uint8Array
  keyAlg: KeyAlg
}

function rdn(oid: string, value: Uint8Array) {
  return der.set(der.sequence(der.oid(oid), value))
}

export function buildName(o: { name: string; organization?: string; unit?: string; email?: string; country?: string }): Uint8Array {
  const parts: Uint8Array[] = []
  const country = (o.country ?? '').trim().toUpperCase()
  if (/^[A-Z]{2}$/.test(country)) parts.push(rdn(OID.countryName, der.printable(country)))
  if (o.organization?.trim()) parts.push(rdn(OID.organizationName, der.utf8(o.organization.trim())))
  if (o.unit?.trim()) parts.push(rdn(OID.organizationalUnitName, der.utf8(o.unit.trim())))
  parts.push(rdn(OID.commonName, der.utf8(o.name.trim())))
  if (o.email?.trim() && /^[\x20-\x7e]+$/.test(o.email.trim())) parts.push(rdn(OID.emailAddress, der.ia5(o.email.trim())))
  return der.sequence(...parts)
}

function extension(oid: string, critical: boolean, value: Uint8Array) {
  return der.sequence(der.oid(oid), critical ? der.boolean(true) : null, der.octetString(value))
}

/** Validates the fields of the "Create a Digital ID" form. Returns an error message or null. */
export function validateNewId(o: Partial<NewDigitalIdOptions> & { confirm?: string }): string | null {
  if (!o.name?.trim()) return 'Enter your name.'
  if (o.name.trim().length > 64) return 'The name can be at most 64 characters.'
  if (o.email?.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(o.email.trim())) return 'Enter a valid email address, or leave it empty.'
  if (o.email?.trim() && !/^[\x20-\x7e]+$/.test(o.email.trim())) return 'The email address can only contain plain ASCII characters.'
  if (o.country?.trim() && !/^[A-Za-z]{2}$/.test(o.country.trim())) return 'Use a two-letter country code, e.g. US, GB or DE.'
  if (!o.password || o.password.length < 6) return 'Use a password with at least 6 characters.'
  if (o.confirm !== undefined && o.confirm !== o.password) return 'The passwords do not match.'
  return null
}

/** Creates a self-signed certificate and key, packaged as a password-protected .p12 file. */
export async function createSelfSignedId(o: NewDigitalIdOptions): Promise<NewDigitalId> {
  const err = validateNewId(o)
  if (err) throw new Error(err)
  const s = subtle()
  const pair = (await (o.keyType === 'RSA'
    ? s.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
    : s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']))) as CryptoKeyPair
  const spki = new Uint8Array(await s.exportKey('spki', pair.publicKey))
  const pkcs8 = new Uint8Array(await s.exportKey('pkcs8', pair.privateKey))
  const keyAlg: KeyAlg = o.keyType === 'RSA' ? { type: 'RSA', bits: 2048 } : { type: 'EC', curve: 'P-256' }

  const now = o.now ?? new Date()
  const notBefore = new Date(now.getTime() - 60_000)
  const notAfter = new Date(now)
  notAfter.setFullYear(notAfter.getFullYear() + Math.max(1, Math.min(50, Math.round(o.years))))
  const serial = randomBytes(16)
  serial[0] = (serial[0] & 0x7f) | 0x40
  const name = buildName(o)
  const publicKeyBits = readBitString(parseAsn1(spki).children[1]).bytes
  const ski = (await digest('SHA-1', publicKeyBits)).slice()
  const algId = o.keyType === 'RSA' ? der.sequence(der.oid(OID.sha256WithRSA), der.null()) : der.sequence(der.oid(OID.ecdsaWithSHA256))
  // digitalSignature + nonRepudiation (+ keyEncipherment for RSA)
  const keyUsage = o.keyType === 'RSA' ? der.bitString(Uint8Array.of(0xe0), 5) : der.bitString(Uint8Array.of(0xc0), 6)
  const extensions: Uint8Array[] = [
    extension(OID.basicConstraints, false, der.sequence()),
    extension(OID.keyUsage, true, keyUsage),
    extension(OID.extKeyUsage, false, der.sequence(der.oid(OID.ekuEmailProtection), der.oid(OID.ekuDocumentSigning))),
    extension(OID.subjectKeyIdentifier, false, der.octetString(ski)),
    extension(OID.authorityKeyIdentifier, false, der.sequence(der.implicitPrimitive(0, ski)))
  ]
  if (o.email?.trim()) {
    extensions.push(extension(OID.subjectAltName, false, der.sequence(der.implicitPrimitive(1, new TextEncoder().encode(o.email.trim())))))
  }
  const tbs = der.sequence(
    der.explicit(0, der.integer(2)),
    der.integer(serial),
    algId,
    name,
    der.sequence(der.time(notBefore), der.time(notAfter)),
    name,
    spki,
    der.explicit(3, der.sequence(...extensions))
  )
  const signature = await signBytes(pair.privateKey, keyAlg, tbs)
  const certificate = der.sequence(tbs, algId, der.bitString(signature))
  const p12 = createPkcs12(pkcs8, [certificate], o.password, o.name.trim())
  return { p12, certificate, pkcs8, keyAlg }
}

/** File name for a new Digital ID: letters, digits and dashes from the name plus the date. */
export function digitalIdFileName(name: string, now = new Date()): string {
  const base =
    name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 40) || 'digital-id'
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
  return `${base}-${stamp}.p12`
}

/** PEM text for a DER certificate. */
export function certificateToPem(certDer: Uint8Array): string {
  let bin = ''
  for (const b of certDer) bin += String.fromCharCode(b)
  const b64 = btoa(bin)
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`
}

