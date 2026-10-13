/**
 * The stamp palette: Acrobat's Dynamic, Sign Here and Standard Business stamps.
 *
 * Standard Business stamps that MuPDF knows by name are drawn by MuPDF itself (vector, standard
 * /Name so other viewers recognise them). The rest are drawn in the UI with a canvas and placed as
 * image stamps (see stampRender.ts).
 */

export type StampCategory = 'dynamic' | 'signhere' | 'standard' | 'custom'

export type StampShape =
  /** MuPDF draws it from the /Name. */
  | 'builtin'
  /** Bordered box with one or two lines of bold text (Standard Business look). */
  | 'box'
  /** Arrow-shaped tag pointing left ("SIGN HERE"). */
  | 'tag'
  /** Round badge with a check mark. */
  | 'check'
  /** Round badge with a cross. */
  | 'cross'
  /** Big word plus "By <author> at <time>, <date>". */
  | 'dynamic'
  /** A user image. */
  | 'image'

export interface StampDef {
  /** Stable id, e.g. "standard:approved", "custom:3f2a…". */
  id: string
  category: StampCategory
  /** Name shown in the palette and stored as the annotation subject. */
  label: string
  /** PDF /Name of the stamp annotation. */
  name: string
  color: string
  shape: StampShape
  /** Text lines drawn on the stamp (box/tag/dynamic). */
  lines?: string[]
  /** Width / height. */
  aspect: number
  /** Default width in points when placed with a click. */
  width: number
}

/** MuPDF's built-in stamp appearance is 190 x 50. */
export const BUILTIN_ASPECT = 3.8

/** /Name values MuPDF draws itself. */
export const MUPDF_STAMP_NAMES = new Set([
  'Approved',
  'NotApproved',
  'Draft',
  'Final',
  'Confidential',
  'ForPublicRelease',
  'NotForPublicRelease',
  'ForComment',
  'Experimental',
  'Expired',
  'Sold',
  'TopSecret',
  'Departmental',
  'AsIs'
])

export const GREEN = '#1E7B34'
export const RED = '#C62828'
export const BLUE = '#1F4E9C'
export const ORANGE = '#E8590C'
export const PURPLE = '#5E35B1'

function standard(key: string, label: string, name: string, color: string, lines?: string[]): StampDef {
  const builtin = MUPDF_STAMP_NAMES.has(name)
  return {
    id: `standard:${key}`,
    category: 'standard',
    label,
    name,
    color,
    shape: builtin ? 'builtin' : 'box',
    lines: lines ?? [label.toUpperCase()],
    aspect: BUILTIN_ASPECT,
    width: 150
  }
}

export const STANDARD_STAMPS: StampDef[] = [
  standard('approved', 'Approved', 'Approved', GREEN),
  standard('notapproved', 'Not Approved', 'NotApproved', RED),
  standard('draft', 'Draft', 'Draft', BLUE),
  standard('final', 'Final', 'Final', GREEN),
  standard('completed', 'Completed', 'Completed', GREEN),
  standard('confidential', 'Confidential', 'Confidential', RED),
  standard('forpublicrelease', 'For Public Release', 'ForPublicRelease', GREEN),
  standard('notforpublicrelease', 'Not For Public Release', 'NotForPublicRelease', RED),
  standard('forcomment', 'For Comment', 'ForComment', BLUE),
  standard('void', 'Void', 'Void', RED),
  standard('preliminaryresults', 'Preliminary Results', 'PreliminaryResults', BLUE, ['PRELIMINARY', 'RESULTS']),
  standard('informationonly', 'Information Only', 'InformationOnly', BLUE, ['INFORMATION', 'ONLY']),
  standard('experimental', 'Experimental', 'Experimental', BLUE),
  standard('expired', 'Expired', 'Expired', RED),
  standard('sold', 'Sold', 'Sold', BLUE),
  standard('topsecret', 'Top Secret', 'TopSecret', RED),
  standard('departmental', 'Departmental', 'Departmental', BLUE)
]

export const SIGN_HERE_STAMPS: StampDef[] = [
  { id: 'signhere:signhere', category: 'signhere', label: 'Sign Here', name: 'SHSignHere', color: RED, shape: 'tag', lines: ['SIGN HERE'], aspect: 3.4, width: 120 },
  { id: 'signhere:witness', category: 'signhere', label: 'Witness', name: 'SHWitness', color: ORANGE, shape: 'tag', lines: ['WITNESS'], aspect: 3.4, width: 120 },
  { id: 'signhere:initialhere', category: 'signhere', label: 'Initial Here', name: 'SHInitialHere', color: PURPLE, shape: 'tag', lines: ['INITIAL HERE'], aspect: 3.4, width: 120 },
  { id: 'signhere:accepted', category: 'signhere', label: 'Accepted', name: 'SHAccepted', color: GREEN, shape: 'check', aspect: 1, width: 36 },
  { id: 'signhere:rejected', category: 'signhere', label: 'Rejected', name: 'SHRejected', color: RED, shape: 'cross', aspect: 1, width: 36 }
]

export const DYNAMIC_STAMPS: StampDef[] = [
  { id: 'dynamic:approved', category: 'dynamic', label: 'Approved', name: 'DApproved', color: GREEN, shape: 'dynamic', lines: ['APPROVED'], aspect: 3, width: 170 },
  { id: 'dynamic:reviewed', category: 'dynamic', label: 'Reviewed', name: 'DReviewed', color: BLUE, shape: 'dynamic', lines: ['REVIEWED'], aspect: 3, width: 170 },
  { id: 'dynamic:received', category: 'dynamic', label: 'Received', name: 'DReceived', color: BLUE, shape: 'dynamic', lines: ['RECEIVED'], aspect: 3, width: 170 },
  { id: 'dynamic:revised', category: 'dynamic', label: 'Revised', name: 'DRevised', color: PURPLE, shape: 'dynamic', lines: ['REVISED'], aspect: 3, width: 170 },
  { id: 'dynamic:confidential', category: 'dynamic', label: 'Confidential', name: 'DConfidential', color: RED, shape: 'dynamic', lines: ['CONFIDENTIAL'], aspect: 3, width: 170 }
]

export const BUILTIN_STAMPS: StampDef[] = [...DYNAMIC_STAMPS, ...SIGN_HERE_STAMPS, ...STANDARD_STAMPS]

export const CATEGORY_LABELS: Record<StampCategory, string> = {
  dynamic: 'Dynamic',
  signhere: 'Sign Here',
  standard: 'Standard Business',
  custom: 'Custom'
}

export const DEFAULT_STAMP_ID = 'standard:approved'

export function findBuiltinStamp(id: string): StampDef | undefined {
  return BUILTIN_STAMPS.find((s) => s.id === id)
}

/** A user stamp kept in the store as a PNG data URL. */
export interface CustomStamp {
  id: string
  name: string
  /** data:image/png;base64,... */
  dataUrl: string
  /** Pixel size of the image. */
  width: number
  height: number
  created: number
}

/** Default placed width for a custom stamp: its size at 150 dpi, kept between 36 and 216 points. */
export function customStampDef(c: CustomStamp): StampDef {
  const aspect = c.width / Math.max(1, c.height)
  const natural = (c.width / 150) * 72
  let width = Math.max(36, Math.min(216, natural))
  // keep tall images from becoming huge
  if (width / aspect > 216) width = 216 * aspect
  return {
    id: `custom:${c.id}`,
    category: 'custom',
    label: c.name,
    name: stampNameFor(c.name),
    color: '#000000',
    shape: 'image',
    aspect,
    width
  }
}

/** A PDF /Name for a custom stamp: "C" followed by the letters and digits of its label. */
export function stampNameFor(label: string): string {
  const clean = label.replace(/[^A-Za-z0-9]+/g, '')
  return `C${clean || 'Stamp'}`.slice(0, 60)
}
