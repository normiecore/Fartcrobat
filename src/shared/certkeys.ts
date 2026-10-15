// Certificate encryption (PDF public-key security, /Filter /Adobe.PubSec): what the renderer, the
// engine and the main process exchange. See docs/features/passwordless.md.
//
// Secrets: private keys, Digital ID passwords and smart card PINs never leave the main process
// (src/main/certkeys/). The renderer and the engine only ever see the 20-byte seed and the 4
// permission bytes that a person's key unwrapped from an envelope (CertificateKey); the engine
// derives the file key from them and keeps it in its Session. Nothing here is ever logged.

/** What the engine says about a certificate-encrypted file it cannot open yet. Public data only. */
export interface CertificateLock {
  /** The /Recipients entries (DER CMS ContentInfo with EnvelopedData), in file order. */
  recipients: Uint8Array[]
  /** /V of the encryption dictionary: 1, 2, 4 or 5. */
  version: number
  /** Cipher of strings and streams. */
  cipher: 'RC4' | 'AESV2' | 'AESV3'
  /** File key length in bits (40 to 128 for RC4, 128 for AESV2, 256 for AESV3). */
  keyBits: number
}

/**
 * A key that opens certificate-encrypted files: the seed a person's private key unwrapped from one
 * envelope. It opens every file whose /Recipients contain that same envelope (copies, saved
 * versions, pages extracted from it), so the engine keeps it by envelope. Secret: never log, show,
 * persist or send it anywhere but an engine of this window.
 */
export interface CertificateKey {
  /** The /Recipients entry (DER) the seed came from. */
  envelope: Uint8Array
  /** The 20-byte seed. */
  seed: Uint8Array
  /** The 4 permission bytes that follow the seed in the envelope (big-endian, unsigned), or null when absent. */
  permissions: number | null
}

/**
 * Public-key handler permission bits (ISO 32000-2, table 24). Bit 2 (value 2) lets the recipient
 * change the security and grants everything else; the other bits match the Standard handler's /P.
 */
export const PUBSEC_PERMISSION = {
  changeSecurity: 1 << 1,
  print: 1 << 2,
  modify: 1 << 3,
  copy: 1 << 4,
  annotate: 1 << 5,
  fillForms: 1 << 8,
  accessibility: 1 << 9,
  assemble: 1 << 10,
  printHighRes: 1 << 11
} as const

export type PubSecPermission = keyof typeof PUBSEC_PERMISSION

/**
 * The most /Recipients a certificate-encrypted file may have for Fartcrobat to open it. The engine
 * refuses larger ones (CERTIFICATE_UNSUPPORTED) and the main process refuses larger certkeys:*
 * requests. Real files have a few envelopes of a few kilobytes.
 */
export const PUBSEC_RECIPIENT_LIMITS = {
  envelopes: 100,
  /** Bytes per envelope, and in all. */
  envelopeBytes: 1024 * 1024,
  totalBytes: 4 * 1024 * 1024
} as const

/** One RecipientInfo of a /Recipients entry, as people are shown it (no secrets). */
export interface PubSecRecipient {
  /** Index of the /Recipients entry (envelope) and of the RecipientInfo inside it. */
  envelope: number
  index: number
  /** How the recipient's certificate is named. */
  idType: 'issuerAndSerialNumber' | 'subjectKeyIdentifier' | 'keyAgreement' | 'other'
  /** Issuer distinguished name as text, e.g. "CN=Contoso CA, O=Contoso" (issuerAndSerialNumber). */
  issuer?: string
  /** Serial number, uppercase hex without leading zero bytes (issuerAndSerialNumber). */
  serial?: string
  /** SubjectKeyIdentifier, uppercase hex (subjectKeyIdentifier). */
  ski?: string
  /**
   * Key transport: 'rsa' (PKCS#1 v1.5), 'rsa-oaep'; 'ec' is key agreement (ECDH), which Fartcrobat
   * cannot open; 'other' anything else.
   */
  keyType: 'rsa' | 'rsa-oaep' | 'ec' | 'other'
}

/** Where a person's private keys come from. */
export type CertKeySourceKind = 'digital-id' | 'windows-store'

/** Who asked to open the file: the person at the keyboard or an AI agent (agent access). */
export type CertKeyActor = 'person' | 'agent'

/** One of the person's keys that matches a recipient. Found without using any key or prompting. */
export interface CertKeyCandidate {
  /**
   * Opaque id to pass back to certkeys:decrypt: "digital-id:<certificate SHA-256 hex>" or
   * "windows-store:<certificate SHA-1 thumbprint>".
   */
  id: string
  source: CertKeySourceKind
  /** Digital ID name, or the certificate's common name ("Alice Test"). */
  label: string
  /** Certificate subject DN as text. */
  subject: string
  /** Certificate issuer DN as text. */
  issuer: string
  /** Uppercase hex: the SHA-1 thumbprint for the Windows store, the SHA-256 fingerprint for a Digital ID. */
  fingerprint: string
  /** Index of the envelope and RecipientInfo it matches. */
  envelope: number
  index: number
  /** What using the key needs: nothing, the Digital ID's password, or a smart card PIN (Windows asks for it). */
  needs: 'nothing' | 'password' | 'pin'
  /** Digital ID whose password is saved on this device (needs 'password', but used without asking). */
  passwordSaved?: boolean
  /** The key is on a smart card or other hardware; null when that cannot be known before using it. */
  hardware: boolean | null
  /** RSA keys can open files; EC keys are listed so the person is told why they cannot. */
  keyType: 'rsa' | 'ec' | 'other'
  /** The certificate has expired (it still decrypts). */
  expired?: boolean
}

export interface CertKeysProbeRequest {
  /** The file's /Recipients entries (CertificateLock.recipients). */
  blobs: Uint8Array[]
}

export interface CertKeysProbeResult {
  /** Best first: Windows store keys, then Digital IDs with a saved password, then other Digital IDs. */
  candidates: CertKeyCandidate[]
  /** Everyone the file is encrypted for, to tell the person when none of their keys match. */
  recipients: PubSecRecipient[]
  /**
   * Whether the Windows certificate store could be searched ('constrained' or 'unavailable' explain
   * why it found nothing). Absent from older main processes.
   */
  windowsStore?: WindowsStoreState
}

export interface CertKeysDecryptRequest {
  blobs: Uint8Array[]
  /** CertKeyCandidate.id from certkeys:probe. */
  candidate: string
  /** A Digital ID password typed by the person. Without it, a password saved on this device is used. */
  password?: string
  /** Save the typed password on this device after it worked (Digital IDs). */
  remember?: boolean
  actor: CertKeyActor
  /**
   * Names this request for certkeys:cancel (letters, digits, '-' and '_', at most 64). Cancelling a
   * Windows store request stops the helper, so a smart card PIN entered in it is asked again.
   */
  requestId?: string
}

/**
 * Why certkeys:decrypt failed. From the Windows helper: CANCELLED (the person cancelled the PIN or
 * consent dialog), WRONG_PIN, PIN_BLOCKED, CARD_NOT_PRESENT, KEY_UNAVAILABLE, NO_MATCHING_CERT,
 * UNSUPPORTED (EC, unknown algorithms), CONSTRAINED_LANGUAGE, POWERSHELL_UNAVAILABLE, TIMEOUT. For
 * Digital IDs: PASSWORD_NEEDED (none given and none saved, or the saved one stopped working, see
 * savedStale), WRONG_PASSWORD, ID_UNAVAILABLE (its file is missing or unreadable). ERROR: anything
 * else.
 */
export type CertKeysErrorCode =
  | 'CANCELLED'
  | 'WRONG_PIN'
  | 'PIN_BLOCKED'
  | 'CARD_NOT_PRESENT'
  | 'KEY_UNAVAILABLE'
  | 'NO_MATCHING_CERT'
  | 'UNSUPPORTED'
  | 'CONSTRAINED_LANGUAGE'
  | 'POWERSHELL_UNAVAILABLE'
  | 'TIMEOUT'
  | 'PASSWORD_NEEDED'
  | 'WRONG_PASSWORD'
  | 'ID_UNAVAILABLE'
  | 'ERROR'

export type CertKeysDecryptResult =
  | {
      ok: true
      /** Index of the envelope (in the request's blobs) the seed came from. */
      envelope: number
      /** 20 bytes. Secret. */
      seed: Uint8Array
      /** The 4 permission bytes (big-endian, unsigned), null when the envelope has none. */
      permissions: number | null
      /** Which key opened it, for the audit log and the Protect panel (no secrets). */
      via: CertKeyVia
    }
  | {
      ok: false
      code: CertKeysErrorCode
      /** A saved Digital ID password no longer worked and was forgotten. */
      savedStale?: boolean
      /** Plain-language message for the person (no paths, no secrets). */
      message: string
    }

/** Which key opened a certificate-encrypted file. */
export interface CertKeyVia {
  source: CertKeySourceKind
  /** Digital ID name or certificate common name. */
  label: string
  subject: string
  /** As in CertKeyCandidate.fingerprint. */
  fingerprint: string
  /** A smart card or other hardware key (known after it was used). */
  hardware: boolean
  /** A Digital ID was opened with a password saved on this device. */
  savedPassword?: boolean
  /** The person typed a Digital ID password and asked to remember it, and it was saved. */
  remembered?: boolean
}

/** Whether the Windows certificate store can be used. */
export type WindowsStoreState =
  /** Windows, the preference is on, and the helper works (or has not been tried yet). */
  | 'available'
  | 'not-windows'
  /** Preferences > Digital IDs: "Use certificates from the Windows certificate store" is off. */
  | 'off'
  /** PowerShell runs in Constrained Language Mode (AppLocker, WDAC): the helper cannot run. */
  | 'constrained'
  /** PowerShell could not be started (blocked, missing) or the helper keeps failing. */
  | 'unavailable'
  /**
   * Only in a certkeys:probe result: the helper did not answer in time, usually because it was
   * busy with another request (a smart card waiting for its PIN), so the store was not searched.
   */
  | 'busy'

export interface CertKeysStatus {
  windowsStore: WindowsStoreState
  /** Digital IDs listed in Preferences > Digital IDs. */
  digitalIds: number
  /**
   * The Windows helper is running. A smart card unlocked with its PIN stays unlocked until the
   * helper stops ("Lock smart card", or quitting Fartcrobat).
   */
  helperRunning: boolean
}

/** A certificate from the Windows store that files can be encrypted for (Protect > Encrypt with Certificate). */
export interface EncryptionCertificate {
  /** 'CurrentUser\\My' (the person's own) or 'CurrentUser\\AddressBook' (Other People). */
  store: string
  thumbprint: string
  subject: string
  issuer: string
  /** Uppercase hex. */
  serial: string
  notBefore: string
  notAfter: string
  /** 'rsa', 'ec' or 'other': only RSA certificates can be added as recipients. */
  keyType: 'rsa' | 'ec' | 'other'
  email: string
  friendlyName: string
  hasPrivateKey: boolean
  /** DER. */
  der: Uint8Array
}

/** The line the agent audit log gets for a certificate open (no secrets). */
export function certificateAuditSummary(via: CertKeyVia): string {
  if (via.source === 'windows-store') {
    const where = via.hardware ? 'a smart card' : 'the Windows certificate store'
    return `opened with certificate ${via.subject} (${via.fingerprint}) from ${where}`
  }
  return `opened with Digital ID ${via.label}${via.savedPassword ? ' (password saved on this device)' : ''}`
}

/** "Digital ID “Alice Test”" or "Alice Test (smart card)", for the Protect panel's "Opened with". */
export function describeCertKey(via: CertKeyVia): string {
  if (via.source === 'digital-id') return `Digital ID “${via.label}”`
  return via.hardware ? `${via.label} (smart card)` : `${via.label} (Windows certificate store)`
}
