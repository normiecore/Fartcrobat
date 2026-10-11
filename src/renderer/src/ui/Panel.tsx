import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { Icon } from '../app/registry'

/** Standard layout for left-pane tool panels and right-side panels. */
export function PanelFrame({
  title,
  onBack,
  actions,
  children,
  footer
}: {
  title: ReactNode
  onBack?: () => void
  actions?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="ui-panel">
      <div className="ui-panel-header">
        {onBack && (
          <button className="ui-icon-btn" aria-label="Back to all tools" title="Back to all tools" onClick={onBack}>
            <ArrowLeft size={18} />
          </button>
        )}
        <h3>{title}</h3>
        <div className="ui-panel-actions">{actions}</div>
      </div>
      <div className="ui-panel-body">{children}</div>
      {footer && <div className="ui-panel-footer">{footer}</div>}
    </div>
  )
}

/** A clickable row in a tool panel (icon + label + optional description). */
export function ToolRow({
  icon: IconC,
  label,
  description,
  onClick,
  active,
  disabled,
  shortcut
}: {
  icon?: Icon
  label: ReactNode
  description?: ReactNode
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  shortcut?: string
}) {
  return (
    <button type="button" className={`ui-tool-row ${active ? 'is-active' : ''}`} onClick={onClick} disabled={disabled}>
      {IconC && <IconC size={18} />}
      <span className="ui-tool-row-text">
        <span className="ui-tool-row-label">{label}</span>
        {description && <span className="ui-tool-row-desc">{description}</span>}
      </span>
      {shortcut && <span className="ui-tool-row-shortcut">{shortcut}</span>}
    </button>
  )
}

export function Section({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="ui-section">
      {(title || actions) && (
        <div className="ui-section-header">
          {title && <h4>{title}</h4>}
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function EmptyState({ icon: IconC, title, children }: { icon?: Icon; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="ui-empty">
      {IconC && <IconC size={32} />}
      <div className="ui-empty-title">{title}</div>
      {children && <div className="ui-empty-body">{children}</div>}
    </div>
  )
}
