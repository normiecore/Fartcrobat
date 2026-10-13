/**
 * Lookup keys for saved passwords. Main process only (node:crypto).
 *
 * Port target: src/main/passwords/keys.ts
 *
 * A saved secret is found through any of several keys, strongest first:
 *  - 'lock': hash of the security parameters (LockInfo.security). A file with the same lock
 *    accepts exactly the same passwords, so a hit is never stale unless the record is wrong.
 *    Survives copies, renames, moves and every save that keeps the encryption.
 *  - 'id':   hash of the trailer /ID[0], the file's permanent identifier. Survives saves by
 *    Fartcrobat, Acrobat, qpdf and pypdf, including re-encryption with the same password
 *    (AES-256 re-encryption changes the lock: new random salts). Can be shared by unrelated
 *    files (template-made PDFs, buggy producers), so a miss here only drops this alias.
 *  - 'path': hash of the normalised file path (pathKey). For files without /ID that move
 *    nowhere; weakest, also only an alias.
 *  - 'digital-id': a Fartcrobat Digital ID (.p12/.pfx), by the SHA-256 of its certificate (the
 *    DigitalIdRecord id).
 *
 * Keys are hashed with a domain prefix so the store file never holds /IDs or paths in clear and
 * the kinds can't collide.
 */
import { createHash } from 'node:crypto'

export type KeyKind = 'lock' | 'id' | 'path' | 'digital-id'

/** Strength order: lookups try records found through stronger keys first. */
export const KEY_ORDER: readonly KeyKind[] = ['lock', 'id', 'path', 'digital-id']

const DOMAIN = 'fartcrobat/saved-password/v1'

export function deriveKey(kind: KeyKind, material: string): string {
  return `${kind}:` + createHash('sha256').update(`${DOMAIN}\0${kind}\0${material}`, 'utf8').digest('hex')
}

export function kindOf(key: string): KeyKind {
  return key.slice(0, key.indexOf(':')) as KeyKind
}

/** What the renderer knows about a locked PDF (LockInfo from the engine, plus where it was read from). */
export interface PdfLockRef {
  lock?: { handler: string; id: string | null; security: string } | null
  /** Normalised, platform-folded path (pathKey from @shared/paths); omit for in-memory documents. */
  pathKey?: string | null
}

/** Lookup keys for a PDF, strongest first. */
export function pdfKeys(ref: PdfLockRef): string[] {
  const keys: string[] = []
  if (ref.lock?.security) keys.push(deriveKey('lock', ref.lock.security))
  if (ref.lock?.id) keys.push(deriveKey('id', ref.lock.id.toLowerCase()))
  if (ref.pathKey) keys.push(deriveKey('path', ref.pathKey))
  return keys
}

export function digitalIdKey(certificateSha256: string): string {
  return deriveKey('digital-id', certificateSha256.toLowerCase())
}
