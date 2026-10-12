import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { create } from 'zustand'
import type { Point, Rect } from '@shared/geometry'
import { useDocState, usePageVersion, type DocumentModel } from '../../document/DocumentModel'
import { caretAt, isOverText, lineAt, rangeRects, wordAt, type PageText, type TextRange } from '../../document/textModel'
import { registry, type ContextMenuItem } from '../../app/registry'
import { showContextMenu, toast } from '../../app/ui-services'
import { invoke } from '../../platform'
import type { PageGeometry } from '../geometry'
import { getLoadedText, loadText } from './textSync'

interface Caret {
  page: number
  index: number
}

interface DragState {
  doc: DocumentModel
  anchor: Caret | null
  startClient: Point
  moved: boolean
  anchorRange?: { start: number; end: number }
}

let drag: DragState | null = null

/** Where the floating selection toolbar appears. */
export const useSelectionToolbar = create<{ docId: string | null; page: number; rect: Rect | null }>(() => ({
  docId: null,
  page: -1,
  rect: null
}))

function rangesBetween(doc: DocumentModel, a: Caret, b: Caret): TextRange[] {
  const [s, e] = a.page < b.page || (a.page === b.page && a.index <= b.index) ? [a, b] : [b, a]
  if (s.page === e.page) return s.index === e.index ? [] : [{ page: s.page, start: s.index, end: e.index }]
  const ranges: TextRange[] = []
  const len = (p: number) => getLoadedText(doc, p)?.text.length ?? 1e9
  ranges.push({ page: s.page, start: s.index, end: len(s.page) })
  for (let p = s.page + 1; p < e.page; p++) ranges.push({ page: p, start: 0, end: len(p) })
  ranges.push({ page: e.page, start: 0, end: e.index })
  return ranges.filter((r) => r.end > r.start)
}

export async function copySelection(doc: DocumentModel) {
  if (doc.state.info.permissions.copy === false) {
    toast('Copying is not allowed: the author of this document restricted copying of its content.', { kind: 'warning' })
    return
  }
  const text = await doc.selectedText()
  if (text) await invoke('clipboard:writeText', text)
}

function selectionMenu(doc: DocumentModel): ContextMenuItem[] {
  const sel = doc.state.selection
  if (sel.kind !== 'text' || !sel.ranges.length) return []
  return [
    { id: 'copy', label: 'Copy', icon: Copy, shortcut: 'Ctrl+C', run: () => void copySelection(doc) },
    ...registry.textSelectionActions.map((a) => ({
      id: a.id,
      label: a.label,
      icon: a.icon,
      run: () => void a.run(doc, sel)
    }))
  ]
}

export function TextSelectionLayer({
  doc,
  pageIndex,
  geometry,
  interactive
}: {
  doc: DocumentModel
  pageIndex: number
  geometry: PageGeometry
  interactive: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const version = usePageVersion(doc, pageIndex)
  const selection = useDocState(doc, (s) => s.selection)
  const [text, setText] = useState<PageText | null>(() => getLoadedText(doc, pageIndex))
  const range = selection.kind === 'text' ? selection.ranges.find((r) => r.page === pageIndex) : undefined
  const toolbar = useSelectionToolbar()

  useEffect(() => {
    setText(getLoadedText(doc, pageIndex))
  }, [doc, pageIndex, version])

  const ensureText = () => {
    if (text && getLoadedText(doc, pageIndex)) return
    void loadText(doc, pageIndex).then((t) => setText(t))
  }

  useEffect(() => {
    if (range) ensureText()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range?.page, range?.start, range?.end, version])

  const pagePoint = (e: { clientX: number; clientY: number }): Point => geometry.eventToPage(e, ref.current!)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const t = getLoadedText(doc, pageIndex)
    const p = pagePoint(e)
    useSelectionToolbar.setState({ docId: null, rect: null })
    if (e.detail >= 2 && t) {
      const idx = Math.max(0, caretAt(t, p))
      const r = e.detail === 2 ? wordAt(t, Math.min(idx, t.text.length - 1)) : lineAt(t, idx)
      if (r) {
        doc.setSelection({ kind: 'text', ranges: [{ page: pageIndex, start: r.start, end: r.end }] })
        drag = { doc, anchor: { page: pageIndex, index: r.start }, startClient: [e.clientX, e.clientY], moved: true, anchorRange: r }
        ref.current?.setPointerCapture(e.pointerId)
      }
      return
    }
    if (e.shiftKey && selection.kind === 'text' && selection.ranges.length && t) {
      const first = selection.ranges[0]
      drag = { doc, anchor: { page: first.page, index: first.start }, startClient: [e.clientX, e.clientY], moved: true }
    } else {
      drag = {
        doc,
        anchor: t ? { page: pageIndex, index: Math.max(0, caretAt(t, p)) } : null,
        startClient: [e.clientX, e.clientY],
        moved: false
      }
      if (!t) void loadText(doc, pageIndex).then((tt) => {
        setText(tt)
        if (drag && !drag.anchor) drag.anchor = { page: pageIndex, index: Math.max(0, caretAt(tt, p)) }
      })
    }
    ref.current?.setPointerCapture(e.pointerId)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    doc.view?.getViewportElement()?.focus({ preventScroll: true })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || drag.doc !== doc) {
      // hover: show an I-beam over text
      const t = getLoadedText(doc, pageIndex)
      if (!t) {
        ensureText()
        return
      }
      if (ref.current) ref.current.style.cursor = isOverText(t, pagePoint(e)) ? 'text' : ''
      return
    }
    const dx = e.clientX - drag.startClient[0]
    const dy = e.clientY - drag.startClient[1]
    if (!drag.moved && Math.hypot(dx, dy) < 3) return
    drag.moved = true
    if (!drag.anchor) return
    const hit = doc.view?.hitTest?.(e.clientX, e.clientY)
    if (!hit) return
    const t = getLoadedText(doc, hit.pageIndex)
    if (!t) {
      void loadText(doc, hit.pageIndex)
      return
    }
    let focus: Caret = { page: hit.pageIndex, index: Math.max(0, caretAt(t, hit.point)) }
    let anchor = drag.anchor
    if (drag.anchorRange && focus.page === anchor.page) {
      // extend by whole words after a double-click
      const w = wordAt(t, Math.min(focus.index, t.text.length - 1))
      if (focus.index < drag.anchorRange.start) {
        anchor = { page: anchor.page, index: drag.anchorRange.end }
        focus = { page: focus.page, index: w?.start ?? focus.index }
      } else {
        anchor = { page: anchor.page, index: drag.anchorRange.start }
        focus = { page: focus.page, index: w?.end ?? focus.index }
      }
    }
    doc.setSelection({ kind: 'text', ranges: rangesBetween(doc, anchor, focus) })
    // auto-scroll near the viewport edges
    const vp = doc.view?.getViewportElement()
    if (vp) {
      const b = vp.getBoundingClientRect()
      if (e.clientY < b.top + 24) doc.view?.scrollBy(0, -24)
      else if (e.clientY > b.bottom - 24) doc.view?.scrollBy(0, 24)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag
    drag = null
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    if (!d || d.doc !== doc) return
    if (!d.moved) {
      doc.clearSelection()
      return
    }
    const sel = doc.state.selection
    if (sel.kind === 'text' && sel.ranges.length) {
      const last = sel.ranges[sel.ranges.length - 1]
      const t = getLoadedText(doc, last.page)
      const rects = t ? rangeRects(t, last.start, Math.min(last.end, t.text.length)) : []
      if (rects.length) useSelectionToolbar.setState({ docId: doc.id, page: last.page, rect: rects[rects.length - 1] })
    }
  }

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const items = selectionMenu(doc)
    const p = pagePoint(e)
    for (const c of registry.pageContextMenu) {
      const more = c.items({ doc, pageIndex, point: p })
      if (more.length) {
        if (items.length) items.push({ id: `sep-${c.id}`, label: '', separator: true })
        items.push(...more)
      }
    }
    showContextMenu(e.clientX, e.clientY, items)
  }

  const rects = range && text ? rangeRects(text, range.start, Math.min(range.end, text.text.length)) : []
  const showToolbar = toolbar.docId === doc.id && toolbar.page === pageIndex && toolbar.rect && selection.kind === 'text'

  return (
    <div
      ref={ref}
      className="viewer-layer viewer-text-layer"
      style={{ pointerEvents: interactive ? 'auto' : 'none' }}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
      onPointerEnter={interactive ? ensureText : undefined}
      onContextMenu={interactive ? onContextMenu : undefined}
    >
      {rects.map((r, i) => {
        const c = geometry.rectToCss(r)
        return <div key={i} className="viewer-text-selection" style={{ left: c.left, top: c.top, width: c.width, height: c.height }} />
      })}
      {showToolbar && <SelectionToolbar doc={doc} geometry={geometry} rect={toolbar.rect!} />}
    </div>
  )
}

function SelectionToolbar({ doc, geometry, rect }: { doc: DocumentModel; geometry: PageGeometry; rect: Rect }) {
  const c = geometry.rectToCss(rect)
  const sel = doc.state.selection
  if (sel.kind !== 'text') return null
  const top = c.top - 40 < 0 ? c.top + c.height + 6 : c.top - 40
  return (
    <div
      className="viewer-selection-toolbar"
      style={{ left: Math.max(0, c.left + c.width / 2 - 100), top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button title="Copy" onClick={() => void copySelection(doc)}>
        <Copy size={16} />
      </button>
      {registry.textSelectionActions.map((a) => (
        <button
          key={a.id}
          title={a.label}
          onClick={() => {
            useSelectionToolbar.setState({ docId: null, rect: null })
            void a.run(doc, sel)
          }}
        >
          <a.icon size={16} />
        </button>
      ))}
    </div>
  )
}
