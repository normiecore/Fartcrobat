/**
 * Runs a form's Acrobat JavaScript: keystroke filters, commit/validation checks, display
 * formatting and calculations. Holds a model of the field values (kept in sync by the caller) so
 * that one user edit can be checked, formatted and recalculated before anything is written to the
 * document.
 */
import type { FieldInfo, FieldType } from '@engine/ops/forms'
import { createAFLibrary, EventObject, makeNumber, type AFHost } from './aform'
import {
  HostObject,
  Interpreter,
  JsDate,
  JsObject,
  NativeFunction,
  ScriptError,
  toDate,
  toNumber,
  toStr,
  type JsValue
} from './interpreter'
import { printd, printf, printx, scand } from './util'

export type FieldValue = string | string[]

export interface FormSnapshot {
  /** Every widget of the form (core forms.listAll). */
  fields: FieldInfo[]
  /** Field-level values by name; multi-select list boxes have arrays. */
  values: Record<string, FieldValue>
  /** Field names in calculation order (/CO). */
  calcOrder: string[]
  /** Document-level JavaScript (defines helper functions used by field scripts). */
  docScripts?: string[]
}

export interface FieldChange {
  name: string
  /** New value (omitted when only properties change). */
  value?: FieldValue
  /** Formatted text shown in the field. */
  display?: string
  textColor?: string
  /** display property set by a script: 0 visible, 1 hidden, 2 visible but not printed, 3 printed but not visible. */
  visibility?: number
  readOnly?: boolean
  required?: boolean
}

/** Things scripts can ask the application to do (button actions, app/doc methods). */
export interface RuntimeHost {
  print?(): void
  resetForm?(names?: string[]): void
  submitForm?(url: string): void
  launchURL?(url: string): void
  gotoPage?(page: number): void
  currentPage?(): number
  pageCount?(): number
  save?(): void
  exportData?(): void
  importData?(): void
  setFocus?(name: string): void
  notSupported?(what: string): void
  fileName?(): string
}

export interface ScriptProblem {
  field: string
  event: string
  message: string
  unsupported: boolean
}

interface FieldState {
  name: string
  type: FieldType
  value: FieldValue
  widgets: FieldInfo[]
  scripts: FieldInfo['scripts']
}

const NUMERIC = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/

/** A field value the way Acrobat's field.value returns it (numbers for numeric text). */
export function typedValue(v: FieldValue | undefined): JsValue {
  if (v === undefined) return ''
  if (Array.isArray(v)) return v.length === 1 ? typedValue(v[0]) : [...v]
  if (NUMERIC.test(v)) return Number(v)
  return v
}

/** Converts a script result to the string stored in the field. */
export function valueToString(v: JsValue): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  if (v instanceof JsDate) return v.date.toString()
  return toStr(v)
}

const COLOR_NAMES: Record<string, JsValue[]> = {
  transparent: ['T'],
  black: ['G', 0],
  white: ['G', 1],
  red: ['RGB', 1, 0, 0],
  green: ['RGB', 0, 1, 0],
  blue: ['RGB', 0, 0, 1],
  cyan: ['CMYK', 1, 0, 0, 0],
  magenta: ['CMYK', 0, 1, 0, 0],
  yellow: ['CMYK', 0, 0, 1, 0],
  dkGray: ['G', 0.25],
  gray: ['G', 0.5],
  ltGray: ['G', 0.75]
}

/** Acrobat colour array (["RGB", r, g, b], ["G", g], ["CMYK", c, m, y, k]) to #rrggbb. */
export function colorToHex(c: JsValue): string | null {
  if (!Array.isArray(c) || !c.length) return null
  const space = toStr(c[0])
  const n = (i: number) => Math.max(0, Math.min(1, toNumber(c[i])))
  let rgb: number[]
  if (space === 'RGB') rgb = [n(1), n(2), n(3)]
  else if (space === 'G') rgb = [n(1), n(1), n(1)]
  else if (space === 'CMYK') rgb = [(1 - n(1)) * (1 - n(4)), (1 - n(2)) * (1 - n(4)), (1 - n(3)) * (1 - n(4))]
  else return null
  return '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}

function hexToColor(hex: string): JsValue[] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return ['G', 0]
  return ['RGB', parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
}

const TYPE_NAMES: Record<FieldType, string> = {
  text: 'text',
  checkbox: 'checkbox',
  radio: 'radiobutton',
  combo: 'combobox',
  list: 'listbox',
  button: 'button',
  signature: 'signature',
  unknown: 'text'
}

export class FormRuntime {
  private readonly fields = new Map<string, FieldState>()
  private readonly names: string[] = []
  private readonly calcOrder: string[]
  private readonly interp: Interpreter
  private current: EventObject | null = null
  private alerts: string[] = []
  private colors = new Map<string, string>()
  /** Values assigned by scripts to other fields (field.value = ...). */
  private scriptWrites = new Map<string, FieldValue>()
  /** Field properties changed by scripts (display, readonly, required). */
  private propWrites = new Map<string, Pick<FieldChange, 'visibility' | 'readOnly' | 'required'>>()
  private readonly docObject: DocObject
  readonly problems: ScriptProblem[] = []
  /** Set by scripts through this.calculate = false. */
  calculateEnabled = true

  constructor(
    snapshot: FormSnapshot,
    readonly host: RuntimeHost = {}
  ) {
    for (const w of snapshot.fields) {
      let f = this.fields.get(w.name)
      if (!f) {
        f = {
          name: w.name,
          type: w.type,
          value: snapshot.values[w.name] ?? (w.type === 'checkbox' || w.type === 'radio' ? (w.checked ? (w.onState ?? 'Off') : 'Off') : w.value),
          widgets: [],
          scripts: {}
        }
        this.fields.set(w.name, f)
        this.names.push(w.name)
      }
      f.widgets.push(w)
      if (w.type === 'checkbox' && w.checked && w.onState) f.value = w.onState
      for (const k of ['format', 'keystroke', 'validate', 'calculate'] as const) {
        if (w.scripts[k] && !f.scripts[k]) f.scripts[k] = w.scripts[k]
      }
    }
    this.calcOrder = snapshot.calcOrder
    this.docObject = new DocObject(this)
    const afHost: AFHost = {
      event: () => {
        if (!this.current) throw new ScriptError('There is no current event')
        return this.current
      },
      fieldValues: (name) => this.valuesUnder(name),
      fieldNames: () => [...this.names],
      setTargetTextColor: (color) => {
        const t = this.current?.get('targetName')
        if (typeof t === 'string') this.colors.set(t, color)
      },
      alert: (m) => this.alerts.push(m)
    }
    this.interp = new Interpreter({ ...createAFLibrary(afHost), ...this.globals() })
    for (const src of snapshot.docScripts ?? []) {
      try {
        this.interp.run(src, { scope: this.interp.global, thisValue: this.docObject, globalObject: this.docObject })
      } catch (err) {
        this.problem('', 'Document script', err)
      }
    }
  }

  // ---- model ------------------------------------------------------------------------------

  has(name: string): boolean {
    return this.fields.has(name)
  }

  fieldNames(): string[] {
    return [...this.names]
  }

  field(name: string): FieldState | undefined {
    return this.fields.get(name)
  }

  value(name: string): FieldValue {
    return this.fields.get(name)?.value ?? ''
  }

  /** Updates the model after a value was written (or will be written) to the document. */
  setValue(name: string, value: FieldValue) {
    const f = this.fields.get(name)
    if (f) f.value = value
  }

  hasScripts(name: string): boolean {
    const s = this.fields.get(name)?.scripts
    return !!(s && (s.format || s.keystroke || s.validate || s.calculate))
  }

  /** True when any field has a calculation script. */
  hasCalculations(): boolean {
    for (const f of this.fields.values()) if (f.scripts.calculate) return true
    return false
  }

  private valuesUnder(name: string): JsValue[] {
    const f = this.fields.get(name)
    if (f) return Array.isArray(f.value) ? f.value.map((v) => typedValue(v)) : [typedValue(f.value)]
    const prefix = name + '.'
    return this.names.filter((n) => n.startsWith(prefix)).map((n) => typedValue(this.fields.get(n)!.value))
  }

  // ---- events -----------------------------------------------------------------------------

  private problem(field: string, event: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const unsupported = err instanceof ScriptError && err.unsupported
    if (!this.problems.some((p) => p.field === field && p.event === event && p.message === message))
      this.problems.push({ field, event, message, unsupported })
  }

  private run(name: string, eventName: string, script: string, init: Record<string, JsValue>): EventObject | null {
    const ev = new EventObject({
      name: eventName,
      type: 'Field',
      target: this.fieldObject(name),
      targetName: name,
      source: this.fieldObject(name),
      rc: true,
      modifier: false,
      shift: false,
      ...init
    })
    const prev = this.current
    this.current = ev
    this.interp.global.vars.set('event', ev)
    try {
      this.interp.run(script, { thisValue: this.docObject, globalObject: this.docObject })
      return ev
    } catch (err) {
      this.problem(name, eventName, err)
      return null
    } finally {
      this.current = prev
      this.interp.global.vars.set('event', prev ?? undefined)
    }
  }

  private takeAlerts(): string[] {
    const a = this.alerts
    this.alerts = []
    return a
  }

  /**
   * Checks one keystroke while the user types. `value` is the text before the change; the change
   * replaces value[selStart..selEnd]. Returns whether it is allowed and the (possibly modified)
   * inserted text.
   */
  keystroke(name: string, k: { value: string; change: string; selStart: number; selEnd: number }): { rc: boolean; change: string; alerts: string[] } {
    const script = this.fields.get(name)?.scripts.keystroke
    if (!script) return { rc: true, change: k.change, alerts: [] }
    const ev = this.run(name, 'Keystroke', script, {
      value: k.value,
      change: k.change,
      changeEx: k.change,
      selStart: k.selStart,
      selEnd: k.selEnd,
      willCommit: false,
      fieldFull: false,
      commitKey: 0
    })
    const alerts = this.takeAlerts()
    if (!ev) return { rc: true, change: k.change, alerts }
    return { rc: ev.rc, change: ev.change, alerts }
  }

  /**
   * Final keystroke check and validation when the user commits a value. Returns the value to
   * store (scripts may normalise it) or rc=false with Acrobat's message.
   */
  commit(name: string, value: string): { rc: boolean; value: string; alerts: string[] } {
    const f = this.fields.get(name)
    if (!f) return { rc: true, value, alerts: [] }
    let v = value
    if (f.scripts.keystroke) {
      const ev = this.run(name, 'Keystroke', f.scripts.keystroke, {
        value: v,
        change: '',
        changeEx: '',
        selStart: -1,
        selEnd: -1,
        willCommit: true,
        fieldFull: false,
        commitKey: 2
      })
      if (ev && !ev.rc) return { rc: false, value, alerts: this.takeAlerts() }
      if (ev) v = valueToString(ev.value)
    }
    if (f.scripts.validate) {
      const ev = this.run(name, 'Validate', f.scripts.validate, { value: v, willCommit: true, change: '' })
      if (ev && !ev.rc) return { rc: false, value, alerts: this.takeAlerts() }
      if (ev) v = valueToString(ev.value)
    }
    return { rc: true, value: v, alerts: this.takeAlerts() }
  }

  /** Display text of a field for its current (or the given) value, via its format script. */
  format(name: string, value?: string): { display: string; textColor?: string; alerts: string[] } {
    const f = this.fields.get(name)
    const raw = value ?? (f ? (Array.isArray(f.value) ? f.value.join(', ') : f.value) : '')
    if (!f?.scripts.format) return { display: raw, alerts: [] }
    this.colors.delete(name)
    const ev = this.run(name, 'Format', f.scripts.format, { value: raw, willCommit: true })
    const color = this.colors.get(name)
    return { display: ev ? valueToString(ev.value) : raw, textColor: color, alerts: this.takeAlerts() }
  }

  /** Names of calculated fields in the order calculations run. */
  calculationSequence(): string[] {
    const seq: string[] = []
    for (const n of this.calcOrder) if (this.fields.get(n)?.scripts.calculate && !seq.includes(n)) seq.push(n)
    for (const n of this.names) if (this.fields.get(n)?.scripts.calculate && !seq.includes(n)) seq.push(n)
    return seq
  }

  /** Runs every calculation once (in /CO order) and returns the fields whose value changed. */
  calculate(): { changes: FieldChange[]; alerts: string[] } {
    const changed = new Map<string, FieldValue>()
    this.scriptWrites.clear()
    this.propWrites.clear()
    if (this.calculateEnabled) {
      for (const name of this.calculationSequence()) {
        const f = this.fields.get(name)!
        const before = f.value
        const ev = this.run(name, 'Calculate', f.scripts.calculate!, { value: typedValue(f.value), willCommit: true })
        if (!ev || !ev.rc) continue
        const nv = valueToString(ev.value)
        if (Array.isArray(before) ? true : nv !== before) {
          f.value = nv
          changed.set(name, nv)
        }
      }
    }
    for (const [n, v] of this.scriptWrites) changed.set(n, v)
    return { changes: this.collectChanges(changed), alerts: this.takeAlerts() }
  }

  private collectChanges(values: Map<string, FieldValue>): FieldChange[] {
    const out = new Map<string, FieldChange>()
    for (const [name, value] of values) {
      const fmt = typeof value === 'string' ? this.format(name, value) : { display: undefined, textColor: undefined }
      out.set(name, { name, value, display: fmt.display, textColor: fmt.textColor })
    }
    for (const [name, props] of this.propWrites) out.set(name, { ...(out.get(name) ?? { name }), ...props })
    this.scriptWrites.clear()
    this.propWrites.clear()
    return [...out.values()]
  }

  /** A script changed a field property (display, readonly, required). */
  setProperty(name: string, props: Pick<FieldChange, 'visibility' | 'readOnly' | 'required'>) {
    const targets = this.fields.has(name) ? [name] : this.names.filter((n) => n.startsWith(name + '.'))
    for (const n of targets) {
      const f = this.fields.get(n)!
      for (const w of f.widgets) {
        if (props.visibility !== undefined) w.hidden = props.visibility === 1 || props.visibility === 3
        if (props.readOnly !== undefined) w.readOnly = props.readOnly
        if (props.required !== undefined) w.required = props.required
      }
      this.propWrites.set(n, { ...this.propWrites.get(n), ...props })
    }
  }

  /** Runs a button or document action script. */
  runAction(script: string, targetName = ''): { alerts: string[]; error?: string; changes: FieldChange[] } {
    this.scriptWrites.clear()
    this.propWrites.clear()
    const ev = new EventObject({
      name: 'Mouse Up',
      type: 'Field',
      target: targetName ? this.fieldObject(targetName) : null,
      targetName,
      rc: true
    })
    const prev = this.current
    this.current = ev
    this.interp.global.vars.set('event', ev)
    let error: string | undefined
    try {
      this.interp.run(script, { thisValue: this.docObject, globalObject: this.docObject })
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      this.problem(targetName, 'Mouse Up', err)
    } finally {
      this.current = prev
      this.interp.global.vars.set('event', prev ?? undefined)
    }
    const changes = this.collectChanges(new Map(this.scriptWrites))
    return { alerts: this.takeAlerts(), error, changes }
  }

  /** A script assigned field.value = v. */
  assignFromScript(name: string, v: JsValue) {
    const f = this.fields.get(name)
    if (!f) return
    let value: FieldValue
    if (Array.isArray(v) && f.type === 'list') value = v.map((x) => valueToString(x))
    else value = valueToString(v)
    if (f.type === 'checkbox' && (value === '' || value === 'false')) value = 'Off'
    f.value = value
    this.scriptWrites.set(name, value)
  }

  setTextColor(name: string, color: JsValue) {
    const hex = colorToHex(color)
    if (hex) this.colors.set(name, hex)
  }

  textColorOf(name: string): string {
    return this.colors.get(name) ?? this.fields.get(name)?.widgets[0]?.textColor ?? '#000000'
  }

  // ---- host objects -------------------------------------------------------------------------

  private fieldObjects = new Map<string, FieldObject>()

  fieldObject(name: string): FieldObject | null {
    if (!this.fields.has(name) && !this.names.some((n) => n.startsWith(name + '.'))) return null
    let o = this.fieldObjects.get(name)
    if (!o) {
      o = new FieldObject(this, name)
      this.fieldObjects.set(name, o)
    }
    return o
  }

  private globals(): Record<string, JsValue> {
    const nf = (name: string, fn: (args: JsValue[]) => JsValue, construct?: (args: JsValue[]) => JsValue, statics?: Record<string, JsValue>) =>
      new NativeFunction(name, (_t, a) => fn(a), construct ? (a) => construct(a) : undefined, statics)
    const host = this.host
    const notSupported = (what: string) => {
      host.notSupported?.(what)
      return undefined
    }
    const app = new JsObject({
      viewerVersion: 11,
      viewerType: 'Exchange-Pro',
      viewerVariation: 'Full',
      platform: 'WIN',
      language: 'ENU',
      formsVersion: 11,
      alert: nf('alert', (a) => {
        const m = a[0] instanceof JsObject ? a[0].props.get('cMsg') : a[0]
        this.alerts.push(toStr(m ?? ''))
        return 1
      }),
      beep: nf('beep', () => undefined),
      launchURL: nf('launchURL', (a) => {
        const url = toStr(a[0] instanceof JsObject ? a[0].props.get('cURL') : a[0])
        if (host.launchURL) host.launchURL(url)
        else notSupported('Opening web links')
        return undefined
      }),
      execMenuItem: nf('execMenuItem', (a) => {
        const item = toStr(a[0])
        if (/print/i.test(item) && host.print) host.print()
        else if (/^save/i.test(item) && host.save) host.save()
        else if (/nextpage/i.test(item)) host.gotoPage?.((host.currentPage?.() ?? 0) + 1)
        else if (/prevpage/i.test(item)) host.gotoPage?.((host.currentPage?.() ?? 0) - 1)
        else if (/firstpage/i.test(item)) host.gotoPage?.(0)
        else if (/lastpage/i.test(item)) host.gotoPage?.((host.pageCount?.() ?? 1) - 1)
        else notSupported(`The menu command “${item}”`)
        return undefined
      }),
      response: nf('response', () => notSupported('Asking questions with app.response') ?? null),
      setTimeOut: nf('setTimeOut', () => notSupported('Timers')),
      setInterval: nf('setInterval', () => notSupported('Timers')),
      clearTimeOut: nf('clearTimeOut', () => undefined),
      clearInterval: nf('clearInterval', () => undefined)
    })
    const util = new JsObject({
      printf: nf('printf', (a) => printf(toStr(a[0]), ...a.slice(1).map((x) => (typeof x === 'number' ? x : x instanceof JsDate ? x.date.getTime() : toStr(x))))),
      printd: nf('printd', (a) => {
        const d = a[1] instanceof JsDate ? a[1].date : toDate([a[1]])
        if (Number.isNaN(d.getTime())) return ''
        return printd(typeof a[0] === 'number' ? a[0] : toStr(a[0]), d)
      }),
      printx: nf('printx', (a) => printx(toStr(a[0]), toStr(a[1] ?? ''))),
      scand: nf('scand', (a) => {
        const d = scand(toStr(a[0]), toStr(a[1] ?? ''))
        return d ? new JsDate(d) : null
      })
    })
    const color = new JsObject()
    for (const [k, v] of Object.entries(COLOR_NAMES)) color.props.set(k, v)
    color.props.set(
      'equal',
      nf('equal', (a) => colorToHex(a[0]) === colorToHex(a[1]))
    )
    const display = new JsObject({ visible: 0, hidden: 1, noPrint: 2, noView: 3 })
    const consoleObj = new JsObject({
      println: nf('println', (a) => {
        console.info('[form script]', toStr(a[0]))
        return undefined
      }),
      show: nf('show', () => undefined),
      clear: nf('clear', () => undefined),
      hide: nf('hide', () => undefined)
    })
    return {
      app,
      util,
      color,
      display,
      console: consoleObj,
      border: new JsObject({ s: 'solid', d: 'dashed', b: 'beveled', i: 'inset', u: 'underline' }),
      style: new JsObject({ ch: 'check', cr: 'cross', di: 'diamond', ci: 'circle', st: 'star', sq: 'square' }),
      getField: nf('getField', (a) => this.fieldObject(toStr(a[0]))),
      event: undefined
    }
  }
}

/** `this` in field scripts: the document. */
class DocObject extends HostObject {
  constructor(private rt: FormRuntime) {
    super()
  }

  get(name: string): JsValue {
    const rt = this.rt
    const host = rt.host
    const nf = (n: string, fn: (a: JsValue[]) => JsValue) => new NativeFunction(n, (_t, a) => fn(a))
    switch (name) {
      case 'getField':
        return nf('getField', (a) => rt.fieldObject(toStr(a[0])))
      case 'numFields':
        return rt.fieldNames().length
      case 'getNthFieldName':
        return nf('getNthFieldName', (a) => rt.fieldNames()[toNumber(a[0])] ?? null)
      case 'calculateNow':
        return nf('calculateNow', () => {
          rt.calculate()
          return undefined
        })
      case 'calculate':
        return rt.calculateEnabled
      case 'resetForm':
        return nf('resetForm', (a) => {
          const names = Array.isArray(a[0]) ? a[0].map(toStr) : a[0] === undefined || a[0] === null ? undefined : [toStr(a[0])]
          if (host.resetForm) host.resetForm(names)
          return undefined
        })
      case 'print':
        return nf('print', () => {
          if (host.print) host.print()
          else host.notSupported?.('Printing')
          return undefined
        })
      case 'pageNum':
        return host.currentPage?.() ?? 0
      case 'numPages':
        return host.pageCount?.() ?? 1
      case 'documentFileName':
        return host.fileName?.() ?? ''
      case 'submitForm':
        return nf('submitForm', (a) => {
          const url = a[0] instanceof JsObject ? toStr(a[0].props.get('cURL') ?? '') : toStr(a[0] ?? '')
          if (host.submitForm) host.submitForm(url)
          else host.notSupported?.('Submitting forms')
          return undefined
        })
      case 'mailForm':
      case 'mailDoc':
      case 'emailForm':
        return nf(name, () => {
          host.notSupported?.('Emailing forms')
          return undefined
        })
      case 'saveAs':
        return nf('saveAs', () => {
          if (host.save) host.save()
          return undefined
        })
      case 'exportAsFDF':
      case 'exportAsXFDF':
      case 'exportAsText':
        return nf(name, () => {
          if (host.exportData) host.exportData()
          return undefined
        })
      case 'importAnFDF':
      case 'importAnXFDF':
      case 'importTextData':
        return nf(name, () => {
          if (host.importData) host.importData()
          return undefined
        })
      case 'dirty':
        return false
      case 'external':
        return false
      case 'info':
        return new JsObject({})
    }
    return undefined
  }

  set(name: string, value: JsValue) {
    if (name === 'pageNum') this.rt.host.gotoPage?.(toNumber(value))
    else if (name === 'calculate') this.rt.calculateEnabled = value !== false && value !== 0
    // Other document properties (dirty, title...) are ignored.
  }

  has(name: string) {
    return this.get(name) !== undefined
  }
}

/** A field as scripts see it (this.getField("name")). */
class FieldObject extends HostObject {
  constructor(
    private rt: FormRuntime,
    readonly name: string
  ) {
    super()
  }

  private state() {
    return this.rt.field(this.name)
  }

  get(prop: string): JsValue {
    const f = this.state()
    const nf = (n: string, fn: (a: JsValue[]) => JsValue) => new NativeFunction(n, (_t, a) => fn(a))
    const w = f?.widgets[0]
    switch (prop) {
      case 'name':
        return this.name
      case 'value':
        return f ? typedValue(f.value) : undefined
      case 'valueAsString':
        return f ? (Array.isArray(f.value) ? f.value.join(',') : f.value) : ''
      case 'type':
        return f ? TYPE_NAMES[f.type] : undefined
      case 'readonly':
        return !!w?.readOnly
      case 'required':
        return !!w?.required
      case 'hidden':
        return !!w?.hidden
      case 'display':
        return w?.hidden ? 1 : 0
      case 'userName':
        return w?.tooltip ?? ''
      case 'textColor':
        return hexToColor(this.rt.textColorOf(this.name))
      case 'fillColor':
        return w?.backgroundColor ? hexToColor(w.backgroundColor) : ['T']
      case 'borderColor':
        return w?.borderColor ? hexToColor(w.borderColor) : ['T']
      case 'textSize':
        return w?.fontSize ?? 0
      case 'textFont':
        return w?.fontName ?? 'Helv'
      case 'charLimit':
        return w?.maxLen ?? 0
      case 'comb':
        return !!w?.comb
      case 'multiline':
        return !!w?.multiline
      case 'password':
        return !!w?.password
      case 'editable':
        return !!w?.editable
      case 'multipleSelection':
        return !!w?.multiSelect
      case 'alignment':
        return ['left', 'center', 'right'][w?.alignment ?? 0]
      case 'page':
        return f && f.widgets.length > 1 ? f.widgets.map((x) => x.page) : (w?.page ?? 0)
      case 'rect':
        return w ? [w.rect[0], w.rect[1], w.rect[2], w.rect[3]] : undefined
      case 'numItems':
        return w?.options.length ?? 0
      case 'exportValues':
        return f?.widgets.map((x) => x.onState ?? '') ?? []
      case 'currentValueIndices': {
        if (!w) return -1
        const vals = Array.isArray(f!.value) ? f!.value : [f!.value]
        const idx = vals.map((v) => w.options.findIndex((o) => o.value === v)).filter((i) => i >= 0)
        return idx.length === 1 ? idx[0] : idx.length ? idx : -1
      }
      case 'defaultValue':
        return ''
      case 'getItemAt':
        return nf('getItemAt', (a) => {
          const o = w?.options[toNumber(a[0])]
          if (!o) return undefined
          return a[1] === false ? o.label : o.value
        })
      case 'getArray':
        return nf('getArray', () => {
          if (f) return [this]
          const prefix = this.name + '.'
          return this.rt
            .fieldNames()
            .filter((n) => n.startsWith(prefix))
            .map((n) => this.rt.fieldObject(n))
        })
      case 'isBoxChecked':
        return nf('isBoxChecked', (a) => {
          const k = f?.widgets[toNumber(a[0] ?? 0)]
          return k ? f!.value === k.onState : false
        })
      case 'isDefaultChecked':
        return nf('isDefaultChecked', () => false)
      case 'checkThisBox':
        return nf('checkThisBox', (a) => {
          const k = f?.widgets[toNumber(a[0] ?? 0)]
          if (!k?.onState) return undefined
          const on = a[1] === undefined ? true : a[1] !== false && a[1] !== 0
          this.rt.assignFromScript(this.name, on ? k.onState : 'Off')
          return undefined
        })
      case 'setFocus':
        return nf('setFocus', () => {
          this.rt.host.setFocus?.(this.name)
          return undefined
        })
      case 'setAction':
      case 'setItems':
      case 'insertItemAt':
      case 'deleteItemAt':
      case 'clearItems':
        return nf(prop, () => {
          this.rt.host.notSupported?.(`Changing a field with ${prop}()`)
          return undefined
        })
      case 'doc':
        return undefined
    }
    return undefined
  }

  set(prop: string, value: JsValue) {
    switch (prop) {
      case 'value':
        this.rt.assignFromScript(this.name, value)
        return
      case 'textColor':
        this.rt.setTextColor(this.name, value)
        return
      case 'display':
        this.rt.setProperty(this.name, { visibility: Math.max(0, Math.min(3, Math.round(toNumber(value)))) })
        return
      case 'hidden':
        this.rt.setProperty(this.name, { visibility: value === true || value === 1 ? 1 : 0 })
        return
      case 'readonly':
        this.rt.setProperty(this.name, { readOnly: value === true || value === 1 })
        return
      case 'required':
        this.rt.setProperty(this.name, { required: value === true || value === 1 })
        return
      default:
        // Other appearance properties (fillColor, borderStyle...) are left as they are.
        return
    }
  }

  toPrimitive(): JsValue {
    return '[object Field]'
  }
}

export { makeNumber }
