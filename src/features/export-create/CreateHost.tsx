import { useEffect } from 'react'
import { openToolGroup, useApp } from '@renderer/sdk'
import { CreatePanel, CreateView } from './CreateView'
import { loadSettings } from './state'

/**
 * Always mounted. Create a PDF works without an open document: opened from Home it covers Home with
 * the same panel and view a document tab would show.
 */
export function CreateHost() {
  const noDoc = useApp((s) => s.activeDocId === null)
  const open = useApp((s) => s.toolGroupId === 'create')
  useEffect(() => {
    void loadSettings()
    // Going back to Home from a document leaves Create a PDF.
    return useApp.subscribe((s, prev) => {
      if (prev.activeDocId !== null && s.activeDocId === null && s.toolGroupId === 'create') openToolGroup(null)
    })
  }, [])
  useEffect(() => {
    if (!noDoc || !open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !useApp.getState().dialogs.length && !useApp.getState().progress) openToolGroup(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [noDoc, open])
  if (!noDoc || !open) return null
  return (
    <div className="fc-export-create-home">
      <aside className="shell-leftpane fc-export-create-home-pane">
        <CreatePanel doc={null} />
      </aside>
      <div className="fc-export-create-home-main">
        <CreateView />
      </div>
    </div>
  )
}
