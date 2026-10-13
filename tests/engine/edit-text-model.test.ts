import { describe, expect, it } from 'vitest'
import { layoutText, type LayoutRun, type ShapedGlyph } from '@features/edit-text/layout'
import {
  applyStyle,
  classifyFont,
  commonStyle,
  DEFAULT_STYLE,
  editKey,
  locateText,
  normalizeRuns,
  replaceRange,
  runsText,
  standardFontName,
  type Run
} from '@features/edit-text/model'
import { winAnsiCode } from '@features/edit-text/write'
import { localFamilies } from '@features/edit-text/fonts'

const run = (text: string, patch: Partial<Run> = {}): Run => ({ ...DEFAULT_STYLE, ...patch, text })

describe('edit-text model', () => {
  it('applies styles to a range or to everything', () => {
    const runs = [run('Hello world')]
    const bold = applyStyle(runs, 6, 11, { bold: true })
    expect(bold.map((r) => [r.text, r.bold])).toEqual([
      ['Hello ', false],
      ['world', true]
    ])
    expect(commonStyle(bold, 6, 11).bold).toBe(true)
    expect(commonStyle(bold, 0, 11).bold).toBeUndefined()
    const all = applyStyle(bold, 3, 3, { size: 20 })
    expect(all.every((r) => r.size === 20)).toBe(true)
    expect(normalizeRuns(applyStyle(bold, 0, 11, { bold: true }))).toHaveLength(1)
  })

  it('replaces ranges keeping the surrounding styles', () => {
    const runs = [run('Hello '), run('world', { bold: true })]
    const r1 = replaceRange(runs, 6, 11, 'there')
    expect(r1.map((r) => [r.text, r.bold])).toEqual([
      ['Hello ', false],
      ['there', true]
    ])
    const r2 = replaceRange(runs, 5, 5, '\n')
    expect(runsText(r2)).toBe('Hello\n world')
    expect(runsText(replaceRange(runs, 0, 11, ''))).toBe('')
    expect(replaceRange(runs, 0, 11, '')).toHaveLength(1)
  })

  it('detects unchanged edits', () => {
    const frame = { origin: [1, 2] as [number, number], dir: [1, 0] as [number, number], width: 100 }
    const a = { runs: [run('a'), run('b')], frame, align: 'left' as const, lineSpacing: 1.2, wrap: false }
    const b = { ...a, runs: [run('ab')] }
    expect(editKey(a)).toBe(editKey(b))
    expect(editKey(a)).not.toBe(editKey({ ...a, align: 'center' }))
  })

  it('maps fonts to standard families', () => {
    expect(classifyFont('ABCDEF+TimesNewRomanPSMT')).toBe('serif')
    expect(classifyFont('ArialMT')).toBe('sans')
    expect(classifyFont('CourierNewPSMT')).toBe('mono')
    expect(classifyFont('Calibri-Bold')).toBe('sans')
    expect(standardFontName('Times', true, true)).toBe('Times-BoldItalic')
    expect(standardFontName('Helvetica', false, true)).toBe('Helvetica-Oblique')
    expect(standardFontName('Courier', true, false)).toBe('Courier-Bold')
    expect(winAnsiCode('€'.codePointAt(0)!)).toBe(0x80)
    expect(winAnsiCode('é'.codePointAt(0)!)).toBe(0xe9)
    expect(winAnsiCode('Ω'.codePointAt(0)!)).toBe(-1)
  })
})

describe('edit-text fonts and text lookup', () => {
  it('classifies common office fonts by name before trusting font flags', () => {
    expect(classifyFont('BAAAAA+Carlito-Bold', { serif: true })).toBe('sans')
    expect(classifyFont('CAAAAA+Caladea-Regular')).toBe('serif')
    expect(classifyFont('LiberationSans-Bold', { serif: true })).toBe('sans')
    expect(classifyFont('NotoSerif-Italic')).toBe('serif')
    expect(classifyFont('DejaVuSansMono')).toBe('mono')
    expect(classifyFont('FranklinGothic-Book')).toBe('sans')
    expect(classifyFont('SomeUnknownFont', { serif: true })).toBe('serif')
    expect(classifyFont('SomeUnknownFont')).toBe('sans')
  })

  it('derives installed font family names from PDF font names', () => {
    expect(localFamilies('ABCDEF+TimesNewRomanPS-BoldMT')).toEqual(['TimesNewRoman', 'Times New Roman'])
    expect(localFamilies('ArialMT')).toEqual(['Arial'])
    expect(localFamilies('CAAAAA+Caladea-Regular')).toEqual(['Caladea'])
    expect(localFamilies('Calibri,Bold')).toEqual(['Calibri'])
    expect(localFamilies('#20weird')).toEqual([])
  })

  it('finds selected text inside a paragraph despite different white space', () => {
    const text = 'Jane Smith\n12 High Street\nSpringfield'
    expect(locateText(text, 'Smith 12 High')).toEqual({ start: 5, end: 18 })
    expect(text.slice(5, 18)).toBe('Smith\n12 High')
    expect(locateText(text, '  Street  ')).toEqual({ start: 19, end: 25 })
    expect(locateText(text, 'nowhere')).toBeNull()
    expect(locateText(text, '   ')).toBeNull()
  })
})

describe('edit-text layout', () => {
  // every character is 1pt per point of font size wide (monospace) to keep numbers simple
  const shape =
    (size: number) =>
    (ch: string): ShapedGlyph => ({ ch, adv: size * 0.5, code: '00', slot: 's', space: ch === ' ' })
  const lr = (text: string, size = 10): LayoutRun => ({
    style: { ...DEFAULT_STYLE, size },
    text,
    shape: shape(size)
  })
  const lineText = (l: { glyphs: { g: ShapedGlyph }[] }) => l.glyphs.map((g) => g.g.ch).join('')

  it('wraps at spaces and keeps hard breaks', () => {
    const res = layoutText([lr('aaa bbb ccc\nddd')], {
      wrap: true,
      width: 40,
      align: 'left',
      lineSpacing: 1.2,
      ascent: 1
    })
    expect(res.lines.map(lineText)).toEqual(['aaa bbb', 'ccc', 'ddd'])
    expect(res.lines.map((l) => l.v)).toEqual([10, 22, 34])
    expect(res.lines[0].width).toBe(35)
  })

  it('does not wrap single-line boxes and splits words longer than the box', () => {
    expect(
      layoutText([lr('aaa bbb ccc')], { wrap: false, width: 10, align: 'left', lineSpacing: 1.2, ascent: 1 })
        .lines
    ).toHaveLength(1)
    const res = layoutText([lr('abcdefghij')], {
      wrap: true,
      width: 20,
      align: 'left',
      lineSpacing: 1,
      ascent: 1
    })
    expect(res.lines.map(lineText)).toEqual(['abcd', 'efgh', 'ij'])
  })

  it('centres, right-aligns and justifies lines', () => {
    const c = layoutText([lr('aa bb')], { wrap: true, width: 45, align: 'center', lineSpacing: 1, ascent: 1 })
    expect(c.lines[0].offset).toBe(10)
    const r = layoutText([lr('aa bb')], { wrap: true, width: 45, align: 'right', lineSpacing: 1, ascent: 1 })
    expect(r.lines[0].offset).toBe(20)
    const j = layoutText([lr('aa bb cc dd ee')], {
      wrap: true,
      width: 45,
      align: 'justify',
      lineSpacing: 1,
      ascent: 1
    })
    expect(j.lines.map(lineText)).toEqual(['aa bb cc', 'dd ee'])
    const first = j.lines[0]
    const last = first.glyphs[first.glyphs.length - 1]
    expect(last.u + last.g.adv).toBeCloseTo(45)
    expect(j.lines[1].glyphs.every((g) => g.extra === 0)).toBe(true)
  })

  it('uses the largest size on a line for line spacing', () => {
    const res = layoutText([lr('small\n'), lr('big', 20)], {
      wrap: false,
      width: 100,
      align: 'left',
      lineSpacing: 1.5,
      ascent: 1
    })
    expect(res.lines[0].v).toBe(10)
    expect(res.lines[1].v).toBe(10 + 1.5 * 20)
  })
})
