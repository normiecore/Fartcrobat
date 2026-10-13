/**
 * Right panel "Comments": every comment grouped by page, with search, filters, sorting, inline
 * editing, replies, status and checkmarks.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Ellipsis,
  Eye,
  EyeOff,
  FileDown,
  FileUp,
  Funnel,
  MessageSquarePlus,
  MessagesSquare,
  ScrollText,
  Search,
  Square,
  SquareCheck,
  Trash,
  X
} from 'lucide-react'
import type { AnnotInfo } from '@engine/ops/annots'
import {
  Button,
  Checkbox,
  DropdownMenu,
  EmptyState,
  FloatingAt,
  IconButton,
  registry,
  setTool,
  showContextMenu,
  useDocState,
  type ContextMenuItem,
  type DocumentModel
} from '@renderer/sdk'
import {
  commentMenu,
  deleteAllComments,
  exportComments,
  importComments,
  isFiltering,
  navigateComments,
  revealComment,
  setMarked,
  setVisibleThreadIds,
  summarizeComments,
  toggleCommentVisibility,
  updateComment
} from './actions'
import { commentColor, commentDate, fullDate, markedText, relativeDate, typeIcon } from './model'
import { ReplyBox, ReplyItem } from './PopupNote'
import { dateValue, REVIEW_STATES, TEXT_MARKUP, threadLabel } from './shared'
import {
  EMPTY_FILTER,
  setExpanded,
  setFilter,
  toggleExpanded,
  useCommentsUi,
  useThreads,
  type CommentThread,
  type PanelFilter,
  type PanelSort
} from './state'
import { AutoTextarea, StatusBadge, TypeBadge } from './widgets'

/** Text under every text-markup comment (resolved in the background). */
function useQuotes(doc: DocumentModel, threads: CommentThread[]): Record<number, string> {
  const [quotes, setQuotes] = useState<Record<number, string>>({})
  const version = useDocState(doc, (s) => s.docVersion)
  useEffect(() => {
    let alive = true
    const markup = threads.filter((t) => TEXT_MARKUP.has(t.root.type))
    Promise.all(markup.map(async (t) => [t.root.id, await markedText(doc, t.root).catch(() => '')] as const)).then((pairs) => {
      if (alive) setQuotes(Object.fromEntries(pairs))
    })
    return () => {
      alive = false
    }
  }, [doc, threads, version])
  return quotes
}

function matches(t: CommentThread, f: PanelFilter, quote: string): boolean {
  const label = threadLabel(t)
  if (f.types.length && !f.types.includes(label)) return false
  if (f.authors.length && !f.authors.includes(t.root.author || 'Unknown')) return false
  if (f.statuses.length && !f.statuses.includes(t.status ?? 'None')) return false
  if (f.colors.length && !f.colors.includes(commentColor(t.root))) return false
  if (f.checkmark === 'checked' && !t.marked) return false
  if (f.checkmark === 'unchecked' && t.marked) return false
  const q = f.query.trim().toLowerCase()
  if (q) {
    const hay = [label, t.root.author, t.root.contents, t.root.subject, quote, ...t.replies.flatMap((r) => [r.author, r.contents])]
      .join('\n')
      .toLowerCase()
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false
  }
  return true
}

function sortThreads(threads: CommentThread[], sort: PanelSort): CommentThread[] {
  const byPos = (a: CommentThread, b: CommentThread) => a.root.page - b.root.page || a.root.rect[1] - b.root.rect[1] || a.root.rect[0] - b.root.rect[0]
  return [...threads].sort((a, b) => {
    switch (sort) {
      case 'date':
        return dateValue(b.root) - dateValue(a.root) || byPos(a, b)
      case 'author':
        return (a.root.author || '').localeCompare(b.root.author || '') || byPos(a, b)
      case 'type':
        return threadLabel(a).localeCompare(threadLabel(b)) || byPos(a, b)
      case 'color':
        return commentColor(a.root).localeCompare(commentColor(b.root)) || byPos(a, b)
      default:
        return byPos(a, b)
    }
  })
}

function groupKey(doc: DocumentModel, t: CommentThread, sort: PanelSort): string {
  if (sort === 'page') {
    const label = doc.info.pages[t.root.page]?.label ?? String(t.root.page + 1)
    return label === String(t.root.page + 1) ? `Page ${label}` : `Page ${label} (${t.root.page + 1})`
  }
  if (sort === 'author') return t.root.author || 'Unknown author'
  if (sort === 'type') return threadLabel(t)
  return ''
}

const SORTS: { id: PanelSort; label: string }[] = [
  { id: 'page', label: 'Page' },
  { id: 'date', label: 'Date (newest first)' },
  { id: 'author', label: 'Author' },
  { id: 'type', label: 'Type' },
  { id: 'color', label: 'Colour' }
]

function toggle(list: string[], v: string): string[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
}

function FilterPopover({ doc, threads, filter, onClose, at }: { doc: DocumentModel; threads: CommentThread[]; filter: PanelFilter; onClose: () => void; at: { x: number; y: number } }) {
  const types = [...new Set(threads.map(threadLabel))].sort()
  const authors = [...new Set(threads.map((t) => t.root.author || 'Unknown'))].sort()
  const colors = [...new Set(threads.map((t) => commentColor(t.root)))].sort()
  const set = (patch: Partial<PanelFilter>) => setFilter(doc.id, patch)
  const count = (pred: (t: CommentThread) => boolean) => threads.filter(pred).length
  return (
    <FloatingAt x={at.x} y={at.y} onClose={onClose}>
      <div className="fc-comments-filter" role="dialog" aria-label="Filter comments">
        <div className="fc-comments-filter-head">
          <b>Filter comments</b>
          <Button size="sm" variant="quiet" onClick={() => set({ ...EMPTY_FILTER, query: filter.query })}>
            Clear all
          </Button>
        </div>
        <section>
          <h5>Type</h5>
          {types.map((t) => (
            <Checkbox key={t} checked={filter.types.includes(t)} onChange={() => set({ types: toggle(filter.types, t) })} label={`${t} (${count((x) => threadLabel(x) === t)})`} />
          ))}
        </section>
        <section>
          <h5>Author</h5>
          {authors.map((a) => (
            <Checkbox key={a} checked={filter.authors.includes(a)} onChange={() => set({ authors: toggle(filter.authors, a) })} label={`${a} (${count((x) => (x.root.author || 'Unknown') === a)})`} />
          ))}
        </section>
        <section>
          <h5>Status</h5>
          {REVIEW_STATES.map((s) => (
            <Checkbox key={s} checked={filter.statuses.includes(s)} onChange={() => set({ statuses: toggle(filter.statuses, s) })} label={`${s} (${count((x) => (x.status ?? 'None') === s)})`} />
          ))}
        </section>
        <section>
          <h5>Colour</h5>
          <div className="fc-comments-filter-colors">
            {colors.map((c) => (
              <button
                key={c}
                type="button"
                className={`ui-swatch ${filter.colors.includes(c) ? 'is-active' : ''}`}
                style={{ background: c }}
                title={c}
                aria-pressed={filter.colors.includes(c)}
                aria-label={`Colour ${c}`}
                onClick={() => set({ colors: toggle(filter.colors, c) })}
              />
            ))}
          </div>
        </section>
        <section>
          <h5>Checkmark</h5>
          <div className="fc-comments-filter-row">
            {(['any', 'checked', 'unchecked'] as const).map((v) => (
              <button key={v} type="button" className={`fc-comments-chip ${filter.checkmark === v ? 'is-active' : ''}`} onClick={() => set({ checkmark: v })}>
                {v === 'any' ? 'Any' : v === 'checked' ? 'Checked' : 'Not checked'}
              </button>
            ))}
          </div>
        </section>
      </div>
    </FloatingAt>
  )
}

function CommentCard({
  doc,
  thread: t,
  list,
  quote,
  selected,
  expanded,
  onKeyNav
}: {
  doc: DocumentModel
  thread: CommentThread
  list: AnnotInfo[]
  quote: string
  selected: boolean
  expanded: boolean
  onKeyNav: (dir: 1 | -1, from: HTMLElement) => void
}) {
  const a = t.root
  const color = commentColor(a)
  const date = commentDate(a)
  const Icon = typeIcon(a)
  const label = threadLabel(t)
  const open = expanded || selected
  const select = () => {
    revealComment(doc, a, list)
    toggleExpanded(doc.id, a.id, true)
  }
  return (
    <div
      role="listitem"
      tabIndex={0}
      aria-selected={selected}
      aria-label={`${label} by ${a.author || 'unknown author'}`}
      data-comment-id={a.id}
      className={`fc-comments-card ${selected ? 'is-selected' : ''} ${open ? 'is-open' : ''}`}
      style={{ ['--fc-comment-color' as string]: color }}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, textarea, input, a')) return
        select()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        showContextMenu(e.clientX, e.clientY, commentMenu(doc, a, list))
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          select()
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          onKeyNav(e.key === 'ArrowDown' ? 1 : -1, e.currentTarget)
        }
      }}
    >
      <div className="fc-comments-card-head">
        <TypeBadge icon={Icon} color={color} />
        <div className="fc-comments-card-who">
          <b>{a.author || 'Unknown author'}</b>
          <span title={fullDate(date)}>{[label, relativeDate(date)].filter(Boolean).join(' · ')}</span>
        </div>
        <IconButton
          icon={t.marked ? SquareCheck : Square}
          size={15}
          label={t.marked ? 'Remove checkmark' : 'Mark with checkmark'}
          active={t.marked}
          className="fc-comments-check"
          onClick={() => void setMarked(doc, a, !t.marked)}
        />
        <DropdownMenu
          align="right"
          items={() => commentMenu(doc, a, list)}
          trigger={(p) => <IconButton icon={Ellipsis} size={15} label="Comment options" {...p} />}
        />
      </div>
      {(t.status || a.locked) && (
        <div className="fc-comments-card-meta">
          <StatusBadge status={t.status} by={t.statusBy} />
          {a.locked && <span className="fc-comments-locked">Locked</span>}
        </div>
      )}
      {quote && <blockquote className="fc-comments-quote">{quote}</blockquote>}
      {open ? (
        <AutoTextarea
          value={a.contents}
          placeholder="Add a note…"
          ariaLabel="Comment text"
          className="fc-comments-card-text"
          onCommit={(text) => void updateComment(doc, a, { contents: text })}
        />
      ) : (
        a.contents.trim() && <p className="fc-comments-card-preview">{a.contents}</p>
      )}
      {t.replies.length > 0 && !open && (
        <button type="button" className="fc-comments-replies-toggle" onClick={() => toggleExpanded(doc.id, a.id, true)}>
          {t.replies.length} {t.replies.length === 1 ? 'reply' : 'replies'}
        </button>
      )}
      {open && (
        <>
          {t.replies.length > 0 && (
            <div className="fc-comments-replies">
              {t.replies.map((r) => (
                <ReplyItem key={r.id} doc={doc} reply={r} />
              ))}
            </div>
          )}
          <ReplyBox doc={doc} annot={a} />
        </>
      )}
    </div>
  )
}

export function CommentsPanel({ doc }: { doc: DocumentModel }) {
  const { threads, list } = useThreads(doc)
  const show = useDocState(doc, (s) => s.showAnnotations)
  const selection = useDocState(doc, (s) => s.selection)
  const filter = useCommentsUi((s) => s.filters[doc.id] ?? EMPTY_FILTER)
  const sort = useCommentsUi((s) => s.sort)
  const expandedIds = useCommentsUi((s) => s.expanded[doc.id])
  const [filterAt, setFilterAt] = useState<{ x: number; y: number } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const quotes = useQuotes(doc, threads)
  const canAdd = registry.tools.has('comment.note')

  const shown = useMemo(
    () => sortThreads(threads.filter((t) => matches(t, filter, quotes[t.root.id] ?? '')), sort),
    [threads, filter, quotes, sort]
  )
  const filtering = isFiltering(filter)

  useEffect(() => {
    setVisibleThreadIds(
      doc.id,
      shown.map((t) => t.root.id)
    )
  }, [doc, shown])

  // Selecting a comment on the page brings its card into view.
  const selectedRoot = selection.kind === 'annotations' ? threads.find((t) => selection.ids.includes(t.root.id) || t.group.some((g) => selection.ids.includes(g.id)))?.root.id : undefined
  useEffect(() => {
    if (selectedRoot === undefined) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-comment-id="${selectedRoot}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedRoot])

  const expandAll = () => setExpanded(doc.id, threads.map((t) => t.root.id))
  const collapseAll = () => setExpanded(doc.id, [])
  const allOpen = threads.length > 0 && (expandedIds?.length ?? 0) >= threads.length

  const moreItems = (): ContextMenuItem[] => [
    { id: 'expand', label: 'Expand All', icon: ChevronsUpDown, run: expandAll },
    { id: 'collapse', label: 'Collapse All', icon: ChevronsDownUp, run: collapseAll },
    { id: 'sep1', label: '', separator: true },
    { id: 'import', label: 'Import Comments…', icon: FileUp, run: () => void importComments(doc) },
    { id: 'export', label: 'Export Comments to Data File…', icon: FileDown, run: () => void exportComments(doc) },
    { id: 'summary', label: 'Summarize Comments…', icon: ScrollText, run: () => void summarizeComments(doc) },
    { id: 'sep2', label: '', separator: true },
    { id: 'show', label: show ? 'Hide Comments' : 'Show Comments', icon: show ? EyeOff : Eye, run: () => toggleCommentVisibility(doc) },
    { id: 'sep3', label: '', separator: true },
    { id: 'delete', label: 'Delete All Comments…', icon: Trash, danger: true, disabled: !threads.length, run: () => void deleteAllComments(doc) }
  ]

  const sortItems = (): ContextMenuItem[] =>
    SORTS.map((s) => ({ id: s.id, label: s.label, icon: s.id === sort ? Check : undefined, run: () => useCommentsUi.setState({ sort: s.id }) }))

  const keyNav = (dir: 1 | -1, from: HTMLElement) => {
    const cards = [...(listRef.current?.querySelectorAll<HTMLElement>('.fc-comments-card') ?? [])]
    const i = cards.indexOf(from)
    const next = cards[i + dir]
    if (next) {
      next.focus()
      const id = Number(next.dataset.commentId)
      const t = threads.find((x) => x.root.id === id)
      if (t) revealComment(doc, t.root, list)
    }
  }

  let lastGroup = ''
  return (
    <div className="fc-comments-panel">
      <div className="fc-comments-toolbar">
        <label className="fc-comments-search">
          <Search size={14} />
          <input
            type="search"
            placeholder="Search comments"
            aria-label="Search comments"
            value={filter.query}
            onChange={(e) => setFilter(doc.id, { query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter.query) {
                e.stopPropagation()
                setFilter(doc.id, { query: '' })
              }
            }}
          />
          {filter.query && <IconButton icon={X} size={13} label="Clear search" onClick={() => setFilter(doc.id, { query: '' })} />}
        </label>
        <IconButton
          icon={Funnel}
          size={16}
          label="Filter comments"
          active={filtering && !!(filter.types.length || filter.authors.length || filter.statuses.length || filter.colors.length || filter.checkmark !== 'any')}
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            setFilterAt(filterAt ? null : { x: r.right - 260, y: r.bottom + 4 })
          }}
        />
        <DropdownMenu align="right" items={sortItems} trigger={(p) => <IconButton icon={ArrowUpDown} size={16} label="Sort by" {...p} />} />
        <DropdownMenu align="right" items={moreItems} trigger={(p) => <IconButton icon={Ellipsis} size={16} label="More options" {...p} />} />
      </div>
      {filterAt && <FilterPopover doc={doc} threads={threads} filter={filter} at={filterAt} onClose={() => setFilterAt(null)} />}
      <div className="fc-comments-subbar">
        <span className="fc-comments-count" aria-live="polite">
          {filtering ? `${shown.length} of ${threads.length}` : threads.length} {threads.length === 1 ? 'comment' : 'comments'}
        </span>
        {filtering && (
          <button type="button" className="fc-comments-link" onClick={() => setFilter(doc.id, EMPTY_FILTER)}>
            Clear filters
          </button>
        )}
        <span className="fc-comments-spacer" />
        <IconButton icon={ChevronUp} size={15} label="Previous comment" disabled={!threads.length} onClick={() => void navigateComments(doc, -1)} />
        <IconButton icon={ChevronDown} size={15} label="Next comment" disabled={!threads.length} onClick={() => void navigateComments(doc, 1)} />
        <IconButton
          icon={allOpen ? ChevronsDownUp : ChevronsUpDown}
          size={15}
          label={allOpen ? 'Collapse all' : 'Expand all'}
          disabled={!threads.length}
          onClick={allOpen ? collapseAll : expandAll}
        />
      </div>
      {!show && (
        <div className="fc-comments-notice">
          <EyeOff size={14} />
          <span>Comments are hidden on the pages.</span>
          <Button size="sm" variant="quiet" onClick={() => toggleCommentVisibility(doc)}>
            Show
          </Button>
        </div>
      )}
      {canAdd && (
        <button type="button" className="fc-comments-add" onClick={() => setTool('comment.note')}>
          <MessageSquarePlus size={16} />
          Add a sticky note
        </button>
      )}
      <div className="fc-comments-list" role="list" aria-label="Comments" ref={listRef}>
        {!threads.length && (
          <EmptyState icon={MessagesSquare} title="No comments yet">
            Sticky notes, highlights, drawings and other comments appear here. Import comments from an XFDF or FDF file with the ⋯ menu.
          </EmptyState>
        )}
        {threads.length > 0 && !shown.length && (
          <EmptyState icon={Search} title="No matching comments">
            <Button size="sm" onClick={() => setFilter(doc.id, EMPTY_FILTER)}>
              Clear filters
            </Button>
          </EmptyState>
        )}
        {shown.map((t) => {
          const g = groupKey(doc, t, sort)
          const header = g && g !== lastGroup ? g : null
          lastGroup = g
          return (
            <div key={t.root.id} className="fc-comments-item">
              {header && (
                <div className="fc-comments-group">
                  <span>{header}</span>
                  <span>{shown.filter((x) => groupKey(doc, x, sort) === g).length}</span>
                </div>
              )}
              <CommentCard
                doc={doc}
                thread={t}
                list={list}
                quote={quotes[t.root.id] ?? ''}
                selected={selectedRoot === t.root.id}
                expanded={!!expandedIds?.includes(t.root.id)}
                onKeyNav={keyNav}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
