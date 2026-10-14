// In-process engine for unit tests (Node): same ops and dispatcher as the worker, no thread.
import type { ChangeSet } from '@shared/types'
import type { ClientOps, OpModule } from './define'
import { Dispatcher } from './dispatcher'
import { collectOpModules } from './registry'
import { Session } from './session'

export interface LocalEngine {
  session: Session
  dispatcher: Dispatcher
  lastChanges: ChangeSet | null
  /** Who makes the following calls when it is an AI agent (undo labels read "<actor>: <label>"). */
  actor: string | null
  call<T = unknown>(method: string, ...args: unknown[]): Promise<T>
  ops<M extends OpModule>(namespace: M['namespace'] | string): ClientOps<M>
}

export async function createLocalEngine(): Promise<LocalEngine> {
  const mupdf = await import('mupdf')
  mupdf.setLog({ warning: () => {}, error: () => {} })
  const session = new Session(mupdf)
  const dispatcher = new Dispatcher(session, collectOpModules())
  const engine: LocalEngine = {
    session,
    dispatcher,
    lastChanges: null,
    actor: null,
    async call<T>(method: string, ...args: unknown[]) {
      const r = await dispatcher.call(method, args, undefined, engine.actor)
      engine.lastChanges = r.changes
      return r.result as T
    },
    ops<M extends OpModule>(namespace: string) {
      return new Proxy({} as ClientOps<M>, {
        get: (_t, name) => (...args: unknown[]) => engine.call(`${namespace}.${String(name)}`, ...args)
      })
    }
  }
  return engine
}
