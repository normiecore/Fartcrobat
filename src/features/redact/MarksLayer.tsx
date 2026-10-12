import { useEffect, useState } from 'react'
import { loadText, rangeRects, useApp, useDocState, usePageVersion, type PageLayerProps, type PageText } from '@renderer/sdk'
import { OVERLAY_FONTS, overlayTextOf, type MarkInfo } from './shared'
import { markAreas } from './geometry'
import { SELECTION_TYPE, useMarks, useRedactUi, type MarkSelectionData } from './store'

function OverlayPreview({ mark, geometry }: { mark: MarkInfo; geometry: PageLayerProps['geometry'] }) {
  const p = mark.props
  const text = overlayTextOf(p)
  const font = OVERLAY_FONTS.find((f) => f.id === p.font) ?? OVERLAY_FONTS[0]
  return (
    <>
      {markAreas(mark).map((r, i) => {
        const c = geometry.rectToCss(r)
        const size = p.autoSize ? Math.max(6, Math.min(c.height * 0.75, 28)) : geometry.len(p.fontSize)
        return (
          <div
            key={i}
            className={`fc-redact-hover ${p.fillColor ? '' : 'is-unfilled'}`}
            style={{
              left: c.left,
              top: c.top,
              width: c.width,
              height: c.height,
              background: p.fillColor ?? undefined,
              color: p.textColor,
              justifyContent: p.align === 'left' ? 'flex-start' : p.align === 'right' ? 'flex-end' : 'center',
              fontFamily: font.css,
              fontWeight: font.weight,
              fontSize: size
            }}
          >
            {text && <span>{p.repeat ? Array(Math.max(1, Math.ceil(c.width / Math.max(8, text.length * size * 0.55)))).fill(text).join('  ') : text}</span>}
          </div>
        )
      })}
    </>
  )
}

/**
 * Always-mounted page layer: shows how a mark will look when the pointer is over it, outlines
 * selected marks and highlights Find & Redact results.
 */
export function MarksLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const marks = useMarks(doc)
  const hoverId = useRedactUi((s) => (s.hover?.docId === doc.id ? s.hover.id : null))
  const selection = useDocState(doc, (s) => s.selection)
  const view = useRedactUi((s) => s.view)
  const find = useRedactUi((s) => s.find[doc.id])
  const groupOpen = useApp((s) => s.toolGroupId === 'redact')
  const toolGroupOpen = groupOpen && view === 'find'
  const version = usePageVersion(doc, pageIndex)
  const results = toolGroupOpen && find ? find.results.filter((r) => r.page === pageIndex) : []
  const [text, setText] = useState<PageText | null>(null)
  const needText = results.length > 0

  useEffect(() => {
    if (!needText) return
    let alive = true
    void loadText(doc, pageIndex).then((t) => alive && setText(t))
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version, needText])

  const pageMarks = marks.filter((m) => m.page === pageIndex)
  const hovered = hoverId !== null ? pageMarks.find((m) => m.id === hoverId) : undefined
  const selectedIds =
    selection.kind === 'custom' && selection.type === SELECTION_TYPE ? ((selection.data as MarkSelectionData).ids ?? []) : []
  const selected = pageMarks.filter((m) => selectedIds.includes(m.id))
  if (!hovered && !selected.length && !(results.length && text)) return null

  return (
    <div className="viewer-layer fc-redact-marks-layer" aria-hidden="true">
      {results.length > 0 &&
        text &&
        results.flatMap((r) =>
          rangeRects(text, r.start, Math.min(r.end, text.text.length)).map((rect, k) => {
            const c = geometry.rectToCss(rect)
            const checked = !!find?.checked[r.key]
            return (
              <div
                key={`${r.key}-${k}`}
                className={`fc-redact-find-hit ${checked ? 'is-checked' : ''} ${find?.active === r.key ? 'is-active' : ''}`}
                style={{ left: c.left - 1, top: c.top - 1, width: c.width + 2, height: c.height + 2 }}
              />
            )
          })
        )}
      {hovered && <OverlayPreview mark={hovered} geometry={geometry} />}
      {selected.map((m) => {
        const c = geometry.rectToCss(m.rect)
        return <div key={m.id} className="fc-redact-selected" style={{ left: c.left - 3, top: c.top - 3, width: c.width + 6, height: c.height + 6 }} />
      })}
    </div>
  )
}
