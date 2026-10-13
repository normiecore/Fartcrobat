/** X.509 certificate parsing (RFC 5280) for display, chain building and signature checks. */
import {
  bytesEqual,
  contentOf,
  expectUniversal,
  isContext,
  isUniversal,
  parseAsn1,
  rawOf,
  readBitString,
  readBoolean,
  readOid,
  readSmallInt,
  readString,
  readTime,
  TAG,
  toHex,
  type Asn1Node
} from './asn1'
import { describePublicKey, fingerprints, parsePublicKey, verifySignature, type PublicKeyInfo, type SignatureAlgorithm } from './crypto'
import { DN_SHORT, EKU_NAMES, OID, SIGNATURE_DIGEST, SIGNATURE_NAMES } from './oids'

export interface DnAttr {
  oid: string
  short: string
  value: string
}

export interface DistinguishedName {
  attrs: DnAttr[]
  /** DER of the Name, used to match issuers and subjects. */
  raw: Uint8Array
  /** "CN=Jane Doe, O=Acme, C=US" (most specific first). */
  text: string
}

export interface Certificate {
  der: Uint8Array
  tbs: Uint8Array
  version: number
  serial: Uint8Array
  signatureAlg: SignatureAlgorithm
  signature: Uint8Array
  issuer: DistinguishedName
  subject: DistinguishedName
  notBefore: Date
  notAfter: Date
  publicKey: PublicKeyInfo
  keyUsage: string[] | null
  extKeyUsage: string[] | null
  basicConstraints: { ca: boolean; pathLen?: number } | null
  subjectAltNames: string[]
  subjectKeyId: Uint8Array | null
  authorityKeyId: Uint8Array | null
}

const KEY_USAGE_NAMES = [
  'Digital signature',
  'Non-repudiation',
  'Key encipherment',
  'Data encipherment',
  'Key agreement',
  'Certificate signing',
  'CRL signing',
  'Encipher only',
  'Decipher only'
]

function readName(node: Asn1Node): DistinguishedName {
  const attrs: DnAttr[] = []
  for (const rdn of node.children) {
    for (const atv of rdn.children) {
      const oid = readOid(atv.children[0])
      let value = ''
      try {
        value = readString(atv.children[1])
      } catch {}
      attrs.push({ oid, short: DN_SHORT[oid] ?? oid, value })
    }
  }
  const text = [...attrs]
    .reverse()
    .map((a) => `${a.short}=${a.value}`)
    .join(', ')
  return { attrs, raw: rawOf(node).slice(), text }
}

export function dnGet(name: DistinguishedName, short: string): string {
  return name.attrs.find((a) => a.short === short)?.value ?? ''
}

/** Best display name of a certificate subject: CN, else O, else email, else the full DN. */
export function displayName(name: DistinguishedName): string {
  return dnGet(name, 'CN') || dnGet(name, 'O') || dnGet(name, 'E') || name.text || 'Unknown'
}

export function parseCertificate(input: Uint8Array): Certificate {
  const root = parseAsn1(input)
  const certDer = rawOf(root).slice()
  const tbsNode = expectUniversal(root.children[0], TAG.SEQUENCE, 'certificate')
  const sigAlgNode = expectUniversal(root.children[1], TAG.SEQUENCE, 'certificate signature algorithm')
  const sigNode = expectUniversal(root.children[2], TAG.BIT_STRING, 'certificate signature')
  let i = 0
  let version = 1
  const kids = tbsNode.children
  if (isContext(kids[0], 0)) {
    version = readSmallInt(kids[0].children[0]) + 1
    i++
  }
  const serial = contentOf(kids[i++]).slice()
  i++ // inner signature algorithm
  const issuer = readName(kids[i++])
  const validity = kids[i++]
  const notBefore = readTime(validity.children[0])
  const notAfter = readTime(validity.children[1])
  const subject = readName(kids[i++])
  const publicKey = parsePublicKey(rawOf(kids[i++]).slice())
  const cert: Certificate = {
    der: certDer,
    tbs: rawOf(tbsNode).slice(),
    version,
    serial,
    signatureAlg: { oid: readOid(sigAlgNode.children[0]), params: sigAlgNode.children[1] },
    signature: readBitString(sigNode).bytes.slice(),
    issuer,
    subject,
    notBefore,
    notAfter,
    publicKey,
    keyUsage: null,
    extKeyUsage: null,
    basicConstraints: null,
    subjectAltNames: [],
    subjectKeyId: null,
    authorityKeyId: null
  }
  for (; i < kids.length; i++) {
    if (!isContext(kids[i], 3)) continue
    for (const ext of kids[i].children[0]?.children ?? []) {
      try {
        readExtension(cert, ext)
      } catch {
        // ignore malformed extensions; they only affect display
      }
    }
  }
  return cert
}

function readExtension(cert: Certificate, ext: Asn1Node) {
  const oid = readOid(ext.children[0])
  const valueNode = ext.children[ext.children.length - 1]
  const value = parseAsn1(contentOf(valueNode))
  switch (oid) {
    case OID.keyUsage: {
      const { unused, bytes } = readBitString(value)
      const out: string[] = []
      const total = bytes.length * 8 - unused
      for (let bit = 0; bit < Math.min(total, KEY_USAGE_NAMES.length); bit++) {
        if (bytes[bit >> 3] & (0x80 >> (bit & 7))) out.push(KEY_USAGE_NAMES[bit])
      }
      cert.keyUsage = out
      break
    }
    case OID.extKeyUsage:
      cert.extKeyUsage = value.children.map(readOid)
      break
    case OID.basicConstraints: {
      let ca = false
      let pathLen: number | undefined
      for (const c of value.children) {
        if (isUniversal(c, TAG.BOOLEAN)) ca = readBoolean(c)
        else if (isUniversal(c, TAG.INTEGER)) pathLen = readSmallInt(c)
      }
      cert.basicConstraints = { ca, pathLen }
      break
    }
    case OID.subjectAltName:
      for (const gn of value.children) {
        if (gn.tag === 1 || gn.tag === 2 || gn.tag === 6) cert.subjectAltNames.push(new TextDecoder().decode(contentOf(gn)))
        else if (gn.tag === 4 && gn.children[0]) cert.subjectAltNames.push(readName(gn.children[0]).text)
      }
      break
    case OID.subjectKeyIdentifier:
      cert.subjectKeyId = contentOf(value).slice()
      break
    case OID.authorityKeyIdentifier: {
      const kid = value.children.find((c) => isContext(c, 0))
      if (kid) cert.authorityKeyId = contentOf(kid).slice()
      break
    }
  }
}

export function isSelfIssued(cert: Certificate): boolean {
  return bytesEqual(cert.subject.raw, cert.issuer.raw)
}

/** True when `issuer` plausibly issued `cert` (names and key identifiers match). */
export function couldHaveIssued(issuer: Certificate, cert: Certificate): boolean {
  if (!bytesEqual(issuer.subject.raw, cert.issuer.raw)) return false
  if (cert.authorityKeyId && issuer.subjectKeyId && !bytesEqual(cert.authorityKeyId, issuer.subjectKeyId)) return false
  return true
}

/** Checks the certificate's signature with the issuer's public key. */
export async function verifyIssuedBy(cert: Certificate, issuer: Certificate): Promise<boolean> {
  try {
    const digestName = SIGNATURE_DIGEST[cert.signatureAlg.oid] ?? 'SHA-256'
    return await verifySignature(issuer.publicKey, cert.signatureAlg, digestName, cert.signature, cert.tbs)
  } catch {
    return false
  }
}

export interface ChainLink {
  cert: Certificate
  /** Whether this certificate's signature was verified by the next one in the chain (or itself for a root). */
  verified: boolean
}

/**
 * Builds the chain signer -> ... -> root from the certificates at hand. Each link records whether
 * its signature verified with the issuer's key.
 */
export async function buildChain(signer: Certificate, pool: Certificate[]): Promise<{ chain: ChainLink[]; complete: boolean }> {
  const chain: ChainLink[] = []
  let cur = signer
  const seen = new Set<string>()
  for (let depth = 0; depth < 10; depth++) {
    const key = toHex(cur.der.subarray(0, Math.min(cur.der.length, 64))) + cur.der.length
    if (seen.has(key)) break
    seen.add(key)
    if (isSelfIssued(cur)) {
      chain.push({ cert: cur, verified: await verifyIssuedBy(cur, cur) })
      return { chain, complete: true }
    }
    const issuer = pool.find((c) => c !== cur && couldHaveIssued(c, cur))
    if (!issuer) {
      chain.push({ cert: cur, verified: false })
      return { chain, complete: false }
    }
    chain.push({ cert: cur, verified: await verifyIssuedBy(cur, issuer) })
    cur = issuer
  }
  return { chain, complete: false }
}

/** Plain, serialisable description of a certificate for the UI. */
export interface CertDetails {
  der: Uint8Array
  subject: string
  subjectName: string
  subjectAttrs: DnAttr[]
  issuer: string
  issuerName: string
  issuerAttrs: DnAttr[]
  email: string
  organization: string
  serial: string
  version: number
  notBefore: string
  notAfter: string
  keyUsage: string[]
  extKeyUsage: string[]
  isCA: boolean
  selfSigned: boolean
  publicKey: string
  signatureAlgorithm: string
  sha256: string
  sha1: string
}

export async function describeCertificate(cert: Certificate): Promise<CertDetails> {
  const fp = await fingerprints(cert.der)
  return {
    der: cert.der,
    subject: cert.subject.text,
    subjectName: displayName(cert.subject),
    subjectAttrs: cert.subject.attrs,
    issuer: cert.issuer.text,
    issuerName: displayName(cert.issuer),
    issuerAttrs: cert.issuer.attrs,
    email: dnGet(cert.subject, 'E') || cert.subjectAltNames.find((n) => n.includes('@')) || '',
    organization: dnGet(cert.subject, 'O'),
    serial: toHex(stripLeadingZero(cert.serial), ':'),
    version: cert.version,
    notBefore: cert.notBefore.toISOString(),
    notAfter: cert.notAfter.toISOString(),
    keyUsage: cert.keyUsage ?? [],
    extKeyUsage: (cert.extKeyUsage ?? []).map((o) => EKU_NAMES[o] ?? o),
    isCA: !!cert.basicConstraints?.ca,
    selfSigned: isSelfIssued(cert),
    publicKey: describePublicKey(cert.publicKey),
    signatureAlgorithm: SIGNATURE_NAMES[cert.signatureAlg.oid] ?? cert.signatureAlg.oid,
    sha256: fp.sha256,
    sha1: fp.sha1
  }
}

function stripLeadingZero(b: Uint8Array): Uint8Array {
  return b.length > 1 && b[0] === 0 ? b.subarray(1) : b
}
