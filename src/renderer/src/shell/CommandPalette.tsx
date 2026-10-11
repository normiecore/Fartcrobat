import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { registry, type Icon } from '../app/registry'
import { getActiveDoc, useApp } from '../app/store'
import { commandLabel, displayShortcut, isCommandEnabled, runCommand } from '../app/commands'
import { openToolGroup, setTool } from '../app/actions'

interface Entry {
  id: string
  label: string
  hint: string
  icon?: Icon
  keywords: string
  shortcut?: string
  run: () => void
}

function score(entry: Entry, q: string): number {
  const label = entry.label.toLowerCase()
  if (label.startsWith(q)) return 0
  if (label.includes(q)) return 1
  if (entry.keywords.includes(q)) return 2
  const words = q.split(/\s+/).filter(Boolean)
  if (words.every((w) => label.includes(w) || entry.keywords.includes(w))) return 3
  return -1
}

/** "Find text or tools": fuzzy search over tools and commands; Enter on free text searches the document. */
export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const entries = useMemo<Entry[]>(() => {
    if (!open) return []
    const list: Entry[] = []
    for (const g of registry.toolGroups) {
      list.push({
        id: `group:${g.id}`,
        label: g.label,
        hint: 'Tool',
        icon: g.icon,
        keywords: [g.description ?? '', ...(g.keywords ?? [])].join(' ').toLowerCase(),
        run: () => openToolGroup(g.id)
      })
    }
    for (const t of registry.tools.values()) {
      list.push({
        id: `tool:${t.id}`,
        label: t.label,
        hint: 'Tool',
        icon: t.icon,
        keywords: t.id.toLowerCase(),
        shortcut: t.shortcut,
        run: () => setTool(t.id)
      })
    }
    for (const c of registry.commands.values()) {
      if (c.hidden || !isCommandEnabled(c)) continue
      const shortcut = Array.isArray(c.shortcut) ? c.shortcut[0] : c.shortcut
      list.push({
        id: `cmd:${c.id}`,
        label: commandLabel(c),
        hint: 'Command',
        icon: c.icon,
        keywords: [c.id, ...(c.keywords ?? [])].join(' ').toLowerCase(),
        shortcut,
        run: () => void runCommand(c.id)
      })
    }
    return list
  }, [open])
  if (!open) return null
  const query = q.trim().toLowerCase()
  const results = query
    ? entries
        .map((e) => ({ e, s: score(e, query) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => a.s - b.s || a.e.label.localeCompare(b.e.label))
        .slice(0, 12)
        .map((x) => x.e)
    : entries.filter((e) => e.hint === 'Tool').slice(0, 12)
  const doc = getActiveDoc()
  const searchEntry: Entry | null =
    query && doc
      ? {
          id: 'search-text',
          label: `Search “${q.trim()}” in this document`,
          hint: 'Text',
          icon: Search,
          keywords: '',
          run: () => {
            useApp.setState({ findBarOpen: true })
            void doc.search(q.trim())
          }
        }
      : null
  const all = searchEntry ? [...results, searchEntry] : results
  const close = () => {
    useApp.setState({ paletteOpen: false })
    setQ('')
    setSel(0)
  }
  const pick = (e: Entry | undefined) => {
    if (!e) return
    close()
    e.run()
  }
  return (
    <div className="ui-dialog-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-label="Find text or tools">
        <div className="palette-input">
          <Search size={16} />
          <input
            autoFocus
            placeholder="Find text or tools"
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(all.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                pick(all[sel])
              }
            }}
          />
        </div>
        <div className="palette-results" role="listbox">
          {all.map((e, i) => (
            <button
              key={e.id}
              role="option"
              aria-selected={i === sel}
              className={`palette-item ${i === sel ? 'is-active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(e)}
            >
              <span className="palette-icon">{e.icon && <e.icon size={16} />}</span>
              <span className="palette-label">{e.label}</span>
              {e.shortcut && <kbd>{displayShortcut(e.shortcut)}</kbd>}
              <span className="palette-hint">{e.hint}</span>
            </button>
          ))}
          {all.length === 0 && <div className="palette-empty">No matching tools</div>}
        </div>
      </div>
    </div>
  )
}
