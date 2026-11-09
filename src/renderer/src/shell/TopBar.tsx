import { useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { FileText, Home, Menu as MenuIcon, Plus, Search, X } from 'lucide-react'
import { insertionIndex, windowChoiceLabels } from '@shared/tabMoves'
import { useApp } from '../app/store'
import { invoke } from '../platform'
import { moveDocument, otherWindows, reorderTab, TAB_MIME, windowId, type TabDragData } from '../app/tabMoves'
import { WINDOW_BOOT } from '../app/boot'
import { showContextMenu } from '../app/ui-services'
import { activateDocument, closeDocument, openFileDialog } from '../app/actions'
import { useDocState, type DocumentModel } from '../document/DocumentModel'
import { resolveMenus, commandContext, commandLabel, isCommandEnabled, displayShortcut, runCommand } from '../app/commands'
import { DropdownMenu } from '../ui/Menu'
import type { CommandDefinition, ContextMenuItem } from '../app/registry'

/** The tab's right-click menu: close, and move to a new or another window. */
async function openTabMenu(doc: DocumentModel, x: number, y: number) {
  const others = windowChoiceLabels(await otherWindows())
  const items: ContextMenuItem[] = [
    { id: 'tab-new-window', label: 'Move to New Window', run: () => void moveDocument(doc, { kind: 'new' }) },
    ...others.map((w) => ({ id: `tab-window-${w.id}`, label: w.label, run: () => void moveDocument(doc, { kind: 'window', windowId: w.id }) })),
    { id: 'tab-sep', label: '', separator: true },
    { id: 'tab-close', label: 'Close', run: () => void closeDocument(doc) }
  ]
  showContextMenu(x, y, items)
}

let ownId: number | null = null
void windowId().then(
  (id) => (ownId = id),
  () => {}
)

function Tab({ doc, active, dropBefore }: { doc: DocumentModel; active: boolean; dropBefore: boolean }) {
  const title = useDocState(doc, (s) => s.title)
  const dirty = useDocState(doc, (s) => s.dirty)
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`shell-tab ${active ? 'is-active' : ''} ${dropBefore ? 'is-drop-before' : ''}`}
      title={doc.state.filePath ?? title}
      data-doc-id={doc.id}
      draggable
      onDragStart={(e) => {
        if (ownId === null) {
          e.preventDefault()
          return
        }
        const data: TabDragData = { windowId: ownId, boot: WINDOW_BOOT, docId: doc.id }
        e.dataTransfer.setData(TAB_MIME, JSON.stringify(data))
        e.dataTransfer.effectAllowed = 'move'
        activateDocument(doc.id)
      }}
      onDragEnd={(e) => {
        // Dropped on a tab strip (this window's or another's): that strip handled it.
        if (e.dataTransfer.dropEffect !== 'none') return
        // Dropped outside: on another window's tab strip, else a new window where it was let go.
        void invoke('window:tabDropDestination').then(
          (target) => target && void moveDocument(doc, target, { closeEmpty: true }),
          () => {}
        )
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        void openTabMenu(doc, e.clientX, e.clientY)
      }}
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

function safeChecked(cmd: CommandDefinition): boolean {
  try {
    return !!cmd.checked?.(commandContext())
  } catch {
    return false
  }
}

/** The hamburger "Menu" with the same structure as the native menu bar, check marks included. */
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
          checked: cmd.checked ? safeChecked(cmd) : undefined,
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
  const strip = useRef<HTMLDivElement>(null)
  /** Where a dragged tab would go (an index in the strip), while one is over it. */
  const [dropAt, setDropAt] = useState<number | null>(null)
  const dropIndex = (e: ReactDragEvent) => {
    const tabs = [...(strip.current?.querySelectorAll<HTMLElement>('.shell-tab') ?? [])].map((t) => {
      const r = t.getBoundingClientRect()
      return { left: r.left, width: r.width }
    })
    return insertionIndex(e.clientX, tabs)
  }
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
      <div
        ref={strip}
        className="shell-tabs"
        role="tablist"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(TAB_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const at = dropIndex(e)
          if (at !== dropAt) setDropAt(at)
        }}
        onDragLeave={(e) => {
          if (!strip.current?.contains(e.relatedTarget as Node | null)) setDropAt(null)
        }}
        onDrop={(e) => {
          setDropAt(null)
          const raw = e.dataTransfer.getData(TAB_MIME)
          if (!raw) return
          e.preventDefault()
          let data: TabDragData
          try {
            data = JSON.parse(raw) as TabDragData
          } catch {
            return
          }
          const at = dropIndex(e)
          if (data.boot === WINDOW_BOOT) reorderTab(data.docId, at)
          else void invoke('window:requestTabMove', data.windowId, data.docId, at)
        }}
      >
        {docs.map((d, i) => (
          <Tab key={d.id} doc={d} active={d.id === activeId} dropBefore={dropAt === i} />
        ))}
        {dropAt === docs.length && <div className="shell-tab-drop-end" aria-hidden />}
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
