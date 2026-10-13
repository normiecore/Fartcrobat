import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { Quad, Rect } from '@shared/geometry'
import { quadToRect, rectToQuad } from '@shared/geometry'
import type renderOps from '@engine/ops/render'
import type textOps from '@engine/ops/text'
import type { PageText } from '@engine/ops/text'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type ocrOps from '@features/ocr/engine'
import { effectiveDpi, samplePages } from '@features/ocr/engine'
import { CidEncoder, cidToGidMapFlate, glyphLessFontProgram } from '@features/ocr/glyphless'
import { OCR_MARK_KEY } from '@features/ocr/textLayer'
import type { OcrLine } from '@features/ocr/types'
import { searchPage } from '@renderer/document/textModel'
import { openFixture, roundTrip, type OpenedEngine } from './helpers'

const ocr = (e: OpenedEngine) => e.ops<typeof ocrOps>('ocr')
const text = (e: OpenedEngine) => e.ops<typeof textOps>('text')

/** Quads of each word box laid out left to right on one line (page space). */
function line(words: [string, Rect][]): OcrLine {
  return { words: words.map(([t, r]) => ({ text: t, quad: rectToQuad(r) })) }
}

/** Union of the character rectangles of the first occurrence of `word` on the page. */
function wordRect(t: PageText, word: string, from = 0): Rect | null {
  const i = t.text.indexOf(word, from)
  if (i < 0) return null
  let r: Rect | null = null
  for (let k = i; k < i + word.length; k++) {
    const q = Array.from(t.quads.slice(k * 8, k * 8 + 8)) as Quad
    const c = quadToRect(q)
    r = r ? [Math.min(r[0], c[0]), Math.min(r[1], c[1]), Math.max(r[2], c[2]), Math.max(r[3], c[3])] : c
  }
  return r
}

function charQuad(t: PageText, k: number): Quad {
  return Array.from(t.quads.slice(k * 8, k * 8 + 8)) as Quad
}

function expectRectClose(a: Rect | null, b: Rect, tol = 0.05) {
  expect(a).not.toBeNull()
  for (let i = 0; i < 4; i++) expect(Math.abs(a![i] - b[i])).toBeLessThan(tol)
}

async function pixels(e: OpenedEngine, page: number) {
  const r = await e.ops<typeof renderOps>('render').page(page, { scale: 1 })
  return r.pixels!
}

describe('glyphless font', () => {
  it('is a TrueType font MuPDF loads, with 500-unit glyphs', async () => {
    const mupdf = await import('mupdf')
    const program = glyphLessFontProgram()
    expect(program.length).toBeLessThan(1024)
    const font = new mupdf.Font('GlyphLessFont', program)
    expect(font.getName()).toContain('GlyphLessFont')
    expect(font.advanceGlyph(1)).toBeCloseTo(0.5, 5)
  })

  it('maps every CID to glyph 1', () => {
    const map = inflateSync(cidToGidMapFlate())
    expect(map.length).toBe(65536 * 2)
    for (let i = 0; i < map.length; i += 2) {
      if (map[i] !== 0 || map[i + 1] !== 1) throw new Error(`entry ${i / 2} is not 1`)
    }
  })

  it('encodes BMP characters as themselves and gives characters beyond it their own CIDs', () => {
    const enc = new CidEncoder()
    expect(enc.encode('Aé日')).toEqual([0x41, 0xe9, 0x65e5])
    const astral = enc.encode('😀x😀')
    expect(astral[0]).toBe(0xd800)
    expect(astral).toEqual([0xd800, 0x78, 0xd800])
    expect(enc.encode('\u0007a')).toEqual([0x61]) // control characters are dropped
    const cmap = enc.toUnicodeCMap()
    expect(cmap).toContain('<D800> <D83DDE00>')
    expect(cmap).toContain('<0000> <D7FF> <0000>')
  })
})

describe('ocr engine: invisible text layer', () => {
  it('adds invisible text whose words and quads match the given boxes', async () => {
    const e = await openFixture('scanned.pdf')
    const before = await pixels(e, 0)
    const res = await ocr(e).addTextLayer([
      {
        page: 0,
        language: 'eng',
        dpi: 300,
        lines: [
          line([
            ['Scanned', [72, 75, 153, 90]],
            ['Document', [163, 75, 260, 90]]
          ]),
          line([
            ['This', [72, 114, 111, 129]],
            ['page', [118, 114, 166, 133.5]]
          ])
        ]
      }
    ])
    expect(res).toEqual([{ page: 0, words: 4, skipped: 0 }])
    // One undoable, dirty step.
    expect(e.lastChanges?.journal.undoLabel).toBe('Recognize Text')
    expect(e.lastChanges?.dirty).toBe(true)
    expect(e.lastChanges?.pages).toEqual([0])
    const t = await text(e).page(0)
    expect(t.text).toBe('Scanned Document\nThis page\n')
    expectRectClose(wordRect(t, 'Scanned'), [72, 75, 153, 90])
    expectRectClose(wordRect(t, 'Document'), [163, 75, 260, 90])
    expectRectClose(wordRect(t, 'This'), [72, 114, 111, 129])
    expectRectClose(wordRect(t, 'page'), [118, 114, 166, 133.5])
    // The space fills the gap between the words, so a phrase highlight is continuous.
    const space = quadToRect(charQuad(t, 'Scanned'.length))
    expectRectClose(space, [153, 75, 163, 90])
    // Invisible: the page looks exactly the same.
    const after = await pixels(e, 0)
    expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).toBe(0)
  })

  it('is undoable and survives saving', async () => {
    const e = await openFixture('scanned.pdf')
    await ocr(e).addTextLayer([{ page: 0, lines: [line([['searchable', [72, 190, 193, 208]]])] }])
    expect(await text(e).plain(0)).toContain('searchable')
    await e.doc.undo()
    expect((await text(e).plain(0)).trim()).toBe('')
    await e.doc.redo()
    expect(await text(e).plain(0)).toContain('searchable')
    const saved = await roundTrip(e)
    const t = await text(saved).page(0)
    expect(t.text).toContain('searchable')
    expectRectClose(wordRect(t, 'searchable'), [72, 190, 193, 208])
    const status = await ocr(saved).status([0])
    expect(status[0]).toMatchObject({ hasOcrLayer: true, ocrChars: 10 })
  })

  it('fits text to rotated pages (/Rotate 90) in page space', async () => {
    const e = await openFixture('ocr/scanned-pages.pdf')
    expect(e.info.pages[1].rotation).toBe(90)
    await ocr(e).addTextLayer([
      {
        page: 1,
        lines: [
          line([
            ['Rotated', [72, 72, 150, 92]],
            ['Page', [158, 72, 205, 92]]
          ]),
          line([['sideways.', [300, 110, 390, 130]]])
        ]
      }
    ])
    const t = await text(e).page(1)
    expect(t.text).toBe('Rotated Page\nsideways.\n')
    expectRectClose(wordRect(t, 'Rotated'), [72, 72, 150, 92])
    expectRectClose(wordRect(t, 'Page'), [158, 72, 205, 92])
    expectRectClose(wordRect(t, 'sideways.'), [300, 110, 390, 130])
    // Characters run left to right as displayed.
    const r = quadToRect(charQuad(t, 0))
    const o = quadToRect(charQuad(t, 1))
    expect(o[0]).toBeGreaterThan(r[0])
  })

  it('follows skewed lines (rotated quads)', async () => {
    const e = await openFixture('scanned.pdf')
    // A word on a baseline rising 3° from (100, 300), 120pt long and 20pt tall.
    const a = (-3 * Math.PI) / 180
    const ux = Math.cos(a)
    const uy = Math.sin(a)
    const ll: [number, number] = [100, 300]
    const lr: [number, number] = [ll[0] + 120 * ux, ll[1] + 120 * uy]
    const up: [number, number] = [20 * uy, -20 * ux]
    const quad: Quad = [ll[0] + up[0], ll[1] + up[1], lr[0] + up[0], lr[1] + up[1], ll[0], ll[1], lr[0], lr[1]]
    await ocr(e).addTextLayer([{ page: 0, lines: [{ words: [{ text: 'Skewed', quad }] }] }])
    const t = await text(e).page(0)
    expect(t.text).toBe('Skewed\n')
    const first = charQuad(t, 0)
    const last = charQuad(t, 5)
    // ll of the first character and lr of the last are the corners of the word quad.
    expect(first[4]).toBeCloseTo(ll[0], 1)
    expect(first[5]).toBeCloseTo(ll[1], 1)
    expect(last[6]).toBeCloseTo(lr[0], 1)
    expect(last[7]).toBeCloseTo(lr[1], 1)
    expect(first[0]).toBeCloseTo(ll[0] + up[0], 1)
    expect(first[1]).toBeCloseTo(ll[1] + up[1], 1)
  })

  it('stores any script: Latin, Greek, Cyrillic, CJK, Arabic and characters beyond the BMP', async () => {
    const e = await openFixture('scanned.pdf')
    const words: [string, Rect][] = [
      ['Grüße', [72, 72, 130, 90]],
      ['Ελληνικά', [140, 72, 230, 90]],
      ['Привет', [240, 72, 310, 90]],
      ['日本語', [320, 72, 370, 90]],
      ['مرحبا', [380, 72, 430, 90]],
      ['𠀋😀', [440, 72, 480, 90]]
    ]
    await ocr(e).addTextLayer([{ page: 0, lines: [line(words)] }])
    // Plain text (UTF-8 from MuPDF) has every character, the astral ones included.
    const plain = await text(e).plain(0)
    for (const [w] of words.slice(0, 4)) expect(plain).toContain(w)
    expect(plain).toContain('𠀋😀')
    for (const ch of 'مرحبا') expect(plain).toContain(ch)
    const t = await text(e).page(0)
    expectRectClose(wordRect(t, 'Ελληνικά'), [140, 72, 230, 90])
    expectRectClose(wordRect(t, '日本語'), [320, 72, 370, 90])
    // Find (Ctrl+F) works on non-Latin text.
    expect(searchPage(t, 'привет')).toHaveLength(1)
    expect(searchPage(t, 'ελληνικά')).toHaveLength(1)
    expect(searchPage(t, '日本')).toHaveLength(1)
  })

  it('replaces an earlier OCR layer instead of adding a second one', async () => {
    const e = await openFixture('scanned.pdf')
    await ocr(e).addTextLayer([{ page: 0, lines: [line([['First', [72, 72, 120, 90]]])] }])
    await ocr(e).addTextLayer([{ page: 0, lines: [line([['Second', [72, 72, 130, 90]]])] }])
    expect((await text(e).plain(0)).trim()).toBe('Second')
    const pageObj = e.session.pdf.findPage(0)
    const contents = pageObj.get('Contents')
    let marks = 0
    const n = contents.isArray() ? contents.length : 1
    for (let i = 0; i < n; i++) {
      const c = contents.isArray() ? contents.get(i) : contents
      if (!c.get(OCR_MARK_KEY).isNull()) marks++
    }
    expect(marks).toBe(1)
    // Only one OCR font is left in the page's resources.
    const fonts: string[] = []
    pageObj.get('Resources').get('Font').forEach((_v, k) => fonts.push(String(k)))
    expect(fonts.filter((f) => f.startsWith('FcOCR'))).toHaveLength(1)
  })

  it('leaves out recognized words that lie on real text', async () => {
    const e = await openFixture('ocr/scanned-pages.pdf')
    const plainBefore = await text(e).plain(2)
    const realLine = (await text(e).page(2)).lines[0].bbox
    const res = await ocr(e).addTextLayer([
      {
        page: 2,
        lines: [
          line([['This', [realLine[0], realLine[1], realLine[0] + 40, realLine[3]]]]),
          line([['Stamp', [400, 600, 460, 620]]])
        ]
      }
    ])
    expect(res[0]).toEqual({ page: 2, words: 1, skipped: 1 })
    const plain = await text(e).plain(2)
    expect(plain).toContain('Stamp')
    expect(plain.split('This page already').length).toBe(plainBefore.split('This page already').length)
  })

  it('removes the recognized text and its font', async () => {
    const e = await openFixture('scanned.pdf')
    await ocr(e).addTextLayer([{ page: 0, lines: [line([['Gone', [72, 72, 120, 90]]])] }])
    expect(await ocr(e).removeTextLayer([0])).toEqual([0])
    expect(e.lastChanges?.journal.undoLabel).toBe('Remove Recognized Text')
    expect((await text(e).plain(0)).trim()).toBe('')
    const fonts: string[] = []
    const f = e.session.pdf.findPage(0).get('Resources').get('Font')
    if (!f.isNull()) f.forEach((_v, k) => fonts.push(String(k)))
    expect(fonts.some((k) => k.startsWith('FcOCR'))).toBe(false)
    // The image is still there.
    expect((await ocr(e).status([0]))[0].imageCoverage).toBeGreaterThan(0.9)
    expect(await ocr(e).removeTextLayer([0])).toEqual([])
  })

  it('keeps pages that share resources apart', async () => {
    const engine = await createLocalEngine()
    const mupdf = await import('mupdf')
    const pdf = new mupdf.PDFDocument()
    const res = pdf.addObject(pdf.newDictionary())
    for (let i = 0; i < 2; i++) pdf.insertPage(-1, pdf.addPage([0, 0, 300, 300], 0, res, ''))
    const bytes = pdf.saveToBuffer('').asUint8Array().slice()
    const r = await engine.ops<typeof docOps>('doc').open(bytes, { fileName: 'shared.pdf' })
    expect(r.ok).toBe(true)
    await engine.ops<typeof ocrOps>('ocr').addTextLayer([{ page: 0, lines: [line([['Only', [10, 10, 60, 30]]])] }])
    await engine.ops<typeof ocrOps>('ocr').removeTextLayer([0])
    await engine.ops<typeof ocrOps>('ocr').addTextLayer([{ page: 1, lines: [line([['Two', [10, 10, 60, 30]]])] }])
    const t = engine.ops<typeof textOps>('text')
    expect((await t.plain(0)).trim()).toBe('')
    expect((await t.plain(1)).trim()).toBe('Two')
    const fontsOf = (i: number) => {
      const out: string[] = []
      const f = engine.session.pdf.findPage(i).get('Resources').get('Font')
      if (!f.isNull()) f.forEach((_v, k) => out.push(String(k)))
      return out
    }
    expect(fontsOf(0)).toEqual([])
    expect(fontsOf(1)).toEqual(['FcOCR'])
  })

  it('rejects pages that do not exist', async () => {
    const e = await openFixture('scanned.pdf')
    await expect(ocr(e).addTextLayer([{ page: 3, lines: [] }])).rejects.toThrow(/Page 4 does not exist/)
  })
})

describe('ocr engine: page status and scan detection', () => {
  it('reports images, text and recognized text per page', async () => {
    const e = await openFixture('ocr/scanned-pages.pdf')
    const st = await ocr(e).status()
    expect(st.map((s) => s.page)).toEqual([0, 1, 2, 3])
    expect(st[0]).toMatchObject({ textChars: 0, hasOcrLayer: false })
    expect(st[0].imageCoverage).toBeGreaterThan(0.95)
    expect(st[1].imageCoverage).toBeGreaterThan(0.95)
    expect(st[2].textChars).toBeGreaterThan(40)
    expect(st[2].imageCoverage).toBe(0)
  })

  it('detects scanned documents from a sample of pages', async () => {
    expect(samplePages(1)).toEqual([0])
    expect(samplePages(2)).toEqual([0, 1])
    expect(samplePages(10)).toEqual([0, 4, 9])
    const scanned = await openFixture('scanned.pdf')
    expect((await ocr(scanned).detectScanned()).scanned).toBe(true)
    const textDoc = await openFixture('text.pdf')
    expect((await ocr(textDoc).detectScanned()).scanned).toBe(false)
    // Pages 1, 3 (middle, real text) and 4 are sampled: two of three look scanned.
    const mixed = await openFixture('ocr/scanned-pages.pdf')
    const d = await ocr(mixed).detectScanned()
    expect(d.sampled.map((s) => s.page)).toEqual([0, 1, 3])
    expect(d.scanned).toBe(true)
    // Once recognized, the document is no longer offered for recognition.
    await ocr(scanned).addTextLayer([{ page: 0, lines: [line([['Hello', [72, 72, 120, 90]]])] }])
    expect((await ocr(scanned).detectScanned()).scanned).toBe(false)
  })

  it('renders pages for recognition as grayscale PNG, capped for huge pages', async () => {
    const e = await openFixture('ocr/scanned-pages.pdf')
    const img = await ocr(e).renderPage(1, { dpi: 150 })
    // /Rotate 90: the image is the page as displayed (portrait).
    expect(img.width).toBe(1275)
    expect(img.height).toBe(1650)
    expect(img.dpi).toBe(150)
    expect(img.origin).toEqual([0, 0])
    expect(Array.from(img.png.slice(1, 4))).toEqual([0x50, 0x4e, 0x47])
    expect(img.png[25]).toBe(0) // colour type 0: grayscale
    expect(effectiveDpi(612, 792, 300)).toBe(300)
    // A 3 x 4 m poster is rendered at a lower resolution.
    const big = effectiveDpi(8504, 11339, 300)
    expect(big).toBeLessThan(60)
    expect(((8504 / 72) * big * (11339 / 72) * big) / 1e6).toBeLessThanOrEqual(36)
  })
})
