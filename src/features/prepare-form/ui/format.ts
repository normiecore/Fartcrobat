/** Example values shown in the Format tab (plain implementations of what AFNumber_Format etc. do). */
import type { FormatSpec } from '../model'

export const SEPARATORS = ['1,234.56', '1234.56', '1.234,56', '1234,56', "1'234.56"]
export const NEGATIVE_STYLES = ['-1,234.01', '-1,234.01 in red', '(1,234.01)', '(1,234.01) in red']
export const TIME_STYLES = ['HH:MM (13:45)', 'h:MM tt (1:45 PM)', 'HH:MM:ss (13:45:30)', 'h:MM:ss tt (1:45:30 PM)']
export const SPECIAL_STYLES = ['Zip Code', 'Zip Code + 4', 'Phone Number', 'Social Security Number']
const SPECIAL_EXAMPLES = ['12345', '12345-6789', '(555) 123-4567', '123-45-6789']

export function formatNumber(n: number, decimals: number, separator: number): string {
  const fixed = Math.abs(n).toFixed(Math.max(0, Math.min(10, decimals)))
  const [int, frac] = fixed.split('.')
  const group = [',', '', '.', '', "'"][separator] ?? ','
  const point = separator === 2 || separator === 3 ? ',' : '.'
  const grouped = group ? int.replace(/\B(?=(\d{3})+(?!\d))/g, group) : int
  return frac ? `${grouped}${point}${frac}` : grouped
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Formats a date with an Acrobat date pattern (d, dd, ddd, dddd, m, mm, mmm, mmmm, yy, yyyy, H, HH, h, hh, M, MM, s, ss, tt). */
export function formatDate(d: Date, pattern: string): string {
  const pad = (v: number) => String(v).padStart(2, '0')
  const tokens: Record<string, () => string> = {
    dddd: () => DAYS[d.getDay()],
    ddd: () => DAYS[d.getDay()].slice(0, 3),
    dd: () => pad(d.getDate()),
    d: () => String(d.getDate()),
    mmmm: () => MONTHS[d.getMonth()],
    mmm: () => MONTHS[d.getMonth()].slice(0, 3),
    mm: () => pad(d.getMonth() + 1),
    m: () => String(d.getMonth() + 1),
    yyyy: () => String(d.getFullYear()),
    yy: () => pad(d.getFullYear() % 100),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    hh: () => pad(d.getHours() % 12 || 12),
    h: () => String(d.getHours() % 12 || 12),
    MM: () => pad(d.getMinutes()),
    M: () => String(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    s: () => String(d.getSeconds()),
    tt: () => (d.getHours() < 12 ? 'am' : 'pm'),
    t: () => (d.getHours() < 12 ? 'a' : 'p')
  }
  const re = /dddd|ddd|dd|d|mmmm|mmm|mm|m|yyyy|yy|HH|H|hh|h|MM|M|ss|s|tt|t/g
  return pattern.replace(re, (tok) => tokens[tok]())
}

export function formatExample(f: FormatSpec): string {
  switch (f.kind) {
    case 'number': {
      const n = f.negative > 0 ? -1234.56 : 1234.56
      let body = formatNumber(n, f.decimals, f.separator)
      if (f.currency) body = f.currencyPrepend ? `${f.currency}${body}` : `${body}${f.currency}`
      if (n < 0) body = f.negative >= 2 ? `(${body})` : `-${body}`
      return f.negative === 1 || f.negative === 3 ? `${body} (shown in red)` : body
    }
    case 'percent':
      return `${formatNumber(12.345, f.decimals, f.separator)}%  (for 0.12345)`
    case 'date':
      return formatDate(new Date(), f.pattern)
    case 'time':
      return TIME_STYLES[f.style]?.replace(/^.*\((.*)\)$/, '$1') ?? ''
    case 'special':
      return SPECIAL_EXAMPLES[f.style] ?? ''
    case 'mask':
      return f.mask.replace(/9/g, '1').replace(/A/g, 'a').replace(/[XO*]/g, 'x')
    default:
      return ''
  }
}
