import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Bookmark as BookmarkIcon,
  BookmarkPlus,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Crosshair,
  ExternalLink,
  MoreHorizontal,
  Pencil,
  Settings2,
  Trash2
} from 'lucide-react'
import {
  Button,
  Checkbox,
  ColorPicker,
  Dialog,
  displayShortcut,
  DropdownMenu,
  EmptyState,
  Field,
  followExternalLink,
  IconButton,
  openDialog,
  showContextMenu,
  showError,
  TextInput,
  toast,
  useDocState,
  type ContextMenuItem,
  type DocumentModel
} from '@renderer/sdk'
import { addBookmarkForCurrentView, currentViewTarget, goToDest, navOps, undoToast } from './actions'
import {
  ancestorsOf,
  computeMove,
  currentBookmarkId,
  flattenVisible,
  initiallyOpen,
  isNoopMove,
  locate,
  parentIds,
  visibleRowFor,
  type DropPosition,
  type FlatRow
} from './outlineModel'
import { setBookmarkUi, useBookmarkUi, type BookmarkUiState } from './state'
import type { Bookmark } from './types'

export const BOOKMARK_ROW_HEIGHT = 28
const INDENT = 16
const LIST_PADDING = 4

const EMPTY_UI: BookmarkUiState = { expanded: new Set(), initialized: false, selected: null, editing: null }

interface DropState {
  draggedId: number
  /** Row index the pointer is over, or -1 for "below the last row". */
  row: number
  position: DropPosition
  valid: boolean
  x: number
  y: number
}

function RenameInput({ initial, onDone }: { initial: string; onDone: (value: string | null) => void }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (v: string | null) => {
    if (done.current) return
    done.current = true
    onDone(v)
  }
  return (
    <input
      ref={ref}
      className="ui-input fc-navigation-bm-input"
      aria-label="Bookmark name"
      defaultValue={initial}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          e.preventDefault()
          finish(e.currentTarget.value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          finish(null)
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  )
}

function BookmarkPropertiesDialog({ doc, bookmark, close }: { doc: DocumentModel; bookmark: Bookmark; close: () => void }) {
  const [title, setTitle] = useState(bookmark.title)
  const [bold, setBold] = useState(bookmark.bold)
  const [italic, setItalic] = useState(bookmark.italic)
  const [color, setColor] = useState<string | null>(bookmark.color)
  const [useCurrentView, setUseCurrentView] = useState(false)
  const apply = async () => {
    try {
      const ops = navOps(doc)
      if (title.trim() && title.trim() !== bookmark.title) await ops.renameBookmark(bookmark.id, title.trim())
      if (bold !== bookmark.bold || italic !== bookmark.italic || color !== bookmark.color) {
        await ops.setBookmarkStyle(bookmark.id, { bold, italic, color })
      }
      if (useCurrentView) await ops.setBookmarkDestination(bookmark.id, currentViewTarget(doc))
      close()
    } catch (err) {
      showError(err, 'Could not change the bookmark')
    }
  }
  const dest = bookmark.dest
  return (
    <Dialog
      title="Bookmark Properties"
      onClose={close}
      onSubmit={() => void apply()}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void apply()}>
            OK
          </Button>
        </>
      }
    >
      <div className="fc-navigation-bm-props">
        <Field label="Name">
          <TextInput data-autofocus value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="fc-navigation-bm-props-row">
          <span className="ui-field-label">Style</span>
          <Checkbox checked={bold} onChange={setBold} label="Bold" />
          <Checkbox checked={italic} onChange={setItalic} label="Italic" />
        </div>
        <div className="ui-field">
          <span className="ui-field-label">Colour</span>
          <ColorPicker value={color} onChange={setColor} allowNone />
        </div>
        <div className="ui-field">
          <span className="ui-field-label">Destination</span>
          <span>
            {dest
              ? `Page ${dest.page + 1}${dest.zoom ? `, ${Math.round(dest.zoom * 100)}% zoom` : ''}`
              : bookmark.uri
                ? bookmark.uri
                : 'None'}
          </span>
          <Checkbox
            checked={useCurrentView}
            onChange={setUseCurrentView}
            label={`Change to the current view (page ${doc.state.currentPage + 1})`}
          />
        </div>
      </div>
    </Dialog>
  )
}

export function BookmarksPanel({ doc }: { doc: DocumentModel }) {
  const docVersion = useDocState(doc, (s) => s.docVersion)
  const currentPage = useDocState(doc, (s) => s.currentPage)
  const ui = useBookmarkUi((s) => s.byDoc[doc.id]) ?? EMPTY_UI
  const [tree, setTree] = useState<Bookmark[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropState | null>(null)
  const dropRef = useRef<DropState | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const suppressClick = useRef(false)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })

  useEffect(() => {
    let alive = true
    navOps(doc)
      .outline()
      .then((t) => {
        if (!alive) return
        setTree(t)
        setLoadError(null)
        const st = useBookmarkUi.getState().byDoc[doc.id]
        if (!st?.initialized) setBookmarkUi(doc.id, { expanded: new Set(initiallyOpen(t)), initialized: true })
      })
      .catch((err) => {
        if (alive) setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [doc, docVersion])

  const rows: FlatRow[] = useMemo(() => (tree ? flattenVisible(tree, ui.expanded) : []), [tree, ui.expanded])
  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r.bookmark.id, i])), [rows])
  const currentId = useMemo(() => {
    if (!tree) return null
    const id = currentBookmarkId(tree, currentPage)
    return id === null ? null : visibleRowFor(tree, id, ui.expanded)
  }, [tree, currentPage, ui.expanded])
  const selected = ui.selected !== null && rowIndex.has(ui.selected) ? ui.selected : null

  // Rows have a fixed height, so only the ones near the viewport are rendered.
  const hasList = !!tree && tree.length > 0
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [hasList])
  const visibleRows = useMemo(() => {
    const first = Math.max(0, Math.floor((viewport.top - LIST_PADDING) / BOOKMARK_ROW_HEIGHT) - 15)
    const last = Math.min(rows.length - 1, Math.ceil((viewport.top + viewport.height) / BOOKMARK_ROW_HEIGHT) + 15)
    const set = new Set<number>()
    for (let i = first; i <= last; i++) set.add(i)
    for (const id of [ui.selected, ui.editing]) {
      const i = id === null ? undefined : rowIndex.get(id)
      if (i !== undefined) set.add(i)
    }
    return [...set].sort((a, b) => a - b)
  }, [viewport, rows.length, rowIndex, ui.selected, ui.editing])

  // Scroll the selected/edited row into view.
  useEffect(() => {
    const id = ui.editing ?? ui.selected
    if (id === null) return
    const i = rowIndex.get(id)
    const el = listRef.current
    if (i === undefined || !el) return
    const top = LIST_PADDING + i * BOOKMARK_ROW_HEIGHT
    if (top < el.scrollTop) el.scrollTop = top - 4
    else if (top + BOOKMARK_ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + BOOKMARK_ROW_HEIGHT - el.clientHeight + 4
  }, [ui.editing, ui.selected, rowIndex])

  // When a new bookmark is being renamed but sits inside a collapsed parent, open the parents.
  useEffect(() => {
    if (!tree || ui.editing === null || rowIndex.has(ui.editing)) return
    const chain = ancestorsOf(tree, ui.editing)
    if (chain.length) setBookmarkUi(doc.id, (s) => ({ expanded: new Set([...s.expanded, ...chain]) }))
  }, [tree, ui.editing, rowIndex, doc.id])

  const set = (patch: Partial<BookmarkUiState> | ((s: BookmarkUiState) => Partial<BookmarkUiState>)) => setBookmarkUi(doc.id, patch)

  const toggle = (id: number, open?: boolean) =>
    set((s) => {
      const expanded = new Set(s.expanded)
      const next = open ?? !expanded.has(id)
      if (next) expanded.add(id)
      else expanded.delete(id)
      return { expanded }
    })

  const focusList = () => listRef.current?.focus({ preventScroll: true })

  const activate = (b: Bookmark) => {
    set({ selected: b.id })
    if (b.dest) void goToDest(doc, b.dest)
    else if (b.uri) void followExternalLink(b.uri)
    else toast('This bookmark has no destination in this document.', { kind: 'warning' })
  }

  const commitRename = async (id: number, value: string | null) => {
    set({ editing: null })
    focusList()
    if (value === null || !tree) return
    const b = locate(tree, id)?.bookmark
    const v = value.replace(/\s+/g, ' ').trim()
    if (!b || !v || v === b.title) return
    try {
      await navOps(doc).renameBookmark(id, v)
    } catch (err) {
      showError(err, 'Could not rename the bookmark')
    }
  }

  const remove = async (id: number) => {
    if (!tree) return
    const i = rowIndex.get(id)
    const b = locate(tree, id)?.bookmark
    try {
      await navOps(doc).deleteBookmarks([id])
      const next = i !== undefined ? (rows[i + 1 + countVisibleDescendants(rows, i)] ?? rows[i - 1]) : undefined
      set({ selected: next ? next.bookmark.id : null })
      const extra = b && b.children.length ? ' and the bookmarks under it' : ''
      undoToast(doc, `Deleted “${b?.title ?? 'bookmark'}”${extra}`)
    } catch (err) {
      showError(err, 'Could not delete the bookmark')
    }
  }

  const setDestination = async (b: Bookmark) => {
    try {
      const target = currentViewTarget(doc)
      await navOps(doc).setBookmarkDestination(b.id, target)
      toast(`“${b.title}” now goes to page ${target.page + 1}.`, { kind: 'success' })
    } catch (err) {
      showError(err, 'Could not set the destination')
    }
  }

  const canExpand = !!tree && parentIds(tree).some((id) => !ui.expanded.has(id))
  const canCollapse = rows.some((r) => r.expanded)
  const expandAll = () => tree && set({ expanded: new Set(parentIds(tree)) })
  const collapseAll = () => set({ expanded: new Set() })

  const menuFor = (b: Bookmark | null): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [
      {
        id: 'new',
        label: 'New Bookmark',
        icon: BookmarkPlus,
        shortcut: displayShortcut('Mod+B'),
        run: () => void addBookmarkForCurrentView(doc)
      }
    ]
    if (b) {
      items.push(
        { id: 'child', label: 'New Child Bookmark', run: () => void addBookmarkForCurrentView(doc, { asChildOf: b.id }) },
        { id: 'sep1', label: '', separator: true },
        { id: 'rename', label: 'Rename', icon: Pencil, shortcut: 'F2', run: () => set({ selected: b.id, editing: b.id }) },
        { id: 'dest', label: 'Set Destination', icon: Crosshair, run: () => void setDestination(b) },
        {
          id: 'props',
          label: 'Properties…',
          icon: Settings2,
          run: () => void openDialog((close) => <BookmarkPropertiesDialog doc={doc} bookmark={b} close={() => close()} />)
        },
        { id: 'sep2', label: '', separator: true },
        { id: 'delete', label: 'Delete', icon: Trash2, shortcut: 'Del', danger: true, run: () => void remove(b.id) }
      )
    }
    items.push(
      { id: 'sep3', label: '', separator: true },
      { id: 'expand', label: 'Expand All', icon: ChevronsUpDown, disabled: !canExpand, run: expandAll },
      { id: 'collapse', label: 'Collapse All', icon: ChevronsDownUp, disabled: !canCollapse, run: collapseAll }
    )
    return items
  }

  const openMenu = (b: Bookmark | null, x: number, y: number) => {
    if (b) set({ selected: b.id })
    showContextMenu(x, y, menuFor(b))
  }

  // ---- keyboard ---------------------------------------------------------------------------------

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== listRef.current || !rows.length) return
    const i = selected !== null ? (rowIndex.get(selected) ?? -1) : -1
    const row = i >= 0 ? rows[i] : null
    const select = (k: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, k))]
      if (r) set({ selected: r.bookmark.id })
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        select(i + 1)
        break
      case 'ArrowUp':
        e.preventDefault()
        select(i < 0 ? rows.length - 1 : i - 1)
        break
      case 'Home':
        e.preventDefault()
        select(0)
        break
      case 'End':
        e.preventDefault()
        select(rows.length - 1)
        break
      case 'ArrowRight':
        e.preventDefault()
        if (!row) select(0)
        else if (row.hasChildren && !row.expanded) toggle(row.bookmark.id, true)
        else if (row.expanded) select(i + 1)
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (row?.expanded) toggle(row.bookmark.id, false)
        else if (row?.parentId !== null && row?.parentId !== undefined) set({ selected: row.parentId })
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        if (row) activate(row.bookmark)
        break
      case 'F2':
        e.preventDefault()
        if (row) set({ editing: row.bookmark.id })
        break
      case 'Delete':
      case 'Backspace':
        e.preventDefault()
        e.stopPropagation()
        if (row) void remove(row.bookmark.id)
        break
      case 'ContextMenu':
      case 'F10': {
        if (e.key === 'F10' && !e.shiftKey) return
        e.preventDefault()
        const r = listRef.current!.getBoundingClientRect()
        openMenu(row?.bookmark ?? null, r.left + 40, r.top + LIST_PADDING + Math.max(0, i) * BOOKMARK_ROW_HEIGHT - listRef.current!.scrollTop + 24)
        break
      }
    }
  }

  // ---- drag & drop ------------------------------------------------------------------------------

  const hitRow = (clientY: number): { row: number; position: DropPosition } => {
    const el = listRef.current!
    const r = el.getBoundingClientRect()
    const y = clientY - r.top + el.scrollTop - LIST_PADDING
    const i = Math.floor(y / BOOKMARK_ROW_HEIGHT)
    if (i < 0) return { row: 0, position: 'before' }
    if (i >= rows.length) return { row: -1, position: 'after' }
    const f = (y - i * BOOKMARK_ROW_HEIGHT) / BOOKMARK_ROW_HEIGHT
    return { row: i, position: f < 0.3 ? 'before' : f > 0.7 ? 'after' : 'inside' }
  }

  const moveFor = (draggedId: number, row: number, position: DropPosition) => {
    if (!tree) return null
    if (row < 0) {
      const top = tree.filter((b) => b.id !== draggedId)
      return { parentId: null, index: top.length }
    }
    return computeMove(tree, draggedId, rows[row].bookmark.id, position, ui.expanded)
  }

  const startDrag = (e: React.PointerEvent, b: Bookmark) => {
    if (e.button !== 0 || ui.editing !== null) return
    const sx = e.clientX
    const sy = e.clientY
    let raf = 0
    let lastY = sy
    const update = (x: number, y: number) => {
      const { row, position } = hitRow(y)
      const move = moveFor(b.id, row, position)
      const valid = !!move && !!tree && !isNoopMove(tree, b.id, move)
      const next = { draggedId: b.id, row, position, valid, x, y }
      dropRef.current = next
      setDrop(next)
    }
    const tick = () => {
      const el = listRef.current
      if (!el || !dropRef.current) return
      const r = el.getBoundingClientRect()
      if (lastY < r.top + 28) el.scrollTop -= 6
      else if (lastY > r.bottom - 28) el.scrollTop += 6
      raf = requestAnimationFrame(tick)
    }
    const move = (ev: PointerEvent) => {
      lastY = ev.clientY
      if (!dropRef.current && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return
      if (!dropRef.current) raf = requestAnimationFrame(tick)
      update(ev.clientX, ev.clientY)
    }
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', esc, true)
      cancelAnimationFrame(raf)
      const d = dropRef.current
      dropRef.current = null
      setDrop(null)
      if (!d) return
      suppressClick.current = true
      setTimeout(() => (suppressClick.current = false), 0)
      if (!commit || !d.valid) return
      const m = moveFor(d.draggedId, d.row, d.position)
      if (!m) return
      void navOps(doc)
        .moveBookmark(d.draggedId, m.parentId, m.index)
        .then(() => {
          set((s) => {
            const expanded = new Set(s.expanded)
            if (m.parentId !== null) expanded.add(m.parentId)
            return { selected: d.draggedId, expanded }
          })
        })
        .catch((err) => showError(err, 'Could not move the bookmark'))
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && dropRef.current) {
        ev.preventDefault()
        ev.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('keydown', esc, true)
  }

  // Drop indicator geometry.
  let indicator: { top: number; left: number; inside: boolean } | null = null
  if (drop && drop.valid) {
    if (drop.row < 0) indicator = { top: LIST_PADDING + rows.length * BOOKMARK_ROW_HEIGHT, left: 8, inside: false }
    else {
      const r = rows[drop.row]
      const top = LIST_PADDING + drop.row * BOOKMARK_ROW_HEIGHT
      if (drop.position === 'inside') indicator = { top, left: 0, inside: true }
      else {
        const depth = drop.position === 'after' && r.expanded ? r.depth + 1 : r.depth
        indicator = { top: drop.position === 'before' ? top : top + BOOKMARK_ROW_HEIGHT, left: 8 + depth * INDENT + 18, inside: false }
      }
    }
  }

  const dragged = drop && tree ? locate(tree, drop.draggedId)?.bookmark : null

  return (
    <div className="fc-navigation-panel fc-navigation-bookmarks">
      <div className="fc-navigation-toolbar" role="toolbar" aria-label="Bookmark actions">
        <IconButton
          icon={BookmarkPlus}
          label="New bookmark"
          shortcut={displayShortcut('Mod+B')}
          onClick={() => void addBookmarkForCurrentView(doc)}
        />
        <IconButton
          icon={Trash2}
          label="Delete bookmark"
          disabled={selected === null}
          onClick={() => selected !== null && void remove(selected)}
        />
        <IconButton icon={ChevronsUpDown} label="Expand all" disabled={!canExpand} onClick={expandAll} />
        <IconButton icon={ChevronsDownUp} label="Collapse all" disabled={!canCollapse} onClick={collapseAll} />
        <span className="fc-navigation-toolbar-spacer" />
        <DropdownMenu
          align="right"
          items={() => menuFor(selected !== null && tree ? (locate(tree, selected)?.bookmark ?? null) : null)}
          trigger={(p) => <IconButton icon={MoreHorizontal} label="Bookmark options" {...p} />}
        />
      </div>
      {loadError ? (
        <EmptyState icon={BookmarkIcon} title="Bookmarks could not be read">
          {loadError}
        </EmptyState>
      ) : tree === null ? (
        <div className="fc-navigation-loading">Loading bookmarks…</div>
      ) : !tree.length ? (
        <EmptyState icon={BookmarkIcon} title="No bookmarks yet">
          <p>Bookmarks let readers jump straight to a section.</p>
          <Button variant="primary" icon={BookmarkPlus} onClick={() => void addBookmarkForCurrentView(doc)}>
            Bookmark this page
          </Button>
          <p className="fc-navigation-hint">
            Tip: select text first and press {displayShortcut('Mod+B')} to use it as the bookmark name.
          </p>
        </EmptyState>
      ) : (
        <div
          ref={listRef}
          className={`fc-navigation-tree ${drop ? 'is-dragging' : ''}`}
          role="tree"
          aria-label="Bookmarks"
          tabIndex={0}
          aria-activedescendant={selected !== null ? `fc-navigation-bm-${doc.id}-${selected}` : undefined}
          onKeyDown={onKeyDown}
          onScroll={(e) => setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })}
          onFocus={(e) => {
            if (e.target === listRef.current && selected === null && rows.length && currentId !== null) set({ selected: currentId })
          }}
          onContextMenu={(e) => {
            if (e.target === listRef.current) {
              e.preventDefault()
              openMenu(null, e.clientX, e.clientY)
            }
          }}
        >
          <div className="fc-navigation-tree-content" style={{ height: rows.length * BOOKMARK_ROW_HEIGHT + LIST_PADDING * 2 + 24 }}>
            {visibleRows.map((i) => {
              const r = rows[i]
              const b = r.bookmark
              const isSel = b.id === selected
              const editing = ui.editing === b.id
              const style: React.CSSProperties = { top: LIST_PADDING + i * BOOKMARK_ROW_HEIGHT, paddingLeft: 4 + r.depth * INDENT }
              const titleStyle: React.CSSProperties & Record<string, string> = {}
              if (b.color) titleStyle['--fc-navigation-bm-color'] = b.color
              return (
                <div
                  key={b.id}
                  id={`fc-navigation-bm-${doc.id}-${b.id}`}
                  role="treeitem"
                  aria-label={b.title || 'Untitled'}
                  aria-level={r.depth + 1}
                  aria-expanded={r.hasChildren ? r.expanded : undefined}
                  aria-selected={isSel}
                  className={`fc-navigation-bm-row ${isSel ? 'is-selected' : ''} ${b.id === currentId ? 'is-current' : ''} ${
                    drop?.draggedId === b.id ? 'is-dragged' : ''
                  } ${indicator?.inside && drop?.row === i ? 'is-drop-inside' : ''}`}
                  style={style}
                  title={b.dest ? `${b.title} — page ${b.dest.page + 1}` : b.uri ? `${b.title} — ${b.uri}` : b.title}
                  onPointerDown={(e) => startDrag(e, b)}
                  onClick={() => {
                    if (suppressClick.current || editing) return
                    activate(b)
                    focusList()
                  }}
                  onDoubleClick={() => set({ selected: b.id, editing: b.id })}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    openMenu(b, e.clientX, e.clientY)
                  }}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    className={`fc-navigation-bm-chevron ${r.hasChildren ? '' : 'is-leaf'}`}
                    title={r.hasChildren ? (r.expanded ? 'Collapse' : 'Expand') : undefined}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (r.hasChildren) toggle(b.id)
                    }}
                  >
                    {r.hasChildren && (r.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)}
                  </button>
                  {b.uri && !b.dest ? (
                    <ExternalLink size={14} className="fc-navigation-bm-icon" aria-hidden="true" />
                  ) : (
                    <BookmarkIcon size={14} className="fc-navigation-bm-icon" aria-hidden="true" />
                  )}
                  {editing ? (
                    <RenameInput initial={b.title} onDone={(v) => void commitRename(b.id, v)} />
                  ) : (
                    <span
                      className={`fc-navigation-bm-title ${b.color ? 'has-color' : ''}`}
                      style={{ ...titleStyle, fontWeight: b.bold ? 700 : undefined, fontStyle: b.italic ? 'italic' : undefined }}
                    >
                      {b.title || 'Untitled'}
                    </span>
                  )}
                </div>
              )
            })}
            {indicator && !indicator.inside && (
              <div className="fc-navigation-drop-line" style={{ top: indicator.top - 1, left: indicator.left }} aria-hidden="true" />
            )}
          </div>
        </div>
      )}
      {drop && dragged && (
        <div className="fc-navigation-drag-ghost" style={{ left: drop.x + 14, top: drop.y + 10 }} aria-hidden="true">
          {dragged.title}
        </div>
      )}
    </div>
  )
}

function countVisibleDescendants(rows: FlatRow[], i: number): number {
  const depth = rows[i].depth
  let k = i + 1
  while (k < rows.length && rows[k].depth > depth) k++
  return k - i - 1
}
