/**
 * Acrobat-style pop-up note: a small floating window next to a comment with its text, replies and
 * review status. Draggable by its header, resizable from the corner.
 */
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Ellipsis, Flag, Send, SquareCheck, Trash, X } from 'lucide-react'
import type { AnnotInfo } from '@engine/ops/annots'
import { DropdownMenu, IconButton, type ContextMenuItem, type DocumentModel } from '@renderer/sdk'
import { addReply, commentMenu, deleteComments, setMarked, setStatus, updateComment } from './actions'
import { commentColor, commentDate, fullDate, relativeDate, typeIcon, useMarkedText } from './model'
import { REVIEW_STATES, threadLabel } from './shared'
import { closePopup, raisePopup, updatePopup, type CommentThread, type PopupEntry } from './state'
import { AutoTextarea, TypeBadge } from './widgets'

/** Status button of a pop-up note: shows the review status and sets it (Acrobat's Set Status). */
export function StatusMenu({ doc, thread }: { doc: DocumentModel; thread: CommentThread }) {
  const a = thread.root
  const current = thread.status ?? 'None'
  const items = (): ContextMenuItem[] => [
    ...REVIEW_STATES.map((st) => ({
      id: `status-${st}`,
      label: st,
      icon: st === current ? Check : undefined,
      run: () => void setStatus(doc, a, st)
    })),
    { id: 'sep', label: '', separator: true },
    {
      id: 'mark',
      label: thread.marked ? 'Remove Checkmark' : 'Mark with Checkmark',
      icon: SquareCheck,
      run: () => void setMarked(doc, a, !thread.marked)
    }
  ]
  return (
    <DropdownMenu
      align="right"
      items={items}
      trigger={(p) => (
        <button
          type="button"
          className={`fc-comments-statusbtn ${thread.status ? `is-${thread.status.toLowerCase()}` : ''}`}
          aria-label={thread.status ? `Status: ${thread.status}. Set status` : 'Set status'}
          aria-haspopup="menu"
          title={thread.status ? `${thread.status}${thread.statusBy ? ` — set by ${thread.statusBy}` : ''}. Click to change.` : 'Set status'}
          {...p}
        >
          {thread.marked && <SquareCheck size={13} />}
          {thread.status ? <span>{thread.status}</span> : <Flag size={13} />}
          <ChevronDown size={12} />
        </button>
      )}
    />
  )
}

export function ReplyItem({ doc, reply }: { doc: DocumentModel; reply: AnnotInfo }) {
  const date = commentDate(reply)
  return (
    <div className="fc-comments-reply" data-reply-id={reply.id}>
      <div className="fc-comments-reply-head">
        <b>{reply.author || 'Unknown author'}</b>
        <span title={fullDate(date)}>{relativeDate(date)}</span>
        <IconButton
          icon={Trash}
          size={13}
          label="Delete reply"
          className="fc-comments-reply-delete"
          onClick={() => void deleteComments(doc, reply.page, [reply.id])}
        />
      </div>
      <AutoTextarea
        value={reply.contents}
        ariaLabel={`Reply from ${reply.author || 'unknown author'}`}
        className="fc-comments-reply-text"
        onCommit={(t) => void updateComment(doc, reply, { contents: t })}
      />
    </div>
  )
}

export function ReplyBox({ doc, annot, autoFocus }: { doc: DocumentModel; annot: AnnotInfo; autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true })
  }, [autoFocus])
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(160, el.scrollHeight + 2)}px`
  }, [text])
  const post = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    if (await addReply(doc, annot, text)) setText('')
    setBusy(false)
    ref.current?.focus({ preventScroll: true })
  }
  return (
    <div className="fc-comments-replybox">
      <textarea
        ref={ref}
        rows={1}
        className="fc-comments-textarea"
        placeholder="Reply…"
        aria-label="Reply"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void post()
          } else if (e.key === 'Escape') {
            e.stopPropagation()
            e.preventDefault()
            setText('')
            ref.current?.blur()
          }
        }}
      />
      <IconButton icon={Send} label="Post reply" size={16} disabled={!text.trim() || busy} onClick={() => void post()} className="fc-comments-post" />
    </div>
  )
}

export function PopupNote({
  doc,
  entry,
  thread,
  list,
  left,
  top,
  toPagePos
}: {
  doc: DocumentModel
  entry: PopupEntry
  thread: CommentThread
  list: AnnotInfo[]
  left: number
  top: number
  /** Converts an overlay position into the stored page-space position. */
  toPagePos: (left: number, top: number) => [number, number]
}) {
  const a = thread.root
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const [size, setSize] = useState<{ w: number; h: number | null }>({ w: entry.width, h: entry.height })
  const quote = useMarkedText(doc, a)

  // Remember where the note first opened (in page space), so it stays next to the comment while
  // the document scrolls and zooms instead of following the visible area around.
  useEffect(() => {
    if (!entry.pos) updatePopup(doc.id, a.id, { pos: toPagePos(left, top) })
  }, [doc.id, a.id, entry.pos, left, top, toPagePos])
  const color = commentColor(a)
  const date = commentDate(a)
  const Icon = typeIcon(a)
  const label = threadLabel(thread)

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    raisePopup(doc.id, a.id)
    const sx = e.clientX
    const sy = e.clientY
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => setDrag({ dx: ev.clientX - sx, dy: ev.clientY - sy })
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      setDrag(null)
      updatePopup(doc.id, a.id, { pos: toPagePos(left + ev.clientX - sx, top + ev.clientY - sy) })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const box = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect()
    const sx = e.clientX
    const sy = e.clientY
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    let last = { w: box.width, h: box.height as number | null }
    const move = (ev: PointerEvent) => {
      last = { w: Math.max(220, box.width + ev.clientX - sx), h: Math.max(140, box.height + ev.clientY - sy) }
      setSize(last)
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      updatePopup(doc.id, a.id, { width: last.w, height: last.h })
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  return (
    <div
      className="fc-comments-popup"
      role="dialog"
      aria-label={`${label} by ${a.author || 'unknown author'}`}
      data-popup-id={a.id}
      style={{
        left: left + (drag?.dx ?? 0),
        top: top + (drag?.dy ?? 0),
        width: size.w,
        height: size.h ?? undefined,
        zIndex: 10 + entry.z,
        ['--fc-comment-color' as string]: color
      }}
      onPointerDown={(e) => {
        e.stopPropagation()
        raisePopup(doc.id, a.id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target as HTMLElement).matches('textarea, input')) {
          e.stopPropagation()
          closePopup(doc.id, a.id)
        }
      }}
    >
      <div className="fc-comments-popup-header" onPointerDown={startMove}>
        <TypeBadge icon={Icon} color={color} size={24} />
        <div className="fc-comments-popup-who">
          <b>{a.author || 'Unknown author'}</b>
          <span title={fullDate(date)}>
            {label}
            {date ? ` · ${relativeDate(date)}` : ''}
          </span>
        </div>
        <StatusMenu doc={doc} thread={thread} />
        <DropdownMenu
          align="right"
          items={() => commentMenu(doc, a, list).filter((i) => i.id !== 'open')}
          trigger={(p) => <IconButton icon={Ellipsis} label="More options" size={16} {...p} />}
        />
        <IconButton icon={X} label="Close pop-up note" size={16} onClick={() => closePopup(doc.id, a.id)} />
      </div>
      <div className="fc-comments-popup-body">
        {quote && <blockquote className="fc-comments-quote">{quote}</blockquote>}
        <AutoTextarea
          value={a.contents}
          placeholder="Add a note…"
          ariaLabel="Comment text"
          autoFocus={entry.focus === 'contents'}
          className="fc-comments-popup-text"
          onCommit={(t) => void updateComment(doc, a, { contents: t })}
        />
        {thread.replies.length > 0 && (
          <div className="fc-comments-replies">
            {thread.replies.map((r) => (
              <ReplyItem key={r.id} doc={doc} reply={r} />
            ))}
          </div>
        )}
        <ReplyBox doc={doc} annot={a} autoFocus={entry.focus === 'reply'} />
      </div>
      <div className="fc-comments-popup-resize" onPointerDown={startResize} aria-hidden />
    </div>
  )
}
