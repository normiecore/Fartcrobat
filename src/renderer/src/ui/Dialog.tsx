import { useEffect, useRef, type ReactNode } from 'react'
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

/** Modal dialog frame. Render it from openDialog(close => <Dialog ...>). */
export function Dialog({ title, onClose, children, footer, width = 480, onSubmit, className }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const focusable = el.querySelector<HTMLElement>('[data-autofocus], input, select, textarea, button.ui-btn-primary')
    focusable?.focus()
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
        className={`ui-dialog ${className ?? ''}`}
        style={{ width }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
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
