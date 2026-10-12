/**
 * Acrobat's `util` object: printf, printd, printx and scand (date parsing), plus the number
 * formatting helpers the AForm functions are built on. Pure functions, no DOM.
 */

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'
]
export const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Thousands and decimal separators for Acrobat's separator styles 0–4. */
export const SEPARATORS: Record<number, [string, string]> = {
  0: [',', '.'],
  1: ['', '.'],
  2: ['.', ','],
  3: ['', ','],
  4: ['\u2019', '.']
}

/** Formats a number with a fixed number of decimals and a separator style. */
export function formatNumber(value: number, decimals: number, sepStyle: number): string {
  const [thousands, decimal] = SEPARATORS[sepStyle] ?? SEPARATORS[0]
  const d = Math.max(0, Math.min(20, Math.floor(decimals)))
  const neg = value < 0
  // toFixed handles rounding; add a tiny epsilon so 1.005 rounds like people expect.
  const abs = Math.abs(value)
  const fixed = (abs + (abs > 0 ? abs * Number.EPSILON * 4 : 0)).toFixed(d)
  let [intPart, frac = ''] = fixed.split('.')
  if (thousands) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousands)
  const out = frac ? `${intPart}${decimal}${frac}` : intPart
  return neg && /[1-9]/.test(out) ? `-${out}` : out
}

/** util.printf: %[,sepStyle][flags][width][.precision](d|f|s|x). */
export function printf(format: string, ...args: unknown[]): string {
  let argIndex = 0
  return format.replace(/%(,[0-4])?([+ 0#]+)?(\d+)?(\.\d+)?([a-zA-Z%])/g, (match, sep, flags = '', width, prec, conv) => {
    if (conv === '%') return '%'
    if (!'dfsx'.includes(conv)) return match
    const arg = args[argIndex++]
    if (conv === 's') return arg === undefined || arg === null ? '' : String(arg)
    const n = Number(arg)
    const w = width ? parseInt(width, 10) : 0
    const pad = (s: string) => {
      if (s.length >= w) return s
      if (flags.includes('0')) {
        const signChar = /^[-+ ]/.test(s) ? s[0] : ''
        return signChar + s.slice(signChar.length).padStart(w - signChar.length, '0')
      }
      return s.padStart(w, ' ')
    }
    if (!Number.isFinite(n)) return pad(String(n))
    if (conv === 'x') {
      let hex = Math.abs(Math.trunc(n)).toString(16).toUpperCase()
      if (flags.includes('#')) hex = '0x' + hex
      return pad(hex)
    }
    const sepStyle = sep ? parseInt(sep.slice(1), 10) : 1
    const decimals = conv === 'd' ? 0 : prec ? parseInt(prec.slice(1), 10) : 6
    let s = formatNumber(conv === 'd' ? Math.trunc(n) : n, decimals, sepStyle)
    if (conv === 'f' && decimals === 0 && flags.includes('#')) s += SEPARATORS[sepStyle][1]
    if (!s.startsWith('-')) {
      if (flags.includes('+')) s = '+' + s
      else if (flags.includes(' ')) s = ' ' + s
    }
    return pad(s)
  })
}

/** util.printx: formats a string against a mask (? X A 9 * \ > < =). */
export function printx(format: string, source: unknown): string {
  const src = source === undefined || source === null ? '' : String(source)
  const out: string[] = []
  let i = 0
  let caseFn = (c: string) => c
  let escaped = false
  const isAlpha = (c: string) => /[A-Za-z]/.test(c)
  const isDigit = (c: string) => /[0-9]/.test(c)
  for (const cmd of format) {
    if (escaped) {
      out.push(cmd)
      escaped = false
      continue
    }
    if (i >= src.length && !['\\', '>', '<', '='].includes(cmd)) {
      // Literal characters are only written while there is source left to format.
      break
    }
    switch (cmd) {
      case '?':
        out.push(caseFn(src[i++]))
        break
      case 'X':
        while (i < src.length) {
          const c = src[i++]
          if (isAlpha(c) || isDigit(c)) {
            out.push(caseFn(c))
            break
          }
        }
        break
      case 'A':
        while (i < src.length) {
          const c = src[i++]
          if (isAlpha(c)) {
            out.push(caseFn(c))
            break
          }
        }
        break
      case '9':
        while (i < src.length) {
          const c = src[i++]
          if (isDigit(c)) {
            out.push(c)
            break
          }
        }
        break
      case '*':
        while (i < src.length) out.push(caseFn(src[i++]))
        break
      case '\\':
        escaped = true
        break
      case '>':
        caseFn = (c) => c.toUpperCase()
        break
      case '<':
        caseFn = (c) => c.toLowerCase()
        break
      case '=':
        caseFn = (c) => c
        break
      default:
        out.push(cmd)
    }
  }
  return out.join('')
}

// ---- dates --------------------------------------------------------------------------------

const DATE_TOKENS = ['mmmm', 'mmm', 'mm', 'm', 'dddd', 'ddd', 'dd', 'd', 'yyyy', 'yy', 'HH', 'H', 'hh', 'h', 'MM', 'M', 'ss', 's', 'tt', 't']

type DatePart = { token: string } | { literal: string }

export function tokenizeDateFormat(format: string): DatePart[] {
  const parts: DatePart[] = []
  let i = 0
  while (i < format.length) {
    if (format[i] === '\\' && i + 1 < format.length) {
      parts.push({ literal: format[i + 1] })
      i += 2
      continue
    }
    const tok = DATE_TOKENS.find((t) => format.startsWith(t, i))
    if (tok) {
      parts.push({ token: tok })
      i += tok.length
    } else {
      parts.push({ literal: format[i] })
      i++
    }
  }
  return parts
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** util.printd: formats a date. Format numbers 0–2 are Acrobat's fixed formats. */
export function printd(format: string | number, date: Date): string {
  if (typeof format === 'number') {
    const y = date.getFullYear()
    const parts = [y, pad2(date.getMonth() + 1), pad2(date.getDate()), pad2(date.getHours()), pad2(date.getMinutes()), pad2(date.getSeconds())]
    if (format === 0) return `D:${parts.join('')}`
    if (format === 1) return `${parts[0]}.${parts[1]}.${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`
    return `${parts[0]}/${parts[1]}/${parts[2]} ${parts[3]}:${parts[4]}:${parts[5]}`
  }
  const h = date.getHours()
  const h12 = h % 12 === 0 ? 12 : h % 12
  return tokenizeDateFormat(format)
    .map((p) => {
      if ('literal' in p) return p.literal
      switch (p.token) {
        case 'mmmm':
          return MONTHS[date.getMonth()]
        case 'mmm':
          return MONTHS[date.getMonth()].slice(0, 3)
        case 'mm':
          return pad2(date.getMonth() + 1)
        case 'm':
          return String(date.getMonth() + 1)
        case 'dddd':
          return DAYS[date.getDay()]
        case 'ddd':
          return DAYS[date.getDay()].slice(0, 3)
        case 'dd':
          return pad2(date.getDate())
        case 'd':
          return String(date.getDate())
        case 'yyyy':
          return String(date.getFullYear()).padStart(4, '0')
        case 'yy':
          return pad2(date.getFullYear() % 100)
        case 'HH':
          return pad2(h)
        case 'H':
          return String(h)
        case 'hh':
          return pad2(h12)
        case 'h':
          return String(h12)
        case 'MM':
          return pad2(date.getMinutes())
        case 'M':
          return String(date.getMinutes())
        case 'ss':
          return pad2(date.getSeconds())
        case 's':
          return String(date.getSeconds())
        case 'tt':
          return h < 12 ? 'am' : 'pm'
        case 't':
          return h < 12 ? 'a' : 'p'
      }
      return ''
    })
    .join('')
}

interface DateFields {
  y?: number
  m?: number
  d?: number
  H?: number
  M?: number
  s?: number
  pm?: boolean
  h12?: boolean
}

function monthFromName(word: string): number | null {
  const w = word.toLowerCase()
  if (w.length < 3) return null
  const i = MONTHS.findIndex((m) => m.toLowerCase().startsWith(w) || w.startsWith(m.toLowerCase().slice(0, 3)))
  return i >= 0 ? i + 1 : null
}

function expandYear(y: number, digits: number): number {
  if (digits <= 2) return y < 50 ? 2000 + y : 1900 + y
  return y
}

function buildDate(f: DateFields, now = new Date()): Date | null {
  let H = f.H ?? 0
  if (f.h12) {
    if (H < 1 || H > 12) return null
    if (f.pm && H < 12) H += 12
    if (!f.pm && H === 12) H = 0
  } else if (f.pm !== undefined) {
    if (f.pm && H < 12) H += 12
    else if (!f.pm && H === 12) H = 0
  }
  const hasDate = f.y !== undefined || f.m !== undefined || f.d !== undefined
  const y = f.y ?? now.getFullYear()
  const m = f.m ?? (hasDate ? 1 : now.getMonth() + 1)
  const d = f.d ?? (hasDate ? 1 : now.getDate())
  const M = f.M ?? 0
  const s = f.s ?? 0
  if (m < 1 || m > 12 || d < 1 || d > 31 || H < 0 || H > 23 || M < 0 || M > 59 || s < 0 || s > 59) return null
  const date = new Date(y, m - 1, d, H, M, s)
  if (y < 100) date.setFullYear(y)
  if (date.getMonth() !== m - 1 || date.getDate() !== d) return null // e.g. February 30
  return date
}

/** util.scand: parses a date written in the given format. Lenient about separators. */
export function scand(format: string, input: string, now = new Date()): Date | null {
  const text = String(input ?? '').trim()
  if (!text) return null
  const parts = tokenizeDateFormat(format)
  const f: DateFields = {}
  let i = 0
  const skipSpaces = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  const readDigits = (min: number, max: number): [number, number] | null => {
    skipSpaces()
    let j = i
    while (j < text.length && j - i < max && /\d/.test(text[j])) j++
    if (j - i < min) return null
    const v = parseInt(text.slice(i, j), 10)
    const len = j - i
    i = j
    return [v, len]
  }
  const readWord = (): string => {
    skipSpaces()
    let j = i
    while (j < text.length && /[A-Za-z\u00c0-\uffff]/.test(text[j])) j++
    const w = text.slice(i, j)
    i = j
    return w
  }
  for (const p of parts) {
    if ('literal' in p) {
      if (/\s/.test(p.literal)) {
        skipSpaces()
        continue
      }
      skipSpaces()
      if (text[i] === p.literal) i++
      else if (i < text.length && /[^A-Za-z0-9\s]/.test(text[i])) i++ // a different separator
      continue
    }
    switch (p.token) {
      case 'yyyy':
      case 'yy': {
        const r = readDigits(2, 4)
        if (!r) return null
        f.y = expandYear(r[0], r[1])
        break
      }
      case 'mm':
      case 'm': {
        const r = readDigits(1, 2)
        if (!r) return null
        f.m = r[0]
        break
      }
      case 'mmm':
      case 'mmmm': {
        const w = readWord()
        const m = monthFromName(w)
        if (!m) return null
        f.m = m
        break
      }
      case 'dd':
      case 'd': {
        const r = readDigits(1, 2)
        if (!r) return null
        f.d = r[0]
        break
      }
      case 'ddd':
      case 'dddd':
        readWord()
        break
      case 'HH':
      case 'H': {
        const r = readDigits(1, 2)
        if (!r) return null
        f.H = r[0]
        break
      }
      case 'hh':
      case 'h': {
        const r = readDigits(1, 2)
        if (!r) return null
        f.H = r[0]
        f.h12 = true
        break
      }
      case 'MM':
      case 'M': {
        const r = readDigits(1, 2)
        if (!r) return null
        f.M = r[0]
        break
      }
      case 'ss':
      case 's': {
        const r = readDigits(1, 2)
        if (!r) return null
        f.s = r[0]
        break
      }
      case 'tt':
      case 't': {
        const w = readWord().toLowerCase()
        if (w.startsWith('p')) f.pm = true
        else if (w.startsWith('a')) f.pm = false
        else if (w) return null
        else f.pm = false
        break
      }
    }
  }
  skipSpaces()
  // Allow a trailing am/pm even when the format has none.
  if (i < text.length) {
    const rest = text.slice(i).trim().toLowerCase()
    if (/^(a|p)\.?m?\.?$/.test(rest) && f.H !== undefined) {
      f.pm = rest.startsWith('p')
      i = text.length
    }
  }
  if (i < text.length) return null
  return buildDate(f, now)
}

/**
 * Lenient date parsing used when the strict format does not match (Acrobat accepts "3/4/24",
 * "March 4 2024", "2024-03-04" for an "mm/dd/yyyy" field): numbers are assigned in the order the
 * format lists day, month and year.
 */
export function guessDate(format: string, input: string, now = new Date()): Date | null {
  const text = String(input ?? '').trim()
  if (!text) return null
  const tokens = text.match(/\d+|[A-Za-z]+/g) ?? []
  if (!tokens.length) return null
  // ISO dates are unambiguous.
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text)
  if (iso) {
    return buildDate({ y: +iso[1], m: +iso[2], d: +iso[3], H: iso[4] ? +iso[4] : undefined, M: iso[5] ? +iso[5] : undefined, s: iso[6] ? +iso[6] : undefined }, now)
  }
  const order: ('d' | 'm' | 'y' | 'H' | 'M' | 's')[] = []
  for (const p of tokenizeDateFormat(format)) {
    if (!('token' in p)) continue
    const c = p.token[0]
    const key = c === 'h' ? 'H' : c
    if (['d', 'm', 'y', 'H', 'M', 's'].includes(key) && !(p.token.startsWith('ddd'))) {
      if (!order.includes(key as 'd')) order.push(key as 'd')
    }
  }
  const f: DateFields = {}
  const numbers: [number, number][] = []
  for (const t of tokens) {
    if (/^\d+$/.test(t)) numbers.push([parseInt(t, 10), t.length])
    else {
      const low = t.toLowerCase()
      const m = monthFromName(t)
      if (m) f.m = m
      else if (/^(am|pm|a|p)$/.test(low)) f.pm = low.startsWith('p')
      else if (!DAYS.some((d) => d.toLowerCase().startsWith(low.slice(0, 3)))) return null
    }
  }
  const slots = order.filter((k) => !(k === 'm' && f.m !== undefined))
  // A four-digit number is always the year.
  const yearIdx = numbers.findIndex(([, len]) => len === 4)
  if (yearIdx >= 0 && slots.includes('y')) {
    f.y = numbers[yearIdx][0]
    numbers.splice(yearIdx, 1)
    slots.splice(slots.indexOf('y'), 1)
  }
  if (numbers.length > slots.length) return null
  numbers.forEach(([v, len], k) => {
    const key = slots[k]
    if (key === 'y') f.y = expandYear(v, len)
    else f[key] = v
  })
  if (order.includes('y') && f.y === undefined && (f.d === undefined || f.m === undefined)) return null
  return buildDate(f, now)
}
