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
