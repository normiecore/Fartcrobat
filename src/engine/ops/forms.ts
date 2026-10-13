import type { Rect } from '@shared/geometry'
import { rgbToHex } from '@shared/geometry'
import { defineOps, EngineError, mutation } from '../define'
import type { PDFObject, PDFWidget, Session } from '../session'
import { isNull, readName, readNumber, readString, walkFields } from '../util/pdf'

export type FieldType = 'text' | 'checkbox' | 'radio' | 'combo' | 'list' | 'button' | 'signature' | 'unknown'

export interface FieldInfo {
  /** Widget annotation id (object number). One field can have several widgets. */
  id: number
  page: number
  /** Fully qualified field name, e.g. "address.city". */
  name: string
  type: FieldType
  rect: Rect
  value: string
  /** Checkbox/radio: whether this widget is on. */
  checked: boolean
  /** Checkbox/radio: the "on" state name of this widget (export value). */
  onState: string | null
  /** Choice fields: display labels and export values. */
  options: { label: string; value: string }[]
  tooltip: string
  readOnly: boolean
  required: boolean
  noExport: boolean
  multiline: boolean
  password: boolean
  comb: boolean
  maxLen: number
  multiSelect: boolean
  editable: boolean
  doNotSpellCheck: boolean
  /** 0 left, 1 centre, 2 right */
  alignment: number
  fontName: string
  fontSize: number
  textColor: string
  borderColor: string | null
  backgroundColor: string | null
  /** JavaScript actions: K keystroke, F format, V validate, C calculate. */
  scripts: { format?: string; keystroke?: string; validate?: string; calculate?: string; action?: string }
  hidden: boolean
  /** Signature fields: whether the field is already signed. */
  signed: boolean
}

const TYPE_MAP: Record<string, FieldType> = {
  text: 'text',
  checkbox: 'checkbox',
  radiobutton: 'radio',
  combobox: 'combo',
  listbox: 'list',
  button: 'button',
  signature: 'signature'
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

function jsOf(action: PDFObject | null): string | undefined {
  if (!action || isNull(action)) return undefined
  const a = action.resolve()
  if (readName(a.get('S')) !== 'JavaScript') return undefined
  const js = a.get('JS').resolve()
  if (js.isStream()) return js.readStream().asString()
  return readString(js) || undefined
}

function parseDA(da: string): { font: string; size: number; color: string } {
  const out = { font: 'Helv', size: 0, color: '#000000' }
  const tf = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da)
  if (tf) {
    out.font = tf[1]
    out.size = parseFloat(tf[2])
  }
  const g = /([\d.]+)\s+g\b/.exec(da)
  const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg\b/.exec(da)
  if (rg) out.color = rgbToHex([parseFloat(rg[1]), parseFloat(rg[2]), parseFloat(rg[3])])
  else if (g) out.color = rgbToHex([parseFloat(g[1])])
  return out
}

function mkColor(mk: PDFObject, key: string): string | null {
  if (isNull(mk)) return null
  const arr = mk.get(key)
  if (isNull(arr) || !arr.isArray() || arr.length === 0) return null
  const vals: number[] = []
  for (let i = 0; i < arr.length; i++) vals.push(arr.get(i).asNumber())
  return rgbToHex(vals)
}

export function onStateOf(widget: PDFWidget): string | null {
  try {
    const n = widget.getObject().get('AP').get('N')
    if (isNull(n) || !n.isDictionary()) return null
    let on: string | null = null
    n.forEach((_v, k) => {
      if (String(k) !== 'Off') on = String(k)
    })
    return on
  } catch {
    return null
  }
}

export function fieldInfo(s: Session, w: PDFWidget, pageIndex: number, position: number): FieldInfo {
  const obj = w.getObject()
  const rawType = safe(() => w.getFieldType(), 'widget')
  const type = TYPE_MAP[rawType] ?? 'unknown'
  const flags = safe(() => w.getFieldFlags(), 0)
  const da = parseDA(readString(obj.getInheritable('DA')) || readString(s.pdf.getTrailer().get('Root', 'AcroForm', 'DA')))
  const mk = obj.get('MK')
  const aa = obj.getInheritable('AA')
  const value = safe(() => w.getValue(), '')
  const onState = type === 'checkbox' || type === 'radio' ? onStateOf(w) : null
  const appearanceState = readName(obj.get('AS'))
  let options: { label: string; value: string }[] = []
  if (type === 'combo' || type === 'list') {
    const labels = safe(() => w.getOptions(false), [] as string[])
    const values = safe(() => w.getOptions(true), [] as string[])
    options = labels.map((label, i) => ({ label, value: values[i] ?? label }))
  }
  const annotFlags = safe(() => w.getFlags(), 0)
  return {
    id: s.annotationId(w, pageIndex, position + 50000),
    page: pageIndex,
    name: safe(() => w.getName(), ''),
    type,
    rect: safe(() => w.getRect() as Rect, [0, 0, 0, 0]),
    value,
    checked:
      onState !== null
        ? appearanceState === onState || value === onState
        : // a checkbox without appearance states: on whenever its value is not Off
          type === 'checkbox' && value !== '' && value !== 'Off',
    onState,
    options,
    tooltip: readString(obj.getInheritable('TU')),
    readOnly: (flags & 1) !== 0,
    required: (flags & 2) !== 0,
    noExport: (flags & 4) !== 0,
    multiline: type === 'text' && (flags & (1 << 12)) !== 0,
    password: type === 'text' && (flags & (1 << 13)) !== 0,
    comb: type === 'text' && (flags & (1 << 24)) !== 0,
    maxLen: type === 'text' ? safe(() => w.getMaxLen(), 0) : 0,
    multiSelect: type === 'list' && (flags & (1 << 21)) !== 0,
    editable: type === 'combo' && (flags & (1 << 18)) !== 0,
    doNotSpellCheck: (flags & (1 << 22)) !== 0,
    alignment: Math.round(readNumber(obj.getInheritable('Q'), 0)),
    fontName: da.font,
    fontSize: da.size,
    textColor: da.color,
    borderColor: mkColor(mk, 'BC'),
    backgroundColor: mkColor(mk, 'BG'),
    scripts: isNull(aa)
      ? { action: jsOf(obj.get('A')) }
      : {
          keystroke: jsOf(aa.get('K')),
          format: jsOf(aa.get('F')),
          validate: jsOf(aa.get('V')),
          calculate: jsOf(aa.get('C')),
          action: jsOf(obj.get('A'))
        },
    hidden: (annotFlags & 2) !== 0,
    signed: type === 'signature' && !isNull(obj.getInheritable('V'))
  }
}

function listPage(s: Session, pageIndex: number): FieldInfo[] {
  return s
    .page(pageIndex)
    .getWidgets()
    .map((w, k) => fieldInfo(s, w, pageIndex, k))
}

function requireWidget(s: Session, id: number, hintPage?: number) {
  const found = s.requireAnnotation(id, hintPage)
  if (found.annot.getType() !== 'Widget') throw new EngineError(`Annotation ${id} is not a form field`, 'NOT_A_FIELD')
  return { ...found, widget: found.annot as PDFWidget }
}

/** Every widget of the field with this name, across pages. */
function widgetsNamed(s: Session, name: string): { pageIndex: number; widget: PDFWidget }[] {
  const out: { pageIndex: number; widget: PDFWidget }[] = []
  const n = s.pageCount()
  for (let p = 0; p < n; p++) {
    for (const w of s.page(p).getWidgets()) if (safe(() => w.getName(), '') === name) out.push({ pageIndex: p, widget: w })
  }
  return out
}

export interface SetValueOptions {
  /** Text shown in the field when different from the stored value (number/date formatting). */
  display?: string
}

type PlacedWidget = { pageIndex: number; widget: PDFWidget }

/** The field dictionary that holds a widget's value: the nearest node (itself included) with a /T. */
function fieldHead(widgetObj: PDFObject): PDFObject {
  let f = widgetObj
  for (let depth = 0; depth < 32 && isNull(f.get('T')) && !isNull(f.get('Parent')); depth++) f = f.get('Parent')
  return f
}

function objNum(obj: PDFObject): number {
  try {
    return obj.asIndirect()
  } catch {
    return 0
  }
}

function annotsContain(page: PDFObject, num: number): boolean {
  const annots = page.get('Annots')
  if (isNull(annots)) return false
  const a = annots.resolve()
  for (let i = 0; i < a.length; i++) if (objNum(a.get(i)) === num) return true
  return false
}

/**
 * Every widget of the field `widget` belongs to, with its page. Only the pages holding those
 * widgets are loaded (found through /P, or a scan of the pages' /Annots arrays).
 */
function fieldWidgets(s: Session, widget: PDFWidget, pageIndex: number): PlacedWidget[] {
  const obj = widget.getObject()
  const self = objNum(obj)
  const head = fieldHead(obj)
  const nums = new Set<number>()
  if (self) nums.add(self)
  const kids = head.get('Kids')
  if (!isNull(kids) && kids.resolve().isArray()) {
    kids.resolve().forEach((k) => {
      if (k.isIndirect() && isNull(k.resolve().get('T'))) nums.add(k.asIndirect())
    })
  }
  const byPage = new Map<number, Set<number>>()
  const count = s.pageCount()
  for (const n of nums) {
    let index = n === self ? pageIndex : -1
    if (index < 0) {
      const p = s.pdf.newIndirect(n).resolve().get('P')
      if (!isNull(p) && p.isIndirect()) index = s.pageIndexById(p.asIndirect())
      if (index >= 0 && !annotsContain(s.pdf.findPage(index), n)) index = -1
    }
    for (let i = 0; index < 0 && i < count; i++) if (annotsContain(s.pdf.findPage(i), n)) index = i
    if (index < 0) continue
    if (!byPage.has(index)) byPage.set(index, new Set())
    byPage.get(index)!.add(n)
  }
  const out: PlacedWidget[] = []
  for (const [p, wanted] of byPage) {
    for (const w of s.page(p).getWidgets()) if (wanted.has(objNum(w.getObject()))) out.push({ pageIndex: p, widget: w })
  }
  if (!out.some((g) => g.widget === widget || objNum(g.widget.getObject()) === self)) out.push({ pageIndex, widget })
  return out
}

/**
 * Checkbox and radio values. `value` is an on-state name ("Yes", "pro"...), "Off"/"" to clear,
 * or a boolean for `widget` itself. Only the widget whose on-state matches is turned on: a
 * checkbox field whose widgets export different values ("Yes" and "No") behaves like a radio
 * group. A text value that matches no widget of a checkbox means "checked" (single-state
 * checkboxes filled from data that says "On" or "true"). Values are written directly, so radio
 * groups with NoToggleToOff can be cleared too (MuPDF's toggle refuses to).
 */
function setButtonValue(s: Session, type: FieldType, widget: PDFWidget, group: PlacedWidget[], value: string | boolean) {
  // Like MuPDF, a button without appearance states is on in state "Yes".
  const states = group.map((g) => ({ ...g, on: onStateOf(g.widget) ?? 'Yes' }))
  const own = onStateOf(widget) ?? 'Yes'
  let target: string | null
  if (typeof value === 'boolean') {
    if (!value && readName(widget.getObject().get('AS')) !== own) return // already off
    target = value ? own : null
  } else if (value === '' || value === 'Off') target = null
  else if (states.some((g) => g.on === value)) target = value
  else if (type === 'checkbox') target = own
  else return // a radio value that matches no button
  fieldHead(widget.getObject()).put('V', s.pdf.newName(target ?? 'Off'))
  for (const g of states) {
    g.widget.getObject().put('AS', s.pdf.newName(target !== null && g.on === target ? target : 'Off'))
  }
}

/**
 * Text values. With `display`, /V keeps the raw value while every widget shows the formatted
 * text (as Acrobat does for number and date formats).
 */
function setTextValue(s: Session, widget: PDFWidget, value: string, display?: string) {
  if (display === undefined || display === value) {
    widget.setTextValue(value)
    widget.update()
    return
  }
  // MuPDF draws appearances from /V when a widget is updated: draw them now with the display
  // text (the field's pages are loaded, so this reaches every widget), then store the raw value.
  // Writing /V directly does not ask for new appearances, so the formatted text stays.
  widget.setTextValue(display)
  widget.update()
  fieldHead(widget.getObject()).put('V', s.pdf.newString(value))
}

function setWidgetValue(s: Session, widget: PDFWidget, pageIndex: number, value: string | boolean, opts: SetValueOptions = {}) {
  const type = TYPE_MAP[safe(() => widget.getFieldType(), 'widget')] ?? 'unknown'
  // Loads the pages of every widget of the field, so all of them get new appearances.
  const group = fieldWidgets(s, widget, pageIndex)
  if (type === 'checkbox' || type === 'radio') {
    setButtonValue(s, type, widget, group, value)
  } else if (type === 'text') {
    setTextValue(s, widget, String(value), opts.display)
  } else if (type === 'combo' || type === 'list') {
    widget.setChoiceValue(String(value))
    widget.update()
  } else {
    throw new EngineError(`Cannot set the value of a ${type} field`, 'BAD_FIELD')
  }
  for (const g of group) s.touch(g.pageIndex)
}

/** Field names locked by signatures (FieldMDP /Lock, or a DocMDP signature allowing no changes). */
function signatureLocks(s: Session): (name: string) => boolean {
  let all = false
  const include: string[] = []
  const exclude: string[][] = []
  const names = (arr: PDFObject): string[] => {
    const out: string[] = []
    if (!isNull(arr) && arr.resolve().isArray()) arr.resolve().forEach((n) => out.push(readString(n)))
    return out
  }
  const addLock = (lock: PDFObject) => {
    if (isNull(lock)) return
    const action = readName(lock.get('Action'))
    if (action === 'All') all = true
    else if (action === 'Include') include.push(...names(lock.get('Fields')))
    else if (action === 'Exclude') exclude.push(names(lock.get('Fields')))
  }
  walkFields(s.pdf, (field, _name, ft) => {
    if (ft !== 'Sig') return
    const f = field.resolve()
    const v = f.get('V')
    if (isNull(v)) return
    addLock(f.get('Lock'))
    const refs = v.resolve().get('Reference')
    if (isNull(refs) || !refs.resolve().isArray()) return
    refs.resolve().forEach((r) => {
      const method = readName(r.resolve().get('TransformMethod'))
      const params = r.resolve().get('TransformParams')
      if (method === 'FieldMDP') addLock(params)
      else if (method === 'DocMDP' && readNumber(params.get('P'), 2) === 1) all = true
    })
  })
  const covers = (list: string[], name: string) => list.some((n) => name === n || name.startsWith(n + '.'))
  return (name) => all || covers(include, name) || exclude.some((ex) => !covers(ex, name))
}

export default defineOps('forms', {
  list(s, pageIndex: number): FieldInfo[] {
    return listPage(s, pageIndex)
  },

  listAll(s): FieldInfo[] {
    const out: FieldInfo[] = []
    const n = s.pageCount()
    for (let i = 0; i < n; i++) out.push(...listPage(s, i))
    return out
  },

  /** Field names in calculation order (/CO), for calculated fields. */
  calculationOrder(s): string[] {
    const co = s.pdf.getTrailer().get('Root', 'AcroForm', 'CO')
    const out: string[] = []
    if (isNull(co) || !co.isArray()) return out
    for (let i = 0; i < co.length; i++) {
      const f = co.get(i).resolve()
      const names: string[] = []
      let cur: PDFObject = f
      for (let d = 0; d < 32 && !isNull(cur); d++) {
        const t = readString(cur.get('T'))
        if (t) names.unshift(t)
        cur = cur.get('Parent')
      }
      if (names.length) out.push(names.join('.'))
    }
    return out
  },

  setValue: mutation('Fill Form Field', (s, id: number, value: string | boolean, opts: SetValueOptions = {}) => {
    const { widget, pageIndex } = requireWidget(s, id)
    setWidgetValue(s, widget, pageIndex, value, opts)
    s.documentChanged()
  }),

  /** Sets several fields by name in one undo step (import form data, calculations). */
  setValues: mutation('Fill Form', (s, values: { name: string; value: string | boolean; display?: string }[]) => {
    for (const v of values) {
      const ws = widgetsNamed(s, v.name)
      if (!ws.length) continue
      // One call per field: it updates every widget of the field.
      setWidgetValue(s, ws[0].widget, ws[0].pageIndex, v.value, { display: v.display })
    }
    s.documentChanged()
  }),

  /**
   * Clears the form (all fields, or only the named ones). Signature fields and fields locked by
   * a signature are left alone: clearing a signature field would delete the signature.
   */
  reset: mutation('Clear Form', (s, names?: string[]) => {
    const doc = s.pdf
    const locked = signatureLocks(s)
    const arr = doc.newArray()
    walkFields(doc, (field, name, ft) => {
      if (ft === 'Sig' || locked(name)) return
      if (names && names.length && !names.includes(name)) return
      arr.push(field)
    })
    if (arr.length) doc.resetForm(arr, false)
    const n = s.pageCount()
    for (let p = 0; p < n; p++) {
      for (const w of s.page(p).getWidgets()) {
        try {
          w.update()
        } catch {}
      }
    }
    s.touchAll()
    s.documentChanged()
  })
})
