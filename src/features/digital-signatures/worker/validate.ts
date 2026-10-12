/** Signature validation against the exact bytes the document was opened from. */
import type { PDFObject, Session } from '@engine/session'
import { isNull, parsePdfDate, readName, readNumber, readString } from '@engine/util/pdf'
import { Asn1Error, bytesEqual, contentOf, parseAsn1 } from '../lib/asn1'
import { verifySignedData, parseTstInfo, type CmsVerification } from '../lib/cms'
import { CryptoUnsupportedError, digest, parsePublicKey, rsaPkcs1Verify } from '../lib/crypto'
import {
  checkByteRange,
  objectAt,
  objectsChangedAfter,
  onlyWhitespaceAfter,
  readRevisions,
  revisionNumberAt,
  signedBytes,
  sizeAt,
  type RevisionInfo
} from '../lib/pdfbytes'
import { buildChain, describeCertificate, displayName, parseCertificate, type Certificate } from '../lib/x509'
import type { MdpPermission, SignatureReport, ValidationReport } from '../types'
import { describeChanges } from './changes'
import { certification, listSignatureFields, lockInfo, readReferences, type SigField } from './fields'

function readByteRange(v: PDFObject): number[] {
  const raw = v.get('ByteRange')
  const out: number[] = []
  if (isNull(raw)) return out
  const arr = raw.resolve()
  if (!arr.isArray()) return out
  for (let i = 0; i < arr.length; i++) out.push(readNumber(arr.get(i), NaN))
  return out
}

interface Context {
  s: Session
  src: Uint8Array | null
  revs: RevisionInfo | null
  certified: { permission: MdpPermission; sigNum: number } | null
  /** Revision end of the certification signature (changes after it are governed by DocMDP). */
  certEnd: number
}

function emptyReport(f: SigField, v: PDFObject): SignatureReport {
  const type = readName(v.get('Type'))
  return {
    fieldName: f.name,
    widgetId: f.widgetId,
    page: f.page,
    rect: f.rect,
    invisible: f.invisible,
    kind: type === 'DocTimeStamp' ? 'timestamp' : 'approval',
    signerName: readString(v.get('Name')),
    reason: readString(v.get('Reason')),
    location: readString(v.get('Location')),
    contactInfo: readString(v.get('ContactInfo')),
    signingTime: parsePdfDate(readString(v.get('M'))) || null,
    timestamp: null,
    subFilter: readName(v.get('SubFilter')) ?? '',
    digestAlgorithm: '',
    signatureAlgorithm: '',
    revision: 0,
    revisionCount: 0,
    signedVersion: 0,
    byteRange: readByteRange(v),
    revisionEnd: 0,
    coversWholeFile: false,
    integrity: null,
    signatureValid: null,
    certificates: [],
    chainVerified: [],
    chainComplete: false,
    certValidAtSigning: null,
    certExpiredNow: false,
    permission: null,
    lock: lockInfo(f),
    changes: [],
    changesUnknown: false,
    problems: [],
    warnings: [],
    unknownReason: null
  }
}

async function verifyCms(r: SignatureReport, contents: Uint8Array, data: Uint8Array): Promise<CmsVerification | null> {
  const sub = r.subFilter
  if (sub === 'adbe.pkcs7.sha1') {
    const v = await verifySignedData(contents, null)
    const d = await digest('SHA-1', data)
    r.integrity = v.digestOk && !!v.eContent && bytesEqual(v.eContent, d)
    return v
  }
  if (sub === 'ETSI.RFC3161') {
    const v = await verifySignedData(contents, null)
    if (!v.eContent) throw new Asn1Error('The timestamp token has no content')
    const info = parseTstInfo(v.eContent)
    const d = await digest(info.digestName, data)
    r.integrity = v.digestOk && bytesEqual(d, info.imprint)
    r.timestamp = { time: info.time.toISOString(), authority: info.tsa || (v.signer ? displayName(v.signer.subject) : ''), valid: r.integrity && v.signatureOk }
    r.signingTime = info.time.toISOString()
    return v
  }
  const v = await verifySignedData(contents, data)
  r.integrity = v.digestOk
  return v
}

async function verifyX509RsaSha1(r: SignatureReport, v: PDFObject, contents: Uint8Array, data: Uint8Array): Promise<Certificate | null> {
  const certs: Certificate[] = []
  const rawCert = v.get('Cert')
  const items: PDFObject[] = []
  if (!isNull(rawCert)) {
    const certObj = rawCert.resolve()
    if (certObj.isArray()) for (let i = 0; i < certObj.length; i++) items.push(certObj.get(i))
    else items.push(certObj)
  }
  for (const c of items) {
    try {
      certs.push(parseCertificate(c.resolve().asByteString()))
    } catch {}
  }
  const signer = certs[0] ?? null
  const sigNode = parseAsn1(contents)
  const sig = contentOf(sigNode)
  r.digestAlgorithm = 'SHA-1'
  r.signatureAlgorithm = 'RSA'
  if (!signer) {
    r.problems.push("The signer's certificate is missing from the signature.")
    return null
  }
  const d = await digest('SHA-1', data)
  const ok = rsaPkcs1Verify(parsePublicKey(signer.publicKey.spki), sig, d) !== null
  r.integrity = ok
  r.signatureValid = ok
  return signer
}

async function validateOne(ctx: Context, f: SigField): Promise<SignatureReport> {
  const v = f.field.resolve().get('V').resolve()
  const r = emptyReport(f, v)
  const refs = readReferences(v)
  const docMdp = refs.find((x) => x.method === 'DocMDP')
  const vRef = f.field.resolve().get('V')
  const vNum = vRef.isIndirect() ? vRef.asIndirect() : f.fieldNum
  if (docMdp || (ctx.certified && ctx.certified.sigNum === vNum)) {
    r.kind = 'certification'
    r.permission = docMdp?.permission ?? ctx.certified?.permission ?? 2
  }
  const src = ctx.src
  if (!src) {
    r.unknownReason = 'The document has not been saved since it was created or converted, so its signatures cannot be checked.'
    return r
  }
  const chk = checkByteRange(src, r.byteRange)
  if (!chk.ok || !chk.contents) {
    r.integrity = false
    r.problems.push(chk.problem ?? 'The signature byte range is invalid.')
    return r
  }
  r.revisionEnd = chk.end
  r.coversWholeFile = chk.end >= src.length || onlyWhitespaceAfter(src, chk.end)
  if (ctx.revs) {
    r.revisionCount = ctx.revs.sections.length
    r.revision = revisionNumberAt(ctx.revs, chk.end)
  }
  const holder = objectAt(src, r.byteRange[1])
  if (holder !== null && holder !== vNum) r.problems.push('The signed data does not belong to this signature field.')

  const data = signedBytes(src, r.byteRange)
  let signer: Certificate | null = null
  let pool: Certificate[] = []
  try {
    if (r.subFilter === 'adbe.x509.rsa_sha1') {
      signer = await verifyX509RsaSha1(r, v, chk.contents, data)
      pool = signer ? [signer] : []
    } else {
      const ver = await verifyCms(r, chk.contents, data)
      if (ver) {
        r.digestAlgorithm = ver.digestName
        r.signatureAlgorithm = ver.signatureAlgorithm
        r.signatureValid = ver.signatureOk
        signer = ver.signer
        pool = ver.certificates
        if (ver.signingTime && r.kind !== 'timestamp') r.signingTime = ver.signingTime.toISOString()
        if (ver.timestamp) r.timestamp = { time: ver.timestamp.time.toISOString(), authority: ver.timestamp.authority, valid: ver.timestamp.valid }
        if (ver.signingCertificateOk === false) r.problems.push('The signing-certificate reference in the signature does not match the certificate.')
        if (!signer) r.problems.push("The signer's certificate is missing from the signature.")
      }
    }
  } catch (err) {
    if (err instanceof CryptoUnsupportedError) r.unknownReason = err.message
    else r.problems.push(`The signature data is damaged or uses an unknown format (${(err as Error).message}).`)
  }
  if (r.integrity === false) r.problems.unshift('The document has been altered or corrupted since the signature was applied.')
  if (r.signatureValid === false && r.integrity !== false) r.problems.push('The signature value does not match the signer’s certificate.')

  if (signer) {
    const { chain, complete } = await buildChain(signer, pool)
    r.chainComplete = complete
    r.chainVerified = chain.map((l) => l.verified)
    r.certificates = await Promise.all(chain.map((l) => describeCertificate(l.cert)))
    if (!r.signerName || r.kind !== 'timestamp') r.signerName = displayName(signer.subject)
    const when = r.timestamp?.valid ? new Date(r.timestamp.time) : r.signingTime ? new Date(r.signingTime) : new Date()
    r.certValidAtSigning = when >= signer.notBefore && when <= signer.notAfter
    r.certExpiredNow = Date.now() > signer.notAfter.getTime()
    if (r.certValidAtSigning === false) r.warnings.push("The signer's certificate was not valid at the signing time.")
    const brokenLink = r.chainVerified.findIndex((ok, i) => !ok && (i < chain.length - 1 || complete))
    if (brokenLink >= 0) r.warnings.push('A certificate in the chain does not verify against its issuer.')
  }
  if (!r.signerName) r.signerName = 'Unknown signer'

  // Byte range must not have been tampered with by a later update of this signature dictionary.
  if (ctx.revs && !r.coversWholeFile) {
    const changed = objectsChangedAfter(ctx.revs, chk.end)
    if (changed === null) {
      r.changesUnknown = true
    } else {
      if (changed.has(vNum) && changed.get(vNum) !== 'f') r.problems.push('The signature dictionary was changed after signing.')
      // Permission in force for this signature: certification (if signed at or after it) and lock.
      let permission: MdpPermission | null = null
      if (ctx.certified && chk.end >= ctx.certEnd && ctx.certEnd > 0) permission = ctx.certified.permission
      if (r.lock?.permission) permission = permission ? (Math.min(permission, r.lock.permission) as MdpPermission) : r.lock.permission
      const lockedFields = r.lock ? (r.lock.action === 'All' ? '*' : r.lock.action === 'Include' ? r.lock.fields : null) : null
      try {
        r.changes = describeChanges(ctx.s.pdf, changed, sizeAt(ctx.revs, chk.end), { permission, lockedFields })
      } catch {
        r.changesUnknown = true
      }
    }
  } else if (!ctx.revs && !r.coversWholeFile) {
    r.changesUnknown = true
  }
  return r
}

export async function validateSignatures(s: Session): Promise<ValidationReport> {
  const pdf = s.pdf
  const fields = listSignatureFields(pdf, s)
  const src = s.sourceBytes
  let revs: RevisionInfo | null = null
  if (src) {
    try {
      revs = await readRevisions(src)
    } catch {
      revs = null
    }
  }
  const certified = certification(pdf)
  const ctx: Context = { s, src, revs, certified, certEnd: 0 }
  if (certified && src) {
    const certField = fields.find((f) => {
      const v = f.field.resolve().get('V')
      return v.isIndirect() && v.asIndirect() === certified.sigNum
    })
    if (certField) {
      const br = readByteRange(certField.field.resolve().get('V').resolve())
      if (br.length === 4) ctx.certEnd = br[2] + br[3]
    }
  }
  const signatures: SignatureReport[] = []
  for (const f of fields.filter((x) => x.signed)) {
    try {
      signatures.push(await validateOne(ctx, f))
    } catch (err) {
      const v = f.field.resolve().get('V').resolve()
      const r = emptyReport(f, v)
      r.problems.push(`The signature could not be checked: ${(err as Error).message}`)
      signatures.push(r)
    }
  }
  signatures.sort((a, b) => (a.revisionEnd || Infinity) - (b.revisionEnd || Infinity))
  signatures.forEach((r, i) => (r.signedVersion = i + 1))
  const certSig = signatures.find((x) => x.kind === 'certification')
  const locked = signatures.some((x) => x.lock?.permission === 1)
  return {
    signatures,
    unsigned: fields.filter((x) => !x.signed).map(({ field: _f, widget: _w, fieldNum: _n, ...rest }) => rest),
    checkedFile: !!src,
    revisionCount: revs?.sections.length ?? 0,
    certified: certified?.permission ?? null,
    certifiedBy: certSig?.signerName ?? null,
    locked: locked || certified?.permission === 1,
    validatedAt: Date.now()
  }
}

