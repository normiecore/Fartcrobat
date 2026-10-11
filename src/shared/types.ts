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

export type OpenResult = { ok: true; info: DocInfo } | { ok: false; needsPassword: true; wrongPassword?: boolean }

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
  hardwareAcceleration: true
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
