import * as mupdf from 'mupdf'
import { describe, expect, it } from 'vitest'
import type pageOps from '@engine/ops/pages'
import { openBytes } from './core-docs'

/** One page per entry; each entry is the raw page dictionary keys to set. */
function oddPagesPdf(pages: Record<string, unknown>[]): Uint8Array {
  const doc = new mupdf.PDFDocument()
  for (const p of pages) {
    const page = doc.addPage([0, 0, 612, 792], 0, doc.newDictionary(), '')
    page.delete('MediaBox')
    for (const [k, v] of Object.entries(p)) page.put(k, v)
    doc.insertPage(-1, page)
  }
  const buf = doc.saveToBuffer('')
  const out = buf.asUint8Array().slice()
  buf.destroy()
  doc.destroy()
  return out
}

describe('page geometry agrees with what MuPDF renders', () => {
  it('handles empty boxes and rotations that are not multiples of 90', async () => {
    const e = await openBytes(
      oddPagesPdf([
        { MediaBox: [0, 0, 0, 0] },
        { MediaBox: [0, 0, 612, 792], Rotate: 45 },
        { MediaBox: [0, 0, 612, 792], Rotate: -90 },
        { MediaBox: [0, 0, 612, 792], Rotate: 135 },
        { MediaBox: [0, 0, 612, 792], Rotate: 420 },
        { MediaBox: [0, 0, 612, 792], CropBox: [700, 800, 900, 900] },
        { MediaBox: [0, 0, 500, 0.5] },
        {}
      ]),
      'odd.pdf'
    )
    const expected: [number, number, number][] = [
      [612, 792, 0],
      [792, 612, 90],
      [792, 612, 270],
      [612, 792, 180],
      [792, 612, 90],
      [612, 792, 0],
      [1, 1, 0],
      [612, 792, 0]
    ]
    e.info.pages.forEach((p, i) => {
      const b = e.session.pageBounds(i)
      const bounds: [number, number] = [Math.round(b[2] - b[0]), Math.round(b[3] - b[1])]
      expect([Math.round(p.width), Math.round(p.height)], `page ${i + 1} vs MuPDF`).toEqual(bounds)
      expect([Math.round(p.width), Math.round(p.height), p.rotation], `page ${i + 1}`).toEqual(expected[i])
    })
    // rotating a 45° page snaps it like MuPDF does
    await e.ops<typeof pageOps>('pages').rotate([1], 90)
    expect((await e.doc.info()).pages[1].rotation).toBe(180)
  })
})
