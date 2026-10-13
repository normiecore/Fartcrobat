import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type textOps from '@engine/ops/text'
import type ocrOps from '@features/ocr/engine'
import type { OcrLine, OcrPageResult } from '@features/ocr/types'
import { rectToQuad, type Rect } from '@shared/geometry'
import type exportOps from '../../src/features/export-create/engine'
import { runExport, type ExportEngine } from '../../src/features/export-create/exporter'
import { analyzeDocument, flowRuns, plainText, type LImage, type LParagraph, type LTable } from '../../src/features/export-create/layout'
import { eraseAreas } from '../../src/features/export-create/scan'
import { DEFAULT_EXPORT_OPTIONS, normalizeExportOptions, type ExportOptions } from '../../src/features/export-create/shared'
import { fixture, openFixture } from './helpers'

type Ops = typeof exportOps

async function contents(name: string, opts: { images?: boolean } = {}) {
  const e = await openFixture(name)
  const x = e.ops<Ops>('export-create')
  const out = []
  for (let i = 0; i < e.info.pageCount; i++) out.push(await x.content(i, { images: opts.images ?? true }))
  return out
}

async function exportFixture(name: string, patch: Partial<ExportOptions>, pages?: number[]) {
  const e = await openFixture(name)
  const engine = e.ops<Ops>('export-create') as unknown as ExportEngine
  const options = normalizeExportOptions({ ...DEFAULT_EXPORT_OPTIONS, ...patch })
  return runExport(engine, {
    options,
    pages: pages ?? Array.from({ length: e.info.pageCount }, (_, i) => i),
    title: 'Test',
    baseName: 'Test'
  })
}

async function fileOf(name: string, patch: Partial<ExportOptions>, pages?: number[]): Promise<Uint8Array> {
  const r = await exportFixture(name, patch, pages)
  if (r.kind !== 'file') throw new Error('expected one file')
  return r.data
}

const paragraphs = (els: { kind: string }[]) => els.filter((e): e is LParagraph => e.kind === 'paragraph')
const text = (p: LParagraph) => plainText(flowRuns(p.lines)).trim()

function soffice(): string | null {
  for (const p of ['/usr/bin/soffice', '/usr/bin/libreoffice', '/usr/local/bin/soffice', '/opt/homebrew/bin/soffice', '/Applications/LibreOffice.app/Contents/MacOS/soffice']) {
    if (existsSync(p)) return p
  }
  return null
}
const SOFFICE = soffice()

/** Converts an Office file back to PDF with LibreOffice and returns its text, page by page. */
async function roundTrip(bytes: Uint8Array, ext: string): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'fc-export-rt-'))
  const file = join(dir, `doc.${ext}`)
  writeFileSync(file, bytes)
  execFileSync(SOFFICE!, [`-env:UserInstallation=file://${join(dir, 'profile')}`, '--headless', '--norestore', '--convert-to', 'pdf', '--outdir', dir, file], {
    timeout: 120000,
    stdio: 'ignore'
  })
  const engine = await createLocalEngine()
  const res = await engine.ops<typeof docOps>('doc').open(new Uint8Array(readFileSync(join(dir, 'doc.pdf'))), { fileName: 'doc.pdf' })
  if (!res.ok) throw new Error('round trip PDF needs a password')
  const out: string[] = []
  for (let i = 0; i < res.info.pageCount; i++) out.push(await engine.ops<Ops>('export-create').text(i))
  return out
}

describe('layout analysis', () => {
  it('finds headings, lists, alignment, joined hyphenation, images and a ruled table', async () => {
    const layout = analyzeDocument(await contents('export-create/rich.pdf'))
    expect(layout.bodySize).toBe(11)
    const p0 = layout.pages[0].elements
    const paras = paragraphs(p0)
    const byText = (t: string) => paras.find((p) => text(p).startsWith(t))!
    expect(byText('Annual Report 2025')).toMatchObject({ role: 'heading', level: 1, align: 'center' })
    expect(byText('Introduction')).toMatchObject({ role: 'heading', level: 2 })
    expect(byText('Highlights')).toMatchObject({ role: 'heading', level: 3 })
    // A justified paragraph, its three lines joined into one.
    const intro = byText('This report summarises')
    expect(intro.align).toBe('justify')
    expect(intro.lines).toHaveLength(3)
    expect(text(intro)).toContain('the company opened two new offices')
    // "docu-" + "ment" is one word again.
    expect(text(byText('Our sustainability'))).toContain('the full document is available')
    const bullets = paras.filter((p) => p.list?.format === 'bullet')
    expect(bullets.map(text)).toEqual(['Record revenue in the third quarter', 'Two new offices opened', 'Customer satisfaction at 94%'])
    const numbered = paras.filter((p) => p.list?.format === 'decimal')
    expect(numbered.map((p) => p.list!.value)).toEqual([1, 2, 3])
    expect(numbered.map(text)).toEqual(['Review the budget', 'Approve the hiring plan', 'Publish the results'])
    expect(byText('Prepared by the finance team').align).toBe('right')
    const important = byText('Important')
    expect(important.lines[0].runs[0]).toMatchObject({ italic: true, color: 0xc0392b, family: 'Arial' })
    const img = p0.find((e): e is LImage => e.kind === 'image')!
    expect(img.image).toMatchObject({ width: 400, height: 200, mime: 'image/png' })
    // Reading order: the image comes before its caption.
    expect(p0.indexOf(img)).toBeLessThan(p0.indexOf(byText('Figure 1')))

    const table = layout.pages[1].elements.find((e): e is LTable => e.kind === 'table')!
    expect(table).toMatchObject({ rows: 5, cols: 4, ruled: true })
    const cell = (r: number, c: number) => table.cells.find((x) => x.row === r && x.col === c)!
    expect(text({ lines: cell(0, 2).lines } as LParagraph)).toBe('Revenue')
    expect(cell(1, 2).align).toBe('right')
    expect(cell(1, 0).align).toBe('left')
    expect(cell(0, 0).lines[0].runs[0].bold).toBe(true)
  })

  it('finds a table without borders from aligned columns', async () => {
    const layout = analyzeDocument(await contents('export-create/table.pdf'))
    const t = layout.pages[1].elements.find((e): e is LTable => e.kind === 'table')!
    expect(t).toMatchObject({ rows: 5, cols: 4, ruled: false })
    expect(t.cells.filter((c) => c.row === 2).map((c) => plainText(flowRuns(c.lines)))).toEqual(['Paper clips', 'A-200', '1.25', '3,400'])
  })

  it('keeps columns, charts, shading, underlines and links apart', async () => {
    const layout = analyzeDocument(await contents('export-create/complex.pdf'))
    const els = layout.pages[0].elements
    // Two text columns are two paragraphs, not a table; the right one is not indented.
    const paras = paragraphs(els)
    const left = paras.find((p) => text(p).startsWith('The left column'))!
    const right = paras.find((p) => text(p).startsWith('The right column'))!
    expect(left.lines.length).toBeGreaterThan(4)
    expect(right.indent).toBe(0)
    // The chart becomes a picture with its labels; its grid lines are not a table.
    const pictures = els.filter((e): e is LImage => e.kind === 'image' && !!e.render)
    expect(pictures).toHaveLength(1)
    expect(pictures[0].render!.text).toBe(true)
    expect(paras.some((p) => /^Q[1-4]/.test(text(p)))).toBe(false)
    const tables = els.filter((e): e is LTable => e.kind === 'table')
    expect(tables).toHaveLength(1)
    expect(tables[0]).toMatchObject({ rows: 4, cols: 3 })
    // The shaded header row.
    expect(tables[0].cells.filter((c) => c.row === 0).every((c) => c.fill === 0xdde7f7)).toBe(true)
    expect(tables[0].cells.filter((c) => c.row === 1).some((c) => c.fill !== undefined)).toBe(false)
    // The chart comes before the table in reading order.
    expect(els.indexOf(pictures[0])).toBeLessThan(els.indexOf(tables[0]))
    // Only "important" is underlined; the link keeps its address.
    const sentence = flowRuns(paras.find((p) => text(p).startsWith('This sentence'))!.lines)
    expect(sentence.filter((r) => r.underline).map((r) => r.text.trim())).toEqual(['important'])
    const terms = flowRuns(paras.find((p) => text(p).startsWith('Read the full terms'))!.lines)
    expect(terms.find((r) => r.link)).toMatchObject({ link: 'https://example.org/terms', underline: true, text: 'example.org/terms' })
  })

  it('reads a PDF made by Word/LibreOffice: Symbol bullets, numbered headings, ruled title, grid table', async () => {
    const layout = analyzeDocument(await contents('export-create/proposal.pdf'))
    const els = layout.pages[0].elements
    const paras = paragraphs(els)
    const byText = (t: string) => paras.find((p) => text(p).startsWith(t))!
    expect(byText('Project Proposal')).toMatchObject({ role: 'heading', level: 1 })
    expect(byText('Project Proposal').borderBottom).toBeDefined()
    // "1. Background" in larger type is a heading that keeps its number, not a list.
    expect(byText('1. Background')).toMatchObject({ role: 'heading', level: 2 })
    expect(byText('2.1 Milestones')).toMatchObject({ role: 'heading', level: 3 })
    expect(paras.filter((p) => p.list?.format === 'bullet').map(text)).toEqual(['Reduce costs by 20%', 'Ship the beta in March', 'Hire four engineers'])
    expect(paras.filter((p) => p.list?.format === 'bullet').every((p) => p.list!.marker === '•')).toBe(true)
    expect(paras.filter((p) => p.list?.format === 'decimal').map(text)).toEqual(['Design review', 'Prototype', 'Launch'])
    const table = els.find((e): e is LTable => e.kind === 'table')!
    expect(table).toMatchObject({ rows: 4, cols: 3, ruled: true })
    expect(layout.pages[1].elements.some((e) => e.kind === 'paragraph' && text(e).startsWith('3. Conclusion') && e.role === 'heading')).toBe(true)
    // The text's left edge is the margin even though the table borders stick out.
    expect(byText('Our team').indent).toBeLessThan(1)
  })

  it('exports a scanned page as a picture', async () => {
    const layout = analyzeDocument(await contents('scanned.pdf'))
    const els = layout.pages[0].elements
    expect(paragraphs(els)).toHaveLength(0)
    expect(els.filter((e) => e.kind === 'image')).toHaveLength(1)
  })
})

describe('Word export', () => {
  it('writes Chapter 1 as a heading and the lorem paragraphs, one page per PDF page', async () => {
    const bytes = await fileOf('text.pdf', { format: 'word' })
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toMatch(/<w:pStyle w:val="Heading1"\/>(?:(?!<\/w:p>).)*Chapter 1<\/w:t>/)
    for (let i = 2; i <= 5; i++) expect(xml).toContain(`Chapter ${i}`)
    expect(xml).toContain('Lorem ipsum dolor sit amet, consectetur adipiscing elit.')
    expect(xml.match(/<w:pageBreakBefore\/>/g)).toHaveLength(4)
    // Page size and the link.
    expect(xml).toMatch(/<w:pgSz w:w="12240" w:h="15840"/)
    expect(xml).toContain('<w:hyperlink')
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string')
    expect(rels).toContain('https://example.com')
  })

  it('writes lists as Word numbering, tables as Word tables and images as pictures', async () => {
    const zip = await JSZip.loadAsync(await fileOf('export-create/rich.pdf', { format: 'word' }))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml.match(/<w:numPr>/g)?.length).toBe(6)
    const numbering = await zip.file('word/numbering.xml')!.async('string')
    expect(numbering).toContain('w:val="bullet"')
    expect(numbering).toContain('w:val="decimal"')
    expect(numbering).toContain('%1.')
    expect(xml.match(/<w:tbl>/g)).toHaveLength(1)
    expect(xml.match(/<w:tr>|<w:tr /g)?.length).toBe(5)
    expect(xml).toContain('<w:jc w:val="both"/>')
    expect(xml).toContain('<w:jc w:val="right"/>')
    expect(Object.keys(zip.files).filter((f) => f.startsWith('word/media/') && !f.endsWith('/'))).toHaveLength(1)
  })

  it.skipIf(!SOFFICE)('opens in LibreOffice with the text intact (flowing text)', async () => {
    const pages = await roundTrip(await fileOf('text.pdf', { format: 'word' }), 'docx')
    expect(pages).toHaveLength(5)
    expect(pages[0]).toContain('Chapter 1')
    expect(pages[0]).toContain('Lorem ipsum dolor sit amet')
    expect(pages[4]).toContain('Chapter 5')
  })

  it.skipIf(!SOFFICE)('keeps the page layout in frames over a picture of the graphics', async () => {
    const bytes = await fileOf('export-create/rich.pdf', { format: 'word', word: { ...DEFAULT_EXPORT_OPTIONS.word, layout: 'page' } })
    const zip = await JSZip.loadAsync(bytes)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('<w:framePr')
    expect(xml).toContain('behindDoc="1"')
    const pages = await roundTrip(bytes, 'docx')
    expect(pages).toHaveLength(2)
    expect(pages[0]).toContain('Annual Report 2025')
    expect(pages[0]).toContain('Prepared by the finance team')
    expect(pages[1]).toContain('Regional Results')
    expect(pages[1]).toContain('$15,750.25')
  })
})

describe('Excel export', () => {
  it('writes table cells as numbers with their formats, one sheet per page', async () => {
    const zip = await JSZip.loadAsync(await fileOf('export-create/table.pdf', { format: 'excel' }))
    const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))
    expect(sheets).toHaveLength(2)
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await fileOf('export-create/table.pdf', { format: 'excel' })) as any)
    const ws = wb.getWorksheet('Page 1')!
    const row = (text: string) => {
      let found: any = null
      ws.eachRow((r) => {
        if (r.getCell(1).value === text) found = r
      })
      return found
    }
    const north = row('North')
    expect(north.getCell(2).value).toBe(1250)
    expect(north.getCell(2).numFmt).toBe('#,##0')
    expect(north.getCell(3).value).toBe(12500)
    expect(north.getCell(3).numFmt).toBe('"$"#,##0.00')
    expect(north.getCell(4).value).toBeCloseTo(0.055)
    expect(row('West').getCell(4).value).toBeCloseTo(-0.034)
    expect(row('Region').getCell(2).font?.bold).toBe(true)
    expect(row('Region').getCell(2).border?.top?.style).toBe('thin')
    const supplies = wb.getWorksheet('Page 2')!
    let stapler: any = null
    supplies.eachRow((r) => {
      if (r.getCell(1).value === 'Stapler') stapler = r
    })
    expect(stapler.getCell(2).value).toBe('A-100')
    expect(stapler.getCell(3).value).toBeCloseTo(7.99)
  })

  it('combines all pages into one sheet when asked', async () => {
    const zip = await JSZip.loadAsync(await fileOf('export-create/table.pdf', { format: 'excel', excel: { combine: true, numbers: false } }))
    expect(Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))).toHaveLength(1)
    const shared = await zip.file('xl/sharedStrings.xml')!.async('string')
    // Numbers stay text when number conversion is off.
    expect(shared).toContain('$12,500.00')
    expect(shared).toContain('Office Supplies')
  })
})

describe('PowerPoint export', () => {
  it('makes one slide per page with editable text over the page picture', async () => {
    const zip = await JSZip.loadAsync(await fileOf('text.pdf', { format: 'powerpoint' }))
    const slides = Object.keys(zip.files).filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
    expect(slides).toHaveLength(5)
    const s1 = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(s1).toContain('Chapter 1')
    expect(s1).toContain('<p:pic>')
    const pres = await zip.file('ppt/presentation.xml')!.async('string')
    // 8.5 x 11 in slides.
    expect(pres).toMatch(/<p:sldSz cx="7772400" cy="10058400"/)
  })

  it('makes picture-only slides', async () => {
    const zip = await JSZip.loadAsync(await fileOf('text.pdf', { format: 'powerpoint', powerpoint: { mode: 'image' } }, [0, 1]))
    const s1 = await zip.file('ppt/slides/slide1.xml')!.async('string')
    expect(s1).not.toContain('Chapter 1')
    expect(Object.keys(zip.files).filter((f) => f.startsWith('ppt/media/') && !f.endsWith('/'))).toHaveLength(2)
  })
})

describe('Image export', () => {
  it('renders PNG pages at the chosen resolution, named like Acrobat', async () => {
    const r = await exportFixture('text.pdf', { format: 'image', image: { ...DEFAULT_EXPORT_OPTIONS.image, format: 'png', dpi: 150 } }, [0, 2])
    if (r.kind !== 'images') throw new Error('expected images')
    expect(r.files.map((f) => f.name)).toEqual(['Test_Page_1.png', 'Test_Page_3.png'])
    const png = Buffer.from(r.files[0].data)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1275, 1650])
  })

  it('renders grayscale JPEG pages', async () => {
    const r = await exportFixture('export-create/rich.pdf', { format: 'image', image: { ...DEFAULT_EXPORT_OPTIONS.image, format: 'jpeg', dpi: 72, grayscale: true, quality: 70 } }, [0])
    if (r.kind !== 'images') throw new Error('expected images')
    expect(r.files[0].name).toBe('Test_Page_1.jpg')
    const d = r.files[0].data
    expect([d[0], d[1]]).toEqual([0xff, 0xd8])
    // The frame header (SOFn): precision, height, width, components (1 = gray)
    const b = Buffer.from(d)
    let at = 2
    while (at < b.length && !(b[at] === 0xff && b[at + 1] >= 0xc0 && b[at + 1] <= 0xc2)) at += 2 + b.readUInt16BE(at + 2)
    expect(b.readUInt16BE(at + 5)).toBe(792)
    expect(b.readUInt16BE(at + 7)).toBe(612)
    expect(b[at + 9]).toBe(1)
  })

  it('writes a multi-page TIFF (Deflate with predictor, or uncompressed)', async () => {
    for (const compression of ['deflate', 'none'] as const) {
      const data = await fileOf('text.pdf', { format: 'image', image: { ...DEFAULT_EXPORT_OPTIONS.image, format: 'tiff', dpi: 72, compression } }, [0, 1])
      const b = Buffer.from(data)
      expect(b.subarray(0, 4)).toEqual(Buffer.from([0x49, 0x49, 42, 0]))
      const ifds: Record<number, number[]>[] = []
      let off = b.readUInt32LE(4)
      while (off) {
        const n = b.readUInt16LE(off)
        const tags: Record<number, number[]> = {}
        for (let i = 0; i < n; i++) {
          const e = off + 2 + i * 12
          const tag = b.readUInt16LE(e)
          const type = b.readUInt16LE(e + 2)
          const count = b.readUInt32LE(e + 4)
          tags[tag] = type === 3 && count <= 2 ? [b.readUInt16LE(e + 8), b.readUInt16LE(e + 10)].slice(0, count) : [b.readUInt32LE(e + 8)]
        }
        ifds.push(tags)
        off = b.readUInt32LE(off + 2 + n * 12)
      }
      expect(ifds).toHaveLength(2)
      expect(ifds[0][256][0]).toBe(612)
      expect(ifds[0][257][0]).toBe(792)
      expect(ifds[1][297]).toEqual([1, 2])
      expect(ifds[0][259][0]).toBe(compression === 'deflate' ? 8 : 1)
      const strip = b.subarray(ifds[0][273][0], ifds[0][273][0] + ifds[0][279][0])
      const raw = compression === 'deflate' ? inflateSync(strip) : strip
      expect(raw.length).toBe(612 * 792 * 3)
      // The top-left pixel of the page is white.
      expect([raw[0], raw[1], raw[2]]).toEqual([255, 255, 255])
    }
  })
})

describe('HTML and text export', () => {
  it('writes every page with its exact layout, graphics as a picture behind the text', async () => {
    const html = new TextDecoder().decode(await fileOf('export-create/rich.pdf', { format: 'html' }))
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html.match(/<div id="page\d+" class="page"/g)).toHaveLength(2)
    expect(html).toContain('Annual Report 2025')
    expect(html).toMatch(/<img class="background" alt="" src="data:image\/(png|jpeg);base64,/)
    const plain = new TextDecoder().decode(await fileOf('text.pdf', { format: 'html', html: { layout: 'page', images: false } }))
    expect(plain).not.toContain('<img')
  })

  it('writes a reflowable page with headings, lists and tables', async () => {
    const html = new TextDecoder().decode(await fileOf('export-create/rich.pdf', { format: 'html', html: { layout: 'flowing', images: true } }))
    expect(html).toMatch(/<h1[^>]*>.*Annual Report 2025.*<\/h1>/)
    expect(html).toMatch(/<ul><li>.*Record revenue in the third quarter/)
    expect(html).toMatch(/<ol><li>.*Review the budget/)
    expect(html).toContain('<table class="ruled">')
    expect(html).toContain('<img src="data:image/png;base64,')
    expect(html).toContain('the full document is available')
  })

  it('writes plain text, with form feeds between pages when asked', async () => {
    const lines = new TextDecoder().decode(await fileOf('text.pdf', { format: 'text', text: { layout: 'lines', pageBreaks: true } }))
    const pages = lines.split('\f')
    expect(pages).toHaveLength(5)
    expect(pages[0]).toContain('Chapter 1')
    expect(pages[4]).toContain('Chapter 5')
    const paras = new TextDecoder().decode(await fileOf('export-create/rich.pdf', { format: 'text', text: { layout: 'paragraphs', pageBreaks: false } }))
    expect(paras).toContain('This report summarises the results of the past year. Revenue grew in every region, and the company opened')
    expect(paras).toContain('• Two new offices opened')
    expect(paras).toContain('Region\tUnits\tRevenue\tGrowth')
    expect(paras).not.toContain('\f')
  })
})

describe('form fields and comments', () => {
  it('exports what was typed into form fields', async () => {
    const e = await openFixture('form.pdf')
    const forms = e.ops<typeof import('@engine/ops/forms').default>('forms')
    const field = (await forms.list(0)).find((f) => f.name === 'fullName')!
    await forms.setValue(field.id, 'Jane Q. Public')
    const engine = e.ops<Ops>('export-create') as unknown as ExportEngine
    const run = (patch: Partial<ExportOptions>) =>
      runExport(engine, { options: normalizeExportOptions({ ...DEFAULT_EXPORT_OPTIONS, ...patch }), pages: [0], title: 'T', baseName: 'T' })
    const txt = await run({ format: 'text' })
    if (txt.kind !== 'file') throw new Error('file expected')
    expect(new TextDecoder().decode(txt.data)).toContain('Jane Q. Public')
    const docx = await run({ format: 'word' })
    if (docx.kind !== 'file') throw new Error('file expected')
    const xml = await (await JSZip.loadAsync(docx.data)).file('word/document.xml')!.async('string')
    expect(xml).toContain('Jane Q. Public')
  })
})

describe('Word comments', () => {
  it('turns the PDF comments and their replies into Word comments on their paragraphs', async () => {
    const e = await openFixture('text.pdf')
    const annots = e.ops<typeof import('@engine/ops/annots').default>('annots')
    const note = await annots.create(0, { type: 'Text', rect: [200, 70, 220, 90], contents: 'Is this the right title?', author: 'Ana' })
    await annots.reply(note.id, 'Yes, keep it.', 'Ben')
    await annots.create(0, { type: 'Highlight', quads: [[72, 150, 400, 150, 72, 165, 400, 165]], contents: 'Check these numbers', author: 'Ana' })
    const engine = e.ops<Ops>('export-create') as unknown as ExportEngine
    const run = async (comments: boolean) => {
      const r = await runExport(engine, {
        options: normalizeExportOptions({ ...DEFAULT_EXPORT_OPTIONS, format: 'word', word: { ...DEFAULT_EXPORT_OPTIONS.word, comments } }),
        pages: [0],
        title: 'T',
        baseName: 'T'
      })
      if (r.kind !== 'file') throw new Error('file expected')
      return JSZip.loadAsync(r.data)
    }
    const zip = await run(true)
    const xml = await zip.file('word/comments.xml')!.async('string')
    expect(xml).toContain('Is this the right title?')
    expect(xml).toContain('w:author="Ana"')
    expect(xml).toContain('Yes, keep it.')
    expect(xml).toContain('w:author="Ben"')
    expect(xml).toContain('Check these numbers')
    expect(zip.file('word/commentsExtended.xml')).not.toBeNull()
    const doc = await zip.file('word/document.xml')!.async('string')
    // The note sits next to the heading; the highlight on the lorem paragraph.
    expect(doc).toMatch(/<w:commentRangeStart w:id="0"\/>(?:(?!<\/w:p>).)*Chapter 1/)
    expect(doc).toMatch(/<w:commentRangeStart w:id="2"\/>(?:(?!<\/w:p>).)*Lorem ipsum/)
    const plain = await run(false)
    expect(plain.file('word/comments.xml')).toBeNull()
    if (SOFFICE) {
      // Word documents with comments open in LibreOffice.
      const pages = await roundTrip(await zip.generateAsync({ type: 'uint8array' }), 'docx')
      expect(pages[0]).toContain('Chapter 1')
    }
  })
})

describe('export runs', () => {
  it('stops between pages when cancelled and reports progress', async () => {
    const e = await openFixture('text.pdf')
    const engine = e.ops<Ops>('export-create') as unknown as ExportEngine
    const seen: string[] = []
    let calls = 0
    await expect(
      runExport(engine, {
        options: normalizeExportOptions({ ...DEFAULT_EXPORT_OPTIONS, format: 'word' }),
        pages: [0, 1, 2, 3, 4],
        title: 'T',
        baseName: 'T',
        onProgress: (_f, m) => seen.push(m),
        isCancelled: () => ++calls > 3
      })
    ).rejects.toThrow('Export cancelled')
    expect(seen[0]).toBe('Reading page 1 of 5…')
    expect(seen).not.toContain('Reading page 5 of 5…')
  })

  it('reports pages too large for the chosen resolution in plain words', async () => {
    const engine = await createLocalEngine()
    const bytes = await engine.ops<Ops>('export-create').build([{ kind: 'blank', width: 14400, height: 14400, count: 1 }])
    const res = await engine.ops<typeof docOps>('doc').open(bytes, { fileName: 'huge.pdf' })
    expect(res.ok).toBe(true)
    await expect(engine.ops<Ops>('export-create').image(0, { dpi: 600, format: 'png' })).rejects.toThrow('Page 1 is too large to export at 600 dpi')
  })
})

describe('Create a PDF', () => {
  async function build(parts: Parameters<ReturnType<typeof createOps>['build']>[0], opts: Parameters<ReturnType<typeof createOps>['build']>[1] = {}) {
    const engine = await createLocalEngine()
    const bytes = await createOps(engine).build(parts, opts)
    const res = await engine.ops<typeof docOps>('doc').open(bytes, { fileName: 'new.pdf' })
    if (!res.ok) throw new Error('needs password')
    return { engine, info: res.info }
  }
  function createOps(engine: Awaited<ReturnType<typeof createLocalEngine>>) {
    return engine.ops<Ops>('export-create')
  }

  it('combines an image and a PDF into one document', async () => {
    const { info } = await build([
      { kind: 'file', name: 'scan.png', data: fixture('scan.png') },
      { kind: 'file', name: 'compare-a.pdf', data: fixture('compare-a.pdf') }
    ])
    expect(info.pageCount).toBe(2)
    // The image page is the size of the image at its resolution (96 dpi).
    expect(info.pages[0].width).toBeCloseTo(956.25, 1)
    expect(info.pages[0].height).toBeCloseTo(1237.5, 1)
    expect(info.metadata.creator).toBe('Fartcrobat')
  })

  it('fits images on Letter or A4 pages inside the margins, landscape for wide images', async () => {
    const { engine, info } = await build([{ kind: 'file', name: 'scan.png', data: fixture('scan.png') }], {
      image: { pageSize: 'letter', margin: 36, autoRotate: true }
    })
    expect([info.pages[0].width, info.pages[0].height]).toEqual([612, 792])
    const c = await createOps(engine).content(0, { images: true })
    const img = c.images[0]
    expect(img.x0).toBeGreaterThanOrEqual(35.9)
    expect(img.y0).toBeGreaterThanOrEqual(35.9)
    expect(img.y1).toBeLessThanOrEqual(756.1)
    // A wide picture turns the page to landscape.
    const m = await import('mupdf')
    const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, 1600, 800], false)
    pix.clear(180)
    const wide = await build([{ kind: 'file', name: 'wide.png', data: pix.asPNG().slice() }], { image: { pageSize: 'a4', margin: 18, autoRotate: true } })
    expect(wide.info.pages[0].width).toBeCloseTo(841.89, 1)
    expect(wide.info.pages[0].height).toBeCloseTo(595.28, 1)
  })

  it('makes blank pages and text pages', async () => {
    const blank = await build([{ kind: 'blank', width: 595.28, height: 841.89, count: 3 }], { title: 'Untitled' })
    expect(blank.info.pageCount).toBe(3)
    expect(blank.info.pages[2].width).toBeCloseTo(595.28, 1)
    expect(blank.info.metadata.title).toBe('Untitled')
    const txt = await build([{ kind: 'file', name: 'Clipboard.txt', data: new TextEncoder().encode('Copied text\nSecond line') }])
    expect(txt.info.pageCount).toBe(1)
    expect(await createOps(txt.engine).text(0)).toContain('Copied text')
  })

  it('asks for the password of a protected PDF', async () => {
    const engine = await createLocalEngine()
    const ops = createOps(engine)
    const part = { kind: 'file' as const, name: 'encrypted.pdf', data: fixture('encrypted.pdf') }
    await expect(ops.build([part])).rejects.toMatchObject({ code: 'NEEDS_PASSWORD' })
    await expect(ops.build([{ ...part, password: 'nope' }])).rejects.toMatchObject({ code: 'WRONG_PASSWORD' })
    const bytes = await ops.build([{ ...part, password: 'secret' }])
    expect(bytes.length).toBeGreaterThan(200)
  })

  it('refuses to build nothing', async () => {
    const engine = await createLocalEngine()
    await expect(createOps(engine).build([])).rejects.toThrow(/Nothing to create/)
  })
})

// ---- scans with recognized text ------------------------------------------------------------

/**
 * A "scan" of a fixture (its pages as 150 dpi pictures) with the invisible text layer Recognize
 * Text writes over it. As from Tesseract, every word of a line is boxed from the top of the line's
 * tallest letters to the bottom of its lowest ones. `keep` leaves lines unread.
 */
async function recognizedScan(name: string, keep: (line: string, page: number) => boolean = () => true) {
  const src = await openFixture(name)
  const x = src.ops<Ops>('export-create')
  const t = src.ops<typeof textOps>('text')
  const parts = []
  const results: OcrPageResult[] = []
  for (let p = 0; p < src.info.pageCount; p++) {
    parts.push({ kind: 'file' as const, name: `page${p + 1}.png`, data: await x.image(p, { dpi: 150, format: 'png' }) })
    const typeset = (await x.content(p, { images: false })).lines
    const pt = await t.page(p)
    const lines: OcrLine[] = []
    for (const [start, text] of pt.text.split('\n').reduce<[number, string][]>((acc, l) => {
      const from = acc.length ? acc[acc.length - 1][0] + acc[acc.length - 1][1].length + 1 : 0
      return [...acc, [from, l]]
    }, [])) {
      if (!text.trim() || !keep(text, p)) continue
      const words: { text: string; rect: Rect }[] = []
      const re = /\S+/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const xs: number[] = []
        const ys: number[] = []
        for (let k = start + m.index; k < start + m.index + m[0].length; k++) {
          const q = pt.quads.slice(k * 8, k * 8 + 8)
          xs.push(q[0], q[2], q[4], q[6])
          ys.push(q[1], q[3], q[5], q[7])
        }
        words.push({ text: m[0], rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] })
      }
      const cy = (words[0].rect[1] + words[0].rect[3]) / 2
      const line = typeset.find((l) => cy >= l.y0 - 1 && cy <= l.y1 + 1)!
      const top = line.baseline - (/[A-Z0-9bdfhklt$%()]/.test(text) ? 0.72 : 0.5) * line.size
      const bottom = line.baseline + (/[gjpqy()]/.test(text) ? 0.21 : /[,;]/.test(text) ? 0.15 : 0) * line.size
      lines.push({ words: words.map((w) => ({ text: w.text, quad: rectToQuad([w.rect[0], top, w.rect[2], bottom]) })) })
    }
    results.push({ page: p, lines })
  }
  const engine = await createLocalEngine()
  const bytes = await engine.ops<Ops>('export-create').build(parts, { image: { pageSize: 'image', margin: 0, autoRotate: false } })
  const res = await engine.ops<typeof docOps>('doc').open(bytes, { fileName: 'scan.pdf' })
  if (!res.ok) throw new Error('scan needs a password')
  await engine.ops<typeof ocrOps>('ocr').addTextLayer(results)
  const ops = engine.ops<Ops>('export-create')
  const pages = Array.from({ length: res.info.pageCount }, (_, i) => i)
  const run = async (patch: Partial<ExportOptions>) => {
    const r = await runExport(ops as unknown as ExportEngine, { options: normalizeExportOptions({ ...DEFAULT_EXPORT_OPTIONS, ...patch }), pages, title: 'Scan', baseName: 'Scan' })
    if (r.kind !== 'file') throw new Error('expected one file')
    return r.data
  }
  return { ops, pages, run, original: x }
}

const overlapShare = (a: Rect, b: Rect) =>
  (Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))) / ((b[2] - b[0]) * (b[3] - b[1]))

describe('scans with recognized text', () => {
  it('reads the recognized text with its sizes, the ruled lines and the pictures of the scan', async () => {
    const scan = await recognizedScan('export-create/rich.pdf')
    const page1 = await scan.ops.content(0, { images: true })
    // The scan is not an image of the page: its text is the page's text.
    expect(page1.images).toHaveLength(0)
    expect(page1.erase!.length).toBeGreaterThan(15)
    const line = (start: string) => page1.lines.find((l) => l.segments.map((sg) => sg.runs.map((r) => r.text).join('')).join(' ').startsWith(start))!
    expect(line('Annual Report 2025').size).toBeCloseTo(26, -0.5)
    expect(line('This report summarises').size).toBeCloseTo(11, 0)
    // Times in the original: serif text.
    expect(line('This report summarises').segments[0].runs[0].flags & 8).toBe(8)
    // The chart (an image in the original) is cut out of the scan as a picture.
    const chart = (await scan.original.content(0, { images: false })).images[0]
    const pictures = page1.drawings.filter((d) => d.scan)
    // (the bars and the axis: the image's white margins are paper).
    const box: Rect = [chart.x0, chart.y0, chart.x1, chart.y1]
    expect(pictures.filter((d) => overlapShare(box, [d.x0, d.y0, d.x1, d.y1]) > 0.98 && overlapShare([d.x0, d.y0, d.x1, d.y1], box) > 0.6)).toHaveLength(1)
    // Page 2: the table's borders, found on the scan, make a table of the recognized cells again.
    const layout = analyzeDocument(await Promise.all(scan.pages.map((p) => scan.ops.content(p, { images: false }))))
    const table = layout.pages[1].elements.find((e): e is LTable => e.kind === 'table')!
    expect(table).toMatchObject({ rows: 5, cols: 4, ruled: true })
  })

  it('exports the text once: no picture of the scan under it', async () => {
    const scan = await recognizedScan('export-create/rich.pdf')
    // Word, flowing: paragraphs, the chart as the only picture, the table as a Word table.
    const zip = await JSZip.loadAsync(await scan.run({ format: 'word' }))
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('This report summarises the results of the past year.')
    expect(xml.match(/<w:tbl>/g)).toHaveLength(1)
    expect(xml).toContain('$12,500.00')
    const media = Object.keys(zip.files).filter((f) => f.startsWith('word/media/') && !f.endsWith('/'))
    expect(media).toHaveLength(1)
    // Text: each sentence once.
    const plain = new TextDecoder().decode(await scan.run({ format: 'text', text: { pageBreaks: false, layout: 'paragraphs' } }))
    expect(plain.match(/Thank you for reading/g)).toHaveLength(1)
    // HTML with the exact layout: the text in real fonts at one size per line, over the scan
    // without its text.
    const html = new TextDecoder().decode(await scan.run({ format: 'html' }))
    expect(html).not.toContain('GlyphLessFont')
    expect(html).toContain('This report summarises the results of the past year.')
    expect(html.match(/class="background"/g)).toHaveLength(2)
  })

  it('keeps what the recognition did not read: an unread table becomes a picture of the table', async () => {
    const scan = await recognizedScan('export-create/rich.pdf', (line, page) => page !== 1 || /Regional Results|Thank you/.test(line))
    const page2 = await scan.ops.content(1, { images: false })
    const tableBox: Rect = [72, 90, 513, 203]
    expect(page2.drawings.some((d) => d.scan && overlapShare([d.x0, d.y0, d.x1, d.y1], tableBox) > 0.95)).toBe(true)
    // Its borders are in that picture, not an empty table.
    expect(page2.rules.filter((r) => overlapShare([r.x0, r.y0 - 0.5, r.x1, r.y1 + 0.5], tableBox) > 0.5)).toHaveLength(0)
    expect(page2.lines.map((l) => l.segments.map((sg) => sg.runs.map((r) => r.text).join('')).join(' '))).toEqual(['Regional Results', 'Thank you for reading.'])
  })

  it('sizes the words of scanned-pages.pdf and leaves the scan out of Word', async () => {
    const e = await openFixture('ocr/scanned-pages.pdf')
    const json = JSON.parse(readFileSync(join(__dirname, '../fixtures/ocr/scanned-pages.json'), 'utf8')) as { words: Record<string, { text: string; rect: Rect }[]> }
    // Each line's words boxed as Tesseract does (to the line's height).
    const lines: OcrLine[] = []
    for (const w of json.words[0]) {
      const last = lines[lines.length - 1]
      if (last && Math.abs(last.words[0].quad[5] - w.rect[3]) < 8) last.words.push({ text: w.text, quad: rectToQuad(w.rect) })
      else lines.push({ words: [{ text: w.text, quad: rectToQuad(w.rect) }] })
    }
    for (const l of lines) {
      const top = Math.min(...l.words.map((w) => w.quad[1]))
      const bottom = Math.max(...l.words.map((w) => w.quad[5]))
      for (const w of l.words) w.quad = rectToQuad([w.quad[0], top, w.quad[2], bottom])
    }
    await e.ops<typeof ocrOps>('ocr').addTextLayer([{ page: 0, lines }])
    const c = await e.ops<Ops>('export-create').content(0, { images: true })
    // DejaVu Sans, 40 px at 150 dpi: 19.2 pt.
    for (const l of c.lines) expect(Math.abs(l.size - 19.2)).toBeLessThan(1.6)
    expect(c.images).toHaveLength(0)
    const engine = e.ops<Ops>('export-create') as unknown as ExportEngine
    const r = await runExport(engine, { options: normalizeExportOptions({ ...DEFAULT_EXPORT_OPTIONS, format: 'word' }), pages: [0], title: 'Scan', baseName: 'Scan' })
    const zip = await JSZip.loadAsync((r as { data: Uint8Array }).data)
    expect(Object.keys(zip.files).filter((f) => f.startsWith('word/media/') && !f.endsWith('/'))).toHaveLength(0)
    const xml = await zip.file('word/document.xml')!.async('string')
    expect(xml).toContain('Revenue grew in every region.')
    expect(xml).not.toContain('GlyphLess')
  })

  it('paints erased areas with the colour around them', async () => {
    const mupdf = await import('mupdf')
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false)
    pix.clear(255)
    const px = pix.getPixels()
    // Cream paper with a dark word in the middle.
    for (let i = 0; i < px.length; i += 3) px.set([250, 240, 200], i)
    for (let y = 8; y < 12; y++) for (let x = 10; x < 30; x++) px.set([20, 20, 20], (y * 40 + x) * 3)
    // Page space at 144 dpi: the word is at 5..15 x 4..6 points.
    eraseAreas(pix, [[4.5, 3.5, 15.5, 6.5]], 2, [0, 0])
    const after = pix.getPixels()
    expect(Array.from(after.slice((10 * 40 + 20) * 3, (10 * 40 + 20) * 3 + 3))).toEqual([250, 240, 200])
    pix.destroy()
  })
})
