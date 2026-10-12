/**
 * Types and pure helpers shared by the protect-optimize UI and engine (no DOM, no MuPDF).
 */
import type { Permission, SaveOptions } from '@shared/types'

export const FEATURE_ID = 'protect-optimize'

// ---- security -------------------------------------------------------------------------------

export type EncryptionMethod = 'aes-256' | 'aes-128' | 'rc4-128'

export const ENCRYPTION_METHODS: { value: EncryptionMethod; label: string; hint: string }[] = [
  { value: 'aes-256', label: '256-bit AES (Acrobat X and later)', hint: 'Strongest. Opens in every current PDF app.' },
  { value: 'aes-128', label: '128-bit AES (Acrobat 7 and later)', hint: 'For older PDF apps.' },
  { value: 'rc4-128', label: '128-bit RC4 (Acrobat 6 and later)', hint: 'Weak; only for very old PDF apps.' }
]

export type PrintingAllowed = 'none' | 'low' | 'high'

export const PRINTING_OPTIONS: { value: PrintingAllowed; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low resolution (150 dpi)' },
  { value: 'high', label: 'High resolution' }
]

export type ChangesAllowed = 'none' | 'pages' | 'forms' | 'comments' | 'any'

export const CHANGES_OPTIONS: { value: ChangesAllowed; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'pages', label: 'Inserting, deleting, and rotating pages' },
  { value: 'forms', label: 'Filling in form fields, and signing existing signature fields' },
  { value: 'comments', label: 'Commenting, filling in form fields, and signing existing signature fields' },
  { value: 'any', label: 'Any except extracting pages' }
]

/** What the "Protect using password" dialog collects. */
export interface ProtectSettings {
  requireOpenPassword: boolean
  openPassword: string
  restrictEditing: boolean
  permissionsPassword: string
  printing: PrintingAllowed
  changes: ChangesAllowed
  allowCopy: boolean
  allowScreenReaders: boolean
  method: EncryptionMethod
}

export const DEFAULT_PROTECT_SETTINGS: ProtectSettings = {
  requireOpenPassword: true,
  openPassword: '',
  restrictEditing: false,
  permissionsPassword: '',
  printing: 'high',
  changes: 'none',
  allowCopy: false,
  allowScreenReaders: true,
  method: 'aes-256'
}

/** Maps the dialog choices to the PDF permission flags (Acrobat's mapping). */
export function permissionsFor(s: Pick<ProtectSettings, 'restrictEditing' | 'printing' | 'changes' | 'allowCopy' | 'allowScreenReaders'>): Record<Permission, boolean> {
  if (!s.restrictEditing) {
    return { print: true, 'print-hq': true, edit: true, annotate: true, form: true, assemble: true, copy: true, accessibility: true }
  }
  const c = s.changes
  return {
    print: s.printing !== 'none',
    'print-hq': s.printing === 'high',
    edit: c === 'any',
    annotate: c === 'comments' || c === 'any',
    form: c === 'forms' || c === 'comments' || c === 'any',
    assemble: c === 'pages' || c === 'any',
    copy: s.allowCopy,
    // Copying implies access for screen readers, as in Acrobat.
    accessibility: s.allowCopy || s.allowScreenReaders
  }
}

/** Validates the dialog. Returns field errors (empty when the settings can be applied). */
export function validateProtect(s: ProtectSettings, confirmOpen: string, confirmPerms: string): Partial<Record<'open' | 'openConfirm' | 'perms' | 'permsConfirm' | 'general', string>> {
  const errors: Partial<Record<'open' | 'openConfirm' | 'perms' | 'permsConfirm' | 'general', string>> = {}
  if (!s.requireOpenPassword && !s.restrictEditing) {
    errors.general = 'Choose at least one: a password to open the document, or restrictions on editing and printing.'
  }
  const check = (pw: string): string | null => {
    if (!pw) return 'Enter a password.'
    if (pw.includes(',')) return 'Passwords can’t contain commas (,).'
    if (s.method !== 'aes-256' && /[^\x20-\x7e\xa0-\xff]/.test(pw)) {
      return 'This encryption level only supports Latin letters, digits and symbols. Choose 256-bit AES for other characters.'
    }
    if (new TextEncoder().encode(pw).length > 127) return 'Passwords can be at most 127 bytes long.'
    return null
  }
  if (s.requireOpenPassword) {
    const e = check(s.openPassword)
    if (e) errors.open = e
    else if (confirmOpen !== s.openPassword) errors.openConfirm = 'The passwords don’t match.'
  }
  if (s.restrictEditing) {
    const e = check(s.permissionsPassword)
    if (e) errors.perms = e
    else if (confirmPerms !== s.permissionsPassword) errors.permsConfirm = 'The passwords don’t match.'
    else if (s.requireOpenPassword && s.permissionsPassword === s.openPassword) {
      errors.perms = 'The permissions password must be different from the open password.'
    }
  }
  return errors
}

/** Core SaveOptions.encrypt for the dialog choices. */
export function encryptOptions(s: ProtectSettings): NonNullable<SaveOptions['encrypt']> {
  const userPassword = s.requireOpenPassword ? s.openPassword : ''
  // Without restrictions the owner password is the open password (everything allowed for its holder).
  const ownerPassword = s.restrictEditing ? s.permissionsPassword : userPassword
  return { method: s.method, userPassword, ownerPassword, permissions: permissionsFor(s) }
}

export type PasswordStrength = { score: 0 | 1 | 2 | 3 | 4; label: string }

/** Rough password strength in Acrobat's words (Weak / Medium / Strong / Best). */
export function passwordStrength(pw: string): PasswordStrength {
  if (!pw) return { score: 0, label: '' }
  let classes = 0
  if (/[a-z]/.test(pw)) classes++
  if (/[A-Z]/.test(pw)) classes++
  if (/[0-9]/.test(pw)) classes++
  if (/[^a-zA-Z0-9]/.test(pw)) classes++
  const unique = new Set(pw).size
  let points = Math.min(pw.length, 20) + classes * 3
  if (unique <= 2) points -= 6
  if (/^(password|qwerty|letmein|123456|abc123|admin|welcome)/i.test(pw)) points -= 8
  if (points < 12) return { score: 1, label: 'Weak' }
  if (points < 18) return { score: 2, label: 'Medium' }
  if (points < 24) return { score: 3, label: 'Strong' }
  return { score: 4, label: 'Best' }
}

/** "Standard V5 R6 256-bit AES" -> "256-bit AES". */
export function encryptionLabel(raw: string | null | undefined): string | null {
  if (!raw) return null
  const m = /(\d+)-bit\s+(AES|RC4)/i.exec(raw)
  if (m) return `${m[1]}-bit ${m[2].toUpperCase()}`
  return raw.replace(/^Standard\s+/i, '')
}

export interface SecurityStatus {
  encrypted: boolean
  /** e.g. "256-bit AES" */
  method: string | null
  /** The file asks for a password before it opens. */
  needsOpenPassword: boolean
  /** All permissions are granted in this session (owner password used, or nothing restricted). */
  ownerAccess: boolean
  permissions: Record<Permission, boolean>
}

export type PasswordLevel = 'owner' | 'user' | 'none'

/** Human-readable list of what the permissions forbid, e.g. ["printing", "copying content"]. */
export function restrictionList(p: Record<Permission, boolean>): string[] {
  const out: string[] = []
  if (!p.print) out.push('printing')
  else if (!p['print-hq']) out.push('high-resolution printing')
  if (!p.edit) out.push('changing the document')
  if (!p.assemble) out.push('inserting, deleting and rotating pages')
  if (!p.annotate) out.push('commenting')
  if (!p.form) out.push('filling in forms and signing')
  if (!p.copy) out.push('copying text and images')
  if (!p.accessibility) out.push('screen reader access')
  return out
}

export function isRestricted(p: Record<Permission, boolean>): boolean {
  return !p.edit || !p.annotate || !p.form || !p.assemble || !p.copy || !p.print
}

export function sentenceList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]
}

// ---- optimization ---------------------------------------------------------------------------

export interface ImageClassSettings {
  /** Downsample images whose resolution is above `abovePpi` to `targetPpi`. */
  downsample: boolean
  targetPpi: number
  abovePpi: number
}

export interface PhotoImageSettings extends ImageClassSettings {
  /** JPEG quality 1–100. */
  quality: number
  /** Also re-encode losslessly stored photos as JPEG when that is smaller. */
  recompress: boolean
}

export interface OptimizeOptions {
  images: {
    color: PhotoImageSettings
    gray: PhotoImageSettings
    mono: ImageClassSettings
  }
  fonts: { subset: boolean }
  discard: {
    formActions: boolean
    javascript: boolean
    flattenFields: boolean
    alternateImages: boolean
    thumbnails: boolean
    bookmarks: boolean
    tags: boolean
    comments: boolean
    attachments: boolean
    metadata: boolean
    privateData: boolean
  }
  cleanup: {
    compressStreams: boolean
    removeUnused: boolean
    objectStreams: boolean
    optimizeContent: boolean
  }
}

export type QualityPreset = 'high' | 'medium' | 'small'

export const QUALITY_PRESETS: { value: QualityPreset; label: string; description: string }[] = [
  { value: 'high', label: 'High quality', description: 'Larger file. Images kept sharp for printing (300 ppi).' },
  { value: 'medium', label: 'Medium', description: 'Good for most uses: reading, sharing and office printing (150 ppi).' },
  { value: 'small', label: 'Small size', description: 'Smallest file, for screens and email (96 ppi).' }
]

const NO_DISCARD: OptimizeOptions['discard'] = {
  formActions: false,
  javascript: false,
  flattenFields: false,
  alternateImages: true,
  thumbnails: true,
  bookmarks: false,
  tags: false,
  comments: false,
  attachments: false,
  metadata: false,
  privateData: true
}

export function presetOptions(preset: QualityPreset): OptimizeOptions {
  const photo = (targetPpi: number, quality: number): PhotoImageSettings => ({
    downsample: true,
    targetPpi,
    abovePpi: Math.round(targetPpi * 1.5),
    quality,
    recompress: true
  })
  const p =
    preset === 'high'
      ? { color: photo(300, 88), mono: 600 }
      : preset === 'medium'
        ? { color: photo(150, 75), mono: 300 }
        : { color: photo(96, 60), mono: 200 }
  return {
    images: {
      color: p.color,
      gray: { ...p.color },
      mono: { downsample: true, targetPpi: p.mono, abovePpi: Math.round(p.mono * 1.5) }
    },
    fonts: { subset: true },
    discard: { ...NO_DISCARD },
    cleanup: { compressStreams: true, removeUnused: true, objectStreams: true, optimizeContent: preset === 'small' }
  }
}

export interface ImageReport {
  examined: number
  downsampled: number
  recompressed: number
  bytesBefore: number
  bytesAfter: number
}

export interface OptimizeReport {
  /** Size of the document saved as it is now, before optimizing. */
  originalSize: number
  resultSize: number
  images: ImageReport
  fontsSubset: boolean
  discarded: string[]
  /** The result keeps the document's password protection. */
  keptEncryption: boolean
  signaturesInvalidated: boolean
}

export interface SpaceCategory {
  id: string
  label: string
  bytes: number
  count: number
}

export interface SpaceAudit {
  total: number
  categories: SpaceCategory[]
}

/** 12_400_000 -> "12.4 MB" (decimal units, like Acrobat and file managers). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–'
  if (n < 1000) return `${n} bytes`
  const units = ['KB', 'MB', 'GB']
  let v = n / 1000
  let u = 0
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000
    u++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, '')} ${units[u]}`
}

/** "Reduced from 12.4 MB to 3.1 MB (75% smaller)". */
export function reductionSummary(before: number, after: number): string {
  if (after >= before) return `The file is already well optimized (${formatBytes(before)}).`
  const pct = Math.round(((before - after) / before) * 100)
  return `Reduced from ${formatBytes(before)} to ${formatBytes(after)} (${pct}% smaller)`
}

/** "report.pdf" -> "report_compressed.pdf" */
export function compressedName(name: string): string {
  const base = name.replace(/\.pdf$/i, '')
  return `${base}_compressed.pdf`
}
