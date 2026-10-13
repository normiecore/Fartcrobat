import { useEffect, useRef, useState } from 'react'
import {
  loadText,
  rangeRects,
  registry,
  showContextMenu,
  useApp,
  useDocState,
  usePageVersion,
  type ContextMenuItem,
  type PageLayerProps,
  type PageText
} from '@renderer/sdk'
import { OVERLAY_FONTS, overlayTextOf, type MarkInfo } from './shared'
import { markAreas } from './geometry'
import { markMenu } from './MarkTool'
import { marksOf, selectedMarkIds, selectMarks, SELECTION_TYPE, useMarks, useRedactUi, type MarkSelectionData } from './store'

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
  const ref = useRef<HTMLDivElement>(null)
  const geometryRef = useRef(geometry)
  geometryRef.current = geometry
  const marks = useMarks(doc)

  // Marks are Redact annotations, so the Select tool's comment layer handles them like comments.
  // A right-click on one opens the redaction menu (Apply, Properties, Delete) instead.
  useEffect(() => {
    const pageEl = ref.current?.parentElement
    if (!pageEl) return
    const onContextMenu = (e: MouseEvent) => {
      const hit = (e.target as Element | null)?.closest?.('[data-annot-id]')
      if (!hit || !pageEl.contains(hit)) return
      const id = Number(hit.getAttribute('data-annot-id'))
      const mark = marksOf(doc).find((m) => m.id === id && m.page === pageIndex)
      if (!mark) return
      e.preventDefault()
      e.stopPropagation()
      if (!selectedMarkIds(doc).includes(mark.id)) selectMarks(doc, pageIndex, [mark.id])
      const point = geometryRef.current.eventToPage(e, ref.current ?? pageEl)
      const items: ContextMenuItem[] = markMenu(doc, mark)
      for (const c of registry.pageContextMenu) {
        if (c.id === 'redact') continue
        const more = c.items({ doc, pageIndex, point })
        if (more.length) items.push({ id: `sep-${c.id}`, label: '', separator: true }, ...more)
      }
      showContextMenu(e.clientX, e.clientY, items)
    }
    pageEl.addEventListener('contextmenu', onContextMenu, true)
    return () => pageEl.removeEventListener('contextmenu', onContextMenu, true)
  }, [doc, pageIndex])

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

  return (
    <div ref={ref} className="viewer-layer fc-redact-marks-layer" aria-hidden="true">
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
