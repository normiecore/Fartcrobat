import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Maximize, Minus, Plus, X } from 'lucide-react'
import { registry } from '../app/registry'
import { useActiveDoc, useApp } from '../app/store'
import { toggleRightPanel } from '../app/actions'
import { useDocState, type DocumentModel } from '../document/DocumentModel'
import { nextZoomStep } from '../viewer/layout'

function PageNav({ doc }: { doc: DocumentModel }) {
  const current = useDocState(doc, (s) => s.currentPage)
  const info = useDocState(doc, (s) => s.info)
  const [text, setText] = useState('')
  const label = info.pages[current]?.label ?? String(current + 1)
  const hasLabels = info.pages.some((p, i) => p.label !== String(i + 1))
  useEffect(() => setText(hasLabels ? label : String(current + 1)), [current, label, hasLabels])
  const go = () => {
    const t = text.trim()
    let idx = info.pages.findIndex((p) => p.label === t)
    if (idx < 0) idx = parseInt(t, 10) - 1
    if (Number.isFinite(idx) && idx >= 0 && idx < info.pageCount) doc.view?.goToPage(idx)
    else setText(hasLabels ? label : String(current + 1))
  }
  return (
    <div className="shell-pagenav">
      <button className="ui-icon-btn" title="Previous page" aria-label="Previous page" onClick={() => doc.view?.goToPage(current - 1)} disabled={current <= 0}>
        <ChevronUp size={16} />
      </button>
      <input
        className="shell-pagenav-input"
        aria-label="Page number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            go()
            ;(e.target as HTMLInputElement).blur()
          }
          e.stopPropagation()
        }}
        onFocus={(e) => e.target.select()}
        onBlur={go}
      />
      <span className="shell-pagenav-total" title={hasLabels ? `Page ${current + 1} of ${info.pageCount}` : undefined}>
        {hasLabels ? `(${current + 1} of ${info.pageCount})` : info.pageCount}
      </span>
      <button className="ui-icon-btn" title="Next page" aria-label="Next page" onClick={() => doc.view?.goToPage(current + 1)} disabled={current >= info.pageCount - 1}>
        <ChevronDown size={16} />
      </button>
    </div>
  )
}

function ZoomControls({ doc }: { doc: DocumentModel }) {
  const zoom = useDocState(doc, (s) => s.zoom)
  return (
    <div className="shell-zoomctl">
      <button className="ui-icon-btn" title="Zoom in" aria-label="Zoom in" onClick={() => doc.view?.setZoom(nextZoomStep(zoom, 1))}>
        <Plus size={16} />
      </button>
      <span className="shell-zoomctl-value">{Math.round(zoom * 100)}%</span>
      <button className="ui-icon-btn" title="Zoom out" aria-label="Zoom out" onClick={() => doc.view?.setZoom(nextZoomStep(zoom, -1))}>
        <Minus size={16} />
      </button>
      <button className="ui-icon-btn" title="Fit page" aria-label="Fit page" onClick={() => doc.view?.setZoom('fit-page')}>
        <Maximize size={15} />
      </button>
    </div>
  )
}

export function RightRail() {
  const doc = useActiveDoc()
  const panelId = useApp((s) => s.rightPanelId)
  const panel = registry.rightPanels.find((p) => p.id === panelId)
  if (!doc) return null
  return (
    <>
      {panel && (
        <aside className="shell-rightpanel" aria-label={panel.label}>
          <div className="shell-rightpanel-header">
            <h3>{panel.label}</h3>
            <button className="ui-icon-btn" aria-label="Close panel" title="Close panel" onClick={() => toggleRightPanel(panel.id)}>
              <X size={16} />
            </button>
          </div>
          <div className="shell-rightpanel-body">
            <panel.component doc={doc} />
          </div>
        </aside>
      )}
      <nav className="shell-rightrail" aria-label="Panels">
        <div className="shell-rightrail-panels">
          {registry.rightPanels.map((p) => (
            <button
              key={p.id}
              className={`shell-rail-btn ${panelId === p.id ? 'is-active' : ''}`}
              title={p.label}
              aria-label={p.label}
              aria-pressed={panelId === p.id}
              onClick={() => toggleRightPanel(p.id)}
            >
              <p.icon size={20} />
            </button>
          ))}
        </div>
        <div className="shell-rightrail-bottom">
          <PageNav doc={doc} />
          <ZoomControls doc={doc} />
        </div>
      </nav>
    </>
  )
}
