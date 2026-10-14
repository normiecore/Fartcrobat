import type { CertificateLock } from './certkeys'
import type { Rect } from './geometry'

/** Static information about one page, in page space (rotation applied). */
export interface PageInfo {
  index: number
  /** Stable identity of the page object (PDF object number). Survives reordering. */
  id: number
  width: number
  height: number
  /** Value of the page /Rotate entry. Width/height already account for it. */
  rotation: number
  label: string
  /** MediaBox and CropBox in unrotated PDF user space, for crop/print features. */
  mediaBox: Rect
  cropBox: Rect
}

export interface DocMetadata {
  title: string
  author: string
  subject: string
  keywords: string
  creator: string
  producer: string
  creationDate: string
  modDate: string
}

export type Permission = 'print' | 'copy' | 'edit' | 'annotate' | 'form' | 'accessibility' | 'assemble' | 'print-hq'

export interface DocInfo {
  pageCount: number
  pages: PageInfo[]
  metadata: DocMetadata
  /** PDF version, e.g. 1.7 */
  version: string
  /** "PDF 1.7", or the original format when the file was converted on open (e.g. "PNG", "DOCX"). */
  format: string
  /** True when the file was not a PDF and was converted on open. */
  converted: boolean
  encryption: string | null
  /**
   * How the document is encrypted: 'password' (the Standard handler), 'certificate' (public-key
   * security, /Adobe.PubSec, opened with a person's certificate), or null when it is not.
   */
  security: 'password' | 'certificate' | null
  permissions: Record<Permission, boolean>
  hasForm: boolean
  hasXfa: boolean
  signatureCount: number
  layerCount: number
  attachmentCount: number
  wasRepaired: boolean
  canSaveIncrementally: boolean
  language: string | null
}

export interface JournalState {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  position: number
}

/**
 * Describes what an engine call changed. Piggybacked on every engine response so the UI can
 * re-render only what is needed.
 */
export interface ChangeSet {
  /** Indices of pages whose content or annotations changed. */
  pages: number[]
  /** Every page may have changed (undo/redo, bulk operations). */
  all: boolean
  /** Page count, order, sizes or rotation changed: the UI must refetch DocInfo. */
  structure: boolean
  /** Document-level data changed (metadata, outline, attachments, form, signatures...). */
  document: boolean
  journal: JournalState
  dirty: boolean
}

/**
 * Facts about a PDF's security handler that can be read before its password is known. Used to find
 * a password saved on this device (the main process hashes them into lookup keys).
 */
export interface LockInfo {
  /** /Filter of the /Encrypt dictionary ('Standard', 'Adobe.PubSec'...). */
  handler: string
  /** Hex of the first element of the trailer /ID; null when missing or empty. */
  id: string | null
  /**
   * Everything the password check depends on, as text. Two files with the same value accept
   * exactly the same passwords; it changes whenever the password (or AES-256's salts) changes.
   */
  security: string
}

/** What a password gave: 'owner' (the permissions password) opens with full access. */
export type PasswordAccess = 'user' | 'owner'

export type OpenResult =
  | {
      ok: true
      info: DocInfo
      /** Set when a password opened the document. */
      access?: PasswordAccess
    }
  | { ok: false; needsPassword: true; needsCertificate?: false; wrongPassword?: boolean; lock?: LockInfo | null }
  /**
   * Certificate encryption: one of the person's keys must unwrap a seed from `certificate.recipients`
   * (src/shared/certkeys.ts). The engine keeps the file pending until doc.unlockCertificate.
   */
  | { ok: false; needsPassword?: false; needsCertificate: true; certificate: CertificateLock }

export interface SaveOptions {
  /**
   * auto: incremental when the document has signatures (to keep them valid), otherwise a full,
   * compacted rewrite.
   */
  mode?: 'auto' | 'full' | 'incremental'
  garbage?: 'none' | 'collect' | 'compact' | 'deduplicate'
  compress?: boolean
  compressImages?: boolean
  compressFonts?: boolean
  clean?: boolean
  sanitize?: boolean
  linearize?: boolean
  objectStreams?: boolean
  /** Remove encryption on save. */
  decrypt?: boolean
  encrypt?: {
    method: 'aes-256' | 'aes-128' | 'rc4-128'
    userPassword: string
    ownerPassword: string
    permissions: Partial<Record<Permission, boolean>>
  }
  /**
   * Certificate security (Protect > Encrypt with Certificate): PubSec V5, AES-256, one envelope per
   * group, all sharing a new seed. Replaces any other security. Only public certificates are needed.
   * The engine keeps the new key, so reloading the saved bytes opens them without asking.
   */
  encryptCertificate?: {
    groups: CertificateGroup[]
    /** Default true. */
    encryptMetadata?: boolean
  }
}

/** Recipients of certificate-encrypted output that get the same permissions (one envelope). */
export interface CertificateGroup {
  /** DER X.509 certificates with RSA keys. */
  certificates: Uint8Array[]
  /** Anything not set to false is allowed. */
  permissions: Partial<Record<Permission, boolean>>
  /** Recipients may change the security (and so get every permission). Default false. */
  changeSecurity?: boolean
}

export type ThemePreference = 'system' | 'light' | 'dark'
export type PageLayoutMode = 'single' | 'continuous' | 'two-page' | 'two-page-continuous'
export type ZoomMode = 'custom' | 'fit-page' | 'fit-width' | 'fit-visible' | 'actual-size'

export interface Preferences {
  authorName: string
  theme: ThemePreference
  defaultZoom: ZoomMode | number
  defaultLayout: PageLayoutMode
  singleKeyShortcuts: boolean
  restoreLastView: boolean
  reopenTabsOnLaunch: boolean
  highlightFormFields: boolean
  smoothText: boolean
  /** Replace document colors (accessibility): none, or render with inverted luminance. */
  pageColors: 'document' | 'dark' | 'high-contrast'
  measurementUnits: 'pt' | 'in' | 'mm' | 'cm'
  showGrid: boolean
  snapToGrid: boolean
  gridSize: number
  keepToolSelected: boolean
  autoSaveMinutes: number
  recentFilesLimit: number
  checkDefaultAppOnStartup: boolean
  ocrLanguage: string
  libreOfficePath: string
  /** Use the GPU for drawing (needs a restart). Turn off if pages look blank or flicker. */
  hardwareAcceleration: boolean
  /**
   * Let AI apps on this computer (Claude Desktop through the Fartcrobat extension) work with open
   * documents. A machine policy file can force it on or off.
   */
  agentAccess: boolean
  /**
   * Offer to remember document and Digital ID passwords on this device (Preferences > Passwords).
   * A machine policy file can turn it off.
   */
  rememberPasswords: boolean
  /** The last choice in the password prompt's "Remember password on this device" checkbox. */
  rememberPasswordChecked: boolean
  /**
   * Check GitHub for a new release at start-up and every few hours (Preferences > Updates). A
   * machine policy can turn it off. Manual checks work either way, unless the policy is off.
   */
  checkForUpdates: boolean
  /**
   * Open certificate-encrypted files with certificates from the Windows certificate store and smart
   * cards (Preferences > Digital IDs; Windows only).
   */
  useWindowsCertificateStore: boolean
}

export const DEFAULT_PREFERENCES: Preferences = {
  authorName: '',
  theme: 'system',
  defaultZoom: 'fit-width',
  defaultLayout: 'continuous',
  singleKeyShortcuts: true,
  restoreLastView: true,
  reopenTabsOnLaunch: false,
  highlightFormFields: true,
  smoothText: true,
  pageColors: 'document',
  measurementUnits: 'in',
  showGrid: false,
  snapToGrid: false,
  gridSize: 18,
  keepToolSelected: false,
  autoSaveMinutes: 5,
  recentFilesLimit: 30,
  checkDefaultAppOnStartup: true,
  ocrLanguage: 'eng',
  libreOfficePath: '',
  hardwareAcceleration: true,
  agentAccess: true,
  rememberPasswords: true,
  rememberPasswordChecked: true,
  checkForUpdates: true,
  useWindowsCertificateStore: true
}

export interface RecentFile {
  path: string
  name: string
  size: number
  openedAt: number
  pageCount?: number
}

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface OpenDialogOptions {
  title?: string
  filters?: FileFilter[]
  multiple?: boolean
  directory?: boolean
  defaultPath?: string
}

export interface SaveDialogOptions {
  title?: string
  defaultPath?: string
  filters?: FileFilter[]
}

/** A native menu item description sent from the renderer to the main process. */
export interface MenuItemModel {
  id?: string
  label?: string
  accelerator?: string
  type?: 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio'
  checked?: boolean
  enabled?: boolean
  role?: string
  submenu?: MenuItemModel[]
}

export interface MenuModel {
  menus: { id: string; label: string; items: MenuItemModel[] }[]
}

export interface PrintJob {
  /** PNG or JPEG data per page, already rendered at the requested DPI. */
  pages: { data: Uint8Array; mime: 'image/png' | 'image/jpeg'; widthPt: number; heightPt: number }[]
  silent?: boolean
  copies?: number
  color?: boolean
  landscape?: boolean
  fit?: 'fit' | 'actual' | 'shrink'
  deviceName?: string
  duplex?: 'simplex' | 'shortEdge' | 'longEdge'
  jobName?: string
  /** Paper size to print on (Electron names), or width/height in microns. Printer default when omitted. */
  pageSize?: 'A0' | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'Legal' | 'Letter' | 'Tabloid' | { width: number; height: number }
}

export interface SystemInfo {
  platform: 'win32' | 'darwin' | 'linux' | string
  appVersion: string
  electron: string
  chrome: string
  node: string
  userDataPath: string
  documentsPath: string
  tempPath: string
  isPackaged: boolean
  /** OS account name, the default author for comments. */
  userName: string
}

export interface DefaultAppStatus {
  isDefault: boolean | null
  canSetDirectly: boolean
  instructions: string
}
