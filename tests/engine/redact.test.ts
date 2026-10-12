import { inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type textOps from '@engine/ops/text'
import type renderOps from '@engine/ops/render'
import type annotOps from '@engine/ops/annots'
import type formOps from '@engine/ops/forms'
import type navOps from '@engine/ops/nav'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type { Quad } from '@shared/geometry'
import { rangeQuads, type PageText } from '@renderer/document/textModel'
import type redactOps from '@features/redact/engine'
import { DEFAULT_PROPS, type RedactionProps } from '@features/redact/shared'
import { openFixture, type OpenedEngine } from './helpers'

type Redact = typeof redactOps

/** Every stream of a saved PDF, decompressed when it is Flate-encoded, plus the raw bytes. */
function pdfStreams(bytes: Uint8Array): string[] {
  const s = Buffer.from(bytes).toString('latin1')
  const out: string[] = [s]
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length
    const end = s.indexOf('endstream', start)
    if (end < 0) break
    const raw = Buffer.from(s.slice(start, end), 'latin1')
    try {
      out.push(inflateSync(raw).toString('latin1'))
    } catch {
      out.push(raw.toString('latin1'))
    }
  }
  return out
}

function fileContains(bytes: Uint8Array, needle: string): boolean {
  return pdfStreams(bytes).some((t) => t.includes(needle))
}

async function pageText(e: OpenedEngine, page: number): Promise<PageText> {
  return e.ops<typeof textOps>('text').page(page)
}

async function quadsOf(e: OpenedEngine, page: number, needle: string): Promise<Quad[]> {
  const t = await pageText(e, page)
  const i = t.text.indexOf(needle)
  expect(i).toBeGreaterThanOrEqual(0)
  return rangeQuads(t, i, i + needle.length)
}

async function pixel(e: OpenedEngine, page: number, x: number, y: number): Promise<number[]> {
  const r = await e.ops<typeof renderOps>('render').page(page, { scale: 1, clip: [x, y, x + 1, y + 1] })
  const p = r.pixels!
  return [p[0], p[1], p[2]]
}

const props = (patch: Partial<RedactionProps> = {}): RedactionProps => ({ ...DEFAULT_PROPS, ...patch })

describe('redact: marks and apply', () => {
  it('removes a marked SSN from the page text and from the saved file, keeping the rest of the line', async () => {
    const e = await openFixture('text.pdf')
    const redact = e.ops<Redact>('redact')
    const quads = await quadsOf(e, 0, 'SSN: 123-45-6780')
    const marks = await redact.mark([{ page: 0, kind: 'text', quads }], props())
    expect(marks).toHaveLength(1)
    expect(marks[0].kind).toBe('text')
    expect(marks[0].quads).toHaveLength(1)
    expect(e.lastChanges?.journal.undoLabel).toBe('Mark for Redaction')
    expect(e.lastChanges?.dirty).toBe(true)
    expect(await redact.list()).toHaveLength(1)

    const report = await redact.apply()
    expect(report).toMatchObject({ marks: 1, pages: [0] })
    expect(e.lastChanges?.journal.undoLabel).toBe('Apply Redactions')
    expect(await redact.list()).toHaveLength(0)

    const text = (await pageText(e, 0)).text
    expect(text).not.toContain('6780')
    expect(text).not.toContain('SSN')
    expect(text).toContain('Phone: (555) 010-0000')
    // other pages are untouched
    expect((await pageText(e, 1)).text).toContain('SSN: 123-45-6781')

    // the redacted area is filled black
    const r = marks[0].rect
    expect(await pixel(e, 0, Math.round((r[0] + r[2]) / 2), Math.round((r[1] + r[3]) / 2))).toEqual([0, 0, 0])

    const saved = await e.doc.save({})
    expect(fileContains(saved, '123-45-6780')).toBe(false)
    expect(fileContains(saved, '6780')).toBe(false)
    expect(fileContains(saved, '123-45-6781')).toBe(true)

    // reopened, the text is still gone
    const again = await createLocalEngine()
    const res = await again.ops<typeof docOps>('doc').open(saved, { fileName: 'redacted.pdf' })
    expect(res.ok).toBe(true)
    const t2 = await again.ops<typeof textOps>('text').page(0)
    expect(t2.text).not.toContain('6780')
    expect(t2.text).toContain('Phone: (555) 010-0000')

    // undo brings the content back (until saved and closed)
    await e.doc.undo()
    expect((await pageText(e, 0)).text).toContain('SSN: 123-45-6780')
    expect(await redact.list()).toHaveLength(1)
  })

  it('forces full saves after applying, so the original bytes cannot leak', async () => {
    const e = await openFixture('text.pdf')
    const redact = e.ops<Redact>('redact')
    expect(await redact.needsCleanSave()).toBe(false)
    await redact.mark([{ page: 0, kind: 'text', quads: await quadsOf(e, 0, 'billing0@example.com') }], props())
    await redact.apply()
    expect(await redact.needsCleanSave()).toBe(true)
    await expect(e.doc.save({ mode: 'incremental' })).rejects.toThrow(/saved in full/)
    const saved = await e.doc.save({ mode: 'auto' })
    expect(Buffer.from(saved).toString('latin1').match(/%%EOF/g)?.length).toBe(1)
    expect(fileContains(saved, 'billing0@example.com')).toBe(false)
  })

  it('looks the same after the clean (sanitized) save as before it', async () => {
    const e = await openFixture('text.pdf')
    const redact = e.ops<Redact>('redact')
    await redact.mark([{ page: 0, kind: 'text', quads: await quadsOf(e, 0, 'billing0@example.com') }], props({ overlay: 'code', code: '(b)(6)' }))
    await redact.mark([{ page: 0, kind: 'area', rect: [60, 320, 300, 420] }], props({ overlay: 'custom', customText: 'WITHHELD', repeat: true }))
    await redact.apply()
    const before = (await e.ops<typeof renderOps>('render').page(0, { scale: 1 })).pixels!
    const saved = await e.doc.save({})
    const again = await createLocalEngine()
    await again.ops<typeof docOps>('doc').open(saved, { fileName: 'r.pdf' })
    const after = (await again.ops<typeof renderOps>('render').page(0, { scale: 1 })).pixels!
    expect(after.length).toBe(before.length)
    let diff = 0
    for (let i = 0; i < before.length; i += 4) if (Math.abs(before[i] - after[i]) > 40) diff++
    expect(diff / (before.length / 4)).toBeLessThan(0.002)
  })

  it('draws overlay text with the chosen properties', async () => {
    const e = await openFixture('text.pdf')
    const redact = e.ops<Redact>('redact')
    const quads = await quadsOf(e, 0, 'billing0@example.com')
    const p = props({ overlay: 'code', code: '(b)(6)', fillColor: '#ff0000', textColor: '#ffffff', font: 'Helvetica-Bold' })
    const [mark] = await redact.mark([{ page: 0, kind: 'text', quads }], p)
    expect(mark.props.overlay).toBe('code')
    expect(mark.props.code).toBe('(b)(6)')
    expect(mark.props.fillColor).toBe('#ff0000')
    expect(mark.props.font).toBe('Helvetica-Bold')
    await redact.apply()
    const text = (await pageText(e, 0)).text
    expect(text).not.toContain('billing0')
    expect(text).toContain('(b)(6)')
    // red fill at the left edge of the area (the overlay text is centred)
    const r = mark.rect
    const px = await pixel(e, 0, Math.round(r[0] + 2), Math.round((r[1] + r[3]) / 2))
    expect(px[0]).toBeGreaterThan(200)
    expect(px[1]).toBeLessThan(60)
  })

  it('fills and labels the right place on rotated pages', async () => {
    const e = await openFixture('redact/rotated.pdf')
    const redact = e.ops<Redact>('redact')
    expect(e.info.pages[0].rotation).toBe(90)
    const [mark] = await redact.mark([{ page: 0, kind: 'text', quads: await quadsOf(e, 0, 'secret text') }], props({ overlay: 'custom', customText: 'XX' }))
    // rotated text: the mark is taller than wide in page space
    expect(mark.rect[3] - mark.rect[1]).toBeGreaterThan(mark.rect[2] - mark.rect[0])
    await redact.apply()
    const t = (await pageText(e, 0)).text
    expect(t).not.toContain('secret')
    expect(t).toContain('Rotated')
    expect(t).toContain('stays hidden')
    expect(t).toContain('Second line remains')
    expect(t).toContain('XX')
    // the fill sits where the text was (page space accounts for /Rotate): sample near one end of the mark
    const r = mark.rect
    const cx = Math.round((r[0] + r[2]) / 2)
    expect(await pixel(e, 0, cx, Math.round(r[1] + (r[3] - r[1]) * 0.1))).toEqual([0, 0, 0])
    expect(await pixel(e, 0, cx, Math.round(r[1] + (r[3] - r[1]) * 0.9))).toEqual([0, 0, 0])
    // and nowhere else: just outside the mark the page is white
    expect(await pixel(e, 0, Math.round(r[2] + 30), Math.round((r[1] + r[3]) / 2))).toEqual([255, 255, 255])
  })

  it('repeats overlay text and can leave the area unfilled', async () => {
    const e = await openFixture('text.pdf')
    const redact = e.ops<Redact>('redact')
    await redact.mark([{ page: 0, kind: 'area', rect: [300, 380, 560, 440] }], props({ overlay: 'custom', customText: 'SECRET', repeat: true, fillColor: null, textColor: '#000000' }))
    await redact.apply()
    const t = (await pageText(e, 0)).text
    expect((t.match(/SECRET/g) ?? []).length).toBeGreaterThan(3)
  })

  it('removes only the covered pixels of an image (area redaction)', async () => {
    const e = await openFixture('scanned.pdf')
    const redact = e.ops<Redact>('redact')
    // first text line of the scan sits around y = 72..95 pt
    let dark: [number, number] | null = null
    for (let y = 74; y < 96 && !dark; y++) {
      for (let x = 72; x < 200; x++) {
        const p = await pixel(e, 0, x, y)
        if (p[0] < 100) {
          dark = [x, y]
          break
        }
      }
    }
    expect(dark).not.toBeNull()
    // a dark pixel of a line further down stays
    let below: [number, number] | null = null
    for (let y = 112; y < 135 && !below; y++) {
      for (let x = 72; x < 200; x++) {
        const p = await pixel(e, 0, x, y)
        if (p[0] < 100) {
          below = [x, y]
          break
        }
      }
    }
    expect(below).not.toBeNull()
    await redact.mark([{ page: 0, kind: 'area', rect: [60, 60, 400, 100] }], props({ fillColor: null }))
    await redact.apply()
    expect((await pixel(e, 0, dark![0], dark![1]))[0]).toBeGreaterThan(240)
    expect((await pixel(e, 0, below![0], below![1]))[0]).toBeLessThan(100)
  })

  it('applies only the chosen marks and keeps the others', async () => {
    const e = await openFixture('text.pdf')
    const redact = e.ops<Redact>('redact')
    const [a] = await redact.mark([{ page: 0, kind: 'text', quads: await quadsOf(e, 0, 'billing0@example.com') }], props())
    const [b] = await redact.mark([{ page: 0, kind: 'text', quads: await quadsOf(e, 0, 'SSN: 123-45-6780') }], props())
    const report = await redact.apply([a.id])
    expect(report.marks).toBe(1)
    const left = await redact.list()
    expect(left.map((m) => m.id)).toEqual([b.id])
    const text = (await pageText(e, 0)).text
    expect(text).not.toContain('billing0')
    expect(text).toContain('SSN: 123-45-6780')
  })

  it('marks whole pages, updates properties and deletes marks with undo', async () => {
    const e = await openFixture('text.pdf')
    const redact = e.ops<Redact>('redact')
    const marks = await redact.mark(
      [
        { page: 1, kind: 'page', rect: [0, 0, 612, 792] },
        { page: 3, kind: 'page', rect: [0, 0, 612, 792] }
      ],
      props()
    )
    expect(marks.map((m) => m.kind)).toEqual(['page', 'page'])
    await redact.update([marks[0].id], props({ overlay: 'custom', customText: 'WITHHELD', fillColor: '#333333' }))
    const updated = (await redact.list()).find((m) => m.id === marks[0].id)!
    expect(updated.props.customText).toBe('WITHHELD')
    expect(updated.props.fillColor).toBe('#333333')
    await redact.remove([marks[1].id])
    expect(await redact.list()).toHaveLength(1)
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete Redaction Mark')
    await e.doc.undo()
    expect(await redact.list()).toHaveLength(2)
    await redact.apply()
    const t1 = (await pageText(e, 1)).text
    expect(t1.replace(/\s/g, '')).toBe('WITHHELD')
    expect((await pageText(e, 3)).text.trim()).toBe('')
    expect((await pageText(e, 2)).text).toContain('Chapter 3')
  })

  it('draws the overlay once when a mark lies inside a page that is redacted whole', async () => {
    const e = await openFixture('text.pdf')
    const redact = e.ops<Redact>('redact')
    const p = props({ overlay: 'custom', customText: 'WITHHELD' })
    await redact.mark([{ page: 2, kind: 'text', quads: await quadsOf(e, 2, 'billing2@example.com') }], p)
    await redact.mark([{ page: 2, kind: 'page', rect: [0, 0, 612, 792] }], p)
    await redact.apply()
    expect((await pageText(e, 2)).text.replace(/\s/g, '')).toBe('WITHHELD')
  })

  it('removes comments and form fields lying in redacted areas', async () => {
    const e = await openFixture('form.pdf')
    const redact = e.ops<Redact>('redact')
    const annots = e.ops<typeof annotOps>('annots')
    const forms = e.ops<typeof formOps>('forms')
    const before = await forms.listAll()
    const email = before.find((f) => f.name === 'email')!
    const note = await annots.create(0, { type: 'Text', rect: [200, 138, 220, 152], contents: 'secret note' })
    await annots.reply(note.id, 'reply to secret')
    const far = await annots.create(0, { type: 'Square', rect: [400, 600, 450, 650] })
    await redact.mark([{ page: 0, kind: 'area', rect: [150, 130, 470, 160] }], props())
    const report = await redact.apply()
    expect(report.removedFields).toBe(1)
    expect(report.removedAnnotations).toBe(2)
    const after = await forms.listAll()
    expect(after.find((f) => f.name === 'email')).toBeUndefined()
    expect(after.find((f) => f.name === 'fullName')).toBeDefined()
    const left = await annots.list(0)
    expect(left.map((a) => a.id)).toEqual([far.id])
    expect(email).toBeDefined()
  })
})

describe('redact: remove hidden information', () => {
  it('finds every kind of hidden information', async () => {
    const e = await openFixture('redact/hidden-info.pdf')
    const scan = await e.ops<Redact>('redact').scanHidden()
    expect(scan.metadata.count).toBeGreaterThanOrEqual(7)
    expect(scan.metadata.details.join('|')).toContain('Author: Jane Secret')
    expect(scan.metadata.details).toContain('XMP metadata')
    expect(scan.attachments.count).toBe(2)
    expect(scan.attachments.details).toEqual(expect.arrayContaining(['notes.txt', 'photo.txt']))
    expect(scan.bookmarks.count).toBe(2)
    expect(scan.comments.count).toBe(2)
    expect(scan.forms.count).toBe(1)
    expect(scan.hiddenText.count).toBe('INVISIBLEOCRLAYER'.length)
    expect(scan.hiddenLayers.details).toEqual(['Hidden layer'])
    expect(scan.searchIndex.count).toBe(1)
    expect(scan.javascript.count).toBeGreaterThanOrEqual(6)
    expect(scan.externalLinks.count).toBe(1)
    expect(scan.externalLinks.details).toContain('https://example.com/secret')
    expect(scan.overlapping.count).toBe('COVEREDSECRET4111'.length)
    expect(scan.overlapping.details[0]).toContain('COVERED SECRET 4111')
  })

  it('removes everything selected and nothing else', async () => {
    const e = await openFixture('redact/hidden-info.pdf')
    const redact = e.ops<Redact>('redact')
    const report = await redact.sanitize({
      items: ['metadata', 'attachments', 'bookmarks', 'comments', 'forms', 'hiddenText', 'hiddenLayers', 'searchIndex', 'javascript', 'externalLinks', 'overlapping'],
      forms: 'flatten'
    })
    expect(report.removed.map((r) => r.id).sort()).toEqual(
      ['attachments', 'bookmarks', 'comments', 'externalLinks', 'forms', 'hiddenLayers', 'hiddenText', 'javascript', 'metadata', 'overlapping', 'searchIndex'].sort()
    )
    expect(e.lastChanges?.journal.undoLabel).toBe('Remove Hidden Information')
    const rescan = await redact.scanHidden()
    for (const item of Object.values(rescan)) expect([item.id, item.count]).toEqual([item.id, 0])

    const text = (await pageText(e, 0)).text
    expect(text).not.toContain('INVISIBLE')
    expect(text).not.toContain('COVERED')
    expect(text).toContain('Visible paragraph text stays.')
    expect(text).toContain('Visible layer text')
    expect(text).toContain('Visit the website and page two.')
    // the flattened field value stays visible as page content
    expect(text).toContain('Jane Secret')
    // the internal link survives, the external one is gone
    const links = await e.ops<typeof navOps>('nav').links(0)
    expect(links.map((l) => l.external)).toEqual([false])

    const saved = await e.doc.save({})
    for (const secret of ['Secret project plan', 'attached secret notes', 'annotation attachment secret', 'app.alert', 'example.com/secret', 'HIDDEN LAYER SECRET', 'INVISIBLE OCR', 'COVERED SECRET', 'Reviewer note', 'Secret chapter', 'index-data', 'private application data', 'AFSpecial']) {
      expect([secret, fileContains(saved, secret)]).toEqual([secret, false])
    }
    // the hidden layer rectangle (red) is gone, the page still renders the visible text
    expect(await pixel(e, 0, 360, 172)).toEqual([255, 255, 255])

    // undo restores everything
    await e.doc.undo()
    expect((await redact.scanHidden()).attachments.count).toBe(2)
  })

  it('keeps pending redaction marks and visible text when removing hidden text only', async () => {
    const e = await openFixture('redact/hidden-info.pdf')
    const redact = e.ops<Redact>('redact')
    await redact.mark([{ page: 0, kind: 'area', rect: [400, 400, 500, 450] }], props())
    await redact.sanitize({ items: ['hiddenText'] })
    expect(await redact.list()).toHaveLength(1)
    const t = (await pageText(e, 0)).text
    expect(t).not.toContain('INVISIBLE')
    expect(t).toContain('COVERED SECRET 4111')
    expect(t).toContain('Hidden information test')
    // nothing else was removed
    const scan = await redact.scanHidden()
    expect(scan.attachments.count).toBe(2)
    expect(scan.externalLinks.count).toBe(1)
  })

  it('removes form fields entirely when asked', async () => {
    const e = await openFixture('redact/hidden-info.pdf')
    const redact = e.ops<Redact>('redact')
    await redact.sanitize({ items: ['forms'], forms: 'remove' })
    expect((await pageText(e, 0)).text).not.toContain('Jane Secret')
    expect(await e.ops<typeof formOps>('forms').listAll()).toHaveLength(0)
  })
})
