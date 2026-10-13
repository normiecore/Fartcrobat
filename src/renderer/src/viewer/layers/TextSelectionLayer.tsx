import { useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { create } from 'zustand'
import type { Point, Rect } from '@shared/geometry'
import { useDocState, usePageVersion, type DocumentModel, type Selection } from '../../document/DocumentModel'
import { caretAt, charIndexAt, isOverText, lineAt, rangeRects, wordAt, type PageText, type TextRange } from '../../document/textModel'
import { registry, type ContextMenuItem } from '../../app/registry'
import { showContextMenu, toast } from '../../app/ui-services'
import { invoke } from '../../platform'
import type { PageGeometry } from '../geometry'
import { getLoadedText, tryLoadText } from './textSync'

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

/** Where the floating selection toolbar appears. */
export const useSelectionToolbar = create<{ docId: string | null; page: number; rect: Rect | null }>(() => ({
  docId: null,
  page: -1,
  rect: null
}))

/**
 * The text drag in progress. It lives outside the page layers because a drag crosses pages, and
 * the page it started on can be unmounted (virtualised away) mid-drag, taking its pointer capture
 * with it: the window listeners below then still end the drag when the button is released.
 */
let drag: DragState | null = null

/** The anchor (where it started) of the last selection made with the mouse, for Shift+click. */
const selectionAnchors = new WeakMap<DocumentModel, { selection: Selection; anchor: Caret }>()

function rememberAnchor(doc: DocumentModel, anchor: Caret) {
  selectionAnchors.set(doc, { selection: doc.state.selection, anchor })
}

function anchorOfSelection(doc: DocumentModel): Caret | null {
  const sel = doc.state.selection
  if (sel.kind !== 'text' || !sel.ranges.length) return null
  const known = selectionAnchors.get(doc)
  if (known && known.selection === sel) return known.anchor
  return { page: sel.ranges[0].page, index: sel.ranges[0].start }
}

const onWindowPointerUp = () => finishDrag()

function beginDrag(state: DragState) {
  if (!drag) {
    window.addEventListener('pointerup', onWindowPointerUp)
    window.addEventListener('pointercancel', onWindowPointerUp)
    window.addEventListener('blur', onWindowPointerUp)
  }
  drag = state
}

/** Ends the drag: a plain click clears the selection, a drag shows the selection toolbar. */
function finishDrag() {
  const d = drag
  drag = null
  window.removeEventListener('pointerup', onWindowPointerUp)
  window.removeEventListener('pointercancel', onWindowPointerUp)
  window.removeEventListener('blur', onWindowPointerUp)
  if (!d) return
  const doc = d.doc
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
    void tryLoadText(doc, pageIndex).then((t) => t && setText(t))
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
    const anchor = e.shiftKey && t ? anchorOfSelection(doc) : null
    if (anchor && t) {
      // Shift+click extends the selection from its anchor to the click, right away.
      const focus: Caret = { page: pageIndex, index: Math.max(0, caretAt(t, p)) }
      doc.setSelection({ kind: 'text', ranges: rangesBetween(doc, anchor, focus) })
      rememberAnchor(doc, anchor)
      beginDrag({ doc, anchor, startClient: [e.clientX, e.clientY], moved: true })
    } else {
      beginDrag({
        doc,
        anchor: t ? { page: pageIndex, index: Math.max(0, caretAt(t, p)) } : null,
        startClient: [e.clientX, e.clientY],
        moved: false
      })
      if (!t) void tryLoadText(doc, pageIndex).then((tt) => {
        if (!tt) return
        setText(tt)
        if (drag && !drag.anchor) drag.anchor = { page: pageIndex, index: Math.max(0, caretAt(tt, p)) }
      })
    }
    ref.current?.setPointerCapture(e.pointerId)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    doc.view?.getViewportElement()?.focus({ preventScroll: true })
  }

  // Double-click selects a word and triple-click a line. The click count comes from the mouse
  // event: PointerEvent.detail is always 0 for pointerdown. This runs after onPointerDown.
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0 || e.detail < 2) return
    const t = getLoadedText(doc, pageIndex)
    if (!t) return
    // The character under the pointer, not the caret position next to it (which is the following
    // character over the right half of a letter).
    const idx = charIndexAt(t, pagePoint(e))
    if (idx < 0) return
    const r = e.detail === 2 ? wordAt(t, Math.min(idx, t.text.length - 1)) : lineAt(t, idx)
    if (!r) return
    doc.setSelection({ kind: 'text', ranges: [{ page: pageIndex, start: r.start, end: r.end }] })
    const anchor = { page: pageIndex, index: r.start }
    rememberAnchor(doc, anchor)
    beginDrag({ doc, anchor, startClient: [e.clientX, e.clientY], moved: true, anchorRange: r })
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag && (e.buttons & 1) === 0) {
      // The button was released where no layer saw it (e.g. after the page the drag started on
      // was unmounted): the drag is over.
      finishDrag()
    }
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
      void tryLoadText(doc, hit.pageIndex)
      return
    }
    let focus: Caret = { page: hit.pageIndex, index: Math.max(0, caretAt(t, hit.point)) }
    let anchor = drag.anchor
    if (drag.anchorRange && focus.page === anchor.page) {
      // extend by whole words after a double-click
      const w = wordAt(t, Math.min(Math.max(0, charIndexAt(t, hit.point)), t.text.length - 1))
      if (focus.index < drag.anchorRange.start) {
        anchor = { page: anchor.page, index: drag.anchorRange.end }
        focus = { page: focus.page, index: Math.min(w?.start ?? focus.index, drag.anchorRange.start) }
      } else {
        anchor = { page: anchor.page, index: drag.anchorRange.start }
        focus = { page: focus.page, index: Math.max(w?.end ?? focus.index, drag.anchorRange.end) }
      }
    }
    doc.setSelection({ kind: 'text', ranges: rangesBetween(doc, anchor, focus) })
    rememberAnchor(doc, anchor)
    // auto-scroll near the viewport edges
    const vp = doc.view?.getViewportElement()
    if (vp) {
      const b = vp.getBoundingClientRect()
      if (e.clientY < b.top + 24) doc.view?.scrollBy(0, -24)
      else if (e.clientY > b.bottom - 24) doc.view?.scrollBy(0, 24)
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    finishDrag()
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
      onMouseDown={interactive ? onMouseDown : undefined}
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
