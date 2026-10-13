/**
 * Reads numbers the way they are printed ("1,250", "$12,500.00", "(3.4%)", "1.234,50 €") so a
 * spreadsheet gets real numbers with a matching number format.
 */

export interface ParsedNumber {
  value: number
  /** Excel number format reproducing how the number was printed. */
  numFmt: string
}

const CURRENCY = /^[$€£¥₹₩₽¢]|[$€£¥₹₩₽¢]$/

export function parseNumber(input: string): ParsedNumber | null {
  let t = input.replace(/[\u00a0\u2009\u202f]/g, ' ').trim()
  if (!t || t.length > 32) return null
  let negative = false
  let parens = false
  if (/^\(.*\)$/.test(t)) {
    parens = true
    negative = true
    t = t.slice(1, -1).trim()
  }
  if (/^[-−–]/.test(t)) {
    negative = !negative
    t = t.slice(1).trim()
  } else if (/[-−]$/.test(t)) {
    negative = !negative
    t = t.slice(0, -1).trim()
  }
  let currency = ''
  let currencyAfter = false
  const cm = CURRENCY.exec(t)
  if (cm) {
    currency = cm[0]
    currencyAfter = cm.index > 0
    t = (currencyAfter ? t.slice(0, -1) : t.slice(1)).trim()
    if (/^[-−]/.test(t)) {
      negative = !negative
      t = t.slice(1).trim()
    }
  }
  let percent = false
  if (t.endsWith('%')) {
    percent = true
    t = t.slice(0, -1).trim()
  }
  if (!t || !/^[0-9]/.test(t)) return null
  let digits: string
  let thousands = false
  let decimals = 0
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) {
    // 1,234,567.89
    thousands = true
    digits = t.replace(/,/g, '')
  } else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t) && (t.includes(',') || (t.match(/\./g) ?? []).length > 1)) {
    // 1.234.567,89
    thousands = true
    digits = t.replace(/\./g, '').replace(',', '.')
  } else if (/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(t)) {
    // 1 234 567,89
    thousands = true
    digits = t.replace(/ /g, '').replace(',', '.')
  } else if (/^\d+\.\d+$/.test(t) || /^\d+$/.test(t)) {
    digits = t
  } else if (/^\d+,\d{1,2}$/.test(t)) {
    // 12,5 (decimal comma)
    digits = t.replace(',', '.')
  } else return null
  const intPart = digits.split('.')[0]
  // Codes with leading zeros ("007", "01234") and long identifiers stay text.
  if ((intPart.length > 1 && intPart.startsWith('0')) || intPart.replace(/^0+/, '').length > 15) return null
  decimals = digits.includes('.') ? digits.split('.')[1].length : 0
  let value = parseFloat(digits)
  if (!Number.isFinite(value)) return null
  if (negative) value = -value
  if (percent) value = value / 100
  const body = (thousands ? '#,##0' : '0') + (decimals ? '.' + '0'.repeat(Math.min(decimals, 10)) : '')
  let fmt = percent ? body + '%' : body
  if (currency) fmt = currencyAfter ? `${fmt}" ${currency}"` : `"${currency}"${fmt}`
  if (parens) fmt = `${fmt};(${fmt})`
  return { value, numFmt: fmt }
}
