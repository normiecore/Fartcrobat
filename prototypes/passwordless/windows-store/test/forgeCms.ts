// Test-only: node-forge CMS helpers, used to cross-check the PowerShell helper.
import { forge } from './deps.ts'

const toBin = (b: Uint8Array): string => Buffer.from(b).toString('binary')
const fromBin = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, 'binary'))

/** Decrypts with a PEM private key (PKCS#1 v1.5 key transport only; node-forge has no OAEP here). */
export function forgeDecrypt(blob: Uint8Array, keyPem: string): Uint8Array | null {
  const key = forge.pki.privateKeyFromPem(keyPem)
  const msg = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(toBin(blob))))
  for (const r of msg.recipients) {
    try {
      msg.decrypt(r, key)
      return fromBin(msg.content.getBytes())
    } catch {
      // not this recipient
    }
  }
  return null
}

/** EnvelopedData with RSAES-PKCS1-v1_5 key transport and AES-256-CBC content, recipients in the given order. */
export function forgeEnvelope(certPems: string[], content: Uint8Array): Uint8Array {
  const p7 = forge.pkcs7.createEnvelopedData()
  for (const pem of certPems) p7.addRecipient(forge.pki.certificateFromPem(pem))
  p7.content = forge.util.createBuffer(toBin(content))
  p7.encrypt(undefined, forge.pki.oids['aes256-CBC'])
  return fromBin(forge.asn1.toDer(p7.toAsn1()).getBytes())
}

/**
 * Same as forgeEnvelope, but each RecipientInfo carries the certificate's issuer Name exactly as encoded
 * in the certificate. node-forge 1.4 rebuilds the Name from parsed attributes and double-encodes
 * non-ASCII UTF8String values, so Windows/.NET cannot match the recipient.
 */
export function forgeEnvelopeRawIssuer(certPems: string[], content: Uint8Array): Uint8Array {
  const p7 = forge.pkcs7.createEnvelopedData()
  const issuers: unknown[] = []
  for (const pem of certPems) {
    const cert = forge.pki.certificateFromPem(pem)
    p7.addRecipient(cert)
    const tbs = cert.tbsCertificate.value
    const hasVersion = tbs[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC
    issuers.push(tbs[hasVersion ? 3 : 2])
  }
  p7.content = forge.util.createBuffer(toBin(content))
  p7.encrypt(undefined, forge.pki.oids['aes256-CBC'])
  const asn1 = p7.toAsn1()
  // ContentInfo -> [0] -> EnvelopedData -> recipientInfos SET -> KeyTransRecipientInfo -> issuerAndSerialNumber
  const recipientInfos = asn1.value[1].value[0].value[1].value
  recipientInfos.forEach((ri: { value: Array<{ value: unknown[] }> }, i: number) => {
    ri.value[1].value[0] = issuers[i]
  })
  return fromBin(forge.asn1.toDer(asn1).getBytes())
}
