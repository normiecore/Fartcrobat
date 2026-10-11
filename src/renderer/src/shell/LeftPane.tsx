import { ChevronLeft, ChevronRight } from 'lucide-react'
import { registry, type ToolCategory } from '../app/registry'
import { useActiveDoc, useApp } from '../app/store'
import { openToolGroup } from '../app/actions'
import { PanelFrame } from '../ui/Panel'
import { useState } from 'react'

const CATEGORIES: { id: 'all' | ToolCategory; label: string }[] = [
  { id: 'all', label: 'All tools' },
  { id: 'edit', label: 'Edit' },
  { id: 'convert', label: 'Convert' },
  { id: 'sign', label: 'E-Sign' }
]

export function AllToolsList({ compact }: { compact?: boolean }) {
  const [cat, setCat] = useState<'all' | ToolCategory>('all')
  const groups = registry.toolGroups.filter((g) => cat === 'all' || g.category === cat)
  return (
    <div className="shell-alltools">
      {!compact && (
        <div className="shell-alltools-cats">
          {CATEGORIES.map((c) => (
            <button key={c.id} className={cat === c.id ? 'is-active' : ''} onClick={() => setCat(c.id)}>
              {c.label}
            </button>
          ))}
        </div>
      )}
      <div className="shell-alltools-list">
        {groups.map((g) => (
          <button key={g.id} className="shell-alltools-item" onClick={() => openToolGroup(g.id)} title={g.description}>
            <span className="shell-alltools-icon" style={{ background: g.color ?? 'var(--accent)' }}>
              <g.icon size={16} />
            </span>
            <span>{g.label}</span>
          </button>
        ))}
        {groups.length === 0 && <div className="shell-muted">No tools in this category yet.</div>}
      </div>
    </div>
  )
}

export function LeftPane() {
  const open = useApp((s) => s.leftPaneOpen)
  const groupId = useApp((s) => s.toolGroupId)
  const doc = useActiveDoc()
  const group = registry.toolGroups.find((g) => g.id === groupId)
  if (!open) {
    return (
      <div className="shell-leftpane is-collapsed">
        <button
          className="ui-icon-btn"
          title="Show tools pane"
          aria-label="Show tools pane"
          onClick={() => useApp.setState({ leftPaneOpen: true })}
        >
          <ChevronRight size={18} />
        </button>
      </div>
    )
  }
  return (
    <aside className="shell-leftpane">
      {group?.panel ? (
        <group.panel doc={doc} />
      ) : (
        <PanelFrame
          title="All tools"
          actions={
            <button
              className="ui-icon-btn"
              title="Hide tools pane"
              aria-label="Hide tools pane"
              onClick={() => useApp.setState({ leftPaneOpen: false })}
            >
              <ChevronLeft size={18} />
            </button>
          }
        >
          <AllToolsList />
        </PanelFrame>
      )}
    </aside>
  )
}

/** Header used by tool group panels: back arrow returns to the All tools list. */
export function ToolPanelFrame(props: Omit<Parameters<typeof PanelFrame>[0], 'onBack'>) {
  return <PanelFrame {...props} onBack={() => openToolGroup(null)} />
}
