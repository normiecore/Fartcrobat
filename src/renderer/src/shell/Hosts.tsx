import { AlertCircle, CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { useApp } from '../app/store'
import { dismissToast, hideContextMenu } from '../app/ui-services'
import { FloatingAt, MenuList } from '../ui/Menu'
import { Button } from '../ui/Button'

export function DialogHost() {
  const dialogs = useApp((s) => s.dialogs)
  return (
    <>
      {dialogs.map((d) => (
        <div key={d.id} className="dialog-layer">
          {d.render((r) => d.resolve(r))}
        </div>
      ))}
    </>
  )
}

const TOAST_ICONS = { info: Info, success: CheckCircle2, error: AlertCircle, warning: TriangleAlert }

export function ToastHost() {
  const toasts = useApp((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => {
        const Icon = TOAST_ICONS[t.kind]
        return (
          <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
            <Icon size={18} />
            <span className="toast-message">{t.message}</span>
            {t.action && (
              <button
                className="toast-action"
                onClick={() => {
                  t.action!.run()
                  dismissToast(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="ui-icon-btn" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <X size={14} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

export function ProgressHost() {
  const p = useApp((s) => s.progress)
  if (!p) return null
  return (
    <div className="ui-dialog-backdrop">
      <div className="ui-dialog progress-dialog" role="progressbar" aria-valuenow={p.fraction !== null ? Math.round(p.fraction * 100) : undefined}>
        <div className="progress-title">{p.title}</div>
        <div className={`progress-bar ${p.fraction === null ? 'is-indeterminate' : ''}`}>
          <div style={{ width: p.fraction === null ? '30%' : `${Math.round(p.fraction * 100)}%` }} />
        </div>
        {p.message && <div className="shell-muted progress-message">{p.message}</div>}
        {p.cancel && (
          <div className="progress-actions">
            <Button onClick={p.cancel}>Cancel</Button>
          </div>
        )}
      </div>
    </div>
  )
}

export function ContextMenuHost() {
  const cm = useApp((s) => s.contextMenu)
  if (!cm) return null
  return (
    <FloatingAt x={cm.x} y={cm.y} onClose={hideContextMenu}>
      <MenuList items={cm.items} onClose={hideContextMenu} />
    </FloatingAt>
  )
}
