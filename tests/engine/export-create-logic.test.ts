import { describe, expect, it } from 'vitest'
import { fontFamily } from '../../src/features/export-create/fonts'
import { parseMarker } from '../../src/features/export-create/layout'
import { parseNumber } from '../../src/features/export-create/numbers'
import {
  fitImagePage,
  normalizeExportOptions,
  blankSize,
  pageImageName,
  parsePageRange
} from '../../src/features/export-create/shared'


describe('numbers in spreadsheets', () => {
  it.each([
    ['1,250', 1250, '#,##0'],
    ['980', 980, '0'],
    ['$12,500.00', 12500, '"$"#,##0.00'],
    ['$9,800.50', 9800.5, '"$"#,##0.00'],
    ['5.5%', 0.055, '0.0%'],
    ['-2.1%', -0.021, '0.0%'],
    ['12%', 0.12, '0%'],
    ['(3.4%)', -0.034, '0.0%;(0.0%)'],
    ['(1,000)', -1000, '#,##0;(#,##0)'],
    ['1.234,50 €', 1234.5, '#,##0.00" €"'],
    ['12,5', 12.5, '0.0'],
    ['1 234 567', 1234567, '#,##0'],
    ['-$4.00', -4, '"$"0.00'],
    ['0.75', 0.75, '0.00']
  ])('%s', (input, value, fmt) => {
    const r = parseNumber(input)
    expect(r).not.toBeNull()
    expect(r!.value).toBeCloseTo(value as number, 10)
    expect(r!.numFmt).toBe(fmt)
  })

  it.each(['A-100', '007', '0123', 'North', '1.2.3', '12 apples', '', '4111111111111111111', '2025-10-13', '$'])('keeps “%s” as text', (input) => {
    expect(parseNumber(input)).toBeNull()
  })
})

describe('font families', () => {
  it.each([
    ['Helvetica-Bold', 'Arial'],
    ['ABCDEF+ArialMT', 'Arial'],
    ['Times-Roman', 'Times New Roman'],
    ['TimesNewRomanPS-BoldItalicMT', 'Times New Roman'],
    ['Courier', 'Courier New'],
    ['ABCDEF+Calibri-Light', 'Calibri Light'],
    ['ABCDEF+Calibri-Bold', 'Calibri'],
    ['Georgia,Bold', 'Georgia'],
    ['SegoeUI-Semibold', 'Segoe UI'],
    ['MinionPro-It', 'Minion Pro'],
    ['NotoSansDisplay-Regular', 'Noto Sans Display'],
    ['Transit', 'Transit']
  ])('%s -> %s', (name, family) => {
    expect(fontFamily(name)).toBe(family)
  })

  it('falls back on the font kind for generated names', () => {
    expect(fontFamily('F1', 4)).toBe('Courier New')
    expect(fontFamily('T1_0', 8)).toBe('Times New Roman')
    expect(fontFamily('', 0)).toBe('Arial')
  })
})

describe('list markers', () => {
  it.each([
    ['•', 'bullet', 1],
    ['-', 'bullet', 1],
    ['3.', 'decimal', 3],
    ['(12)', 'decimal', 12],
    ['b)', 'lowerLetter', 2],
    ['C.', 'upperLetter', 3],
    ['iv.', 'lowerRoman', 4],
    ['XII)', 'upperRoman', 12]
  ])('%s', (marker, format, value) => {
    expect(parseMarker(marker)).toMatchObject({ format, value })
  })

  it.each(['1999', 'Dr.', 'e.g.', 'abc)'])('“%s” is not a marker', (marker) => {
    expect(parseMarker(marker)).toBeNull()
  })
})

describe('options and names', () => {
  it('parses page ranges', () => {
    expect(parsePageRange('1-3, 5', 10)).toEqual([0, 1, 2, 4])
    expect(parsePageRange('8-', 10)).toEqual([7, 8, 9])
    expect(parsePageRange('3-1', 10)).toEqual([0, 1, 2])
    expect(parsePageRange('2,2,2', 10)).toEqual([1])
    expect(parsePageRange('11', 10)).toBe('This document has 10 pages')
    expect(parsePageRange('0', 10)).toBe('Page numbers start at 1')
    expect(parsePageRange('a', 10)).toMatch(/is not a page number/)
    expect(parsePageRange(' ', 10)).toMatch(/Enter the pages/)
  })

  it('names page images like Acrobat', () => {
    expect(pageImageName('Report', 1, 'png')).toBe('Report_Page_1.png')
    expect(pageImageName('Report', 12, 'jpeg')).toBe('Report_Page_12.jpg')
  })

  it('repairs stored options', () => {
    const o = normalizeExportOptions({ format: 'nope', image: { dpi: 123, quality: 500, format: 'gif' }, word: { layout: 'x', images: false } })
    expect(o.format).toBe('word')
    expect(o.image).toMatchObject({ dpi: 150, quality: 100, format: 'png' })
    expect(o.word).toMatchObject({ layout: 'flowing', images: false, structure: true })
  })

  it('fits images on pages', () => {
    expect(fitImagePage(300, 200, { pageSize: 'image', margin: 36, autoRotate: true })).toEqual({ pageWidth: 300, pageHeight: 200, scale: 1, x: 0, y: 0 })
    const big = fitImagePage(1224, 1584, { pageSize: 'letter', margin: 36, autoRotate: true })
    expect(big.pageWidth).toBe(612)
    expect(big.scale).toBeCloseTo(540 / 1224)
    // Never enlarged; centred.
    const small = fitImagePage(100, 50, { pageSize: 'letter', margin: 36, autoRotate: false })
    expect(small).toMatchObject({ scale: 1, x: 256, y: 371 })
    expect(fitImagePage(800, 400, { pageSize: 'a4', margin: 0, autoRotate: true }).pageWidth).toBeCloseTo(841.89)
  })

  it('sizes blank pages', () => {
    expect(blankSize({ preset: 'letter', width: 1, height: 1, unit: 'in', landscape: false, pages: 1 })).toEqual({ width: 612, height: 792 })
    expect(blankSize({ preset: 'letter', width: 1, height: 1, unit: 'in', landscape: true, pages: 1 })).toEqual({ width: 792, height: 612 })
    expect(blankSize({ preset: 'custom', width: 100, height: 50, unit: 'mm', landscape: true, pages: 1 })).toMatchObject({ width: expect.closeTo(283.46, 1) })
    expect(blankSize({ preset: 'custom', width: 0.5, height: 5, unit: 'in', landscape: false, pages: 1 })).toMatch(/at least 1 inch/)
  })
})
