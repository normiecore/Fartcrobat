import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, CircleCheck, CircleSlash, CircleX, Flag } from 'lucide-react'
import { registerActiveEditor } from '@renderer/sdk'

/**
 * A textarea that grows with its text and saves when it loses focus (Ctrl+Enter saves too,
 * Escape puts the saved text back).
 */
export const AutoTextarea = forwardRef<
  HTMLTextAreaElement,
  {
    value: string
    onCommit: (text: string) => void
    placeholder?: string
    autoFocus?: boolean
    className?: string
    ariaLabel?: string
    maxHeight?: number
    readOnly?: boolean
    /** Called after Escape reverted the text. */
    onEscape?: () => void
  }
>(function AutoTextarea({ value, onCommit, placeholder, autoFocus, className, ariaLabel, maxHeight = 260, readOnly, onEscape }, fwd) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useImperativeHandle(fwd, () => ref.current as HTMLTextAreaElement)
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const skipCommit = useRef(false)
  // While it has the focus, commands, Save and Close save the text first (by taking the focus).
  const unregister = useRef<(() => void) | null>(null)
  useEffect(() => () => unregister.current?.(), [])

  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(maxHeight, el.scrollHeight + 2)}px`
  }, [draft, maxHeight])

  useEffect(() => {
    if (!autoFocus) return
    const el = ref.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [autoFocus])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      ref.current?.blur()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      skipCommit.current = true
      setDraft(value)
      ref.current?.blur()
      onEscape?.()
    }
  }

  return (
    <textarea
      ref={ref}
      className={`fc-comments-textarea ${className ?? ''}`}
      value={draft}
      rows={1}
      readOnly={readOnly}
      placeholder={placeholder}
      aria-label={ariaLabel}
      spellCheck
      onFocus={() => {
        focused.current = true
        unregister.current?.()
        unregister.current = registerActiveEditor({ commit: () => ref.current?.blur() })
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => {
        focused.current = false
        unregister.current?.()
        unregister.current = null
        if (skipCommit.current) {
          skipCommit.current = false
          return
        }
        if (draft !== value) onCommit(draft)
      }}
    />
  )
})

const STATUS_ICONS: Record<string, typeof Check> = {
  Accepted: CircleCheck,
  Completed: Check,
  Rejected: CircleX,
  Cancelled: CircleSlash
}

export function StatusBadge({ status, by }: { status: string | null; by?: string }) {
  if (!status) return null
  const Icon = STATUS_ICONS[status] ?? Flag
  return (
    <span className={`fc-comments-status is-${status.toLowerCase()}`} title={by ? `${status} — set by ${by}` : status}>
      <Icon size={12} />
      {status}
    </span>
  )
}

/** Coloured circle with the comment type icon. */
export function TypeBadge({ icon: Icon, color, size = 26 }: { icon: React.ComponentType<{ size?: number | string }>; color: string; size?: number }) {
  return (
    <span className="fc-comments-typebadge" style={{ width: size, height: size, ['--fc-comment-color' as string]: color }}>
      <Icon size={Math.round(size * 0.55)} />
    </span>
  )
}
