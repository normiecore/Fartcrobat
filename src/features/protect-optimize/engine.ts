import type { Permission } from '@shared/types'
import { certificateEncryptionLabel, certificatePermissions } from '@engine/crypt'
import { defineOps, EngineError, withTransfer } from '@engine/define'
import type { Session } from '@engine/session'
import { isNull } from '@engine/util/pdf'
import { auditSpace, optimizeDocument } from './optimize'
import { encryptionLabel, FEATURE_ID, type OptimizeOptions, type PasswordLevel, type SecurityStatus } from './shared'

const PERMISSIONS: Permission[] = ['print', 'print-hq', 'edit', 'annotate', 'form', 'assemble', 'copy', 'accessibility']

/** PDF permission bits (ISO 32000-1, table 22) to flags. */
function permissionsFromBits(p: number): Record<Permission, boolean> {
  const has = (bit: number) => (p & (1 << (bit - 1))) !== 0
  return {
    print: has(3),
    edit: has(4),
    copy: has(5),
    annotate: has(6),
    form: has(9),
    accessibility: has(10),
    assemble: has(11),
    'print-hq': has(12)
  }
}

/** Opens the bytes the document was loaded from in a separate MuPDF document. */
function withSourceCopy<T>(s: Session, fn: (doc: InstanceType<Session['mupdf']['Document']>) => T): T {
  const bytes = s.sourceBytes
  if (!bytes) throw new EngineError('This document was not opened from a PDF file', 'NO_SOURCE')
  const doc = s.mupdf.Document.openDocument(bytes, 'application/pdf')
  try {
    return fn(doc)
  } finally {
    doc.destroy()
  }
}

function needsOpenPassword(s: Session): boolean {
  // Certificate-encrypted documents open with a key, never a password.
  if (s.pubsec) return false
  const bytes = s.sourceBytes
  if (!bytes) return false
  const key = `${FEATURE_ID}:needsOpenPassword`
  const cached = s.state.get(key) as { bytes: Uint8Array; value: boolean } | undefined
  if (cached && cached.bytes === bytes) return cached.value
  let value = false
  try {
    value = withSourceCopy(s, (d) => d.needsPassword())
  } catch {}
  s.state.set(key, { bytes, value })
  return value
}

function passwordLevel(auth: number): PasswordLevel {
  // 1: the file is not encrypted; 2: user (open) password; 4: owner (permissions) password.
  return auth & 4 || auth === 1 ? 'owner' : auth & 2 ? 'user' : 'none'
}

export default defineOps('protect-optimize', {
  /** Encryption, the permissions this session has, and those the file grants to everyone else. */
  security(s): SecurityStatus & { filePermissions: Record<Permission, boolean> } {
    if (s.pubsec) {
      // Certificate security: what the envelope that opened it allows. MuPDF sees the temporary
      // bridge (or no encryption at all), so neither it nor the source bytes are asked. Each
      // recipient's envelope has its own permissions; the file grants this one these.
      const { access, permissions } = certificatePermissions(s.pubsec.permissions)
      return {
        encrypted: true,
        method: encryptionLabel(certificateEncryptionLabel(s.pubsec.source)),
        needsOpenPassword: false,
        ownerAccess: access === 'owner',
        permissions: { ...permissions },
        filePermissions: { ...permissions }
      }
    }
    const doc = s.pdf
    let raw: string | null = null
    try {
      raw = doc.getMetaData('encryption') ?? null
    } catch {}
    const encrypted = !!raw && raw !== 'None'
    const permissions = {} as Record<Permission, boolean>
    for (const p of PERMISSIONS) {
      try {
        permissions[p] = doc.hasPermission(p)
      } catch {
        permissions[p] = true
      }
    }
    let filePermissions = { ...permissions }
    if (encrypted) {
      try {
        const enc = doc.getTrailer().get('Encrypt').resolve()
        if (!isNull(enc.get('P'))) filePermissions = permissionsFromBits(enc.get('P').asNumber() | 0)
      } catch {}
    }
    return {
      encrypted,
      method: encrypted ? encryptionLabel(raw) : null,
      needsOpenPassword: encrypted && needsOpenPassword(s),
      ownerAccess: PERMISSIONS.every((p) => permissions[p]),
      permissions,
      filePermissions
    }
  },

  /**
   * Checks a password against the file without touching the open document. With `apply`, a correct
   * permissions (owner) password also lifts the restrictions for this session.
   */
  checkPassword(s, password: string, opts: { apply?: boolean } = {}): { level: PasswordLevel } {
    // No password opens a certificate-encrypted document, and the bridge's passwords are never tried.
    if (s.pubsec) return { level: 'none' }
    const level = withSourceCopy(s, (d) => passwordLevel(d.authenticatePassword(password)))
    if (level === 'owner' && opts.apply) {
      // The same password derives the same file key, so this is safe on the live document.
      s.pdf.authenticatePassword(password)
      s.documentChanged()
    }
    return { level }
  },

  /** PDF Optimizer: returns optimized bytes of the document (the open document is unchanged). */
  async optimize(s, opts: OptimizeOptions, password?: string) {
    const { bytes, report } = await optimizeDocument(s, opts, password)
    return withTransfer({ bytes, report }, [bytes.buffer as ArrayBuffer])
  },

  /** Marks a document opened from optimized bytes as unsaved, so closing it asks to save. */
  markUnsaved(s) {
    s.markDirty()
  },

  /** Bytes used by images, fonts, page content... ("Audit space usage"). */
  audit(s) {
    return auditSpace(s)
  }
})
