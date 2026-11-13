/** Turns validation reports into Acrobat-style status levels and plain-language messages. */
import type { CertDetails } from './lib/x509'
import { COPIED_SIGNATURE, type MdpPermission, type SignatureReport, type ValidationReport } from './types'

export type StatusLevel = 'valid' | 'unknown-identity' | 'warning' | 'unknown' | 'invalid'

export interface SignatureStatus {
  level: StatusLevel
  /** One-line verdict, e.g. "Signature is valid, but the signer's identity is unknown." */
  title: string
  /** Bulleted explanation (Acrobat's "Validity Summary"). */
  details: string[]
  identityKnown: boolean
  /** Index in report.certificates of the trusted certificate, or -1. */
  trustedIndex: number
  /** The embedded timestamp verified and its authority is trusted, so its time can be relied on. */
  timestampTrusted: boolean
}

export function permissionText(p: MdpPermission | null): string {
  switch (p) {
    case 1:
      return 'No changes are allowed.'
    case 2:
      return 'Filling in forms and signing are allowed.'
    case 3:
      return 'Filling in forms, signing and commenting are allowed.'
    default:
      return 'Any changes are allowed.'
  }
}

/**
 * Index of the first certificate in the (verified part of the) chain that the user trusts. A
 * trusted certificate above the signer only counts when it is a certificate authority.
 */
export function chainTrustedIndex(certificates: CertDetails[], chainVerified: boolean[], trusted: Set<string>): number {
  for (let i = 0; i < certificates.length; i++) {
    if (trusted.has(certificates[i].sha256) && (i === 0 || certificates[i].isCA)) return i
    // Trust only flows down through links that verified (signature and issuer constraints).
    if (!chainVerified[i]) return -1
  }
  return -1
}

export function trustedIndex(r: SignatureReport, trusted: Set<string>): number {
  return chainTrustedIndex(r.certificates, r.chainVerified, trusted)
}

/** The title of a signature whose document was changed after it was signed (other than by signing). */
export const CHANGED_AFTER_SIGNING = 'The document was changed after it was signed.'

/**
 * Whether anything other than later signatures was written after the signature's revision. Fails
 * closed: a report that does not say (an older report) counts as changed.
 */
export function changedAfterSigning(r: SignatureReport): boolean {
  return !r.coversWholeFile && r.revisionEnd > 0 && r.laterUpdates !== 'signing'
}

/**
 * A well-formed document timestamp: /Type /DocTimeStamp whose value is an RFC 3161 token, so the
 * signature's own certificate (r.certificates[0]) is the token's signer, the authority. A
 * /DocTimeStamp in any other format is malformed (the validator reports it as a problem): neither
 * its signer nor any timestamp embedded in it is a document timestamp authority.
 */
export function isDocumentTimestamp(r: SignatureReport): boolean {
  return r.kind === 'timestamp' && r.subFilter === 'ETSI.RFC3161'
}

/**
 * For a document timestamp: the token verified and its signer, the signature's own certificate, is
 * a time-stamping certificate valid at the token's time. A timestamp with a chain of its own
 * (r.timestamp.certificates) describes some other token, not this authority.
 */
function documentTimestampAuthorityOk(r: SignatureReport): boolean {
  return !!r.timestamp?.valid && r.timestamp.authorityOk && r.timestamp.certificates.length === 0
}

/**
 * Whether the signature's timestamp time can be relied on: the token verified, its signer is a
 * time-stamping certificate valid at that time, and that certificate is trusted (itself or through
 * its chain). Otherwise the time is only what the signer (or an unknown authority) claims.
 */
export function timestampTrusted(r: SignatureReport, trusted: Set<string>): boolean {
  // A document timestamp's authority chain is the signature's own chain.
  if (isDocumentTimestamp(r)) return documentTimestampAuthorityOk(r) && trustedIndex(r, trusted) >= 0
  if (!r.timestamp?.valid || !r.timestamp.authorityOk) return false
  // A token as the signature value of anything else, or a document timestamp in another format, is malformed.
  if (r.kind === 'timestamp' || r.subFilter === 'ETSI.RFC3161') return false
  return chainTrustedIndex(r.timestamp.certificates, r.timestamp.chainVerified, trusted) >= 0
}

/**
 * A document timestamp whose token verified but whose signer is not a time-stamping certificate
 * valid at the token's time. Its time cannot be relied on, whoever issued that certificate.
 */
export function timestampAuthorityInvalid(r: SignatureReport): boolean {
  return isDocumentTimestamp(r) && !!r.timestamp?.valid && !documentTimestampAuthorityOk(r)
}

/** The signing time to show: the trusted timestamp's time, else the time the signer claims. */
export function displayedSigningTime(r: SignatureReport, trusted: Set<string>): string | null {
  return timestampTrusted(r, trusted) ? r.timestamp!.time : r.signingTime
}

/**
 * A note to show after a document timestamp's time when that time is not vouched for (for a
 * document timestamp, the time shown is always the token's own), else ''.
 */
export function signingTimeNote(r: SignatureReport, trusted: Set<string>): string {
  if (r.kind !== 'timestamp' || !r.signingTime) return ''
  // A malformed document timestamp: the time shown is only the one its dictionary claims.
  if (!isDocumentTimestamp(r)) return '(could not be verified)'
  if (timestampTrusted(r, trusted)) return ''
  if (!r.timestamp?.valid) return '(could not be verified)'
  if (!documentTimestampAuthorityOk(r)) return '(not from a valid time-stamping certificate)'
  return '(the time-stamping authority is not trusted)'
}

/**
 * False when the bytes a signature signed are not in this file (copied in from another file, or
 * damaged): its certification, lock and the rest of its dictionary are then unverified claims.
 */
export function signedBytesFound(r: SignatureReport): boolean {
  return r.revisionEnd > 0 || r.integrity !== false
}

/** Whether the signature counts as a certification: one whose signed bytes are in this file. */
export function certifies(r: SignatureReport): boolean {
  return r.kind === 'certification' && signedBytesFound(r)
}

/** What the signature signed is not in this document, most likely copied in (see COPIED_SIGNATURE). */
export function isCopied(r: SignatureReport): boolean {
  return r.problems.includes(COPIED_SIGNATURE)
}

export function signatureStatus(r: SignatureReport, trusted: Set<string>): SignatureStatus {
  const details: string[] = []
  const changedLater = changedAfterSigning(r)
  // Anything at all written after a signature that allows no changes (certification P=1, a lock
  // with P=1, or made under either).
  const noChangesAllowed = r.permission === 1 || r.lock?.permission === 1 || r.permissionInForce === 1
  const anyLater = !r.coversWholeFile && r.revisionEnd > 0
  const restricted = r.permission !== null || r.lock !== null || !!r.restrictionsUnknown
  const disallowed = r.changes.filter((c) => !c.allowed)
  const isTimestamp = r.kind === 'timestamp'
  const isDocTimestamp = isDocumentTimestamp(r)
  // A document timestamp's identity is its authority: a certificate that may not sign timestamps
  // (or was not valid at that time) is no known authority, even if the person trusts it or its CA.
  // Nor is the signer of a document timestamp that is not an RFC 3161 token.
  const authorityInvalid = timestampAuthorityInvalid(r)
  const ti = authorityInvalid || (isTimestamp && !isDocTimestamp) ? -1 : trustedIndex(r, trusted)
  const identityKnown = ti >= 0
  const tsTrusted = timestampTrusted(r, trusted)
  // A document timestamp that is not an RFC 3161 token, or a token as an approval signature's value
  // (the validator also reports these as problems). A certification's /Type is not known here.
  const malformed = r.kind !== 'certification' && isTimestamp !== (r.subFilter === 'ETSI.RFC3161')

  // Integrity
  if (r.integrity === true) {
    if (r.coversWholeFile) details.push('The document has not been modified since this signature was applied.')
    else if (!disallowed.length) {
      details.push('This revision of the document has not been altered. There have been subsequent changes to the document.')
    } else if (restricted) {
      details.push(
        r.kind === 'certification'
          ? 'The document has been changed in ways the certifier did not allow.'
          : 'The document has been changed in ways this signature’s lock does not allow.'
      )
    } else details.push('The document has been modified since this signature was applied.')
  }
  if (r.changesUnknown) {
    details.push(
      restricted
        ? 'The document was changed after this signature was applied, and the changes cannot be checked against what the signer allowed.'
        : 'The document was changed after this signature was applied, and the changes cannot be checked.'
    )
  }
  if (changedLater && r.integrity === true) {
    details.push('The document was changed after this signature was applied. Use View Signed Version to see the document as it was signed and compare.')
  }
  if (noChangesAllowed && anyLater && r.integrity === true) details.push('The signer allowed no changes after signing, and the document was updated after this signature was applied.')
  details.push(...r.problems)
  if (r.unknownReason) details.push(r.unknownReason)

  // Certification. A signature whose signed bytes are not in this file (copied from another file, or
  // damaged) certifies and locks nothing that can be relied on, so neither is described.
  if (certifies(r)) details.push(`The document is certified. ${permissionText(r.permission)}`)
  if (r.lock && signedBytesFound(r)) details.push(r.lock.permission === 1 ? 'The signer locked the document: no further changes are allowed.' : 'The signer locked some form fields.')

  // Identity
  if (r.certificates.length) {
    if (authorityInvalid)
      details.push(
        "The time-stamping authority's certificate is not a time-stamping certificate that was valid at the timestamp time, so the time cannot be relied on."
      )
    else if (identityKnown) details.push(isTimestamp ? 'The time-stamping authority is trusted.' : "The signer's identity is valid.")
    else
      details.push(
        isTimestamp
          ? 'The time-stamping authority is unknown because its certificate is not in your list of trusted certificates.'
          : "The signer's identity is unknown because it has not been included in your list of trusted certificates and none of its parent certificates are trusted certificates."
      )
  }
  details.push(...r.warnings)

  // Time
  if (r.timestamp && !authorityInvalid) {
    const authority = r.timestamp.authority || 'a time-stamping authority'
    // A document timestamp's authority is the signer: the identity line above says whether it is trusted.
    details.push(
      !r.timestamp.valid
        ? 'The signature includes a timestamp, but it could not be verified.'
        : !r.timestamp.authorityOk
          ? `The signature includes a timestamp from ${authority}, but its certificate is not a time-stamping certificate that was valid at that time. The signing time is only what the signer claims.`
          : tsTrusted || isDocTimestamp
          ? `The signature includes an embedded timestamp from ${authority}.`
          : `The signature includes an embedded timestamp from ${authority}, but the time-stamping authority is unknown because its certificate is not in your list of trusted certificates. The signing time is only what the signer claims.`
    )
  } else if (!isTimestamp && r.signingTime) details.push("Signing time is from the clock on the signer's computer.")
  if (r.certExpiredNow && r.certValidAtSigning) details.push("The signer's certificate has expired since the document was signed.")

  let level: StatusLevel
  // Changes that cannot be checked count as changes that are not allowed.
  const unchecked = r.changesUnknown
  if (
    malformed ||
    r.problems.length ||
    r.integrity === false ||
    r.signatureValid === false ||
    (restricted && (disallowed.length || unchecked)) ||
    (noChangesAllowed && anyLater)
  )
    level = 'invalid'
  else if (r.unknownReason || r.integrity === null || r.signatureValid === null) level = 'unknown'
  // Fail closed: anything written after the signature other than later signatures, described or
  // not, allowed by the signer or not, is at best a warning.
  else if (
    r.warnings.length ||
    disallowed.length ||
    unchecked ||
    changedLater ||
    (r.timestamp && !r.timestamp.valid) ||
    authorityInvalid
  )
    level = 'warning'
  else level = identityKnown ? 'valid' : 'unknown-identity'

  const noun = isTimestamp ? 'Document timestamp' : certifies(r) ? 'Certification' : 'Signature'
  const title =
    level === 'valid'
      ? `${noun} is valid.`
      : level === 'unknown-identity'
        ? isTimestamp
          ? 'Document timestamp is valid, but the time-stamping authority is unknown.'
          : `${noun} is valid, but the signer's identity is unknown.`
        : level === 'warning'
          ? changedLater
            ? CHANGED_AFTER_SIGNING
            : `${noun} is valid, but there are problems.`
          : level === 'unknown'
            ? `${noun} validity is unknown.`
            : isCopied(r)
              ? `${noun} is invalid: what was signed is not in this document.`
              : `${noun} is invalid.`
  return { level, title, details, identityKnown, trustedIndex: ti, timestampTrusted: tsTrusted }
}

export interface OverallStatus {
  level: StatusLevel
  message: string
}

/** The document message bar: "Signed and all signatures are valid." and friends. */
export function overallStatus(report: ValidationReport | null, trusted: Set<string>): OverallStatus | null {
  if (!report || !report.signatures.length) return null
  const levels = report.signatures.map((s) => signatureStatus(s, trusted).level)
  const certPrefix = report.certified ? `Certified by ${report.certifiedBy ?? 'the author'}. ${permissionText(report.certified)} ` : ''
  if (levels.includes('invalid')) {
    const invalid = report.signatures.filter((_, i) => levels[i] === 'invalid')
    return {
      level: 'invalid',
      message: invalid.every(isCopied)
        ? `${certPrefix}At least one signature is invalid: what was signed is not in this document, usually because the signature was copied from another document.`
        : `${certPrefix}At least one signature is invalid.`
    }
  }
  if (levels.includes('warning') || levels.includes('unknown')) return { level: 'warning', message: `${certPrefix}At least one signature has problems.` }
  if (levels.includes('unknown-identity')) {
    const n = levels.filter((l) => l === 'unknown-identity').length
    return {
      level: 'unknown-identity',
      message: `${certPrefix}Signed and all signatures are valid, but ${n === 1 && levels.length === 1 ? "the signer's identity is" : 'the identity of at least one signer is'} unknown.`
    }
  }
  return { level: 'valid', message: `${certPrefix}Signed and all signatures are valid.` }
}
