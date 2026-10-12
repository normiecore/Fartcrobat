import type { Rect } from '@shared/geometry'
import type { KeyAlg } from './lib/crypto'
import type { CertDetails } from './lib/x509'

export const FEATURE_ID = 'digital-signatures'
export const STORE_IDS = 'digital-signatures:ids'
export const STORE_TRUSTED = 'digital-signatures:trusted'
export const STORE_PREFS = 'digital-signatures:prefs'
/** Saved handwritten signature from Fill & Sign (data URL or PNG bytes). */
export const STORE_FILLSIGN_SIGNATURE = 'fill-sign:signature'

/** A Digital ID the user added (the private key stays in the .p12/.pfx file). */
export interface DigitalIdRecord {
  /** SHA-256 fingerprint of the certificate. */
  id: string
  /** Location of the .p12/.pfx file. */
  path: string
  name: string
  email: string
  organization: string
  issuer: string
  notBefore: string
  notAfter: string
  keyType: string
  /** Base64 DER certificate (public), for exporting without the password. */
  certificate: string
  selfSigned: boolean
  /** Created by Fartcrobat in the user data folder (removing it deletes the file). */
  createdByApp: boolean
  addedAt: number
}

export interface TrustedCertificate {
  /** SHA-256 fingerprint, uppercase hex. */
  fingerprint: string
  name: string
  issuer: string
  addedAt: number
}

export type AppearanceGraphic = 'name' | 'image' | 'none'

/** What the visible signature shows (Acrobat's "Configure Signature Appearance"). */
export interface AppearanceOptions {
  graphic: AppearanceGraphic
  /** PNG or JPEG bytes for graphic 'image'. */
  image?: Uint8Array | null
  showName: boolean
  showDate: boolean
  showReason: boolean
  showLocation: boolean
  showLabels: boolean
  showDistinguishedName: boolean
}

export interface AppearanceContent {
  options: AppearanceOptions
  /** Signer name (certificate common name). */
  name: string
  distinguishedName?: string
  reason?: string
  location?: string
  /** Signing time (ms since epoch). */
  time: number
  certify?: boolean
}

export type SignTarget =
  | { kind: 'field'; name: string }
  | { kind: 'new'; page: number; rect: Rect }
  | { kind: 'invisible' }

export type MdpPermission = 1 | 2 | 3

export interface SignRequest {
  mode: 'sign' | 'certify'
  target: SignTarget
  key: { pkcs8: Uint8Array; alg: KeyAlg }
  /** Signer certificate first, then issuers (DER). */
  chain: Uint8Array[]
  appearance: AppearanceContent
  reason?: string
  location?: string
  contactInfo?: string
  /** Certification: allowed changes. */
  permission?: MdpPermission
  /** Lock the document after signing (field lock + FieldMDP). */
  lock?: boolean
  subFilter?: 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached'
  /** Signing time (ms since epoch); defaults to now. */
  time?: number
}

export interface SignResult {
  bytes: Uint8Array
  fieldName: string
}

export interface SignatureFieldInfo {
  name: string
  /** Widget object number (also the form field annotation id). */
  widgetId: number
  page: number
  /** Page-space rectangle (top-left origin). */
  rect: Rect
  invisible: boolean
  signed: boolean
  /** Name in the signature dictionary (/Name) or empty. */
  signerName: string
  locked: boolean
}

/** Whether the document can be signed and how. */
export interface SignCapability {
  canSign: boolean
  canCertify: boolean
  reason: string | null
  certifyReason: string | null
  /** Certification permission of the document (when certified). */
  certified: MdpPermission | null
  /** A signature locked the document. */
  locked: boolean
  /** Adding a new signature field breaks the certification (P < 3). */
  newFieldBreaksCertification: boolean
  fields: SignatureFieldInfo[]
}

export type ChangeCategory =
  | 'signature'
  | 'form'
  | 'annotation'
  | 'content'
  | 'pages'
  | 'page'
  | 'metadata'
  | 'dss'
  | 'deleted'
  | 'other'

export interface ChangeEntry {
  category: ChangeCategory
  description: string
  page?: number
  /** Allowed by the signer/certifier (or harmless for approval signatures). */
  allowed: boolean
}

export interface SignatureReport {
  fieldName: string
  widgetId: number
  page: number
  rect: Rect
  invisible: boolean
  kind: 'approval' | 'certification' | 'timestamp'
  /** Name from the certificate (or /Name when there is no certificate). */
  signerName: string
  reason: string
  location: string
  contactInfo: string
  /** ISO time the signer's computer claims (signed attribute or /M). */
  signingTime: string | null
  timestamp: { time: string; authority: string; valid: boolean } | null
  subFilter: string
  digestAlgorithm: string
  signatureAlgorithm: string
  /** File revision (1 = the original file) that this signature completed. */
  revision: number
  revisionCount: number
  /** Acrobat's "Rev. N": position of this signature among the document's signatures (1-based). */
  signedVersion: number
  byteRange: number[]
  /** Offset just after the signed revision. */
  revisionEnd: number
  coversWholeFile: boolean
  /** Hash of the signed bytes matches (null: could not check). */
  integrity: boolean | null
  /** Cryptographic signature verified with the signer certificate (null: could not check). */
  signatureValid: boolean | null
  /** Signer first. */
  certificates: CertDetails[]
  /** For each certificate in `certificates`, whether its issuer's signature verified. */
  chainVerified: boolean[]
  chainComplete: boolean
  certValidAtSigning: boolean | null
  certExpiredNow: boolean
  /** Certification permission (certification signatures). */
  permission: MdpPermission | null
  lock: { action: string; fields: string[]; permission: MdpPermission | null } | null
  changes: ChangeEntry[]
  /** Details could not be determined for later changes. */
  changesUnknown: boolean
  /** Fatal problems (signature invalid). */
  problems: string[]
  /** Problems that make the signature questionable. */
  warnings: string[]
  /** Unsupported algorithm or missing data: the result is unknown. */
  unknownReason: string | null
}

export interface ValidationReport {
  signatures: SignatureReport[]
  unsigned: SignatureFieldInfo[]
  /** The signatures were checked against the bytes on disk. */
  checkedFile: boolean
  revisionCount: number
  certified: MdpPermission | null
  certifiedBy: string | null
  locked: boolean
  validatedAt: number
}
