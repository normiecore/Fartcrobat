import type { Rect } from '@shared/geometry'
import { normalizeRect, rectIntersection } from '@shared/geometry'
import type { PDFDocument, PDFObject } from '../session'

/** Reads a PDF rectangle array (possibly indirect) into a normalized Rect. */
export function readRect(obj: PDFObject | null | undefined, fallback: Rect = [0, 0, 612, 792]): Rect {
  if (!obj) return fallback
  try {
    const o = obj.resolve()
    if (!o.isArray() || o.length < 4) return fallback
    const r: Rect = [o.get(0).asNumber(), o.get(1).asNumber(), o.get(2).asNumber(), o.get(3).asNumber()]
    if (r.some((v) => !Number.isFinite(v))) return fallback
    return normalizeRect(r)
  } catch {
    return fallback
  }
}

export function readNumber(obj: PDFObject | null | undefined, fallback = 0): number {
  if (!obj) return fallback
  try {
    const o = obj.resolve()
    if (o.isNumber()) return o.asNumber()
  } catch {}
  return fallback
}

export function readString(obj: PDFObject | null | undefined, fallback = ''): string {
  if (!obj) return fallback
  try {
    const o = obj.resolve()
    if (o.isString()) return o.asString()
    if (o.isName()) return o.asName()
  } catch {}
  return fallback
}

export function readName(obj: PDFObject | null | undefined): string | null {
  if (!obj) return null
  try {
    const o = obj.resolve()
    if (o.isName()) return o.asName()
  } catch {}
  return null
}

export function isNull(obj: PDFObject | null | undefined): boolean {
  if (!obj) return true
  try {
    return obj.isNull()
  } catch {
    return true
  }
}

export interface PageBoxes {
  mediaBox: Rect
  cropBox: Rect
  rotation: number
  width: number
  height: number
}

const LETTER: Rect = [0, 0, 612, 792]
const NO_RECT: Rect = [0, 0, 0, 0]

function isEmptyRect(r: Rect): boolean {
  return !(r[0] < r[2] && r[1] < r[3])
}

/** /Rotate snapped the way MuPDF does: to the nearest multiple of 90, in 0..270. */
export function pageRotation(rotate: number): 0 | 90 | 180 | 270 {
  let r = Math.round(rotate) || 0
  if (r < 0) r = 360 - (-r % 360)
  if (r >= 360) r = r % 360
  r = 90 * Math.floor((r + 45) / 90)
  return (r >= 360 ? 0 : r) as 0 | 90 | 180 | 270
}

/**
 * Page geometry read straight from the page dictionary (fast: does not load the page). Mirrors
 * MuPDF's page transform, so it always agrees with what is rendered: an empty or missing box
 * falls back to Letter, the crop box is clipped to the media box, and /Rotate snaps to 90°.
 */
export function pageBoxes(doc: PDFDocument, index: number): PageBoxes {
  const pageObj = doc.findPage(index)
  const media = readRect(pageObj.getInheritable('MediaBox'), NO_RECT)
  const cropRaw = pageObj.getInheritable('CropBox')
  let cropBox = isNull(cropRaw) ? media : (rectIntersection(media, readRect(cropRaw, NO_RECT)) ?? NO_RECT)
  if (isEmptyRect(cropBox)) cropBox = LETTER
  if (cropBox[2] - cropBox[0] < 1 || cropBox[3] - cropBox[1] < 1) cropBox = [0, 0, 1, 1]
  const mediaBox = isEmptyRect(media) ? LETTER : media
  const rotation: number = pageRotation(readNumber(pageObj.getInheritable('Rotate'), 0))
  const userUnit = readNumber(pageObj.get('UserUnit'), 1) || 1
  const w = (cropBox[2] - cropBox[0]) * userUnit
  const h = (cropBox[3] - cropBox[1]) * userUnit
  const swap = rotation === 90 || rotation === 270
  return { mediaBox, cropBox, rotation, width: swap ? h : w, height: swap ? w : h }
}

export function catalog(doc: PDFDocument): PDFObject {
  return doc.getTrailer().get('Root')
}

/** Calls fn for every terminal form field (fields with a /FT, inherited or not). */
export function walkFields(doc: PDFDocument, fn: (field: PDFObject, fullName: string, ft: string | null) => void) {
  const acro = catalog(doc).get('AcroForm')
  if (isNull(acro)) return
  const fields = acro.get('Fields')
  if (isNull(fields) || !fields.isArray()) return
  const seen = new Set<number>()
  const visit = (field: PDFObject, parentName: string, inheritedFt: string | null, depth: number) => {
    if (depth > 64) return
    const num = field.isIndirect() ? field.asIndirect() : 0
    if (num && seen.has(num)) return
    if (num) seen.add(num)
    const f = field.resolve()
    if (!f.isDictionary()) return
    const partial = readString(f.get('T'))
    const name = partial ? (parentName ? `${parentName}.${partial}` : partial) : parentName
    const ft = readName(f.get('FT')) ?? inheritedFt
    const kids = f.get('Kids')
    let hasFieldKids = false
    if (!isNull(kids) && kids.isArray()) {
      for (let i = 0; i < kids.length; i++) {
        const k = kids.get(i).resolve()
        if (!isNull(k.get('T'))) {
          hasFieldKids = true
          break
        }
      }
    }
    if (hasFieldKids) {
      for (let i = 0; i < kids.length; i++) visit(kids.get(i), name, ft, depth + 1)
    } else {
      fn(field, name, ft)
    }
  }
  for (let i = 0; i < fields.length; i++) visit(fields.get(i), '', null, 0)
}

export function countSignatures(doc: PDFDocument): number {
  let n = 0
  walkFields(doc, (field, _name, ft) => {
    if (ft === 'Sig' && !isNull(field.resolve().get('V'))) n++
  })
  return n
}

export function hasForm(doc: PDFDocument): boolean {
  let n = 0
  walkFields(doc, () => n++)
  return n > 0
}

export function hasXfa(doc: PDFDocument): boolean {
  const acro = catalog(doc).get('AcroForm')
  return !isNull(acro) && !isNull(acro.get('XFA'))
}

// ---- page labels ------------------------------------------------------------------------

interface LabelRange {
  start: number
  style: string | null
  prefix: string
  first: number
}

function collectNumberTree(node: PDFObject, out: [number, PDFObject][], depth = 0) {
  if (depth > 32 || isNull(node)) return
  const n = node.resolve()
  const nums = n.get('Nums')
  if (!isNull(nums) && nums.isArray()) {
    for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums.get(i).asNumber(), nums.get(i + 1).resolve()])
  }
  const kids = n.get('Kids')
  if (!isNull(kids) && kids.isArray()) {
    for (let i = 0; i < kids.length; i++) collectNumberTree(kids.get(i), out, depth + 1)
  }
}

function toRoman(n: number): string {
  const table: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i']
  ]
  let s = ''
  for (const [v, r] of table) {
    while (n >= v) {
      s += r
      n -= v
    }
  }
  return s
}

function toAlpha(n: number): string {
  const letter = String.fromCharCode(97 + ((n - 1) % 26))
  return letter.repeat(Math.floor((n - 1) / 26) + 1)
}

export function formatPageLabel(style: string | null, prefix: string, value: number): string {
  let body = ''
  switch (style) {
    case 'D':
      body = String(value)
      break
    case 'R':
      body = toRoman(value).toUpperCase()
      break
    case 'r':
      body = toRoman(value)
      break
    case 'A':
      body = toAlpha(value).toUpperCase()
      break
    case 'a':
      body = toAlpha(value)
      break
    default:
      body = ''
  }
  return prefix + body
}

/** Computes the label of every page from the /PageLabels number tree (defaults to "1", "2", ...). */
export function pageLabels(doc: PDFDocument, count: number): string[] {
  const labels: string[] = []
  const tree = catalog(doc).get('PageLabels')
  if (isNull(tree)) {
    for (let i = 0; i < count; i++) labels.push(String(i + 1))
    return labels
  }
  const entries: [number, PDFObject][] = []
  try {
    collectNumberTree(tree, entries)
  } catch {}
  const ranges: LabelRange[] = entries
    .map(([start, dict]) => ({
      start,
      style: readName(dict.get('S')),
      prefix: readString(dict.get('P')),
      first: Math.max(1, Math.round(readNumber(dict.get('St'), 1)))
    }))
    .sort((a, b) => a.start - b.start)
  for (let i = 0; i < count; i++) {
    let range: LabelRange | null = null
    for (const r of ranges) if (r.start <= i) range = r
    if (!range) labels.push(String(i + 1))
    else labels.push(formatPageLabel(range.style, range.prefix, range.first + (i - range.start)) || String(i + 1))
  }
  return labels
}

/** Escapes a string for use inside a PDF literal string `( ... )`. */
export function pdfLiteral(s: string): string {
  return '(' + s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/\r/g, '\\r') + ')'
}

/** Formats a number for content streams (no exponent, trimmed). */
export function num(n: number): string {
  if (!Number.isFinite(n)) return '0'
  const s = n.toFixed(4)
  return s.replace(/\.?0+$/, '') || '0'
}

/** PDF date string D:YYYYMMDDHHmmSS+HH'mm' for a JS date. */
export function pdfDate(d: Date = new Date()): string {
  const pad = (v: number) => String(v).padStart(2, '0')
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  const tzh = pad(Math.floor(Math.abs(tz) / 60))
  const tzm = pad(Math.abs(tz) % 60)
  return `D:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${sign}${tzh}'${tzm}'`
}

/** Parses a PDF date string into an ISO string, or '' when it cannot be parsed. */
export function parsePdfDate(s: string | undefined | null): string {
  if (!s) return ''
  const m = /D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s)
  if (!m) return ''
  const [, y, mo = '01', d = '01', h = '00', mi = '00', se = '00', z, tzh = '00', tzm = '00'] = m
  let iso = `${y}-${mo}-${d}T${h}:${mi}:${se}`
  if (z === 'Z' || z === 'z') iso += 'Z'
  else if (z === '+' || z === '-') iso += `${z}${tzh}:${tzm}`
  const t = Date.parse(iso)
  return Number.isNaN(t) ? '' : new Date(t).toISOString()
}
