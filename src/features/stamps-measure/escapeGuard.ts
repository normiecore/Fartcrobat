import { useLayoutEffect } from 'react'

/**
 * While one of our popovers is open, Escape only closes it. Without this the same key press also
 * reaches the app-wide Escape shortcut, which leaves the current tool (the popover closes itself on
 * Escape first, so React's stopPropagation never runs).
 *
 * A layout effect registers the listener before the popover's own (passive) effect, so it runs
 * first; marking the event handled makes the shortcut handler ignore it.
 */
export function useEscapeGuard(open: boolean) {
  useLayoutEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])
}

/** Component form of useEscapeGuard, for places that only know whether a menu is open while rendering. */
export function EscapeGuard() {
  useEscapeGuard(true)
  return null
}
