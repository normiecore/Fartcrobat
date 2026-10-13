import { describe, expect, it } from 'vitest'
import { decodeString, filterHiddenLayers, operandStrings, removeDictKeys, tokenize } from '@features/redact/worker/contentFilter'
import { markedSequences } from '@features/redact/worker/tagged'
import { layoutOverlay, textWidthEm, toWinAnsi } from '@features/redact/worker/overlay'
import { DEFAULT_PROPS } from '@features/redact/shared'
import type redactOps from '@features/redact/engine'
import type textOps from '@engine/ops/text'
import { openFixture } from './helpers'

const ctx = (hidden: string[]) => ({
  isHiddenProperty: (n: string) => hidden.includes(n),
  isHiddenXObject: (n: string) => hidden.includes(n)
})

describe('redact: content stream filter', () => {
  it('tokenizes strings, arrays, dictionaries, comments and inline images', () => {
    const src = [
      '% a comment with Tj inside',
      'BT /F1 12 Tf (a \\(nested (paren)\\) and \\\\ backslash) Tj [(A) -120 <0041>] TJ ET',
      '/Span << /ActualText (x) /Nested << /K [1 2] >> >> BDC EMC',
      'BI /W 4 /H 1 /BPC 8 /CS /G ID \x00EI\x01\xff EI Q',
      'q 1 0 0 1 10 20 cm /Im1 Do Q'
    ].join('\n')
    const ops = tokenize(src).map((o) => o.op)
    expect(ops).toEqual(['BT', 'Tf', 'Tj', 'TJ', 'ET', 'BDC', 'EMC', 'BI', 'Q', 'q', 'cm', 'Do', 'Q'])
    const tj = tokenize(src)[2]
    expect(tj.operands[0].kind).toBe('string')
    expect(src.slice(tj.start, tj.end)).toBe('(a \\(nested (paren)\\) and \\\\ backslash) Tj')
  })

  it('neutralises hidden layers and keeps everything else byte for byte', () => {
    const src = [
      'q 1 0 0 rg 0 0 10 10 re f Q',
      '/OC /hid BDC q 0 0 1 rg 10 10 50 50 re f /Im1 Do 0 0 m 5 5 l S BT /F1 9 Tf (secret) Tj ET Q EMC',
      '/OC /vis BDC BT /F1 9 Tf (shown) Tj ET EMC',
      '/Hidden Do /Shown Do'
    ].join('\n')
    const r = filterHiddenLayers(src, ctx(['hid', 'Hidden']))
    expect(r.removed).toBe(4) // f, Do, S and the hidden XObject
    expect(r.hiddenText).toBe(1)
    expect(r.visibleForms).toEqual(['Shown'])
    const lines = r.out.split('\n')
    expect(lines[0]).toBe('q 1 0 0 rg 0 0 10 10 re f Q')
    expect(lines[1]).toBe('/FcHiddenLayer BMC q 0 0 1 rg 10 10 50 50 re n  0 0 m 5 5 l n BT /F1 9 Tf 3 Tr (secret) Tj 0 Tr ET Q EMC')
    expect(lines[2]).toBe('/OC /vis BDC BT /F1 9 Tf (shown) Tj ET EMC')
    expect(lines[3]).toBe(' /Shown Do')
  })

  it('restores the text render mode that was in force', () => {
    const r = filterHiddenLayers('2 Tr q 1 Tr /OC /h BDC BT (a) Tj ET EMC Q', ctx(['h']))
    expect(r.out).toContain('3 Tr (a) Tj 1 Tr')
  })
})

describe('redact: marked content', () => {
  it('decodes strings and edits property lists', () => {
    expect(decodeString('(a\\(b\\)\\\\ \\101\\n)')).toBe('a(b)\\ A\n')
    expect(decodeString('<4142 43>')).toBe('ABC')
    expect(operandStrings({ kind: 'array', text: '[(Hel) -20 <6C> 5 (o)]' })).toBe('Hello')
    const d = '<< /MCID 3 /ActualText (secret \\) text) /Lang (en) /Alt <414243> >>'
    expect(removeDictKeys(d, new Set(['ActualText', 'Alt']))).toBe('<< /MCID 3  /Lang (en)  >>')
  })

  it('lists marked-content sequences with what they draw', () => {
    const src = [
      '/P <</MCID 0>> BDC BT (Hello) Tj [(Wor) 10 (ld)] TJ ET EMC',
      '/Span <</MCID 1 /ActualText (x)>> BDC /Im1 Do 0 0 5 5 re f EMC',
      '/Artifact BMC (skip) Tj EMC',
      '/Span /MC0 BDC /Outer <</MCID 2>> BDC (in) Tj EMC (out) Tj EMC'
    ].join('\n')
    const seqs = markedSequences(src, { xobject: (n) => (n === 'Im1' ? '42' : n), property: () => null })
    expect(seqs.map((q) => [q.mcid, q.hasReplacement, q.resource])).toEqual([
      [0, false, null],
      [1, true, null],
      [null, false, 'MC0'],
      [2, false, null]
    ])
    expect(seqs[0].signature).toBe('HelloWorld\u0000')
    expect(seqs[1].signature).toBe('\u0000D42;P')
    expect(seqs[2].signature).toBe('inout\u0000')
    expect(seqs[3].signature).toBe('in\u0000')
  })
})

describe('redact: overlay text', () => {
  it('encodes text for WinAnsi and lays it out inside the area', async () => {
    expect(toWinAnsi('Café “quoted” €5 ☃').chars).toBe('Café “quoted” €5 ?')
    const e = await openFixture('text.pdf')
    const s = e.session
    const centred = layoutOverlay(s, [100, 100, 300, 130], { ...DEFAULT_PROPS, autoSize: false, fontSize: 10 }, 'REDACTED')!
    expect(centred.size).toBe(10)
    expect(centred.lines).toHaveLength(1)
    const width = textWidthEm(s, 'Helvetica', 'REDACTED') * 10
    expect(centred.lines[0].x).toBeCloseTo(100 + (200 - width) / 2, 2)
    expect(centred.lines[0].baseline).toBeGreaterThan(115)
    expect(centred.lines[0].baseline).toBeLessThan(125)
    const fit = layoutOverlay(s, [0, 0, 60, 400], { ...DEFAULT_PROPS, autoSize: true }, 'A long overlay text')!
    expect(fit.size).toBeLessThan(10)
    const left = layoutOverlay(s, [50, 0, 400, 20], { ...DEFAULT_PROPS, autoSize: false, align: 'left' }, 'X')!
    expect(left.lines[0].x).toBeLessThan(55)
    const rep = layoutOverlay(s, [0, 0, 300, 60], { ...DEFAULT_PROPS, autoSize: false, fontSize: 10, repeat: true }, 'NO')!
    expect(rep.lines.length).toBeGreaterThan(3)
    expect(rep.lines[0].text.split('NO').length - 1).toBeGreaterThan(5)
  })

  it('keeps layers the user switched off for viewing when only hidden layers are removed', async () => {
    const e = await openFixture('redact/hidden-info.pdf')
    const doc = e.session.pdf
    const visible = [...Array(doc.countLayers()).keys()].find((i) => doc.getLayerName(i) === 'Visible layer')!
    doc.setLayerVisible(visible, false)
    await e.ops<typeof redactOps>('redact').sanitize({ items: ['hiddenLayers'] })
    doc.setLayerVisible(visible, true)
    const t = await e.ops<typeof textOps>('text').page(0)
    expect(t.text).toContain('Visible layer text')
    expect(t.text).not.toContain('HIDDEN LAYER SECRET')
    expect(t.text).toContain('INVISIBLE OCR LAYER')
  })
})
