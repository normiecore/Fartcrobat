import { useEffect } from 'react'
import { openToolGroup, useApp } from '@renderer/sdk'
import { loadSavedOptions } from './actions'
import { ComparePanel } from './ComparePanel'
import { CompareView } from './CompareView'
import { watchTabs } from './sources'

/**
 * Always mounted. Compare files also works without an open document: opened from the Home screen
 * it covers Home with the same panel and view the document area would show.
 */
export function CompareHost() {
  const noDoc = useApp((s) => s.activeDocId === null)
  const open = useApp((s) => s.toolGroupId === 'compare')
  useEffect(() => {
    void loadSavedOptions()
    const unwatch = watchTabs()
    // Going back to Home (or closing the last tab) leaves Compare files; the results are kept.
    const unsub = useApp.subscribe((s, prev) => {
      if (prev.activeDocId !== null && s.activeDocId === null && s.toolGroupId === 'compare') openToolGroup(null)
    })
    return () => {
      unwatch()
      unsub()
    }
  }, [])
  if (!noDoc || !open) return null
  return (
    <div className="fc-compare-home">
      <aside className="shell-leftpane fc-compare-home-pane">
        <ComparePanel doc={null} />
      </aside>
      <div className="fc-compare-home-main">
        <CompareView />
      </div>
    </div>
  )
}
