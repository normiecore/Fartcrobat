/**
 * Pure helpers shared by the comments engine ops and the comments UI (no MuPDF, no DOM).
 */
import type { Point, Quad, Rect } from '@shared/geometry'

/** Review states offered in "Set Status" (Acrobat order). */
export const REVIEW_STATES = ['None', 'Accepted', 'Cancelled', 'Completed', 'Rejected'] as const
export type ReviewState = (typeof REVIEW_STATES)[number]

/** Annotation types that are attached to text and cannot be moved or resized. */
export const TEXT_MARKUP = new Set(['Highlight', 'Underline', 'StrikeOut', 'Squiggly'])

/** Standard stamp icon names MuPDF can draw by itself (no image needed to reproduce them). */
export const STANDARD_STAMPS = new Set([
  'Approved',
  'AsIs',
  'Confidential',
  'Departmental',
  'Draft',
  'Experimental',
  'Expired',
  'Final',
  'ForComment',
  'ForPublicRelease',
  'NotApproved',
  'NotForPublicRelease',
  'Sold',
  'TopSecret'
])

/** Sticky note icons (Acrobat's names and the PDF icon names). */
export const NOTE_ICONS: { value: string; label: string }[] = [
  { value: 'Comment', label: 'Comment' },
  { value: 'Note', label: 'Note' },
  { value: 'Key', label: 'Key' },
  { value: 'Help', label: 'Help' },
  { value: 'NewParagraph', label: 'New Paragraph' },
  { value: 'Paragraph', label: 'Paragraph' },
  { value: 'Insert', label: 'Insert' }
]

export const LINE_ENDINGS: { value: string; label: string }[] = [
  { value: 'None', label: 'None' },
  { value: 'OpenArrow', label: 'Open arrow' },
  { value: 'ClosedArrow', label: 'Closed arrow' },
  { value: 'ROpenArrow', label: 'Reversed open arrow' },
  { value: 'RClosedArrow', label: 'Reversed closed arrow' },
  { value: 'Circle', label: 'Circle' },
  { value: 'Square', label: 'Square' },
  { value: 'Diamond', label: 'Diamond' },
  { value: 'Butt', label: 'Butt' },
  { value: 'Slash', label: 'Slash' }
]

/** The minimum an annotation needs for labelling. */
export interface LabelInfo {
  type: string
  intent?: string | null
  cloudy?: boolean
  lineEndings?: { start: string; end: string } | null
  extra?: Record<string, string>
}

const ARROWS = new Set(['OpenArrow', 'ClosedArrow', 'ROpenArrow', 'RClosedArrow'])

/** Acrobat's name for a comment type, e.g. "Sticky Note", "Rectangle", "Strikethrough". */
export function typeLabel(a: LabelInfo): string {
  const intent = a.intent ?? ''
  switch (a.type) {
    case 'Text':
      return 'Sticky Note'
    case 'FreeText':
      if (/TypeWriter/i.test(intent)) return 'Typewritten Text'
      if (/Callout/i.test(intent)) return 'Callout'
      return 'Text Box'
    case 'Line':
      if (/Dimension/i.test(intent)) return 'Distance'
      if (a.lineEndings && (ARROWS.has(a.lineEndings.start) || ARROWS.has(a.lineEndings.end))) return 'Arrow'
      return 'Line'
    case 'Square':
      return 'Rectangle'
    case 'Circle':
      return 'Oval'
    case 'Polygon':
      if (/Dimension/i.test(intent)) return 'Area'
      if (a.cloudy || /Cloud/i.test(intent)) return 'Cloud'
      return 'Polygon'
    case 'PolyLine':
      if (/Dimension/i.test(intent)) return 'Perimeter'
      return 'Polygonal Line'
    case 'Highlight':
      return 'Highlight'
    case 'Underline':
      return 'Underline'
    case 'StrikeOut':
      return 'Strikethrough'
    case 'Squiggly':
      return 'Squiggly Underline'
    case 'Caret':
      return 'Inserted Text'
    case 'Ink':
      return 'Drawing'
    case 'Stamp':
      return a.extra?.kind === 'signature' ? 'Signature' : a.extra?.kind === 'initials' ? 'Initials' : 'Stamp'
    case 'FileAttachment':
      return 'File Attachment'
    case 'Sound':
      return 'Sound'
    case 'Redact':
      return 'Redaction'
    default:
      return a.type
  }
}

// ---- default properties ------------------------------------------------------------------

/**
 * The kind of comment whose default look a comment sets, used in the store key
 * `comments:defaults:<kind>`. It is the PDF subtype ("Square", "Line", "FreeText", "Ink",
 * "Highlight"...), except for the variants Acrobat keeps separate defaults for: "Arrow" (a Line
 * with an arrow head), "Cloud" (a cloudy Polygon), "Callout" and "Typewriter" (FreeText intents),
 * and the measurements "Distance", "Perimeter" and "Area".
 */
export function defaultsKind(a: LabelInfo): string {
  const intent = a.intent ?? ''
  switch (a.type) {
    case 'Line':
      if (/Dimension/i.test(intent)) return 'Distance'
      if (a.lineEndings && (ARROWS.has(a.lineEndings.start) || ARROWS.has(a.lineEndings.end))) return 'Arrow'
      return 'Line'
    case 'Polygon':
      if (/Dimension/i.test(intent)) return 'Area'
      if (a.cloudy || /Cloud/i.test(intent)) return 'Cloud'
      return 'Polygon'
    case 'PolyLine':
      return /Dimension/i.test(intent) ? 'Perimeter' : 'PolyLine'
    case 'FreeText':
      if (/TypeWriter/i.test(intent)) return 'Typewriter'
      if (/Callout/i.test(intent)) return 'Callout'
      return 'FreeText'
    default:
      return a.type
  }
}

/** Every kind that can have saved defaults (for "Reset"). */
export const DEFAULT_KINDS = [
  'Text',
  'FreeText',
  'Callout',
  'Typewriter',
  'Line',
  'Arrow',
  'Square',
  'Circle',
  'Polygon',
  'Cloud',
  'PolyLine',
  'Ink',
  'Highlight',
  'Underline',
  'StrikeOut',
  'Squiggly',
  'Caret',
  'Stamp',
  'FileAttachment',
  'Distance',
  'Perimeter',
  'Area'
]

/** Text box kinds that share the "Default font size for text boxes" preference. */
export const TEXT_BOX_KINDS = ['FreeText', 'Callout', 'Typewriter']

// ---- annotation flags --------------------------------------------------------------------

/** XFDF flag names in bit order (bit 1 = invisible). */
export const FLAG_NAMES = [
  'invisible',
  'hidden',
  'print',
  'nozoom',
  'norotate',
  'noview',
  'readonly',
  'locked',
  'togglenoview',
  'lockedcontents'
]

export function flagsToNames(flags: number): string {
  return FLAG_NAMES.filter((_, i) => (flags & (1 << i)) !== 0).join(',')
}

export function namesToFlags(names: string): number {
  let f = 0
  for (const n of names.split(/[\s,]+/)) {
    const i = FLAG_NAMES.indexOf(n.trim().toLowerCase())
    if (i >= 0) f |= 1 << i
  }
  return f
}

// ---- interchange record --------------------------------------------------------------------

/**
 * A comment in a file-format neutral form, with all geometry in PDF user space (y up, as stored
 * in the file). Used for XFDF export/import (the UI builds/parses the XML).
 */
export interface CommentRecord {
  /** PDF annotation subtype, e.g. "Square". */
  type: string
  page: number
  /** Unique name (/NM). */
  name: string
  rect: Rect
  /** Name of the annotation this one replies to or is grouped with. */
  inReplyTo?: string
  replyType?: 'R' | 'Group'
  color?: string | null
  interiorColor?: string | null
  opacity?: number
  borderWidth?: number
  borderStyle?: 'Solid' | 'Dashed' | 'Beveled' | 'Inset' | 'Underline'
  dashes?: number[]
  cloudy?: boolean
  contents?: string
  author?: string
  subject?: string
  /** ISO dates. */
  created?: string
  modified?: string
  flags?: number
  icon?: string
  state?: string
  stateModel?: string
  intent?: string
  /** QuadPoints, 8 numbers per quad, user space. */
  quads?: number[][]
  ink?: Point[][]
  vertices?: Point[]
  line?: [Point, Point]
  lineEndings?: { start: string; end: string }
  calloutLine?: Point[]
  /** FreeText default appearance, e.g. "/Helv 12 Tf 0 0 1 rg". */
  defaultAppearance?: string
  quadding?: number
  popup?: { rect: Rect; open: boolean }
  /** PNG (base64) of the appearance of image stamps (signatures, custom stamps). */
  imagePng?: string
  /** Embedded file of a FileAttachment (base64). */
  file?: { name: string; mime?: string; data: string }
  /** Fartcrobat feature data (/FartcrobatData). */
  extra?: Record<string, string>
}

/** Parses a default appearance string ("/Helv 12 Tf 0 0 1 rg") into font, size and #rrggbb colour. */
export function parseDefaultAppearance(da: string): { font: string; size: number; color: string } {
  const out = { font: 'Helv', size: 12, color: '#000000' }
  const tf = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da)
  if (tf) {
    out.font = tf[1]
    out.size = parseFloat(tf[2]) || 12
  }
  const hex = (v: number) =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0')
  const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg\b/.exec(da)
  const g = /([\d.]+)\s+g\b/.exec(da)
  const k = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+k\b/.exec(da)
  if (rg) out.color = '#' + [rg[1], rg[2], rg[3]].map((v) => hex(parseFloat(v))).join('')
  else if (k) {
    const [c, m, y, kk] = [k[1], k[2], k[3], k[4]].map(parseFloat)
    out.color = '#' + [(1 - c) * (1 - kk), (1 - m) * (1 - kk), (1 - y) * (1 - kk)].map(hex).join('')
  } else if (g) out.color = '#' + hex(parseFloat(g[1])).repeat(3)
  return out
}

export function buildDefaultAppearance(font: string, size: number, color: string): string {
  const h = color.replace('#', '')
  const c = [0, 2, 4].map((i) => (parseInt(h.slice(i, i + 2), 16) / 255 || 0).toFixed(3).replace(/\.?0+$/, '') || '0')
  return `/${font || 'Helv'} ${+size.toFixed(2)} Tf ${c.join(' ')} rg`
}

// ---- text under markup ---------------------------------------------------------------------

/** Minimal shape of a page's text (PageText from the core text op). */
export interface TextLike {
  text: string
  /** 8 numbers per character (ul, ur, ll, lr). */
  quads: ArrayLike<number>
}

function quadBox(q: ArrayLike<number>, k = 0): Rect {
  const xs = [q[k], q[k + 2], q[k + 4], q[k + 6]]
  const ys = [q[k + 1], q[k + 3], q[k + 5], q[k + 7]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

/**
 * The text covered by a text markup annotation (Highlight, Underline...): characters whose centre
 * lies inside one of the annotation quads, in reading order. Lines are joined with spaces.
 */
export function textUnderQuads(t: TextLike, quads: Quad[] | number[][]): string {
  if (!quads.length || !t.text) return ''
  const boxes = quads.map((q) => {
    const b = quadBox(q)
    const h = b[3] - b[1]
    // tolerate quads that are slightly smaller than the glyph boxes
    return [b[0] - 0.5, b[1] - h * 0.15, b[2] + 0.5, b[3] + h * 0.15] as Rect
  })
  const all: Rect = [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3]))
  ]
  let out = ''
  let gap = false
  for (let i = 0; i < t.text.length; i++) {
    const c = t.text[i]
    if (c === '\n') {
      gap = true
      continue
    }
    const k = i * 8
    const cx = (t.quads[k] + t.quads[k + 2] + t.quads[k + 4] + t.quads[k + 6]) / 4
    const cy = (t.quads[k + 1] + t.quads[k + 3] + t.quads[k + 5] + t.quads[k + 7]) / 4
    if (cx < all[0] || cx > all[2] || cy < all[1] || cy > all[3]) continue
    if (!boxes.some((b) => cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3])) continue
    if (gap && out && !/\s$/.test(out)) out += ' '
    gap = false
    out += c
  }
  return out.replace(/\s+/g, ' ').trim()
}

/** A globally unique annotation name (/NM), like the GUIDs Acrobat assigns. */
export function uniqueName(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  const r = () =>
    Math.floor(Math.random() * 0x100000000)
      .toString(16)
      .padStart(8, '0')
  return `${r()}-${r().slice(0, 4)}-${r().slice(0, 4)}-${r().slice(0, 4)}-${r()}${r().slice(0, 4)}`
}

// ---- base64 (works in the worker, Node and the browser) ------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  return btoa(s)
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '')
  const s = atob(clean)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  const out = new Uint8Array(clean.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += b.toString(16).padStart(2, '0')
  return s.toUpperCase()
}

// ---- threads ---------------------------------------------------------------------------------

/** The fields thread building needs (AnnotInfo has all of them). */
export interface ThreadAnnot {
  id: number
  page: number
  type: string
  rect: Rect
  inReplyTo: number | null
  state: string | null
  stateModel: string | null
  author: string
  created: string
  modified: string
}

export interface Thread<T extends ThreadAnnot = ThreadAnnot> {
  root: T
  /** Text replies, oldest first. */
  replies: T[]
  /** Review/marked state changes, oldest first. */
  states: T[]
  /** Annotations grouped with the root (e.g. the caret of a "Replace Text"). */
  group: T[]
  /** Latest review state other than None, or null. */
  status: string | null
  statusBy: string
  /** Latest "Marked" state is Marked (checkmark). */
  marked: boolean
}

/** '' for missing dates (MuPDF reports a missing date as the 1970 epoch). */
export function cleanDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  return Number.isNaN(t) || t < Date.UTC(1971, 0, 1) ? '' : iso
}

export function dateValue(a: { created: string; modified: string }): number {
  const t = Date.parse(cleanDate(a.modified) || cleanDate(a.created))
  return Number.isNaN(t) ? 0 : t
}

function createdValue(a: { created: string; modified: string }): number {
  const t = Date.parse(cleanDate(a.created) || cleanDate(a.modified))
  return Number.isNaN(t) ? 0 : t
}

/** Groups annotations into comment threads (root comment + replies + status changes + grouped). */
export function buildThreads<T extends ThreadAnnot>(list: T[]): Thread<T>[] {
  const byId = new Map(list.map((a) => [a.id, a]))
  const rootOf = (a: T): T => {
    let cur = a
    for (let i = 0; i < 64 && cur.inReplyTo !== null; i++) {
      const parent = byId.get(cur.inReplyTo)
      if (!parent) break
      cur = parent
    }
    return cur
  }
  const threads = new Map<number, Thread<T>>()
  const order: T[] = []
  for (const a of list) {
    if (a.inReplyTo === null || !byId.has(a.inReplyTo)) {
      // a status change whose comment is gone is meaningless on its own
      if (a.type === 'Text' && a.state && a.inReplyTo !== null) continue
      threads.set(a.id, { root: a, replies: [], states: [], group: [], status: null, statusBy: '', marked: false })
      order.push(a)
    }
  }
  for (const a of list) {
    if (threads.has(a.id) || a.inReplyTo === null || !byId.has(a.inReplyTo)) continue
    const root = rootOf(a)
    const t = threads.get(root.id)
    if (!t) continue
    if (a.type === 'Text' && a.state) t.states.push(a)
    else if (a.type === 'Text') t.replies.push(a)
    else t.group.push(a)
  }
  for (const t of threads.values()) {
    t.replies.sort((x, y) => createdValue(x) - createdValue(y) || x.id - y.id)
    t.states.sort((x, y) => dateValue(x) - dateValue(y) || x.id - y.id)
    for (const s of t.states) {
      const model = s.stateModel ?? (s.state === 'Marked' || s.state === 'Unmarked' ? 'Marked' : 'Review')
      if (model === 'Marked') t.marked = s.state === 'Marked'
      else {
        t.status = s.state && s.state !== 'None' ? s.state : null
        t.statusBy = s.author
      }
    }
  }
  return order.map((a) => threads.get(a.id)!)
}

/** Label of a thread, taking groups into account (strikeout + caret = "Replace Text"). */
export function threadLabel(t: Thread<ThreadAnnot & LabelInfo>): string {
  if (t.root.type === 'StrikeOut' && t.group.some((g) => g.type === 'Caret')) return 'Replace Text'
  if (t.root.type === 'Caret' && t.group.some((g) => g.type === 'StrikeOut')) return 'Replace Text'
  return typeLabel(t.root)
}

// ---- messages ----------------------------------------------------------------------------------

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What an import did, in plain words ("Imported 2 comments and 1 reply from review.xfdf."). */
export function importMessage(
  t: { imported: number; duplicates: number; skipped: number; comments: number; replies: number; duplicateComments: number },
  from: string
): string {
  const parts: string[] = []
  if (t.comments) {
    parts.push(`Imported ${plural(t.comments, 'comment')}${t.replies ? ` and ${plural(t.replies, 'reply', 'replies')}` : ''} from ${from}.`)
  } else if (t.replies) {
    parts.push(`Imported ${plural(t.replies, 'reply', 'replies')} to existing comments from ${from}.`)
  } else if (t.imported) {
    parts.push(`Imported ${plural(t.imported, 'status change')} from ${from}.`)
  } else {
    parts.push(`No new comments in ${from}.`)
  }
  if (t.duplicateComments) {
    parts.push(`${plural(t.duplicateComments, 'comment')} ${t.duplicateComments === 1 ? 'was' : 'were'} already in the document.`)
  } else if (t.duplicates && !t.imported) {
    parts.push('Everything in it is already in the document.')
  }
  if (t.skipped) parts.push(`${t.skipped} could not be placed (missing pages or unsupported types).`)
  return parts.join(' ')
}
