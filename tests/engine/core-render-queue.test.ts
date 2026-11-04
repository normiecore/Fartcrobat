import { describe, expect, it, vi } from 'vitest'
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

  it('trims the caches of a document that is not shown and releases their bitmaps', async () => {
    const { doc, calls } = fakeDoc()
    const q = new RenderQueue(doc)
    const bitmaps: ReturnType<typeof fakeBitmap>[] = []
    for (let i = 0; i < 4; i++) {
      const bm = fakeBitmap()
      bitmaps.push(bm)
      // 4 MB each; a tile for every second one
      const r = q.request(`k${i}`, 0, i % 2 ? { scale: 1, clip: [0, 0, 1024, 1024] } : { scale: 1 }, 0)
      calls[calls.length - 1].finish({ width: 1024, height: 1024, bitmap: bm })
      await r.promise
    }
    q.trim(5 * 1024 * 1024)
    await tick()
    // the most recent page bitmap stays, older ones and every tile go
    expect(q.cached('k2')).not.toBeNull()
    expect(q.cached('k0')).toBeNull()
    expect(q.cached('k1')).toBeNull()
    expect(q.cached('k3')).toBeNull()
    expect(bitmaps.map((b) => b.closed)).toEqual([true, true, false, true])
    q.trim(0)
    await tick()
    expect(q.cached('k2')).toBeNull()
    expect(bitmaps[2].closed).toBe(true)
  })
})

describe('render queue with other sources (a proposal held in the worker)', () => {
  /** A render function of its own whose renders finish only when the test says so. */
  function source() {
    const calls: Call[] = []
    const render = (page: number, opts: RenderOptions) =>
      new Promise<RenderResult>((resolve) =>
        calls.push({ page, opts, finish: (r = {}) => resolve({ width: 10, height: 10, x: 0, y: 0, ...r }) })
      )
    return { calls, render }
  }

  it('renders through the given function, in the same queue, cache and priority order', async () => {
    const { doc, calls } = fakeDoc()
    const s = source()
    const q = new RenderQueue(doc)
    q.request('busy1', 9, { scale: 1 }, 0)
    q.request('busy2', 9, { scale: 1 }, 0)
    const low = q.request('rv1.1:p0:low', 0, { scale: 1 }, 5, s.render)
    const high = q.request('rv1.1:p1:high', 1, { scale: 2 }, 1, s.render)
    expect(s.calls).toHaveLength(0)
    calls[0].finish()
    await tick()
    // the higher priority proposal render goes first, to the proposal's function
    expect(s.calls.map((c) => c.page)).toEqual([1])
    expect(calls).toHaveLength(2)
    s.calls[0].finish({ width: 3 })
    expect((await high.promise)?.width).toBe(3)
    expect(q.cached('rv1.1:p1:high')?.width).toBe(3)
    calls[1].finish()
    await tick()
    s.calls[1].finish({ width: 4 })
    expect((await low.promise)?.width).toBe(4)
  })

  it('dropPrefix forgets cached, queued and running renders of a source and closes their bitmaps', async () => {
    const { doc, calls } = fakeDoc()
    const s = source()
    const q = new RenderQueue(doc)
    const cachedBitmap = fakeBitmap()
    const done = q.request('rv1.1:a', 0, { scale: 1 }, 0, s.render)
    s.calls[0].finish({ bitmap: cachedBitmap })
    await done.promise
    const live = q.request('p0:live', 0, { scale: 1 }, 0)
    calls[0].finish()
    await live.promise
    await tick()
    const runningBitmap = fakeBitmap()
    const running = q.request('rv1.1:b', 0, { scale: 1 }, 0, s.render)
    q.request('rv1.2:other-version', 0, { scale: 1 }, 0, s.render)
    const queued = q.request('rv1.1:c', 1, { scale: 1 }, 0, s.render)
    expect(s.calls).toHaveLength(3)
    q.dropPrefix('rv1.1:')
    await tick()
    expect(q.cached('rv1.1:a')).toBeNull()
    expect(cachedBitmap.closed).toBe(true)
    expect(q.cached('p0:live')).not.toBeNull()
    expect(await queued.promise).toBeNull()
    // the running render ends with nothing cached, and its bitmap is released
    s.calls[1].finish({ bitmap: runningBitmap })
    expect(await running.promise).toBeNull()
    expect(q.cached('rv1.1:b')).toBeNull()
    expect(runningBitmap.closed).toBe(true)
    // a later request for the same key renders again
    q.request('rv1.1:b', 0, { scale: 1 }, 0, s.render)
    s.calls[2].finish()
    await tick()
    expect(s.calls).toHaveLength(4)
  })

  it('a render of a closed proposal fails quietly', async () => {
    const { doc } = fakeDoc()
    const q = new RenderQueue(doc)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const stale = Object.assign(new Error('This proposal is no longer shown.'), { code: 'STALE_PROPOSAL' })
      const r = q.request('rv1.1:x', 0, { scale: 1 }, 0, () => Promise.reject(stale))
      expect(await r.promise).toBeNull()
      expect(warn).not.toHaveBeenCalled()
      const broken = q.request('rv1.1:y', 0, { scale: 1 }, 0, () => Promise.reject(new Error('broken')))
      expect(await broken.promise).toBeNull()
      expect(warn).toHaveBeenCalledWith('Render failed', expect.any(Error))
    } finally {
      warn.mockRestore()
    }
  })
})
