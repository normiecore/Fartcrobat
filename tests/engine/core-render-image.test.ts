import { describe, expect, it } from 'vitest'
import type renderOps from '@engine/ops/render'
import { openFixture } from './helpers'

describe('render.image', () => {
  it('encodes PNG, JPEG and grayscale output', async () => {
    const e = await openFixture('text.pdf')
    const render = e.ops<typeof renderOps>('render')
    for (const opts of [
      { dpi: 36, format: 'png' as const },
      { dpi: 36, format: 'jpeg' as const, quality: 80 },
      { dpi: 36, format: 'png' as const, grayscale: true },
      { dpi: 36, format: 'jpeg' as const, grayscale: true }
    ]) {
      const bytes = await render.image(0, opts)
      expect(bytes.length).toBeGreaterThan(100)
      if (opts.format === 'png') expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47])
      else expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8])
    }
  })
})

describe('render.page', () => {
  it('renders on a transparent background when asked, white otherwise', async () => {
    const e = await openFixture('text.pdf')
    const render = e.ops<typeof renderOps>('render')
    // The top-left corner of the page is blank.
    const corner = async (transparent: boolean) => {
      const r = await render.page(0, { scale: 0.25, transparent, clip: [0, 0, 4, 4] })
      return [...r.pixels!.slice(0, 4)]
    }
    expect(await corner(true)).toEqual([0, 0, 0, 0])
    expect(await corner(false)).toEqual([255, 255, 255, 255])
  })
})
