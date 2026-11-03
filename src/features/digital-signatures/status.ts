/** Turns validation reports into Acrobat-style status levels and plain-language messages. */
import type { CertDetails } from './lib/x509'
import type { MdpPermission, SignatureReport, ValidationReport } from './types'

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

/**
 * Whether the signature's timestamp time can be relied on: the token verified, its signer is a
 * time-stamping certificate valid at that time, and that certificate is trusted (itself or through
 * its chain). Otherwise the time is only what the signer (or an unknown authority) claims.
 */
export function timestampTrusted(r: SignatureReport, trusted: Set<string>): boolean {
  if (!r.timestamp?.valid || !r.timestamp.authorityOk) return false
  if (r.kind === 'timestamp') return trustedIndex(r, trusted) >= 0
  return chainTrustedIndex(r.timestamp.certificates, r.timestamp.chainVerified, trusted) >= 0
}

/** The signing time to show: the trusted timestamp's time, else the time the signer claims. */
export function displayedSigningTime(r: SignatureReport, trusted: Set<string>): string | null {
  return timestampTrusted(r, trusted) ? r.timestamp!.time : r.signingTime
}

export function signatureStatus(r: SignatureReport, trusted: Set<string>): SignatureStatus {
  const details: string[] = []
  const restricted = r.permission !== null || r.lock !== null
  const disallowed = r.changes.filter((c) => !c.allowed)
  const ti = trustedIndex(r, trusted)
  const identityKnown = ti >= 0
  const isTimestamp = r.kind === 'timestamp'
  const tsTrusted = timestampTrusted(r, trusted)

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
  details.push(...r.problems)
  if (r.unknownReason) details.push(r.unknownReason)

  // Certification
  if (r.kind === 'certification') details.push(`The document is certified. ${permissionText(r.permission)}`)
  if (r.lock) details.push(r.lock.permission === 1 ? 'The signer locked the document: no further changes are allowed.' : 'The signer locked some form fields.')

  // Identity
  if (r.certificates.length) {
    if (identityKnown) details.push(isTimestamp ? 'The time-stamping authority is trusted.' : "The signer's identity is valid.")
    else
      details.push(
        isTimestamp
          ? 'The time-stamping authority is unknown because its certificate is not in your list of trusted certificates.'
          : "The signer's identity is unknown because it has not been included in your list of trusted certificates and none of its parent certificates are trusted certificates."
      )
  }
  details.push(...r.warnings)

  // Time
  if (r.timestamp) {
    const authority = r.timestamp.authority || 'a time-stamping authority'
    // A document timestamp's authority is the signer: the identity line above says whether it is trusted.
    details.push(
      !r.timestamp.valid
        ? 'The signature includes a timestamp, but it could not be verified.'
        : !r.timestamp.authorityOk
          ? `The signature includes a timestamp from ${authority}, but its certificate is not a time-stamping certificate that was valid at that time.${isTimestamp ? '' : ' The signing time is only what the signer claims.'}`
          : tsTrusted || isTimestamp
          ? `The signature includes an embedded timestamp from ${authority}.`
          : `The signature includes an embedded timestamp from ${authority}, but the time-stamping authority is unknown because its certificate is not in your list of trusted certificates. The signing time is only what the signer claims.`
    )
  } else if (!isTimestamp && r.signingTime) details.push("Signing time is from the clock on the signer's computer.")
  if (r.certExpiredNow && r.certValidAtSigning) details.push("The signer's certificate has expired since the document was signed.")

  let level: StatusLevel
  if (r.problems.length || r.integrity === false || r.signatureValid === false || (restricted && disallowed.length)) level = 'invalid'
  else if (r.unknownReason || r.integrity === null || r.signatureValid === null) level = 'unknown'
  else if (r.warnings.length || disallowed.length || (r.timestamp && !r.timestamp.valid)) level = 'warning'
  else level = identityKnown ? 'valid' : 'unknown-identity'

  const noun = isTimestamp ? 'Document timestamp' : r.kind === 'certification' ? 'Certification' : 'Signature'
  const title =
    level === 'valid'
      ? `${noun} is valid.`
      : level === 'unknown-identity'
        ? isTimestamp
          ? 'Document timestamp is valid, but the time-stamping authority is unknown.'
          : `${noun} is valid, but the signer's identity is unknown.`
        : level === 'warning'
          ? `${noun} is valid, but there are problems.`
          : level === 'unknown'
            ? `${noun} validity is unknown.`
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
  if (levels.includes('invalid')) return { level: 'invalid', message: `${certPrefix}At least one signature is invalid.` }
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
