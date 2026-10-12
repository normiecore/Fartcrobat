import { describe, expect, it } from 'vitest'
import type { CalculateSpec, FormatSpec, ValidateSpec } from '@features/prepare-form/model'
import {
  calculateScript,
  checkNotation,
  formatScripts,
  jsToNotation,
  notationFields,
  notationToJs,
  parseCalculate,
  parseFormat,
  parseValidate,
  tokenizeNotation,
  validateScript
} from '@features/prepare-form/scripts'
import { formatDate, formatExample, formatNumber } from '@features/prepare-form/ui/format'

describe('prepare-form: Acrobat format scripts', () => {
  const cases: [FormatSpec, string, string][] = [
    [{ kind: 'number', decimals: 2, separator: 0, negative: 2, currency: '€', currencyPrepend: false }, 'AFNumber_Format(2, 0, 2, 0, "€", false);', 'AFNumber_Keystroke(2, 0, 2, 0, "€", false);'],
    [{ kind: 'percent', decimals: 0, separator: 1 }, 'AFPercent_Format(0, 1);', 'AFPercent_Keystroke(0, 1);'],
    [{ kind: 'date', pattern: 'yyyy-mm-dd' }, 'AFDate_FormatEx("yyyy-mm-dd");', 'AFDate_KeystrokeEx("yyyy-mm-dd");'],
    [{ kind: 'time', style: 3 }, 'AFTime_Format(3);', 'AFTime_Keystroke(3);'],
    [{ kind: 'special', style: 0 }, 'AFSpecial_Format(0);', 'AFSpecial_Keystroke(0);'],
    [{ kind: 'mask', mask: 'AA-9999' }, 'AFSpecial_KeystrokeEx("AA-9999");', 'AFSpecial_KeystrokeEx("AA-9999");']
  ]
  it.each(cases)('writes and reads back %j', (spec, format, keystroke) => {
    const sc = formatScripts(spec)
    expect(sc).toEqual({ format, keystroke })
    expect(parseFormat(sc.format, sc.keystroke)).toEqual(spec)
  })

  it('handles none, custom and legacy scripts', () => {
    expect(formatScripts({ kind: 'none' })).toEqual({ format: '', keystroke: '' })
    expect(parseFormat('', '')).toEqual({ kind: 'none' })
    expect(parseFormat('event.value = "x";', '')).toEqual({ kind: 'custom', format: 'event.value = "x";', keystroke: '' })
    expect(parseFormat('AFDate_Format(2);', 'AFDate_Keystroke(2);')).toEqual({ kind: 'date', pattern: 'mm/dd/yy' })
    expect(parseFormat('AFTime_FormatEx("h:MM tt");', '')).toEqual({ kind: 'time', style: 1 })
    expect(parseFormat('AFPercent_Format(2, 0, false);', '')).toEqual({ kind: 'percent', decimals: 2, separator: 0 })
    // quotes in currency symbols survive
    const spec: FormatSpec = { kind: 'number', decimals: 0, separator: 0, negative: 0, currency: 'a"b\\', currencyPrepend: true }
    const sc = formatScripts(spec)
    expect(parseFormat(sc.format, sc.keystroke)).toEqual(spec)
  })

  it('writes range validation', () => {
    const cases: [ValidateSpec, string][] = [
      [{ kind: 'range', min: 1, max: 10 }, 'AFRange_Validate(true, 1, true, 10);'],
      [{ kind: 'range', min: -5.5, max: null }, 'AFRange_Validate(true, -5.5, false, 0);'],
      [{ kind: 'range', min: null, max: 100 }, 'AFRange_Validate(false, 0, true, 100);']
    ]
    for (const [spec, js] of cases) {
      expect(validateScript(spec)).toBe(js)
      expect(parseValidate(js)).toEqual(spec)
    }
    expect(validateScript({ kind: 'range', min: null, max: null })).toBe('')
    expect(validateScript({ kind: 'none' })).toBe('')
    expect(parseValidate('if (event.value < 0) event.rc = false;')).toEqual({ kind: 'custom', script: 'if (event.value < 0) event.rc = false;' })
  })
})

describe('prepare-form: calculations', () => {
  it('writes AFSimple_Calculate for picked fields', () => {
    const spec: CalculateSpec = { kind: 'simple', op: 'PRD', fields: ['qty', 'unit "price"'] }
    const js = calculateScript(spec)
    expect(js).toBe('AFSimple_Calculate("PRD", new Array ("qty", "unit \\"price\\""));')
    expect(parseCalculate(js)).toEqual(spec)
    for (const op of ['SUM', 'AVG', 'MIN', 'MAX'] as const) {
      expect(parseCalculate(calculateScript({ kind: 'simple', op, fields: ['a'] }))).toEqual({ kind: 'simple', op, fields: ['a'] })
    }
    expect(calculateScript({ kind: 'simple', op: 'SUM', fields: [] })).toBe('')
  })

  it('converts simplified field notation to event.value scripts and back', () => {
    expect(notationToJs('price * qty + shipping')).toBe("getField('price').value * getField('qty').value + getField('shipping').value")
    expect(notationToJs('(a + b) / 2')).toBe("(getField('a').value + getField('b').value) / 2")
    expect(notationToJs('Unit\\ price * Qty')).toBe("getField('Unit price').value * getField('Qty').value")
    expect(notationToJs("O'Brien.total - 1")).toBe("getField('O\\'Brien.total').value - 1")
    const spec: CalculateSpec = { kind: 'notation', expr: 'Unit\\ price * (Qty - 1)' }
    const js = calculateScript(spec)
    expect(js).toBe("event.value = getField('Unit price').value * (getField('Qty').value - 1);")
    expect(parseCalculate(js)).toEqual(spec)
    expect(jsToNotation('getField("a").value + Math.sqrt(2)')).toBeNull()
    expect(parseCalculate('event.value = Math.max(1, 2);')).toEqual({ kind: 'custom', script: 'event.value = Math.max(1, 2);' })
  })

  it('tokenizes names, numbers and operators', () => {
    expect(tokenizeNotation('2ndLine*1.5')).toEqual([
      { t: 'name', v: '2ndLine' },
      { t: 'op', v: '*' },
      { t: 'num', v: '1.5' }
    ])
    expect(notationFields('a + b * a - 3')).toEqual(['a', 'b'])
    expect(() => tokenizeNotation('(a')).toThrow(/parentheses/)
    expect(() => tokenizeNotation('a)')).toThrow(/parentheses/)
  })

  it('explains mistakes in plain language', () => {
    const known = ['price', 'qty', 'Unit price']
    expect(checkNotation('price * qty', known)).toBeNull()
    expect(checkNotation('-price + 2', known)).toBeNull()
    expect(checkNotation('Unit\\ price * 2', known)).toBeNull()
    expect(checkNotation('', known)).toBe('Enter an expression')
    expect(checkNotation('price *', known)).toBe('The expression ends with an operator')
    expect(checkNotation('price qty', known)).toBe('Missing operator before “qty”')
    expect(checkNotation('price * total', known)).toBe('There is no field named “total”')
    expect(checkNotation('(price', known)).toBe('Unbalanced parentheses')
    expect(checkNotation('* price', known)).toBe('Missing value before “*”')
  })
})

describe('prepare-form: format examples', () => {
  it('formats numbers with each separator style', () => {
    expect(formatNumber(1234567.891, 2, 0)).toBe('1,234,567.89')
    expect(formatNumber(1234567.891, 2, 1)).toBe('1234567.89')
    expect(formatNumber(1234567.891, 2, 2)).toBe('1.234.567,89')
    expect(formatNumber(1234567.891, 0, 3)).toBe('1234568')
    expect(formatNumber(1234.5, 1, 4)).toBe("1'234.5")
  })

  it('formats dates with Acrobat patterns', () => {
    const d = new Date(2024, 2, 5, 14, 7, 9)
    expect(formatDate(d, 'mm/dd/yyyy')).toBe('03/05/2024')
    expect(formatDate(d, 'd-mmm-yy')).toBe('5-Mar-24')
    expect(formatDate(d, 'mmmm d, yyyy')).toBe('March 5, 2024')
    expect(formatDate(d, 'dddd HH:MM')).toBe('Tuesday 14:07')
    expect(formatDate(d, 'h:MM:ss tt')).toBe('2:07:09 pm')
  })

  it('shows examples in the Format tab', () => {
    expect(formatExample({ kind: 'number', decimals: 2, separator: 0, negative: 2, currency: '$', currencyPrepend: true })).toBe('($1,234.56)')
    expect(formatExample({ kind: 'number', decimals: 0, separator: 2, negative: 0, currency: ' €', currencyPrepend: false })).toBe('1.235 €')
    expect(formatExample({ kind: 'special', style: 2 })).toBe('(555) 123-4567')
    expect(formatExample({ kind: 'mask', mask: 'AA-9999' })).toBe('aa-1111')
    expect(formatExample({ kind: 'none' })).toBe('')
  })
})
