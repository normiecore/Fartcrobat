/**
 * Certificate security in the Protect tools: the recipients and permission groups of Protect >
 * Encrypt with Certificate, the person's own certificate, and what the Protect panel says about a
 * certificate-encrypted document. Pure: no DOM, no IPC (the dialog and flows.tsx do those).
 */
import type { CertKeyCandidate, CertKeysProbeResult, CertKeyVia, EncryptionCertificate, PubSecRecipient } from '@shared/certkeys'
import type { CertificateGroup, DocInfo, Permission } from '@shared/types'
import type { DocUnlock } from '@renderer/sdk'
import { fromBase64 } from '@features/digital-signatures/lib/asn1'
import type { DigitalIdRecord } from '@features/digital-signatures/types'
import { certificateInfo, isExpired, type CertificateInfo } from './certificateFiles'
import { encryptionLabel, restrictionList, sentenceList, type PrintingAllowed, type SecurityStatus } from './shared'

const PERMISSIONS: Permission[] = ['print', 'print-hq', 'edit', 'annotate', 'form', 'assemble', 'copy', 'accessibility']

export const EC_REASON = 'Elliptic-curve certificates cannot be used for certificate encryption yet.'
export const OTHER_KEY_REASON = 'Only certificates with RSA keys can be used for certificate encryption.'
export const OWN_REMOVED_WARNING = 'You will not be able to open this file yourself unless you have another certificate in the recipient list.'
export const REPLACE_CERTIFICATE_SECURITY = 'This replaces the certificate security with a password.'

// ---- recipients ---------------------------------------------------------------------------------

/** Where a recipient's certificate came from. */
export type RecipientSource = 'digital-id' | 'windows-store' | 'other-people' | 'file'

export interface Recipient {
  /** The certificate's SHA-256 (uppercase hex): a certificate is a recipient once, in one group. */
  id: string
  cert: CertificateInfo
  source: RecipientSource
  /** The Digital ID's name, the store's name, or the file's name. */
  sourceLabel: string
  /** One of the person's own keys: a Digital ID, or a personal store certificate with a private key. */
  mine: boolean
  /** How a file encrypted for this certificate would say it was opened (own certificates only; no secrets). */
  via?: CertKeyVia
}

/** Why a certificate cannot be a recipient, or null when it can. */
export function recipientRefusal(cert: Pick<CertificateInfo, 'keyType'>): string | null {
  if (cert.keyType === 'rsa') return null
  return cert.keyType === 'ec' ? EC_REASON : OTHER_KEY_REASON
}

/** Warnings shown next to a recipient that can still be added. */
export function recipientWarnings(cert: CertificateInfo, now: number = Date.now()): string[] {
  const out: string[] = []
  if (isExpired(cert, now)) out.push(`This certificate expired on ${formatDay(cert.notAfter)}. The file can still be encrypted for it.`)
  if (!cert.keyEncipherment) out.push('This certificate is not meant for encryption. Some apps may not open the file with it.')
  return out
}

function formatDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** A Digital ID from Preferences > Digital IDs (null when its certificate cannot be read). */
export function recipientFromDigitalId(rec: DigitalIdRecord): Recipient | null {
  let cert: CertificateInfo
  try {
    cert = certificateInfo(fromBase64(rec.certificate))
  } catch {
    return null
  }
  return {
    id: cert.sha256,
    cert,
    source: 'digital-id',
    sourceLabel: rec.name || cert.name,
    mine: true,
    via: { source: 'digital-id', label: rec.name || cert.name, subject: cert.subject, fingerprint: cert.sha256, hardware: false }
  }
}

/** A certificate from the Windows store: the person's own ('CurrentUser\\My') or Other People. */
export function recipientFromStore(c: EncryptionCertificate): Recipient | null {
  let cert: CertificateInfo
  try {
    cert = certificateInfo(c.der)
  } catch {
    return null
  }
  const personal = /\\My$/i.test(c.store)
  const mine = personal && c.hasPrivateKey
  return {
    id: cert.sha256,
    cert: { ...cert, email: cert.email || c.email },
    source: personal ? 'windows-store' : 'other-people',
    sourceLabel: personal ? 'Windows certificate store' : 'Other People (Windows)',
    mine,
    // Whether the key is on a smart card is only known once it is used.
    ...(mine ? { via: { source: 'windows-store' as const, label: cert.name, subject: cert.subject, fingerprint: cert.sha1, hardware: false } } : {})
  }
}

/** Certificates read from a .cer, .p7b or .p12 file. */
export function recipientsFromFile(certs: CertificateInfo[], fileName: string): Recipient[] {
  return certs.map((cert) => ({ id: cert.sha256, cert, source: 'file', sourceLabel: fileName, mine: false }))
}

function viaMatches(via: CertKeyVia, r: Recipient): boolean {
  const fp = via.fingerprint.replace(/[^0-9a-f]/gi, '').toUpperCase()
  return (via.source === 'digital-id' ? r.cert.sha256 : r.cert.sha1) === fp
}

/**
 * The certificate added to a new recipient list by default: the one that opened the document when
 * it is certificate-encrypted (`via`), else the person's first Digital ID with an RSA key, else
 * their first personal Windows store certificate with a private key and an RSA key.
 */
export function chooseOwnCertificate(o: { via?: CertKeyVia | null; ids: Recipient[]; store: Recipient[] }): Recipient | null {
  if (o.via) {
    const opened = [...o.ids, ...o.store].find((r) => viaMatches(o.via!, r) && !recipientRefusal(r.cert))
    // The via that really opened it knows whether the key is on a smart card.
    if (opened) return { ...opened, mine: true, via: o.via }
  }
  return o.ids.find((r) => r.mine && !recipientRefusal(r.cert)) ?? o.store.find((r) => r.mine && !recipientRefusal(r.cert)) ?? null
}

// ---- permission groups --------------------------------------------------------------------------

/** What the recipients of one group may do (Acrobat's certificate security permissions). */
export interface GroupSettings {
  printing: PrintingAllowed
  /** Changing the document. */
  edit: boolean
  /** Inserting, deleting and rotating pages. */
  assemble: boolean
  /** Commenting. */
  annotate: boolean
  /** Filling in form fields and signing. */
  form: boolean
  /** Copying text, images and other content (also gives screen readers access). */
  copy: boolean
  /** Text access for screen readers. */
  accessibility: boolean
  /** Changing the security settings, which grants everything else too. */
  changeSecurity: boolean
}

export const FULL_ACCESS: GroupSettings = {
  printing: 'high',
  edit: true,
  assemble: true,
  annotate: true,
  form: true,
  copy: true,
  accessibility: true,
  changeSecurity: true
}

export interface RecipientGroup {
  /** Stable key for the UI. */
  id: number
  settings: GroupSettings
  recipients: Recipient[]
}

/** The permissions a group's settings give (everything when they may change the security). */
export function groupPermissions(s: GroupSettings): Record<Permission, boolean> {
  if (s.changeSecurity) return { print: true, 'print-hq': true, edit: true, annotate: true, form: true, assemble: true, copy: true, accessibility: true }
  return {
    print: s.printing !== 'none',
    'print-hq': s.printing === 'high',
    edit: s.edit,
    annotate: s.annotate,
    form: s.form,
    assemble: s.assemble,
    copy: s.copy,
    // Copying implies access for screen readers, as in Acrobat.
    accessibility: s.copy || s.accessibility
  }
}

/** "Full access", "Everything except changing the security", or "Not allowed: printing and copying". */
export function permissionSummary(s: GroupSettings): string {
  if (s.changeSecurity) return 'Full access, including the security settings'
  const denied = restrictionList(groupPermissions(s))
  if (!denied.length) return 'Everything allowed except changing the security settings'
  return `Not allowed: ${sentenceList(denied)}`
}

/** SaveOptions.encryptCertificate.groups for the dialog's groups: one envelope per group that has recipients. */
export function toCertificateGroups(groups: RecipientGroup[]): CertificateGroup[] {
  const out: CertificateGroup[] = []
  for (const g of groups) {
    if (!g.recipients.length) continue
    for (const r of g.recipients) {
      const refusal = recipientRefusal(r.cert)
      if (refusal) throw new Error(`${r.cert.name}: ${refusal}`)
    }
    out.push({
      certificates: g.recipients.map((r) => r.cert.der),
      permissions: groupPermissions(g.settings),
      changeSecurity: g.settings.changeSecurity
    })
  }
  return out
}

export function recipientCount(groups: RecipientGroup[]): number {
  return groups.reduce((n, g) => n + g.recipients.length, 0)
}

export function findRecipient(groups: RecipientGroup[], id: string): Recipient | null {
  for (const g of groups) for (const r of g.recipients) if (r.id === id) return r
  return null
}

/**
 * Adds recipients to a group. Certificates already in any group and ones that cannot receive a key
 * (not RSA) are left out and counted.
 */
export function addRecipients(
  groups: RecipientGroup[],
  groupId: number,
  add: Recipient[]
): { groups: RecipientGroup[]; added: number; duplicates: number; refused: number } {
  const seen = new Set(groups.flatMap((g) => g.recipients.map((r) => r.id)))
  const fresh: Recipient[] = []
  let duplicates = 0
  let refused = 0
  for (const r of add) {
    if (recipientRefusal(r.cert)) refused++
    else if (seen.has(r.id)) duplicates++
    else {
      seen.add(r.id)
      fresh.push(r)
    }
  }
  return {
    groups: groups.map((g) => (g.id === groupId ? { ...g, recipients: [...g.recipients, ...fresh] } : g)),
    added: fresh.length,
    duplicates,
    refused
  }
}

export function removeRecipient(groups: RecipientGroup[], id: string): RecipientGroup[] {
  return groups.map((g) => (g.recipients.some((r) => r.id === id) ? { ...g, recipients: g.recipients.filter((r) => r.id !== id) } : g))
}

export function moveRecipient(groups: RecipientGroup[], id: string, toGroupId: number): RecipientGroup[] {
  const r = findRecipient(groups, id)
  if (!r || !groups.some((g) => g.id === toGroupId)) return groups
  return removeRecipient(groups, id).map((g) => (g.id === toGroupId ? { ...g, recipients: [...g.recipients, r] } : g))
}

/** Removes a group; its recipients move to the first remaining group. The last group stays. */
export function removeGroup(groups: RecipientGroup[], groupId: number): RecipientGroup[] {
  const gone = groups.find((g) => g.id === groupId)
  const rest = groups.filter((g) => g.id !== groupId)
  if (!gone || !rest.length) return groups
  return rest.map((g, i) => (i === 0 ? { ...g, recipients: [...g.recipients, ...gone.recipients] } : g))
}

/** One of the person's own certificates is a recipient, so they can open the file later. */
export function hasOwnRecipient(groups: RecipientGroup[]): boolean {
  return groups.some((g) => g.recipients.some((r) => r.mine))
}

/** How the reopened document says it was opened: the default own certificate, else any own recipient. */
export function ownVia(groups: RecipientGroup[], preferred: Recipient | null): CertKeyVia | undefined {
  const kept = preferred && findRecipient(groups, preferred.id)
  if (kept) return preferred.via ?? kept.via
  return groups.flatMap((g) => g.recipients).find((r) => r.mine && r.via)?.via
}

// ---- certificate-encrypted documents in the Protect panel ---------------------------------------

/**
 * The envelope the person's certificate opened may change the security (DocUnlock.access 'owner').
 * Only that counts: an envelope that allows every permission but not changing the security (what
 * "Add a Group with Other Permissions" starts with) cannot replace or remove it, and the engine
 * refuses. Without an unlock it is not known which envelope opened it, so nothing is offered.
 */
export function hasFullAccess(unlock: DocUnlock | null | undefined): boolean {
  return unlock?.access === 'owner'
}

/**
 * The security of a certificate-encrypted document, from what the engine reported when it opened it
 * (DocInfo) and how it was opened. There is no password: the permissions are those of the envelope
 * the person's certificate opened, and other recipients may have others.
 */
export function certificateSecurity(
  info: Pick<DocInfo, 'encryption' | 'permissions'>,
  unlock: DocUnlock | null | undefined
): SecurityStatus & { filePermissions: Record<Permission, boolean> } {
  const permissions = {} as Record<Permission, boolean>
  for (const p of PERMISSIONS) permissions[p] = info.permissions[p] !== false
  return {
    encrypted: true,
    method: encryptionLabel(info.encryption),
    needsOpenPassword: false,
    ownerAccess: hasFullAccess(unlock),
    permissions,
    filePermissions: { ...permissions }
  }
}

/** The CN of a distinguished name given as text ("CN=Contoso CA, O=Contoso" -> "Contoso CA"). */
export function commonName(dn: string): string {
  // Split on commas that are not escaped; values may contain "\,".
  for (const part of dn.split(/(?<!\\),\s*/)) {
    const m = /^\s*(?:CN|2\.5\.4\.3)\s*=\s*(.*)$/i.exec(part)
    if (m) return m[1].replace(/\\(.)/g, '$1').trim()
  }
  return ''
}

/** How the Protect panel names one recipient of the document ("Encrypted for"). */
export function describeRecipient(r: PubSecRecipient, candidates: CertKeyCandidate[] = []): string {
  const mine = candidates.find((c) => c.envelope === r.envelope && c.index === r.index)
  if (mine) return `${mine.label} (you)`
  if (r.idType === 'subjectKeyIdentifier') return r.ski ? `Certificate with key ID ${r.ski}` : 'Unknown certificate'
  if (r.issuer) {
    const issuer = commonName(r.issuer) || r.issuer
    return r.serial ? `Certificate from ${issuer}, serial ${r.serial}` : `Certificate from ${issuer}`
  }
  return 'Unknown recipient'
}

/** The "Encrypted for" list of the Protect panel, each name once, the person's own key first. */
export function certificateRecipientNames(probe: Pick<CertKeysProbeResult, 'recipients' | 'candidates'>): string[] {
  const mine = (r: PubSecRecipient) => probe.candidates.some((c) => c.envelope === r.envelope && c.index === r.index)
  const ordered = [...probe.recipients.filter(mine), ...probe.recipients.filter((r) => !mine(r))]
  return [...new Set(ordered.map((r) => describeRecipient(r, probe.candidates)))]
}
