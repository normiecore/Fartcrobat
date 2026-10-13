import type { ChangeSet } from '@shared/types'

/** `actor`: set when an AI agent made the call; its undo steps are labelled "<actor>: <label>". */
export type EngineRequest = { kind: 'call'; id: number; method: string; args: unknown[]; actor?: string }

export type EngineMessage =
  | { kind: 'ready'; methods: string[] }
  | { kind: 'init-error'; message: string }
  | { kind: 'result'; id: number; result: unknown; changes: ChangeSet | null }
  | { kind: 'error'; id: number; message: string; code: string; changes: ChangeSet | null }
  | { kind: 'progress'; id: number; fraction: number; message?: string }
