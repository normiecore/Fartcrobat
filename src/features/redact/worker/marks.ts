/** Reading and writing redaction marks (Redact annotations) in the engine worker. */
import type { Quad, Rect } from '@shared/geometry'
import { hexToRgb, quadToRect, rgbToHex } from '@shared/geometry'
import type { PDFAnnotation, PDFObject, Session } from '@engine/session'
import { isNull, readName, readNumber, readString } from '@engine/util/pdf'
import {
  DA_FONT_NAMES,
  DEFAULT_PROPS,
  OVERLAY_FONTS,
  type MarkInfo,
  type MarkKind,
  type OverlayAlign,
  type OverlayFont,
  type RedactionProps
} from '../shared'

const ALIGN: OverlayAlign[] = ['left', 'center', 'right']

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function colorArray(s: Session, hex: string): PDFObject {
  const arr = s.pdf.newArray()
  for (const v of hexToRgb(hex)) arr.push(Math.round(v * 1000) / 1000)
  return arr
}

function readColor(obj: PDFObject): string | null {
  if (isNull(obj)) return null
  const o = obj.resolve()
  if (!o.isArray() || o.length === 0) return null
  const vals: number[] = []
  for (let i = 0; i < o.length; i++) vals.push(readNumber(o.get(i), 0))
  return rgbToHex(vals)
}

function fontFromDA(name: string): OverlayFont {
  const hit = (Object.entries(DA_FONT_NAMES) as [OverlayFont, string][]).find(([, n]) => n === name)
  if (hit) return hit[0]
  if (/^Ti|Times/i.test(name)) return /Bo|Bold/i.test(name) ? 'Times-Bold' : 'Times-Roman'
  if (/^Co|Courier/i.test(name)) return /Bo|Bold/i.test(name) ? 'Courier-Bold' : 'Courier'
  return /Bo|Bold/i.test(name) ? 'Helvetica-Bold' : 'Helvetica'
}

function extraDict(obj: PDFObject): PDFObject | null {
  const d = obj.get('FartcrobatData')
  return !isNull(d) && d.isDictionary() ? d : null
}

/** Reads the overlay/appearance properties stored on a Redact annotation. */
export function readProps(obj: PDFObject): RedactionProps {
  const p: RedactionProps = { ...DEFAULT_PROPS }
  p.outlineColor = readColor(obj.get('C')) ?? DEFAULT_PROPS.outlineColor
  const ic = obj.get('IC')
  // Absent IC means "no fill" for marks written by other apps only when explicitly empty.
  if (isNull(ic)) p.fillColor = DEFAULT_PROPS.fillColor
  else p.fillColor = readColor(ic)
  const text = readString(obj.get('OverlayText'))
  p.repeat = safe(() => {
    const r = obj.get('Repeat')
    return !isNull(r) && r.isBoolean() ? r.asBoolean() : false
  }, false)
  const q = Math.round(readNumber(obj.get('Q'), 0))
  p.align = ALIGN[q] ?? 'left'
  const da = readString(obj.get('DA'))
  const tf = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da)
  if (tf) {
    p.font = fontFromDA(tf[1])
    const size = parseFloat(tf[2])
    p.autoSize = !(size > 0)
    if (size > 0) p.fontSize = size
  }
  const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da)
  const g = /([\d.]+)\s+g\b/.exec(da)
  if (rg) p.textColor = rgbToHex([parseFloat(rg[1]), parseFloat(rg[2]), parseFloat(rg[3])])
  else if (g) p.textColor = rgbToHex([parseFloat(g[1])])
  p.overlay = text ? 'custom' : 'none'
  if (text) p.customText = text
  const extra = extraDict(obj)
  if (extra) {
    const font = readString(extra.get('font')) as OverlayFont
    if (OVERLAY_FONTS.some((f) => f.id === font)) p.font = font
    const size = parseFloat(readString(extra.get('fontSize')))
    if (size > 0) p.fontSize = size
    const auto = readString(extra.get('autoSize'))
    if (auto) p.autoSize = auto === '1'
    const mode = readString(extra.get('overlay'))
    if (text && mode === 'code') {
      p.overlay = 'code'
      p.code = text
      p.customText = readString(extra.get('customText')) || DEFAULT_PROPS.customText
    } else if (!text) {
      const custom = readString(extra.get('customText'))
      const code = readString(extra.get('code'))
      if (custom) p.customText = custom
      if (code) p.code = code
    }
  }
  return p
}

/** Writes overlay/appearance properties onto a Redact annotation (call annot.update() afterwards). */
export function writeProps(s: Session, annot: PDFAnnotation, p: RedactionProps) {
  const obj = annot.getObject()
  annot.setColor(hexToRgb(p.outlineColor))
  if (p.fillColor) obj.put('IC', colorArray(s, p.fillColor))
  else obj.put('IC', s.pdf.newArray())
  const text = p.overlay === 'custom' ? p.customText.trim() : p.overlay === 'code' ? p.code.trim() : ''
  if (text) obj.put('OverlayText', s.pdf.newString(text))
  else obj.delete('OverlayText')
  obj.put('Repeat', s.pdf.newBoolean(p.repeat))
  obj.put('Q', ALIGN.indexOf(p.align))
  const [r, g, b] = hexToRgb(p.textColor)
  const f = (v: number) => String(Math.round(v * 1000) / 1000)
  obj.put('DA', s.pdf.newString(`/${DA_FONT_NAMES[p.font]} ${p.autoSize ? 0 : f(p.fontSize)} Tf ${f(r)} ${f(g)} ${f(b)} rg`))
  let extra = extraDict(obj)
  if (!extra) {
    obj.put('FartcrobatData', s.pdf.newDictionary())
    extra = obj.get('FartcrobatData')
  }
  extra.put('fartcrobat', s.pdf.newString('redact'))
  extra.put('font', s.pdf.newString(p.font))
  extra.put('fontSize', s.pdf.newString(String(p.fontSize)))
  extra.put('autoSize', s.pdf.newString(p.autoSize ? '1' : '0'))
  extra.put('overlay', s.pdf.newString(p.overlay))
  extra.put('customText', s.pdf.newString(p.customText))
  extra.put('code', s.pdf.newString(p.code))
}

export function markKind(obj: PDFObject, hasQuads: boolean): MarkKind {
  const extra = extraDict(obj)
  const k = extra ? readString(extra.get('kind')) : ''
  if (k === 'text' || k === 'area' || k === 'page') return k
  return hasQuads ? 'text' : 'area'
}

export function setMarkKind(s: Session, annot: PDFAnnotation, kind: MarkKind) {
  const obj = annot.getObject()
  let extra = extraDict(obj)
  if (!extra) {
    obj.put('FartcrobatData', s.pdf.newDictionary())
    extra = obj.get('FartcrobatData')
  }
  extra.put('kind', s.pdf.newString(kind))
}

/** True when the annotation dictionary is a Redact annotation (without loading the page). */
export function isRedactDict(obj: PDFObject): boolean {
  return safe(() => readName(obj.resolve().get('Subtype')) === 'Redact', false)
}

/** Pages that contain at least one Redact annotation (reads page dictionaries only). */
export function pagesWithMarks(s: Session): number[] {
  const out: number[] = []
  const n = s.pageCount()
  for (let i = 0; i < n; i++) {
    const annots = safe(() => s.pdf.findPage(i).get('Annots'), null)
    if (!annots || isNull(annots)) continue
    const arr = annots.resolve()
    if (!arr.isArray()) continue
    for (let k = 0; k < arr.length; k++) {
      if (isRedactDict(arr.get(k))) {
        out.push(i)
        break
      }
    }
  }
  return out
}

function dateIso(fn: () => Date): string {
  try {
    const d = fn()
    return d && !Number.isNaN(d.getTime()) ? d.toISOString() : ''
  } catch {
    return ''
  }
}

export function markInfo(s: Session, annot: PDFAnnotation, pageIndex: number, position: number): MarkInfo {
  const obj = annot.getObject()
  const quads = safe(() => (annot.hasQuadPoints() ? (annot.getQuadPoints() as Quad[]) : []), [] as Quad[])
  let rect = safe(() => annot.getRect() as Rect, [0, 0, 0, 0] as Rect)
  if (quads.length) {
    const rs = quads.map(quadToRect)
    rect = [
      Math.min(...rs.map((r) => r[0])),
      Math.min(...rs.map((r) => r[1])),
      Math.max(...rs.map((r) => r[2])),
      Math.max(...rs.map((r) => r[3]))
    ]
  }
  return {
    id: s.annotationId(annot, pageIndex, position),
    page: pageIndex,
    kind: markKind(obj, quads.length > 0),
    rect,
    quads,
    props: readProps(obj),
    author: safe(() => (annot.hasAuthor() ? annot.getAuthor() : ''), ''),
    created: dateIso(() => annot.getCreationDate())
  }
}

/** Redact annotations of one page with their position in the page's annotation list. */
export function pageMarks(s: Session, pageIndex: number): { annot: PDFAnnotation; position: number }[] {
  const out: { annot: PDFAnnotation; position: number }[] = []
  s.page(pageIndex)
    .getAnnotations()
    .forEach((a, k) => {
      if (safe(() => a.getType(), '') === 'Redact') out.push({ annot: a, position: k })
    })
  return out
}

/** The areas (page space) a mark covers: its quads, or its rectangle. */
export function markAreas(m: Pick<MarkInfo, 'quads' | 'rect'>): Rect[] {
  return m.quads.length ? m.quads.map(quadToRect) : [m.rect]
}
