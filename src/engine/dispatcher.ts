import type { ChangeSet } from '@shared/types'
import { EngineError, mutationLabel, Transfer, type OpFn, type OpModule } from './define'
import type { Session } from './session'

export interface DispatchResult {
  result: unknown
  transfer: Transferable[]
  changes: ChangeSet | null
}

/**
 * Routes "namespace.method" calls to op functions, one at a time, wrapping mutations in undo
 * steps and collecting what changed.
 */
export class Dispatcher {
  private readonly methods = new Map<string, OpFn>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    readonly session: Session,
    modules: OpModule[]
  ) {
    for (const mod of modules) {
      for (const [name, fn] of Object.entries(mod.ops)) {
        const key = `${mod.namespace}.${name}`
        if (this.methods.has(key)) throw new Error(`Duplicate engine op ${key}`)
        this.methods.set(key, fn)
      }
    }
  }

  has(method: string): boolean {
    return this.methods.has(method)
  }

  list(): string[] {
    return [...this.methods.keys()].sort()
  }

  /**
   * `actor` names who asked for the call when it was not the person at the keyboard (an AI agent):
   * undo steps it creates are labelled "<actor>: <label>".
   */
  call(
    method: string,
    args: unknown[],
    progress?: (fraction: number, message?: string) => void,
    actor?: string | null
  ): Promise<DispatchResult> {
    const run = async (): Promise<DispatchResult> => {
      const fn = this.methods.get(method)
      if (!fn) throw new EngineError(`Unknown engine op ${method}`, 'UNKNOWN_OP')
      const s = this.session
      s.setProgressSink(progress ?? null)
      s.actor = actor || null
      try {
        const label = mutationLabel(fn, args)
        let value: unknown
        if (label !== null) {
          value = s.runMutation(label, () => fn(s, ...args))
        } else {
          value = await fn(s, ...args)
        }
        let transfer: Transferable[] = []
        if (value instanceof Transfer) {
          transfer = value.transferables
          value = value.value
        }
        const changes = s.doc ? s.takeChanges() : null
        return { result: value, transfer, changes }
      } finally {
        s.setProgressSink(null)
        s.actor = null
      }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }
}
