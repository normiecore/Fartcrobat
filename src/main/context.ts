import type { BrowserWindow } from 'electron'
import { handle, send } from './ipc'
import { store } from './store'

/** What a feature's `main.ts` receives to register its main-process handlers. */
export interface MainContext {
  handle: typeof handle
  send: typeof send
  store: typeof store
  /** The focused window, or the most recently created one. */
  currentWindow(): BrowserWindow | null
}

export interface MainFeatureModule {
  register(ctx: MainContext): void
}
