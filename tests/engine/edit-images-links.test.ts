import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Matrix, Rect } from '@shared/geometry'
import type navOps from '@engine/ops/nav'
import type textOps from '@engine/ops/text'
import type renderOps from '@engine/ops/render'
import type ops from '@features/edit-images-links/engine'
import type marksOps from '@features/page-marks/engine'
import { defaultBackground, defaultHeaderFooter } from '@features/page-marks/shared'
import type { PageImage } from '@features/edit-images-links/engine'
import { applySplices, parseContent } from '@features/edit-images-links/content'
import { declaredDpi } from '@features/edit-images-links/images'
import { fileSpecToPath, pathToFileSpec } from '@features/edit-images-links/filespec'
import { FIXTURES, openFixture, roundTrip, type OpenedEngine } from './helpers'

const FIX = 'edit-images-links/images.pdf'
const bytesOf = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURES, 'edit-images-links', name)))

const T = (dx: number, dy: number): Matrix => [1, 0, 0, 1, dx, dy]
const refOf = (i: PageImage) => ({ index: i.index, xref: i.xref, loc: i.loc })

async function setup(): Promise<{ e: OpenedEngine; o: ReturnType<OpenedEngine['ops']> & any }> {
  const e = await openFixture(FIX)
  return { e, o: e.ops<typeof ops>('edit-images-links') }
}

const text = (e: OpenedEngine, p: number) => e.ops<typeof textOps>('text').plain(p)

/** Average colour of a page region (to check what is really painted). */
async function regionColor(e: OpenedEngine, page: number, r: Rect): Promise<[number, number, number]> {
  const res = await e.ops<typeof renderOps>('render').page(page, { scale: 1, annots: false })
  const px = res.pixels!
  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  for (let y = Math.max(0, Math.floor(r[1])); y < Math.min(res.height, Math.ceil(r[3])); y++) {
    for (let x = Math.max(0, Math.floor(r[0])); x < Math.min(res.width, Math.ceil(r[2])); x++) {
      const k = (y * res.width + x) * 4
      sr += px[k]
      sg += px[k + 1]
      sb += px[k + 2]
      n++
    }
  }
  return n ? [sr / n, sg / n, sb / n] : [255, 255, 255]
}

const isWhite = (c: number[]) => c.every((v) => v > 245)

describe('content stream tokenizer', () => {
  it('finds operators, operands and inline images with byte ranges', () => {
    const raw = 'q 1 0 0 1 10 20 cm /Im1 Do Q BT /F1 12 Tf (a\\)b) Tj [(x) -20 (y)] TJ ET\nBI /W 2 /H 1 /BPC 8 /CS /G ID \x00\xff\nEI 0 0 m'
    const src = Uint8Array.from(raw, (c) => c.charCodeAt(0))
    const ops = parseContent(src)
    expect(ops.map((o) => o.op)).toEqual(['q', 'cm', 'Do', 'Q', 'BT', 'Tf', 'Tj', 'TJ', 'ET', 'BI', 'm'])
    const doOp = ops[2]
    expect(new TextDecoder().decode(src.subarray(doOp.start, doOp.end))).toBe('/Im1 Do')
    const bi = ops[9]
    expect(bi.inline!.dataEnd - bi.inline!.dataStart).toBe(2)
    expect(String.fromCharCode(...src.subarray(bi.end - 2, bi.end))).toBe('EI')
  })

  it('finds the end of filtered inline images', () => {
    const src = new TextEncoder().encode('BI /W 4 /H 4 /F [/A85 /Fl] ID\nGat6D\\EI_$g~>\nEI\nQ')
    const ops = parseContent(src)
    expect(ops.map((o) => o.op)).toEqual(['BI', 'Q'])
  })

  it('splices bytes and maps offsets', () => {
    const b = new TextEncoder().encode('AAAA BBBB CCCC')
    const r = applySplices(b, [
      { start: 5, end: 9, parts: ['xx'] },
      { start: 14, end: 14, parts: [' ', [0, 4]] }
    ])
    expect(new TextDecoder().decode(r.bytes)).toBe('AAAA xx CCCC AAAA')
    expect(r.map(10)).toBe(8)
    expect(r.placed(1)).toBe(12)
  })
})

describe('images: listing', () => {
  it('lists both images on page 1 with page-space geometry', async () => {
    const { o } = await setup()
    const imgs: PageImage[] = await o.images(0)
    expect(imgs.length).toBe(2)
    const [chart, photo] = imgs
    expect(chart.kind).toBe('xobject')
    expect(chart.width).toBe(300)
    expect(chart.bbox[0]).toBeCloseTo(72, 1)
    expect(chart.bbox[1]).toBeCloseTo(792 - 570, 1)
    expect(chart.bbox[2]).toBeCloseTo(272, 1)
    expect(photo.bbox[0]).toBeCloseTo(340, 1)
    expect(photo.flipped).toBe(false)
    expect(photo.rotation).toBe(0)
    expect(chart.dpi).toBe(108)
  })

  it('lists inline images, masked images and clipped images on a rotated page', async () => {
    const { o } = await setup()
    const p2: PageImage[] = await o.images(1)
    expect(p2.map((i) => i.kind)).toEqual(['inline', 'xobject'])
    expect(p2[0].width).toBe(40)
    const p3: PageImage[] = await o.images(2)
    expect(p3.length).toBe(1)
    expect(p3[0].cropped).toBe(true)
    // rotated page: page space is 792 x 612
    expect(p3[0].visible[2]).toBeLessThanOrEqual(792)
    expect(p3[0].visible[2] - p3[0].visible[0]).toBeCloseTo(100, 0)
    expect(p3[0].visible[3] - p3[0].visible[1]).toBeCloseTo(150, 0)
  })
})

describe('images: editing', () => {
  it('moves one image, keeps the other image and all text, and undoes', async () => {
    const { e, o } = await setup()
    const before = await text(e, 0)
    const [chart, photo] = (await o.images(0)) as PageImage[]
    const moved: PageImage = await o.transformImage(0, refOf(chart), T(100, 20), 'move')
    expect(e.lastChanges?.journal.undoLabel).toBe('Move Image')
    expect(e.lastChanges?.pages).toContain(0)
    expect(e.lastChanges?.dirty).toBe(true)
    expect(moved.bbox[0]).toBeCloseTo(chart.bbox[0] + 100, 1)
    expect(moved.bbox[1]).toBeCloseTo(chart.bbox[1] + 20, 1)
    const after: PageImage[] = await o.images(0)
    expect(after.length).toBe(2)
    expect(after[1].bbox).toEqual(photo.bbox)
    expect(await text(e, 0)).toBe(before)
    // the old place is now blank, the new place shows the chart
    expect(isWhite(await regionColor(e, 0, [74, 225, 160, 240]))).toBe(true)
    expect(isWhite(await regionColor(e, 0, [chart.bbox[0] + 100, chart.bbox[1] + 20, chart.bbox[2] + 100, chart.bbox[3] + 20]))).toBe(false)
    // moving again folds into the same cm (no nesting growth)
    const again: PageImage = await o.transformImage(0, refOf(moved), T(-50, 0), 'move')
    expect(again.bbox[0]).toBeCloseTo(chart.bbox[0] + 50, 1)
    await e.doc.undo()
    await e.doc.undo()
    const restored: PageImage[] = await o.images(0)
    expect(restored[0].bbox).toEqual(chart.bbox)
  })

  it('resizes, rotates and flips around the image', async () => {
    const { e, o } = await setup()
    const [chart] = (await o.images(0)) as PageImage[]
    const [x0, y0, x1] = chart.bbox
    // scale to half size keeping the top-left corner
    const half: Matrix = [0.5, 0, 0, 0.5, x0 * 0.5, y0 * 0.5]
    const small: PageImage = await o.transformImage(0, refOf(chart), half, 'resize')
    expect(e.lastChanges?.journal.undoLabel).toBe('Resize Image')
    expect(small.bbox[0]).toBeCloseTo(x0, 1)
    expect(small.bbox[2] - small.bbox[0]).toBeCloseTo((x1 - x0) / 2, 1)
    // rotate 90 degrees clockwise about the centre
    const cx = (small.bbox[0] + small.bbox[2]) / 2
    const cy = (small.bbox[1] + small.bbox[3]) / 2
    const rot: Matrix = [0, 1, -1, 0, cx + cy, cy - cx]
    const turned: PageImage = await o.transformImage(0, refOf(small), rot, 'rotate')
    expect(turned.rotation).toBe(90)
    expect(turned.bbox[2] - turned.bbox[0]).toBeCloseTo(small.bbox[3] - small.bbox[1], 1)
    // flip horizontally about the centre
    const flip: Matrix = [-1, 0, 0, 1, 2 * cx, 0]
    const flipped: PageImage = await o.transformImage(0, refOf(turned), flip, 'flip')
    expect(flipped.flipped).toBe(true)
    expect(e.lastChanges?.journal.undoLabel).toBe('Flip Image')
  })

  it('moves an inline image and an image with a soft mask', async () => {
    const { e, o } = await setup()
    const [inline, masked] = (await o.images(1)) as PageImage[]
    const a: PageImage = await o.transformImage(1, refOf(inline), T(0, 200), 'move')
    expect(a.kind).toBe('inline')
    expect(a.bbox[1]).toBeCloseTo(inline.bbox[1] + 200, 1)
    const b: PageImage = await o.transformImage(1, refOf(masked), T(-200, 100), 'move')
    expect(b.bbox[0]).toBeCloseTo(masked.bbox[0] - 200, 1)
    const list: PageImage[] = await o.images(1)
    expect(list.length).toBe(2)
    const rt = await roundTrip(e)
    const list2: PageImage[] = await rt.ops<typeof ops>('edit-images-links').images(1)
    expect(list2.map((i) => Math.round(i.bbox[1]))).toEqual(list.map((i) => Math.round(i.bbox[1])))
  })

  it('moves a cropped image together with its clipping on a rotated page', async () => {
    const { e, o } = await setup()
    const [img] = (await o.images(2)) as PageImage[]
    const moved: PageImage = await o.transformImage(2, refOf(img), T(150, 60), 'move')
    expect(moved.visible[0]).toBeCloseTo(img.visible[0] + 150, 1)
    expect(moved.visible[1]).toBeCloseTo(img.visible[1] + 60, 1)
    expect(moved.visible[2] - moved.visible[0]).toBeCloseTo(img.visible[2] - img.visible[0], 1)
    expect(moved.cropped).toBe(true)
    expect(isWhite(await regionColor(e, 2, img.visible))).toBe(true)
    expect(isWhite(await regionColor(e, 2, moved.visible))).toBe(false)
  })

  it('crops an image, widens the crop again and moves it with its crop', async () => {
    const { e, o } = await setup()
    const [chart] = (await o.images(0)) as PageImage[]
    // the crop is a clip that belongs to the image, so it must travel with it
    const cropped: PageImage = await o.cropImage(0, refOf(chart), [chart.bbox[0], chart.bbox[1], chart.bbox[0] + 100, chart.bbox[3]])
    expect(e.lastChanges?.journal.undoLabel).toBe('Crop Image')
    expect(cropped.cropped).toBe(true)
    expect(cropped.visible[2] - cropped.visible[0]).toBeCloseTo(100, 1)
    // widen the crop again (reuses our crop group)
    const wider: PageImage = await o.cropImage(0, refOf(cropped), [chart.bbox[0], chart.bbox[1], chart.bbox[0] + 150, chart.bbox[3]])
    expect(wider.visible[2] - wider.visible[0]).toBeCloseTo(150, 1)
    const moved: PageImage = await o.transformImage(0, refOf(wider), T(250, 300), 'move')
    expect(moved.visible[2] - moved.visible[0]).toBeCloseTo(150, 1)
    expect(moved.visible[0]).toBeCloseTo(chart.bbox[0] + 250, 1)
  })

  it('deletes an image without touching the rest of the page', async () => {
    const { e, o } = await setup()
    const before = await text(e, 0)
    const [chart, photo] = (await o.images(0)) as PageImage[]
    await o.deleteImage(0, refOf(photo))
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete Image')
    const left: PageImage[] = await o.images(0)
    expect(left.length).toBe(1)
    expect(left[0].bbox).toEqual(chart.bbox)
    expect(await text(e, 0)).toBe(before)
    expect(isWhite(await regionColor(e, 0, photo.bbox))).toBe(true)
    // the blue rectangle drawn after the images is still there
    const blue = await regionColor(e, 0, [80, 792 - 335, 180, 792 - 305])
    expect(blue[2]).toBeGreaterThan(180)
    expect(blue[0]).toBeLessThan(80)
    await e.doc.undo()
    expect(((await o.images(0)) as PageImage[]).length).toBe(2)
    const rt = await roundTrip(e)
    expect(((await rt.ops<typeof ops>('edit-images-links').images(0)) as PageImage[]).length).toBe(2)
  })

  it('replaces an image, fitting the new picture inside the old bounds', async () => {
    const { e, o } = await setup()
    const [, photo] = (await o.images(0)) as PageImage[]
    const repl: PageImage = await o.replaceImage(0, refOf(photo), bytesOf('replacement.png'))
    expect(e.lastChanges?.journal.undoLabel).toBe('Replace Image')
    expect(repl.width).toBe(120)
    expect(repl.height).toBe(60)
    expect(repl.xref).not.toBe(photo.xref)
    // 2:1 picture in a square box: full width, half height, centred
    expect(repl.bbox[2] - repl.bbox[0]).toBeCloseTo(160, 1)
    expect(repl.bbox[3] - repl.bbox[1]).toBeCloseTo(80, 1)
    expect((repl.bbox[1] + repl.bbox[3]) / 2).toBeCloseTo((photo.bbox[1] + photo.bbox[3]) / 2, 1)
    const green = await regionColor(e, 0, [repl.bbox[0] + 2, repl.bbox[1] + 2, repl.bbox[0] + 8, repl.bbox[1] + 8])
    expect(green[1]).toBeGreaterThan(140)
    expect(green[0]).toBeLessThan(90)
    const rt = await roundTrip(e)
    const list: PageImage[] = await rt.ops<typeof ops>('edit-images-links').images(0)
    expect(list[1].width).toBe(120)
  })

  it('replaces an inline image', async () => {
    const { o } = await setup()
    const [inline] = (await o.images(1)) as PageImage[]
    const repl: PageImage = await o.replaceImage(1, refOf(inline), bytesOf('stamp.jpg'))
    expect(repl.kind).toBe('xobject')
    expect(repl.width).toBe(64)
    expect(((await o.images(1)) as PageImage[]).length).toBe(2)
  })

  it('extracts image pixels as PNG, including transparency', async () => {
    const { o } = await setup()
    const [chart] = (await o.images(0)) as PageImage[]
    const r = await o.imagePng(0, refOf(chart))
    expect(r.width).toBe(300)
    expect(Array.from(r.png.slice(1, 4))).toEqual([0x50, 0x4e, 0x47])
    const [inline, masked] = (await o.images(1)) as PageImage[]
    const ri = await o.imagePng(1, refOf(inline))
    expect(ri.width).toBe(40)
    const rm = await o.imagePng(1, refOf(masked))
    expect(rm.width).toBe(90)
    // colour type 6 = RGBA
    expect(rm.png[25]).toBe(6)
  })

  it('adds an image as page content and survives a round trip', async () => {
    const { e, o } = await setup()
    const probe = await o.probeImage(bytesOf('stamp.jpg'))
    expect(probe.width).toBe(64)
    const added: PageImage = await o.addImage(0, bytesOf('stamp.jpg'), [400, 650, 464, 714])
    expect(e.lastChanges?.journal.undoLabel).toBe('Add Image')
    expect(added.bbox[0]).toBeCloseTo(400, 1)
    expect(added.bbox[1]).toBeCloseTo(650, 1)
    expect(added.flipped).toBe(false)
    expect(((await o.images(0)) as PageImage[]).length).toBe(3)
    const c = await regionColor(e, 0, [425, 675, 440, 690])
    expect(c[0]).toBeLessThan(100)
    // rotated page: the image must appear upright where it was placed
    const onRotated: PageImage = await o.addImage(2, bytesOf('replacement.png'), [500, 100, 620, 160])
    expect(onRotated.bbox[0]).toBeCloseTo(500, 1)
    expect(onRotated.bbox[1]).toBeCloseTo(100, 1)
    expect(onRotated.rotation).toBe(0)
    expect(onRotated.flipped).toBe(false)
    const rt = await roundTrip(e)
    const list: PageImage[] = await rt.ops<typeof ops>('edit-images-links').images(0)
    expect(list.length).toBe(3)
    await expect(o.probeImage(new TextEncoder().encode('not an image'))).rejects.toThrow(/not supported/)
  })

  // MuPDF's per-document image cache is not part of the undo journal: after an undo it would hand
  // back the image object the undo removed.
  it('adds and replaces the same picture again after an undo', async () => {
    const { e, o } = await setup()
    await o.addImage(0, bytesOf('stamp.jpg'), [400, 650, 464, 714])
    await e.doc.undo()
    const again: PageImage = await o.addImage(0, bytesOf('stamp.jpg'), [400, 650, 464, 714])
    expect(again.width).toBe(64)
    expect((await regionColor(e, 0, [425, 675, 440, 690]))[0]).toBeLessThan(100)
    const [, photo] = (await o.images(0)) as PageImage[]
    await o.replaceImage(0, refOf(photo), bytesOf('replacement.png'))
    await e.doc.undo()
    const [, back] = (await o.images(0)) as PageImage[]
    const repl: PageImage = await o.replaceImage(0, refOf(back), bytesOf('replacement.png'))
    expect(repl.width).toBe(120)
    const green = await regionColor(e, 0, [repl.bbox[0] + 2, repl.bbox[1] + 2, repl.bbox[0] + 8, repl.bbox[1] + 8])
    expect(green[1]).toBeGreaterThan(140)
    const list: PageImage[] = await (await roundTrip(e)).ops<typeof ops>('edit-images-links').images(0)
    expect(list.map((i) => i.width).sort((a, b) => a - b)).toEqual([64, 120, 300])
  })

  it('changes the stacking order', async () => {
    const { e, o } = await setup()
    // put a new image over the chart so the two overlap; [121,251,129,255] is white chart background
    const probe: Rect = [121, 251, 129, 255]
    const [chart] = (await o.images(0)) as PageImage[]
    const top: PageImage = await o.addImage(0, bytesOf('stamp.jpg'), [100, 250, 200, 350])
    expect(top.index).toBe(2)
    const orange = (c: number[]) => c[0] > 200 && c[2] < 120
    expect(orange(await regionColor(e, 0, probe))).toBe(true)
    const back: PageImage = await o.arrangeImage(0, refOf(top), 'back')
    expect(e.lastChanges?.journal.undoLabel).toBe('Send to Back')
    expect(back.index).toBe(0)
    // the chart's white background now covers the stamp
    expect(isWhite(await regionColor(e, 0, probe))).toBe(true)
    await expect(o.arrangeImage(0, refOf(back), 'back')).rejects.toThrow(/already behind/)
    const fwd: PageImage = await o.arrangeImage(0, refOf(back), 'forward')
    expect(e.lastChanges?.journal.undoLabel).toBe('Bring Forward')
    expect(fwd.index).toBe(1)
    expect(orange(await regionColor(e, 0, probe))).toBe(true)
    const bwd: PageImage = await o.arrangeImage(0, refOf(fwd), 'backward')
    expect(bwd.index).toBe(0)
    expect(isWhite(await regionColor(e, 0, probe))).toBe(true)
    const front: PageImage = await o.arrangeImage(0, refOf(bwd), 'front')
    expect(front.index).toBe(2)
    expect(orange(await regionColor(e, 0, probe))).toBe(true)
    await expect(o.arrangeImage(0, refOf(front), 'front')).rejects.toThrow(/already in front/)
    expect(((await o.images(0)) as PageImage[]).find((i) => i.xref === chart.xref)?.bbox).toEqual(chart.bbox)
    const rt = await roundTrip(e)
    expect(((await rt.ops<typeof ops>('edit-images-links').images(0)) as PageImage[]).length).toBe(3)
  })

  it('lifts an image out of a clipping group it shares with text when moved outside it', async () => {
    const { e, o } = await setup()
    const before = await text(e, 3)
    const [chart] = (await o.images(3)) as PageImage[]
    expect(chart.cropped).toBe(false)
    // a small move stays inside the group's clip: edited in place
    const nudged: PageImage = await o.transformImage(3, refOf(chart), T(10, 0), 'move')
    expect(nudged.loc[0]).toBeLessThan(400)
    // a big move would be hidden by the clip: the image is lifted out of the group
    const moved: PageImage = await o.transformImage(3, refOf(nudged), T(300, 0), 'move')
    expect(moved.cropped).toBe(false)
    expect(moved.visible[2] - moved.visible[0]).toBeCloseTo(150, 1)
    expect(moved.bbox[0]).toBeCloseTo(chart.bbox[0] + 310, 1)
    expect(isWhite(await regionColor(e, 3, moved.bbox))).toBe(false)
    expect(await text(e, 3)).toBe(before)
  })

  it('edits an image inside a form XObject shared by two pages on one page only', async () => {
    const { e, o } = await setup()
    const [logo4] = (await o.images(3)).filter((i: PageImage) => i.nested) as PageImage[]
    const [logo5] = (await o.images(4)) as PageImage[]
    expect(logo4.nested).toBe(true)
    expect(logo5.bbox).toEqual(logo4.bbox)
    const moved: PageImage = await o.transformImage(3, refOf(logo4), T(5, 5), 'move')
    expect(moved.nested).toBe(true)
    expect(moved.bbox[0]).toBeCloseTo(logo4.bbox[0] + 5, 1)
    expect(((await o.images(4)) as PageImage[])[0].bbox).toEqual(logo5.bbox)
    // moving it beyond the form's bounds draws it from the page instead
    const far: PageImage = await o.transformImage(3, refOf(moved), T(-200, -300), 'move')
    expect(far.nested).toBe(false)
    expect(far.cropped).toBe(false)
    expect(far.bbox[0]).toBeCloseTo(logo4.bbox[0] - 195, 1)
    expect(far.bbox[1]).toBeCloseTo(logo4.bbox[1] - 295, 1)
    expect(isWhite(await regionColor(e, 3, far.bbox))).toBe(false)
    expect(((await o.images(3)) as PageImage[]).filter((i) => i.xref === logo4.xref).length).toBe(1)
    expect(((await o.images(4)) as PageImage[])[0].bbox).toEqual(logo5.bbox)
    // delete and replace inside the (copied) form
    await e.doc.undo()
    const again = ((await o.images(3)) as PageImage[]).find((i) => i.nested)!
    const repl: PageImage = await o.replaceImage(3, refOf(again), bytesOf('replacement.png'))
    expect(repl.nested).toBe(true)
    expect(repl.width).toBe(120)
    expect(((await o.images(4)) as PageImage[])[0].width).toBe(64)
    await o.deleteImage(3, refOf(repl))
    expect(((await o.images(3)) as PageImage[]).filter((i) => i.nested).length).toBe(0)
    expect(((await o.images(4)) as PageImage[]).length).toBe(1)
    const rt = await roundTrip(e)
    expect(((await rt.ops<typeof ops>('edit-images-links').images(4)) as PageImage[]).length).toBe(1)
  })

  it('leaves page marks alone: headers, watermarks and backgrounds stay tagged and removable', async () => {
    const { e, o } = await setup()
    const marks = e.ops<typeof marksOps>('page-marks')
    const hf = defaultHeaderFooter()
    // "shrink" scales the page content down inside a wrapper to make room for the header
    await marks.apply({ ...hf, shrink: true, text: { ...hf.text, headerCenter: 'CONFIDENTIAL' } }, { mode: 'add' })
    const src = await marks.loadSource(bytesOf('stamp.jpg'), 'stamp.jpg')
    const bg = defaultBackground()
    await marks.apply({ ...bg, source: { kind: 'file', fileName: 'stamp.jpg', page: 1, scale: 100, sourceId: src.id } }, { mode: 'add' })
    const listed = async () => (await marks.list()).groups.map((g) => [g.type, g.pages.includes(0)])
    expect(await listed()).toEqual([
      ['HeaderFooter', true],
      ['Background', true]
    ])
    // the background picture is not offered for editing: only the page's own two images are
    const imgs = (await o.images(0)) as PageImage[]
    expect(imgs.map((i) => i.xref)).toEqual([9, 10])
    const [chart, photo] = imgs
    const moved: PageImage = await o.transformImage(0, refOf(chart), T(20, 0), 'move')
    expect(moved.bbox[0]).toBeCloseTo(chart.bbox[0] + 20, 1)
    const added: PageImage = await o.addImage(0, bytesOf('stamp.jpg'), [100, 600, 164, 664])
    expect(added.bbox).toEqual([100, 600, 164, 664].map((v) => expect.closeTo(v, 1)))
    await o.arrangeImage(0, refOf(added), 'back')
    // what the user sees is where the engine says the images are (inside the shrunk content)
    expect(isWhite(await regionColor(e, 0, [moved.bbox[0] + 30, moved.bbox[1] + 70, moved.bbox[0] + 40, moved.bbox[1] + 80]))).toBe(false)
    expect(isWhite(await regionColor(e, 0, [110, 610, 150, 650]))).toBe(false)
    // the marks are still recognised on the edited page, and can be removed from it
    expect(await listed()).toEqual([
      ['HeaderFooter', true],
      ['Background', true]
    ])
    expect(await text(e, 0)).toContain('CONFIDENTIAL')
    await marks.remove('HeaderFooter')
    await marks.remove('Background')
    expect(await text(e, 0)).not.toContain('CONFIDENTIAL')
    const after = (await o.images(0)) as PageImage[]
    expect(after.length).toBe(3)
    // without the shrink the edited images keep their place on the unshrunk page
    expect(after.find((i) => i.xref === photo.xref)!.bbox).toEqual(
      ((await (await openFixture(FIX)).ops<typeof ops>('edit-images-links').images(0)) as PageImage[])[1].bbox
    )
  })

  it('reads declared resolution from PNG and JPEG headers', () => {
    expect(declaredDpi(bytesOf('stamp.jpg'))).toBeNull()
    const png = bytesOf('replacement.png')
    expect(declaredDpi(png)).toBeNull()
  })
})

describe('links', () => {
  it('lists existing links with their actions and appearance', async () => {
    const { o } = await setup()
    const links = await o.links(1)
    expect(links.length).toBe(2)
    const web = links.find((l: any) => l.action.type === 'uri')
    expect(web.action.uri).toBe('https://existing.example.net')
    expect(web.appearance.visible).toBe(true)
    expect(web.appearance.color).toBe('#0000ff')
    const back = links.find((l: any) => l.action.type === 'page')
    expect(back.action.page).toBe(0)
  })

  it('creates web, page and file links that MuPDF resolves', async () => {
    const { e, o } = await setup()
    const nav = e.ops<typeof navOps>('nav')
    const web = await o.createLink(0, [72, 100, 300, 120], {
      action: { type: 'uri', uri: 'https://fartcrobat.org/docs' },
      appearance: { visible: true, width: 2, style: 'dashed', color: '#ff0000', highlight: 'outline' }
    })
    expect(e.lastChanges?.journal.undoLabel).toBe('Create Link')
    expect(e.lastChanges?.pages).toContain(0)
    expect(web.rect[0]).toBeCloseTo(72, 1)
    expect(web.rect[1]).toBeCloseTo(100, 1)
    expect(web.appearance).toEqual({ visible: true, width: 2, style: 'dashed', color: '#ff0000', highlight: 'outline' })
    let links = await nav.links(0)
    expect(links.map((l) => l.uri)).toContain('https://fartcrobat.org/docs')
    const toPage = await o.createLink(0, [72, 130, 300, 150], {
      action: { type: 'page', page: 1, x: 72, y: 100, zoom: 150, fit: 'XYZ' },
      appearance: { visible: false, width: 1, style: 'solid', color: '#000000', highlight: 'invert' }
    })
    expect(toPage.action).toMatchObject({ type: 'page', page: 1, x: 72, y: 100, zoom: 150 })
    links = await nav.links(0)
    const internal = links.find((l) => !l.external)!
    expect(internal.dest?.page).toBe(1)
    expect(internal.dest?.y).toBeCloseTo(100, 0)
    // on a rotated page, coordinates still map back exactly
    const rotated = await o.createLink(0, [72, 160, 300, 180], {
      action: { type: 'page', page: 2, x: 100, y: 50, zoom: null, fit: 'XYZ' },
      appearance: { visible: false, width: 1, style: 'solid', color: '#000000', highlight: 'none' }
    })
    expect(rotated.action).toMatchObject({ type: 'page', page: 2 })
    expect((rotated.action as any).x).toBeCloseTo(100, 0)
    expect((rotated.action as any).y).toBeCloseTo(50, 0)
    const file = await o.createLink(0, [72, 190, 300, 210], {
      action: { type: 'file', path: '/tmp/report.docx' },
      appearance: { visible: false, width: 1, style: 'solid', color: '#000000', highlight: 'invert' }
    })
    expect(file.action).toEqual({ type: 'file', path: '/tmp/report.docx' })
    expect((await o.links(0)).length).toBe(4)
    await e.doc.undo()
    expect((await o.links(0)).length).toBe(3)
    await e.doc.redo()
    const rt = await roundTrip(e)
    const rlinks = await rt.ops<typeof ops>('edit-images-links').links(0)
    expect(rlinks.length).toBe(4)
    expect(rlinks[0].appearance.style).toBe('dashed')
  })

  it('moves, edits and deletes links', async () => {
    const { e, o } = await setup()
    const nav = e.ops<typeof navOps>('nav')
    const [web] = (await o.links(1)).filter((l: any) => l.action.type === 'uri')
    const moved = await o.updateLink(1, web.id, { rect: [100, 300, 260, 320] })
    expect(e.lastChanges?.journal.undoLabel).toBe('Move Link')
    expect(moved.rect[0]).toBeCloseTo(100, 1)
    expect(moved.rect[1]).toBeCloseTo(300, 1)
    const nl = await nav.links(1)
    expect(nl.some((l) => Math.abs(l.rect[1] - 300) < 0.5 && l.uri === 'https://existing.example.net')).toBe(true)
    const edited = await o.updateLink(1, web.id, {
      action: { type: 'uri', uri: 'https://changed.example/ü' },
      appearance: { visible: false, width: 1, style: 'solid', color: '#000000', highlight: 'none' }
    })
    expect(e.lastChanges?.journal.undoLabel).toBe('Edit Link')
    expect(edited.action).toEqual({ type: 'uri', uri: 'https://changed.example/%C3%BC' })
    expect(edited.appearance.visible).toBe(false)
    expect(edited.appearance.highlight).toBe('none')
    await o.deleteLink(1, web.id)
    expect(e.lastChanges?.journal.undoLabel).toBe('Delete Link')
    expect((await o.links(1)).length).toBe(1)
    expect((await nav.links(1)).length).toBe(1)
    await e.doc.undo()
    expect((await nav.links(1)).length).toBe(2)
  })

  it('creates and moves links on a rotated page in page coordinates', async () => {
    const { e, o } = await setup()
    const nav = e.ops<typeof navOps>('nav')
    expect(e.info.pages[2].rotation).not.toBe(0)
    const made = await o.createLink(2, [50, 60, 250, 90], {
      action: { type: 'uri', uri: 'https://rotated.example' },
      appearance: { visible: true, width: 1, style: 'solid', color: '#0000ff', highlight: 'invert' }
    })
    expect(made.rect.map((v: number) => Math.round(v))).toEqual([50, 60, 250, 90])
    const listed = (await nav.links(2)).find((l) => l.uri === 'https://rotated.example')!
    expect(listed.rect.map((v) => Math.round(v))).toEqual([50, 60, 250, 90])
    const moved = await o.updateLink(2, made.id, { rect: [60, 100, 260, 130] })
    expect(moved.rect.map((v: number) => Math.round(v))).toEqual([60, 100, 260, 130])
    const rt = await roundTrip(e)
    const again = (await rt.ops<typeof navOps>('nav').links(2)).find((l) => l.uri === 'https://rotated.example')!
    expect(again.rect.map((v) => Math.round(v))).toEqual([60, 100, 260, 130])
  })

  it('creates links from web and e-mail addresses in the text', async () => {
    const { e, o } = await setup()
    const found = await o.findUrls('all')
    const uris = found.map((f: any) => f.uri)
    expect(uris).toContain('https://example.com/docs')
    expect(uris).toContain('mailto:support@example.org')
    expect(uris).toContain('http://www.fartcrobat.org')
    // already linked on page 2
    expect(uris).not.toContain('https://existing.example.net')
    const n = await o.createLinksFromUrls('all')
    expect(n).toBe(found.length)
    expect(e.lastChanges?.journal.undoLabel).toBe('Create Links from URLs')
    const nav = await e.ops<typeof navOps>('nav').links(0)
    const docs = nav.find((l) => l.uri === 'https://example.com/docs')!
    expect(docs).toBeTruthy()
    // the link covers the address text, not the whole line
    const t = await e.ops<typeof textOps>('text').page(0)
    const i = t.text.indexOf('https://example.com/docs')
    expect(docs.rect[0]).toBeLessThanOrEqual(t.quads[i * 8] + 0.01)
    expect(docs.rect[0]).toBeGreaterThan(100)
    // running it again finds nothing new
    await expect(o.createLinksFromUrls('all')).rejects.toThrow(/No web addresses/)
    expect((await o.findUrls('all')).length).toBe(0)
    await e.doc.undo()
    expect((await o.findUrls([0])).length).toBe(3)
  })

  it('removes all links', async () => {
    const { e, o } = await setup()
    const n = await o.removeAllLinks('all')
    expect(n).toBe(2)
    expect((await e.ops<typeof navOps>('nav').links(1)).length).toBe(0)
    await expect(o.removeAllLinks('all')).rejects.toThrow(/no links/)
  })

  it('converts file paths to PDF file specifications and back', () => {
    expect(pathToFileSpec('C:\\Users\\me\\a.pdf')).toBe('/C/Users/me/a.pdf')
    expect(fileSpecToPath('/C/Users/me/a.pdf', true)).toBe('C:\\Users\\me\\a.pdf')
    expect(fileSpecToPath('/C/Users/me/a.pdf', false)).toBe('/C/Users/me/a.pdf')
    expect(pathToFileSpec('/home/me/a.pdf')).toBe('/home/me/a.pdf')
    expect(fileSpecToPath('docs/a.pdf', true)).toBe('docs\\a.pdf')
  })
})
