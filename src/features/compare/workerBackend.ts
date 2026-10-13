import type { ProgressFn } from './core'
import { CancelledError, type DiffBackend } from './pipeline'
import type { TextCompareResult, VisualRegion } from './types'
import type { WorkerRequest, WorkerResponse } from './workerProtocol'

type Payload<K extends WorkerRequest['kind']> = Omit<Extract<WorkerRequest, { kind: K }>, 'id' | 'kind'>

/** Runs the diff in a dedicated Web Worker. `terminate()` stops a running diff at once. */
export class WorkerBackend implements DiffBackend {
  private worker = new Worker(new URL('./diff.worker.ts', import.meta.url), { type: 'module', name: 'compare' })
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; progress?: ProgressFn }>()
  private dead: Error | null = null

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.kind === 'progress') {
        p.progress?.(msg.fraction, msg.message)
        return
      }
      this.pending.delete(msg.id)
      if (msg.kind === 'result') p.resolve(msg.result)
      else p.reject(new Error(msg.message))
    }
    this.worker.onerror = (e) => this.fail(new Error(`The comparison stopped unexpectedly: ${e.message || 'worker error'}`))
  }

  private fail(err: Error) {
    this.dead = err
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private call<K extends WorkerRequest['kind']>(kind: K, payload: Payload<K>, transfer: Transferable[], progress?: ProgressFn) {
    if (this.dead) return Promise.reject(this.dead)
    const id = this.nextId++
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, progress })
      this.worker.postMessage({ kind, id, ...payload } as unknown as WorkerRequest, transfer)
    })
  }

  compareText(...[oldPages, newPages, options, progress]: Parameters<DiffBackend['compareText']>): Promise<TextCompareResult> {
    return this.call('text', { oldPages, newPages, options }, [], progress)
  }

  visualDiff(...[a, b, oldPage, newPage]: Parameters<DiffBackend['visualDiff']>): Promise<VisualRegion[]> {
    const transfer = [a.data.buffer, b.data.buffer].filter((buf, i, arr) => arr.indexOf(buf) === i) as ArrayBuffer[]
    return this.call('visual', { a, b, oldPage, newPage }, transfer)
  }

  /** Stops the worker; calls still running reject with CancelledError. */
  terminate() {
    this.worker.terminate()
    this.fail(new CancelledError())
  }
}
