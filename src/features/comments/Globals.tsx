/**
 * Always-mounted parts of the comments feature: the floating overlay, the hover pop-up, keyboard
 * nudging, the 'fartcrobat:edit-annotation' listener and preference loading.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { authorName, getActiveDoc, useActiveDoc, useApp, type DocumentModel } from '@renderer/sdk'
import { activeDocOf, editNewAnnotation, nudgeSelection } from './actions'
import { commentColor, commentDate, relativeDate, typeIcon, useMarkedText } from './model'
import { CommentOverlayHost } from './Overlay'
import { threadLabel } from './shared'
import { annotsOf, loadCommentPrefs, pruneDocs, useCommentPrefs, useCommentsUi, useThreads, type HoverInfo } from './state'
import { StatusBadge, TypeBadge } from './widgets'

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true
  if (t.tagName === 'INPUT') return !['checkbox', 'radio', 'button', 'range', 'color'].includes((t as HTMLInputElement).type)
  return false
}

function HoverTipContent({ doc, hover }: { doc: DocumentModel; hover: HoverInfo }) {
  const { threads } = useThreads(doc)
  const t = threads.find((x) => x.root.id === hover.id || x.group.some((g) => g.id === hover.id))
  const quote = useMarkedText(doc, t?.root ?? null)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x: hover.x + 14, y: hover.y + 18 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let x = hover.x + 14
    let y = hover.y + 18
    if (x + r.width > window.innerWidth - 8) x = Math.max(8, hover.x - r.width - 10)
    if (y + r.height > window.innerHeight - 8) y = Math.max(8, hover.y - r.height - 12)
    setPos({ x, y })
  }, [hover.x, hover.y, t?.root.id])
  if (!t) return null
  const a = t.root
  const Icon = typeIcon(a)
  const date = commentDate(a)
  const text = a.contents.trim()
  return (
    <div ref={ref} className="fc-comments-tip" role="tooltip" style={{ left: pos.x, top: pos.y, ['--fc-comment-color' as string]: commentColor(a) }}>
      <div className="fc-comments-tip-head">
        <TypeBadge icon={Icon} color={commentColor(a)} size={20} />
        <div>
          <b>{a.author || 'Unknown author'}</b>
          <span>
            {threadLabel(t)}
            {date ? ` · ${relativeDate(date)}` : ''}
          </span>
        </div>
        <StatusBadge status={t.status} />
      </div>
      {quote && <blockquote className="fc-comments-quote">{quote.length > 160 ? quote.slice(0, 160) + '…' : quote}</blockquote>}
      {text && <p>{text.length > 280 ? text.slice(0, 280) + '…' : text}</p>}
      {!text && !quote && <p className="fc-comments-muted">No note. Double-click to add one.</p>}
      {t.replies.length > 0 && (
        <div className="fc-comments-muted">
          {t.replies.length} {t.replies.length === 1 ? 'reply' : 'replies'}
        </div>
      )}
    </div>
  )
}

function HoverTip() {
  const hover = useCommentsUi((s) => s.hover)
  const dragging = useCommentsUi((s) => s.dragging)
  const popupOpen = useCommentsUi((s) => !!s.hover && s.popups.some((p) => p.docId === s.hover!.docId && p.id === s.hover!.id))
  const enabled = useCommentPrefs((s) => s.hoverPopups)
  const doc = useActiveDoc()
  const [visibleFor, setVisibleFor] = useState<string | null>(null)
  const key = hover ? `${hover.docId}:${hover.id}` : null
  useEffect(() => {
    if (!key) {
      setVisibleFor(null)
      return
    }
    const t = window.setTimeout(() => setVisibleFor(key), 500)
    return () => window.clearTimeout(t)
  }, [key])
  if (!hover || !enabled || dragging || popupOpen || visibleFor !== key || !doc || doc.id !== hover.docId) return null
  return <HoverTipContent doc={doc} hover={hover} />
}

export function CommentsGlobal() {
  const docs = useApp((s) => s.docs)

  useEffect(() => {
    void loadCommentPrefs()
  }, [])

  useEffect(() => {
    pruneDocs(docs.map((d) => d.id))
  }, [docs])

  // Preferences > Commenting > name: new comments in every open document use the new name.
  const authorPref = useApp((s) => s.prefs.authorName)
  const userName = useApp((s) => s.systemInfo?.userName ?? '')
  useEffect(() => {
    const t = window.setTimeout(() => {
      const name = authorName()
      for (const d of useApp.getState().docs) {
        if (d.isClosed) continue
        annotsOf(d)
          .setAuthor(name)
          .catch((err) => !d.isClosed && console.warn('Could not set the comment author', err))
      }
    }, 250)
    return () => window.clearTimeout(t)
  }, [authorPref, userName, docs])

  useEffect(() => {
    const onEdit = (e: Event) => {
      const detail = (e as CustomEvent<{ docId?: string; id?: number; page?: number }>).detail
      if (!detail || typeof detail.id !== 'number') return
      const doc = (detail.docId ? activeDocOf(detail.docId) : null) ?? getActiveDoc()
      if (doc) void editNewAnnotation(doc, detail.id, detail.page ?? doc.state.currentPage)
    }
    window.addEventListener('fartcrobat:edit-annotation', onEdit)
    return () => window.removeEventListener('fartcrobat:edit-annotation', onEdit)
  }, [])

  // Arrow keys nudge selected comments (before the page-turning shortcuts see them).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.key.startsWith('Arrow') || e.altKey || e.ctrlKey || e.metaKey || e.defaultPrevented) return
      if (isTyping(e.target)) return
      const target = e.target as Element | null
      if (target !== document.body && !target?.closest?.('.viewer-scroll')) return
      const app = useApp.getState()
      if (app.dialogs.length || app.paletteOpen || app.contextMenu) return
      const doc = getActiveDoc()
      if (!doc || doc.state.selection.kind !== 'annotations') return
      if (nudgeSelection(doc, e.key, e.shiftKey ? 10 : 1)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <>
      <CommentOverlayHost />
      <HoverTip />
    </>
  )
}
