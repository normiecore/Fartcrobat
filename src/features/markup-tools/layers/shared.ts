import { useEffect, useRef } from 'react'
import type { Point } from '@shared/geometry'
import { useApp, type PageGeometry } from '@renderer/sdk'
import { clampPoint } from '../geometry'
import { useToolStyle } from '../style'
import { TOOL_BY_ID, type MarkupTool } from '../tools'

/** The markup tool currently active (the layer is only mounted for its own tools). */
export function useActiveTool(): MarkupTool | null {
  const id = useApp((s) => s.toolId)
  return TOOL_BY_ID.get(id) ?? null
}

export function useActiveToolAndStyle() {
  const tool = useActiveTool()
  const style = useToolStyle(tool?.key ?? 'highlight')
  return { tool, style }
}

/** Pointer position in page space, clamped to the page. */
export function pagePoint(e: { clientX: number; clientY: number }, el: Element, g: PageGeometry): Point {
  return clampPoint(g.eventToPage(e, el), g.width, g.height)
}

/**
 * Listens to key presses (capture phase, before the global shortcuts) while `active` is true.
 * The handler returns true when it handled the key; the event is then stopped.
 */
export function useKeys(active: boolean, handler: (e: KeyboardEvent) => boolean) {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return
      if (useApp.getState().dialogs.length) return
      if (ref.current(e)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [active])
}

/** Scrolls the document while dragging near the edges of the viewport. */
export function autoScroll(doc: { view: { getViewportElement(): HTMLElement | null; scrollBy(dx: number, dy: number): void } | null }, e: { clientX: number; clientY: number }) {
  const vp = doc.view?.getViewportElement()
  if (!vp) return
  const b = vp.getBoundingClientRect()
  const edge = 28
  let dx = 0
  let dy = 0
  if (e.clientY < b.top + edge) dy = -20
  else if (e.clientY > b.bottom - edge) dy = 20
  if (e.clientX < b.left + edge) dx = -20
  else if (e.clientX > b.right - edge) dx = 20
  if (dx || dy) doc.view?.scrollBy(dx, dy)
}

/** Keeps a callback's latest version in a ref (for timers and async continuations). */
export function useLatest<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}
