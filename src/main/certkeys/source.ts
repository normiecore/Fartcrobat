// Where a person's private keys come from, for opening certificate-encrypted PDFs. Each source runs
// in the main process and keeps its keys there: only the unwrapped seed and permission bytes leave
// it (see src/shared/certkeys.ts and docs/features/passwordless.md).
import type { CertKeyActor, CertKeyCandidate, CertKeysErrorCode, CertKeySourceKind, CertKeyVia } from '@shared/certkeys'

export interface SourceDecryptOptions {
  /** A Digital ID password the person typed (Digital IDs only). */
  password?: string
  /** Save the typed password on this device once it worked (Digital IDs only). */
  remember?: boolean
  actor: CertKeyActor
  signal?: AbortSignal
}

/** The content of the envelope a key opened. */
export interface SourceDecryptResult {
  /** Index of the envelope (in the blobs given) that was opened. */
  envelope: number
  /** ContentInfo content: the 20-byte seed, then (usually) 4 permission bytes. */
  content: Uint8Array
  via: CertKeyVia
}

/** A failure the person can act on; `code` goes back to the renderer as is. */
/** A Windows store probe that did not finish in time (its CertKeyError TIMEOUT). */
export const STORE_BUSY =
  'The Windows certificate store did not answer in time. It may be waiting for a smart card PIN; try again when that is done.'

export class CertKeyError extends Error {
  constructor(
    readonly code: CertKeysErrorCode,
    message: string,
    readonly extra: { savedStale?: boolean } = {}
  ) {
    super(message)
    this.name = 'CertKeyError'
  }
}

export interface RecipientKeySource {
  readonly kind: CertKeySourceKind
  /** The person's keys that match a recipient of these envelopes. Never uses a key, never prompts. */
  probe(blobs: Uint8Array[]): Promise<CertKeyCandidate[]>
  /**
   * Unwraps one envelope with the candidate's key (`candidate.id` came from this source's probe).
   * May wait for the person (the Windows smart card PIN dialog). Throws CertKeyError.
   */
  decrypt(blobs: Uint8Array[], candidate: CertKeyCandidate, opts: SourceDecryptOptions): Promise<SourceDecryptResult>
}
