import { describe, expect, it } from 'vitest'
import type { FieldInfo } from '@engine/ops/forms'
import { Interpreter, JsObject, NativeFunction, ScriptError, toStr, type JsValue } from '@features/forms-fill/js/interpreter'
import { parse } from '@features/forms-fill/js/parser'
import { formatNumber, guessDate, printd, printf, printx, scand } from '@features/forms-fill/js/util'
import { makeNumber } from '@features/forms-fill/js/aform'
import { FormRuntime, colorToHex, typedValue, valueToString, type RuntimeHost } from '@features/forms-fill/js/runtime'

function run(src: string, globals: Record<string, JsValue> = {}): JsValue {
  return new Interpreter(globals).run(src)
}

let nextId = 1
function field(name: string, patch: Partial<FieldInfo> = {}): FieldInfo {
  return {
    id: nextId++,
    page: 0,
    name,
    type: 'text',
    rect: [0, 0, 100, 20],
    value: '',
    checked: false,
    onState: null,
    options: [],
    tooltip: '',
    readOnly: false,
    required: false,
    noExport: false,
    multiline: false,
    password: false,
    comb: false,
    maxLen: 0,
    multiSelect: false,
    editable: false,
    doNotSpellCheck: false,
    alignment: 0,
    fontName: 'Helv',
    fontSize: 12,
    textColor: '#000000',
    borderColor: null,
    backgroundColor: null,
    scripts: {},
    hidden: false,
    signed: false,
    ...patch
  }
}

const MONEY_F = 'AFNumber_Format(2, 0, 0, 0, "$", true);'
const MONEY_K = 'AFNumber_Keystroke(2, 0, 0, 0, "$", true);'

describe('JavaScript interpreter', () => {
  it('evaluates arithmetic, precedence and JS conversions', () => {
    expect(run('1 + 2 * 3')).toBe(7)
    expect(run('(1 + 2) * 3')).toBe(9)
    expect(run('10 / 4 - 1')).toBe(1.5)
    expect(run('7 % 3')).toBe(1)
    expect(run('"5" + 1')).toBe('51')
    expect(run('"5" * "2"')).toBe(10)
    expect(run('"" - 1')).toBe(-1)
    expect(run('-(-3)')).toBe(3)
    expect(run('2 ** 3 ** 2')).toBe(512)
    expect(run('"a" < "b"')).toBe(true)
    expect(run('"10" == 10')).toBe(true)
    expect(run('"10" === 10')).toBe(false)
    expect(run('null == undefined')).toBe(true)
    expect(run('[1, 2] + ""')).toBe('1,2')
    expect(run('typeof x')).toBe('undefined')
    expect(run('typeof "s"')).toBe('string')
    expect(run('!!""')).toBe(false)
    expect(run('0 || "default"')).toBe('default')
    expect(run('1 && 2')).toBe(2)
    expect(run('true ? "y" : "n"')).toBe('y')
  })

  it('supports variables, control flow, functions and closures', () => {
    expect(
      run(`
        var total = 0;
        for (var i = 1; i <= 10; i++) { if (i % 2) continue; total += i; }
        total`)
    ).toBe(30)
    expect(run('var n = 0; while (true) { n++; if (n > 4) break; } n')).toBe(5)
    expect(run('var k = 0; do { k += 2 } while (k < 7); k')).toBe(8)
    expect(run('function sq(x) { return x * x } sq(9)')).toBe(81)
    expect(run('function fact(n) { return n <= 1 ? 1 : n * fact(n - 1) } fact(6)')).toBe(720)
    expect(run('var add = function (a) { return function (b) { return a + b } }; add(2)(3)')).toBe(5)
    expect(run('var s = ""; switch (2) { case 1: s = "one"; break; case 2: s = "two"; case 3: s += "+three"; break; default: s = "d" } s')).toBe('two+three')
    expect(run('var r; try { throw "boom" } catch (e) { r = "caught " + e } finally { r += "!" } r')).toBe('caught boom!')
    expect(run('var o = { a: 1, "b c": 2 }; o.a + o["b c"]')).toBe(3)
    expect(run('var a = [3, 1, 2]; a.sort(); a.join("-")')).toBe('1-2-3')
    expect(run('[1, 2, 3].map(function (x) { return x * 2 }).reduce(function (s, x) { return s + x }, 0)')).toBe(12)
    expect(run('var keys = ""; var o = {x: 1, y: 2}; for (var k in o) keys += k; keys')).toBe('xy')
  })

  it('supports string, number and regex methods', () => {
    expect(run('"Hello".toUpperCase()')).toBe('HELLO')
    expect(run('"  pad ".trim().length')).toBe(3)
    expect(run('"a-b-c".split("-").length')).toBe(3)
    expect(run('"2024-05-06".substring(5, 7)')).toBe('05')
    expect(run('"abc".substr(-2)')).toBe('bc')
    expect(run('(1234.5678).toFixed(2)')).toBe('1234.57')
    expect(run('/^\\d+$/.test("123")')).toBe(true)
    expect(run('"a1b2".replace(/\\d/g, "#")')).toBe('a#b#')
    expect(run('"x".concat("y", 1)')).toBe('xy1')
    expect(run('Math.round(2.5) + Math.max(1, 7, 3) + Math.min(4, -1)')).toBe(9)
    expect(run('Number("12.5") + parseInt("7px") + parseFloat("1.5e1")')).toBe(34.5)
    expect(run('isNaN("abc")')).toBe(true)
    expect(run('String.fromCharCode(72, 105)')).toBe('Hi')
    expect(run('new Array("a", "b").length')).toBe(2)
    expect(run('new Date(2024, 0, 31).getDate()')).toBe(31)
  })

  it('never exposes the host JavaScript environment', () => {
    expect(() => run('globalThis')).toThrow(ScriptError)
    expect(() => run('process.exit()')).toThrow(/not defined/)
    expect(() => run('eval("1")')).toThrow(/not defined/)
    expect(() => run('Function("return 1")')).toThrow(/not defined/)
    expect(run('"".constructor')).toBeUndefined()
    expect(run('[].constructor')).toBeUndefined()
    expect(run('var o = {}; o.__proto__')).toBeUndefined()
    expect(run('(1).constructor')).toBeUndefined()
    expect(() => run('"".constructor.constructor("return process")()')).toThrow(ScriptError)
  })

  it('stops endless loops and runaway recursion', () => {
    expect(() => run('while (true) {}')).toThrow(/too long/)
    expect(() => run('function f() { return f() } f()')).toThrow(/recursion/)
    expect(() => run('for (;;) { try { x() } catch (e) {} }')).toThrow(/too long/)
  })

  it('reports syntax errors and unsupported features', () => {
    expect(() => parse('var = 3')).toThrow(ScriptError)
    expect(() => parse('if (x {')).toThrow(ScriptError)
    expect(() => parse('"unterminated')).toThrow(/Unterminated/)
    let err: unknown
    try {
      run('xfa.host.messageBox("hi")')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ScriptError)
    expect((err as ScriptError).unsupported).toBe(true)
  })

  it('handles comments, automatic semicolons and host objects', () => {
    const calls: string[] = []
    const host = new JsObject({ log: new NativeFunction('log', (_t, a) => (calls.push(toStr(a[0])), undefined)) })
    run(
      `/** BVCALC a + b EVCALC **/
      // a comment
      var a = 1
      var b = 2
      host.log(a + b)`,
      { host }
    )
    expect(calls).toEqual(['3'])
  })
})

describe('util', () => {
  it('formats numbers with Acrobat separator styles', () => {
    expect(formatNumber(1234.5, 2, 0)).toBe('1,234.50')
    expect(formatNumber(1234.5, 2, 1)).toBe('1234.50')
    expect(formatNumber(1234567.891, 2, 2)).toBe('1.234.567,89')
    expect(formatNumber(1234.5, 1, 3)).toBe('1234,5')
    expect(formatNumber(1234.5, 0, 4)).toBe('1’235')
    expect(formatNumber(-0.004, 2, 0)).toBe('0.00')
    expect(formatNumber(1.005, 2, 0)).toBe('1.01')
    expect(formatNumber(-12, 0, 0)).toBe('-12')
  })

  it('printf', () => {
    expect(printf('%.2f', 3.14159)).toBe('3.14')
    expect(printf('%,0.2f', 1234.5)).toBe('1,234.50')
    expect(printf('%,2.2f', 1234.5)).toBe('1.234,50')
    expect(printf('%d items', 12.9)).toBe('12 items')
    expect(printf('%05d', 42)).toBe('00042')
    expect(printf('%+d', 5)).toBe('+5')
    expect(printf('%x', 255)).toBe('FF')
    expect(printf('%s and %s', 'a', 'b')).toBe('a and b')
    expect(printf('100%%')).toBe('100%')
  })

  it('printx', () => {
    expect(printx('(999) 999-9999', '5551234567')).toBe('(555) 123-4567')
    expect(printx('99999-9999', '123456789')).toBe('12345-6789')
    expect(printx('999-99-9999', '123 45 6789')).toBe('123-45-6789')
    expect(printx('>AAA', 'abc')).toBe('ABC')
    expect(printx('99999', '12')).toBe('12')
  })

  it('printd and scand', () => {
    const d = new Date(2024, 2, 5, 14, 7, 9)
    expect(printd('mm/dd/yyyy', d)).toBe('03/05/2024')
    expect(printd('m/d/yy', d)).toBe('3/5/24')
    expect(printd('mmmm d, yyyy', d)).toBe('March 5, 2024')
    expect(printd('dd-mmm-yy', d)).toBe('05-Mar-24')
    expect(printd('h:MM tt', d)).toBe('2:07 pm')
    expect(printd('HH:MM:ss', d)).toBe('14:07:09')
    expect(printd('dddd', d)).toBe('Tuesday')
    expect(printd(2, d)).toBe('2024/03/05 14:07:09')

    const s = scand('mm/dd/yyyy', '03/05/2024')!
    expect([s.getFullYear(), s.getMonth(), s.getDate()]).toEqual([2024, 2, 5])
    expect(scand('mm/dd/yyyy', '3-5-2024')!.getDate()).toBe(5)
    expect(scand('mm/dd/yyyy', '02/30/2024')).toBeNull()
    expect(scand('mm/dd/yyyy', '13/01/2024')).toBeNull()
    expect(scand('mm/dd/yyyy', 'hello')).toBeNull()
    expect(scand('d-mmm-yy', '5-mar-24')!.getMonth()).toBe(2)
    expect(scand('m/d/yy', '1/2/99')!.getFullYear()).toBe(1999)
    const t = scand('h:MM tt', '2:30 pm')!
    expect([t.getHours(), t.getMinutes()]).toEqual([14, 30])
    expect(scand('HH:MM', '9:05')!.getHours()).toBe(9)
    expect(scand('HH:MM', '25:00')).toBeNull()
  })

  it('guesses dates written differently from the format', () => {
    const g = guessDate('mm/dd/yyyy', 'March 5 2024')!
    expect([g.getFullYear(), g.getMonth(), g.getDate()]).toEqual([2024, 2, 5])
    const iso = guessDate('mm/dd/yyyy', '2024-03-05')!
    expect([iso.getFullYear(), iso.getMonth(), iso.getDate()]).toEqual([2024, 2, 5])
    const dmy = guessDate('dd.mm.yyyy', '5 3 2024')!
    expect([dmy.getMonth(), dmy.getDate()]).toEqual([2, 5])
    expect(guessDate('mm/dd/yyyy', 'not a date')).toBeNull()
  })

  it('AFMakeNumber', () => {
    expect(makeNumber('1234.5')).toBe(1234.5)
    expect(makeNumber('1,5')).toBe(1.5)
    expect(makeNumber('1,234')).toBe(1234)
    expect(makeNumber('$1,234.50')).toBe(1234.5)
    expect(makeNumber('1.234,56 €')).toBe(1234.56)
    expect(makeNumber('(12.00)')).toBe(-12)
    expect(makeNumber('-7')).toBe(-7)
    expect(makeNumber('')).toBeNull()
    expect(makeNumber('abc')).toBeNull()
    expect(makeNumber(5)).toBe(5)
  })

  it('field value typing and colours', () => {
    expect(typedValue('12')).toBe(12)
    expect(typedValue('007')).toBe(7)
    expect(typedValue('12a')).toBe('12a')
    expect(typedValue('')).toBe('')
    expect(valueToString(NaN)).toBe('')
    expect(valueToString(1234.5)).toBe('1234.5')
    expect(colorToHex(['RGB', 1, 0, 0])).toBe('#ff0000')
    expect(colorToHex(['G', 0.5])).toBe('#808080')
    expect(colorToHex(['CMYK', 0, 0, 0, 1])).toBe('#000000')
  })
})

describe('AForm functions through the form runtime', () => {
  function orderForm(host: RuntimeHost = {}) {
    return new FormRuntime(
      {
        fields: [
          field('amount1', { scripts: { format: MONEY_F, keystroke: MONEY_K } }),
          field('amount2', { scripts: { format: MONEY_F, keystroke: MONEY_K } }),
          field('total', {
            readOnly: true,
            scripts: { format: MONEY_F, keystroke: MONEY_K, calculate: 'AFSimple_Calculate("SUM", new Array ("amount1", "amount2"));' }
          }),
          field('discount', { scripts: { format: 'AFPercent_Format(0, 0);', keystroke: 'AFPercent_Keystroke(0, 0);' } }),
          field('net', {
            scripts: {
              format: MONEY_F,
              calculate: 'var t = this.getField("total").value;\nvar d = this.getField("discount").value;\nevent.value = t * (1 - d);'
            }
          }),
          field('qty', { scripts: { keystroke: 'AFNumber_Keystroke(0, 1, 0, 0, "", true);', validate: 'AFRange_Validate(true, 0, true, 100);' } }),
          field('orderDate', { scripts: { format: 'AFDate_FormatEx("mm/dd/yyyy");', keystroke: 'AFDate_KeystrokeEx("mm/dd/yyyy");' } })
        ],
        values: {},
        calcOrder: ['total', 'net']
      },
      host
    )
  }

  it('filters keystrokes for number fields', () => {
    const rt = orderForm()
    expect(rt.keystroke('amount1', { value: '12', change: '3', selStart: 2, selEnd: 2 }).rc).toBe(true)
    expect(rt.keystroke('amount1', { value: '12', change: 'a', selStart: 2, selEnd: 2 }).rc).toBe(false)
    expect(rt.keystroke('amount1', { value: '1.2', change: '.', selStart: 3, selEnd: 3 }).rc).toBe(false)
    expect(rt.keystroke('amount1', { value: '', change: '-', selStart: 0, selEnd: 0 }).rc).toBe(true)
    // replacing a selection
    expect(rt.keystroke('amount1', { value: '1x2', change: '5', selStart: 1, selEnd: 2 }).rc).toBe(true)
  })

  it('rejects malformed numbers on commit with Acrobat\'s message', () => {
    const rt = orderForm()
    const bad = rt.commit('amount1', '12.3.4')
    expect(bad.rc).toBe(false)
    expect(bad.alerts).toEqual(['The value entered does not match the format of the field [ amount1 ]'])
    const ok = rt.commit('amount1', '1000')
    expect(ok).toEqual({ rc: true, value: '1000', alerts: [] })
  })

  it('formats currency, percent and dates', () => {
    const rt = orderForm()
    expect(rt.format('amount1', '1234.5').display).toBe('$1,234.50')
    expect(rt.format('amount1', '-5').display).toBe('-$5.00')
    expect(rt.format('amount1', '').display).toBe('')
    expect(rt.format('discount', '0.1').display).toBe('10%')
    expect(rt.format('orderDate', '3/4/2024').display).toBe('03/04/2024')
    expect(rt.format('orderDate', 'March 4, 2024').display).toBe('03/04/2024')
  })

  it('validates ranges and dates', () => {
    const rt = orderForm()
    expect(rt.commit('qty', '50').rc).toBe(true)
    const r = rt.commit('qty', '150')
    expect(r.rc).toBe(false)
    expect(r.alerts[0]).toBe('Invalid value: must be greater than or equal to 0 and less than or equal to 100.')
    const d = rt.commit('orderDate', '13/45/2024')
    expect(d.rc).toBe(false)
    expect(d.alerts[0]).toBe(
      'Invalid date/time: please ensure that the date/time exists. Field [ orderDate ] should match format mm/dd/yyyy'
    )
    expect(rt.commit('orderDate', '12/25/2024').rc).toBe(true)
  })

  it('calculates in /CO order and formats results', () => {
    const rt = orderForm()
    rt.setValue('amount1', '1000')
    rt.setValue('amount2', '234.5')
    let { changes } = rt.calculate()
    expect(changes).toEqual([
      { name: 'total', value: '1234.5', display: '$1,234.50', textColor: undefined },
      { name: 'net', value: '1234.5', display: '$1,234.50', textColor: undefined }
    ])
    rt.setValue('discount', '0.1')
    changes = rt.calculate().changes
    expect(changes).toEqual([{ name: 'net', value: '1111.05', display: '$1,111.05', textColor: undefined }])
    // nothing changes the second time
    expect(rt.calculate().changes).toEqual([])
  })

  it('AFSimple_Calculate supports every function, lists and wildcards', () => {
    const mk = (fn: string, list: string) =>
      new FormRuntime({
        fields: [field('row.a'), field('row.b'), field('row.c'), field('out', { scripts: { calculate: `AFSimple_Calculate("${fn}", ${list});` } })],
        values: { 'row.a': '2', 'row.b': '3', 'row.c': '' },
        calcOrder: ['out']
      }).calculate().changes[0]?.value
    expect(mk('SUM', '"row.a, row.b"')).toBe('5')
    expect(mk('PRD', 'new Array("row.a", "row.b")')).toBe('6')
    expect(mk('AVG', '["row.a", "row.b", "row.c"]')).toBe('1.666667')
    expect(mk('MIN', '"row.*"')).toBe('0')
    expect(mk('MAX', '"row"')).toBe('3')
  })

  it('negative numbers in red and in parentheses', () => {
    const rt = new FormRuntime({
      fields: [field('n', { scripts: { format: 'AFNumber_Format(2, 0, 3, 0, "", false);' } })],
      values: {},
      calcOrder: []
    })
    expect(rt.format('n', '-1234.5')).toEqual({ display: '(1,234.50)', textColor: '#ff0000', alerts: [] })
    expect(rt.format('n', '7')).toEqual({ display: '7.00', textColor: '#000000', alerts: [] })
  })

  it('special formats (zip, phone, SSN) and masks', () => {
    const rt = new FormRuntime({
      fields: [
        field('zip', { scripts: { format: 'AFSpecial_Format(0);', keystroke: 'AFSpecial_Keystroke(0);' } }),
        field('zip4', { scripts: { format: 'AFSpecial_Format(1);', keystroke: 'AFSpecial_Keystroke(1);' } }),
        field('phone', { scripts: { format: 'AFSpecial_Format(2);', keystroke: 'AFSpecial_Keystroke(2);' } }),
        field('ssn', { scripts: { format: 'AFSpecial_Format(3);', keystroke: 'AFSpecial_Keystroke(3);' } }),
        field('code', { scripts: { keystroke: 'AFSpecial_KeystrokeEx("AA-999");' } })
      ],
      values: {},
      calcOrder: []
    })
    expect(rt.keystroke('zip', { value: '1234', change: '5', selStart: 4, selEnd: 4 }).rc).toBe(true)
    expect(rt.keystroke('zip', { value: '12345', change: '6', selStart: 5, selEnd: 5 }).rc).toBe(false)
    expect(rt.keystroke('zip', { value: '12', change: 'x', selStart: 2, selEnd: 2 }).rc).toBe(false)
    expect(rt.commit('zip', '1234').rc).toBe(false)
    expect(rt.commit('zip', '12345').rc).toBe(true)
    expect(rt.format('zip4', '123456789').display).toBe('12345-6789')
    expect(rt.format('phone', '5551234567').display).toBe('(555) 123-4567')
    expect(rt.format('phone', '1234567').display).toBe('123-4567')
    expect(rt.commit('phone', '(555) 123-4567').rc).toBe(true)
    expect(rt.commit('phone', '555-12').rc).toBe(false)
    expect(rt.format('ssn', '123456789').display).toBe('123-45-6789')
    expect(rt.commit('ssn', '123-45-6789').rc).toBe(true)
    // masks insert literal characters while typing
    const k = rt.keystroke('code', { value: 'AB', change: '1', selStart: 2, selEnd: 2 })
    expect(k).toEqual({ rc: true, change: '-1', alerts: [] })
    expect(rt.keystroke('code', { value: 'A', change: '1', selStart: 1, selEnd: 1 }).rc).toBe(false)
    expect(rt.commit('code', 'AB-12').rc).toBe(false)
    expect(rt.commit('code', 'AB-123').rc).toBe(true)
  })

  it('custom keystroke, validate and format scripts', () => {
    const rt = new FormRuntime({
      fields: [
        field('city', { scripts: { keystroke: 'if (!event.willCommit) event.change = event.change.toUpperCase();' } }),
        field('even', {
          scripts: { validate: 'if (event.value % 2 != 0) { app.alert("Please enter an even number."); event.rc = false; }' }
        }),
        field('weight', { scripts: { format: 'if (event.value != "") event.value = util.printf("%.1f", event.value) + " kg";' } })
      ],
      values: {},
      calcOrder: []
    })
    expect(rt.keystroke('city', { value: 'par', change: 'is', selStart: 3, selEnd: 3 })).toEqual({ rc: true, change: 'IS', alerts: [] })
    expect(rt.commit('even', '3')).toEqual({ rc: false, value: '3', alerts: ['Please enter an even number.'] })
    expect(rt.commit('even', '4').rc).toBe(true)
    expect(rt.format('weight', '72').display).toBe('72.0 kg')
    expect(rt.format('weight', '').display).toBe('')
  })

  it('simplified field notation and document-level functions', () => {
    const rt = new FormRuntime({
      fields: [
        field('a'),
        field('b'),
        field('c'),
        field('sfn', {
          scripts: {
            calculate:
              '/** BVCALC a + b * c EVCALC **/ event.value = AFMakeNumber(getField("a").value) + AFMakeNumber(getField("b").value) * AFMakeNumber(getField("c").value)'
          }
        }),
        field('tax', { scripts: { calculate: 'event.value = taxOf(this.getField("a").value);' } })
      ],
      values: { a: '10', b: '2', c: '3' },
      calcOrder: ['sfn', 'tax'],
      docScripts: ['function taxOf(v) { return Math.round(v * 0.2 * 100) / 100; }']
    })
    expect(rt.calculate().changes.map((c) => [c.name, c.value])).toEqual([
      ['sfn', '16'],
      ['tax', '2']
    ])
  })

  it('string concatenation of empty fields behaves like Acrobat', () => {
    const rt = new FormRuntime({
      fields: [field('first'), field('last'), field('full', { scripts: { calculate: 'event.value = this.getField("first").value + " " + this.getField("last").value;' } })],
      values: { first: 'Ada', last: 'Lovelace' },
      calcOrder: ['full']
    })
    expect(rt.calculate().changes[0].value).toBe('Ada Lovelace')
  })

  it('scripts can set other fields, properties and text colours', () => {
    const rt = new FormRuntime({
      fields: [
        field('agree', { type: 'checkbox', onState: 'Yes' }),
        field('details'),
        field('x', {
          scripts: {
            calculate:
              'var on = this.getField("agree").value != "Off"; this.getField("details").display = on ? display.visible : display.hidden; this.getField("details").readonly = !on; event.target.textColor = color.blue; event.value = on ? "yes" : "no";'
          }
        })
      ],
      values: { agree: 'Off' },
      calcOrder: ['x']
    })
    const { changes } = rt.calculate()
    expect(changes).toContainEqual({ name: 'x', value: 'no', display: 'no', textColor: undefined })
    expect(changes).toContainEqual({ name: 'details', visibility: 1, readOnly: true })
    rt.setValue('agree', 'Yes')
    const again = rt.calculate().changes
    expect(again).toContainEqual({ name: 'details', visibility: 0, readOnly: false })
  })

  it('button actions call back into the application', () => {
    const calls: string[] = []
    const host: RuntimeHost = {
      print: () => calls.push('print'),
      resetForm: (names) => calls.push(`reset:${names?.join(',') ?? 'all'}`),
      submitForm: (url) => calls.push(`submit:${url}`),
      launchURL: (url) => calls.push(`url:${url}`),
      gotoPage: (p) => calls.push(`page:${p}`),
      currentPage: () => 2,
      notSupported: (w) => calls.push(`unsupported:${w}`)
    }
    const rt = new FormRuntime({ fields: [field('a'), field('b')], values: {}, calcOrder: [] }, host)
    rt.runAction('this.print();')
    rt.runAction('this.resetForm(["a"]); resetForm();')
    rt.runAction('this.submitForm({cURL: "https://example.com/x"});')
    rt.runAction('app.launchURL("https://example.com", true);')
    rt.runAction('this.pageNum++;')
    rt.runAction('this.mailForm(true);')
    const r = rt.runAction('app.alert("Hello"); this.getField("b").value = 42;')
    expect(r.alerts).toEqual(['Hello'])
    expect(r.changes).toEqual([{ name: 'b', value: '42', display: '42', textColor: undefined }])
    expect(calls).toEqual(['print', 'reset:a', 'reset:all', 'submit:https://example.com/x', 'url:https://example.com', 'page:3', 'unsupported:Emailing forms'])
  })

  it('records problems instead of failing on broken or unsupported scripts', () => {
    const rt = new FormRuntime({
      fields: [field('a', { scripts: { format: 'xfa.resolveNode("x")', keystroke: 'if (' } }), field('b', { scripts: { calculate: 'event.value = ;' } })],
      values: { a: '5' },
      calcOrder: ['b']
    })
    expect(rt.format('a', '5').display).toBe('5')
    expect(rt.keystroke('a', { value: '', change: 'x', selStart: 0, selEnd: 0 }).rc).toBe(true)
    expect(rt.calculate().changes).toEqual([])
    expect(rt.problems.length).toBe(3)
    expect(rt.problems.find((p) => p.event === 'Format')?.unsupported).toBe(true)
  })

  it('reads checkbox, radio and list values like Acrobat', () => {
    const rt = new FormRuntime({
      fields: [
        field('cb', { type: 'checkbox', onState: 'Yes', checked: true, value: 'Yes' }),
        field('plan', { type: 'radio', onState: 'basic', value: 'pro' }),
        field('plan', { type: 'radio', onState: 'pro', value: 'pro', checked: true }),
        field('langs', { type: 'list', multiSelect: true, options: [{ label: 'English', value: 'en' }, { label: 'French', value: 'fr' }] }),
        field('out', {
          scripts: {
            calculate:
              'var l = this.getField("langs"); event.value = this.getField("cb").value + "/" + this.getField("plan").value + "/" + l.value.length + "/" + l.getItemAt(1, false) + "/" + this.getField("plan").isBoxChecked(1);'
          }
        })
      ],
      values: { plan: 'pro', langs: ['en', 'fr'] },
      calcOrder: ['out']
    })
    expect(rt.calculate().changes[0].value).toBe('Yes/pro/2/French/true')
  })
})
