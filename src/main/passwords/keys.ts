/**
 * Lookup keys for saved passwords. A saved password is found through any of several keys,
 * strongest first:
 *  - 'lock': the security parameters (LockInfo.security). A file with the same lock accepts exactly
 *    the same passwords, so a hit never goes stale. Survives copies, renames, moves and every save
 *    that keeps the encryption.
 *  - 'id': the trailer /ID[0], the file's permanent identifier. Survives saves by other programs
 *    and protecting again with the same password (AES-256 then gets new salts, so a new lock).
 *    Unrelated files can share one (templates, careless producers), so a miss only drops this key.
 *  - 'path': the normalised file path, for files without an /ID. The weakest; also only a key.
 *  - 'digital-id': a Digital ID (.p12/.pfx), by the SHA-256 of its certificate.
 *
 * Keys are hashed with a domain prefix, so the store file never holds /IDs or paths in clear and
 * the kinds can't collide.
 */
import { createHash } from 'node:crypto'
import { pathKey } from '@shared/paths'
import type { SavedPasswordTarget } from '@shared/passwords'
import type { LockInfo } from '@shared/types'

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

export interface PdfLockRef {
  lock?: LockInfo | null
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

/** Lookup keys for what the renderer asked about. */
export function targetKeys(target: SavedPasswordTarget, platform: string): string[] {
  if (target.kind === 'digital-id') return [digitalIdKey(target.certificateSha256)]
  return pdfKeys({ lock: target.lock, pathKey: target.path ? pathKey(target.path, platform) : null })
}
