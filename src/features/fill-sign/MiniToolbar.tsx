import { useLayoutEffect, useRef, useState } from 'react'
import { AArrowDown, AArrowUp, ChevronDown, Pencil, Trash2 } from 'lucide-react'
import { showContextMenu, type ContextMenuItem, type DocumentModel, type PageGeometry } from '@renderer/sdk'
import {
  FILL_SIGN_COLORS,
  isMarkKind,
  isSignatureKind,
  isTextKind,
  kindLabel,
  MARK_KINDS,
  type FillSignItem,
  type MarkKind,
  type TextKind
} from './shared'
import { changeColor, changeSize, convertItem, deleteItem, startEditing } from './actions'
import { KIND_ICON } from './icons'

const CONVERT_TO: (TextKind | MarkKind)[] = ['text', ...MARK_KINDS]

function ColorDot({ color }: { color: string }) {
  return <span className="fc-fill-sign-colordot" style={{ background: color }} />
}

/** Menu entries shared by the mini toolbar's mark menu and the item context menu. */
export function convertMenu(doc: DocumentModel, item: FillSignItem): ContextMenuItem[] {
  return CONVERT_TO.filter((k) => k !== item.kind).map((k) => ({
    id: `to-${k}`,
    label: k === 'text' ? 'Text' : kindLabel(k),
    icon: KIND_ICON[k],
    run: () => void convertItem(doc, item, k)
  }))
}

export function colorMenu(doc: DocumentModel, item: FillSignItem): ContextMenuItem[] {
  return FILL_SIGN_COLORS.map((c) => ({
    id: `color-${c.value}`,
    label: c.label + (c.value.toLowerCase() === item.color.toLowerCase() ? '  ✓' : ''),
    icon: () => <ColorDot color={c.value} />,
    run: () => void changeColor(doc, item, c.value)
  }))
}

/** Right-click menu for a Fill & Sign item. */
export function itemContextMenu(doc: DocumentModel, item: FillSignItem): ContextMenuItem[] {
  const items: ContextMenuItem[] = []
  if (isTextKind(item.kind)) items.push({ id: 'edit', label: 'Edit Text', icon: Pencil, shortcut: 'Enter', run: () => startEditing(doc, item) })
  items.push(
    { id: 'larger', label: isTextKind(item.kind) ? 'Larger Text' : 'Larger', icon: AArrowUp, shortcut: '+', run: () => void changeSize(doc, item, 1) },
    { id: 'smaller', label: isTextKind(item.kind) ? 'Smaller Text' : 'Smaller', icon: AArrowDown, shortcut: '-', run: () => void changeSize(doc, item, -1) }
  )
  if (!isSignatureKind(item.kind)) {
    items.push({ id: 'convert', label: 'Change To', submenu: convertMenu(doc, item) })
    items.push({ id: 'color', label: 'Colour', submenu: colorMenu(doc, item) })
  }
  items.push({ id: 'sep', label: '', separator: true })
  items.push({ id: 'delete', label: 'Delete', icon: Trash2, shortcut: 'Del', danger: true, run: () => void deleteItem(doc, item) })
  return items.map((i) => ({ ...i, disabled: i.disabled || (item.locked && i.id !== 'sep') }))
}

/**
 * Floating toolbar above the selected Fill & Sign item: smaller/larger, change the mark, colour,
 * delete. Buttons never take focus from the text editor (mouse down is cancelled).
 */
export function MiniToolbar({ doc, geometry, item }: { doc: DocumentModel; geometry: PageGeometry; item: FillSignItem }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(180)
  const c = geometry.rectToCss(item.rect)
  useLayoutEffect(() => {
    if (ref.current) setWidth(ref.current.offsetWidth)
  }, [item.kind])
  const height = 36
  const above = c.top - height - 8
  const top = above >= 2 ? above : Math.min(geometry.cssHeight - height - 2, c.top + c.height + 8)
  const left = Math.max(2, Math.min(c.left, geometry.cssWidth - width - 2))
  const Kind = KIND_ICON[item.kind]
  const openAt = (e: React.MouseEvent, items: ContextMenuItem[]) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    showContextMenu(r.left, r.bottom + 4, items)
  }
  return (
    <div
      ref={ref}
      className="fc-fill-sign-minibar"
      role="toolbar"
      aria-label={`${kindLabel(item.kind)} options`}
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.preventDefault()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        title={isTextKind(item.kind) ? 'Smaller text (-)' : 'Smaller (-)'}
        aria-label={isTextKind(item.kind) ? 'Smaller text' : 'Smaller'}
        disabled={item.locked}
        onClick={() => void changeSize(doc, item, -1)}
      >
        <AArrowDown size={17} />
      </button>
      <button
        type="button"
        title={isTextKind(item.kind) ? 'Larger text (+)' : 'Larger (+)'}
        aria-label={isTextKind(item.kind) ? 'Larger text' : 'Larger'}
        disabled={item.locked}
        onClick={() => void changeSize(doc, item, 1)}
      >
        <AArrowUp size={17} />
      </button>
      {(isTextKind(item.kind) || isMarkKind(item.kind)) && (
        <>
          <span className="fc-fill-sign-minibar-sep" />
          <button
            type="button"
            className="fc-fill-sign-minibar-wide"
            title="Change to another mark"
            aria-label={`Change ${kindLabel(item.kind).toLowerCase()} to another mark`}
            aria-haspopup="menu"
            disabled={item.locked}
            onClick={(e) => openAt(e, convertMenu(doc, item))}
          >
            <Kind size={17} />
            <ChevronDown size={13} />
          </button>
          <button
            type="button"
            className="fc-fill-sign-minibar-wide"
            title="Colour"
            aria-label="Colour"
            aria-haspopup="menu"
            disabled={item.locked}
            onClick={(e) => openAt(e, colorMenu(doc, item))}
          >
            <ColorDot color={item.color} />
            <ChevronDown size={13} />
          </button>
        </>
      )}
      <span className="fc-fill-sign-minibar-sep" />
      <button
        type="button"
        className="is-danger"
        title="Delete (Del)"
        aria-label={`Delete ${kindLabel(item.kind).toLowerCase()}`}
        disabled={item.locked}
        onClick={() => void deleteItem(doc, item)}
      >
        <Trash2 size={17} />
      </button>
    </div>
  )
}
