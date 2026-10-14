import type { ClientOps, OpModule } from '@engine/define'
import type { EngineMessage, EngineRequest } from '@engine/protocol'
import type { ChangeSet } from '@shared/types'

export class EngineCallError extends Error {
  constructor(
    message: string,
    public readonly code: string
  ) {
    super(message)
    this.name = 'EngineCallError'
  }
}

/** True for the error a closed document's calls fail with (those still running when it closed, and later ones). */
export function isDocumentClosedError(err: unknown): boolean {
  return err instanceof EngineCallError && err.code === 'CLOSED'
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onProgress?: (fraction: number, message?: string) => void
  method: string
}

export interface CallOptions {
  onProgress?: (fraction: number, message?: string) => void
  transfer?: Transferable[]
}

/** Talks to one engine Web Worker (one per open document). */
export class EngineClient {
  private worker: Worker
  private nextId = 1
  private pending = new Map<number, Pending>()
  private readyPromise: Promise<void>
  private changeListeners = new Set<(cs: ChangeSet) => void>()
  private terminated = false
  /** Number of calls in flight (for busy indicators). */
  inFlight = 0
  /** Set while an AI agent's request runs (see runAs): its undo steps read "<actor>: <label>". */
  private actor: string | null = null
  private actorDepth = 0

  constructor() {
    this.worker = new Worker(new URL('../../../engine/worker.ts', import.meta.url), { type: 'module', name: 'engine' })
    this.readyPromise = new Promise((resolve, reject) => {
      const onMessage = (e: MessageEvent<EngineMessage>) => {
        if (e.data.kind === 'ready') {
          this.worker.removeEventListener('message', onMessage)
          resolve()
        } else if (e.data.kind === 'init-error') {
          this.worker.removeEventListener('message', onMessage)
          reject(new Error(e.data.message))
        }
      }
      this.worker.addEventListener('message', onMessage)
    })
    this.worker.addEventListener('message', (e: MessageEvent<EngineMessage>) => this.onMessage(e.data))
    this.worker.addEventListener('error', (e) => {
      console.error('Engine worker error', e)
      for (const p of this.pending.values()) p.reject(new EngineCallError('The document engine crashed', 'CRASH'))
      this.pending.clear()
    })
  }

  ready(): Promise<void> {
    return this.readyPromise
  }

  onChanges(listener: (cs: ChangeSet) => void): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  private onMessage(msg: EngineMessage) {
    if (msg.kind === 'progress') {
      this.pending.get(msg.id)?.onProgress?.(msg.fraction, msg.message)
      return
    }
    if (msg.kind !== 'result' && msg.kind !== 'error') return
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    this.inFlight--
    if (msg.changes) for (const l of this.changeListeners) l(msg.changes)
    if (msg.kind === 'result') p.resolve(msg.result)
    else p.reject(new EngineCallError(msg.message, msg.code))
  }

  call<T = unknown>(method: string, args: unknown[], opts: CallOptions = {}): Promise<T> {
    if (this.terminated) return Promise.reject(new EngineCallError('Document is closed', 'CLOSED'))
    const id = this.nextId++
    const req: EngineRequest = this.actor ? { kind: 'call', id, method, args, actor: this.actor } : { kind: 'call', id, method, args }
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress: opts.onProgress, method })
      this.inFlight++
      this.worker.postMessage(req, opts.transfer ?? [])
    })
  }

  /**
   * Runs `fn` on behalf of an AI agent: engine calls made meanwhile (also by helpers fn uses) are
   * tagged so their undo steps read "<actor>: <label>". Calls the person makes in that window are
   * tagged too, which only changes a label.
   */
  async runAs<T>(actor: string, fn: () => Promise<T>): Promise<T> {
    this.actorDepth++
    this.actor = actor
    try {
      return await fn()
    } finally {
      if (--this.actorDepth === 0) this.actor = null
    }
  }

  /** Typed proxy for an op module: `client.ops<typeof import('./engine').default>('stamps').add(...)` */
  ops<M extends OpModule>(namespace: string, opts: CallOptions = {}): ClientOps<M> {
    return new Proxy({} as ClientOps<M>, {
      get: (_t, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined
        return (...args: unknown[]) => this.call(`${namespace}.${name}`, args, opts)
      }
    })
  }

  terminate() {
    this.terminated = true
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new EngineCallError('Document is closed', 'CLOSED'))
    this.pending.clear()
  }
}
