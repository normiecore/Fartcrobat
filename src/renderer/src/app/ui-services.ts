import type { ReactNode } from 'react'
import { isDocumentClosedError } from '../engine/EngineClient'
import { useApp, type ToastEntry } from './store'
import type { ContextMenuItem } from './registry'

let nextId = 1

/** Opens a modal dialog. `render` receives `close(result)`; resolves with the result (undefined if dismissed). */
export function openDialog<R = unknown>(render: (close: (result?: R) => void) => ReactNode): Promise<R | undefined> {
  return new Promise((resolve) => {
    const id = nextId++
    useApp.setState((s) => ({
      dialogs: [
        ...s.dialogs,
        {
          id,
          render: render as (close: (r?: unknown) => void) => ReactNode,
          resolve: (r: unknown) => {
            useApp.setState((st) => ({ dialogs: st.dialogs.filter((d) => d.id !== id) }))
            resolve(r as R | undefined)
          }
        }
      ]
    }))
  })
}

export function toast(
  message: string,
  opts: { kind?: ToastEntry['kind']; action?: ToastEntry['action']; timeout?: number } = {}
): number {
  const id = nextId++
  const entry: ToastEntry = {
    id,
    message,
    kind: opts.kind ?? 'info',
    action: opts.action,
    timeout: opts.timeout ?? (opts.kind === 'error' ? 8000 : 4000)
  }
  useApp.setState((s) => ({ toasts: [...s.toasts, entry] }))
  if (entry.timeout > 0) setTimeout(() => dismissToast(id), entry.timeout)
  return id
}

export function dismissToast(id: number) {
  useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

export function showError(err: unknown, prefix?: string) {
  // Work still running when the user closed its document fails with this: nothing to tell them.
  if (isDocumentClosedError(err)) return
  const msg = err instanceof Error ? err.message : String(err)
  console.error(prefix ?? 'Error', err)
  toast(prefix ? `${prefix}: ${msg}` : msg, { kind: 'error' })
}

/**
 * Runs a long task with a modal progress indicator. The task receives a reporter for
 * fraction (0..1) and message updates.
 */
export async function withProgress<T>(
  title: string,
  task: (report: (fraction: number | null, message?: string) => void) => Promise<T>,
  opts: { cancel?: () => void } = {}
): Promise<T> {
  useApp.setState({ progress: { title, fraction: null, cancel: opts.cancel } })
  try {
    return await task((fraction, message) =>
      useApp.setState((s) => ({ progress: s.progress ? { ...s.progress, fraction, message } : s.progress }))
    )
  } finally {
    useApp.setState({ progress: null })
  }
}

export function showContextMenu(x: number, y: number, items: ContextMenuItem[]) {
  if (!items.length) return
  useApp.setState({ contextMenu: { x, y, items } })
}

export function hideContextMenu() {
  useApp.setState({ contextMenu: null })
}
