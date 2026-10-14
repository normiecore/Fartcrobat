import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type textOps from '@engine/ops/text'
import type annotOps from '@engine/ops/annots'
import type ops from '@features/protect-optimize/engine'
import {
  DEFAULT_PROTECT_SETTINGS,
  compressedName,
  encryptOptions,
  formatBytes,
  passwordStrength,
  permissionsFor,
  presetOptions,
  reductionSummary,
  restrictionList,
  validateProtect,
  type OptimizeOptions,
  type ProtectSettings
} from '@features/protect-optimize/shared'
import { decodeAscii85, decodeAsciiHex, packBits, pngPredict } from '@features/protect-optimize/optimize'
import { fixture, openFixture } from './helpers'

const NS = 'protect-optimize'

async function openBytes(bytes: Uint8Array, password?: string) {
  const engine = await createLocalEngine()
  const doc = engine.ops<typeof docOps>('doc')
  let res = await doc.open(bytes, { fileName: 'test.pdf' })
  if (!res.ok && password !== undefined) res = await doc.authenticate(password)
  return { engine, doc, res, po: engine.ops<typeof ops>(NS), text: engine.ops<typeof textOps>('text') }
}

/** Image XObjects of a PDF: object number -> width, height, filter. */
function imagesOf(bytes: Uint8Array, password?: string) {
  const d = mupdf.Document.openDocument(bytes, 'application/pdf')
  if (password) d.authenticatePassword(password)
  const pdf = d.asPDF()!
  const out: { num: number; w: number; h: number; filter: string; bpc: number; smask: boolean; imageMask: boolean }[] = []
  for (let i = 1; i < pdf.countObjects(); i++) {
    const ref = pdf.newIndirect(i)
    if (!ref.isStream()) continue
    const o = ref.resolve()
    if (o.get('Subtype').isName() && o.get('Subtype').asName() === 'Image') {
      out.push({
        num: i,
        w: o.get('Width').asNumber(),
        h: o.get('Height').asNumber(),
        filter: o.get('Filter').toString(),
        bpc: o.get('BitsPerComponent').isNull() ? 1 : o.get('BitsPerComponent').asNumber(),
        smask: !o.get('SMask').isNull(),
        imageMask: o.get('ImageMask').isBoolean() && o.get('ImageMask').asBoolean()
      })
    }
  }
  return out
}

const protect = (patch: Partial<ProtectSettings>): ProtectSettings => ({ ...DEFAULT_PROTECT_SETTINGS, ...patch })

describe('protect-optimize: security', () => {
  it('maps dialog choices to permissions like Acrobat', () => {
    const none = permissionsFor(protect({ restrictEditing: true, printing: 'none', changes: 'none', allowCopy: false, allowScreenReaders: false }))
    expect(Object.values(none).every((v) => v === false)).toBe(true)
    const low = permissionsFor(protect({ restrictEditing: true, printing: 'low', changes: 'pages' }))
    expect(low).toMatchObject({ print: true, 'print-hq': false, assemble: true, edit: false, annotate: false, form: false })
    const comments = permissionsFor(protect({ restrictEditing: true, printing: 'high', changes: 'comments', allowCopy: true, allowScreenReaders: false }))
    expect(comments).toMatchObject({ print: true, 'print-hq': true, annotate: true, form: true, edit: false, assemble: false, copy: true, accessibility: true })
    const any = permissionsFor(protect({ restrictEditing: true, changes: 'any' }))
    expect(any).toMatchObject({ edit: true, annotate: true, form: true, assemble: true, copy: false })
    expect(Object.values(permissionsFor(protect({ restrictEditing: false }))).every(Boolean)).toBe(true)
    expect(restrictionList(none)).toContain('printing')
  })

  it('validates passwords (commas, confirmation, different passwords)', () => {
    expect(validateProtect(protect({ openPassword: 'a,b' }), 'a,b', '').open).toMatch(/comma/)
    expect(validateProtect(protect({ openPassword: 'abc' }), 'abd', '').openConfirm).toMatch(/match/)
    expect(validateProtect(protect({ openPassword: 'abc' }), 'abc', '')).toEqual({})
    expect(validateProtect(protect({ requireOpenPassword: false }), '', '').general).toBeTruthy()
    expect(
      validateProtect(protect({ openPassword: 'same', restrictEditing: true, permissionsPassword: 'same' }), 'same', 'same').perms
    ).toMatch(/different/)
    expect(validateProtect(protect({ openPassword: '日本', method: 'rc4-128' }), '日本', '').open).toMatch(/256-bit AES/)
    expect(validateProtect(protect({ openPassword: '日本', method: 'aes-256' }), '日本', '')).toEqual({})
    expect(passwordStrength('abc').label).toBe('Weak')
    expect(passwordStrength('Tr0ub4dor&3-horse-battery').label).toBe('Best')
  })

  it('encrypts with an open password and no copying; reopening needs the password and reports permissions', async () => {
    const e = await openFixture('text.pdf')
    const settings = protect({
      openPassword: 'abc',
      restrictEditing: true,
      permissionsPassword: 'owner-pw',
      printing: 'low',
      changes: 'comments',
      allowCopy: false,
      allowScreenReaders: true
    })
    expect(validateProtect(settings, 'abc', 'owner-pw')).toEqual({})
    const bytes = await e.doc.save({ mode: 'full', encrypt: encryptOptions(settings) })

    const locked = await openBytes(bytes)
    expect(locked.res).toEqual({ ok: false, needsPassword: true, wrongPassword: false, lock: expect.objectContaining({ handler: 'Standard' }) })
    expect((await locked.doc.authenticate('nope')).ok).toBe(false)
    const ok = await locked.doc.authenticate('abc')
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    expect(ok.info.encryption).toMatch(/256/)
    expect(ok.info.permissions).toMatchObject({ copy: false, print: true, 'print-hq': false, annotate: true, form: true, edit: false, assemble: false })

    const st = await locked.po.security()
    expect(st).toMatchObject({ encrypted: true, method: '256-bit AES', needsOpenPassword: true, ownerAccess: false })
    expect(st.filePermissions.copy).toBe(false)
    expect((await locked.text.page(0)).text).toContain('Chapter 1')

    // The permissions password unlocks everything for this session only.
    expect((await locked.po.checkPassword('abc')).level).toBe('user')
    expect((await locked.po.checkPassword('wrong', { apply: true })).level).toBe('none')
    expect((await locked.po.security()).ownerAccess).toBe(false)
    expect((await locked.po.checkPassword('owner-pw', { apply: true })).level).toBe('owner')
    const unlocked = await locked.po.security()
    expect(unlocked.ownerAccess).toBe(true)
    expect(unlocked.filePermissions.copy).toBe(false)
    expect((await locked.doc.info()).permissions.copy).toBe(true)
    // The document still renders and reads after unlocking.
    expect((await locked.text.page(1)).text).toContain('Chapter 2')
  })

  it('restricts editing without an open password, and supports every encryption level', async () => {
    const e = await openFixture('text.pdf')
    for (const method of ['aes-256', 'aes-128', 'rc4-128'] as const) {
      const settings = protect({ requireOpenPassword: false, restrictEditing: true, permissionsPassword: 'perm', changes: 'none', printing: 'none', method })
      const bytes = await e.doc.save({ mode: 'full', encrypt: encryptOptions(settings) })
      const o = await openBytes(bytes)
      expect(o.res.ok).toBe(true)
      if (!o.res.ok) continue
      expect(o.res.info.permissions).toMatchObject({ print: false, edit: false, copy: false, annotate: false })
      const st = await o.po.security()
      expect(st.needsOpenPassword).toBe(false)
      expect(st.method).toBe(method === 'aes-256' ? '256-bit AES' : method === 'aes-128' ? '128-bit AES' : '128-bit RC4')
      // unlocking keeps the document readable with every encryption level
      expect((await o.po.checkPassword('perm', { apply: true })).level).toBe('owner')
      expect((await o.po.security()).ownerAccess).toBe(true)
      expect((await o.text.page(4)).text).toContain('Chapter 5')
    }
  })

  it('replaces the security of an already protected document', async () => {
    const e = await openFixture('text.pdf')
    const first = await e.doc.save({ mode: 'full', encrypt: encryptOptions(protect({ openPassword: 'one', method: 'rc4-128' })) })
    const o = await openBytes(first, 'one')
    expect((await o.po.security()).ownerAccess).toBe(true)
    const second = await o.doc.save({ mode: 'full', encrypt: encryptOptions(protect({ openPassword: 'two', restrictEditing: true, permissionsPassword: 'own', printing: 'none' })) })
    const again = await openBytes(second)
    expect(again.res.ok).toBe(false)
    expect((await again.doc.authenticate('one')).ok).toBe(false)
    const ok = await again.doc.authenticate('two')
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.info.encryption).toMatch(/256-bit AES/)
      expect(ok.info.permissions.print).toBe(false)
    }
  })

  it('removes security', async () => {
    const e = await openFixture('text.pdf')
    const bytes = await e.doc.save({ mode: 'full', encrypt: encryptOptions(protect({ openPassword: 'abc', restrictEditing: true, permissionsPassword: 'own' })) })
    const o = await openBytes(bytes, 'abc')
    expect((await o.po.checkPassword('own', { apply: true })).level).toBe('owner')
    const plain = await o.doc.save({ mode: 'full', decrypt: true })
    const p = await openBytes(plain)
    expect(p.res.ok).toBe(true)
    if (p.res.ok) {
      expect(p.res.info.encryption).toBeNull()
      expect(Object.values(p.res.info.permissions).every(Boolean)).toBe(true)
    }
    expect(await p.po.security()).toMatchObject({ encrypted: false, needsOpenPassword: false, ownerAccess: true })
    expect((await p.text.page(0)).text).toContain('Chapter 1')
  })

  it('reports an unprotected document', async () => {
    const e = await openFixture('text.pdf')
    expect(await e.ops<typeof ops>(NS).security()).toMatchObject({ encrypted: false, method: null, needsOpenPassword: false, ownerAccess: true })
    expect((await e.ops<typeof ops>(NS).checkPassword('anything')).level).toBe('owner')
  })
})

describe('protect-optimize: compress', () => {
  it('downsamples a 3000 px photo placed at 2 inches to about 150 ppi and keeps the text', async () => {
    const original = fixture('protect-optimize/big-image.pdf')
    const e = await openFixture('protect-optimize/big-image.pdf')
    const before = imagesOf(original)
    expect(before).toHaveLength(1)
    expect(before[0].w).toBe(3000)
    const progress: number[] = []
    const res = await e.dispatcher.call(`${NS}.optimize`, [presetOptions('medium')], (f) => progress.push(f))
    const { bytes, report } = res.result as { bytes: Uint8Array; report: import('@features/protect-optimize/shared').OptimizeReport }
    expect(bytes.length).toBeLessThan(original.length / 5)
    expect(report.resultSize).toBe(bytes.length)
    expect(report.images.downsampled).toBe(1)
    expect(report.images.bytesAfter).toBeLessThan(report.images.bytesBefore)
    expect(progress.length).toBeGreaterThan(2)
    expect(progress[progress.length - 1]).toBe(1)
    const after = imagesOf(bytes)
    expect(after).toHaveLength(1)
    expect(after[0].w).toBeGreaterThanOrEqual(295)
    expect(after[0].w).toBeLessThanOrEqual(305)
    expect(after[0].h).toBe(after[0].w)
    expect(after[0].filter).toBe('/DCTDecode')

    const o = await openBytes(bytes)
    expect(o.res.ok).toBe(true)
    const text = (await o.text.page(0)).text
    expect(text).toContain('Quarterly Report 2026')
    expect(text).toContain('Figure 1. A very large photo.')
    // the page still shows the photo: render the image area and check it is not blank
    const render = await o.engine.call<{ pixels: Uint8ClampedArray; width: number }>('render.page', 0, { scale: 0.5 })
    const px = render.pixels
    const at = (x: number, y: number) => (y * render.width + x) * 4
    const sample = px[at(Math.round(144 * 0.5), Math.round((792 - 512) * 0.5))]
    expect(sample).toBeLessThan(250)
    // the open document is untouched
    expect((await e.doc.journal()).canUndo).toBe(false)
    expect(await e.doc.isDirty()).toBe(false)
  })

  it('handles soft masks, grayscale, 1-bit images, shared images and leaves low resolution images alone', async () => {
    const original = fixture('protect-optimize/mixed-images.pdf')
    const e = await openFixture('protect-optimize/mixed-images.pdf')
    const before = imagesOf(original)
    const { bytes, report } = await e.ops<typeof ops>(NS).optimize(presetOptions('medium'))
    expect(bytes.length).toBeLessThan(original.length / 3)
    const after = imagesOf(bytes)
    const by = (w: number, h: number, list = before) => list.find((i) => i.w === w && i.h === h)
    // RGB logo with soft mask: 1200 px at 1.5 in -> 225 px, and its mask follows
    const logo = after.find((i) => i.smask)!
    expect(logo.w).toBe(225)
    expect(logo.filter).toBe('/FlateDecode') // lossless next to a soft mask
    const masks = after.filter((i) => i.w === 225 && !i.smask)
    expect(masks.length).toBeGreaterThanOrEqual(1)
    // grayscale 1600x1200 at 2 x 1.5 in -> 300 x 225
    expect(by(300, 225, after)).toBeTruthy()
    // low resolution image untouched
    expect(by(100, 100, after)).toBeTruthy()
    // shared photo drawn at 4 in (largest use) -> 600 px
    expect(by(600, 600, after)).toBeTruthy()
    expect(by(2000, 2000, after)).toBeFalsy()
    expect(report.images.downsampled).toBeGreaterThanOrEqual(4)
    const o = await openBytes(bytes)
    expect(o.res.ok).toBe(true)
    expect((await o.text.page(1)).text).toContain('Page two text stays searchable.')
    // bookmarks are kept by default
    expect((await o.engine.call<unknown[]>('nav.outline')).length).toBe(1)
    // the pages look the same as before (mean difference per channel)
    for (const page of [0, 1]) {
      const a = await e.call<{ pixels: Uint8ClampedArray }>('render.page', page, { scale: 0.5 })
      const b = await o.engine.call<{ pixels: Uint8ClampedArray }>('render.page', page, { scale: 0.5 })
      let diff = 0
      let worstRow = 0
      const width = 306
      for (let y = 0; y < a.pixels.length / 4 / width; y++) {
        let row = 0
        for (let x = 0; x < width; x++) {
          const k = (y * width + x) * 4
          row += Math.abs(a.pixels[k] - b.pixels[k]) + Math.abs(a.pixels[k + 1] - b.pixels[k + 1]) + Math.abs(a.pixels[k + 2] - b.pixels[k + 2])
        }
        diff += row
        worstRow = Math.max(worstRow, row / width / 3)
      }
      expect(diff / (a.pixels.length * 0.75)).toBeLessThan(3)
      expect(worstRow).toBeLessThan(40)
    }
  })

  it('downsamples true 1-bit images and stencil masks', async () => {
    // Build a document with a 1-bit gray image and an image mask at 800 ppi.
    const doc = new mupdf.PDFDocument()
    const W = 1600
    const H = 800
    const data = new Uint8Array((W / 8) * H).fill(0xff)
    for (let y = 40; y < H - 40; y += 80) data.fill(0, y * (W / 8) + 10, (y + 30) * (W / 8) - 10)
    const dict = (o: Record<string, unknown>) => {
      const d = doc.newDictionary()
      for (const [k, v] of Object.entries(o)) d.put(k, v)
      return d
    }
    const mono = doc.addStream(data, dict({ Type: doc.newName('XObject'), Subtype: doc.newName('Image'), Width: W, Height: H, BitsPerComponent: 1, ColorSpace: doc.newName('DeviceGray') }))
    const stencil = doc.addStream(data, dict({ Type: doc.newName('XObject'), Subtype: doc.newName('Image'), Width: W, Height: H, ImageMask: true }))
    const res = dict({ XObject: dict({ Im1: mono, Im2: stencil }) })
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, 'q 144 0 0 72 72 600 cm /Im1 Do Q q 1 0 0 rg 144 0 0 72 72 400 cm /Im2 Do Q'))
    const src = doc.saveToBuffer('compress').asUint8Array().slice()
    const engine = await createLocalEngine()
    expect((await engine.ops<typeof docOps>('doc').open(src, { fileName: 'mono.pdf' })).ok).toBe(true)
    const { bytes, report } = await engine.ops<typeof ops>(NS).optimize(presetOptions('medium'))
    expect(report.images.downsampled).toBe(2)
    const after = imagesOf(bytes)
    expect(after).toHaveLength(2)
    for (const img of after) {
      expect(img.w).toBe(600) // 2 in at 300 ppi
      expect(img.h).toBe(300)
      expect(img.bpc).toBe(1)
    }
    expect(after.some((i) => i.imageMask)).toBe(true)
    // Rendering: the stencil is painted red where the stripes are.
    const out = await openBytes(bytes)
    const r = await out.engine.call<{ pixels: Uint8ClampedArray; width: number }>('render.page', 0, { scale: 1 })
    const at = (x: number, y: number) => (y * r.width + x) * 4
    // first stripe of the mask image: image rows 40..70 of 800 -> page y = 792-472 + (40..70)/800*72
    const y = Math.round(792 - 472 + 50 * (72 / 800))
    const p = at(144, y)
    expect(r.pixels[p]).toBeGreaterThan(230)
    expect(r.pixels[p + 1]).toBeLessThan(60)
    expect(r.pixels[p + 2]).toBeLessThan(60)
    // and the gaps between stripes stay white
    const gap = at(144, Math.round(792 - 472 + 100 * (72 / 800)))
    expect([r.pixels[gap], r.pixels[gap + 1], r.pixels[gap + 2]]).toEqual([255, 255, 255])
  })

  it('recompresses losslessly stored photos as JPEG when that is smaller, and not when disabled', async () => {
    const doc = new mupdf.PDFDocument()
    const W = 400
    const data = new Uint8Array(W * W * 3)
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        const k = (y * W + x) * 3
        data[k] = 128 + 120 * Math.sin(x / 23 + y / 41)
        data[k + 1] = 128 + 120 * Math.cos(y / 17 - x / 53)
        data[k + 2] = (x * y) % 255
      }
    }
    const d = doc.newDictionary()
    for (const [k, v] of Object.entries({ Type: doc.newName('XObject'), Subtype: doc.newName('Image'), Width: W, Height: W, BitsPerComponent: 8, ColorSpace: doc.newName('DeviceRGB') })) d.put(k, v)
    const img = doc.addStream(data, d)
    const res = doc.newDictionary()
    const xo = doc.newDictionary()
    xo.put('Im1', img)
    res.put('XObject', xo)
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, 'q 288 0 0 288 72 400 cm /Im1 Do Q')) // 4 in -> 100 ppi
    const src = doc.saveToBuffer('compress').asUint8Array().slice()
    const engine = await createLocalEngine()
    await engine.ops<typeof docOps>('doc').open(src, { fileName: 'photo.pdf' })
    const on = await engine.ops<typeof ops>(NS).optimize(presetOptions('medium'))
    expect(on.report.images.recompressed).toBe(1)
    expect(on.report.images.downsampled).toBe(0)
    expect(imagesOf(on.bytes)[0]).toMatchObject({ w: 400, h: 400, filter: '/DCTDecode' })
    const opts = presetOptions('medium')
    opts.images.color.recompress = false
    const off = await engine.ops<typeof ops>(NS).optimize(opts)
    expect(off.report.images.recompressed).toBe(0)
    expect(imagesOf(off.bytes)[0].filter).toBe('/FlateDecode')
  })

  it('keeps palette images in colour and leaves spot-colour images alone', async () => {
    const doc = new mupdf.PDFDocument()
    const W = 1600
    const H = 800
    const data = new Uint8Array(W * H)
    for (let y = 0; y < H; y++) data.fill(Math.floor(y / 100) % 2, y * W, (y + 1) * W) // red / blue stripes of 100 rows
    const dict = (o: Record<string, unknown>) => {
      const d = doc.newDictionary()
      for (const [k, v] of Object.entries(o)) d.put(k, v)
      return d
    }
    const indexed = doc.newArray()
    indexed.push(doc.newName('Indexed'))
    indexed.push(doc.newName('DeviceRGB'))
    indexed.push(1)
    indexed.push(doc.newByteString([255, 0, 0, 0, 0, 255]))
    const pal = doc.addStream(data, dict({ Type: doc.newName('XObject'), Subtype: doc.newName('Image'), Width: W, Height: H, BitsPerComponent: 8, ColorSpace: indexed }))
    const tint = doc.addStream('{dup 0 mul exch dup 0 mul exch 1 mul}', dict({ FunctionType: 4, Domain: [0, 1], Range: [0, 1, 0, 1, 0, 1] }))
    const sep = doc.newArray()
    sep.push(doc.newName('Separation'))
    sep.push(doc.newName('Spot Blue'))
    sep.push(doc.newName('DeviceRGB'))
    sep.push(tint)
    const spot = doc.addStream(data.map((v) => v * 255), dict({ Type: doc.newName('XObject'), Subtype: doc.newName('Image'), Width: W, Height: H, BitsPerComponent: 8, ColorSpace: sep }))
    const res = dict({ XObject: dict({ Im1: pal, Im2: spot }) })
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, 'q 144 0 0 72 72 600 cm /Im1 Do Q q 144 0 0 72 72 400 cm /Im2 Do Q'))
    const src = doc.saveToBuffer('compress').asUint8Array().slice()
    const engine = await createLocalEngine()
    await engine.ops<typeof docOps>('doc').open(src, { fileName: 'pal.pdf' })
    const { bytes, report } = await engine.ops<typeof ops>(NS).optimize(presetOptions('medium'))
    expect(report.images.downsampled).toBe(1)
    const after = imagesOf(bytes)
    expect(after.map((i) => [i.w, i.h]).sort()).toEqual([
      [1600, 800],
      [300, 150]
    ])
    const out = await openBytes(bytes)
    const r = await out.engine.call<{ pixels: Uint8ClampedArray; width: number }>('render.page', 0, { scale: 1 })
    const at = (x: number, y: number) => (y * r.width + x) * 4
    // first stripe (image rows 0-99, the top of the image) is red, the next one blue
    const red = at(144, Math.round(792 - 672 + 4))
    const blue = at(144, Math.round(792 - 672 + 13))
    expect([r.pixels[red], r.pixels[red + 1], r.pixels[red + 2]]).toEqual([255, 0, 0])
    expect([r.pixels[blue], r.pixels[blue + 1], r.pixels[blue + 2]]).toEqual([0, 0, 255])
  })

  it('keeps password protection when compressing and needs the open password', async () => {
    const e = await openFixture('protect-optimize/big-image.pdf')
    const enc = await e.doc.save({ mode: 'full', encrypt: encryptOptions(protect({ openPassword: 'abc', restrictEditing: true, permissionsPassword: 'own', allowCopy: false })) })
    const o = await openBytes(enc, 'abc')
    await expect(o.po.optimize(presetOptions('small'))).rejects.toThrow(/open password/)
    await expect(o.po.optimize(presetOptions('small'), 'bad')).rejects.toThrow(/incorrect/)
    const { bytes, report } = await o.po.optimize(presetOptions('small'), 'abc')
    expect(report.keptEncryption).toBe(true)
    expect(bytes.length).toBeLessThan(enc.length / 5)
    const again = await openBytes(bytes)
    expect(again.res.ok).toBe(false)
    const ok = await again.doc.authenticate('abc')
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.info.permissions.copy).toBe(false)
    expect(imagesOf(bytes, 'abc')[0].w).toBe(192) // 2 in at 96 ppi
  })

  it('discards bookmarks, comments, JavaScript and metadata, flattens fields and subsets fonts', async () => {
    const e = await openFixture('form.pdf')
    const annots = e.ops<typeof annotOps>('annots')
    await annots.create(0, { type: 'Text', rect: [400, 100, 420, 120], contents: 'A comment' } as any)
    const opts: OptimizeOptions = presetOptions('medium')
    opts.discard = { ...opts.discard, bookmarks: true, comments: true, javascript: true, formActions: true, metadata: true, flattenFields: true }
    const { bytes, report } = await e.ops<typeof ops>(NS).optimize(opts)
    expect(report.discarded).toEqual(expect.arrayContaining(['comments', 'JavaScript', 'metadata', 'form fields flattened']))
    const d = mupdf.Document.openDocument(bytes, 'application/pdf').asPDF()!
    const root = d.getTrailer().get('Root')
    expect(root.get('AcroForm').isNull()).toBe(true)
    expect(root.get('Outlines').isNull()).toBe(true)
    expect(d.getTrailer().get('Info').isNull()).toBe(true)
    const page = d.loadPage(0) as mupdf.PDFPage
    expect(page.getAnnotations().filter((a) => a.getType() === 'Text')).toHaveLength(0)
    expect(page.getWidgets()).toHaveLength(0)

    // font subsetting: a document with a fully embedded font gets much smaller
    const doc = new mupdf.PDFDocument()
    const font = doc.addFont(new mupdf.Font('Times-Roman'))
    const res = doc.newDictionary()
    const fonts = doc.newDictionary()
    fonts.put('F1', font)
    res.put('Font', fonts)
    doc.insertPage(-1, doc.addPage([0, 0, 612, 792], 0, res, 'BT /F1 24 Tf 72 700 Td <00410042> Tj ET'))
    const src = doc.saveToBuffer('compress').asUint8Array().slice()
    const engine = await createLocalEngine()
    await engine.ops<typeof docOps>('doc').open(src, { fileName: 'font.pdf' })
    const sub = await engine.ops<typeof ops>(NS).optimize(presetOptions('medium'))
    expect(sub.report.fontsSubset).toBe(true)
    expect(sub.bytes.length).toBeLessThan(src.length / 2)
  })

  it('marks an optimized copy opened in a new tab as unsaved', async () => {
    const e = await openFixture('text.pdf')
    expect(await e.doc.isDirty()).toBe(false)
    await e.ops<typeof ops>(NS).markUnsaved()
    expect(e.lastChanges?.dirty).toBe(true)
    expect(await e.doc.isDirty()).toBe(true)
  })

  it('audits space usage', async () => {
    const e = await openFixture('protect-optimize/mixed-images.pdf')
    const audit = await e.ops<typeof ops>(NS).audit()
    expect(audit.total).toBeGreaterThan(800_000)
    const images = audit.categories.find((c) => c.id === 'images')!
    expect(images.bytes / audit.total).toBeGreaterThan(0.9)
    expect(audit.categories.find((c) => c.id === 'content')).toBeTruthy()
  })

  it('removes ASCII stream encodings', async () => {
    const e = await openFixture('protect-optimize/mixed-images.pdf')
    const opts = presetOptions('medium')
    opts.images.color.downsample = false
    opts.images.gray.downsample = false
    opts.images.color.recompress = false
    opts.images.gray.recompress = false
    opts.images.mono.downsample = false
    const { bytes } = await e.ops<typeof ops>(NS).optimize(opts)
    const txt = new TextDecoder('latin1').decode(bytes)
    expect(txt).not.toContain('ASCII85Decode')
    // ASCII85 inflates data by 25%: removing it alone saves at least 15%
    expect(bytes.length).toBeLessThan(fixture('protect-optimize/mixed-images.pdf').length * 0.85)
    const imgs = imagesOf(bytes)
    expect(imgs.some((i) => i.w === 2000 && i.filter === '/DCTDecode')).toBe(true)
  })
})

describe('protect-optimize: helpers', () => {
  it('decodes ASCII85 and ASCIIHex', () => {
    const enc = new TextEncoder()
    expect(new TextDecoder().decode(decodeAscii85(enc.encode('87cURD]i,"Ebo80~>')))).toBe('Hello World!')
    expect(new TextDecoder().decode(decodeAscii85(enc.encode('<~87cURD]i,\n"Ebo7~>')))).toBe('Hello World')
    expect([...decodeAscii85(enc.encode('z@:E^~>'))]).toEqual([0, 0, 0, 0, 97, 98, 99])
    // long runs of zeros ("z" expands to four bytes)
    expect(decodeAscii85(enc.encode('z'.repeat(1000) + '~>')).length).toBe(4000)
    expect([...decodeAsciiHex(enc.encode('48 65 6C6c 6F7>'))]).toEqual([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x70])
  })

  it('packs bits and predicts PNG rows', () => {
    const bits = packBits(new Uint8Array([0, 255, 0, 255, 255, 255, 255, 255, 0]), 9, 1, 9)
    expect([...bits]).toEqual([0b01011111, 0b00000000])
    const pred = pngPredict(new Uint8Array([10, 10, 10, 10, 10, 10]), 3, 2, 1)
    expect(pred.length).toBe(8)
    expect(pred[4]).toBe(2) // second row: "Up" gives zeros
    expect([...pred.slice(5)]).toEqual([0, 0, 0])
  })

  it('formats sizes and summaries', () => {
    expect(formatBytes(12_400_000)).toBe('12.4 MB')
    expect(formatBytes(3_100_000)).toBe('3.1 MB')
    expect(formatBytes(512)).toBe('512 bytes')
    expect(reductionSummary(12_400_000, 3_100_000)).toBe('Reduced from 12.4 MB to 3.1 MB (75% smaller)')
    expect(reductionSummary(1_300_000, 5_500)).toBe('Reduced from 1.3 MB to 5.5 KB (99% smaller)')
    expect(reductionSummary(1_000_000, 996_000)).toBe('Reduced from 1 MB to 996 KB (less than 1% smaller)')
    expect(reductionSummary(1_000, 1_200)).toMatch(/already well optimized/)
    expect(compressedName('Report.PDF')).toBe('Report_compressed.pdf')
  })
})
