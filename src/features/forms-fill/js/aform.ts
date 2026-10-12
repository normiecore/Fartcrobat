/**
 * Acrobat's AForm.js functions (AFNumber_Format, AFDate_FormatEx, AFSimple_Calculate...) used by
 * nearly every real-world PDF form, implemented natively for the interpreter. Behaviour and
 * messages follow Acrobat.
 */
import { HostObject, JsDate, NativeFunction, toNumber, toStr, type JsValue } from './interpreter'
import { formatNumber, guessDate, printd, printx, scand } from './util'

export const IDS_INVALID_VALUE = 'The value entered does not match the format of the field'
export const IDS_INVALID_DATE = 'Invalid date/time: please ensure that the date/time exists. Field'
export const IDS_INVALID_DATE2 = ' should match format '
export const IDS_GT_AND_LT = 'Invalid value: must be greater than or equal to %s and less than or equal to %s.'
export const IDS_GREATER_THAN = 'Invalid value: must be greater than or equal to %s.'
export const IDS_LESS_THAN = 'Invalid value: must be less than or equal to %s.'

/** The `event` object scripts see. */
export class EventObject extends HostObject {
  readonly props = new Map<string, JsValue>()
  constructor(init: Record<string, JsValue>) {
    super()
    for (const [k, v] of Object.entries(init)) this.props.set(k, v)
    if (!this.props.has('rc')) this.props.set('rc', true)
  }
  get(name: string): JsValue {
    return this.props.get(name)
  }
  set(name: string, value: JsValue) {
    this.props.set(name, value)
  }
  has(name: string) {
    return this.props.has(name)
  }
  get value(): JsValue {
    return this.props.get('value')
  }
  set value(v: JsValue) {
    this.props.set('value', v)
  }
  get rc(): boolean {
    return this.props.get('rc') !== false
  }
  set rc(v: boolean) {
    this.props.set('rc', v)
  }
  get willCommit(): boolean {
    return this.props.get('willCommit') === true
  }
  get change(): string {
    const c = this.props.get('change')
    return c === undefined || c === null ? '' : toStr(c)
  }
  /** Name of the field the event is for, as Acrobat prints it in messages: "[ name ]". */
  targetLabel(): string {
    return `[ ${toStr(this.props.get('targetName') ?? '')} ]`
  }
}

export interface AFHost {
  /** The event being processed. */
  event(): EventObject
  /** Values of a field and its descendants (for "group" names), in document order. */
  fieldValues(name: string): JsValue[]
  /** Every field name, for "name.*" wildcards. */
  fieldNames(): string[]
  /** Changes the text colour of the event's target field (negative numbers in red). */
  setTargetTextColor(color: string): void
  alert(message: string): void
}

const sprintf = (fmt: string, ...args: unknown[]) => {
  let i = 0
  return fmt.replace(/%s/g, () => String(args[i++]))
}

/** AFMakeNumber: turns "1,5", " 12 ", 7 into numbers; null when there is no number. */
export function makeNumber(v: JsValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v !== 'string') {
    if (v === null || v === undefined) return null
    return makeNumber(toStr(v))
  }
  let s = v.trim()
  if (!s) return null
  // Strip currency symbols, spaces and percent signs around the number.
  s = s.replace(/[\s\u00a0'\u2019]/g, '').replace(/^[^\d.,+-]+|[^\d.,]+$/g, '')
  let neg = false
  if (/^\(.*\)$/.test(v.trim())) neg = true
  if (s.startsWith('-')) {
    neg = !neg
    s = s.slice(1)
  } else if (s.startsWith('+')) s = s.slice(1)
  if (s.startsWith('-')) {
    neg = !neg
    s = s.slice(1)
  }
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  if (lastDot >= 0 && lastComma >= 0) {
    // "1,234.56" or "1.234,56": the last separator is the decimal point.
    s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.')
  } else if (lastComma >= 0) {
    // "1,5" is a decimal comma; "1,234" or "1,234,567" are thousands.
    const groups = s.split(',')
    const thousands = groups.length > 2 || (groups.length === 2 && groups[1].length === 3 && groups[0].length <= 3 && groups[0] !== '0')
    s = thousands && groups.slice(1).every((g) => g.length === 3) ? groups.join('') : s.replace(',', '.')
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, '')
  }
  const n = parseFloat(s)
  if (!Number.isFinite(n)) return null
  return neg ? -n : n
}

/** AFMergeChange: the field text after the pending keystroke is applied. */
export function mergeChange(e: EventObject): string {
  const value = toStr(e.value ?? '')
  if (e.willCommit) return value
  const selStart = toNumber(e.get('selStart') ?? value.length)
  const selEnd = toNumber(e.get('selEnd') ?? value.length)
  const prefix = selStart >= 0 ? value.slice(0, selStart) : ''
  const postfix = selEnd >= 0 && selEnd <= value.length ? value.slice(selEnd) : ''
  return prefix + e.change + postfix
}

function exactMatch(res: RegExp | RegExp[], value: string): number {
  const list = Array.isArray(res) ? res : [res]
  for (let i = 0; i < list.length; i++) {
    const m = new RegExp(`^(?:${list[i].source})$`).exec(value)
    if (m) return i + 1
  }
  return 0
}

const ZIP_COMMIT = /\d{5}/
const ZIP_NO_COMMIT = /\d{0,5}/
const ZIP4_COMMIT = /\d{5}(\.|[- ])?\d{4}/
const ZIP4_NO_COMMIT = /\d{0,5}(\.|[- ])?\d{0,4}/
const PHONE_COMMIT = [
  /\d{3}(\.|[- ])?\d{4}/,
  /\d{3}(\.|[- ])?\d{3}(\.|[- ])?\d{4}/,
  /\(\d{3}\)(\.|[- ])?\d{3}(\.|[- ])?\d{4}/,
  /011(\.|[- \d])*/
]
const PHONE_NO_COMMIT = [
  /\d{0,3}(\.|[- ])?\d{0,3}(\.|[- ])?\d{0,4}/,
  /\(\d{0,3}/,
  /\(\d{0,3}\)(\.|[- ])?\d{0,3}(\.|[- ])?\d{0,4}/,
  /\(\d{0,3}(\.|[- ])?\d{0,3}(\.|[- ])?\d{0,4}/,
  /\d{0,3}\)(\.|[- ])?\d{0,3}(\.|[- ])?\d{0,4}/,
  /011(\.|[- \d])*/
]
const SSN_COMMIT = /\d{3}(\.|[- ])?\d{2}(\.|[- ])?\d{4}/
const SSN_NO_COMMIT = /\d{0,3}(\.|[- ])?\d{0,2}(\.|[- ])?\d{0,4}/

export const DATE_FORMATS = [
  'm/d',
  'm/d/yy',
  'mm/dd/yy',
  'mm/yy',
  'd-mmm',
  'd-mmm-yy',
  'dd-mmm-yy',
  'yy-mm-dd',
  'mmm-yy',
  'mmmm-yy',
  'mmm d, yyyy',
  'mmmm d, yyyy',
  'm/d/yy h:MM tt',
  'm/d/yy HH:MM'
]
export const TIME_FORMATS = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt']

/** Parses a date the way AFDate_* does: the exact format first, then a lenient guess. */
export function parseDate(format: string, value: string): Date | null {
  return scand(format, value) ?? guessDate(format, value)
}

function arg(args: JsValue[], i: number): JsValue {
  return args[i]
}

function num(args: JsValue[], i: number, fallback = 0): number {
  const n = makeNumber(args[i] ?? null)
  return n === null ? fallback : n
}

function bool(args: JsValue[], i: number): boolean {
  const v = args[i]
  return v === true || v === 1 || v === 'true'
}

/** Expands a field list ("a, b", ["a", "b"], "group.*") into field names. */
export function fieldList(host: AFHost, list: JsValue): string[] {
  let names: string[] = []
  if (Array.isArray(list)) names = list.map((x) => toStr(x).trim())
  else if (typeof list === 'string') names = list.split(/\s*,\s*/).map((x) => x.trim())
  else if (list !== undefined && list !== null) names = [toStr(list)]
  const out: string[] = []
  for (const n of names) {
    if (!n) continue
    if (n.endsWith('*')) {
      const prefix = n.slice(0, -1)
      for (const f of host.fieldNames()) if (f.startsWith(prefix)) out.push(f)
    } else out.push(n)
  }
  return out
}

export function createAFLibrary(host: AFHost): Record<string, NativeFunction> {
  const fn = (name: string, impl: (args: JsValue[]) => JsValue | void) =>
    new NativeFunction(name, (_t, args) => impl(args) ?? undefined)

  const numberKeystroke = (sepStyle: number) => {
    const e = host.event()
    let value = mergeChange(e)
    if (!value) return
    value = value.trim()
    const commaDecimal = sepStyle > 1
    const pattern = e.willCommit
      ? commaDecimal
        ? /^[+-]?(\d+(,\d*)?|,\d+)$/
        : /^[+-]?(\d+(\.\d*)?|\.\d+)$/
      : commaDecimal
        ? /^[+-]?\d*,?\d*$/
        : /^[+-]?\d*\.?\d*$/
    if (!pattern.test(value)) {
      if (e.willCommit) host.alert(`${IDS_INVALID_VALUE} ${e.targetLabel()}`)
      e.rc = false
      return
    }
    if (e.willCommit && commaDecimal) e.value = String(parseFloat(value.replace(',', '.')))
  }

  const dateFormat = (format: string) => {
    const e = host.event()
    const value = toStr(e.value ?? '')
    if (!value) return
    const date = parseDate(format, value)
    if (date) e.value = printd(format, date)
  }

  const dateKeystroke = (format: string) => {
    const e = host.event()
    if (!e.willCommit) return
    const value = mergeChange(e)
    if (!value) return
    if (!parseDate(format, value)) {
      host.alert(`${IDS_INVALID_DATE} ${e.targetLabel()}${IDS_INVALID_DATE2}${format}`)
      e.rc = false
    }
  }

  const specialKeystrokeEx = (mask: string) => {
    if (!mask) return
    const e = host.event()
    const value = mergeChange(e)
    if (!value) return
    const checkers: Record<string, (c: string) => boolean> = {
      '9': (c) => /[0-9]/.test(c),
      A: (c) => /[A-Za-z]/.test(c),
      O: (c) => /[A-Za-z0-9]/.test(c),
      X: () => true
    }
    const valid = (v: string, m: string) => {
      for (let i = 0; i < v.length; i++) {
        const mc = m[i]
        const check = checkers[mc]
        if (check ? !check(v[i]) : mc !== v[i]) return false
      }
      return true
    }
    const err = `${IDS_INVALID_VALUE} ${e.targetLabel()}`
    if (e.willCommit) {
      if (value.length < mask.length || value.length > mask.length || !valid(value, mask)) {
        host.alert(err)
        e.rc = false
      }
      return
    }
    // While typing, insert literal mask characters automatically ("1234" -> "123-4").
    if (value.length <= mask.length && valid(value, mask.slice(0, value.length))) return
    const sel = toNumber(e.get('selStart') ?? 0)
    const atEnd = sel >= toStr(e.value ?? '').length
    if (atEnd && e.change) {
      let prefix = toStr(e.value ?? '')
      let auto = ''
      while (prefix.length + auto.length < mask.length && !checkers[mask[prefix.length + auto.length]]) {
        auto += mask[prefix.length + auto.length]
      }
      const candidate = prefix + auto + e.change
      prefix = candidate
      if (auto && candidate.length <= mask.length && valid(candidate, mask.slice(0, candidate.length))) {
        e.set('change', auto + e.change)
        return
      }
    }
    e.rc = false
  }

  const lib: Record<string, NativeFunction> = {
    AFMakeNumber: fn('AFMakeNumber', (a) => makeNumber(arg(a, 0))),
    AFMergeChange: fn('AFMergeChange', (a) => mergeChange((a[0] instanceof EventObject ? a[0] : host.event()) as EventObject)),
    AFExtractNums: fn('AFExtractNums', (a) => {
      const m = toStr(arg(a, 0)).match(/\d+/g)
      return m ? [...m] : null
    }),

    AFNumber_Format: fn('AFNumber_Format', (a) => {
      const nDec = num(a, 0)
      const sepStyle = Math.max(0, Math.min(4, Math.floor(num(a, 1))))
      const negStyle = num(a, 2)
      const strCurrency = arg(a, 4) === undefined ? '' : toStr(arg(a, 4))
      const prepend = bool(a, 5)
      const e = host.event()
      const value = makeNumber(e.value ?? null)
      if (value === null) {
        e.value = ''
        return
      }
      const negative = value < 0
      let body = formatNumber(Math.abs(value), nDec, sepStyle)
      const isZero = !/[1-9]/.test(body)
      body = prepend ? strCurrency + body : body + strCurrency
      if (negative && !isZero) {
        if (negStyle === 2 || negStyle === 3) body = `(${body})`
        else if (negStyle === 0) body = `-${body}`
      }
      if (negStyle === 1 || negStyle === 3) host.setTargetTextColor(negative && !isZero ? '#ff0000' : '#000000')
      e.value = body
    }),
    AFNumber_Keystroke: fn('AFNumber_Keystroke', (a) => numberKeystroke(num(a, 1))),

    AFPercent_Format: fn('AFPercent_Format', (a) => {
      const nDec = num(a, 0)
      const sepStyle = Math.max(0, Math.min(4, Math.floor(num(a, 1))))
      const prepend = bool(a, 2)
      const e = host.event()
      const value = makeNumber(e.value ?? null)
      if (value === null) {
        e.value = ''
        return
      }
      const s = formatNumber(value * 100, nDec, sepStyle)
      e.value = prepend ? `%${s}` : `${s}%`
    }),
    AFPercent_Keystroke: fn('AFPercent_Keystroke', (a) => numberKeystroke(num(a, 1))),

    AFDate_FormatEx: fn('AFDate_FormatEx', (a) => dateFormat(toStr(arg(a, 0)))),
    AFDate_Format: fn('AFDate_Format', (a) => dateFormat(DATE_FORMATS[num(a, 0)] ?? DATE_FORMATS[0])),
    AFDate_KeystrokeEx: fn('AFDate_KeystrokeEx', (a) => dateKeystroke(toStr(arg(a, 0)))),
    AFDate_Keystroke: fn('AFDate_Keystroke', (a) => dateKeystroke(DATE_FORMATS[num(a, 0)] ?? DATE_FORMATS[0])),
    AFTime_Format: fn('AFTime_Format', (a) => dateFormat(TIME_FORMATS[num(a, 0)] ?? TIME_FORMATS[0])),
    AFTime_FormatEx: fn('AFTime_FormatEx', (a) => dateFormat(toStr(arg(a, 0)))),
    AFTime_Keystroke: fn('AFTime_Keystroke', (a) => dateKeystroke(TIME_FORMATS[num(a, 0)] ?? TIME_FORMATS[0])),
    AFTime_KeystrokeEx: fn('AFTime_KeystrokeEx', (a) => dateKeystroke(toStr(arg(a, 0)))),

    AFSpecial_Format: fn('AFSpecial_Format', (a) => {
      const e = host.event()
      const value = toStr(e.value ?? '')
      if (!value) return
      let mask: string
      switch (num(a, 0)) {
        case 0:
          mask = '99999'
          break
        case 1:
          mask = '99999-9999'
          break
        case 2:
          mask = printx('9999999999', value).length >= 10 ? '(999) 999-9999' : '999-9999'
          break
        case 3:
          mask = '999-99-9999'
          break
        default:
          return // arbitrary masks are enforced by the keystroke script; display as typed
      }
      e.value = printx(mask, value)
    }),
    AFSpecial_Keystroke: fn('AFSpecial_Keystroke', (a) => {
      const e = host.event()
      const value = mergeChange(e)
      if (!value) return
      let commit: RegExp | RegExp[]
      let noCommit: RegExp | RegExp[]
      switch (num(a, 0)) {
        case 0:
          commit = ZIP_COMMIT
          noCommit = ZIP_NO_COMMIT
          break
        case 1:
          commit = ZIP4_COMMIT
          noCommit = ZIP4_NO_COMMIT
          break
        case 2:
          commit = PHONE_COMMIT
          noCommit = PHONE_NO_COMMIT
          break
        case 3:
          commit = SSN_COMMIT
          noCommit = SSN_NO_COMMIT
          break
        default:
          return
      }
      if (!e.willCommit) {
        if (!exactMatch(noCommit, value)) e.rc = false
      } else if (!exactMatch(commit, value)) {
        host.alert(`${IDS_INVALID_VALUE} ${e.targetLabel()}`)
        e.rc = false
      }
    }),
    AFSpecial_KeystrokeEx: fn('AFSpecial_KeystrokeEx', (a) => specialKeystrokeEx(toStr(arg(a, 0) ?? ''))),

    AFRange_Validate: fn('AFRange_Validate', (a) => {
      const e = host.event()
      if (e.value === '' || e.value === undefined || e.value === null) return
      const v = makeNumber(e.value)
      if (v === null) return
      const gt = bool(a, 0)
      const lt = bool(a, 2)
      const nGt = num(a, 1)
      const nLt = num(a, 3)
      let err = ''
      if (gt && lt) {
        if (v < nGt || v > nLt) err = sprintf(IDS_GT_AND_LT, nGt, nLt)
      } else if (gt) {
        if (v < nGt) err = sprintf(IDS_GREATER_THAN, nGt)
      } else if (lt) {
        if (v > nLt) err = sprintf(IDS_LESS_THAN, nLt)
      }
      if (err) {
        host.alert(err)
        e.rc = false
      }
    }),

    AFSimple_Calculate: fn('AFSimple_Calculate', (a) => {
      const op = toStr(arg(a, 0)).toUpperCase()
      const values: number[] = []
      for (const name of fieldList(host, arg(a, 1))) {
        for (const v of host.fieldValues(name)) values.push(makeNumber(v) ?? 0)
      }
      const e = host.event()
      let res: number
      if (!values.length) res = 0
      else
        switch (op) {
          case 'SUM':
            res = values.reduce((x, y) => x + y, 0)
            break
          case 'PRD':
            res = values.reduce((x, y) => x * y, 1)
            break
          case 'AVG':
            res = values.reduce((x, y) => x + y, 0) / values.length
            break
          case 'MIN':
            res = Math.min(...values)
            break
          case 'MAX':
            res = Math.max(...values)
            break
          default:
            throw new Error(`AFSimple_Calculate: unknown function ${op}`)
        }
      e.value = Math.round(res * 1e6) / 1e6
    }),
    AFMakeArrayFromList: fn('AFMakeArrayFromList', (a) => fieldList(host, arg(a, 0))),

    // A few helpers that real forms call directly.
    AFParseDateEx: fn('AFParseDateEx', (a) => {
      const d = parseDate(toStr(arg(a, 1)), toStr(arg(a, 0)))
      return d ? new JsDate(d) : null
    })
  }
  return lib
}
