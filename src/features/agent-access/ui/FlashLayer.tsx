/** Page layer: the short-lived outline show_in_app draws around the region an agent points at. */
import type { PageLayerProps } from '@renderer/sdk'
import { useFlash } from './store'

export function FlashLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const flash = useFlash((s) => (s.flash && s.flash.docId === doc.id && s.flash.page === pageIndex ? s.flash : null))
  if (!flash) return null
  const c = geometry.rectToCss(flash.rect)
  const pad = 4
  return (
    <div className="viewer-layer fc-agent-access-flash-layer" aria-hidden>
      <div
        key={flash.key}
        className="fc-agent-access-flash"
        style={{ left: c.left - pad, top: c.top - pad, width: c.width + pad * 2, height: c.height + pad * 2 }}
      />
    </div>
  )
}
