import { useEffect } from 'react'
import { getActiveDoc, setTool, useApp } from '@renderer/sdk'
import { clearFieldSelection, isFormTool, nudgeSelected, selectedIds } from './actions'
import { openProperties } from './PropertiesDialog'
import { usePF } from './state'

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !['checkbox', 'radio', 'button', 'range', 'color'].includes((el as HTMLInputElement).type)
  return false
}

/**
 * Keyboard handling while editing a form: arrow keys nudge the selected fields (Shift: 10 points),
 * Enter opens their properties and Esc steps back (creation tool -> selection tool -> deselect)
 * instead of leaving form editing. Runs before the app's own shortcuts (capture phase).
 */
export function PrepareFormKeys() {
  useEffect(() => {
    let pendingDx = 0
    let pendingDy = 0
    let timer: number | null = null
    const flush = () => {
      timer = null
      const doc = getActiveDoc()
      const dx = pendingDx
      const dy = pendingDy
      pendingDx = pendingDy = 0
      if (doc && (dx || dy)) void nudgeSelected(doc, dx, dy)
    }
    const onKey = (e: KeyboardEvent) => {
      const app = useApp.getState()
      if (!isFormTool(app.toolId) || app.dialogs.length || app.contextMenu || app.paletteOpen) return
      if (isTyping(e.target) || e.defaultPrevented) return
      const doc = getActiveDoc()
      if (!doc) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        if (app.toolId !== 'form.select') {
          usePF.setState({ radioGroup: null, pendingSigner: null })
          setTool('form.select')
        } else if (usePF.getState().inline) usePF.setState({ inline: null })
        else clearFieldSelection(doc)
        return
      }
      // arrows and Enter only act on fields when the focus is on the document (not in a panel)
      const t = e.target as HTMLElement | null
      const onDocument = !t || t === document.body || !!t.closest?.('.viewer-scroll')
      const ids = selectedIds(doc)
      if (!onDocument || !ids.length || e.ctrlKey || e.metaKey || e.altKey) return
      const step = e.shiftKey ? 10 : 1
      let dx = 0
      let dy = 0
      if (e.key === 'ArrowLeft') dx = -step
      else if (e.key === 'ArrowRight') dx = step
      else if (e.key === 'ArrowUp') dy = -step
      else if (e.key === 'ArrowDown') dy = step
      else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        openProperties(doc, ids)
        return
      } else return
      e.preventDefault()
      e.stopPropagation()
      // coalesce key repeats into one move
      pendingDx += dx
      pendingDy += dy
      if (timer === null) timer = window.setTimeout(flush, 120)
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])

  // Leaving form editing drops the field selection and any half-finished placement.
  useEffect(
    () =>
      useApp.subscribe((s, prev) => {
        if (s.toolId === prev.toolId || isFormTool(s.toolId)) return
        if (!isFormTool(prev.toolId)) return
        usePF.setState({ inline: null, radioGroup: null, pendingSigner: null })
        for (const d of s.docs) clearFieldSelection(d)
      }),
    []
  )
  return null
}
