import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import type { ContextMenuItem } from '../app/registry'

/** Open popups, innermost last, each with the number of dialogs that were open when it opened. */
const popups: { close: () => void; dialogs: number }[] = []
const openDialogs = () => document.querySelectorAll('.ui-dialog[aria-modal="true"]').length

/**
 * Escape closes the innermost open popup (menu, submenu, colour picker...) and does nothing else.
 * main.tsx registers this before any other key listener, so neither the features' own Escape
 * handling nor the app's shortcuts (which would drop the current tool) see that key press. A
 * dialog opened over the popup keeps its Escape.
 */
export function handlePopupEscape(e: KeyboardEvent) {
  const top = popups[popups.length - 1]
  if (e.key !== 'Escape' || !top || openDialogs() > top.dialogs) return
  e.preventDefault()
  e.stopImmediatePropagation()
  top.close()
}

/** While `open`, Escape closes this popup (see handlePopupEscape). */
export function usePopupEscape(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useLayoutEffect(() => {
    if (!open) return
    const entry = { close: () => onCloseRef.current(), dialogs: openDialogs() }
    popups.push(entry)
    return () => {
      const i = popups.indexOf(entry)
      if (i >= 0) popups.splice(i, 1)
    }
  }, [open])
}

/** A vertical menu list (used by context menus and dropdowns). */
export function MenuList({ items, onClose }: { items: ContextMenuItem[]; onClose: () => void }) {
  const [openSub, setOpenSub] = useState<string | null>(null)
  return (
    <div className="ui-menu" role="menu">
      {items.map((item, i) =>
        item.separator ? (
          <div key={`sep-${i}`} className="ui-menu-sep" role="separator" />
        ) : (
          <div
            key={item.id}
            className="ui-menu-item-wrap"
            onMouseEnter={() => setOpenSub(item.submenu ? item.id : null)}
          >
            <button
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              className={`ui-menu-item ${item.danger ? 'is-danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                if (item.submenu) {
                  setOpenSub(item.id)
                  return
                }
                onClose()
                item.run?.()
              }}
            >
              <span className="ui-menu-icon">
                {item.checked ? <Check size={16} className="ui-menu-check" /> : item.icon && <item.icon size={16} />}
              </span>
              <span className="ui-menu-label">{item.label}</span>
              {item.shortcut && <span className="ui-menu-shortcut">{item.shortcut}</span>}
              {item.submenu && <ChevronRight size={14} />}
            </button>
            {item.submenu && openSub === item.id && (
              <Submenu items={item.submenu} onClose={onClose} onEscape={() => setOpenSub(null)} />
            )}
          </div>
        )
      )}
    </div>
  )
}

/**
 * A submenu opened to the right of its item. It flips to the left when there is no room on the
 * right and moves up (or scrolls) so it never extends past the bottom of the window. Escape closes
 * only the submenu.
 */
function Submenu({ items, onClose, onEscape }: { items: ContextMenuItem[]; onClose: () => void; onEscape: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' })
  usePopupEscape(true, onEscape)
  useLayoutEffect(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const p = parent.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    const margin = 4
    const next: React.CSSProperties = {}
    if (p.right + r.width > window.innerWidth - margin && p.left - r.width >= margin) {
      next.left = 'auto'
      next.right = '100%'
    }
    const top = p.top - 5
    const maxHeight = window.innerHeight - margin * 2
    if (r.height > maxHeight) {
      next.top = margin - p.top
      next.maxHeight = maxHeight
      next.overflowY = 'auto'
    } else if (top + r.height > window.innerHeight - margin) {
      next.top = window.innerHeight - margin - r.height - p.top
    }
    setStyle(next)
  }, [items])
  return (
    <div ref={ref} className="ui-submenu" style={style}>
      <MenuList items={items} onClose={onClose} />
    </div>
  )
}

/** Positions children at (x, y), flipping to stay inside the window. */
export function FloatingAt({ x, y, children, onClose }: { x: number; y: number; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (nx + r.width > window.innerWidth - 4) nx = Math.max(4, window.innerWidth - r.width - 4)
    if (ny + r.height > window.innerHeight - 4) ny = Math.max(4, y - r.height)
    setPos({ x: nx, y: ny })
  }, [x, y])
  // Closing the menu is all Escape does: not also leave Full Screen or reset the tool.
  usePopupEscape(true, onClose)
  return (
    <>
      <div className="ui-popover-scrim" onMouseDown={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
      <div ref={ref} className="ui-floating" style={{ left: pos.x, top: pos.y }}>
        {children}
      </div>
    </>
  )
}

/** Button that opens a dropdown menu below itself. */
export function DropdownMenu({
  trigger,
  items,
  align = 'left'
}: {
  trigger: (props: { onClick: (e: React.MouseEvent) => void; 'aria-expanded': boolean }) => ReactNode
  items: ContextMenuItem[] | (() => ContextMenuItem[])
  align?: 'left' | 'right'
}) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const resolved = at ? (typeof items === 'function' ? items() : items) : []
  return (
    <>
      {trigger({
        'aria-expanded': !!at,
        onClick: (e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          setAt(at ? null : { x: align === 'left' ? r.left : r.right - 220, y: r.bottom + 4 })
        }
      })}
      {at && (
        <FloatingAt x={at.x} y={at.y} onClose={() => setAt(null)}>
          <MenuList items={resolved} onClose={() => setAt(null)} />
        </FloatingAt>
      )}
    </>
  )
}
