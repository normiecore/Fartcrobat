/**
 * CMS SignedData (RFC 5652) as used by PDF signatures: building detached signatures with
 * CAdES-style signed attributes, and verifying the signatures other software produced.
 */
import {
  Asn1Error,
  bytesEqual,
  CLASS_UNIVERSAL,
  contentOf,
  der,
  expectUniversal,
  isContext,
  isUniversal,
  parseAsn1,
  rawOf,
  readOid,
  readTime,
  TAG,
  tlv,
  type Asn1Node
} from './asn1'
import { CryptoUnsupportedError, digest, signBytes, verifySignature, type KeyAlg, type SignatureAlgorithm } from './crypto'
import { DIGEST_BY_OID, DIGEST_OID, OID, SIGNATURE_DIGEST, SIGNATURE_NAMES, type DigestName } from './oids'
import { displayName, parseCertificate, type Certificate } from './x509'

export interface BuildSignedDataOptions {
  /** Digest of the signed content (the PDF byte ranges). */
  contentDigest: Uint8Array
  digestName?: 'SHA-256' | 'SHA-384' | 'SHA-512'
  /** Signer certificate (DER). */
  signer: Uint8Array
  /** Further certificates to embed (issuers), DER. */
  extraCerts?: Uint8Array[]
  key: CryptoKey
  keyAlg: KeyAlg
  signingTime?: Date
  /** Add the ESS signing-certificate-v2 attribute (required for ETSI.CAdES.detached). */
  cades?: boolean
}

function attribute(oid: string, ...values: Uint8Array[]): Uint8Array {
  return der.sequence(der.oid(oid), der.set(...values))
}

function digestAlgId(name: DigestName): Uint8Array {
  const oid = DIGEST_OID[name as keyof typeof DIGEST_OID]
  if (!oid) throw new CryptoUnsupportedError(`Cannot sign with ${name}`)
  return der.sequence(der.oid(oid))
}

/** Encodes an INTEGER from content bytes exactly as found in a certificate. */
function rawInteger(content: Uint8Array): Uint8Array {
  return tlv(CLASS_UNIVERSAL, false, TAG.INTEGER, content)
}

/** Builds a DER-encoded, detached CMS ContentInfo(SignedData). */
export async function buildSignedData(o: BuildSignedDataOptions): Promise<Uint8Array> {
  const digestName = o.digestName ?? 'SHA-256'
  const cert = parseCertificate(o.signer)
  const attrs: Uint8Array[] = [attribute(OID.contentType, der.oid(OID.data))]
  if (o.signingTime) attrs.push(attribute(OID.signingTime, der.time(o.signingTime)))
  attrs.push(attribute(OID.messageDigest, der.octetString(o.contentDigest)))
  if (o.cades) {
    const certHash = await digest('SHA-256', cert.der)
    const issuerSerial = der.sequence(der.sequence(der.explicit(4, cert.issuer.raw)), rawInteger(cert.serial))
    // hashAlgorithm defaults to SHA-256 and is therefore omitted (DER).
    const essCertIdV2 = der.sequence(der.octetString(certHash), issuerSerial)
    attrs.push(attribute(OID.signingCertificateV2, der.sequence(der.sequence(essCertIdV2))))
  }
  const signedAttrsSet = der.set(...attrs)
  const signature = await signBytes(o.key, o.keyAlg, signedAttrsSet, digestName)
  // [0] IMPLICIT SET OF Attribute: same encoding with the tag changed to 0xA0.
  const signedAttrsImplicit = signedAttrsSet.slice()
  signedAttrsImplicit[0] = 0xa0
  const sigAlg =
    o.keyAlg.type === 'RSA'
      ? der.sequence(der.oid(digestName === 'SHA-256' ? OID.sha256WithRSA : digestName === 'SHA-384' ? OID.sha384WithRSA : OID.sha512WithRSA), der.null())
      : der.sequence(der.oid(digestName === 'SHA-256' ? OID.ecdsaWithSHA256 : digestName === 'SHA-384' ? OID.ecdsaWithSHA384 : OID.ecdsaWithSHA512))
  const signerInfo = der.sequence(
    der.integer(1),
    der.sequence(cert.issuer.raw, rawInteger(cert.serial)),
    digestAlgId(digestName),
    signedAttrsImplicit,
    sigAlg,
    der.octetString(signature)
  )
  const certs = [cert.der, ...(o.extraCerts ?? []).filter((c) => !bytesEqual(c, cert.der))]
  const signedData = der.sequence(
    der.integer(1),
    der.set(digestAlgId(digestName)),
    der.sequence(der.oid(OID.data)),
    der.implicitConstructed(0, ...certs),
    der.set(signerInfo)
  )
  return der.sequence(der.oid(OID.signedData), der.explicit(0, signedData))
}

// ---- verification --------------------------------------------------------------------------

export interface TimestampInfo {
  time: Date
  /** Name of the time-stamping authority. */
  authority: string
  /** Hash of the timestamped data matches and the token's own signature verified. */
  valid: boolean
  digestName: DigestName
  imprint: Uint8Array
}

export interface CmsVerification {
  digestName: DigestName
  signatureAlgorithm: string
  /** messageDigest (or the content itself when there are no signed attributes) matches. */
  digestOk: boolean
  signatureOk: boolean
  signer: Certificate | null
  certificates: Certificate[]
  signingTime: Date | null
  /** The encapsulated content (for adbe.pkcs7.sha1 and timestamp tokens). */
  eContent: Uint8Array | null
  eContentType: string
  timestamp: TimestampInfo | null
  /** ESS signing-certificate(-v2) attribute present and matching the signer. */
  signingCertificateOk: boolean | null
}

interface ParsedSignedData {
  certificates: Certificate[]
  signerInfo: Asn1Node
  eContent: Uint8Array | null
  eContentType: string
}

function parseSignedData(cms: Uint8Array): ParsedSignedData {
  const root = parseAsn1(cms)
  expectUniversal(root, TAG.SEQUENCE, 'signature container')
  if (readOid(root.children[0]) !== OID.signedData) throw new Asn1Error('The signature is not a CMS SignedData structure')
  const sd = expectUniversal(root.children[1]?.children[0], TAG.SEQUENCE, 'SignedData')
  const kids = sd.children
  let i = 2
  const encap = expectUniversal(kids[i++], TAG.SEQUENCE, 'encapsulated content')
  const eContentType = readOid(encap.children[0])
  let eContent: Uint8Array | null = null
  if (encap.children[1] && isContext(encap.children[1], 0)) {
    const inner = encap.children[1].children[0]
    if (inner) eContent = contentOf(inner).slice()
  }
  const certificates: Certificate[] = []
  if (isContext(kids[i], 0)) {
    for (const c of kids[i].children) {
      if (!isUniversal(c, TAG.SEQUENCE)) continue
      try {
        certificates.push(parseCertificate(rawOf(c)))
      } catch {
        // unknown certificate format: ignore
      }
    }
    i++
  }
  if (isContext(kids[i], 1)) i++ // CRLs
  const infos = expectUniversal(kids[i], TAG.SET, 'signer infos')
  if (!infos.children.length) throw new Asn1Error('The signature contains no signer')
  return { certificates, signerInfo: infos.children[0], eContent, eContentType }
}

function stripZeros(b: Uint8Array): Uint8Array {
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  return b.subarray(i)
}

function findSigner(si: Asn1Node, certs: Certificate[]): Certificate | null {
  const sid = si.children[1]
  if (isUniversal(sid, TAG.SEQUENCE)) {
    const issuer = rawOf(sid.children[0])
    const serial = stripZeros(contentOf(sid.children[1]))
    return certs.find((c) => bytesEqual(c.issuer.raw, issuer) && bytesEqual(stripZeros(c.serial), serial)) ?? null
  }
  if (isContext(sid, 0)) {
    const ski = contentOf(sid)
    return certs.find((c) => c.subjectKeyId && bytesEqual(c.subjectKeyId, ski)) ?? null
  }
  return null
}

function attributeValues(attrs: Asn1Node | undefined, oid: string): Asn1Node[] {
  if (!attrs) return []
  for (const a of attrs.children) {
    if (readOid(a.children[0]) === oid) return a.children[1]?.children ?? []
  }
  return []
}

/** DER encoding of the signed attributes as they were signed (tag SET). */
function signedAttributesForVerification(attrs: Asn1Node): Uint8Array {
  if (!attrs.indefinite) {
    const raw = rawOf(attrs).slice()
    raw[0] = 0x31
    return raw
  }
  return der.set(...attrs.children.map((c) => rawOf(c)))
}

/**
 * Verifies a CMS SignedData. `detached` is the signed content for detached signatures; pass null
 * to use the encapsulated content.
 */
export async function verifySignedData(cms: Uint8Array, detached: Uint8Array | null): Promise<CmsVerification> {
  const parsed = parseSignedData(cms)
  const si = parsed.signerInfo
  const kids = si.children
  let i = 2
  const digestOid = readOid(kids[i++].children[0])
  let signedAttrs: Asn1Node | undefined
  if (isContext(kids[i], 0)) signedAttrs = kids[i++]
  const sigAlgNode = kids[i++]
  const sigAlg: SignatureAlgorithm = { oid: readOid(sigAlgNode.children[0]), params: sigAlgNode.children[1] }
  const signature = contentOf(expectUniversal(kids[i++], TAG.OCTET_STRING, 'signature value'))
  const unsignedAttrs = isContext(kids[i], 1) ? kids[i] : undefined
  const digestName = DIGEST_BY_OID[digestOid] ?? SIGNATURE_DIGEST[sigAlg.oid]
  if (!digestName) throw new CryptoUnsupportedError(`Unknown digest algorithm ${digestOid}`)
  const signer = findSigner(si, parsed.certificates)
  const content = detached ?? parsed.eContent
  if (!content) throw new Asn1Error('The signature does not contain the signed data')

  const contentDigest = await digest(digestName, content)
  let digestOk: boolean
  let signedBytes: Uint8Array
  let signingTime: Date | null = null
  let signingCertificateOk: boolean | null = null
  if (signedAttrs) {
    const md = attributeValues(signedAttrs, OID.messageDigest)[0]
    digestOk = !!md && bytesEqual(contentOf(md), contentDigest)
    const st = attributeValues(signedAttrs, OID.signingTime)[0]
    if (st) {
      try {
        signingTime = readTime(st)
      } catch {}
    }
    signingCertificateOk = await checkSigningCertificate(signedAttrs, signer)
    signedBytes = signedAttributesForVerification(signedAttrs)
  } else {
    digestOk = true
    signedBytes = content
  }

  let signatureOk = false
  if (signer) {
    try {
      signatureOk = await verifySignature(signer.publicKey, sigAlg, digestName, signature, signedBytes)
    } catch (err) {
      if (err instanceof CryptoUnsupportedError) throw err
      signatureOk = false
    }
  }

  let timestamp: TimestampInfo | null = null
  const tst = attributeValues(unsignedAttrs, OID.timeStampToken)[0]
  if (tst) {
    try {
      timestamp = await verifyTimestampToken(rawOf(tst), signature)
    } catch {
      timestamp = null
    }
  }
  return {
    digestName,
    signatureAlgorithm: SIGNATURE_NAMES[sigAlg.oid] ?? sigAlg.oid,
    digestOk,
    signatureOk,
    signer,
    certificates: parsed.certificates,
    signingTime,
    eContent: parsed.eContent,
    eContentType: parsed.eContentType,
    timestamp,
    signingCertificateOk
  }
}

async function checkSigningCertificate(attrs: Asn1Node, signer: Certificate | null): Promise<boolean | null> {
  const v2 = attributeValues(attrs, OID.signingCertificateV2)[0]
  const v1 = attributeValues(attrs, OID.signingCertificate)[0]
  const node = v2 ?? v1
  if (!node || !signer) return null
  try {
    const certIds = node.children[0]
    const first = certIds.children[0]
    let name: DigestName = v2 ? 'SHA-256' : 'SHA-1'
    let k = 0
    if (v2 && isUniversal(first.children[0], TAG.SEQUENCE)) {
      name = DIGEST_BY_OID[readOid(first.children[0].children[0])] ?? name
      k = 1
    }
    const hash = contentOf(first.children[k])
    return bytesEqual(hash, await digest(name, signer.der))
  } catch {
    return false
  }
}

/** Parses a TSTInfo (RFC 3161). */
export function parseTstInfo(tstInfo: Uint8Array): { digestName: DigestName; imprint: Uint8Array; time: Date; tsa: string } {
  const node = parseAsn1(tstInfo)
  const imprint = node.children[2]
  const digestName = DIGEST_BY_OID[readOid(imprint.children[0].children[0])]
  if (!digestName) throw new CryptoUnsupportedError('Unknown timestamp digest')
  const time = readTime(node.children[4])
  let tsa = ''
  for (const c of node.children.slice(5)) {
    if (isContext(c, 0) && c.children[0]?.children[0]) {
      // GeneralName directoryName [4]
      const gn = c.children[0]
      if (gn.tag === 4 && gn.children[0]) {
        const attrs: string[] = []
        for (const rdn of gn.children[0].children) for (const atv of rdn.children) if (readOid(atv.children[0]) === OID.commonName) attrs.push(new TextDecoder().decode(contentOf(atv.children[1])))
        tsa = attrs[0] ?? ''
      }
    }
  }
  return { digestName, imprint: contentOf(imprint.children[1]).slice(), time, tsa }
}

/** Verifies an RFC 3161 timestamp token over `data` (the signature value it timestamps, or the document). */
export async function verifyTimestampToken(token: Uint8Array, data: Uint8Array): Promise<TimestampInfo> {
  const v = await verifySignedData(token, null)
  if (v.eContentType !== OID.tstInfo || !v.eContent) throw new Asn1Error('Not a timestamp token')
  const info = parseTstInfo(v.eContent)
  const expected = await digest(info.digestName, data)
  return {
    time: info.time,
    authority: info.tsa || (v.signer ? displayName(v.signer.subject) : 'Unknown time-stamping authority'),
    valid: v.digestOk && v.signatureOk && bytesEqual(expected, info.imprint),
    digestName: info.digestName,
    imprint: info.imprint
  }
}

/** Length of the DER element at the start of `bytes` (the CMS inside zero padding). */
export function derLength(bytes: Uint8Array): number {
  return parseAsn1(bytes).end
}

