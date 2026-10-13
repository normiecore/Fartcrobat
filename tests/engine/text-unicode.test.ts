import { describe, expect, it } from 'vitest'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type textOps from '@engine/ops/text'
import {
  caretAt,
  charQuad,
  hitContext,
  rangeQuads,
  rangeRects,
  rangeText,
  searchPage,
  wordAt,
  type PageText,
  type SearchOptions
} from '@renderer/document/textModel'

// Codes 1-4 of a simple font map to characters outside the Basic Multilingual Plane through the
// ToUnicode CMap (UTF-16BE surrogate pairs), the way PDFs with emoji, math alphanumerics or CJK
// Extension B carry them: 1 = U+1F600 😀, 2 = U+1D400 𝐀, 3 = U+1D401 𝐁, 4 = U+2000B 𠀋.
const TO_UNICODE = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<00> <FF>
endcodespacerange
4 beginbfchar
<01> <D83DDE00>
<02> <D835DC00>
<03> <D835DC01>
<04> <D840DC0B>
endbfchar
1 beginbfrange
<20> <7E> <0020>
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end`

const CONTENT =
  'BT /F1 20 Tf 72 700 Td (Hi \\001 there) Tj 0 -30 Td (x\\002\\003y z) Tj 0 -30 Td (\\004\\004 end) Tj ET'

async function openAstral() {
  const mupdf = await import('mupdf')
  const pdf = new mupdf.PDFDocument()
  const font = pdf.addSimpleFont(new mupdf.Font('Helvetica'))
  font.put('ToUnicode', pdf.addStream(TO_UNICODE, {}))
  pdf.insertPage(-1, pdf.addPage([0, 0, 612, 792], 0, pdf.addObject({ Font: { F1: font } }), CONTENT))
  const bytes = pdf.saveToBuffer('').asUint8Array()
  const e = await createLocalEngine()
  await e.ops<typeof docOps>('doc').open(bytes, { fileName: 'astral.pdf' })
  return e
}

const astralPage = async () => (await openAstral()).ops<typeof textOps>('text').page(0)

const found = (t: PageText, query: string, opts?: SearchOptions) =>
  searchPage(t, query, opts).map((h) => rangeText(t, h.start, h.end))

describe('text outside the Basic Multilingual Plane', () => {
  it('extracts full code points, repeating the quad for both UTF-16 units', async () => {
    const text = (await openAstral()).ops<typeof textOps>('text')
    const t = await text.page(0)
    expect(t.text).toBe('Hi 😀 there\nx𝐀𝐁y z\n𠀋𠀋 end\n')
    expect(t.quads.length).toBe(t.text.length * 8)
    expect(t.lines.map((l) => t.text.slice(l.start, l.end))).toEqual(['Hi 😀 there', 'x𝐀𝐁y z', '𠀋𠀋 end'])
    expect(t.spans.map((s) => t.text.slice(s.start, s.end))).toEqual(['Hi 😀 there', 'x𝐀𝐁y z', '𠀋𠀋 end'])
    const i = t.text.indexOf('😀')
    const q = charQuad(t, i)
    expect(q[2]).toBeGreaterThan(q[0])
    expect(charQuad(t, i + 1)).toEqual(q)
    // the next character starts where the emoji ends
    expect(charQuad(t, i + 2)[0]).toBeCloseTo(q[2], 3)
    expect(await text.plain(0)).toContain('Hi 😀 there')
    expect((await text.all())[0]).toContain('𠀋𠀋 end')
  })

  it('finds them without splitting surrogate pairs', async () => {
    const t = await astralPage()
    expect(found(t, '😀')).toEqual(['😀'])
    expect(found(t, '𠀋')).toEqual(['𠀋', '𠀋'])
    expect(found(t, '𠀋', { wholeWords: true })).toEqual([])
    expect(found(t, '𠀋𠀋', { wholeWords: true })).toEqual(['𠀋𠀋'])
    expect(found(t, 'x𝐀', { wholeWords: true })).toEqual([])
    // math alphanumerics fold to plain letters, like ligatures
    expect(found(t, 'XAB')).toEqual(['x𝐀𝐁'])
    expect(found(t, 'x.', { regex: true })).toEqual(['x𝐀'])
    expect(found(t, '\\p{Extended_Pictographic}', { regex: true })).toEqual(['😀'])
    const [there] = searchPage(t, 'there')
    expect(hitContext(t, there, 2).before).toBe('😀 ')
    const [hi] = searchPage(t, 'Hi')
    expect(hitContext(t, hi, 2).after).toBe(' 😀')
  })

  it('selects them as whole characters', async () => {
    const t = await astralPage()
    const i = t.text.indexOf('😀')
    const q = charQuad(t, i)
    const y = (q[1] + q[5]) / 2
    expect(caretAt(t, [q[0] + 1, y])).toBe(i)
    expect(caretAt(t, [q[2] - 1, y])).toBe(i + 2)
    expect(wordAt(t, i)).toEqual({ start: i, end: i + 2 })
    expect(wordAt(t, i + 1)).toEqual({ start: i, end: i + 2 })
    const x = t.text.indexOf('x𝐀𝐁y')
    for (let k = x; k < x + 6; k++) expect(wordAt(t, k)).toEqual({ start: x, end: x + 6 })
    const [r] = rangeRects(t, i, i + 2)
    expect(r[0]).toBeCloseTo(q[0], 3)
    expect(r[2]).toBeCloseTo(q[2], 3)
    const [quad] = rangeQuads(t, x, x + 6)
    expect(quad[0]).toBeCloseTo(charQuad(t, x)[0], 3)
    expect(quad[2]).toBeCloseTo(charQuad(t, x + 5)[2], 3)
  })
})
