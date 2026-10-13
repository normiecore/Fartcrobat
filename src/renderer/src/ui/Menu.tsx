import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronRight } from 'lucide-react'
import type { ContextMenuItem } from '../app/registry'

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
              <div className="ui-submenu">
                <MenuList items={item.submenu} onClose={onClose} />
              </div>
            )}
          </div>
        )
      )}
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Closing the menu is all Escape does: not also leave Full Screen or reset the tool.
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
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
