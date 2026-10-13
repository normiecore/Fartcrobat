import { useEffect, useRef, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'

export interface DialogProps {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number | string
  /** Submit handler for Enter key inside inputs. */
  onSubmit?: () => void
  className?: string
}

const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]'

/** Elements of `root` that Tab can reach, in order. */
function tabbable(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)].filter((el) => el.getClientRects().length > 0)
}

/** True for the dialog shown on top (dialogs stack in the order they opened). */
function isTopmost(el: HTMLElement): boolean {
  const all = document.querySelectorAll('.ui-dialog[aria-modal="true"]')
  return all[all.length - 1] === el
}

/** Keeps Tab inside `el`; returns true when it moved the focus itself. */
function trapTab(el: HTMLElement, backwards: boolean): boolean {
  const items = tabbable(el)
  const active = document.activeElement
  if (!items.length) {
    el.focus()
    return true
  }
  const first = items[0]
  const last = items[items.length - 1]
  if (!active || !el.contains(active)) {
    ;(backwards ? last : first).focus()
    return true
  }
  if (backwards && (active === first || active === el)) {
    last.focus()
    return true
  }
  if (!backwards && active === last) {
    first.focus()
    return true
  }
  return false
}

/**
 * Modal dialog frame. Render it from openDialog(close => <Dialog ...>). It takes the focus
 * (the first field, else the primary button, else the first button that is not destructive),
 * keeps Tab inside, closes with Escape and gives the focus back when it closes.
 */
export function Dialog({ title, onClose, children, footer, width = 480, onSubmit, className }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Read while rendering, before this dialog takes the focus.
  const [previousFocus] = useState(() => document.activeElement)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const initial =
      el.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button.ui-btn-primary:not([disabled])') ??
      // Destructive confirmations default to the safe choice, never to the danger button.
      [...el.querySelectorAll<HTMLElement>('.ui-dialog-footer button:not([disabled])')].find(
        (b) => !b.classList.contains('ui-btn-danger')
      ) ??
      el
    initial.focus()
    // Keys pressed while the focus is lost (on the page body) still belong to the top dialog.
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !isTopmost(el) || el.contains(document.activeElement)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
      } else if (e.key === 'Tab') {
        e.preventDefault()
        trapTab(el, e.shiftKey)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      const active = document.activeElement
      const lost = !active || active === document.body || !active.isConnected || el.contains(active)
      if (lost && previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className="ui-dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`ui-dialog ${className ?? ''}`}
        style={{ width }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          } else if (e.key === 'Tab') {
            if (trapTab(e.currentTarget, e.shiftKey)) e.preventDefault()
          } else if (e.key === 'Enter' && onSubmit && (e.target as HTMLElement).tagName === 'INPUT') {
            e.preventDefault()
            onSubmit()
          }
        }}
      >
        <div className="ui-dialog-header">
          <h2>{title}</h2>
          <button className="ui-icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="ui-dialog-body">{children}</div>
        {footer && <div className="ui-dialog-footer">{footer}</div>}
      </div>
    </div>
  )
}
