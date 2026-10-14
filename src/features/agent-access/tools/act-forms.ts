// set_form_values: finds fields by name and turns the agent's values into what the form stores
// (export values for check boxes, radio buttons and choices). Pure, Node-testable.
import type { FieldInfo, FieldType } from '@engine/ops/forms'
import type { FillChange } from '@features/forms-fill/engine'
import type { FieldChange, FormRuntime } from '@features/forms-fill/js/runtime'
import { InvalidArgs, isObject } from './act-common'

/** One field (all its widgets) as set_form_values sees it. */
export interface FormField {
  name: string
  type: FieldType
  readOnly: boolean
  /** Choice fields: labels and export values. */
  options: { label: string; value: string }[]
  /** Check boxes and radio buttons: the "on" state of each widget (export values). */
  onStates: string[]
  multiSelect: boolean
  /** Combo boxes that accept any text. */
  editable: boolean
  /** First widget (id, page). */
  widget: FieldInfo
}

/** Groups widgets by field name. */
export function formFields(widgets: FieldInfo[]): Map<string, FormField> {
  const out = new Map<string, FormField>()
  for (const w of widgets) {
    let f = out.get(w.name)
    if (!f) {
      f = {
        name: w.name,
        type: w.type,
        readOnly: w.readOnly,
        options: w.options,
        onStates: [],
        multiSelect: w.multiSelect,
        editable: w.editable,
        widget: w
      }
      out.set(w.name, f)
    }
    if (w.readOnly) f.readOnly = true
    // Like MuPDF, a button without appearance states is on in state "Yes".
    if (w.type === 'checkbox' || w.type === 'radio') {
      const on = w.onState ?? 'Yes'
      if (!f.onStates.includes(on)) f.onStates.push(on)
    }
  }
  return out
}

/** The value as the form stores it: text, an export value or "Off", or a list for list boxes. */
export type NormalizedValue = string | string[]

const OFF = /^(off|false|no|0|unchecked|)$/i
const ON = /^(on|true|yes|1|x|checked)$/i

function quoteList(values: string[]): string {
  return values.map((v) => `"${v}"`).join(', ')
}

function choice(field: FormField, value: string): string | null {
  const exact = field.options.find((o) => o.value === value) ?? field.options.find((o) => o.label === value)
  if (exact) return exact.value
  const lower = value.toLowerCase()
  const loose = field.options.find((o) => o.value.toLowerCase() === lower) ?? field.options.find((o) => o.label.toLowerCase() === lower)
  return loose ? loose.value : null
}

/** Converts one set_form_values value for its field. Throws InvalidArgs with what the field accepts. */
export function normalizeValue(field: FormField, value: unknown): NormalizedValue {
  const name = `"${field.name}"`
  switch (field.type) {
    case 'text': {
      if (typeof value !== 'string') throw new InvalidArgs(`${name} is a text field: give its value as a string`)
      // Refused rather than cut, as typing in Fartcrobat stops at the limit: a cut date or number would be wrong.
      const max = field.widget.maxLen
      if (max > 0 && value.length > max)
        throw new InvalidArgs(`${name} takes at most ${max} characters${field.widget.comb ? ', one per box' : ''} (got ${value.length})`)
      return value
    }
    case 'checkbox': {
      // Check boxes that share a name but have different export values work like radio buttons.
      const group = field.onStates.length > 1
      const pick = () => {
        if (group) throw new InvalidArgs(`${name} is a group of check boxes: give the value of the box to tick, one of ${quoteList(field.onStates)}, or false`)
        return field.onStates[0]
      }
      if (typeof value === 'boolean') return value ? pick() : 'Off'
      if (typeof value !== 'string') throw new InvalidArgs(`${name} is a check box: give true or false`)
      if (field.onStates.includes(value)) return value
      const loose = field.onStates.find((s) => s.toLowerCase() === value.toLowerCase())
      if (loose) return loose
      if (OFF.test(value.trim())) return 'Off'
      if (ON.test(value.trim())) return pick()
      throw new InvalidArgs(`${name} is a check box: give true or false${group ? `, or one of ${quoteList(field.onStates)}` : ''}`)
    }
    case 'radio': {
      if (value === false) return 'Off'
      if (typeof value !== 'string') throw new InvalidArgs(`${name} is a group of radio buttons: give one of ${quoteList(field.onStates)}`)
      if (field.onStates.includes(value)) return value
      const loose = field.onStates.find((s) => s.toLowerCase() === value.toLowerCase())
      if (loose) return loose
      if (value === 'Off' || value === '') return 'Off'
      throw new InvalidArgs(`${name} has no option "${value}": give one of ${quoteList(field.onStates)}`)
    }
    case 'combo':
    case 'list': {
      if (typeof value !== 'string') throw new InvalidArgs(`${name} is a ${field.type === 'combo' ? 'drop-down list' : 'list box'}: give an option as a string`)
      if (field.type === 'list' && value === '') return []
      const v = choice(field, value)
      if (v !== null) return field.type === 'list' ? [v] : v
      if (field.type === 'combo' && field.editable) return value
      const shown = field.options.slice(0, 30).map((o) => (o.label === o.value ? o.value : `${o.value} (${o.label})`))
      throw new InvalidArgs(`${name} has no option "${value}": give one of ${quoteList(shown)}${field.options.length > 30 ? ', ...' : ''}`)
    }
    case 'signature':
      throw new InvalidArgs(`${name} is a signature field: sign it with sign_document`)
    default:
      throw new InvalidArgs(`${name} is a ${field.type === 'button' ? 'button' : 'field'} that cannot be filled`)
  }
}

function distance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  if (!m || !n) return m + n
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}

/** Field names that look like `name` (typos, other case, the last part of a dotted name). */
export function closeNames(name: string, names: string[], max = 5): string[] {
  const lower = name.toLowerCase()
  const last = (s: string) => s.split('.').pop()!.toLowerCase()
  const scored = names.map((n) => {
    const l = n.toLowerCase()
    let score = distance(lower, l)
    if (l === lower) score = 0
    else if (last(n) === last(name) || l.includes(lower) || lower.includes(l)) score = Math.min(score, 1)
    return { n, score }
  })
  const limit = Math.max(2, Math.floor(name.length / 3))
  return scored
    .filter((s) => s.score <= limit)
    .sort((a, b) => a.score - b.score || a.n.localeCompare(b.n))
    .slice(0, max)
    .map((s) => s.n)
}

export interface ValueEntry {
  field: FormField
  value: NormalizedValue
}

/**
 * Checks every entry of set_form_values before anything is written: unknown names (with close
 * matches), read-only and signature fields, and values the field cannot take. Later entries for
 * the same field win.
 */
export function resolveValues(values: unknown, fields: Map<string, FormField>): ValueEntry[] {
  if (!Array.isArray(values) || !values.length) throw new InvalidArgs('values must be a list of { name, value }')
  if (!fields.size) throw new InvalidArgs('This document has no form fields')
  const out = new Map<string, ValueEntry>()
  const unknown: string[] = []
  values.forEach((entry, i) => {
    if (!isObject(entry) || typeof entry.name !== 'string' || !('value' in entry)) throw new InvalidArgs(`values[${i}] must be { name, value }`)
    const field = fields.get(entry.name)
    if (!field) {
      unknown.push(entry.name)
      return
    }
    if (field.type === 'signature') throw new InvalidArgs(`"${field.name}" is a signature field: sign it with sign_document`)
    if (field.readOnly) throw new InvalidArgs(`"${field.name}" is read-only`)
    out.set(field.name, { field, value: normalizeValue(field, entry.value) })
  })
  if (unknown.length) {
    const names = [...fields.keys()]
    const hints = unknown.map((u) => {
      const close = closeNames(u, names)
      return close.length ? `"${u}" (did you mean ${close.map((c) => `"${c}"`).join(', ')}?)` : `"${u}"`
    })
    throw new InvalidArgs(`No field named ${hints.join(', ')}. Call list_form_fields for the names.`)
  }
  return [...out.values()]
}

export interface FillPlan {
  /** What to write in one fill step (forms-fill `fill` op). */
  changes: FillChange[]
  /** Messages the form's scripts showed (app.alert), in order. */
  messages: string[]
  /** Puts the runtime's values back (when writing the plan fails). */
  restore(): void
}

function toFill(c: FieldChange): FillChange {
  return {
    name: c.name,
    value: c.value,
    display: c.display !== undefined && c.display !== c.value ? c.display : undefined,
    textColor: c.textColor,
    visibility: c.visibility,
    readOnly: c.readOnly,
    required: c.required
  }
}

/** One change per field (later ones win, fields given only once keep their place). */
function merge(changes: FillChange[]): FillChange[] {
  const out = new Map<string, FillChange>()
  for (const c of changes) {
    const defined = Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined))
    out.set(c.name, { ...out.get(c.name), ...defined } as FillChange)
  }
  return [...out.values()]
}

/**
 * Runs the form's own scripts for the new values as if the person typed them one after the other
 * (keystroke and validation checks, then formatting; calculations once at the end), like the
 * forms-fill FormController does for each edit. Throws InvalidArgs, leaving the runtime as it
 * was, when the form rejects a value.
 */
export function planFill(rt: FormRuntime, entries: ValueEntry[], opts: { calculate: boolean }): FillPlan {
  const saved = new Map(rt.fieldNames().map((n) => [n, rt.value(n)] as const))
  const restore = () => {
    for (const [n, v] of saved) rt.setValue(n, v)
  }
  const changes: FillChange[] = []
  const messages: string[] = []
  try {
    for (const { field, value } of entries) {
      const name = field.name
      if (typeof value === 'string' && (field.type === 'text' || field.type === 'combo')) {
        const c = rt.commit(name, value)
        if (!c.rc) {
          const why = c.alerts.length ? c.alerts.join(' ') : 'The value does not match the format of the field.'
          throw new InvalidArgs(`The form rejected the value for "${name}": ${why}`)
        }
        rt.setValue(name, c.value)
        const fmt = rt.format(name, c.value)
        // Password fields show asterisks, as when typed.
        const display = field.widget.password ? '*'.repeat(Math.min(c.value.length, 64)) : fmt.display !== c.value ? fmt.display : undefined
        changes.push({ name, value: c.value, display, textColor: fmt.textColor })
        messages.push(...c.alerts, ...fmt.alerts)
      } else {
        rt.setValue(name, value)
        // The widget id picks the right button of check boxes that share a name.
        changes.push({ id: field.type === 'checkbox' || field.type === 'radio' ? field.widget.id : undefined, name, value })
      }
    }
    if (opts.calculate && rt.hasCalculations()) {
      const r = rt.calculate()
      changes.push(...r.changes.map(toFill))
      messages.push(...r.alerts)
    }
  } catch (err) {
    restore()
    throw err
  }
  return { changes: merge(changes), messages, restore }
}
