import { useEffect, useState } from 'react'
import { Clock, FileText, FolderOpen, Trash2, X } from 'lucide-react'
import { registry } from '../app/registry'
import { useApp } from '../app/store'
import { openFileDialog, openPaths, openToolGroup, refreshRecent } from '../app/actions'
import { invoke } from '../platform'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/Panel'
import type { DefaultAppStatus } from '@shared/types'

function formatSize(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatWhen(t: number) {
  const d = new Date(t)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return `Today, ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })
}

function DefaultAppBanner() {
  const [status, setStatus] = useState<DefaultAppStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const check = useApp((s) => s.prefs.checkDefaultAppOnStartup)
  useEffect(() => {
    if (!check) return
    void invoke('defaultApp:status').then(setStatus).catch(() => {})
  }, [check])
  if (!check || dismissed || !status || status.isDefault !== false) return null
  return (
    <div className="home-banner">
      <div>
        <b>Make Fartcrobat your default PDF app?</b>
        <div className="shell-muted">{status.instructions}</div>
      </div>
      <Button variant="primary" onClick={() => void invoke('defaultApp:set').then(setStatus)}>
        Make default
      </Button>
      <button className="ui-icon-btn" aria-label="Dismiss" onClick={() => setDismissed(true)}>
        <X size={16} />
      </button>
    </div>
  )
}

export function Home() {
  const recent = useApp((s) => s.recent)
  useEffect(() => {
    void refreshRecent()
  }, [])
  const tiles = registry.toolGroups.filter((g) => g.homeTile)
  return (
    <div className="home">
      <div className="home-inner">
        <DefaultAppBanner />
        <h1 className="home-title">Welcome to Fartcrobat</h1>
        <p className="shell-muted home-sub">Open a PDF, or pick a tool to get started. You can also drop files anywhere in this window.</p>
        <div className="home-tiles">
          <button className="home-tile home-tile-open" onClick={() => void openFileDialog()}>
            <span className="home-tile-icon" style={{ background: 'var(--accent)' }}>
              <FolderOpen size={22} />
            </span>
            <span className="home-tile-label">Open a file</span>
            <span className="home-tile-desc">PDF, images, Word, Excel, PowerPoint and more</span>
          </button>
          {tiles.map((g) => (
            <button key={g.id} className="home-tile" onClick={() => openToolGroup(g.id)}>
              <span className="home-tile-icon" style={{ background: g.color ?? 'var(--accent)' }}>
                <g.icon size={22} />
              </span>
              <span className="home-tile-label">{g.label}</span>
              {g.description && <span className="home-tile-desc">{g.description}</span>}
            </button>
          ))}
        </div>
        <div className="home-recent">
          <div className="home-recent-header">
            <h2>
              <Clock size={16} /> Recent files
            </h2>
            {recent.length > 0 && (
              <Button
                variant="quiet"
                size="sm"
                icon={Trash2}
                onClick={() => void invoke('recent:clear').then(() => useApp.setState({ recent: [] }))}
              >
                Clear recent
              </Button>
            )}
          </div>
          {recent.length === 0 ? (
            <EmptyState icon={FileText} title="No recent files">
              Files you open will appear here.
            </EmptyState>
          ) : (
            <table className="home-recent-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Opened</th>
                  <th>Size</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.path} onClick={() => void openPaths([r.path])} title={r.path}>
                    <td className="home-recent-name">
                      <FileText size={16} />
                      <span>
                        {r.name}
                        <small>{r.path}</small>
                      </span>
                    </td>
                    <td>{formatWhen(r.openedAt)}</td>
                    <td>{formatSize(r.size)}</td>
                    <td>
                      <button
                        className="ui-icon-btn"
                        aria-label={`Remove ${r.name} from recent files`}
                        title="Remove from list"
                        onClick={(e) => {
                          e.stopPropagation()
                          void invoke('recent:remove', r.path).then((recent) => useApp.setState({ recent }))
                        }}
                      >
                        <X size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
