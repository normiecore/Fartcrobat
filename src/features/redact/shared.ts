/**
 * Types and constants shared by the redact engine (worker) and UI. Keep this file free of DOM and
 * MuPDF imports.
 */
import type { Quad, Rect } from '@shared/geometry'

export const FEATURE_ID = 'redact'

/** Base-14 fonts available for overlay text (no embedding needed, every PDF reader has them). */
export const OVERLAY_FONTS = [
  { id: 'Helvetica', label: 'Helvetica', css: 'Helvetica, Arial, "Liberation Sans", sans-serif', weight: 400 },
  { id: 'Helvetica-Bold', label: 'Helvetica Bold', css: 'Helvetica, Arial, "Liberation Sans", sans-serif', weight: 700 },
  { id: 'Times-Roman', label: 'Times', css: '"Times New Roman", Times, "Liberation Serif", serif', weight: 400 },
  { id: 'Times-Bold', label: 'Times Bold', css: '"Times New Roman", Times, "Liberation Serif", serif', weight: 700 },
  { id: 'Courier', label: 'Courier', css: '"Courier New", Courier, "Liberation Mono", monospace', weight: 400 },
  { id: 'Courier-Bold', label: 'Courier Bold', css: '"Courier New", Courier, "Liberation Mono", monospace', weight: 700 }
] as const

export type OverlayFont = (typeof OVERLAY_FONTS)[number]['id']

/** Resource names Acrobat uses in /DA strings for the base-14 fonts. */
export const DA_FONT_NAMES: Record<OverlayFont, string> = {
  Helvetica: 'Helv',
  'Helvetica-Bold': 'HeBo',
  'Times-Roman': 'TiRo',
  'Times-Bold': 'TiBo',
  Courier: 'Cour',
  'Courier-Bold': 'CoBo'
}

export type OverlayMode = 'none' | 'custom' | 'code'
export type OverlayAlign = 'left' | 'center' | 'right'

/** How a redaction mark looks before it is applied and what the redacted area looks like after. */
export interface RedactionProps {
  /** Outline of the mark shown before applying. */
  outlineColor: string
  /** Colour that fills the redacted area once applied; null leaves it blank (white page shows through). */
  fillColor: string | null
  overlay: OverlayMode
  customText: string
  /** Redaction code, e.g. "(b)(6)". */
  code: string
  font: OverlayFont
  fontSize: number
  /** Shrink or grow the overlay text so it fits the redacted area. */
  autoSize: boolean
  textColor: string
  align: OverlayAlign
  /** Repeat the overlay text to fill the whole area. */
  repeat: boolean
}

export const DEFAULT_PROPS: RedactionProps = {
  outlineColor: '#e8001c',
  fillColor: '#000000',
  overlay: 'none',
  customText: 'REDACTED',
  code: '(b)(6)',
  font: 'Helvetica',
  fontSize: 10,
  autoSize: true,
  textColor: '#ffffff',
  align: 'center',
  repeat: false
}

/** Redaction code sets (as in Acrobat's Redaction Properties). */
export const REDACTION_CODE_SETS: { id: string; label: string; codes: { code: string; description: string }[] }[] = [
  {
    id: 'foia',
    label: 'U.S. FOIA',
    codes: [
      { code: '(b)(1)', description: 'Classified national security information' },
      { code: '(b)(2)', description: 'Internal personnel rules and practices' },
      { code: '(b)(3)', description: 'Exempted by another statute' },
      { code: '(b)(4)', description: 'Trade secrets, commercial or financial information' },
      { code: '(b)(5)', description: 'Privileged inter- or intra-agency communications' },
      { code: '(b)(6)', description: 'Personal privacy' },
      { code: '(b)(7)(A)', description: 'Law enforcement: interference with proceedings' },
      { code: '(b)(7)(B)', description: 'Law enforcement: fair trial' },
      { code: '(b)(7)(C)', description: 'Law enforcement: personal privacy' },
      { code: '(b)(7)(D)', description: 'Law enforcement: confidential source' },
      { code: '(b)(7)(E)', description: 'Law enforcement: techniques and procedures' },
      { code: '(b)(7)(F)', description: 'Law enforcement: endangering life or safety' },
      { code: '(b)(8)', description: 'Financial institution examination' },
      { code: '(b)(9)', description: 'Geological information on wells' }
    ]
  },
  {
    id: 'privacy',
    label: 'U.S. Privacy Act',
    codes: [
      { code: '(d)(5)', description: 'Information compiled for a civil action' },
      { code: '(j)(1)', description: 'CIA records' },
      { code: '(j)(2)', description: 'Criminal law enforcement records' },
      { code: '(k)(1)', description: 'Classified information' },
      { code: '(k)(2)', description: 'Investigatory material for law enforcement' },
      { code: '(k)(3)', description: 'Protective services records' },
      { code: '(k)(4)', description: 'Statistical records' },
      { code: '(k)(5)', description: 'Suitability investigations: confidential source' },
      { code: '(k)(6)', description: 'Testing or examination material' },
      { code: '(k)(7)', description: 'Armed services promotion: confidential source' }
    ]
  }
]

/** The text drawn over a redacted area, or '' for none. */
export function overlayTextOf(p: RedactionProps): string {
  if (p.overlay === 'custom') return p.customText.trim()
  if (p.overlay === 'code') return p.code.trim()
  return ''
}

export type MarkKind = 'text' | 'area' | 'page'

export interface MarkInfo {
  id: number
  page: number
  kind: MarkKind
  /** Bounding box of the mark (page space). */
  rect: Rect
  /** One quad per text line for text marks; empty for areas. */
  quads: Quad[]
  props: RedactionProps
  /** Created by (annotation author). */
  author: string
  created: string
}

/** One area to mark: text quads (one per line) or a rectangle. */
export interface MarkSpec {
  page: number
  kind: MarkKind
  quads?: Quad[]
  rect?: Rect
}

export interface ApplyReport {
  marks: number
  pages: number[]
  /** Comments and markups lying in redacted areas that were removed with the content. */
  removedAnnotations: number
  /** Form fields lying in redacted areas that were removed. */
  removedFields: number
}

// ---- Remove hidden information ----------------------------------------------------------------

export type HiddenItemId =
  | 'metadata'
  | 'attachments'
  | 'bookmarks'
  | 'comments'
  | 'forms'
  | 'hiddenText'
  | 'hiddenLayers'
  | 'searchIndex'
  | 'croppedContent'
  | 'javascript'
  | 'externalLinks'
  | 'overlapping'

export interface HiddenItem {
  id: HiddenItemId
  /** Number of things found (0 = nothing to remove). */
  count: number
  /** Short human-readable details, e.g. attachment names or layer names. */
  details: string[]
}

export type HiddenScan = Record<HiddenItemId, HiddenItem>

export interface SanitizeOptions {
  items: HiddenItemId[]
  /** What to do with form fields when 'forms' is selected. */
  forms?: 'flatten' | 'remove'
}

export interface SanitizeReport {
  removed: { id: HiddenItemId; count: number }[]
}

export const HIDDEN_ITEMS: { id: HiddenItemId; label: string; description: string; optional?: boolean }[] = [
  { id: 'metadata', label: 'Metadata', description: 'Title, author, keywords, XMP and private application data.' },
  { id: 'attachments', label: 'File attachments', description: 'Files embedded in the document or attached to comments.' },
  { id: 'bookmarks', label: 'Bookmarks', description: 'The bookmark (outline) tree.' },
  { id: 'comments', label: 'Comments and markups', description: 'Notes, highlights, drawings, stamps and their replies.' },
  { id: 'forms', label: 'Form fields', description: 'Interactive fields and the values typed into them.' },
  {
    id: 'hiddenText',
    label: 'Hidden text',
    description: 'Invisible text, such as the text layer added by OCR. The page will no longer be searchable.',
    optional: true
  },
  { id: 'hiddenLayers', label: 'Hidden layers', description: 'Layers that are switched off and everything drawn on them.' },
  { id: 'searchIndex', label: 'Embedded search index', description: 'A full-text index stored inside the file.' },
  {
    id: 'croppedContent',
    label: 'Cropped content',
    description: 'Text, images and drawings outside the visible page area, left over from cropping pages. The crop becomes permanent.'
  },
  { id: 'javascript', label: 'JavaScript and actions', description: 'Scripts that run when the document, a page or a field is used.' },
  { id: 'externalLinks', label: 'Links to outside the document', description: 'Web links, links to other files and form submit actions.' },
  {
    id: 'overlapping',
    label: 'Overlapping objects',
    description: 'Text that is covered by boxes or images drawn on top of it (it can still be copied).'
  }
]

