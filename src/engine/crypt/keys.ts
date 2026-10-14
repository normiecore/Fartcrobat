// The keys an engine (one Web Worker per tab) holds for certificate-encrypted files, and what a
// key's permission bytes allow. A CertificateKey is the seed one envelope gave a person's private
// key; it opens every file whose /Recipients contain that same envelope (copies, saved versions,
// pages extracted from it), so keys are found by envelope.
import { PUBSEC_PERMISSION, type CertificateKey } from '@shared/certkeys'
import type { PasswordAccess, Permission } from '@shared/types'
import { EngineError } from '../define'
import { bytesEqual } from './primitives'

/** Checks the shape of a key from the UI thread and copies it (the caller may reuse its buffers). */
export function copyCertificateKey(key: CertificateKey): CertificateKey {
  const ok =
    key &&
    key.envelope instanceof Uint8Array &&
    key.envelope.length > 0 &&
    key.seed instanceof Uint8Array &&
    key.seed.length === 20 &&
    (key.permissions === null || (Number.isInteger(key.permissions) && key.permissions >= 0 && key.permissions <= 0xffffffff))
  if (!ok) throw new EngineError('This is not a certificate key', 'BAD_CERTIFICATE_KEY')
  return { envelope: key.envelope.slice(), seed: key.seed.slice(), permissions: key.permissions }
}

/**
 * Every key the engine was given, for the life of the worker (it survives closing and reloading
 * the document). Secret: never logged, never sent back to the UI thread.
 */
export class CertificateKeyRegistry {
  private keys: CertificateKey[] = []

  /** Keeps a key (a copy). The same key added again moves to the front. */
  add(key: CertificateKey): void {
    const k = copyCertificateKey(key)
    this.keys = [k, ...this.keys.filter((x) => !(bytesEqual(x.envelope, k.envelope) && bytesEqual(x.seed, k.seed)))]
  }

  /** Keys whose envelope is one of `recipients` (identical bytes), most recently added first. */
  find(recipients: Uint8Array[]): CertificateKey[] {
    return this.keys.filter((k) => recipients.some((r) => bytesEqual(r, k.envelope)))
  }

  get size(): number {
    return this.keys.length
  }
}

export interface CertificatePermissions {
  /** 'owner': the recipient may change the security, which grants everything. */
  access: PasswordAccess
  permissions: Record<Permission, boolean>
  /** The same permissions as a Standard handler /P (signed 32-bit), for the R6 bridge. */
  standardP: number
}

const BITS: [Permission, number][] = [
  ['print', PUBSEC_PERMISSION.print],
  ['edit', PUBSEC_PERMISSION.modify],
  ['copy', PUBSEC_PERMISSION.copy],
  ['annotate', PUBSEC_PERMISSION.annotate],
  ['form', PUBSEC_PERMISSION.fillForms],
  ['accessibility', PUBSEC_PERMISSION.accessibility],
  ['assemble', PUBSEC_PERMISSION.assemble],
  ['print-hq', PUBSEC_PERMISSION.printHighRes]
]

/**
 * What an envelope's permission bytes allow (ISO 32000-2, table 24). Bit 2 (change security), or
 * no permission bytes at all, means full access; otherwise bits 3 to 6 and 9 to 12 are the same
 * permissions as the Standard handler's /P.
 */
export function certificatePermissions(bits: number | null): CertificatePermissions {
  const full = bits === null || (bits & PUBSEC_PERMISSION.changeSecurity) !== 0
  const permissions = {} as Record<Permission, boolean>
  let standardP = 0xfffff0c0 | 0 // reserved bits set, bits 1 and 2 clear
  for (const [p, bit] of BITS) {
    permissions[p] = full || ((bits as number) & bit) !== 0
    if (permissions[p]) standardP |= bit
  }
  return { access: full ? 'owner' : 'user', permissions, standardP: full ? -4 : standardP | 0 }
}

/**
 * The permission bytes of a new envelope (CertificateGroup): anything not set to false is
 * allowed, high-quality printing follows printing unless given. Reserved bits are set, and bit 13
 * ("tolerate a missing PDF MAC"), as Acrobat and pyHanko write them. The inverse of
 * certificatePermissions.
 */
export function certificatePermissionBits(allow: Partial<Record<Permission, boolean>>, changeSecurity = false): number {
  let bits = 0xffffe0c1 | 0x1000
  if (changeSecurity) bits |= PUBSEC_PERMISSION.changeSecurity
  for (const [p, bit] of BITS) {
    const on = p === 'print-hq' ? (allow['print-hq'] ?? allow.print) : allow[p]
    if (on !== false) bits |= bit
  }
  return bits >>> 0
}
