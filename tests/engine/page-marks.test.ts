import { describe, expect, it } from 'vitest'
import type textOps from '@engine/ops/text'
import type renderOps from '@engine/ops/render'
import { extractPageText } from '@engine/ops/text'
import type marksOps from '@features/page-marks/engine'
import {
  defaultBackground,
  defaultBates,
  defaultHeaderFooter,
  defaultWatermark,
  expandTokens,
  formatBates,
  resolvePageRange,
  unsupportedChars,
  type HeaderFooterSettings,
  type WatermarkSettings
} from '@features/page-marks/shared'
import { fixture, openFixture, roundTrip, type OpenedEngine } from './helpers'

function marks(e: OpenedEngine) {
  return e.ops<typeof marksOps>('page-marks')
}

async function allText(e: OpenedEngine): Promise<string[]> {
  const text = e.ops<typeof textOps>('text')
  const out: string[] = []
  for (let i = 0; i < e.session.pageCount(); i++) out.push(await text.plain(i))
  return out
}

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1
}

function hf(
  patch: Partial<HeaderFooterSettings> = {},
  text: Partial<HeaderFooterSettings['text']> = {}
): HeaderFooterSettings {
  const d = defaultHeaderFooter()
  return { ...d, ...patch, text: { ...d.text, ...text } }
}

function watermark(text: string, patch: Partial<WatermarkSettings> = {}): WatermarkSettings {
  const d = defaultWatermark()
  return {
    ...d,
    source: { kind: 'text', text, font: { ...(d.source as any).font, size: 60 }, align: 'center' },
    ...patch
  }
}

/** RGB of a pixel of a page rendered at 72 dpi. */
async function pixel(e: OpenedEngine, page: number, x: number, y: number): Promise<[number, number, number]> {
  const r = await e.ops<typeof renderOps>('render').page(page, { scale: 1 })
  const k = (Math.round(y) * r.width + Math.round(x)) * 4
  return [r.pixels![k], r.pixels![k + 1], r.pixels![k + 2]]
}

describe('page-marks shared helpers', () => {
  it('expands page and date tokens', () => {
    const date = new Date(2026, 9, 11)
    expect(expandTokens('Page <<1>> of <<n>>', { page: 3, total: 5, date })).toBe('Page 3 of 5')
    expect(expandTokens('<<Page 1 of n>> | <<1/n>>', { page: 2, total: 9, date })).toBe('Page 2 of 9 | 2/9')
    expect(expandTokens('<<m/d/yyyy>> <<dd/mm/yy>> <<yyyy-mm-dd>>', { page: 1, total: 1, date })).toBe(
      '10/11/2026 11/10/26 2026-10-11'
    )
    expect(expandTokens('<<mmmm d, yyyy>>', { page: 1, total: 1, date })).toBe('October 11, 2026')
    expect(expandTokens('<<unknown>>', { page: 1, total: 1, date })).toBe('<<unknown>>')
  })

  it('resolves page ranges and formats Bates numbers', () => {
    expect(resolvePageRange({ kind: 'all', subset: 'all' }, 5)).toEqual([0, 1, 2, 3, 4])
    expect(resolvePageRange({ kind: 'all', subset: 'odd' }, 5)).toEqual([0, 2, 4])
    expect(resolvePageRange({ kind: 'range', from: 2, to: 5, subset: 'even' }, 5)).toEqual([1, 3])
    expect(resolvePageRange({ kind: 'range', from: 4, to: 9, subset: 'all' }, 5)).toEqual([3, 4])
    expect(formatBates({ prefix: 'ABC', suffix: '-X', digits: 6 }, 42)).toBe('ABC000042-X')
    expect(unsupportedChars('Héllo € 世')).toEqual(['世'])
  })
})

describe('header & footer', () => {
  it('adds page numbers to every page, updates them and removes them exactly', async () => {
    const e = await openFixture('text.pdf')
    const before = await allText(e)
    await marks(e).apply(hf({}, { headerCenter: 'Draft copy', footerRight: 'Page <<1>> of <<n>>' }), {
      mode: 'add'
    })
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Header & Footer')
    expect(e.lastChanges?.dirty).toBe(true)
    let after = await allText(e)
    after.forEach((t, i) => {
      expect(t).toContain('Draft copy')
      // the fixture already prints "Page i of 5" once; ours adds a second one
      expect(count(t, `Page ${i + 1} of 5`)).toBe(2)
    })
    expect(after.join('\n')).toContain('Page 3 of 5')

    const listing = await marks(e).list()
    expect(listing.groups).toHaveLength(1)
    expect(listing.groups[0].type).toBe('HeaderFooter')
    expect(listing.groups[0].pages).toEqual([0, 1, 2, 3, 4])
    expect((listing.groups[0].settings as HeaderFooterSettings).text.footerRight).toBe('Page <<1>> of <<n>>')

    // survives a save/reopen
    const again = await roundTrip(e)
    expect((await again.ops<typeof marksOps>('page-marks').list()).groups[0].pages).toHaveLength(5)

    // update replaces the old marks (one undo step)
    await marks(e).apply(hf({ startNumber: 10 }, { footerLeft: 'Sheet <<1>>' }), { mode: 'replace' })
    expect(e.lastChanges?.journal.undoLabel).toBe('Update Header & Footer')
    after = await allText(e)
    expect(after[2]).toContain('Sheet 12')
    expect(after[2]).not.toContain('Draft copy')
    expect(count(after[2], 'Page 3 of 5')).toBe(1)

    await marks(e).remove('HeaderFooter')
    expect(e.lastChanges?.journal.undoLabel).toBe('Remove Header & Footer')
    expect(await allText(e)).toEqual(before)
    expect((await marks(e).list()).groups).toHaveLength(0)

    await e.doc.undo()
    expect((await allText(e))[2]).toContain('Sheet 12')
    await e.doc.undo()
    expect((await allText(e))[2]).toContain('Draft copy')
    await e.doc.undo()
    expect(await allText(e)).toEqual(before)
  })

  it('numbers a page range, odd pages only, with dates', async () => {
    const e = await openFixture('text.pdf')
    const s = hf(
      { range: { kind: 'range', from: 2, to: 5, subset: 'all' }, date: new Date(2026, 0, 2).toISOString() },
      { headerLeft: '<<1>>/<<n>> <<yyyy-mm-dd>>' }
    )
    await marks(e).apply(s, { mode: 'add' })
    const t = await allText(e)
    expect(t[0]).not.toContain('2026-01-02')
    expect(t[1]).toContain('1/4 2026-01-02')
    expect(t[4]).toContain('4/4 2026-01-02')

    await marks(e).apply(hf({ range: { kind: 'all', subset: 'odd' } }, { headerRight: 'ODD <<1>>' }), {
      mode: 'replace'
    })
    const t2 = await allText(e)
    expect(t2[0]).toContain('ODD 1')
    expect(t2[1]).not.toContain('ODD')
    expect(t2[2]).toContain('ODD 3')
  })

  it('keeps the header upright on a rotated page', async () => {
    const e = await openFixture('mixed-sizes.pdf')
    expect(e.info.pages[2].rotation).toBe(90)
    await marks(e).apply(hf({}, { headerCenter: 'Upright header', footerLeft: 'Left footer' }), {
      mode: 'add'
    })
    const t = extractPageText(e.session, 2)
    const idx = t.text.indexOf('Upright header')
    expect(idx).toBeGreaterThanOrEqual(0)
    const line = t.lines.find((l) => l.start <= idx && idx < l.end)!
    expect(line.dir[0]).toBeCloseTo(1, 3)
    expect(line.dir[1]).toBeCloseTo(0, 3)
    // near the top of the displayed page (MediaBox 792x612 turned upright), centred horizontally
    const w = e.info.pages[2].width
    expect(w).toBeCloseTo(612, 0)
    expect(line.bbox[1]).toBeLessThan(60)
    expect((line.bbox[0] + line.bbox[2]) / 2).toBeCloseTo(w / 2, -1)
    const fidx = t.text.indexOf('Left footer')
    const fline = t.lines.find((l) => l.start <= fidx && fidx < l.end)!
    expect(fline.bbox[0]).toBeCloseTo(72, 0)
    expect(fline.bbox[3]).toBeGreaterThan(e.info.pages[2].height - 60)
  })

  it('shrinks the page content to make room', async () => {
    const e = await openFixture('text.pdf')
    const findLine = (needle: string) => {
      const t = extractPageText(e.session, 0)
      const i = t.text.indexOf(needle)
      return t.lines.find((l) => l.start <= i && i < l.end)!.bbox
    }
    const before = findLine('Page 1 of 5')
    await marks(e).apply(
      hf(
        { shrink: true, margins: { top: 36, bottom: 36, left: 72, right: 72 } },
        { headerCenter: 'TOP', footerCenter: 'BOTTOM' }
      ),
      { mode: 'add' }
    )
    const after = findLine('Page 1 of 5')
    // the original footer moved up, above our footer band
    expect(after[3]).toBeLessThan(before[3] - 10)
    const ours = findLine('BOTTOM')
    expect(after[3]).toBeLessThan(ours[1])
    await marks(e).remove('HeaderFooter')
    const restored = findLine('Page 1 of 5')
    expect(restored[1]).toBeCloseTo(before[1], 3)
  })
})

describe('watermarks', () => {
  it('adds a diagonal text watermark and removes it', async () => {
    const e = await openFixture('text.pdf')
    const before = await allText(e)
    await marks(e).apply(watermark('CONFIDENTIAL', { opacity: 0.3, rotation: 45 }), { mode: 'add' })
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Watermark')
    const t = await allText(e)
    for (const page of t) expect(page).toContain('CONFIDENTIAL')
    const listing = await marks(e).list()
    expect(listing.groups.map((g) => g.type)).toEqual(['Watermark'])
    await marks(e).remove('Watermark')
    expect(await allText(e)).toEqual(before)
  })

  it('puts a watermark behind the page without hiding content', async () => {
    const e = await openFixture('text.pdf')
    // the blue box of the fixture: x 72..272, y (page space) 332..412
    const blue = await pixel(e, 0, 150, 370)
    await marks(e).apply(watermark('BEHIND', { behind: true, opacity: 1, rotation: 0, relativeScale: 90 }), {
      mode: 'add'
    })
    expect(await pixel(e, 0, 150, 370)).toEqual(blue)
    expect((await allText(e))[0]).toContain('BEHIND')
  })

  it('uses an image or a PDF page as the watermark', async () => {
    const e = await openFixture('text.pdf')
    const src = await marks(e).loadSource(fixture('compare-a.pdf'), 'compare-a.pdf')
    expect(src.kind).toBe('pdf')
    const s = defaultWatermark()
    await marks(e).apply(
      {
        ...s,
        source: { kind: 'file', fileName: 'compare-a.pdf', page: 1, scale: 50, sourceId: src.id },
        rotation: 0
      },
      { mode: 'add' }
    )
    expect((await allText(e))[1]).toContain('Quarterly report')
    // updating without choosing the file again reuses the one in the document
    await marks(e).apply(
      { ...s, source: { kind: 'file', fileName: 'compare-a.pdf', page: 1, scale: 30 }, rotation: -45 },
      { mode: 'replace' }
    )
    expect((await allText(e))[4]).toContain('Quarterly report')
    await marks(e).releaseSource(src.id)

    const img = await marks(e).loadSource(fixture('scan.png'), 'scan.png')
    expect(img.kind).toBe('image')
    await marks(e).apply(
      {
        ...s,
        source: { kind: 'file', fileName: 'scan.png', page: 1, scale: 100, sourceId: img.id },
        relativeScale: 50,
        opacity: 1,
        rotation: 0
      },
      { mode: 'replace' }
    )
    const t = extractPageText(e.session, 0, 'preserve-images')
    expect(t.images.length).toBeGreaterThan(0)
    const again = await roundTrip(e)
    expect((await again.ops<typeof marksOps>('page-marks').list()).groups[0].pages).toHaveLength(5)
  })

  it('hides a watermark when printing through optional content', async () => {
    const e = await openFixture('text.pdf')
    await marks(e).apply(watermark('SCREEN ONLY', { showOnPrint: false, opacity: 1, rotation: 0 }), {
      mode: 'add'
    })
    const ocp = e.session.pdf.getTrailer().get('Root').get('OCProperties')
    expect(ocp.isNull()).toBe(false)
    expect(ocp.get('OCGs').length).toBe(1)
    expect(ocp.get('OCGs').get(0).get('Usage').get('Print').get('PrintState').asName()).toBe('OFF')
    // MuPDF reads the optional content configuration when a file is opened: check after reopening
    const again = await roundTrip(e)
    const m = again.session.mupdf
    const red = (usage: string) => {
      const pix = again.session
        .page(0)
        .toPixmap([0.5, 0, 0, 0.5, 0, 0], m.ColorSpace.DeviceRGB, false, false, usage)
      const px = pix.getPixels()
      let n = 0
      for (let k = 0; k < px.length; k += 3) if (px[k] > 200 && px[k + 1] < 80 && px[k + 2] < 80) n++
      return n
    }
    expect(red('View')).toBeGreaterThan(50)
    expect(red('Print')).toBe(0)
    expect(again.info.layerCount).toBe(1)
    await marks(e).remove('Watermark')
    expect(e.session.pdf.getTrailer().get('Root').get('OCProperties').isNull()).toBe(true)
    await e.doc.undo()
    expect(e.session.pdf.getTrailer().get('Root').get('OCProperties').isNull()).toBe(false)
  })
})

describe('backgrounds and Bates numbers', () => {
  it('adds a colour background behind the content', async () => {
    const e = await openFixture('text.pdf')
    const before = await allText(e)
    const blue = await pixel(e, 0, 150, 370)
    await marks(e).apply(
      { ...defaultBackground(), source: { kind: 'color', color: '#00FF00' } },
      { mode: 'add' }
    )
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Background')
    expect(await allText(e)).toEqual(before)
    expect(await pixel(e, 0, 5, 5)).toEqual([0, 255, 0])
    expect(await pixel(e, 0, 150, 370)).toEqual(blue)
    // text still extracts first and unchanged
    const t = extractPageText(e.session, 0)
    expect(t.text.startsWith('Chapter 1')).toBe(true)
    await marks(e).remove('Background')
    expect(await pixel(e, 0, 5, 5)).toEqual([255, 255, 255])
  })

  it('numbers pages with Bates numbers', async () => {
    const e = await openFixture('text.pdf')
    await marks(e).apply(
      { ...defaultBates(), prefix: 'ACME-', suffix: '-C', digits: 6, start: 41, slot: 'footerRight' },
      { mode: 'add' }
    )
    const t = await allText(e)
    t.forEach((page, i) => expect(page).toContain(`ACME-0000${41 + i}-C`))
    expect(formatBates({ prefix: 'ACME-', suffix: '-C', digits: 6 }, 45)).toBe('ACME-000045-C')
    await marks(e).remove('Bates')
    expect((await allText(e))[0]).not.toContain('ACME-')
  })

  it('previews marks without changing the document', async () => {
    const e = await openFixture('text.pdf')
    const plain = await marks(e).preview(0, defaultBates(), { mode: 'add', scale: 0.5 })
    const bg = await marks(e).preview(
      0,
      { ...defaultBackground(), source: { kind: 'color', color: '#0000FF' } },
      { mode: 'add', scale: 0.5 }
    )
    expect(bg.inRange).toBe(true)
    expect(Array.from(bg.pixels!.slice(0, 3))).toEqual([0, 0, 255])
    expect(Array.from(plain.pixels!.slice(0, 3))).toEqual([255, 255, 255])
    expect(e.lastChanges?.dirty).toBe(false)
    expect(e.lastChanges?.journal.canUndo).toBe(false)
    expect((await marks(e).list()).groups).toHaveLength(0)
    const empty = await marks(e).preview(0, watermark(''), { mode: 'add', scale: 0.25 })
    expect(empty.message).toMatch(/watermark text/i)
    const out = await marks(e).preview(
      0,
      hf({ range: { kind: 'range', from: 3, to: 5, subset: 'all' } }, { headerLeft: 'X' }),
      { mode: 'add', scale: 0.25 }
    )
    expect(out.inRange).toBe(false)
  })
})

describe('previews', () => {
  /** Share of pixels that differ by more than a small tolerance. */
  function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
    expect(a.length).toBe(b.length)
    let n = 0
    for (let k = 0; k < a.length; k += 4) {
      if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) > 24) n++
    }
    return n / (a.length / 4)
  }

  it('keeps the redo history and the document untouched', async () => {
    const e = await openFixture('text.pdf')
    const api = marks(e)
    await api.apply(defaultBates(), { mode: 'add' })
    await e.doc.undo()
    expect(e.lastChanges?.journal.redoLabel).toBe('Add Bates Numbering')
    const objects = e.session.pdf.countObjects()
    for (const s of [
      watermark('PREVIEW'),
      hf({}, { footerCenter: '<<1>>' }),
      defaultBackground(),
      defaultBates()
    ]) {
      await api.preview(1, s, { mode: 'replace', scale: 0.4 })
    }
    expect(e.lastChanges?.journal.canRedo).toBe(true)
    expect(e.lastChanges?.journal.redoLabel).toBe('Add Bates Numbering')
    expect(e.lastChanges?.dirty).toBe(false)
    expect(e.session.pdf.countObjects()).toBe(objects)
    await e.doc.redo()
    expect((await allText(e))[4]).toContain('000005')
  })

  it('looks like the page after OK, form fields included', async () => {
    for (const name of ['text.pdf', 'form.pdf', 'mixed-sizes.pdf']) {
      const e = await openFixture(name)
      const api = marks(e)
      const page = name === 'mixed-sizes.pdf' ? 2 : 0
      const settings = [
        watermark('SAME', { opacity: 0.4 }),
        hf({}, { headerLeft: 'Left <<1>>', footerRight: '<<Page 1 of n>>' }),
        { ...defaultBackground(), source: { kind: 'color' as const, color: '#FFE0B2' } }
      ]
      for (const s of settings) {
        const pre = await api.preview(page, s, { mode: 'add', scale: 1 })
        await api.apply(s, { mode: 'add' })
        const after = await e.ops<typeof renderOps>('render').page(page, { scale: 1 })
        expect(diff(pre.pixels!, after.pixels!)).toBeLessThan(0.001)
        await e.doc.undo()
      }
    }
  })

  it('previews an update that reuses the file already in the document', async () => {
    const e = await openFixture('text.pdf')
    const api = marks(e)
    const src = await api.loadSource(fixture('scan.png'), 'scan.png')
    const base: WatermarkSettings = {
      ...defaultWatermark(),
      opacity: 1,
      rotation: 0,
      relativeScale: 80,
      source: { kind: 'file', fileName: 'scan.png', page: 1, scale: 100, sourceId: src.id }
    }
    await api.apply(base, { mode: 'add' })
    await api.releaseSource(src.id)
    const update: WatermarkSettings = {
      ...base,
      source: { kind: 'file', fileName: 'scan.png', page: 1, scale: 100 }
    }
    const pre = await api.preview(2, update, { mode: 'replace', scale: 0.5 })
    expect(pre.message).toBeUndefined()
    const before = await e.ops<typeof renderOps>('render').page(2, { scale: 0.5 })
    expect(diff(pre.pixels!, before.pixels!)).toBeLessThan(0.001)
  })
})

describe('pages sharing one resource dictionary', () => {
  it('adds one resource entry for a watermark used on every page, and removes it cleanly', async () => {
    const e = await openFixture('text.pdf')
    const doc = e.session.pdf
    e.session.runMutation('Share resources', () => {
      const shared = doc.addObject(doc.newDictionary())
      for (let i = 0; i < e.session.pageCount(); i++) {
        const pageObj = doc.findPage(i)
        const own = pageObj.get('Resources').resolve()
        own.forEach((v, k) => shared.put(k as string, v))
        pageObj.put('Resources', shared)
      }
    })
    e.session.invalidatePages()
    const before = await allText(e)
    await marks(e).apply(watermark('SHARED'), { mode: 'add' })
    await marks(e).apply(defaultBates(), { mode: 'add' })
    const xo = doc.findPage(0).get('Resources').get('XObject')
    let names = 0
    xo.forEach(() => names++)
    // one watermark appearance + one Bates form per page
    expect(names).toBe(1 + 5)
    const t = await allText(e)
    t.forEach((page, i) => {
      expect(page).toContain('SHARED')
      expect(page).toContain(`00000${i + 1}`)
    })
    await marks(e).remove('Watermark')
    await marks(e).remove('Bates')
    expect(await allText(e)).toEqual(before)
    expect(doc.findPage(3).get('Resources').get('XObject').isNull()).toBe(true)
  })
})

describe('resources after previews and undo', () => {
  /** Every XObject a page mark uses resolves, with its fonts and images. */
  function checkResources(e: OpenedEngine, pageIndex: number) {
    const xo = e.session.pdf.findPage(pageIndex).get('Resources').get('XObject')
    let forms = 0
    xo.forEach((form) => {
      const res = form.get('Resources')
      expect(form.isStream()).toBe(true)
      const fonts = res.get('Font')
      if (!fonts.isNull()) fonts.forEach((f) => expect(f.get('BaseFont').isName()).toBe(true))
      const src = res.get('XObject')
      if (!src.isNull()) src.forEach((x) => expect(['Image', 'Form']).toContain(x.get('Subtype').asName()))
      forms++
    })
    expect(forms).toBeGreaterThan(0)
  }

  it('keeps fonts and images valid when applying after a preview or an undo', async () => {
    const e = await openFixture('text.pdf')
    const api = marks(e)
    const s = hf({}, { headerRight: 'Fartcrobat test' })
    await api.preview(0, s, { mode: 'add', scale: 0.3 })
    await api.apply(s, { mode: 'add' })
    checkResources(e, 0)
    await e.doc.undo()
    await api.apply(s, { mode: 'add' })
    checkResources(e, 0)
    await e.doc.undo()
    const src = await api.loadSource(fixture('scan.png'), 'scan.png')
    const w: WatermarkSettings = {
      ...defaultWatermark(),
      source: { kind: 'file', fileName: 'scan.png', page: 1, scale: 10, sourceId: src.id }
    }
    await api.preview(0, w, { mode: 'add', scale: 0.3 })
    await api.apply(w, { mode: 'add' })
    checkResources(e, 0)
    await e.doc.undo()
    await api.apply(w, { mode: 'add' })
    checkResources(e, 0)
    const again = await roundTrip(e)
    checkResources(again, 3)
  })
})

describe('crop pages', () => {
  it('crops with margins, removes white margins and resets to the MediaBox', async () => {
    const e = await openFixture('text.pdf')
    await marks(e).setBoxes({
      pages: [0, 1],
      box: 'CropBox',
      margins: { top: 36, bottom: 72, left: 18, right: 54 }
    })
    expect(e.lastChanges?.journal.undoLabel).toBe('Crop Pages')
    let info = await e.doc.info()
    expect(info.pages[0].width).toBeCloseTo(612 - 72, 3)
    expect(info.pages[0].height).toBeCloseTo(792 - 108, 3)
    expect(info.pages[2].width).toBeCloseTo(612, 3)
    expect((await marks(e).list()).croppedPages).toEqual([0, 1])

    const bounds = (await marks(e).contentBounds(3))!
    expect(bounds[0]).toBeGreaterThan(68)
    expect(bounds[0]).toBeLessThan(74)
    expect(bounds[1]).toBeGreaterThan(70)
    expect(bounds[1]).toBeLessThan(80)
    expect(bounds[3]).toBeGreaterThan(755)
    expect(bounds[3]).toBeLessThan(770)
    await marks(e).setBoxes({ pages: [3], box: 'CropBox', margins: null, removeWhiteMargins: true })
    info = await e.doc.info()
    expect(info.pages[3].width).toBeCloseTo(bounds[2] - bounds[0], 0)
    expect(info.pages[3].height).toBeCloseTo(bounds[3] - bounds[1], 0)

    // margins are measured from the MediaBox, so the same margins on a cropped page give the same box
    await marks(e).setBoxes({
      pages: [0],
      box: 'CropBox',
      margins: { top: 36, bottom: 72, left: 18, right: 54 }
    })
    info = await e.doc.info()
    expect(info.pages[0].width).toBeCloseTo(612 - 72, 3)

    const view = await marks(e).boxes(0, 0.5)
    expect(view.media[0]).toBeCloseTo(-18, 3)
    expect(view.media[1]).toBeCloseTo(-36, 3)
    expect(view.width).toBe(306)

    await marks(e).setBoxes({ pages: [0, 1, 3], box: 'CropBox', margins: null })
    expect(e.lastChanges?.journal.undoLabel).toBe('Remove Crop')
    info = await e.doc.info()
    expect(info.pages[0].width).toBeCloseTo(612, 3)
    expect(info.pages[3].height).toBeCloseTo(792, 3)
    await e.doc.undo()
    expect((await e.doc.info()).pages[3].width).toBeCloseTo(bounds[2] - bounds[0], 0)
  })

  it('crops a rotated page in its displayed orientation and sets other boxes', async () => {
    const e = await openFixture('mixed-sizes.pdf')
    await marks(e).setBoxes({
      pages: [2],
      box: 'CropBox',
      margins: { top: 100, bottom: 0, left: 50, right: 0 }
    })
    const info = await e.doc.info()
    expect(info.pages[2].rotation).toBe(90)
    expect(info.pages[2].width).toBeCloseTo(562, 3)
    expect(info.pages[2].height).toBeCloseTo(692, 3)
    // with /Rotate 90 the displayed top is the user-space left edge: CropBox [100 50 792 612]
    const crop = e.session.pdf.findPage(2).get('CropBox')
    expect([0, 1, 2, 3].map((k) => Math.round(crop.get(k).asNumber()))).toEqual([100, 50, 792, 612])
    await marks(e).setBoxes({
      pages: [0],
      box: 'TrimBox',
      margins: { top: 10, bottom: 10, left: 10, right: 10 }
    })
    const view = await marks(e).boxes(0, 0.25)
    expect(view.trim).not.toBeNull()
    expect(view.trim![0]).toBeCloseTo(10, 3)
    await expect(
      marks(e).setBoxes({ pages: [0], box: 'CropBox', margins: { top: 500, bottom: 500, left: 0, right: 0 } })
    ).rejects.toThrow(/larger than page 1/)
  })
})
