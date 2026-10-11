import { FileText, Home, Menu as MenuIcon, Plus, Search, X } from 'lucide-react'
import { useApp } from '../app/store'
import { activateDocument, closeDocument, openFileDialog } from '../app/actions'
import { useDocState, type DocumentModel } from '../document/DocumentModel'
import { resolveMenus, commandLabel, isCommandEnabled, displayShortcut, runCommand } from '../app/commands'
import { DropdownMenu } from '../ui/Menu'
import type { ContextMenuItem } from '../app/registry'

function Tab({ doc, active }: { doc: DocumentModel; active: boolean }) {
  const title = useDocState(doc, (s) => s.title)
  const dirty = useDocState(doc, (s) => s.dirty)
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`shell-tab ${active ? 'is-active' : ''}`}
      title={doc.state.filePath ?? title}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          void closeDocument(doc)
        } else activateDocument(doc.id)
      }}
    >
      <FileText size={14} className="shell-tab-icon" />
      <span className="shell-tab-title">
        {dirty && <span className="shell-tab-dirty">• </span>}
        {title}
      </span>
      <button
        className="shell-tab-close"
        aria-label={`Close ${title}`}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          void closeDocument(doc)
        }}
      >
        <X size={14} />
      </button>
    </div>
  )
}

/** The hamburger "Menu" with the same structure as the native menu bar. */
function appMenuItems(): ContextMenuItem[] {
  return resolveMenus().map((menu) => ({
    id: `menu-${menu.id}`,
    label: menu.label,
    submenu: menu.groups.flatMap((group, gi) => {
      const items: ContextMenuItem[] = gi > 0 ? [{ id: `${menu.id}-sep-${gi}`, label: '', separator: true }] : []
      const subs = new Map<string, ContextMenuItem>()
      for (const it of group) {
        const cmd = it.command
        const shortcut = Array.isArray(cmd.shortcut) ? cmd.shortcut[0] : cmd.shortcut
        const item: ContextMenuItem = {
          id: cmd.id,
          label: commandLabel(cmd),
          icon: cmd.icon,
          shortcut: shortcut ? displayShortcut(shortcut) : undefined,
          disabled: !isCommandEnabled(cmd),
          run: () => void runCommand(cmd.id)
        }
        if (it.submenu) {
          let sub = subs.get(it.submenu)
          if (!sub) {
            sub = { id: `${menu.id}-${it.submenu}`, label: it.submenu, submenu: [] }
            subs.set(it.submenu, sub)
            items.push(sub)
          }
          sub.submenu!.push(item)
        } else items.push(item)
      }
      return items
    })
  }))
}

export function TopBar() {
  const docs = useApp((s) => s.docs)
  const activeId = useApp((s) => s.activeDocId)
  return (
    <header className="shell-topbar">
      <DropdownMenu
        items={appMenuItems}
        trigger={(p) => (
          <button className="shell-menu-btn" aria-label="Menu" title="Menu" {...p}>
            <MenuIcon size={18} />
            <span>Menu</span>
          </button>
        )}
      />
      <button
        className={`shell-home-btn ${activeId === null ? 'is-active' : ''}`}
        onClick={() => activateDocument(null)}
        title="Home"
      >
        <Home size={16} />
        <span>Home</span>
      </button>
      <div className="shell-tabs" role="tablist">
        {docs.map((d) => (
          <Tab key={d.id} doc={d} active={d.id === activeId} />
        ))}
        <button className="shell-tab-new" title="Open a file (Ctrl+O)" aria-label="Open a file" onClick={() => void openFileDialog()}>
          <Plus size={16} />
        </button>
      </div>
      <button className="shell-search" onClick={() => useApp.setState({ paletteOpen: true })}>
        <Search size={15} />
        <span>Find text or tools</span>
        <kbd>{displayShortcut('Mod+Shift+K')}</kbd>
      </button>
    </header>
  )
}
