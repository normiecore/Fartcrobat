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
    checked: onState !== null ? appearanceState === onState || value === onState : false,
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

function setWidgetValue(s: Session, widget: PDFWidget, pageIndex: number, value: string | boolean, opts: SetValueOptions = {}) {
  const type = TYPE_MAP[safe(() => widget.getFieldType(), 'widget')] ?? 'unknown'
  if (type === 'checkbox') {
    const on = onStateOf(widget)
    const isOn = readName(widget.getObject().get('AS')) === on
    const want = typeof value === 'boolean' ? value : value !== '' && value !== 'Off'
    if (isOn !== want) widget.toggle()
  } else if (type === 'radio') {
    // value is the on-state name of the radio button to select (or this widget when true)
    const on = onStateOf(widget)
    const target = typeof value === 'boolean' ? (value ? on : 'Off') : value
    if (target === on) {
      if (readName(widget.getObject().get('AS')) !== on) widget.toggle()
    } else {
      // select the sibling with that state
      const name = widget.getName()
      for (const sib of widgetsNamed(s, name)) {
        const sibOn = onStateOf(sib.widget)
        const sibIsOn = readName(sib.widget.getObject().get('AS')) === sibOn
        if (sibOn === target && !sibIsOn) sib.widget.toggle()
        if (target === 'Off' && sibIsOn) sib.widget.toggle()
        s.touch(sib.pageIndex)
      }
    }
  } else if (type === 'text') {
    const v = String(value)
    if (opts.display !== undefined && opts.display !== v) {
      widget.setTextValue(opts.display)
      // Build the appearance from the formatted text now: update() regenerates it from /V.
      widget.update()
      // Keep the raw value in /V while the appearance shows the formatted text.
      const field = widget.getObject()
      const target = isNull(field.get('T')) && !isNull(field.get('Parent')) ? field.get('Parent') : field
      target.put('V', s.pdf.newString(v))
    } else {
      widget.setTextValue(v)
    }
  } else if (type === 'combo' || type === 'list') {
    widget.setChoiceValue(String(value))
  } else {
    throw new EngineError(`Cannot set the value of a ${type} field`, 'BAD_FIELD')
  }
  widget.update()
  s.touch(pageIndex)
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
      const first = ws[0]
      const type = TYPE_MAP[safe(() => first.widget.getFieldType(), 'widget')]
      if (type === 'checkbox' || type === 'radio') {
        if (type === 'radio') setWidgetValue(s, first.widget, first.pageIndex, v.value, {})
        else for (const w of ws) setWidgetValue(s, w.widget, w.pageIndex, v.value, {})
      } else {
        setWidgetValue(s, first.widget, first.pageIndex, v.value, { display: v.display })
        // other widgets of the same field share the value; refresh their appearance
        for (const w of ws.slice(1)) {
          w.widget.update()
          s.touch(w.pageIndex)
        }
      }
    }
    s.documentChanged()
  }),

  /** Clears the form (all fields, or only the named ones). */
  reset: mutation('Clear Form', (s, names?: string[]) => {
    const doc = s.pdf
    if (!names || !names.length) {
      // resetForm(empty, exclude=true) does not reset anything in MuPDF; pass every field.
      const all = doc.getTrailer().get('Root', 'AcroForm', 'Fields')
      if (!isNull(all)) doc.resetForm(all, false)
    } else {
      const arr = doc.newArray()
      walkFields(doc, (field, name) => {
        if (names.includes(name)) arr.push(field)
      })
      doc.resetForm(arr, false)
    }
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
