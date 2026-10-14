import { describe, expect, it } from 'vitest'
import type navOps from '@engine/ops/nav'
import type renderOps from '@engine/ops/render'
import type textOps from '@engine/ops/text'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import { fixture, openFixture, roundTrip } from './helpers'

describe('document core', () => {
  it('opens a PDF and reports pages, metadata and outline', async () => {
    const e = await openFixture('text.pdf')
    expect(e.info.pageCount).toBe(5)
    expect(e.info.pages[0].width).toBeCloseTo(612)
    expect(e.info.pages[0].height).toBeCloseTo(792)
    expect(e.info.metadata.title).toBe('Fixture Text Document')
    expect(e.info.pages.map((p) => p.label)).toEqual(['1', '2', '3', '4', '5'])
    const outline = await e.ops<typeof navOps>('nav').outline()
    expect(outline.map((o) => o.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4', 'Chapter 5'])
    expect(outline[2].dest?.page).toBe(2)
  })

  it('reports rotated and mixed page sizes like MuPDF does', async () => {
    const e = await openFixture('mixed-sizes.pdf')
    const sizes = e.info.pages.map((p) => [Math.round(p.width), Math.round(p.height), p.rotation])
    expect(sizes).toEqual([
      [595, 842, 0],
      [842, 595, 0],
      [612, 792, 90]
    ])
    for (let i = 0; i < 3; i++) {
      const b = e.session.pageBounds(i)
      expect(Math.round(b[2] - b[0])).toBe(sizes[i][0])
      expect(Math.round(b[3] - b[1])).toBe(sizes[i][1])
    }
  })

  it('renders a page to RGBA pixels at the requested scale', async () => {
    const e = await openFixture('text.pdf')
    const r = await e.ops<typeof renderOps>('render').page(0, { scale: 0.5 })
    expect(r.width).toBe(306)
    expect(r.height).toBe(396)
    expect(r.pixels!.length).toBe(306 * 396 * 4)
    // background is white, the blue rectangle is blue
    expect([...r.pixels!.slice(0, 4)]).toEqual([255, 255, 255, 255])
  })

  it('renders a clipped region', async () => {
    const e = await openFixture('text.pdf')
    const r = await e.ops<typeof renderOps>('render').page(0, { scale: 2, clip: [100, 100, 300, 200] })
    expect([r.x, r.y, r.width, r.height]).toEqual([100, 100, 200, 100])
  })

  it('extracts text with per-character quads and font info', async () => {
    const e = await openFixture('text.pdf')
    const t = await e.ops<typeof textOps>('text').page(0)
    expect(t.text).toContain('Hello Fartcrobat page 1.')
    expect(t.quads.length).toBe(t.text.length * 8)
    const idx = t.text.indexOf('Chapter 1')
    const span = t.spans.find((s) => s.start <= idx && s.end > idx)!
    expect(span.font).toMatch(/Helvetica/)
    expect(span.size).toBeCloseTo(24)
    expect(span.flags & 1).toBe(1) // bold
    // quad of 'C' in "Chapter 1" sits near y = 792 - 700
    const qy = t.quads[idx * 8 + 5]
    expect(qy).toBeGreaterThan(85)
    expect(qy).toBeLessThan(100)
  })

  it('reads links with internal destinations', async () => {
    const e = await openFixture('text.pdf')
    const links = await e.ops<typeof navOps>('nav').links(0)
    const ext = links.find((l) => l.external)!
    expect(ext.uri).toBe('https://example.com')
    const internal = links.find((l) => !l.external)!
    expect(internal.dest?.page).toBe(2)
  })

  it('tracks dirty state and undo/redo of metadata changes', async () => {
    const e = await openFixture('text.pdf')
    expect(await e.doc.isDirty()).toBe(false)
    await e.doc.setMetadata({ title: 'New Title' })
    expect(e.lastChanges?.journal.canUndo).toBe(true)
    expect(e.lastChanges?.journal.undoLabel).toBe('Change Document Properties')
    expect(e.lastChanges?.dirty).toBe(true)
    expect((await e.doc.info()).metadata.title).toBe('New Title')
    await e.doc.undo()
    expect((await e.doc.info()).metadata.title).toBe('Fixture Text Document')
    expect(e.lastChanges?.dirty).toBe(false)
    await e.doc.redo()
    expect((await e.doc.info()).metadata.title).toBe('New Title')
  })

  it('saves, keeps undo history after saving, and round-trips', async () => {
    const e = await openFixture('text.pdf')
    await e.doc.setMetadata({ author: 'Someone' })
    const bytes = await e.doc.save({})
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    await e.doc.markSaved()
    expect(await e.doc.isDirty()).toBe(false)
    await e.doc.undo()
    expect((await e.doc.info()).metadata.author).toBe('Fartcrobat Tests')
    await e.doc.redo()
    const again = await roundTrip(e)
    expect(again.info.metadata.author).toBe('Someone')
  })

  it('opens encrypted files with a password and can remove security', async () => {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    const first = await doc.open(fixture('encrypted.pdf'), { fileName: 'encrypted.pdf' })
    expect(first).toEqual({ ok: false, needsPassword: true, wrongPassword: false, lock: expect.objectContaining({ handler: 'Standard' }) })
    const wrong = await doc.authenticate('nope')
    expect(wrong.ok).toBe(false)
    const ok = await doc.authenticate('secret')
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.info.encryption).toMatch(/RC4|AES/)
    const plain = await doc.save({ decrypt: true })
    const e2 = await createLocalEngine()
    const r = await e2.ops<typeof docOps>('doc').open(plain, { fileName: 'plain.pdf' })
    expect(r.ok).toBe(true)
  })

  it('encrypts with AES-256 and permissions', async () => {
    const e = await openFixture('text.pdf')
    const bytes = await e.doc.save({
      encrypt: { method: 'aes-256', userPassword: 'open', ownerPassword: 'own', permissions: { print: true, copy: false } }
    })
    const e2 = await createLocalEngine()
    const d2 = e2.ops<typeof docOps>('doc')
    expect((await d2.open(bytes, { fileName: 'x.pdf' })).ok).toBe(false)
    const res = await d2.authenticate('open')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.info.encryption).toMatch(/256/)
      expect(res.info.permissions.copy).toBe(false)
      expect(res.info.permissions.print).toBe(true)
    }
  })

  it('compacts without breaking the live document undo history', async () => {
    const e = await openFixture('text.pdf')
    await e.doc.setMetadata({ title: 'Compacted' })
    const bytes = await e.doc.save({ garbage: 'deduplicate', compressImages: true, compressFonts: true })
    expect(bytes.length).toBeGreaterThan(100)
    await e.doc.undo()
    expect((await e.doc.info()).metadata.title).toBe('Fixture Text Document')
  })

  it('converts images to PDF on open', async () => {
    const engine = await createLocalEngine()
    const res = await engine.ops<typeof docOps>('doc').open(fixture('scan.png'), { fileName: 'scan.png' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.info.converted).toBe(true)
      expect(res.info.format).toBe('PNG')
      expect(res.info.pageCount).toBe(1)
    }
    expect(await engine.ops<typeof docOps>('doc').isDirty()).toBe(true)
  })

  it('creates a blank document', async () => {
    const engine = await createLocalEngine()
    const res = await engine.ops<typeof docOps>('doc').createBlank({ pages: 3 })
    expect(res.ok && res.info.pageCount).toBe(3)
  })
})
