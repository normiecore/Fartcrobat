/**
 * Low-level AcroForm structure helpers for Prepare Form (engine side).
 *
 * Vocabulary: a *widget* is the annotation dictionary on a page (/Subtype /Widget); a *field* is
 * the dictionary with the field name (/T) and type (/FT). A single-widget field is usually one
 * merged dictionary; radio groups and fields copied onto several pages are a parent field with
 * widget /Kids.
 */
import type { Rect } from '@shared/geometry'
import { hexToRgb, normalizeRect, rgbToHex, transformRect } from '@shared/geometry'
import { EngineError } from '@engine/define'
import type { PDFDocument, PDFObject, Session } from '@engine/session'
import { catalog, isNull, readName, readNumber, readString, walkFields } from '@engine/util/pdf'
import { FONTS, type FieldKind } from './model'

// Field flags (ISO 32000-1, tables 221, 226, 228, 230)
export const FF_READ_ONLY = 1
export const FF_REQUIRED = 1 << 1
export const FF_NO_EXPORT = 1 << 2
export const FF_MULTILINE = 1 << 12
export const FF_PASSWORD = 1 << 13
export const FF_NO_TOGGLE_TO_OFF = 1 << 14
export const FF_RADIO = 1 << 15
export const FF_PUSHBUTTON = 1 << 16
export const FF_COMBO = 1 << 17
export const FF_EDIT = 1 << 18
export const FF_SORT = 1 << 19
export const FF_MULTI_SELECT = 1 << 21
export const FF_DO_NOT_SPELL_CHECK = 1 << 22
export const FF_DO_NOT_SCROLL = 1 << 23
export const FF_COMB = 1 << 24
export const FF_RADIOS_IN_UNISON = 1 << 25
export const FF_COMMIT_ON_SEL_CHANGE = 1 << 26

// Annotation flags
export const F_INVISIBLE = 1
export const F_HIDDEN = 2
export const F_PRINT = 4
export const F_NO_VIEW = 32

/** Keys that belong to the field (moved to the parent when a field gets several widgets). */
export const FIELD_KEYS = ['FT', 'Ff', 'V', 'DV', 'TU', 'TM', 'MaxLen', 'Opt', 'TI', 'I', 'RV', 'DS', 'Lock', 'SV']
/** Trigger events of /AA that belong to the field rather than to the widget annotation. */
export const FIELD_AA_KEYS = ['K', 'F', 'V', 'C']

export function num(obj: PDFObject): number {
  return obj.asIndirect()
}

export function sameObj(a: PDFObject, b: PDFObject): boolean {
  if (a.isIndirect() && b.isIndirect()) return a.asIndirect() === b.asIndirect()
  return false
}

export function newArray(doc: PDFDocument, values: unknown[]): PDFObject {
  const a = doc.newArray()
  for (const v of values) a.push(v)
  return a
}

export function readNumberArray(obj: PDFObject): number[] | null {
  if (isNull(obj)) return null
  const a = obj.resolve()
  if (!a.isArray()) return null
  const out: number[] = []
  for (let i = 0; i < a.length; i++) out.push(readNumber(a.get(i), 0))
  return out
}

/** Removes the entry referring to `target` from an array. Returns true when found. */
export function removeRef(arr: PDFObject, target: PDFObject): boolean {
  if (isNull(arr) || !arr.isArray()) return false
  const n = num(target)
  for (let i = arr.length - 1; i >= 0; i--) {
    const it = arr.get(i)
    if (it.isIndirect() && it.asIndirect() === n) {
      arr.delete(i)
      return true
    }
  }
  return false
}

export function indexOfRef(arr: PDFObject, target: PDFObject | number): number {
  if (isNull(arr) || !arr.isArray()) return -1
  const n = typeof target === 'number' ? target : num(target)
  for (let i = 0; i < arr.length; i++) {
    const it = arr.get(i)
    if (it.isIndirect() && it.asIndirect() === n) return i
  }
  return -1
}

// ---- AcroForm --------------------------------------------------------------------------

export function acroForm(s: Session): PDFObject | null {
  const a = catalog(s.pdf).get('AcroForm')
  return isNull(a) ? null : a
}

/** Creates /AcroForm (with /Fields, /DA and /DR fonts) when missing and makes sure it is usable. */
export function ensureAcroForm(s: Session): PDFObject {
  const doc = s.pdf
  const root = catalog(doc)
  let acro = root.get('AcroForm')
  if (isNull(acro) || !acro.resolve().isDictionary()) {
    const d = doc.newDictionary()
    d.put('Fields', doc.newArray())
    d.put('DA', doc.newString('/Helv 0 Tf 0 g'))
    d.put('NeedAppearances', false)
    root.put('AcroForm', doc.addObject(d))
    acro = root.get('AcroForm')
  }
  if (isNull(acro.get('Fields')) || !acro.get('Fields').isArray()) acro.put('Fields', doc.newArray())
  if (isNull(acro.get('DA'))) acro.put('DA', doc.newString('/Helv 0 Tf 0 g'))
  ensureFont(s, 'Helv')
  ensureFont(s, 'ZaDb')
  return acro
}

/** Makes sure /AcroForm /DR /Font has a base-14 font under one of the standard Acrobat names. */
export function ensureFont(s: Session, id: string): PDFObject | null {
  const doc = s.pdf
  const acro = catalog(doc).get('AcroForm')
  if (isNull(acro)) return null
  let dr = acro.get('DR')
  if (isNull(dr)) {
    acro.put('DR', doc.newDictionary())
    dr = acro.get('DR')
  }
  let fonts = dr.get('Font')
  if (isNull(fonts)) {
    dr.put('Font', doc.newDictionary())
    fonts = dr.get('Font')
  }
  const existing = fonts.get(id)
  if (!isNull(existing)) return existing
  const def = FONTS.find((f) => f.id === id)
  if (!def) return null
  const f = doc.newDictionary()
  f.put('Type', doc.newName('Font'))
  f.put('Subtype', doc.newName('Type1'))
  f.put('BaseFont', doc.newName(def.base))
  if (id !== 'ZaDb') f.put('Encoding', doc.newName('WinAnsiEncoding'))
  const ref = doc.addObject(f)
  fonts.put(id, ref)
  return ref
}

// ---- locating widgets ---------------------------------------------------------------------

export interface WidgetRef {
  obj: PDFObject
  pageIndex: number
}

function isWidgetDict(o: PDFObject): boolean {
  try {
    const r = o.resolve()
    return r.isDictionary() && readName(r.get('Subtype')) === 'Widget'
  } catch {
    return false
  }
}

/** Widget dictionaries on a page, in /Annots order. */
export function pageWidgets(s: Session, pageIndex: number): PDFObject[] {
  const annots = s.pdf.findPage(pageIndex).get('Annots')
  const out: PDFObject[] = []
  if (isNull(annots) || !annots.isArray()) return out
  for (let i = 0; i < annots.length; i++) {
    const a = annots.get(i)
    if (a.isIndirect() && isWidgetDict(a)) out.push(a)
  }
  return out
}

/** Finds a widget by its object number. */
export function locateWidget(s: Session, id: number, hintPage?: number): WidgetRef {
  const n = s.pageCount()
  const order: number[] = []
  if (hintPage !== undefined && hintPage >= 0 && hintPage < n) order.push(hintPage)
  for (let i = 0; i < n; i++) if (i !== hintPage) order.push(i)
  for (const p of order) {
    const annots = s.pdf.findPage(p).get('Annots')
    const k = indexOfRef(annots, id)
    if (k >= 0) {
      const obj = annots.get(k)
      if (!isWidgetDict(obj)) throw new EngineError(`Annotation ${id} is not a form field`, 'NOT_A_FIELD')
      return { obj, pageIndex: p }
    }
  }
  throw new EngineError(`Form field ${id} was not found`, 'NO_FIELD')
}

/** Page index of a widget dictionary (via /P, verified, else by scanning /Annots). */
export function pageOfWidget(s: Session, w: PDFObject): number {
  const id = num(w)
  const p = w.get('P')
  if (!isNull(p) && p.isIndirect()) {
    const idx = s.pageIndexById(p.asIndirect())
    if (idx >= 0 && indexOfRef(s.pdf.findPage(idx).get('Annots'), id) >= 0) return idx
  }
  const n = s.pageCount()
  for (let i = 0; i < n; i++) if (indexOfRef(s.pdf.findPage(i).get('Annots'), id) >= 0) return i
  return -1
}

/** The loaded MuPDF widget for a widget dictionary (reloads the page when it is not there yet). */
export function loadWidget(s: Session, pageIndex: number, id: number) {
  let w = s
    .page(pageIndex)
    .getWidgets()
    .find((x) => x.getObject().asIndirect() === id)
  if (!w) {
    s.invalidatePages()
    w = s
      .page(pageIndex)
      .getWidgets()
      .find((x) => x.getObject().asIndirect() === id)
  }
  if (!w) throw new EngineError(`Form field ${id} could not be loaded`, 'NO_FIELD')
  return w
}

// ---- field structure ----------------------------------------------------------------------

/** The terminal field dictionary a widget belongs to. */
export function fieldOf(w: PDFObject): PDFObject {
  if (!isNull(w.get('T'))) return w
  const p = w.get('Parent')
  if (!isNull(p) && p.isIndirect()) return p
  return w
}

export function isMerged(field: PDFObject): boolean {
  return isWidgetDict(field)
}

/** Widgets of a terminal field. */
export function widgetsOf(field: PDFObject): PDFObject[] {
  if (isMerged(field)) return [field]
  const kids = field.get('Kids')
  const out: PDFObject[] = []
  if (isNull(kids) || !kids.isArray()) return out
  for (let i = 0; i < kids.length; i++) {
    const k = kids.get(i)
    if (k.isIndirect() && isWidgetDict(k) && isNull(k.get('T'))) out.push(k)
  }
  return out
}

export function partialName(field: PDFObject): string {
  return readString(field.get('T'))
}

export function fullName(field: PDFObject): string {
  const parts: string[] = []
  let cur: PDFObject = field
  for (let d = 0; d < 64 && !isNull(cur); d++) {
    const t = readString(cur.get('T'))
    if (t) parts.unshift(t)
    cur = cur.get('Parent')
  }
  return parts.join('.')
}

/** The array that holds this field (its parent's /Kids or /AcroForm /Fields). */
export function containerOf(s: Session, field: PDFObject): PDFObject {
  const p = field.get('Parent')
  if (!isNull(p)) {
    let kids = p.get('Kids')
    if (isNull(kids)) {
      p.put('Kids', s.pdf.newArray())
      kids = p.get('Kids')
    }
    return kids
  }
  return ensureAcroForm(s).get('Fields')
}

/** Every terminal field by fully qualified name. */
export function fieldsByName(s: Session): Map<string, PDFObject> {
  const out = new Map<string, PDFObject>()
  walkFields(s.pdf, (field, name) => {
    if (name && !out.has(name)) out.set(name, field)
  })
  return out
}

export function kindOf(w: PDFObject): FieldKind {
  const ft = readName(w.getInheritable('FT'))
  const ff = readNumber(w.getInheritable('Ff'), 0)
  switch (ft) {
    case 'Tx': {
      const f = fieldScripts(fieldOf(w)).format ?? ''
      return /^\s*AFDate_Format/.test(f) ? 'date' : 'text'
    }
    case 'Btn':
      if (ff & FF_PUSHBUTTON) return 'button'
      if (ff & FF_RADIO) return 'radio'
      return 'checkbox'
    case 'Ch':
      return ff & FF_COMBO ? 'combo' : 'list'
    case 'Sig':
      return 'signature'
    default:
      return 'unknown'
  }
}

/** The JavaScript of a field's trigger events (K, F, V, C). */
export function fieldScripts(field: PDFObject): { keystroke?: string; format?: string; validate?: string; calculate?: string } {
  const aa = field.get('AA')
  if (isNull(aa)) return {}
  const js = (key: string): string | undefined => {
    const a = aa.get(key)
    if (isNull(a)) return undefined
    if (readName(a.get('S')) !== 'JavaScript') return undefined
    const j = a.get('JS').resolve()
    if (j.isStream()) return j.readStream().asString()
    return readString(j) || undefined
  }
  return { keystroke: js('K'), format: js('F'), validate: js('V'), calculate: js('C') }
}

/** Sets (or removes, for empty strings) a JavaScript trigger on a field. */
export function setFieldScript(s: Session, field: PDFObject, key: 'K' | 'F' | 'V' | 'C', script: string) {
  const doc = s.pdf
  let aa = field.get('AA')
  if (!script.trim()) {
    if (!isNull(aa)) {
      aa.delete(key)
      let empty = true
      aa.forEach(() => (empty = false))
      if (empty) field.delete('AA')
    }
    return
  }
  if (isNull(aa)) {
    field.put('AA', doc.newDictionary())
    aa = field.get('AA')
  }
  const action = doc.newDictionary()
  action.put('S', doc.newName('JavaScript'))
  action.put('JS', doc.newString(script))
  aa.put(key, action)
}

/** Adds or removes a field from the /CO calculation order. */
export function setInCalculationOrder(s: Session, field: PDFObject, include: boolean) {
  const acro = ensureAcroForm(s)
  let co = acro.get('CO')
  if (include) {
    if (isNull(co)) {
      acro.put('CO', s.pdf.newArray())
      co = acro.get('CO')
    }
    if (indexOfRef(co, field) < 0) co.push(field)
  } else if (!isNull(co)) {
    removeRef(co, field)
    if (co.length === 0) acro.delete('CO')
  }
}

function replaceInCalculationOrder(s: Session, from: PDFObject, to: PDFObject) {
  const acro = acroForm(s)
  if (!acro) return
  const co = acro.get('CO')
  const i = indexOfRef(co, from)
  if (i >= 0) co.put(i, to)
}

/** Splits a merged field/widget dictionary into a parent field and one widget kid. */
export function splitMerged(s: Session, w: PDFObject): PDFObject {
  const doc = s.pdf
  const container = containerOf(s, w)
  const parent = doc.addObject(doc.newDictionary())
  parent.put('T', w.get('T'))
  w.delete('T')
  for (const key of FIELD_KEYS) {
    const v = w.get(key)
    if (!isNull(v)) {
      parent.put(key, v)
      w.delete(key)
    }
  }
  const aa = w.get('AA')
  if (!isNull(aa)) {
    const fieldAA = doc.newDictionary()
    let moved = 0
    for (const key of FIELD_AA_KEYS) {
      const v = aa.get(key)
      if (!isNull(v)) {
        fieldAA.put(key, v)
        aa.delete(key)
        moved++
      }
    }
    if (moved) parent.put('AA', fieldAA)
    let empty = true
    aa.forEach(() => (empty = false))
    if (empty) w.delete('AA')
  }
  const grand = w.get('Parent')
  if (!isNull(grand)) parent.put('Parent', grand)
  const i = indexOfRef(container, w)
  if (i >= 0) container.put(i, parent)
  else container.push(parent)
  parent.put('Kids', newArray(doc, [w]))
  w.put('Parent', parent)
  replaceInCalculationOrder(s, w, parent)
  return parent
}

/** Removes empty intermediate (non-terminal) fields up the hierarchy. */
function pruneEmpty(s: Session, node: PDFObject) {
  let cur: PDFObject = node
  for (let d = 0; d < 64 && !isNull(cur); d++) {
    const kids = cur.get('Kids')
    if (!isNull(kids) && kids.isArray() && kids.length > 0) return
    const parent = cur.get('Parent')
    const container = isNull(parent) ? ensureAcroForm(s).get('Fields') : parent.get('Kids')
    removeRef(container, cur)
    setInCalculationOrder(s, cur, false)
    cur = parent
  }
}

/** Takes a field (with all its widgets) out of the field tree. */
export function detachField(s: Session, field: PDFObject) {
  const parent = field.get('Parent')
  const container = isNull(parent) ? ensureAcroForm(s).get('Fields') : parent.get('Kids')
  removeRef(container, field)
  field.delete('Parent')
  if (!isNull(parent)) pruneEmpty(s, parent)
}

/** Takes one widget out of its field (deleting the field when it was the last widget). */
export function detachWidget(s: Session, w: PDFObject) {
  const field = fieldOf(w)
  if (sameObj(field, w)) {
    setInCalculationOrder(s, w, false)
    detachField(s, w)
    return
  }
  removeRef(field.get('Kids'), w)
  w.delete('Parent')
  const kids = field.get('Kids')
  if (isNull(kids) || kids.length === 0) {
    setInCalculationOrder(s, field, false)
    detachField(s, field)
  }
}

/** Moves a widget into another (terminal) field so they share name and value. */
export function joinWidgetToField(s: Session, w: PDFObject, target: PDFObject): PDFObject {
  let field = target
  if (isMerged(field)) field = splitMerged(s, field)
  if (sameObj(fieldOf(w), field)) return field
  detachWidget(s, w)
  w.delete('T')
  for (const key of FIELD_KEYS) w.delete(key)
  const aa = w.get('AA')
  if (!isNull(aa)) {
    for (const key of FIELD_AA_KEYS) aa.delete(key)
  }
  w.put('Parent', field)
  let kids = field.get('Kids')
  if (isNull(kids)) {
    field.put('Kids', s.pdf.newArray())
    kids = field.get('Kids')
  }
  kids.push(w)
  return field
}

export function validateFieldName(name: string): string | null {
  if (!name.trim()) return 'Enter a field name'
  if (name !== name.trim()) return 'Field names cannot start or end with spaces'
  if (/^\.|\.$|\.\./.test(name)) return 'Field names cannot start or end with a period, or contain two periods in a row'
  return null
}

/**
 * Places a terminal field at a fully qualified name, creating parent fields for dotted names
 * ("address.city" -> field "city" under "address").
 */
export function placeFieldAtName(s: Session, field: PDFObject, name: string) {
  const err = validateFieldName(name)
  if (err) throw new EngineError(err, 'BAD_NAME')
  const doc = s.pdf
  const parts = name.split('.')
  const leaf = parts.pop()!
  // find or create the intermediate fields
  let container = ensureAcroForm(s).get('Fields')
  let parent: PDFObject | null = null
  const path: PDFObject[] = []
  for (const part of parts) {
    let found: PDFObject | null = null
    for (let i = 0; i < container.length; i++) {
      const k = container.get(i)
      if (!k.isIndirect() || sameObj(k, field)) continue
      if (readString(k.get('T')) !== part) continue
      const kids = k.get('Kids')
      const terminal = isWidgetDict(k) || isNull(kids) || widgetsOf(k).length > 0
      if (terminal) throw new EngineError(`“${[...path.map(partialName), part].join('.')}” is already a field, so it cannot hold other fields`, 'NAME_EXISTS')
      found = k
      break
    }
    if (!found) {
      const d = doc.newDictionary()
      d.put('T', doc.newString(part))
      d.put('Kids', doc.newArray())
      if (parent) d.put('Parent', parent)
      found = doc.addObject(d)
      container.push(found)
    }
    path.push(found)
    parent = found
    container = found.get('Kids')
  }
  field.put('T', doc.newString(leaf))
  if (indexOfRef(container, field) >= 0) return // already in place: only the partial name changed
  const oldParent = field.get('Parent')
  const oldContainer = isNull(oldParent) ? ensureAcroForm(s).get('Fields') : oldParent.get('Kids')
  if (indexOfRef(oldContainer, field) >= 0) detachField(s, field)
  else field.delete('Parent')
  if (parent) field.put('Parent', parent)
  container.push(field)
}

// ---- geometry -------------------------------------------------------------------------------

/** Writes a page-space rectangle into /Rect (PDF user space). */
export function putRect(s: Session, pageIndex: number, w: PDFObject, rect: Rect) {
  const r = normalizeRect(transformRect(normalizeRect(rect), s.pageToUser(pageIndex)))
  w.put('Rect', newArray(s.pdf, r.map((v) => Math.round(v * 1000) / 1000)))
}

/** Page-space rectangle of a widget. */
export function getRect(s: Session, pageIndex: number, w: PDFObject): Rect {
  const a = readNumberArray(w.get('Rect')) ?? [0, 0, 0, 0]
  return normalizeRect(transformRect(normalizeRect(a as Rect), s.userToPage(pageIndex)))
}

// ---- default appearance -------------------------------------------------------------------

export interface DA {
  font: string
  size: number
  color: string
}

export function parseDA(da: string): DA {
  const out: DA = { font: 'Helv', size: 0, color: '#000000' }
  const tf = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da)
  if (tf) {
    out.font = tf[1]
    out.size = parseFloat(tf[2])
  }
  const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg\b/.exec(da)
  const k = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+k\b/.exec(da)
  const g = /([\d.]+)\s+g\b/.exec(da)
  if (rg) out.color = rgbToHex([parseFloat(rg[1]), parseFloat(rg[2]), parseFloat(rg[3])])
  else if (k) out.color = rgbToHex([parseFloat(k[1]), parseFloat(k[2]), parseFloat(k[3]), parseFloat(k[4])])
  else if (g) out.color = rgbToHex([parseFloat(g[1])])
  return out
}

const fmt = (v: number) => {
  const s = v.toFixed(3)
  return s.replace(/\.?0+$/, '') || '0'
}

export function colorOps(hex: string, stroke = false): string {
  const [r, g, b] = hexToRgb(hex)
  if (r === g && g === b) return `${fmt(r)} ${stroke ? 'G' : 'g'}`
  return `${fmt(r)} ${fmt(g)} ${fmt(b)} ${stroke ? 'RG' : 'rg'}`
}

export function formatDA(da: DA): string {
  return `/${da.font} ${fmt(da.size)} Tf ${colorOps(da.color)}`
}

export function readDA(s: Session, w: PDFObject): DA {
  let da = readString(w.getInheritable('DA'))
  if (!da) da = readString(catalog(s.pdf).get('AcroForm', 'DA'))
  return parseDA(da || '/Helv 0 Tf 0 g')
}

/** Reads an /MK colour array as #rrggbb, or null when absent/empty. */
export function mkColor(w: PDFObject, key: 'BC' | 'BG'): string | null {
  const vals = readNumberArray(w.get('MK', key))
  if (!vals || vals.length === 0) return null
  return rgbToHex(vals)
}

export function colorArray(s: Session, hex: string | null): PDFObject {
  if (!hex) return s.pdf.newArray()
  return newArray(s.pdf, hexToRgb(hex).map((v) => Math.round(v * 1000) / 1000))
}

export function ensureMK(s: Session, w: PDFObject): PDFObject {
  let mk = w.get('MK')
  if (isNull(mk)) {
    w.put('MK', s.pdf.newDictionary())
    mk = w.get('MK')
  }
  return mk
}

/** On-state name of a check box or radio widget (the non-Off key of /AP /N). */
export function onStateName(w: PDFObject): string | null {
  const n = w.get('AP', 'N')
  let on: string | null = null
  if (!isNull(n) && n.isDictionary() && !n.isStream()) {
    n.forEach((_v, k) => {
      if (String(k) !== 'Off' && on === null) on = String(k)
    })
  }
  if (on === null) {
    const d = w.get('AP', 'D')
    if (!isNull(d) && d.isDictionary() && !d.isStream()) {
      d.forEach((_v, k) => {
        if (String(k) !== 'Off' && on === null) on = String(k)
      })
    }
  }
  if (on === null) {
    const as = readName(w.get('AS'))
    if (as && as !== 'Off') on = as
  }
  return on
}
