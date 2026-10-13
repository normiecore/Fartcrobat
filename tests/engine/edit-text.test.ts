import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type formOps from '@engine/ops/forms'
import type navOps from '@engine/ops/nav'
import type renderOps from '@engine/ops/render'
import type textOps from '@engine/ops/text'
import type ops from '@features/edit-text/engine'
import type { Run, TextBlockInfo, TextEdit } from '@features/edit-text/model'
import type marksOps from '@features/page-marks/engine'
import {
  defaultHeaderFooter,
  defaultWatermark,
  type FontSpec,
  type HeaderFooterSettings,
  type WatermarkSettings
} from '@features/page-marks/shared'
import { openFixture, roundTrip, type OpenedEngine } from './helpers'

const tools = (e: OpenedEngine) => ({
  edit: e.ops<typeof ops>('edit-text'),
  text: e.ops<typeof textOps>('text'),
  render: e.ops<typeof renderOps>('render')
})

function editOf(b: TextBlockInfo, runs: Run[] | string, patch: Partial<TextEdit> = {}): TextEdit {
  return {
    source: { start: b.start, end: b.end, check: b.text },
    frame: b.frame,
    runs: typeof runs === 'string' ? [{ ...b.runs[0], text: runs }] : runs,
    align: b.align,
    lineSpacing: b.lineSpacing,
    wrap: b.wrap,
    ascent: b.ascent,
    ...patch
  }
}

function newText(origin: [number, number], runs: Run[], patch: Partial<TextEdit> = {}): TextEdit {
  return {
    source: null,
    frame: { origin, dir: [1, 0], width: 200 },
    runs,
    align: 'left',
    lineSpacing: 1.2,
    wrap: false,
    ascent: 0.9,
    ...patch
  }
}

const style = { font: 'Helvetica', size: 12, color: '#000000', bold: false, italic: false, underline: false }

async function block(e: OpenedEngine, page: number, startsWith: string): Promise<TextBlockInfo> {
  const b = (await tools(e).edit.analyze(page)).find((x) => x.text.startsWith(startsWith))
  if (!b) throw new Error(`no block starting with ${startsWith}`)
  return b
}

/** The line of page text containing `needle`, with its characters' quads. */
async function lineWith(e: OpenedEngine, page: number, needle: string) {
  const t = await tools(e).text.page(page)
  const at = t.text.indexOf(needle)
  if (at < 0) return null
  const line = t.lines.find((l) => l.start <= at && l.end > at)!
  return {
    text: t.text.slice(line.start, line.end),
    quads: [...t.quads.slice(line.start * 8, line.end * 8)],
    line
  }
}

describe('edit-text: finding paragraphs', () => {
  it('groups lines into paragraphs with fonts, alignment and spacing', async () => {
    const e = await openFixture('text.pdf')
    const blocks = await tools(e).edit.analyze(0)
    const heading = blocks.find((b) => b.text === 'Chapter 1')!
    expect(heading.wrap).toBe(false)
    expect(heading.runs).toHaveLength(1)
    expect(heading.runs[0]).toMatchObject({
      font: 'Helvetica',
      size: 24,
      bold: true,
      italic: false,
      color: '#000000'
    })
    expect(heading.frame.origin[0]).toBeCloseTo(72, 0)
    const lorem = blocks.find((b) => b.text.startsWith('Lorem'))!
    expect(lorem.wrap).toBe(true)
    expect(lorem.quads).toHaveLength(6)
    expect(lorem.lineSpacing).toBeCloseTo(16 / 11, 1)
    expect(lorem.runs[0].font).toBe('Times')
    // "Visit ..." and "Jump to chapter 3" share a baseline but are separate boxes
    expect(blocks.some((b) => b.text === 'Visit https://example.com')).toBe(true)
    expect(blocks.some((b) => b.text === 'Jump to chapter 3')).toBe(true)
    expect(blocks.find((b) => b.text === 'Page 1 of 5')!.align).toBe('center')
  })

  it('detects alignment, hard line breaks and mixed styles', async () => {
    const e = await openFixture('edit-text/layout.pdf')
    const blocks = await tools(e).edit.analyze(0)
    const by = (t: string) => blocks.find((b) => b.text.startsWith(t))!
    expect(by('The committee').align).toBe('justify')
    expect(by('Right aligned').align).toBe('right')
    expect(by('A centred').align).toBe('center')
    expect(by('Jane Smith').text).toBe('Jane Smith\n12 High Street\nSpringfield')
    const mixed = by('Red text')
    expect(mixed.runs.map((r) => [r.text, r.color, r.bold])).toEqual([
      ['Red text and ', '#c0392b', false],
      ['bold words', '#000000', true]
    ])
    // the bold heading does not swallow the paragraph set tightly under it
    expect(by('Quarterly').text).toBe('Quarterly gyp jumping report')
  })
})

describe('edit-text: committing edits', () => {
  it("replaces 'Hello Fartcrobat page 1' with 'Goodbye', keeps the next line, undoes and survives save", async () => {
    const e = await openFixture('text.pdf')
    const { edit, text } = tools(e)
    const original = await text.page(0)
    const nextBefore = await lineWith(e, 0, 'Lorem ipsum')
    const b = await block(e, 0, 'Hello Fartcrobat page 1')
    const res = await edit.commit(0, editOf(b, b.text.replace('Hello Fartcrobat page 1', 'Goodbye')))
    expect(res.fallbackFonts).toEqual([])
    expect(e.lastChanges?.journal.undoLabel).toBe('Edit Text')
    expect(e.lastChanges?.dirty).toBe(true)
    expect(e.lastChanges?.pages).toContain(0)

    const after = await text.page(0)
    expect(after.text).toContain('Goodbye. The quick brown fox jumps over the lazy dog.')
    expect(after.text).not.toContain('Hello Fartcrobat page 1')
    expect(after.text).toContain('Chapter 1')
    // the new text sits where the old one was
    const g = await lineWith(e, 0, 'Goodbye')
    expect(g!.quads[0]).toBeCloseTo(72, 1)
    expect(g!.line.bbox[1]).toBeCloseTo(119.1, 0)
    // the next line is untouched (same text, same glyph positions)
    const nextAfter = await lineWith(e, 0, 'Lorem ipsum')
    expect(nextAfter!.text).toBe(nextBefore!.text)
    expect(nextAfter!.quads.map((v) => Math.round(v * 100))).toEqual(
      nextBefore!.quads.map((v) => Math.round(v * 100))
    )
    // other pages untouched
    expect((await text.page(1)).text).toContain('Hello Fartcrobat page 2')

    await e.doc.undo()
    const undone = await text.page(0)
    expect(undone.text).toBe(original.text)
    expect([...undone.quads]).toEqual([...original.quads])
    await e.doc.redo()
    expect((await text.page(0)).text).toContain('Goodbye.')

    const again = await roundTrip(e)
    const t2 = await again.ops<typeof textOps>('text').page(0)
    expect(t2.text).toContain('Goodbye. The quick brown fox')
    expect(t2.text).not.toContain('Hello Fartcrobat page 1')
    // it is still editable after reopening
    const reopened = (await again.ops<typeof ops>('edit-text').analyze(0)).find((x) =>
      x.text.startsWith('Goodbye')
    )!
    expect(reopened.runs[0]).toMatchObject({ font: 'Helvetica', size: 12 })
  })

  it('works on rotated pages (mixed-sizes.pdf page 3 and an edited rotated page)', async () => {
    const e = await openFixture('mixed-sizes.pdf')
    expect(e.info.pages[2].rotation).toBe(90)
    const { edit } = tools(e)
    await edit.commit(2, newText([100, 100], [{ ...style, text: 'Note on a rotated page' }]))
    const l = await lineWith(e, 2, 'Note on a rotated page')
    expect(l).not.toBeNull()
    expect(l!.line.dir[0]).toBeCloseTo(1, 3)
    expect(l!.line.dir[1]).toBeCloseTo(0, 3)
    expect(l!.quads[0]).toBeCloseTo(100, 0)
    // first baseline at ascent * size below the box top
    expect(l!.line.bbox[1]).toBeGreaterThan(95)
    expect(l!.line.bbox[3]).toBeLessThan(120)

    const r = await openFixture('edit-text/rotated.pdf')
    expect(r.info.pages[0].rotation).toBe(90)
    const heading = await block(r, 0, 'Rotated heading')
    await tools(r).edit.commit(0, editOf(heading, 'Sideways heading edited'))
    const h = await lineWith(r, 0, 'Sideways heading edited')
    expect(h!.line.dir).toEqual([1, 0])
    expect(h!.line.bbox[0]).toBeCloseTo(heading.bbox[0], 0)
    expect(h!.line.bbox[1]).toBeCloseTo(heading.bbox[1], 0)
    const all = await tools(r).edit.text(0)
    expect(all).not.toContain('Rotated heading')
    expect(all).toContain('Text on a page that is rotated by ninety degrees.')
  })

  it('reuses an embedded subset font and falls back to a standard font for missing characters', async () => {
    const e = await openFixture('edit-text/subset-font.pdf')
    const { edit, text } = tools(e)
    const b = await block(e, 0, 'Embedded subset')
    expect(b.runs[0].font).toMatch(/^orig:.*DejaVuSans$/)
    expect(b.fonts[0].label).toBe('DejaVuSans')

    let res = await edit.commit(0, editOf(b, 'Embedded font kept'))
    expect(res.fallbackFonts).toEqual([])
    let t = await text.page(0)
    let i = t.text.indexOf('Embedded font kept')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(t.spans.find((s) => s.start <= i && s.end > i)!.font).toMatch(/DejaVuSans/)

    // 'é' is not part of the subset: the box switches to Helvetica
    const b2 = await block(e, 0, 'Embedded font kept')
    res = await edit.commit(0, editOf(b2, 'Café crème brûlée'))
    expect(res.fallbackFonts).toEqual(['DejaVuSans'])
    t = await text.page(0)
    i = t.text.indexOf('Café crème brûlée')
    expect(i).toBeGreaterThanOrEqual(0)
    expect(t.spans.find((s) => s.start <= i && s.end > i)!.font).toMatch(/Helvetica/)
    const saved = await roundTrip(e)
    expect((await saved.ops<typeof textOps>('text').page(0)).text).toContain('Café crème brûlée')
  })

  it('edits a word-processor export: keeps its fonts, styles and the text order of neighbours', async () => {
    const e = await openFixture('edit-text/office-report.pdf')
    const { edit, text } = tools(e)
    const blocks = await edit.analyze(0)
    const heading = blocks.find((b) => b.text === 'Annual Report 2025')!
    expect(heading.runs[0]).toMatchObject({ bold: true, size: 14, color: '#365f91' })
    expect(heading.fonts[0]).toMatchObject({ label: 'Carlito-Bold', cls: 'sans' })
    const para = blocks.find((b) => b.text.startsWith('This report'))!
    expect(para.runs.map((r) => [r.text.slice(0, 12), r.bold])).toEqual([
      ['This report ', false],
      ['Revenue grew', true],
      [' while costs', false]
    ])
    const runs = para.runs.map((r) => ({
      ...r,
      text: r.text.replace('activities', 'main activities and results')
    }))
    let res = await edit.commit(0, editOf(para, runs))
    expect(res.fallbackFonts).toEqual([])
    // the heading sits right above the paragraph: editing it must not disturb the new paragraph
    const h2 = (await edit.analyze(0)).find((b) => b.text === 'Annual Report 2025')!
    res = await edit.commit(0, editOf(h2, 'Annual Report 2026 – Draft'))
    // the subset font lacks some of the new characters: a bold sans standard font replaces it
    expect(res.fallbackFonts).toEqual(['Carlito-Bold'])
    const t = await text.page(0)
    const lines = t.lines.map((l) => t.text.slice(l.start, l.end).trim())
    expect(lines).toContain('Annual Report 2026 – Draft')
    expect(lines.filter((l) => l.length < 3)).toEqual([])
    expect(lines.join(' ')).toContain(
      'This report summarises the main activities and results of the year. Revenue grew by 12 percent while costs remained flat'
    )
    const at = t.text.indexOf('Annual Report 2026')
    const span = t.spans.find((sp) => sp.start <= at && sp.end > at)!
    expect(span.font).toBe('Helvetica-Bold')
    expect(span.color).toBe(0x365f91)
    const p2 = t.text.indexOf('Revenue grew')
    expect(t.spans.find((sp) => sp.start <= p2 && sp.end > p2)!.font).toMatch(/Caladea-Bold/)
  })

  it('only changes the edited page, even when pages share a form XObject', async () => {
    const e = await openFixture('edit-text/shared-xobject.pdf')
    const { edit } = tools(e)
    const header = await block(e, 0, 'Shared header')
    await edit.commit(0, editOf(header, 'Edited header'))
    expect(e.lastChanges?.pages).toEqual([0])
    expect(await edit.text(0)).toContain('Edited header')
    expect(await edit.text(0)).not.toContain('Shared header')
    expect(await edit.text(1)).toContain('Shared header in a form XObject')
    const saved = await roundTrip(e)
    const t = saved.ops<typeof ops>('edit-text')
    expect(await t.text(0)).not.toContain('Shared header')
    expect(await t.text(1)).toContain('Shared header in a form XObject')
  })

  it('writes characters outside Latin-1 (Greek, Cyrillic, CJK) with matching fonts', async () => {
    const e = await openFixture('text.pdf')
    const { edit, text } = tools(e)
    const res = await edit.commit(4, newText([72, 600], [{ ...style, text: 'Ωμέγα Жук € “quotes” 日本語' }]))
    expect(res.unsupported).toEqual([])
    const saved = await roundTrip(e)
    expect((await saved.ops<typeof textOps>('text').page(4)).text).toContain('Ωμέγα Жук € “quotes” 日本語')
    expect((await text.page(4)).text).toContain('Ωμέγα')
  })

  it('keeps tightly spaced neighbours, links and unapplied redaction marks', async () => {
    const e = await openFixture('edit-text/layout.pdf')
    const { edit, text } = tools(e)
    const annots = e.ops<typeof annotOps>('annots')
    const nav = e.ops<typeof navOps>('nav')
    const tightBefore = await lineWith(e, 0, 'ÉCOLE')
    // a redaction mark from the Redact tool that has not been applied yet
    const jane = await lineWith(e, 0, 'Jane Smith')
    const mark = await annots.create(0, { type: 'Redact', rect: jane!.line.bbox })
    const linksBefore = (await nav.links(0)).length

    const heading = await block(e, 0, 'Quarterly')
    await edit.commit(0, editOf(heading, 'Annual jumping report, edited'))
    const tightAfter = await lineWith(e, 0, 'ÉCOLE')
    expect(tightAfter!.text).toBe(tightBefore!.text)
    expect(tightAfter!.quads.map((v) => Math.round(v * 10))).toEqual(
      tightBefore!.quads.map((v) => Math.round(v * 10))
    )

    const linked = await block(e, 0, 'Read the full terms')
    await edit.commit(0, editOf(linked, 'Read the full terms and conditions online'))
    expect((await nav.links(0)).length).toBe(linksBefore)
    expect((await nav.links(0)).some((l) => l.uri === 'https://example.org/terms')).toBe(true)

    // the redaction mark is still there, and the text under it was not removed
    expect((await annots.list(0)).some((a) => a.id === mark.id && a.type === 'Redact')).toBe(true)
    expect((await text.page(0)).text).toContain('Jane Smith')
  })

  it('redraws overlapping text (a watermark) that the removal touched', async () => {
    const e = await openFixture('edit-text/layout.pdf')
    const { edit } = tools(e)
    const b = await block(e, 0, 'Watermarked')
    const runs = b.runs.map((r) => ({ ...r, text: r.text.replace('line one', 'line 1') }))
    const res = await edit.commit(0, editOf(b, runs))
    expect(res.restoredGlyphs).toBeGreaterThan(0)
    const all = await edit.text(0)
    expect(all).toContain('DRAFT')
    expect(all).toContain('Watermarked paragraph line 1 with')
    await e.doc.undo()
    expect(await edit.text(0)).toContain('line one')
  })

  it('applies size, bold, italic, underline, colour and keeps the box top when the size grows', async () => {
    const e = await openFixture('text.pdf')
    const { edit, text, render } = tools(e)
    const heading = await block(e, 0, 'Chapter 1')
    await edit.commit(0, editOf(heading, [{ ...heading.runs[0], text: 'Bigger heading', size: 36 }]))
    const bigger = await block(e, 0, 'Bigger heading')
    expect(bigger.runs[0].size).toBe(36)
    expect(bigger.bbox[1]).toBeCloseTo(heading.bbox[1], 0)

    const runs: Run[] = [
      { ...style, text: 'Plain ' },
      { ...style, text: 'Bold ', bold: true },
      { ...style, text: 'Italic ', italic: true, font: 'Times' },
      { ...style, text: 'Red', color: '#ff0000' },
      { ...style, text: ' Under', underline: true, font: 'Courier', size: 14 }
    ]
    await edit.commit(1, newText([72, 400], runs))
    const t = await text.page(1)
    const span = (w: string) => {
      const i = t.text.indexOf(w)
      return t.spans.find((s) => s.start <= i && s.end > i)!
    }
    expect(span('Plain').font).toBe('Helvetica')
    expect(span('Bold').font).toBe('Helvetica-Bold')
    expect(span('Italic').font).toBe('Times-Italic')
    expect(span('Red').color).toBe(0xff0000)
    expect(span('Under').font).toBe('Courier')
    expect(span('Under').size).toBeCloseTo(14)
    // the underline is drawn just below the baseline
    const under = await lineWith(e, 1, 'Under')
    const i = under!.text.indexOf('Under')
    const x0 = under!.quads[i * 8]
    const baseline = 400 + 0.9 * 14
    const r = await render.page(1, {
      scale: 2,
      clip: [x0 * 2 + 4, (baseline + 1) * 2, x0 * 2 + 40, (baseline + 3) * 2]
    })
    let dark = 0
    for (let k = 0; k < r.pixels!.length; k += 4) if (r.pixels![k] < 100) dark++
    expect(dark).toBeGreaterThan(20)
  })

  it('wraps, aligns and justifies text inside the box', async () => {
    const e = await openFixture('text.pdf')
    const { edit, text } = tools(e)
    const long = 'This sentence is long enough to wrap onto several lines inside a narrow box.'
    await edit.commit(
      2,
      newText([100, 560], [{ ...style, text: long }], {
        wrap: true,
        align: 'center',
        frame: { origin: [100, 560], dir: [1, 0], width: 150 }
      })
    )
    const t = await text.page(2)
    const lines = t.lines.filter((l) => l.bbox[1] >= 555 && l.bbox[1] < 650)
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const l of lines) {
      expect(l.bbox[0]).toBeGreaterThanOrEqual(99.5)
      expect(l.bbox[2]).toBeLessThanOrEqual(250.5)
      expect((l.bbox[0] + l.bbox[2]) / 2).toBeCloseTo(175, 0)
    }
    const words = lines.map((l) => t.text.slice(l.start, l.end).trim()).join(' ')
    expect(words).toBe(long)

    await edit.commit(
      3,
      newText([100, 560], [{ ...style, text: long + ' ' + long }], {
        wrap: true,
        align: 'justify',
        frame: { origin: [100, 560], dir: [1, 0], width: 200 }
      })
    )
    const t3 = await text.page(3)
    const jl = t3.lines.filter((l) => l.bbox[1] >= 555 && l.bbox[1] < 700)
    expect(jl.length).toBeGreaterThanOrEqual(3)
    for (const l of jl.slice(0, -1)) expect(l.bbox[2]).toBeCloseTo(300, 0)
    expect(jl[jl.length - 1].bbox[2]).toBeLessThan(299)
  })

  it('deletes a text box when all of its text is removed, and rejects stale edits', async () => {
    const e = await openFixture('text.pdf')
    const { edit } = tools(e)
    const b = await block(e, 0, 'Jump to chapter 3')
    await expect(
      edit.commit(0, { ...editOf(b, 'x'), source: { start: b.start, end: b.end, check: 'something else' } })
    ).rejects.toThrow(/changed/)
    await edit.commit(0, editOf(b, ''))
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete Text')
    expect(await edit.text(0)).not.toContain('Jump to chapter 3')
    expect(await edit.text(0)).toContain('Visit https://example.com')
  })

  it('adds new text as page content (not an annotation)', async () => {
    const e = await openFixture('text.pdf')
    const { edit } = tools(e)
    await edit.commit(0, newText([72, 600], [{ ...style, text: 'Brand new text' }]))
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Text')
    expect(await edit.text(0)).toContain('Brand new text')
    expect(await e.ops<typeof annotOps>('annots').list(0)).toEqual([])
    await e.doc.undo()
    expect(await edit.text(0)).not.toContain('Brand new text')
  })
})

describe('edit-text: working with other features', () => {
  const hf = (text: Partial<HeaderFooterSettings['text']>, patch: Partial<HeaderFooterSettings> = {}) => {
    const d = defaultHeaderFooter()
    return { ...d, ...patch, text: { ...d.text, ...text } }
  }
  const watermark = (text: string): WatermarkSettings => {
    const d = defaultWatermark()
    return {
      ...d,
      opacity: 0.3,
      rotation: 45,
      source: {
        kind: 'text',
        text,
        font: { ...(d.source as { font: FontSpec }).font, size: 60 },
        align: 'center'
      }
    }
  }

  it('leaves headers, footers and watermarks made with page marks updatable and removable', async () => {
    const e = await openFixture('text.pdf')
    const { edit, text } = tools(e)
    const marks = e.ops<typeof marksOps>('page-marks')
    const originalHello = await lineWith(e, 0, 'Hello Fartcrobat')
    // the header shrinks the page content to make room: the edited text must follow that
    await marks.apply(
      hf({ headerCenter: 'Draft copy', footerRight: 'Page <<1>> of <<n>>' }, { shrink: true }),
      {
        mode: 'add'
      }
    )
    await marks.apply(watermark('CONFIDENTIAL'), { mode: 'add' })

    const blocks = await edit.analyze(0)
    expect(blocks.find((b) => b.text === 'Draft copy')?.mark).toBe('HeaderFooter')
    expect(blocks.find((b) => b.text === 'CONFIDENTIAL')?.mark).toBe('Watermark')
    // the page's own footer is ordinary text
    expect(blocks.filter((b) => b.text === 'Page 1 of 5').map((b) => b.mark ?? 'own')).toEqual(
      expect.arrayContaining(['own', 'HeaderFooter'])
    )
    const header = blocks.find((b) => b.mark === 'HeaderFooter')!
    await expect(edit.commit(0, editOf(header, 'Changed'))).rejects.toThrow(/changed/)

    const hello = blocks.find((b) => b.text.startsWith('Hello') && !b.mark)!
    await edit.commit(0, editOf(hello, 'Goodbye'))
    const g = await lineWith(e, 0, 'Goodbye')
    expect(g!.quads[0]).toBeCloseTo(hello.bbox[0], 0)
    expect(g!.line.bbox[1]).toBeCloseTo(hello.bbox[1], 0)
    // the marks are still marks: listed on every page, recognised after the edit
    const listing = await marks.list()
    expect(listing.groups.map((gr) => [gr.type, gr.pages.length])).toEqual(
      expect.arrayContaining([
        ['HeaderFooter', 5],
        ['Watermark', 5]
      ])
    )
    const again = await edit.analyze(0)
    expect(again.find((b) => b.text === 'Draft copy')?.mark).toBe('HeaderFooter')
    expect(again.find((b) => b.text === 'CONFIDENTIAL')?.mark).toBe('Watermark')

    // removing the header puts the content back at full size, the edited text with it
    await marks.remove('HeaderFooter')
    const unshrunk = await lineWith(e, 0, 'Goodbye')
    expect(unshrunk!.quads[0]).toBeCloseTo(originalHello!.quads[0], 0)
    expect(unshrunk!.line.bbox[1]).toBeCloseTo(originalHello!.line.bbox[1], 0)
    expect(await edit.text(0)).not.toContain('Draft copy')
    await marks.remove('Watermark')
    expect(await edit.text(0)).not.toContain('CONFIDENTIAL')
    expect(await edit.text(0)).toContain('Goodbye')

    await e.doc.undo()
    await e.doc.undo()
    await e.doc.undo()
    const t = (await text.page(0)).text
    expect(t).toContain('Hello Fartcrobat page 1')
    expect(t).toContain('Draft copy')
    expect(t).toContain('CONFIDENTIAL')
  })

  it('keeps comments and form fields on the page', async () => {
    const e = await openFixture('form.pdf')
    const { edit } = tools(e)
    const annots = e.ops<typeof annotOps>('annots')
    const forms = e.ops<typeof formOps>('forms')
    const label = await block(e, 0, 'Full name:')
    const hl = await annots.create(0, { type: 'Highlight', rect: label.bbox, quads: label.quads })
    const note = await annots.create(0, {
      type: 'Text',
      rect: [label.bbox[0], label.bbox[1], label.bbox[0] + 20, label.bbox[1] + 20]
    })
    const fieldsBefore = (await forms.list(0)).map((f) => f.name)
    await edit.commit(0, editOf(label, 'Your full name:'))
    expect(await edit.text(0)).toContain('Your full name:')
    expect((await annots.list(0)).map((a) => a.id)).toEqual(expect.arrayContaining([hl.id, note.id]))
    expect((await forms.list(0)).map((f) => f.name)).toEqual(fieldsBefore)
    const saved = await roundTrip(e)
    expect((await saved.ops<typeof annotOps>('annots').list(0)).map((a) => a.type).sort()).toEqual([
      'Highlight',
      'Text'
    ])
    expect((await saved.ops<typeof formOps>('forms').list(0)).length).toBe(fieldsBefore.length)
  })
})

const src = (b: TextBlockInfo) => ({ start: b.start, end: b.end, check: b.text })

describe('edit-text: preview', () => {
  it('renders the page with the edited block left out', async () => {
    const e = await openFixture('text.pdf')
    const { edit, render } = tools(e)
    const heading = await block(e, 0, 'Chapter 1')
    const clip: [number, number, number, number] = [
      heading.bbox[0] * 2,
      heading.bbox[1] * 2,
      heading.bbox[2] * 2,
      heading.bbox[3] * 2
    ]
    const dark = (px: Uint8ClampedArray) => {
      let n = 0
      for (let k = 0; k < px.length; k += 4) if (px[k] < 128) n++
      return n
    }
    const normal = await render.page(0, { scale: 2, clip })
    const preview = await edit.preview(0, src(heading), heading.quads, { scale: 2, clip })
    expect(dark(normal.pixels!)).toBeGreaterThan(100)
    expect(dark(preview.pixels!)).toBe(0)
    // text outside the block is still drawn
    const hello = await block(e, 0, 'Hello')
    const clip2: [number, number, number, number] = [
      hello.bbox[0] * 2,
      hello.bbox[1] * 2,
      hello.bbox[2] * 2,
      hello.bbox[3] * 2
    ]
    expect(
      dark((await edit.preview(0, src(heading), heading.quads, { scale: 2, clip: clip2 })).pixels!)
    ).toBeGreaterThan(100)
    // without a (current) paragraph, the glyphs inside the quads are left out
    expect(dark((await edit.preview(0, null, heading.quads, { scale: 2, clip })).pixels!)).toBe(0)
  })

  it('keeps other text crossing the paragraph (a watermark) visible', async () => {
    const e = await openFixture('edit-text/layout.pdf')
    const { edit, render } = tools(e)
    const b = await block(e, 0, 'Watermarked')
    const clip: [number, number, number, number] = [
      b.bbox[0] * 2,
      b.bbox[1] * 2,
      b.bbox[2] * 2,
      b.bbox[3] * 2
    ]
    const count = (px: Uint8ClampedArray, test: (r: number, g: number, bl: number) => boolean) => {
      let n = 0
      for (let k = 0; k < px.length; k += 4) if (test(px[k], px[k + 1], px[k + 2])) n++
      return n
    }
    const black = (r: number, g: number, bl: number) => r < 90 && g < 90 && bl < 90
    const red = (r: number, g: number, bl: number) => r > 150 && g < 100 && bl < 100
    const normal = (await render.page(0, { scale: 2, clip })).pixels!
    const preview = (await edit.preview(0, src(b), b.quads, { scale: 2, clip })).pixels!
    expect(count(normal, black)).toBeGreaterThan(200)
    expect(count(preview, black)).toBeLessThan(count(normal, black) * 0.05)
    expect(count(preview, red)).toBeGreaterThan(count(normal, red) * 0.9)
  })
})
