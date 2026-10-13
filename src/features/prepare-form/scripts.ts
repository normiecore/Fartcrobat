/**
 * Builds and reads the Acrobat JavaScript snippets that Acrobat itself writes for the Format,
 * Validate and Calculate tabs (the AF* functions). Pure functions: used by the engine and tested
 * directly.
 */
import type { CalcOp, CalculateSpec, FormatSpec, ValidateSpec } from './model'

function jsString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
}

function unJsString(s: string): string {
  return s.replace(/\\(.)/g, (_m, c: string) => (c === 'n' ? '\n' : c))
}

const int = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(Number.isFinite(n) ? n : 0)))

/** Format (F) and keystroke (K) scripts for a format spec. Empty strings mean "no script". */
export function formatScripts(f: FormatSpec): { format: string; keystroke: string } {
  switch (f.kind) {
    case 'none':
      return { format: '', keystroke: '' }
    case 'number': {
      const args = `${int(f.decimals, 0, 10)}, ${int(f.separator, 0, 4)}, ${int(f.negative, 0, 3)}, 0, ${jsString(f.currency)}, ${f.currencyPrepend ? 'true' : 'false'}`
      return { format: `AFNumber_Format(${args});`, keystroke: `AFNumber_Keystroke(${args});` }
    }
    case 'percent': {
      const args = `${int(f.decimals, 0, 10)}, ${int(f.separator, 0, 4)}`
      return { format: `AFPercent_Format(${args});`, keystroke: `AFPercent_Keystroke(${args});` }
    }
    case 'date':
      return {
        format: `AFDate_FormatEx(${jsString(f.pattern)});`,
        keystroke: `AFDate_KeystrokeEx(${jsString(f.pattern)});`
      }
    case 'time': {
      // Acrobat's AFTime_* functions are AFDate_* with a time pattern; writing AFDate_FormatEx keeps
      // the field within the AF* subset every viewer (and Fartcrobat's form filling) supports
      const pattern = jsString(TIME_PATTERNS[int(f.style, 0, 3)])
      return { format: `AFDate_FormatEx(${pattern});`, keystroke: `AFDate_KeystrokeEx(${pattern});` }
    }
    case 'special':
      return {
        format: `AFSpecial_Format(${int(f.style, 0, 3)});`,
        keystroke: `AFSpecial_Keystroke(${int(f.style, 0, 3)});`
      }
    case 'mask':
      return {
        format: `AFSpecial_KeystrokeEx(${jsString(f.mask)});`,
        keystroke: `AFSpecial_KeystrokeEx(${jsString(f.mask)});`
      }
    case 'custom':
      return { format: f.format, keystroke: f.keystroke }
  }
}

const STR = '"((?:[^"\\\\]|\\\\.)*)"'

/** Reads a format spec back from the F and K scripts of a field. */
export function parseFormat(format?: string, keystroke?: string): FormatSpec {
  const f = (format ?? '').trim()
  const k = (keystroke ?? '').trim()
  if (!f && !k) return { kind: 'none' }
  let m = new RegExp(
    `^AFNumber_Format\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*${STR}\\s*,\\s*(true|false)\\s*\\);?$`
  ).exec(f)
  if (m) {
    return {
      kind: 'number',
      decimals: +m[1],
      separator: +m[2],
      negative: +m[3],
      currency: unJsString(m[5]),
      currencyPrepend: m[6] === 'true'
    }
  }
  m = /^AFPercent_Format\(\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*\w+)?\s*\);?$/.exec(f)
  if (m) return { kind: 'percent', decimals: +m[1], separator: +m[2] }
  m = new RegExp(`^AFDate_FormatEx\\(\\s*${STR}\\s*\\);?$`).exec(f)
  if (m) {
    const pattern = unJsString(m[1])
    const time = TIME_PATTERNS.indexOf(pattern)
    return time >= 0 ? { kind: 'time', style: time } : { kind: 'date', pattern }
  }
  m = /^AFDate_Format\(\s*(\d+)\s*\);?$/.exec(f)
  if (m) return { kind: 'date', pattern: LEGACY_DATE[+m[1]] ?? 'm/d/yy' }
  m = /^AFTime_Format\(\s*(\d+)\s*\);?$/.exec(f)
  if (m) return { kind: 'time', style: +m[1] }
  m = new RegExp(`^AFTime_FormatEx\\(\\s*${STR}\\s*\\);?$`).exec(f)
  if (m) {
    const idx = TIME_PATTERNS.indexOf(unJsString(m[1]))
    if (idx >= 0) return { kind: 'time', style: idx }
  }
  m = /^AFSpecial_Format\(\s*(\d+)\s*\);?$/.exec(f)
  if (m) return { kind: 'special', style: +m[1] }
  m = new RegExp(`^AFSpecial_KeystrokeEx\\(\\s*${STR}\\s*\\);?$`).exec(f || k)
  if (m) return { kind: 'mask', mask: unJsString(m[1]) }
  return { kind: 'custom', format: format ?? '', keystroke: keystroke ?? '' }
}

/** AFDate_Format(n) indices used by old Acrobat versions. */
const LEGACY_DATE = [
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

export const TIME_PATTERNS = ['HH:MM', 'h:MM tt', 'HH:MM:ss', 'h:MM:ss tt']

function numArg(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '0'
  return String(n)
}

export function validateScript(v: ValidateSpec): string {
  switch (v.kind) {
    case 'none':
      return ''
    case 'range':
      if (v.min === null && v.max === null) return ''
      return `AFRange_Validate(${v.min !== null ? 'true' : 'false'}, ${numArg(v.min)}, ${v.max !== null ? 'true' : 'false'}, ${numArg(v.max)});`
    case 'custom':
      return v.script
  }
}

export function parseValidate(script?: string): ValidateSpec {
  const s = (script ?? '').trim()
  if (!s) return { kind: 'none' }
  const m =
    /^AFRange_Validate\(\s*(true|false)\s*,\s*([-+\d.eE]+)\s*,\s*(true|false)\s*,\s*([-+\d.eE]+)\s*\);?$/.exec(
      s
    )
  if (m) {
    return {
      kind: 'range',
      min: m[1] === 'true' ? parseFloat(m[2]) : null,
      max: m[3] === 'true' ? parseFloat(m[4]) : null
    }
  }
  return { kind: 'custom', script: script ?? '' }
}

// ---- calculations --------------------------------------------------------------------------

const OPS: CalcOp[] = ['SUM', 'PRD', 'AVG', 'MIN', 'MAX']

export function calculateScript(c: CalculateSpec): string {
  switch (c.kind) {
    case 'none':
      return ''
    case 'simple':
      if (!c.fields.length) return ''
      return `AFSimple_Calculate(${jsString(c.op)}, new Array (${c.fields.map(jsString).join(', ')}));`
    case 'notation': {
      if (!c.expr.trim()) return ''
      return `event.value = ${notationToJs(c.expr)};`
    }
    case 'custom':
      return c.script
  }
}

export function parseCalculate(script?: string): CalculateSpec {
  const s = (script ?? '').trim()
  if (!s) return { kind: 'none' }
  const m = new RegExp(
    `^AFSimple_Calculate\\(\\s*${STR}\\s*,\\s*new\\s+Array\\s*\\(([^)]*)\\)\\s*\\);?$`
  ).exec(s)
  if (m && OPS.includes(unJsString(m[1]) as CalcOp)) {
    const fields: string[] = []
    const re = new RegExp(STR, 'g')
    let a: RegExpExecArray | null
    while ((a = re.exec(m[2]))) fields.push(unJsString(a[1]))
    return { kind: 'simple', op: unJsString(m[1]) as CalcOp, fields }
  }
  const n = /^event\.value\s*=\s*([\s\S]*?);?\s*$/.exec(s)
  if (n) {
    const expr = jsToNotation(n[1])
    if (expr !== null) return { kind: 'notation', expr }
  }
  return { kind: 'custom', script: script ?? '' }
}

/** A token of the simplified field notation. */
type Token = { t: 'num'; v: string } | { t: 'name'; v: string } | { t: 'op'; v: string }

/**
 * Splits simplified field notation ("Text1 + Text2 * 0.5", names with spaces escaped with a
 * backslash as in Acrobat: "Unit\ price * Qty") into tokens. Throws on unbalanced parentheses.
 */
export function tokenizeNotation(expr: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < expr.length) {
    const c = expr[i]
    if (/\s/.test(c)) {
      i++
      continue
    }
    if ('+-*/()'.includes(c)) {
      out.push({ t: 'op', v: c })
      i++
      continue
    }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < expr.length && /[0-9.]/.test(expr[j])) j++
      // a number immediately followed by letters is a field name like "2ndLine"
      if (j < expr.length && !/[\s+\-*/()]/.test(expr[j])) {
        // fall through to name parsing
      } else {
        out.push({ t: 'num', v: expr.slice(i, j) })
        i = j
        continue
      }
    }
    let name = ''
    while (i < expr.length) {
      const ch = expr[i]
      if (ch === '\\' && i + 1 < expr.length) {
        name += expr[i + 1]
        i += 2
        continue
      }
      if (/[\s+\-*/()]/.test(ch)) break
      name += ch
      i++
    }
    out.push({ t: 'name', v: name })
  }
  let depth = 0
  for (const tk of out) {
    if (tk.v === '(' && tk.t === 'op') depth++
    if (tk.v === ')' && tk.t === 'op') depth--
    if (depth < 0) throw new Error('Unbalanced parentheses')
  }
  if (depth !== 0) throw new Error('Unbalanced parentheses')
  return out
}

/** Field names used in a simplified notation expression. */
export function notationFields(expr: string): string[] {
  try {
    return [
      ...new Set(
        tokenizeNotation(expr)
          .filter((t) => t.t === 'name')
          .map((t) => t.v)
      )
    ]
  } catch {
    return []
  }
}

/** Checks the expression; returns an error message or null. */
export function checkNotation(expr: string, knownFields?: string[]): string | null {
  let tokens: Token[]
  try {
    tokens = tokenizeNotation(expr)
  } catch (err) {
    return (err as Error).message
  }
  if (!tokens.length) return 'Enter an expression'
  // operand/operator alternation (unary minus allowed)
  let expectOperand = true
  for (const tk of tokens) {
    if (tk.t === 'op' && tk.v === '(') {
      if (!expectOperand) return 'Missing operator before “(”'
      continue
    }
    if (tk.t === 'op' && tk.v === ')') {
      if (expectOperand) return 'Missing value before “)”'
      continue
    }
    if (tk.t === 'op') {
      if (expectOperand) {
        if (tk.v === '-' || tk.v === '+') continue
        return `Missing value before “${tk.v}”`
      }
      expectOperand = true
      continue
    }
    if (!expectOperand) return `Missing operator before “${tk.v}”`
    if (tk.t === 'num' && !Number.isFinite(parseFloat(tk.v))) return `“${tk.v}” is not a number`
    if (tk.t === 'name' && knownFields && !knownFields.includes(tk.v))
      return `There is no field named “${tk.v}”`
    expectOperand = false
  }
  if (expectOperand) return 'The expression ends with an operator'
  return null
}

function jsSingle(s: string): string {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

/** Converts simplified field notation to the JavaScript expression Acrobat runs. */
export function notationToJs(expr: string): string {
  return tokenizeNotation(expr)
    .map((tk) => (tk.t === 'name' ? `getField(${jsSingle(tk.v)}).value` : tk.v))
    .join(' ')
    .replace(/\( /g, '(')
    .replace(/ \)/g, ')')
}

function escapeName(name: string): string {
  return name.replace(/([\\\s+\-*/()])/g, '\\$1')
}

/** Reverses notationToJs (returns null when the script is not a plain notation script). */
export function jsToNotation(js: string): string | null {
  const re = /getField\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*\)\.value/g
  const replaced = js.replace(
    re,
    (_m, a?: string, b?: string) => `\uE000${escapeName(unJsString(a ?? b ?? ''))}\uE001`
  )
  // what remains outside field references must be numbers, operators, parentheses and spaces
  const outside = replaced.replace(/\uE000[^\uE001]*\uE001/g, ' ')
  if (!/^[\s\d.+\-*/()]*$/.test(outside)) return null
  return replaced
    .replace(/\uE000([^\uE001]*)\uE001/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}
