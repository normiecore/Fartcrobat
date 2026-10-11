import { create } from 'zustand'
import type { ReactNode } from 'react'
import { DEFAULT_PREFERENCES, type Preferences, type RecentFile, type SystemInfo } from '@shared/types'
import type { DocumentModel } from '../document/DocumentModel'

export interface DialogEntry {
  id: number
  render: (close: (result?: unknown) => void) => ReactNode
  resolve: (result: unknown) => void
}

export interface ToastEntry {
  id: number
  message: string
  kind: 'info' | 'success' | 'error' | 'warning'
  action?: { label: string; run: () => void }
  timeout: number
}

export interface ProgressEntry {
  title: string
  message?: string
  fraction: number | null
  cancel?: () => void
}

export interface ContextMenuState {
  x: number
  y: number
  items: import('./registry').ContextMenuItem[]
}

export interface AppState {
  docs: DocumentModel[]
  activeDocId: string | null
  prefs: Preferences
  systemInfo: SystemInfo | null
  recent: RecentFile[]
  toolId: string
  toolGroupId: string | null
  leftPaneOpen: boolean
  rightPanelId: string | null
  findBarOpen: boolean
  readMode: boolean
  fullScreen: boolean
  dialogs: DialogEntry[]
  toasts: ToastEntry[]
  progress: ProgressEntry | null
  contextMenu: ContextMenuState | null
  paletteOpen: boolean
  /** Temporary hand tool while Space is held. */
  spaceHand: boolean
}

export const useApp = create<AppState>(() => ({
  docs: [],
  activeDocId: null,
  prefs: { ...DEFAULT_PREFERENCES },
  systemInfo: null,
  recent: [],
  toolId: 'select',
  toolGroupId: null,
  leftPaneOpen: true,
  rightPanelId: null,
  findBarOpen: false,
  readMode: false,
  fullScreen: false,
  dialogs: [],
  toasts: [],
  progress: null,
  contextMenu: null,
  paletteOpen: false,
  spaceHand: false
}))

export function getActiveDoc(): DocumentModel | null {
  const s = useApp.getState()
  return s.docs.find((d) => d.id === s.activeDocId) ?? null
}

/** React hook returning the active document (or null on the Home screen). */
export function useActiveDoc(): DocumentModel | null {
  return useApp((s) => s.docs.find((d) => d.id === s.activeDocId) ?? null)
}

export function usePrefs(): Preferences {
  return useApp((s) => s.prefs)
}
