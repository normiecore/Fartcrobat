import type { Session } from './session'

/**
 * Engine operations are plain functions that receive the document Session first. They run inside
 * the engine Web Worker (or directly in Node for tests).
 *
 * A feature declares its operations in `src/features/<feature>/engine.ts`:
 *
 *   export default defineOps('stamps', {
 *     list: (s, page: number) => ...,                        // read-only query
 *     add: mutation('Add Stamp', (s, page: number) => ...)  // undoable change
 *   })
 *
 * and calls them from the UI with full typing:
 *
 *   const stamps = doc.ops<typeof import('./engine').default>('stamps')
 *   await stamps.add(0)
 */

export type OpFn = (s: Session, ...args: any[]) => any

export interface OpModule<T extends Record<string, OpFn> = Record<string, OpFn>> {
  namespace: string
  ops: T
}

export const MUTATION = Symbol.for('fartcrobat.mutation')

/** A fixed label, or a function of the op's arguments (e.g. "Delete 3 Pages"). */
export type MutationLabel = string | ((...args: any[]) => string)

/**
 * Marks an operation as an undoable document change. The engine wraps it in a MuPDF journal
 * operation, so Edit > Undo reverts it as a single step labelled `label`.
 */
export function mutation<A extends any[], R>(
  label: MutationLabel,
  fn: (s: Session, ...args: A) => R
): (s: Session, ...args: A) => R {
  ;(fn as any)[MUTATION] = label
  return fn
}

export function mutationLabel(fn: OpFn, args: unknown[]): string | null {
  const label = (fn as any)[MUTATION] as MutationLabel | undefined
  if (label === undefined) return null
  return typeof label === 'function' ? label(...args) : label
}

export function defineOps<T extends Record<string, OpFn>>(namespace: string, ops: T): OpModule<T> {
  return { namespace, ops }
}

/** Wraps a result so the given buffers are transferred (not copied) to the UI thread. */
export class Transfer<T> {
  constructor(
    public readonly value: T,
    public readonly transferables: Transferable[]
  ) {}
}

export function withTransfer<T>(value: T, transferables: Transferable[]): Transfer<T> {
  return new Transfer(value, transferables)
}

type Unwrap<R> = R extends Transfer<infer V> ? V : R

/** The client-side (UI) view of an op module: same functions, minus the session, returning promises. */
export type ClientOps<M> =
  M extends OpModule<infer T>
    ? {
        [K in keyof T]: T[K] extends (s: Session, ...args: infer A) => infer R
          ? (...args: A) => Promise<Unwrap<Awaited<R>>>
          : never
      }
    : never

export class EngineError extends Error {
  constructor(
    message: string,
    public readonly code: string = 'ENGINE_ERROR'
  ) {
    super(message)
    this.name = 'EngineError'
  }
}
