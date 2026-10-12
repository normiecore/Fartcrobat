import type { RenderOptions, RenderResult } from '@engine/ops/render'
import type { DocumentModel } from '../document/DocumentModel'

type Waiter = (r: RenderResult | null) => void

interface Job {
  key: string
  pageIndex: number
  opts: RenderOptions
  priority: number
  /** Consumers waiting for this render. A queued job nobody waits for any more is dropped. */
  waiters: Set<Waiter>
  started: boolean
}

interface CacheEntry {
  result: RenderResult
  bytes: number
}

/** Whole-page bitmaps (reused while scrolling and zooming back and forth). */
const MAX_CACHE_BYTES = 384 * 1024 * 1024
/** Detail tiles (clipped renders) are mostly single-use, so they get a small cache of their own. */
const MAX_TILE_CACHE_BYTES = 64 * 1024 * 1024
const MAX_IN_FLIGHT = 2

/**
 * Frees the memory of a bitmap that left the cache. Canvases copy the pixels when they draw, so
 * nothing on screen depends on it; waiting one task lets a consumer that was just handed the
 * bitmap draw it first.
 */
function release(result: RenderResult) {
  const bitmap = result.bitmap
  if (bitmap) setTimeout(() => bitmap.close(), 0)
}

class BitmapCache {
  private map = new Map<string, CacheEntry>()
  private bytes = 0

  constructor(private maxBytes: number) {}

  get(key: string): RenderResult | null {
    const e = this.map.get(key)
    if (!e) return null
    this.map.delete(key)
    this.map.set(key, e)
    return e.result
  }

  set(key: string, result: RenderResult) {
    const old = this.map.get(key)
    if (old) {
      this.map.delete(key)
      this.bytes -= old.bytes
      if (old.result !== result) release(old.result)
    }
    const bytes = result.width * result.height * 4
    this.map.set(key, { result, bytes })
    this.bytes += bytes
    // the newest entry stays even when it alone is over budget
    this.evictTo(this.maxBytes, 1)
  }

  /** Drops least recently used entries until at most maxBytes (and keepAtLeast entries) remain. */
  evictTo(maxBytes: number, keepAtLeast = 0) {
    while (this.bytes > maxBytes && this.map.size > keepAtLeast) {
      const [k, e] = this.map.entries().next().value as [string, CacheEntry]
      this.map.delete(k)
      this.bytes -= e.bytes
      release(e.result)
    }
  }

  clear() {
    for (const e of this.map.values()) release(e.result)
    this.map.clear()
    this.bytes = 0
  }
}

/**
 * Prioritised, cancellable page rendering with bitmap LRU caches (one queue per document).
 * Requests with the same key share one render; cancelling one consumer never affects the others.
 */
export class RenderQueue {
  private jobs: Job[] = []
  private byKey = new Map<string, Job>()
  private inFlight = 0
  private pages = new BitmapCache(MAX_CACHE_BYTES)
  private tiles = new BitmapCache(MAX_TILE_CACHE_BYTES)

  constructor(private doc: DocumentModel) {}

  cached(key: string): RenderResult | null {
    return this.pages.get(key) ?? this.tiles.get(key)
  }

  request(key: string, pageIndex: number, opts: RenderOptions, priority: number): { promise: Promise<RenderResult | null>; cancel: () => void } {
    const hit = this.cached(key)
    if (hit) return { promise: Promise.resolve(hit), cancel: () => {} }
    let waiter!: Waiter
    const promise = new Promise<RenderResult | null>((resolve) => (waiter = resolve))
    // Join an identical render that is queued or already running.
    let job = this.byKey.get(key)
    if (job) {
      job.waiters.add(waiter)
      job.priority = Math.min(job.priority, priority)
    } else {
      job = { key, pageIndex, opts, priority, waiters: new Set([waiter]), started: false }
      this.byKey.set(key, job)
      this.jobs.push(job)
    }
    const j = job
    this.pump()
    return {
      promise,
      cancel: () => {
        if (!j.waiters.delete(waiter)) return
        waiter(null)
        // A running render finishes (and is cached); a queued one that nobody wants is dropped.
        if (!j.waiters.size && !j.started) {
          const idx = this.jobs.indexOf(j)
          if (idx >= 0) this.jobs.splice(idx, 1)
          if (this.byKey.get(j.key) === j) this.byKey.delete(j.key)
        }
      }
    }
  }

  private settle(job: Job, result: RenderResult | null) {
    if (this.byKey.get(job.key) === job) this.byKey.delete(job.key)
    const waiters = [...job.waiters]
    job.waiters.clear()
    for (const w of waiters) w(result)
  }

  private pump() {
    while (this.inFlight < MAX_IN_FLIGHT && this.jobs.length) {
      this.jobs.sort((a, b) => a.priority - b.priority)
      const job = this.jobs.shift()!
      if (!job.waiters.size) {
        this.settle(job, null)
        continue
      }
      job.started = true
      this.inFlight++
      this.doc.core.render
        .page(job.pageIndex, job.opts)
        .then((result) => {
          if (this.doc.isClosed) {
            result.bitmap?.close()
            this.settle(job, null)
            return
          }
          ;(job.opts.clip ? this.tiles : this.pages).set(job.key, result)
          this.settle(job, result)
        })
        .catch((err) => {
          if (!this.doc.isClosed) console.warn('Render failed', err)
          this.settle(job, null)
        })
        .finally(() => {
          this.inFlight--
          this.pump()
        })
    }
  }

  /**
   * Shrinks the caches to at most maxBytes of page bitmaps and no detail tiles, e.g. while the
   * document is not shown (its tab is in the background) or after it was closed (maxBytes 0).
   */
  trim(maxBytes = 0) {
    this.pages.evictTo(maxBytes)
    this.tiles.evictTo(0)
  }

  clear() {
    this.pages.clear()
    this.tiles.clear()
    const jobs = this.jobs
    this.jobs = []
    for (const j of jobs) this.settle(j, null)
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
  if (r.bitmap) {
    // a bitmap that was released (closed) has no size; drawing it would throw
    if (r.bitmap.width) ctx.drawImage(r.bitmap, 0, 0)
  } else if (r.pixels) ctx.putImageData(new ImageData(new Uint8ClampedArray(r.pixels), r.width, r.height), 0, 0)
}
