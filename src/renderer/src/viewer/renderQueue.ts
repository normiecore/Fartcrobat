import type { RenderOptions, RenderResult } from '@engine/ops/render'
import type { DocumentModel } from '../document/DocumentModel'

interface Job {
  key: string
  pageIndex: number
  opts: RenderOptions
  priority: number
  resolve: (r: RenderResult | null) => void
  cancelled: boolean
}

interface CacheEntry {
  key: string
  result: RenderResult
  bytes: number
}

const MAX_CACHE_BYTES = 384 * 1024 * 1024
const MAX_IN_FLIGHT = 2

/** Prioritised, cancellable page rendering with a bitmap LRU cache (one per document). */
export class RenderQueue {
  private jobs: Job[] = []
  private inFlight = 0
  private cache = new Map<string, CacheEntry>()
  private cacheBytes = 0

  constructor(private doc: DocumentModel) {}

  cached(key: string): RenderResult | null {
    const e = this.cache.get(key)
    if (!e) return null
    this.cache.delete(key)
    this.cache.set(key, e)
    return e.result
  }

  request(key: string, pageIndex: number, opts: RenderOptions, priority: number): { promise: Promise<RenderResult | null>; cancel: () => void } {
    const hit = this.cached(key)
    if (hit) return { promise: Promise.resolve(hit), cancel: () => {} }
    let job!: Job
    const promise = new Promise<RenderResult | null>((resolve) => {
      job = { key, pageIndex, opts, priority, resolve, cancelled: false }
    })
    // Merge with an identical queued job.
    const same = this.jobs.find((j) => j.key === key && !j.cancelled)
    if (same) {
      const prev = same.resolve
      same.priority = Math.min(same.priority, priority)
      same.resolve = (r) => {
        prev(r)
        job.resolve(r)
      }
    } else {
      this.jobs.push(job)
    }
    this.pump()
    return {
      promise,
      cancel: () => {
        job.cancelled = true
        if (!same) {
          const idx = this.jobs.indexOf(job)
          if (idx >= 0) {
            this.jobs.splice(idx, 1)
            job.resolve(null)
          }
        }
      }
    }
  }

  private pump() {
    while (this.inFlight < MAX_IN_FLIGHT && this.jobs.length) {
      this.jobs.sort((a, b) => a.priority - b.priority)
      const job = this.jobs.shift()!
      if (job.cancelled) {
        job.resolve(null)
        continue
      }
      this.inFlight++
      this.doc.core.render
        .page(job.pageIndex, job.opts)
        .then((result) => {
          if (this.doc.isClosed) {
            result.bitmap?.close()
            job.resolve(null)
            return
          }
          this.store(job.key, result)
          job.resolve(result)
        })
        .catch((err) => {
          if (!this.doc.isClosed) console.warn('Render failed', err)
          job.resolve(null)
        })
        .finally(() => {
          this.inFlight--
          this.pump()
        })
    }
  }

  private store(key: string, result: RenderResult) {
    const bytes = result.width * result.height * 4
    const old = this.cache.get(key)
    if (old) {
      this.cacheBytes -= old.bytes
      this.cache.delete(key)
    }
    this.cache.set(key, { key, result, bytes })
    this.cacheBytes += bytes
    while (this.cacheBytes > MAX_CACHE_BYTES && this.cache.size > 1) {
      const [k, e] = this.cache.entries().next().value as [string, CacheEntry]
      this.cache.delete(k)
      this.cacheBytes -= e.bytes
      // Bitmaps may still be on screen; let GC reclaim them rather than closing.
    }
  }

  clear() {
    this.cache.clear()
    this.cacheBytes = 0
    for (const j of this.jobs) j.resolve(null)
    this.jobs = []
  }
}

const queues = new WeakMap<DocumentModel, RenderQueue>()

export function renderQueueFor(doc: DocumentModel): RenderQueue {
  let q = queues.get(doc)
  if (!q) {
    q = new RenderQueue(doc)
    queues.set(doc, q)
  }
  return q
}

/** Draws a render result into a canvas, sizing the canvas to the bitmap. */
export function drawResult(canvas: HTMLCanvasElement, r: RenderResult) {
  if (canvas.width !== r.width) canvas.width = r.width
  if (canvas.height !== r.height) canvas.height = r.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  if (r.bitmap) ctx.drawImage(r.bitmap, 0, 0)
  else if (r.pixels) ctx.putImageData(new ImageData(new Uint8ClampedArray(r.pixels), r.width, r.height), 0, 0)
}
