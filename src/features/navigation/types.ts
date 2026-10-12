/** Data shared by the navigation engine ops and the UI. */

/** A destination in page space (points, origin top-left, y down, page rotation applied). */
export interface BookmarkTarget {
  page: number
  /** Left edge of the view, or null to keep the current horizontal position. */
  x: number | null
  /** Top edge of the view, or null for the top of the page. */
  y: number | null
  /** Zoom factor (1 = 100%) or null to keep the current zoom ("Inherit zoom"). */
  zoom: number | null
}

export interface BookmarkDest {
  page: number
  x: number | null
  y: number | null
  /** Zoom factor (1 = 100%) for XYZ destinations, otherwise null. */
  zoom: number | null
  /** PDF destination type: XYZ, Fit, FitH, FitV, FitB, FitBH, FitBV, FitR. */
  type: string
}

export interface Bookmark {
  /** Object number of the outline item (stable across edits and undo). Negative for direct objects. */
  id: number
  title: string
  dest: BookmarkDest | null
  /** External link or other action target (e.g. "https://…"), when the bookmark is not a page destination. */
  uri: string | null
  /** Open in the PDF (/Count > 0). Used as the initial expanded state. */
  open: boolean
  bold: boolean
  italic: boolean
  /** #rrggbb, or null for the default text colour. */
  color: string | null
  children: Bookmark[]
}

export interface BookmarkStyle {
  bold?: boolean
  italic?: boolean
  color?: string | null
}

export interface EmbeddedFileInfo {
  /** Key in the /EmbeddedFiles name tree. */
  key: string
  fileName: string
  size: number | null
  mimeType: string
  /** ISO date strings, '' when unknown. */
  created: string
  modified: string
  description: string
}

export interface AnnotationFileInfo {
  /** Annotation object number (same id as the core annots ops use). */
  id: number
  page: number
  /** Annotation rectangle in page space. */
  rect: [number, number, number, number] | null
  fileName: string
  size: number | null
  description: string
}

export interface AttachmentList {
  files: EmbeddedFileInfo[]
  annotations: AnnotationFileInfo[]
}

export interface LayerInfo {
  index: number
  name: string
  visible: boolean
  /** Visibility when the document was opened. */
  initiallyVisible: boolean
}

export type NavigationTab = 'page' | 'bookmarks' | 'thumbnails' | 'attachments' | 'layers'

export type InitialLayout =
  | 'default'
  | 'single'
  | 'continuous'
  | 'two-up'
  | 'two-up-continuous'
  | 'two-up-cover'
  | 'two-up-continuous-cover'

export type InitialMagnification =
  'default' | 'actual-size' | 'fit-page' | 'fit-width' | 'fit-height' | 'fit-visible' | number

export interface InitialView {
  navigationTab: NavigationTab
  pageLayout: InitialLayout
  magnification: InitialMagnification
  /** 0-based page the document opens on. */
  openToPage: number
  /** Viewer preference /DisplayDocTitle: show the document title instead of the file name. */
  displayDocTitle: boolean
  /** True when /OpenAction is something other than a page destination (e.g. JavaScript). */
  openActionIsScript: boolean
}

export interface DocumentPropertiesData {
  tagged: boolean
  initialView: InitialView
  /** Custom document information keys, in file order. */
  custom: { key: string; value: string }[]
  trapped: string
  /** The /Info dictionary exists. */
  hasInfo: boolean
  hasXmpMetadata: boolean
}

export interface PropertiesPatch {
  metadata?: Partial<Record<'title' | 'author' | 'subject' | 'keywords', string>>
  initialView?: Partial<Omit<InitialView, 'openActionIsScript'>>
  /** Full replacement of the custom keys (standard keys are ignored). */
  custom?: { key: string; value: string }[]
}

export interface FontInfo {
  /** Object number of the font dictionary (0 for direct fonts). */
  id: number
  name: string
  /** "Type 1", "TrueType", "Type 0 (CID)" … */
  type: string
  encoding: string
  embedded: boolean
  subset: boolean
  /** 0-based pages where the font appears in the resources. */
  pages: number[]
}
