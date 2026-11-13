/** Signature validation against the exact bytes the document was opened from. */
import type { PDFDocument, PDFObject, Session } from '@engine/session'
import { isNull, parsePdfDate, readName, readNumber, readString } from '@engine/util/pdf'
import { Asn1Error, bytesEqual, contentOf, parseAsn1 } from '../lib/asn1'
import { claimedSigner, verifySignedData, parseTstInfo, type CmsVerification } from '../lib/cms'
import { OID } from '../lib/oids'
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
  type RevisionInfo,
  type XrefEntryType
} from '../lib/pdfbytes'
import { buildChain, describeCertificate, displayName, isTimestampAuthority, parseCertificate, type Certificate } from '../lib/x509'
import { COPIED_SIGNATURE, type MdpPermission, type SignatureReport, type ValidationReport } from '../types'
import { describeChanges } from './changes'
import { certification, listSignatureFields, lockInfo, readReferences, safe, signedFieldIn, type SigField } from './fields'
import { laterUpdatesOtherThanSigning } from './later'

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
  /** MuPDF had to repair the file: it does not read it the way its cross-reference sections say. */
  repaired: boolean
  /** Signatures followed by later updates, to check once every signature is verified. */
  later: { r: SignatureReport; changed: Map<number, XrefEntryType> }[]
  /** Object number of each report's signature dictionary. */
  vNums: Map<SignatureReport, number>
  /** The signature value the catalog's /Perms /DocMDP names when it is a timestamp (not a certification), else -1. */
  rejectedCertification: number
}

/**
 * A document timestamp, or a signature value in the RFC 3161 token format. Neither can certify a
 * document: the token's signer is a time-stamping authority, not the author.
 */
function timestampLike(v: PDFObject): boolean {
  return readName(v.get('Type')) === 'DocTimeStamp' || readName(v.get('SubFilter')) === 'ETSI.RFC3161'
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
    restrictionsUnknown: false,
    laterUpdates: 'other',
    permissionInForce: null,
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
    // The token must say that it holds timestamp information (id-ct-TSTInfo), not just hold bytes
    // that happen to parse as one.
    if (v.eContentType !== OID.tstInfo) throw new Asn1Error('The timestamp token does not hold timestamp information')
    if (!v.eContent) throw new Asn1Error('The timestamp token has no content')
    const info = parseTstInfo(v.eContent)
    const d = await digest(info.digestName, data)
    r.integrity = v.digestOk && bytesEqual(d, info.imprint)
    // The authority's chain is the signature's own chain (r.certificates).
    r.timestamp = {
      time: info.time.toISOString(),
      authority: info.tsa || (v.signer ? displayName(v.signer.subject) : ''),
      valid: r.integrity && v.signatureOk,
      authorityOk: isTimestampAuthority(v.signer, info.time),
      certificates: [],
      chainVerified: []
    }
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
  const ok = rsaPkcs1Verify(parsePublicKey(signer.publicKey.spki), sig, d, 'SHA-1') !== null
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
  ctx.vNums.set(r, vNum)
  const tsLike = timestampLike(v)
  // ctx.certified never names a timestamp (see validateSignatures).
  if (!tsLike && (docMdp || (ctx.certified && ctx.certified.sigNum === vNum))) {
    r.kind = 'certification'
    r.permission = docMdp?.permission ?? ctx.certified?.permission ?? 2
  }
  const src = ctx.src
  if (!src) {
    r.unknownReason = 'The document has not been saved since it was created or converted, so its signatures cannot be checked.'
    return r
  }
  const chk = await checkSignatureData(ctx, r, v, vNum)
  // After the cached data checks, which replace problems and warnings.
  if (tsLike && docMdp) {
    r.problems.push(
      'This timestamp carries a certification (DocMDP) reference, but a timestamp cannot certify a document. It is not treated as a certification.'
    )
  } else if (tsLike && ctx.rejectedCertification === vNum) {
    r.warnings.push('The document names this timestamp as its certification, but a timestamp cannot certify a document. It is not treated as one.')
  }
  if (!chk) return r

  // Permission in force for this signature: certification (if signed at or after it) and lock.
  const inForce = (): MdpPermission | null => {
    let permission: MdpPermission | null = null
    if (ctx.certified && chk.end >= ctx.certEnd && ctx.certEnd > 0) permission = ctx.certified.permission
    if (r.lock?.permission) permission = permission ? (Math.min(permission, r.lock.permission) as MdpPermission) : r.lock.permission
    return permission
  }
  r.permissionInForce = inForce()
  if (r.coversWholeFile) {
    r.laterUpdates = 'none'
    return r
  }
  // Later updates: what they changed, judged by the rules in force when this signature was made.
  // A repaired file is not read the way its cross-reference sections say, so its changes are unknown.
  const changed = ctx.revs && !ctx.repaired ? objectsChangedAfter(src, ctx.revs, chk.end) : null
  const before = openRevision(ctx.s, src, chk.end)
  try {
    if (!before) {
      // Without the signed revision there is nothing to judge the changes by, not even the
      // field lock or the certification the signer applied: the current document may have
      // dropped them.
      r.changesUnknown = true
      r.restrictionsUnknown = true
      return r
    }
    // The field lock as signed, read from the field that held this signature value in the signed
    // revision: a later update can neither remove the lock nor move the value to another field.
    const signedField = vRef.isIndirect() ? signedFieldIn(before, vNum) : null
    if (signedField) r.lock = lockInfo(f, signedField)
    else r.restrictionsUnknown = true
    const permission = inForce()
    r.permissionInForce = permission
    if (changed === null) {
      r.changesUnknown = true
      return r
    }
    // Byte range must not have been tampered with by a later update of this signature dictionary.
    if (changed.has(vNum) && changed.get(vNum) !== 'f') r.problems.push('The signature dictionary was changed after signing.')
    try {
      r.changes = describeChanges(ctx.s.pdf, changed, sizeAt(ctx.revs!, chk.end), { permission, lock: r.lock, before })
    } catch {
      r.changes = []
      r.changesUnknown = true
    }
    // Reading the objects can make MuPDF repair the file (an entry that points to the wrong
    // object); from then on it shows objects the cross-reference sections do not list.
    if (wasRepaired(ctx.s.pdf) || wasRepaired(before)) {
      ctx.repaired = true
      r.changes = []
      r.changesUnknown = true
    }
    if (!r.changesUnknown) ctx.later.push({ r, changed })
  } finally {
    before?.destroy()
  }
  return r
}

/**
 * Decides, for each signature followed by later updates, whether those updates are only later
 * signatures (laterUpdates 'signing'); it stays 'other' otherwise. The later signatures must have
 * verified, and the newest of them must cover the whole file. See later.ts.
 */
function judgeLaterUpdates(ctx: Context, signatures: SignatureReport[]) {
  const src = ctx.src!
  const verified = signatures.filter((x) => x.integrity === true && x.signatureValid === true && !x.problems.length && x.revisionEnd > 0 && ctx.vNums.has(x))
  const coveredBySignature = verified.some((x) => x.coversWholeFile)
  const todo = coveredBySignature && !ctx.repaired ? ctx.later.filter((x) => !x.r.changesUnknown) : []
  let now: PDFDocument | null = null
  try {
    if (todo.length) now = openRevision(ctx.s, src, src.length)
    for (const { r, changed } of todo) {
      const laterSigs = new Set(verified.filter((x) => x.revisionEnd > r.revisionEnd).map((x) => ctx.vNums.get(x)!))
      if (!now || !laterSigs.size) continue
      const before = openRevision(ctx.s, src, r.revisionEnd)
      if (!before) continue
      try {
        const why = laterUpdatesOtherThanSigning(now, before, changed, laterSigs)
        if (why === null && !wasRepaired(now) && !wasRepaired(before)) r.laterUpdates = 'signing'
      } finally {
        before.destroy()
      }
    }
  } finally {
    now?.destroy()
  }
  // A change describeChanges has nothing to say about (an object MuPDF reads without any
  // reference to it, for one) is still a change.
  for (const r of signatures) {
    if (r.laterUpdates === 'other' && !r.coversWholeFile && r.revisionEnd > 0 && !r.changesUnknown && !r.changes.length) {
      r.changes.push({ category: 'other', allowed: false, description: 'Other parts of the document were changed' })
    }
  }
}

function wasRepaired(pdf: PDFDocument): boolean {
  return safe(() => pdf.wasRepaired(), true)
}

/** The signed revision (the file up to `end`) opened on its own, or null. */
function openRevision(s: Session, src: Uint8Array, end: number): PDFDocument | null {
  let doc: PDFDocument | null = null
  try {
    doc = new s.mupdf.PDFDocument(src.slice(0, end))
    if (doc.needsPassword() && !(s.password && doc.authenticatePassword(s.password))) throw new Error('password')
    return doc
  } catch {
    try {
      doc?.destroy()
    } catch {}
    return null
  }
}

/** Report fields that only depend on the file bytes and the signature value (cached per file). */
const DATA_KEYS = [
  'integrity',
  'signatureValid',
  'revisionEnd',
  'coversWholeFile',
  'revision',
  'revisionCount',
  'digestAlgorithm',
  'signatureAlgorithm',
  'signingTime',
  'timestamp',
  'certificates',
  'chainVerified',
  'chainComplete',
  'certValidAtSigning',
  'certExpiredNow',
  'signerName',
  'problems',
  'warnings',
  'unknownReason'
] as const satisfies readonly (keyof SignatureReport)[]

type DataResult = { end: number } | null
interface CachedData {
  values: Partial<SignatureReport>
  result: DataResult
}

/**
 * Checks of the signed bytes are by far the slowest part (hashing the whole file, verifying
 * certificates) and depend only on the file, so they are remembered for the bytes the document
 * was opened (or last saved) from; editing the document does not repeat them.
 */
const dataCache = new WeakMap<Uint8Array, Map<string, CachedData>>()

async function checkSignatureData(ctx: Context, r: SignatureReport, v: PDFObject, vNum: number): Promise<DataResult> {
  const src = ctx.src!
  const key = `${vNum}|${r.kind}|${r.subFilter}|${r.byteRange.join(',')}`
  let perFile = dataCache.get(src)
  if (!perFile) {
    perFile = new Map()
    dataCache.set(src, perFile)
  }
  const hit = perFile.get(key)
  if (hit) {
    const copy = structuredClone(hit.values)
    Object.assign(r, copy)
    return hit.result
  }
  const result = await checkSignatureDataUncached(ctx, r, v, vNum)
  const values: Partial<SignatureReport> = {}
  for (const k of DATA_KEYS) (values as Record<string, unknown>)[k] = r[k]
  perFile.set(key, { values: structuredClone(values), result })
  return result
}

/** File offset of an object as the file's newest cross-reference section that has it says, or null. */
function objectOffset(ctx: Context, num: number): number | null {
  for (const sec of ctx.revs?.chain ?? []) {
    const container = sec.containers?.get(num)
    const target = container ?? num
    const hit = sec.offsets?.find(([n]) => n === target)
    if (hit) return hit[1]
  }
  return null
}

/**
 * True when the signature dictionary itself lies beyond the end of the bytes it says it signed.
 * A signature dictionary is always written inside the revision it signs, so this one was signed in
 * another file and copied into this one (combining signed PDFs into a bundle does this).
 */
function copiedFromAnotherFile(ctx: Context, br: number[], vNum: number): boolean {
  if (br.length !== 4 || br[0] !== 0 || br[2] <= br[1]) return false
  const at = objectOffset(ctx, vNum)
  return at !== null && at >= br[2] + br[3]
}

/** The name in the signer certificate a signature carries, unverified, for display only. */
function claimedSignerName(r: SignatureReport, v: PDFObject): string {
  if (r.subFilter === 'adbe.x509.rsa_sha1') return 'Unknown signer'
  const contents = safe<Uint8Array | null>(() => v.get('Contents').resolve().asByteString(), null)
  const cert = contents ? claimedSigner(contents) : null
  return cert ? displayName(cert.subject) : 'Unknown signer'
}

async function checkSignatureDataUncached(ctx: Context, r: SignatureReport, v: PDFObject, vNum: number): Promise<DataResult> {
  const src = ctx.src!
  const chk = checkByteRange(src, r.byteRange)
  if (!chk.ok || !chk.contents) {
    r.integrity = false
    if (copiedFromAnotherFile(ctx, r.byteRange, vNum)) r.problems.push(COPIED_SIGNATURE)
    else if (r.byteRange.length === 4 && r.byteRange[0] === 0 && r.byteRange[2] > r.byteRange[1])
      r.problems.push('The document has been altered or corrupted since the signature was applied.')
    r.problems.push(chk.problem ?? 'The signature byte range is invalid.')
    if (!r.signerName) r.signerName = claimedSignerName(r, v)
    return null
  }
  r.revisionEnd = chk.end
  r.coversWholeFile = chk.end >= src.length || onlyWhitespaceAfter(src, chk.end)
  if (ctx.revs) {
    r.revisionCount = ctx.revs.sections.length
    r.revision = revisionNumberAt(ctx.revs, chk.end)
  }
  const holder = objectAt(src, r.byteRange[1])
  if (holder !== null && holder !== vNum) r.problems.push('The signed data does not belong to this signature field.')

  // A document timestamp is an RFC 3161 token signed by the authority, and an RFC 3161 token is
  // only a document timestamp. Any other combination is malformed and is not checked further: its
  // signer is no time-stamping authority, and no time in it can be relied on.
  const docTimeStamp = readName(v.get('Type')) === 'DocTimeStamp'
  if (docTimeStamp !== (r.subFilter === 'ETSI.RFC3161')) {
    r.problems.push(
      docTimeStamp
        ? 'This document timestamp is not an RFC 3161 timestamp (its format is not ETSI.RFC3161), so it cannot be checked.'
        : 'This signature uses the document timestamp format (ETSI.RFC3161) but is not a document timestamp, so it cannot be checked.'
    )
    if (!r.signerName) r.signerName = 'Unknown signer'
    return { end: chk.end }
  }

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
        // An RFC 3161 token's authority is the token's own signer (set by verifyCms). A token
        // nested in its SignerInfo is not that authority and is ignored.
        if (ver.timestamp && r.subFilter !== 'ETSI.RFC3161') {
          r.timestamp = {
            time: ver.timestamp.time.toISOString(),
            authority: ver.timestamp.authority,
            valid: ver.timestamp.valid,
            authorityOk: ver.timestamp.authorityOk,
            certificates: await Promise.all(ver.timestamp.chain.map((l) => describeCertificate(l.cert))),
            chainVerified: ver.timestamp.chain.map((l) => l.verified)
          }
        }
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
    const when = r.timestamp?.valid ? new Date(r.timestamp.time) : r.signingTime ? new Date(r.signingTime) : new Date()
    const { chain, complete } = await buildChain(signer, pool, when)
    r.chainComplete = complete
    r.chainVerified = chain.map((l) => l.verified)
    r.certificates = await Promise.all(chain.map((l) => describeCertificate(l.cert)))
    if (!r.signerName || r.kind !== 'timestamp') r.signerName = displayName(signer.subject)
    r.certValidAtSigning = when >= signer.notBefore && when <= signer.notAfter
    r.certExpiredNow = Date.now() > signer.notAfter.getTime()
    if (r.certValidAtSigning === false) r.warnings.push("The signer's certificate was not valid at the signing time.")
    const brokenLink = r.chainVerified.findIndex((ok, i) => !ok && (i < chain.length - 1 || complete))
    if (brokenLink >= 0) r.warnings.push('A certificate in the chain was not validly issued by the next one (its signature does not verify, or the issuer may not issue certificates).')
  }
  if (!r.signerName) r.signerName = 'Unknown signer'
  return { end: chk.end }
}

/** Revisions of a file, parsed once per file. */
const revisionCache = new WeakMap<Uint8Array, Promise<RevisionInfo | null>>()

function revisionsOf(src: Uint8Array): Promise<RevisionInfo | null> {
  let p = revisionCache.get(src)
  if (!p) {
    p = readRevisions(src).catch(() => null)
    revisionCache.set(src, p)
  }
  return p
}

export async function validateSignatures(s: Session): Promise<ValidationReport> {
  const pdf = s.pdf
  const fields = listSignatureFields(pdf, s)
  const src = s.sourceBytes
  // Only signed documents need the revision structure of the file.
  const revs: RevisionInfo | null = src && fields.some((f) => f.signed) ? await revisionsOf(src) : null
  // The certification is the signature whose own (signed) dictionary carries a DocMDP reference;
  // the catalog's /Perms can be changed or removed by a later update.
  let certified: Context['certified'] = null
  let certAt = Infinity
  for (const f of fields.filter((x) => x.signed)) {
    const vRef = f.field.resolve().get('V')
    // A timestamp with a DocMDP reference is reported as a problem by validateOne, not a certification.
    if (timestampLike(vRef.resolve())) continue
    const ref = readReferences(vRef).find((x) => x.method === 'DocMDP')
    const br = readByteRange(vRef.resolve())
    const at = br.length === 4 ? br[2] + br[3] : Infinity
    if (ref && (!certified || at < certAt)) {
      certified = { permission: ref.permission ?? 2, sigNum: vRef.isIndirect() ? vRef.asIndirect() : f.fieldNum }
      certAt = at
    }
  }
  const signedValue = (sigNum: number) =>
    fields.find((f) => {
      const v = f.field.resolve().get('V')
      return f.signed && v.isIndirect() && v.asIndirect() === sigNum
    })
  // The catalog's /Perms /DocMDP is only a pointer to the certification signature and is not
  // covered by any signature itself, so it never makes a certification on its own: a
  // certification needs a signed signature dictionary with its own DocMDP reference (found
  // above). When no signature makes one, a /Perms /DocMDP is a claim nothing backs: a timestamp it
  // names gets a warning in validateOne (and its P never locks the document), anything else (a
  // direct dictionary, another object, a signature without a DocMDP reference) a warning below.
  let rejectedCertification = -1
  let unbackedClaim: { sigNum: number } | null = null
  if (!certified) {
    const claim = certification(pdf)
    const named = claim && claim.sigNum > 0 ? signedValue(claim.sigNum) : undefined
    if (claim && named && timestampLike(named.field.resolve().get('V').resolve())) rejectedCertification = claim.sigNum
    else if (claim) unbackedClaim = { sigNum: named ? claim.sigNum : -1 }
  }
  const repaired = !!src && wasRepaired(pdf)
  const ctx: Context = { s, src, revs, certified, certEnd: 0, repaired, later: [], vNums: new Map(), rejectedCertification }
  if (certified && src) {
    const certField = signedValue(certified.sigNum)
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
      if (!r.signerName) r.signerName = 'Unknown signer'
      signatures.push(r)
    }
  }
  if (unbackedClaim) {
    for (const r of signatures) {
      if (unbackedClaim.sigNum > 0 && ctx.vNums.get(r) !== unbackedClaim.sigNum) continue
      r.warnings.push(
        unbackedClaim.sigNum > 0
          ? 'The document names this signature as its certification, but the signature carries no certification (DocMDP) reference. The document is not treated as certified.'
          : 'The document claims to be certified, but no signature in it certifies it. The document is not treated as certified.'
      )
    }
  }
  // A repair while checking one signature also affects the ones checked before it.
  if (src && wasRepaired(pdf)) {
    for (const r of signatures) {
      if (r.coversWholeFile || !r.revisionEnd) continue
      r.changes = []
      r.changesUnknown = true
    }
  }
  if (src) judgeLaterUpdates(ctx, signatures)
  signatures.sort((a, b) => (a.revisionEnd || Infinity) - (b.revisionEnd || Infinity))
  // Acrobat's "Rev. N" numbers the signatures that sign a revision of this file; one whose signed
  // bytes could not be found in it (copied from another file, or damaged) gets none.
  let rev = 0
  for (const r of signatures) r.signedVersion = r.revisionEnd ? ++rev : 0
  const certSig = signatures.find((x) => x.kind === 'certification')
  const locked = signatures.some((x) => x.lock?.permission === 1)
  return {
    signatures,
    unsigned: fields.filter((x) => !x.signed).map(({ field: _f, widget: _w, fieldNum: _n, ...rest }) => rest),
    checkedFile: !!src,
    revisionCount: revs?.sections.length ?? 0,
    certified: certified?.permission ?? null,
    certifiedBy: certSig?.signerName ?? null,
    // A DocMDP reference or /Perms entry that certifies nothing (a timestamp's) locks nothing either.
    locked: locked || certified?.permission === 1,
    validatedAt: Date.now()
  }
}

