/** Turns validation reports into Acrobat-style status levels and plain-language messages. */
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

/** Index of the first certificate in the (verified part of the) chain that the user trusts. */
export function trustedIndex(r: SignatureReport, trusted: Set<string>): number {
  for (let i = 0; i < r.certificates.length; i++) {
    if (trusted.has(r.certificates[i].sha256)) return i
    // Trust only flows down through certificates whose signatures verified.
    if (!r.chainVerified[i]) return -1
  }
  return -1
}

export function signatureStatus(r: SignatureReport, trusted: Set<string>): SignatureStatus {
  const details: string[] = []
  const restricted = r.permission !== null || r.lock !== null
  const disallowed = r.changes.filter((c) => !c.allowed)
  const ti = trustedIndex(r, trusted)
  const identityKnown = ti >= 0
  const isTimestamp = r.kind === 'timestamp'

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
    details.push(
      r.timestamp.valid
        ? `The signature includes an embedded timestamp from ${r.timestamp.authority || 'a time-stamping authority'}.`
        : 'The signature includes a timestamp, but it could not be verified.'
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
  return { level, title, details, identityKnown, trustedIndex: ti }
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
