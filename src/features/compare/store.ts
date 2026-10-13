import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import type { DocumentModel } from '@renderer/sdk'
import { DEFAULT_OPTIONS, type ChangeCategory, type CompareOptions, type CompareResult } from './types'

export type Side = 'old' | 'new'

/** A file chosen for one side of the comparison. */
export interface Slot {
  doc: DocumentModel | null
  /** Display name and path (path is null for unsaved documents). */
  name: string
  path: string | null
  /** True while a file from disk is being opened. */
  loading: boolean
  /** "All pages" or a custom range like "1-3, 5". */
  allPages: boolean
  range: string
}

export const emptySlot = (): Slot => ({ doc: null, name: '', path: null, loading: false, allPages: true, range: '' })

/** The comparison currently shown. */
export interface Session {
  /** Increases with every comparison. */
  id: number
  old: { doc: DocumentModel; name: string; path: string | null }
  new: { doc: DocumentModel; name: string; path: string | null }
  result: CompareResult
}

export interface Running {
  fraction: number
  message: string
  cancel: () => void
}

export type Filter = Record<ChangeCategory, boolean>

export const ALL_FILTER: Filter = { replaced: true, inserted: true, deleted: true, formatting: true, image: true, page: true }

export interface CompareState {
  slots: Record<Side, Slot>
  options: CompareOptions
  running: Running | null
  session: Session | null
  /** Id of the selected change. */
  selected: number | null
  /** Bumps when the view should scroll to the selected change. */
  focusTick: number
  filter: Filter
  overlay: boolean
  zoom: number
  fitWidth: boolean
  /** Why the results may be out of date (a document was edited or closed), or null. */
  stale: string | null
}

export const compareStore = createStore<CompareState>(() => ({
  slots: { old: emptySlot(), new: emptySlot() },
  options: { ...DEFAULT_OPTIONS },
  running: null,
  session: null,
  selected: null,
  focusTick: 0,
  filter: { ...ALL_FILTER },
  overlay: false,
  zoom: 1,
  fitWidth: true,
  stale: null
}))

export function useCompare<T>(selector: (s: CompareState) => T): T {
  return useStore(compareStore, selector)
}

export const getCompare = () => compareStore.getState()
export const setCompare = (patch: Partial<CompareState> | ((s: CompareState) => Partial<CompareState>)) =>
  compareStore.setState(patch as Partial<CompareState>)

export function patchSlot(side: Side, patch: Partial<Slot>) {
  setCompare((s) => ({ slots: { ...s.slots, [side]: { ...s.slots[side], ...patch } } }))
}
