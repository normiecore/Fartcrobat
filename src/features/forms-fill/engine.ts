/**
 * Engine side of form filling: widget details the core field list does not carry (tab order,
 * button actions, list selections, signers), a one-call snapshot of the whole form for scripts,
 * and the undoable "fill" step that writes values, formatted appearances, script-driven property
 * changes and calculation results together.
 */
import type { Rect } from '@shared/geometry'
import { defineOps, EngineError, mutation } from '@engine/define'
import formsOps, { fieldInfo, onStateOf, type FieldInfo } from '@engine/ops/forms'
import type { PDFObject, PDFWidget, Session } from '@engine/session'
import { catalog, isNull, readName, readNumber, readRect, readString, walkFields } from '@engine/util/pdf'
import { signerCommonName } from './der'

export type ButtonAction =
  | { kind: 'reset'; fields: string[]; exclude: boolean }
  | { kind: 'submit'; url: string }
  | { kind: 'js'; script: string }
  | { kind: 'uri'; uri: string }
  | { kind: 'goto'; page: number; x: number | null; y: number | null }
  | { kind: 'named'; name: string }
  | { kind: 'hide'; fields: string[]; hide: boolean }
  | { kind: 'other'; type: string }

export interface WidgetExtra {
  id: number
  /** Position of the widget in its page's tab order (0 = first). */
  tabIndex: number
  /** /MK /R: rotation of the widget content, degrees counter-clockwise. */
  rotation: number
  noToggleToOff: boolean
  radiosInUnison: boolean
  commitOnSelChange: boolean
  doNotScroll: boolean
  /** Selected export values (list boxes, including multi-select). */
  selected: string[]
  /** /TI: first visible item of a list box. */
  topIndex: number
  /** Mouse-up action (buttons; JavaScript on check boxes and radio buttons). */
  action: ButtonAction | null
  /** Signed signature fields: signer name and signing time (ISO) when known. */
  signer: string | null
  signedAt: string | null
  /** Annotation flags: hidden on screen (Hidden or NoView). */
  noView: boolean
}

export interface FormSnapshotData {
  fields: FieldInfo[]
  values: Record<string, string | string[]>
  calcOrder: string[]
  docScripts: string[]
  /** Widget ids in tab order, page by page. */
  tabOrder: number[]
}

export interface FillChange {
  /** Widget id: picks the widget for check boxes and radio buttons set with `true`. */
  id?: number
  name: string
  /** text: string; check box: export value, 'Off' or boolean; radio: export value or 'Off'; list: string[]. */
  value?: string | boolean | string[]
  /** Text to show in the field when it differs from the stored value (formatting). */
  display?: string
  /** #rrggbb text colour (negative numbers in red). */
  textColor?: string
  /** 0 visible, 1 hidden, 2 visible but not printed, 3 printed but not visible. */
  visibility?: number
  readOnly?: boolean
  required?: boolean
}

export interface ExportedField {
  name: string
  type: 'text' | 'checkbox' | 'radio' | 'combo' | 'list'
  value: string | string[]
  noExport: boolean
}

const FLAG_HIDDEN = 2
const FLAG_PRINT = 4
const FLAG_NOVIEW = 32

/** Resolves an object, or null when it is missing (mupdf's null objects cannot be resolved). */
function res(obj: PDFObject | null | undefined): PDFObject | null {
  return isNull(obj) ? null : obj!.resolve()
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** The dictionary holding /T, /V and /Ff for a widget (the widget itself or its parent). */
function fieldDict(widgetObj: PDFObject): PDFObject {
  const o = widgetObj.resolve()
  if (isNull(o.get('T')) && !isNull(o.get('Parent'))) return o.get('Parent').resolve()
  return o
}

/** Fully qualified name of a field dictionary. */
function fullName(field: PDFObject): string {
  const parts: string[] = []
  let cur: PDFObject | null = field.resolve()
  for (let d = 0; d < 32 && cur && !isNull(cur); d++) {
    const t = readString(cur.get('T'))
    if (t) parts.unshift(t)
    const p = cur.get('Parent')
    cur = isNull(p) ? null : p.resolve()
  }
  return parts.join('.')
}

function jsText(action: PDFObject): string {
  const js = res(action.get('JS'))
  if (!js) return ''
  if (js.isStream()) return js.readStream().asString()
  return readString(js)
}

function fieldNamesOf(list: PDFObject): string[] {
  const out: string[] = []
  if (isNull(list) || !list.isArray()) return out
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i)
    if (item.isIndirect() || item.resolve().isDictionary()) out.push(fullName(item))
    else out.push(readString(item))
  }
  return out.filter(Boolean)
}

function namedDest(s: Session, name: string): PDFObject | null {
  const cat = catalog(s.pdf)
  const old = cat.get('Dests')
  if (!isNull(old)) {
    const d = old.get(name)
    if (!isNull(d)) return d.resolve()
  }
  const tree = safe(() => s.pdf.loadNameTree('Dests'), {} as Record<string, PDFObject>)
  const d = tree[name]
  return d ? d.resolve() : null
}

function destToPage(s: Session, dest: PDFObject | null): { page: number; x: number | null; y: number | null } | null {
  if (!dest) return null
  let d: PDFObject | null = dest.resolve()
  if (d.isDictionary()) d = res(d.get('D'))
  if (!d) return null
  if (d.isString() || d.isName()) return destToPage(s, namedDest(s, readString(d)))
  if (!d.isArray() || d.length < 1) return null
  const pageRef = d.get(0)
  let page = -1
  if (pageRef.isIndirect()) page = s.pageIndexById(pageRef.asIndirect())
  else if (pageRef.isNumber()) page = pageRef.asNumber()
  if (page < 0 || page >= s.pageCount()) return null
  const kind = readName(d.get(1))
  let x: number | null = null
  let y: number | null = null
  if (kind === 'XYZ' && d.length >= 4) {
    const ux = d.get(2)
    const uy = d.get(3)
    if (ux.isNumber() || uy.isNumber()) {
      const m = s.userToPage(page)
      const px = ux.isNumber() ? ux.asNumber() : 0
      const py = uy.isNumber() ? uy.asNumber() : 0
      const pt = [px * m[0] + py * m[2] + m[4], px * m[1] + py * m[3] + m[5]]
      x = ux.isNumber() ? pt[0] : null
      y = uy.isNumber() ? pt[1] : null
    }
  }
  return { page, x, y }
}

function readAction(s: Session, action: PDFObject): ButtonAction | null {
  if (isNull(action)) return null
  const a = action.resolve()
  if (!a.isDictionary()) return null
  const type = readName(a.get('S')) ?? ''
  switch (type) {
    case 'ResetForm':
      return { kind: 'reset', fields: fieldNamesOf(a.get('Fields')), exclude: (readNumber(a.get('Flags'), 0) & 1) !== 0 }
    case 'SubmitForm': {
      const f = res(a.get('F'))
      const url = !f ? '' : f.isDictionary() ? readString(f.get('F')) || readString(f.get('UF')) : readString(f)
      return { kind: 'submit', url }
    }
    case 'JavaScript':
      return { kind: 'js', script: jsText(a) }
    case 'URI':
      return { kind: 'uri', uri: readString(a.get('URI')) }
    case 'GoTo': {
      const dest = destToPage(s, a.get('D'))
      return dest ? { kind: 'goto', ...dest } : { kind: 'other', type }
    }
    case 'Named':
      return { kind: 'named', name: readName(a.get('N')) ?? '' }
    case 'Hide': {
      const t = res(a.get('T'))
      const fields = !t ? [] : t.isArray() ? fieldNamesOf(t) : t.isDictionary() ? [fullName(t)] : [readString(t)]
      const h = a.get('H')
      return { kind: 'hide', fields: fields.filter(Boolean), hide: isNull(h) ? true : h.asBoolean() }
    }
    default:
      return { kind: 'other', type: type || 'unknown' }
  }
}

function widgetAction(s: Session, w: PDFWidget): ButtonAction | null {
  const obj = w.getObject()
  const a = readAction(s, obj.get('A'))
  if (a) return a
  const aa = obj.get('AA')
  return isNull(aa) ? null : readAction(s, aa.get('U'))
}

// ---- tab order ------------------------------------------------------------------------------

interface Placed {
  id: number
  objNum: number
  rect: Rect
  annotIndex: number
}

function lines<T extends Placed>(items: T[], axis: 0 | 1): T[] {
  // Group into rows (axis 1) or columns (axis 0) of overlapping items, then sort along the other axis.
  const lo = axis
  const hi = axis + 2
  const other = axis === 1 ? 0 : 1
  const sorted = [...items].sort((a, b) => (a.rect[lo] + a.rect[hi]) / 2 - (b.rect[lo] + b.rect[hi]) / 2)
  const groups: { start: number; end: number; items: T[] }[] = []
  for (const it of sorted) {
    const center = (it.rect[lo] + it.rect[hi]) / 2
    const g = groups[groups.length - 1]
    if (g && center >= g.start && center <= g.end) {
      g.items.push(it)
      g.end = Math.max(g.end, Math.min(it.rect[hi], g.end + (it.rect[hi] - it.rect[lo]) / 2))
    } else groups.push({ start: it.rect[lo], end: it.rect[hi], items: [it] })
  }
  return groups.flatMap((g) => g.items.sort((a, b) => a.rect[other] - b.rect[other] || a.annotIndex - b.annotIndex))
}

/** Object numbers of annotations in logical structure order (/Tabs /S). */
function structureOrder(s: Session): Map<number, number> {
  const key = 'forms-fill:structOrder'
  const journalPos = s.journal().position
  const cached = s.state.get(key) as { pos: number; order: Map<number, number> } | undefined
  if (cached && cached.pos === journalPos) return cached.order
  const order = new Map<number, number>()
  const root = catalog(s.pdf).get('StructTreeRoot')
  const seen = new Set<number>()
  let budget = 200000
  const visit = (node: PDFObject, depth: number) => {
    if (depth > 100 || --budget < 0 || isNull(node)) return
    if (node.isIndirect()) {
      const n = node.asIndirect()
      if (seen.has(n)) return
      seen.add(n)
    }
    const o = node.resolve()
    if (o.isArray()) {
      for (let i = 0; i < o.length; i++) visit(o.get(i), depth + 1)
      return
    }
    if (!o.isDictionary()) return
    if (readName(o.get('Type')) === 'OBJR') {
      const ref = o.get('Obj')
      if (ref.isIndirect() && !order.has(ref.asIndirect())) order.set(ref.asIndirect(), order.size)
      return
    }
    visit(o.get('K'), depth + 1)
  }
  if (!isNull(root)) safe(() => visit(root.get('K'), 0), undefined)
  s.state.set(key, { pos: journalPos, order })
  return order
}

/** Widget ids of a page in tab order. */
function pageTabOrder(s: Session, pageIndex: number): number[] {
  const page = s.page(pageIndex)
  const pageObj = page.getObject()
  const annots = pageObj.get('Annots')
  const annotPos = new Map<number, number>()
  if (!isNull(annots) && annots.resolve().isArray()) {
    const arr = annots.resolve()
    for (let i = 0; i < arr.length; i++) {
      const a = arr.get(i)
      if (a.isIndirect()) annotPos.set(a.asIndirect(), i)
    }
  }
  const items: Placed[] = page.getWidgets().map((w, k) => {
    const objNum = safe(() => w.getObject().asIndirect(), 0)
    return {
      id: s.annotationId(w, pageIndex, k + 50000),
      objNum,
      rect: safe(() => w.getRect() as Rect, [0, 0, 0, 0] as Rect),
      annotIndex: annotPos.get(objNum) ?? 100000 + k
    }
  })
  const tabs = readName(pageObj.get('Tabs'))
  let ordered: Placed[]
  if (tabs === 'C') ordered = lines(items, 0)
  else if (tabs === 'A' || tabs === 'W') ordered = [...items].sort((a, b) => a.annotIndex - b.annotIndex)
  else if (tabs === 'S') {
    const struct = structureOrder(s)
    ordered = [...items].sort((a, b) => {
      const sa = struct.get(a.objNum)
      const sb = struct.get(b.objNum)
      if (sa !== undefined && sb !== undefined) return sa - sb
      if (sa !== undefined) return -1
      if (sb !== undefined) return 1
      return a.annotIndex - b.annotIndex
    })
  } else ordered = lines(items, 1)
  return ordered.map((p) => p.id)
}

/** Pages that have form widgets, found without loading every page. */
function pagesWithWidgets(s: Session): number[] {
  const out: number[] = []
  const n = s.pageCount()
  for (let p = 0; p < n; p++) {
    const annots = res(s.pdf.findPage(p).get('Annots'))
    if (!annots || !annots.isArray()) continue
    for (let i = 0; i < annots.length; i++) {
      const a = res(annots.get(i))
      if (a && a.isDictionary() && readName(a.get('Subtype')) === 'Widget') {
        out.push(p)
        break
      }
    }
  }
  return out
}

// ---- values -----------------------------------------------------------------------------------

function readValue(v: PDFObject): string | string[] | null {
  if (isNull(v)) return null
  const o = v.resolve()
  if (o.isArray()) {
    const out: string[] = []
    for (let i = 0; i < o.length; i++) out.push(readString(o.get(i)))
    return out
  }
  if (o.isName()) return o.asName()
  if (o.isString()) return o.asString()
  if (o.isNumber()) return String(o.asNumber())
  return null
}

function fieldKind(ft: string | null, flags: number): ExportedField['type'] | 'button' | 'signature' | null {
  if (ft === 'Tx') return 'text'
  if (ft === 'Ch') return flags & (1 << 17) ? 'combo' : 'list'
  if (ft === 'Btn') {
    if (flags & (1 << 16)) return 'button'
    return flags & (1 << 15) ? 'radio' : 'checkbox'
  }
  if (ft === 'Sig') return 'signature'
  return null
}

function allValues(s: Session): ExportedField[] {
  const out: ExportedField[] = []
  walkFields(s.pdf, (field, name, ft) => {
    const f = field.resolve()
    const flags = Math.round(readNumber(f.getInheritable('Ff'), 0))
    const type = fieldKind(ft, flags)
    if (!type || type === 'button' || type === 'signature') return
    let value = readValue(f.getInheritable('V'))
    if (value === null) value = type === 'checkbox' || type === 'radio' ? 'Off' : type === 'list' && flags & (1 << 21) ? [] : ''
    if (type === 'list' && flags & (1 << 21) && !Array.isArray(value)) value = value ? [value] : []
    out.push({ name, type, value, noExport: (flags & 4) !== 0 })
  })
  return out
}

function documentScripts(s: Session): string[] {
  const tree = safe(() => s.pdf.loadNameTree('JavaScript'), {} as Record<string, PDFObject>)
  return Object.keys(tree)
    .sort()
    .map((k) => {
      const a = tree[k].resolve()
      return a.isDictionary() && readName(a.get('S')) === 'JavaScript' ? safe(() => jsText(a), '') : ''
    })
    .filter(Boolean)
}

// ---- writing ----------------------------------------------------------------------------------

interface NamedWidget {
  pageIndex: number
  widget: PDFWidget
  id: number
}

function widgetsByName(s: Session): Map<string, NamedWidget[]> {
  const map = new Map<string, NamedWidget[]>()
  for (const p of pagesWithWidgets(s)) {
    s.page(p)
      .getWidgets()
      .forEach((w, k) => {
        const name = safe(() => w.getName(), '')
        if (!name) return
        const list = map.get(name) ?? []
        list.push({ pageIndex: p, widget: w, id: s.annotationId(w, p, k + 50000) })
        map.set(name, list)
      })
  }
  return map
}

function fieldType(w: PDFWidget): string {
  return safe(() => w.getFieldType(), 'widget')
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000)

/** Replaces the colour operator in a /DA string. */
export function daWithColor(da: string, hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return da
  const color = rgb[0] === rgb[1] && rgb[1] === rgb[2] ? `${fmt(rgb[0])} g` : `${rgb.map(fmt).join(' ')} rg`
  const stripped = da
    .replace(/(^|\s)[\d.]+\s+[\d.]+\s+[\d.]+\s+[\d.]+\s+k(?=\s|$)/g, ' ')
    .replace(/(^|\s)[\d.]+\s+[\d.]+\s+[\d.]+\s+rg(?=\s|$)/g, ' ')
    .replace(/(^|\s)[\d.]+\s+g(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return `${stripped} ${color}`.trim()
}

function setTextColor(s: Session, widgets: NamedWidget[], hex: string) {
  for (const { widget } of widgets) {
    const obj = widget.getObject()
    const da = readString(obj.getInheritable('DA')) || readString(s.pdf.getTrailer().get('Root', 'AcroForm', 'DA')) || '/Helv 0 Tf 0 g'
    const next = daWithColor(da, hex)
    if (next !== da) obj.put('DA', s.pdf.newString(next))
  }
}

function writeText(s: Session, widgets: NamedWidget[], raw: string, display: string | undefined, forceAppearance: boolean) {
  const first = widgets[0].widget
  const isPassword = (safe(() => first.getFieldFlags(), 0) & (1 << 13)) !== 0
  let shown = display ?? raw
  if (isPassword) shown = '*'.repeat(Math.min(raw.length, 64))
  const current = safe(() => first.getValue(), '')
  if (shown === current && forceAppearance) {
    // Same text but the appearance must be rebuilt (e.g. new text colour): change it twice.
    first.setTextValue(shown + ' ')
  }
  first.setTextValue(shown)
  for (const w of widgets) {
    safe(() => w.widget.update(), false)
    s.touch(w.pageIndex)
  }
  if (shown !== raw) {
    // Keep the real value in /V while the appearance shows the formatted (or masked) text.
    for (const w of widgets) fieldDict(w.widget.getObject()).put('V', s.pdf.newString(raw))
  }
}

function writeButtonState(s: Session, widgets: NamedWidget[], target: string) {
  // target: on-state name to switch on, or 'Off'
  for (const w of widgets) {
    const on = onStateOf(w.widget)
    const obj = w.widget.getObject()
    const want = on !== null && on === target ? on : 'Off'
    if (readName(obj.get('AS')) !== want) obj.put('AS', s.pdf.newName(want))
    s.touch(w.pageIndex)
  }
  // Fields split over several dictionaries with the same name keep /V on each.
  for (const w of widgets) fieldDict(w.widget.getObject()).put('V', s.pdf.newName(target))
}

function choiceOptions(w: PDFWidget): { label: string; value: string }[] {
  const labels = safe(() => w.getOptions(false), [] as string[])
  const values = safe(() => w.getOptions(true), [] as string[])
  return labels.map((label, i) => ({ label, value: values[i] ?? label }))
}

function pdfStringBytes(text: string): string {
  let out = '('
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (ch === '(' || ch === ')' || ch === '\\') out += '\\' + ch
    else if (c < 32) out += ' '
    else if (c < 256) out += String.fromCharCode(c)
    else out += WIN_ANSI_EXTRA[ch] ?? '?'
  }
  return out + ')'
}

// Characters outside Latin-1 that WinAnsiEncoding still has.
const WIN_ANSI_EXTRA: Record<string, string> = {
  '€': '\x80',
  '‚': '\x82',
  'ƒ': '\x83',
  '„': '\x84',
  '…': '\x85',
  '†': '\x86',
  '‡': '\x87',
  'ˆ': '\x88',
  '‰': '\x89',
  'Š': '\x8a',
  '‹': '\x8b',
  'Œ': '\x8c',
  'Ž': '\x8e',
  '‘': '\x91',
  '’': '\x92',
  '“': '\x93',
  '”': '\x94',
  '•': '\x95',
  '–': '\x96',
  '—': '\x97',
  '˜': '\x98',
  '™': '\x99',
  'š': '\x9a',
  '›': '\x9b',
  'œ': '\x9c',
  'ž': '\x9e',
  'Ÿ': '\x9f'
}

function colorOps(arr: PDFObject, stroke: boolean): string | null {
  if (isNull(arr) || !arr.isArray() || arr.length === 0) return null
  const v: number[] = []
  for (let i = 0; i < arr.length; i++) v.push(arr.get(i).asNumber())
  if (v.length === 1) return `${fmt(v[0])} ${stroke ? 'G' : 'g'}`
  if (v.length === 3) return `${v.map(fmt).join(' ')} ${stroke ? 'RG' : 'rg'}`
  if (v.length === 4) return `${v.map(fmt).join(' ')} ${stroke ? 'K' : 'k'}`
  return null
}

/**
 * Builds the normal appearance of a list box with the selected items highlighted (MuPDF's own
 * list box appearance does not show the selection).
 */
function writeListAppearance(s: Session, w: PDFWidget, selected: Set<string>, topIndex: number) {
  const obj = w.getObject()
  const mk = obj.get('MK')
  if (!isNull(mk) && readNumber(mk.get('R'), 0) % 360 !== 0) return // rotated: keep MuPDF's appearance
  const r = readRect(obj.get('Rect'))
  const width = r[2] - r[0]
  const height = r[3] - r[1]
  if (width <= 0 || height <= 0) return
  const daStr = readString(obj.getInheritable('DA')) || readString(s.pdf.getTrailer().get('Root', 'AcroForm', 'DA')) || '/Helv 0 Tf 0 g'
  const tf = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(daStr)
  const fontName = tf?.[1] ?? 'Helv'
  const size = tf && parseFloat(tf[2]) > 0 ? parseFloat(tf[2]) : 12
  const textColor = daStr.replace(/\/[^\s/]+\s+[\d.]+\s+Tf/, '').trim() || '0 g'
  // Find the font: the form's default resources, else the existing appearance's resources.
  let fontRef: PDFObject | null = null
  const dr = s.pdf.getTrailer().get('Root', 'AcroForm', 'DR')
  if (!isNull(dr) && !isNull(dr.get('Font')) && !isNull(dr.get('Font').get(fontName))) fontRef = dr.get('Font').get(fontName)
  if (!fontRef) {
    const n = obj.get('AP').get('N')
    const f = isNull(n) ? null : n.get('Resources').get('Font').get(fontName)
    if (f && !isNull(f)) fontRef = f
  }
  if (!fontRef) return
  const bs = obj.get('BS')
  const bw = isNull(mk) || isNull(mk.get('BC')) ? 0 : isNull(bs) ? 1 : readNumber(bs.get('W'), 1)
  const bg = isNull(mk) ? null : colorOps(mk.get('BG'), false)
  const bc = isNull(mk) ? null : colorOps(mk.get('BC'), true)
  const opts = choiceOptions(w)
  const lh = Math.round(size * 1.25 * 100) / 100
  const parts: string[] = ['/Tx BMC', 'q']
  if (bg) parts.push(bg, `0 0 ${fmt(width)} ${fmt(height)} re f`)
  if (bc && bw > 0) parts.push(bc, `${fmt(bw)} w`, `${fmt(bw / 2)} ${fmt(bw / 2)} ${fmt(width - bw)} ${fmt(height - bw)} re S`)
  const inset = Math.max(bw, 1)
  parts.push(`${fmt(inset)} ${fmt(inset)} ${fmt(width - 2 * inset)} ${fmt(height - 2 * inset)} re W n`)
  for (let i = Math.max(0, topIndex); i < opts.length; i++) {
    const rowTop = height - inset - (i - topIndex) * lh
    const rowBottom = rowTop - lh
    if (rowTop <= inset) break
    if (selected.has(opts[i].value)) parts.push('0.6 0.757 0.855 rg', `${fmt(inset)} ${fmt(rowBottom)} ${fmt(width - 2 * inset)} ${fmt(lh)} re f`)
    parts.push('BT', `/${fontName} ${fmt(size)} Tf`, textColor, `${fmt(inset + 2)} ${fmt(rowBottom + (lh - size) / 2 + size * 0.22)} Td`, `${pdfStringBytes(opts[i].label)} Tj`, 'ET')
  }
  parts.push('Q', 'EMC')
  const content = parts.join('\n')
  const bytes = new Uint8Array(content.length)
  for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff
  const doc = s.pdf
  const dict = doc.newDictionary()
  dict.put('Type', doc.newName('XObject'))
  dict.put('Subtype', doc.newName('Form'))
  const bbox = doc.newArray()
  for (const v of [0, 0, width, height]) bbox.push(doc.newReal(v))
  dict.put('BBox', bbox)
  const res = doc.newDictionary()
  const fonts = doc.newDictionary()
  fonts.put(fontName, fontRef)
  res.put('Font', fonts)
  dict.put('Resources', res)
  const stream = doc.addStream(bytes, dict)
  let ap = obj.get('AP')
  if (isNull(ap)) {
    ap = doc.newDictionary()
    obj.put('AP', ap)
  }
  ap.put('N', stream)
}

function writeChoice(s: Session, widgets: NamedWidget[], value: string | string[]) {
  const first = widgets[0].widget
  const opts = choiceOptions(first)
  const field = fieldDict(first.getObject())
  const isCombo = fieldType(first) === 'combobox'
  const values = Array.isArray(value) ? value : value === '' ? [] : [value]
  const doc = s.pdf
  if (isCombo) {
    const v = values[0] ?? ''
    const idx = opts.findIndex((o) => o.value === v)
    const label = idx >= 0 ? opts[idx].label : v
    first.setChoiceValue(label)
    for (const w of widgets) {
      safe(() => w.widget.update(), false)
      s.touch(w.pageIndex)
    }
    if (label !== v) field.put('V', doc.newString(v))
    if (idx >= 0) {
      const ia = doc.newArray()
      ia.push(doc.newInteger(idx))
      field.put('I', ia)
    } else field.delete('I')
    return
  }
  // list box
  if (!values.length) field.delete('V')
  else if (values.length === 1) field.put('V', doc.newString(values[0]))
  else {
    const arr = doc.newArray()
    for (const v of values) arr.push(doc.newString(v))
    field.put('V', arr)
  }
  const indices = values.map((v) => opts.findIndex((o) => o.value === v)).filter((i) => i >= 0).sort((a, b) => a - b)
  if (indices.length) {
    const ia = doc.newArray()
    for (const i of indices) ia.push(doc.newInteger(i))
    field.put('I', ia)
  } else field.delete('I')
  const selected = new Set(values)
  for (const w of widgets) {
    const obj = w.widget.getObject()
    const r = readRect(obj.get('Rect'))
    const da = readString(obj.getInheritable('DA'))
    const size = parseFloat(/([\d.]+)\s+Tf/.exec(da)?.[1] ?? '12') || 12
    const visibleRows = Math.max(1, Math.floor((r[3] - r[1] - 2) / (size * 1.25)))
    let top = Math.round(readNumber(field.get('TI'), 0))
    if (indices.length && (indices[0] < top || indices[0] >= top + visibleRows)) top = Math.max(0, indices[0])
    if (top !== Math.round(readNumber(field.get('TI'), 0))) field.put('TI', doc.newInteger(top))
    writeListAppearance(s, w.widget, selected, top)
    s.touch(w.pageIndex)
  }
}

function setFlags(s: Session, widgets: NamedWidget[], change: FillChange) {
  if (change.visibility !== undefined) {
    for (const w of widgets) {
      let f = safe(() => w.widget.getFlags(), 0)
      f &= ~(FLAG_HIDDEN | FLAG_NOVIEW)
      switch (change.visibility) {
        case 0:
          f |= FLAG_PRINT
          break
        case 1:
          f |= FLAG_HIDDEN
          f &= ~FLAG_PRINT
          break
        case 2:
          f &= ~FLAG_PRINT
          break
        case 3:
          f |= FLAG_NOVIEW | FLAG_PRINT
          break
      }
      w.widget.setFlags(f)
      s.touch(w.pageIndex)
    }
  }
  if (change.readOnly !== undefined || change.required !== undefined) {
    const field = fieldDict(widgets[0].widget.getObject())
    let ff = Math.round(readNumber(field.getInheritable('Ff'), 0))
    if (change.readOnly !== undefined) ff = change.readOnly ? ff | 1 : ff & ~1
    if (change.required !== undefined) ff = change.required ? ff | 2 : ff & ~2
    field.put('Ff', s.pdf.newInteger(ff))
    for (const w of widgets) s.touch(w.pageIndex)
  }
}

export function applyFill(s: Session, changes: FillChange[]) {
  const byName = widgetsByName(s)
  const missing: string[] = []
  for (const c of changes) {
    const widgets = byName.get(c.name)
    if (!widgets?.length) {
      missing.push(c.name)
      continue
    }
    const type = fieldType(widgets[0].widget)
    if (c.textColor && type === 'text') setTextColor(s, widgets, c.textColor)
    if (c.value !== undefined) {
      switch (type) {
        case 'text':
          writeText(s, widgets, Array.isArray(c.value) ? c.value.join(', ') : String(c.value), c.display, !!c.textColor)
          break
        case 'checkbox':
        case 'radiobutton': {
          let target: string
          if (typeof c.value === 'boolean') {
            const w = (c.id !== undefined && widgets.find((x) => x.id === c.id)) || widgets[0]
            target = c.value ? (onStateOf(w.widget) ?? 'Yes') : 'Off'
          } else {
            const v = Array.isArray(c.value) ? (c.value[0] ?? 'Off') : c.value
            target = v === '' ? 'Off' : v
            // A plain "on" value for a single check box means its own export value.
            if (type === 'checkbox' && target !== 'Off' && !widgets.some((w) => onStateOf(w.widget) === target)) {
              const truthy = /^(1|true|yes|on|x)$/i.test(target)
              target = truthy ? (onStateOf(widgets[0].widget) ?? 'Off') : 'Off'
            }
          }
          writeButtonState(s, widgets, target)
          break
        }
        case 'combobox':
        case 'listbox':
          writeChoice(s, widgets, Array.isArray(c.value) ? c.value.map(String) : String(c.value))
          break
        default:
          throw new EngineError(`“${c.name}” cannot be filled in`, 'BAD_FIELD')
      }
    } else if (c.textColor && type === 'text') {
      const raw = safe(() => readString(fieldDict(widgets[0].widget.getObject()).get('V')), '')
      writeText(s, widgets, raw, c.display, true)
    }
    setFlags(s, widgets, c)
  }
  s.documentChanged()
  return { missing }
}

// ---- FDF ----------------------------------------------------------------------------------------

function fdfFields(node: PDFObject, prefix: string, out: { name: string; value: string | string[] }[], depth: number) {
  if (depth > 32 || isNull(node) || !node.isArray()) return
  for (let i = 0; i < node.length; i++) {
    const f = node.get(i).resolve()
    if (!f.isDictionary()) continue
    const t = readString(f.get('T'))
    const name = t ? (prefix ? `${prefix}.${t}` : t) : prefix
    const v = readValue(f.get('V'))
    if (v !== null && name) out.push({ name, value: v })
    const kids = res(f.get('Kids'))
    if (kids) fdfFields(kids, name, out, depth + 1)
  }
}

export default defineOps('forms-fill', {
  /** Extra details for every widget on a page. */
  pageExtras(s, pageIndex: number): WidgetExtra[] {
    const order = pageTabOrder(s, pageIndex)
    return s
      .page(pageIndex)
      .getWidgets()
      .map((w, k) => {
        const id = s.annotationId(w, pageIndex, k + 50000)
        const obj = w.getObject()
        const field = fieldDict(obj)
        const flags = safe(() => w.getFieldFlags(), 0)
        const type = fieldType(w)
        const mk = obj.get('MK')
        let selected: string[] = []
        if (type === 'listbox') {
          const v = readValue(field.getInheritable('V'))
          selected = v === null ? [] : Array.isArray(v) ? v : [v]
        }
        let signer: string | null = null
        let signedAt: string | null = null
        if (type === 'signature') {
          const v = field.getInheritable('V')
          if (!isNull(v)) {
            const sig = v.resolve()
            signer = readString(sig.get('Name')) || null
            if (!signer) {
              const contents = sig.get('Contents')
              if (!isNull(contents)) signer = signerCommonName(safe(() => contents.asByteString(), new Uint8Array()))
            }
            const m = readString(sig.get('M'))
            const parsed = /D?:?(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(m)
            if (parsed) {
              const [, y, mo, d, h = '00', mi = '00', se = '00'] = parsed
              const t = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}`)
              signedAt = Number.isNaN(t) ? null : new Date(t).toISOString()
            }
          }
        }
        let action: ButtonAction | null = null
        if (type === 'button') action = widgetAction(s, w)
        else if (type === 'checkbox' || type === 'radiobutton') {
          const a = widgetAction(s, w)
          action = a && (a.kind === 'js' || a.kind === 'reset') ? a : null
        }
        return {
          id,
          tabIndex: Math.max(0, order.indexOf(id)),
          rotation: isNull(mk) ? 0 : ((Math.round(readNumber(mk.get('R'), 0)) % 360) + 360) % 360,
          noToggleToOff: (flags & (1 << 14)) !== 0,
          radiosInUnison: (flags & (1 << 25)) !== 0 && type === 'radiobutton',
          commitOnSelChange: (flags & (1 << 26)) !== 0 && (type === 'combobox' || type === 'listbox'),
          doNotScroll: (flags & (1 << 23)) !== 0 && type === 'text',
          selected,
          topIndex: Math.round(readNumber(field.get('TI'), 0)),
          action,
          signer,
          signedAt,
          noView: (safe(() => w.getFlags(), 0) & (FLAG_HIDDEN | FLAG_NOVIEW)) !== 0
        }
      })
  },

  /** Widget ids of the whole document in tab order. */
  tabOrder(s): number[] {
    const out: number[] = []
    for (const p of pagesWithWidgets(s)) out.push(...pageTabOrder(s, p))
    return out
  },

  /** Everything the form scripts need, in one call. */
  snapshot(s): FormSnapshotData {
    const pages = pagesWithWidgets(s)
    const fields: FieldInfo[] = []
    const tabOrder: number[] = []
    for (const p of pages) {
      fields.push(...s.page(p).getWidgets().map((w, k) => fieldInfo(s, w, p, k)))
      tabOrder.push(...pageTabOrder(s, p))
    }
    const values: Record<string, string | string[]> = {}
    for (const f of allValues(s)) values[f.name] = f.value
    return { fields, values, calcOrder: formsOps.ops.calculationOrder(s), docScripts: documentScripts(s), tabOrder }
  },

  /** Field values for Export Data (text, check boxes, radio buttons, choices). */
  exportValues(s): ExportedField[] {
    return allValues(s)
  },

  /**
   * Writes field values (with formatted appearances), text colours and script-driven property
   * changes in one undo step. Returns the names that do not exist in this form.
   */
  fill: mutation(
    (changes: FillChange[], label?: string) => label ?? (changes.length === 1 ? 'Fill Form Field' : 'Fill Form'),
    (s, changes: FillChange[], _label?: string) => applyFill(s, changes)
  ),

  /** Reads the fields of an FDF file. */
  parseFdf(s, bytes: Uint8Array): { file: string; fields: { name: string; value: string | string[] }[] } {
    let fdf: InstanceType<Session['mupdf']['PDFDocument']>
    try {
      fdf = new s.mupdf.PDFDocument(bytes)
    } catch (err) {
      throw new EngineError(`This is not a valid FDF file (${(err as Error).message})`, 'BAD_FDF')
    }
    try {
      const root = res(fdf.getTrailer().get('Root'))
      const dict = root ? res(root.get('FDF')) : null
      if (!dict || !dict.isDictionary()) throw new EngineError('This file has no form data', 'BAD_FDF')
      const fields: { name: string; value: string | string[] }[] = []
      const list = res(dict.get('Fields'))
      if (list) fdfFields(list, '', fields, 0)
      const f = res(dict.get('F'))
      const file = !f ? '' : f.isDictionary() ? readString(f.get('F')) : readString(f)
      return { file, fields }
    } finally {
      fdf.destroy()
    }
  }
})
