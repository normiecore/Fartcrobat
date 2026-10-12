/**
 * Reading and writing Prepare Form field properties (engine side).
 */
import type { Rect } from '@shared/geometry'
import { EngineError } from '@engine/define'
import type { PDFObject, Session } from '@engine/session'
import { isNull, readName, readNumber, readString } from '@engine/util/pdf'
import {
  CHECK_CHARS,
  NAME_PREFIX,
  type ButtonAction,
  type ButtonHighlight,
  type ChoiceOption,
  type FieldKind,
  type FieldProps,
  type PFField,
  type PFType,
  type TabOrder,
  type Visibility
} from './model'
import { borderStyleOf, borderWidthOf, checkStyleOf } from './appearance'
import {
  F_HIDDEN,
  F_NO_VIEW,
  F_PRINT,
  FF_COMB,
  FF_COMMIT_ON_SEL_CHANGE,
  FF_DO_NOT_SCROLL,
  FF_DO_NOT_SPELL_CHECK,
  FF_EDIT,
  FF_MULTI_SELECT,
  FF_MULTILINE,
  FF_NO_EXPORT,
  FF_PASSWORD,
  FF_RADIOS_IN_UNISON,
  FF_READ_ONLY,
  FF_REQUIRED,
  FF_SORT,
  colorArray,
  ensureFont,
  ensureMK,
  fieldOf,
  fieldScripts,
  fieldsByName,
  formatDA,
  fullName,
  getRect,
  kindOf,
  mkColor,
  newArray,
  onStateName,
  pageWidgets,
  putRect,
  readDA,
  sameObj,
  setFieldScript,
  setInCalculationOrder,
  widgetsOf
} from './fieldDict'
import {
  calculateScript,
  formatScripts,
  notationToJs,
  parseCalculate,
  parseFormat,
  parseValidate,
  tokenizeNotation,
  validateScript
} from './scripts'

// ---- reading ------------------------------------------------------------------------------

function visibilityOf(flags: number): Visibility {
  if (flags & F_HIDDEN) return 'hidden'
  if (flags & F_NO_VIEW) return flags & F_PRINT ? 'hidden-print' : 'hidden'
  return flags & F_PRINT ? 'visible' : 'visible-noprint'
}

function readOptions(field: PDFObject): ChoiceOption[] {
  const opt = field.getInheritable('Opt')
  const out: ChoiceOption[] = []
  if (isNull(opt) || !opt.isArray()) return out
  for (let i = 0; i < opt.length; i++) {
    const o = opt.get(i).resolve()
    if (o.isArray() && o.length >= 2) out.push({ value: readString(o.get(0)), label: readString(o.get(1)) })
    else {
      const t = readString(o)
      out.push({ value: t, label: t })
    }
  }
  return out
}

function readStrings(obj: PDFObject): string[] {
  if (isNull(obj)) return []
  const o = obj.resolve()
  if (o.isArray()) {
    const out: string[] = []
    for (let i = 0; i < o.length; i++) out.push(readString(o.get(i)))
    return out
  }
  const s = readString(o)
  return s ? [s] : []
}

function readAction(s: Session, w: PDFObject): ButtonAction {
  const a = w.get('A')
  if (isNull(a)) return { kind: 'none' }
  const type = readName(a.get('S'))
  switch (type) {
    case 'ResetForm':
      return { kind: 'reset' }
    case 'URI':
      return { kind: 'url', url: readString(a.get('URI')) }
    case 'Named':
      if (readName(a.get('N')) === 'Print') return { kind: 'print' }
      return { kind: 'other', description: `Menu item: ${readName(a.get('N')) ?? ''}` }
    case 'GoTo': {
      const d = a.get('D')
      if (!isNull(d) && d.isArray() && d.length > 0) {
        const p = d.get(0)
        if (p.isIndirect()) {
          const idx = s.pageIndexById(p.asIndirect())
          if (idx >= 0) return { kind: 'page', page: idx }
        } else if (p.isNumber()) return { kind: 'page', page: p.asNumber() }
      }
      return { kind: 'other', description: 'Go to a named destination' }
    }
    case 'JavaScript':
      return { kind: 'other', description: 'Run a JavaScript' }
    case 'SubmitForm':
      return {
        kind: 'other',
        description: `Submit form to ${readString(a.get('F', 'F')) || readString(a.get('F'))}`
      }
    default:
      return { kind: 'other', description: type ?? 'Unknown action' }
  }
}

function highlightOf(w: PDFObject): ButtonHighlight {
  switch (readName(w.get('H'))) {
    case 'N':
      return 'none'
    case 'O':
      return 'outline'
    case 'P':
      return 'push'
    default:
      return 'invert'
  }
}

/** Ids of the widgets of a page in tab order. */
export function tabOrderedWidgets(s: Session, pageIndex: number): PDFObject[] {
  const widgets = pageWidgets(s, pageIndex)
  const order = tabOrderOf(s, pageIndex)
  if (order !== 'row' && order !== 'column') return widgets
  const items = widgets.map((w) => ({ w, r: getRect(s, pageIndex, w) }))
  const primary = order === 'row' ? 1 : 0
  const secondary = order === 'row' ? 0 : 1
  items.sort((a, b) => a.r[primary] - b.r[primary])
  // group into rows (or columns): an item joins the current band when it starts within half the
  // band's first item size
  const bands: (typeof items)[] = []
  for (const it of items) {
    const band = bands[bands.length - 1]
    if (band) {
      const first = band[0]
      const size = first.r[primary + 2] - first.r[primary]
      if (it.r[primary] < first.r[primary] + Math.max(4, size / 2)) {
        band.push(it)
        continue
      }
    }
    bands.push([it])
  }
  return bands.flatMap((b) => b.sort((a, c) => a.r[secondary] - c.r[secondary]).map((x) => x.w))
}

export function tabOrderOf(s: Session, pageIndex: number): TabOrder {
  switch (readName(s.pdf.findPage(pageIndex).get('Tabs'))) {
    case 'R':
      return 'row'
    case 'C':
      return 'column'
    case 'S':
      return 'structure'
    default:
      return 'unspecified'
  }
}

export function readField(s: Session, w: PDFObject, pageIndex: number, tabIndex: number): PFField {
  const field = fieldOf(w)
  const type = kindOf(w)
  const ff = readNumber(w.getInheritable('Ff'), 0)
  const flags = readNumber(w.get('F'), 0)
  const da = readDA(s, w)
  const scripts = fieldScripts(field)
  const options = type === 'list' || type === 'combo' ? readOptions(field) : []
  const isToggle = type === 'checkbox' || type === 'radio'
  const exportValue = isToggle ? (onStateName(w) ?? 'Yes') : ''
  const dv = field.get('DV')
  const defaultSelection = type === 'list' || type === 'combo' ? readStrings(dv) : []
  const textLike = type === 'text' || type === 'date'
  let maxLen = 0
  if (textLike) maxLen = Math.round(readNumber(w.getInheritable('MaxLen'), 0))
  const r = Math.round(readNumber(w.get('MK', 'R'), 0))
  return {
    id: w.asIndirect(),
    page: pageIndex,
    name: fullName(field),
    type,
    rect: getRect(s, pageIndex, w),
    widgetCount: widgetsOf(field).length || 1,
    tabIndex,
    tooltip: readString(field.getInheritable('TU')),
    visibility: visibilityOf(flags),
    orientation: ((r % 360) + 360) % 360,
    readOnly: (ff & FF_READ_ONLY) !== 0,
    required: (ff & FF_REQUIRED) !== 0,
    noExport: (ff & FF_NO_EXPORT) !== 0,
    borderColor: mkColor(w, 'BC'),
    fillColor: mkColor(w, 'BG'),
    borderWidth: Math.round(borderWidthOf(w)),
    borderStyle: borderStyleOf(w),
    fontName: da.font,
    fontSize: da.size,
    textColor: da.color,
    alignment: Math.round(readNumber(w.getInheritable('Q'), 0)),
    defaultValue: textLike ? readString(dv) : '',
    value: isToggle ? (readName(field.get('V')) ?? 'Off') : readStrings(field.get('V')).join('\n'),
    multiline: textLike && (ff & FF_MULTILINE) !== 0,
    doNotScroll: (ff & FF_DO_NOT_SCROLL) !== 0,
    password: textLike && (ff & FF_PASSWORD) !== 0,
    doNotSpellCheck: (ff & FF_DO_NOT_SPELL_CHECK) !== 0,
    maxLen,
    comb: textLike && (ff & FF_COMB) !== 0,
    checkStyle: checkStyleOf(w),
    exportValue,
    checkedByDefault: isToggle && readName(dv) === exportValue,
    radiosInUnison: type === 'radio' && (ff & FF_RADIOS_IN_UNISON) !== 0,
    options,
    sort: (ff & FF_SORT) !== 0,
    editable: type === 'combo' && (ff & FF_EDIT) !== 0,
    multiSelect: type === 'list' && (ff & FF_MULTI_SELECT) !== 0,
    commitOnSelChange: (ff & FF_COMMIT_ON_SEL_CHANGE) !== 0,
    defaultSelection,
    caption: type === 'button' ? readString(w.get('MK', 'CA')) : '',
    highlight: highlightOf(w),
    action: readAction(s, w),
    format: parseFormat(scripts.format, scripts.keystroke),
    validate: parseValidate(scripts.validate),
    calculate: parseCalculate(scripts.calculate)
  }
}

export function readPage(s: Session, pageIndex: number): PFField[] {
  return tabOrderedWidgets(s, pageIndex).map((w, i) => readField(s, w, pageIndex, i))
}

// ---- naming -------------------------------------------------------------------------------

/** Next Acrobat-style automatic name for a field type ("Text3", "Check Box1"...). */
export function nextAutoName(s: Session, type: PFType, taken?: Set<string>): string {
  const prefix = NAME_PREFIX[type]
  const names = taken ?? new Set(fieldsByName(s).keys())
  let max = 0
  const re = new RegExp(`^${prefix.replace(/ /g, '\\s')}(\\d+)$`)
  for (const n of names) {
    const m = re.exec(n)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  let n = max + 1
  while (names.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

/** A unique name based on `base` ("Name", "Name_2", "Name_3"...). */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base
  const m = /^(.*?)(?:_(\d+))?$/.exec(base)!
  const stem = m[1] || base
  let n = m[2] ? parseInt(m[2], 10) + 1 : 2
  while (taken.has(`${stem}_${n}`)) n++
  return `${stem}_${n}`
}

/** Next radio export value in a group ("Choice1", "Choice2"...). */
export function nextChoiceName(field: PDFObject): string {
  const used = new Set(widgetsOf(field).map((w) => onStateName(w) ?? ''))
  let n = 1
  while (used.has(`Choice${n}`)) n++
  return `Choice${n}`
}

// ---- writing ------------------------------------------------------------------------------

function setFlag(field: PDFObject, s: Session, bit: number, on: boolean | undefined) {
  if (on === undefined) return
  const cur = readNumber(field.get('Ff'), readNumber(field.getInheritable('Ff'), 0))
  const next = on ? cur | bit : cur & ~bit
  if (next !== cur || isNull(field.get('Ff'))) field.put('Ff', next)
}

function visibilityFlags(current: number, v: Visibility): number {
  let f = current & ~(F_HIDDEN | F_NO_VIEW | F_PRINT | 1)
  if (v === 'visible') f |= F_PRINT
  else if (v === 'hidden') f |= F_HIDDEN
  else if (v === 'hidden-print') f |= F_NO_VIEW | F_PRINT
  return f
}

function borderStyleName(style: string): string {
  switch (style) {
    case 'dashed':
      return 'D'
    case 'beveled':
      return 'B'
    case 'inset':
      return 'I'
    case 'underline':
      return 'U'
    default:
      return 'S'
  }
}

/** Renames the on-state of a check box/radio widget (its export value). */
export function setExportValue(s: Session, w: PDFObject, value: string) {
  const doc = s.pdf
  const v = value.trim()
  if (!v) throw new EngineError('The export value cannot be empty', 'BAD_VALUE')
  if (v === 'Off') throw new EngineError('“Off” cannot be used as an export value', 'BAD_VALUE')
  const old = onStateName(w)
  if (old === v) return
  const field = fieldOf(w)
  const wasOn = old !== null && readName(field.get('V')) === old
  const wasDefault = old !== null && readName(field.get('DV')) === old
  for (const key of ['N', 'D']) {
    const d = w.get('AP', key)
    if (isNull(d) || d.isStream()) continue
    if (old !== null) {
      const stream = d.get(old)
      if (!isNull(stream)) {
        d.delete(old)
        d.put(v, stream)
      }
    }
  }
  if (isNull(w.get('AP'))) {
    const ap = doc.newDictionary()
    const n = doc.newDictionary()
    n.put(v, doc.addStream('', doc.newDictionary()))
    n.put('Off', doc.addStream('', doc.newDictionary()))
    ap.put('N', n)
    w.put('AP', ap)
  }
  if (wasOn) {
    // other widgets that still use the old value keep the field on only if any is on
    field.put('V', doc.newName(v))
    w.put('AS', doc.newName(v))
  }
  if (wasDefault) field.put('DV', doc.newName(v))
}

function optArray(s: Session, options: ChoiceOption[]): PDFObject {
  const doc = s.pdf
  const arr = doc.newArray()
  for (const o of options) {
    if (o.value === o.label || !o.value) arr.push(doc.newString(o.label))
    else arr.push(newArray(doc, [doc.newString(o.value), doc.newString(o.label)]))
  }
  return arr
}

function putStrings(s: Session, field: PDFObject, key: string, values: string[]) {
  const doc = s.pdf
  if (!values.length) field.delete(key)
  else if (values.length === 1) field.put(key, doc.newString(values[0]))
  else
    field.put(
      key,
      newArray(
        doc,
        values.map((v) => doc.newString(v))
      )
    )
}

function actionDict(s: Session, a: ButtonAction): PDFObject | null {
  const doc = s.pdf
  const d = doc.newDictionary()
  switch (a.kind) {
    case 'none':
    case 'other':
      return null
    case 'reset':
      d.put('S', doc.newName('ResetForm'))
      return d
    case 'url': {
      const url = a.url.trim()
      if (!url) return null
      d.put('S', doc.newName('URI'))
      d.put('URI', doc.newString(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`))
      return d
    }
    case 'page': {
      const page = Math.max(0, Math.min(s.pageCount() - 1, Math.round(a.page)))
      d.put('S', doc.newName('GoTo'))
      d.put('D', newArray(doc, [doc.findPage(page), doc.newName('Fit')]))
      return d
    }
    case 'print':
      d.put('S', doc.newName('Named'))
      d.put('N', doc.newName('Print'))
      return d
  }
}

/** Applies properties to a widget and its field. Returns the field dictionary. */
export function applyProps(s: Session, w: PDFObject, pageIndex: number, props: FieldProps): PDFObject {
  const doc = s.pdf
  const field = fieldOf(w)
  const kind: FieldKind = kindOf(w)
  const has = <K extends keyof FieldProps>(k: K) => props[k] !== undefined

  if (has('rect')) putRect(s, pageIndex, w, props.rect!)

  // General
  if (has('tooltip')) {
    if (props.tooltip!.trim()) field.put('TU', doc.newString(props.tooltip!))
    else field.delete('TU')
  }
  if (has('visibility')) w.put('F', visibilityFlags(readNumber(w.get('F'), F_PRINT), props.visibility!))
  if (has('orientation')) {
    const r = (((Math.round(props.orientation! / 90) * 90) % 360) + 360) % 360
    const mk = ensureMK(s, w)
    if (r) mk.put('R', r)
    else mk.delete('R')
  }
  setFlag(field, s, FF_READ_ONLY, props.readOnly)
  setFlag(field, s, FF_REQUIRED, props.required)
  setFlag(field, s, FF_NO_EXPORT, props.noExport)

  // Appearance
  if (has('borderColor')) ensureMK(s, w).put('BC', colorArray(s, props.borderColor!))
  if (has('fillColor')) ensureMK(s, w).put('BG', colorArray(s, props.fillColor!))
  if (has('borderWidth') || has('borderStyle')) {
    let bs = w.get('BS')
    if (isNull(bs)) {
      w.put('BS', doc.newDictionary())
      bs = w.get('BS')
    }
    bs.put('Type', doc.newName('Border'))
    if (has('borderWidth')) bs.put('W', Math.max(0, Math.min(12, props.borderWidth!)))
    if (has('borderStyle')) {
      bs.put('S', doc.newName(borderStyleName(props.borderStyle!)))
      if (props.borderStyle === 'dashed') bs.put('D', newArray(doc, [3]))
      else bs.delete('D')
    }
    w.delete('Border')
  }
  if (has('fontName') || has('fontSize') || has('textColor')) {
    const da = readDA(s, w)
    if (has('fontName')) da.font = props.fontName!
    if (has('fontSize')) da.size = Math.max(0, Math.min(144, props.fontSize!))
    if (has('textColor')) da.color = props.textColor!
    ensureFont(s, da.font)
    w.put('DA', doc.newString(formatDA(da)))
    // a field-level DA would otherwise win for other viewers that read the field first
    if (!sameObj(field, w) && !isNull(field.get('DA'))) field.delete('DA')
  }
  if (has('alignment')) w.put('Q', Math.max(0, Math.min(2, Math.round(props.alignment!))))

  // Text options
  if (kind === 'text' || kind === 'date') {
    setFlag(field, s, FF_MULTILINE, props.multiline)
    setFlag(field, s, FF_DO_NOT_SCROLL, props.doNotScroll)
    setFlag(field, s, FF_PASSWORD, props.password)
    setFlag(field, s, FF_DO_NOT_SPELL_CHECK, props.doNotSpellCheck)
    setFlag(field, s, FF_COMB, props.comb)
    if (has('maxLen')) {
      const n = Math.max(0, Math.round(props.maxLen!))
      if (n > 0) field.put('MaxLen', n)
      else field.delete('MaxLen')
    }
    if (has('defaultValue')) {
      const v = props.defaultValue!
      if (v) {
        field.put('DV', doc.newString(v))
        field.put('V', doc.newString(v))
      } else {
        field.delete('DV')
        field.delete('V')
      }
    }
  }

  // Check boxes and radio buttons
  if (kind === 'checkbox' || kind === 'radio') {
    if (has('checkStyle')) ensureMK(s, w).put('CA', doc.newString(CHECK_CHARS[props.checkStyle!]))
    if (has('exportValue')) setExportValue(s, w, props.exportValue!)
    if (has('checkedByDefault')) {
      const on = onStateName(w) ?? 'Yes'
      if (props.checkedByDefault) {
        field.put('DV', doc.newName(on))
        field.put('V', doc.newName(on))
      } else if (readName(field.get('DV')) === on) {
        field.delete('DV')
        field.put('V', doc.newName('Off'))
      }
    }
    if (kind === 'radio') setFlag(field, s, FF_RADIOS_IN_UNISON, props.radiosInUnison)
  }

  // Choice fields
  if (kind === 'list' || kind === 'combo') {
    setFlag(field, s, FF_SORT, props.sort)
    if (kind === 'combo') setFlag(field, s, FF_EDIT, props.editable)
    if (kind === 'list') setFlag(field, s, FF_MULTI_SELECT, props.multiSelect)
    setFlag(field, s, FF_COMMIT_ON_SEL_CHANGE, props.commitOnSelChange)
    setFlag(field, s, FF_DO_NOT_SPELL_CHECK, props.doNotSpellCheck)
    if (has('options') || has('sort')) {
      let options = props.options ?? readOptions(field)
      const sort = props.sort ?? (readNumber(field.getInheritable('Ff'), 0) & FF_SORT) !== 0
      if (sort) options = [...options].sort((a, b) => a.label.localeCompare(b.label))
      if (options.length) field.put('Opt', optArray(s, options))
      else field.delete('Opt')
      // drop a value that no longer exists
      const values = new Set(options.map((o) => o.value || o.label))
      const cur = readStrings(field.get('V')).filter((v) => values.has(v))
      if (kind === 'list' || !(readNumber(field.getInheritable('Ff'), 0) & FF_EDIT))
        putStrings(s, field, 'V', cur)
      putStrings(
        s,
        field,
        'DV',
        readStrings(field.get('DV')).filter((v) => values.has(v))
      )
      field.delete('I')
    }
    if (has('defaultSelection')) {
      const sel = props.defaultSelection!.filter(Boolean)
      putStrings(s, field, 'DV', sel)
      putStrings(s, field, 'V', sel)
      // /I (selected indices) must match /V for list boxes
      const opts = readOptions(field)
      const idx = sel.map((v) => opts.findIndex((o) => (o.value || o.label) === v)).filter((i) => i >= 0)
      if (kind === 'list' && idx.length)
        field.put(
          'I',
          newArray(
            doc,
            idx.sort((a, b) => a - b)
          )
        )
      else field.delete('I')
    }
  }

  // Buttons
  if (kind === 'button') {
    if (has('caption')) ensureMK(s, w).put('CA', doc.newString(props.caption!))
    if (has('highlight'))
      w.put('H', doc.newName({ none: 'N', invert: 'I', outline: 'O', push: 'P' }[props.highlight!]))
    if (has('action') && props.action!.kind !== 'other') {
      const a = actionDict(s, props.action!)
      if (a) w.put('A', a)
      else w.delete('A')
    }
  }

  // Scripts (text fields and dropdowns)
  if (kind === 'text' || kind === 'date' || kind === 'combo') {
    if (has('format')) {
      const sc = formatScripts(props.format!)
      setFieldScript(s, field, 'F', sc.format)
      setFieldScript(s, field, 'K', sc.keystroke)
    }
    if (has('validate')) setFieldScript(s, field, 'V', validateScript(props.validate!))
    if (has('calculate')) {
      const c = props.calculate!
      if (c.kind === 'notation' && c.expr.trim()) {
        try {
          tokenizeNotation(c.expr)
        } catch (err) {
          throw new EngineError(
            `The calculation “${c.expr}” is not valid: ${(err as Error).message}`,
            'BAD_CALC'
          )
        }
      }
      const script = calculateScript(c)
      setFieldScript(s, field, 'C', script)
      setInCalculationOrder(s, field, !!script)
    }
  }
  return field
}

/** Rewrites simple calculations of every field that refer to `from` so they use `to`. */
export function renameInCalculations(s: Session, from: string, to: string) {
  for (const field of fieldsByName(s).values()) {
    const sc = fieldScripts(field)
    if (!sc.calculate) continue
    const spec = parseCalculate(sc.calculate)
    if (spec.kind === 'simple' && spec.fields.includes(from)) {
      setFieldScript(
        s,
        field,
        'C',
        calculateScript({ ...spec, fields: spec.fields.map((f) => (f === from ? to : f)) })
      )
    } else if (spec.kind === 'notation') {
      try {
        const tokens = tokenizeNotation(spec.expr)
        if (tokens.some((t) => t.t === 'name' && t.v === from)) {
          const escaped = (n: string) => n.replace(/([\\\s+\-*/()])/g, '\\$1')
          const expr = tokens.map((t) => (t.t === 'name' ? escaped(t.v === from ? to : t.v) : t.v)).join(' ')
          setFieldScript(s, field, 'C', `event.value = ${notationToJs(expr)};`)
        }
      } catch {}
    }
  }
}

export function rectWithin(r: Rect, bounds: Rect): Rect {
  const w = Math.min(r[2] - r[0], bounds[2] - bounds[0])
  const h = Math.min(r[3] - r[1], bounds[3] - bounds[1])
  const x = Math.max(bounds[0], Math.min(bounds[2] - w, r[0]))
  const y = Math.max(bounds[1], Math.min(bounds[3] - h, r[1]))
  return [x, y, x + w, y + h]
}
