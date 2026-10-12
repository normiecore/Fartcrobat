import { describe, expect, it } from 'vitest'
import type { RenderOptions, RenderResult } from '@engine/ops/render'
import { RenderQueue } from '@renderer/viewer/renderQueue'

interface Call {
  page: number
  opts: RenderOptions
  finish: (r?: Partial<RenderResult>) => void
}

/** A fake document whose renders finish only when the test says so. */
function fakeDoc() {
  const calls: Call[] = []
  const doc: any = {
    isClosed: false,
    core: {
      render: {
        page: (page: number, opts: RenderOptions) =>
          new Promise<RenderResult>((resolve) =>
            calls.push({ page, opts, finish: (r = {}) => resolve({ width: 10, height: 10, x: 0, y: 0, ...r }) })
          )
      }
    }
  }
  return { doc, calls }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function fakeBitmap() {
  const b = { closed: false, close: () => (b.closed = true) }
  return b as unknown as ImageBitmap & { closed: boolean }
}

describe('render queue', () => {
  it('keeps serving a merged consumer when the other consumer of the same job cancels', async () => {
    const { doc, calls } = fakeDoc()
    const q = new RenderQueue(doc)
    q.request('busy1', 9, { scale: 1 }, 0)
    q.request('busy2', 9, { scale: 1 }, 0)
    const a = q.request('K', 3, { scale: 1 }, 1)
    const b = q.request('K', 3, { scale: 1 }, 1)
    a.cancel()
    expect(await a.promise).toBeNull()
    calls[0].finish()
    await tick()
    // the shared job still runs once for B
    const k = calls.filter((c) => c.page === 3)
    expect(k).toHaveLength(1)
    k[0].finish({ width: 7 })
    const rb = await b.promise
    expect(rb?.width).toBe(7)
  })

  it('drops a queued job only when every consumer has cancelled', async () => {
    const { doc, calls } = fakeDoc()
    const q = new RenderQueue(doc)
    q.request('busy1', 9, { scale: 1 }, 0)
    q.request('busy2', 9, { scale: 1 }, 0)
    const a = q.request('K', 3, { scale: 1 }, 1)
    const b = q.request('K', 3, { scale: 1 }, 1)
    a.cancel()
    b.cancel()
    expect(await b.promise).toBeNull()
    calls[0].finish()
    calls[1].finish()
    await tick()
    expect(calls.filter((c) => c.page === 3)).toHaveLength(0)
  })

  it('joins a request to an identical render that is already in flight', async () => {
    const { doc, calls } = fakeDoc()
    const q = new RenderQueue(doc)
    const a = q.request('K', 3, { scale: 1 }, 1)
    const b = q.request('K', 3, { scale: 1 }, 1)
    expect(calls).toHaveLength(1)
    calls[0].finish({ width: 5 })
    expect((await a.promise)?.width).toBe(5)
    expect((await b.promise)?.width).toBe(5)
    // and the result is cached
    expect(q.cached('K')?.width).toBe(5)
  })

  it('keeps detail tiles from pushing whole-page bitmaps out of the cache and closes evicted bitmaps', async () => {
    const { doc, calls } = fakeDoc()
    const q = new RenderQueue(doc)
    // a 64 MB whole-page bitmap
    const base = fakeBitmap()
    const pb = q.request('page', 0, { scale: 4 }, 0)
    calls[0].finish({ width: 4096, height: 4096, bitmap: base })
    await pb.promise
    // scrolling at high zoom creates many single-use 16 MB tiles
    const tiles: ReturnType<typeof fakeBitmap>[] = []
    for (let i = 0; i < 40; i++) {
      const bm = fakeBitmap()
      tiles.push(bm)
      const r = q.request(`tile${i}`, 0, { scale: 16, clip: [0, i * 64, 2048, i * 64 + 2048] }, 0)
      calls[calls.length - 1].finish({ width: 2048, height: 2048, bitmap: bm })
      await r.promise
    }
    expect(q.cached('page')).not.toBeNull()
    expect(base.closed).toBe(false)
    await tick()
    // old tiles were evicted and their bitmaps released; the newest is still cached
    expect(q.cached('tile0')).toBeNull()
    expect(tiles[0].closed).toBe(true)
    expect(q.cached('tile39')).not.toBeNull()
    expect(tiles[39].closed).toBe(false)
  })
})
