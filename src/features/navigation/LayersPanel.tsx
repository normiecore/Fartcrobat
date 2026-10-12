import { useEffect, useState } from 'react'
import { Eye, EyeOff, Layers, RotateCcw } from 'lucide-react'
import { Button, EmptyState, showError, useDocState, type DocumentModel } from '@renderer/sdk'
import { navOps } from './actions'
import type { LayerInfo } from './types'

export function LayersPanel({ doc }: { doc: DocumentModel }) {
  const docVersion = useDocState(doc, (s) => s.docVersion)
  const [layers, setLayers] = useState<LayerInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    navOps(doc)
      .layers()
      .then((l) => {
        if (!alive) return
        setLayers(l)
        setError(null)
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [doc, docVersion])

  const run = async (fn: () => Promise<LayerInfo[]>) => {
    setBusy(true)
    try {
      setLayers(await fn())
    } catch (err) {
      showError(err, 'Could not change layer visibility')
    } finally {
      setBusy(false)
    }
  }

  const changed = !!layers?.some((l) => l.visible !== l.initiallyVisible)

  if (error) {
    return (
      <div className="fc-navigation-panel">
        <EmptyState icon={Layers} title="Layers could not be read">
          {error}
        </EmptyState>
      </div>
    )
  }
  if (!layers) return <div className="fc-navigation-loading">Loading layers…</div>
  if (!layers.length) {
    return (
      <div className="fc-navigation-panel">
        <EmptyState icon={Layers} title="No layers">
          This document has no layers. Layers (optional content) are used in drawings and maps to show or hide parts of a
          page.
        </EmptyState>
      </div>
    )
  }
  return (
    <div className="fc-navigation-panel fc-navigation-layers">
      <div className="fc-navigation-toolbar" role="toolbar" aria-label="Layer actions">
        <Button size="sm" variant="quiet" icon={RotateCcw} disabled={!changed || busy} onClick={() => void run(() => navOps(doc).resetLayers())}>
          Reset to initial visibility
        </Button>
      </div>
      <ul className="fc-navigation-layer-list" aria-label="Layers">
        {layers.map((l) => (
          <li key={l.index} className={`fc-navigation-layer ${l.visible ? '' : 'is-hidden'}`}>
            <button
              type="button"
              className="fc-navigation-layer-eye ui-icon-btn"
              aria-pressed={l.visible}
              aria-label={`${l.visible ? 'Hide' : 'Show'} layer ${l.name}`}
              title={l.visible ? 'Hide layer' : 'Show layer'}
              disabled={busy}
              onClick={() => void run(() => navOps(doc).setLayerVisible(l.index, !l.visible))}
            >
              {l.visible ? <Eye size={16} /> : <EyeOff size={16} />}
            </button>
            <span className="fc-navigation-layer-name">{l.name}</span>
          </li>
        ))}
      </ul>
      <p className="fc-navigation-hint fc-navigation-layers-note">
        Showing or hiding layers changes what you see and print. It doesn't change the document.
      </p>
    </div>
  )
}
