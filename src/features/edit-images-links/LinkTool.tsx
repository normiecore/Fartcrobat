import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Link2, Pencil, Trash2, Wand2 } from 'lucide-react'
import type { Point, Rect } from '@shared/geometry'
import {
  Button,
  followExternalLink,
  showContextMenu,
  showError,
  useDocState,
  usePageVersion,
  type ContextMenuItem,
  type CssRect,
  type DocumentModel,
  type PageLayerProps
} from '@renderer/sdk'
import type { LinkItem } from './engine'
import { LINK_SELECTION, ops, returnToEditTool, selectLink, selectedLink } from './common'
import { createLinksFromUrls, openLinkDialog, removeAllLinks } from './LinkDialogs'
import { openFileLink } from './LinkBordersLayer'

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const MIN = 4

type Drag =
  | { mode: 'draw'; a: Point; b: Point }
  | { mode: 'move'; link: LinkItem; start: Point; dx: number; dy: number }
  | { mode: 'resize'; link: LinkItem; handle: Handle; start: Point; from: CssRect; rect: CssRect }

function resize(from: CssRect, h: Handle, dx: number, dy: number): CssRect {
  let l = from.left
  let t = from.top
  let r = from.left + from.width
  let b = from.top + from.height
  if (h.includes('w')) l = Math.min(l + dx, r - MIN)
  if (h.includes('e')) r = Math.max(r + dx, l + MIN)
  if (h.includes('n')) t = Math.min(t + dy, b - MIN)
  if (h.includes('s')) b = Math.max(b + dy, t + MIN)
  return { left: l, top: t, width: r - l, height: b - t }
}

function handlePos(h: Handle, c: CssRect): React.CSSProperties {
  const x = h.includes('w') ? 0 : h.includes('e') ? c.width : c.width / 2
  const y = h.includes('n') ? 0 : h.includes('s') ? c.height : c.height / 2
  const cursor = h === 'n' || h === 's' ? 'ns-resize' : h === 'e' || h === 'w' ? 'ew-resize' : h === 'nw' || h === 'se' ? 'nwse-resize' : 'nesw-resize'
  return { left: x, top: y, cursor }
}

/** Follows a link from the link tool (to check where it goes). */
export function followLink(doc: DocumentModel, link: LinkItem) {
  const a = link.action
  if (a.type === 'page') doc.view?.goToPage(a.page, { x: a.x, y: a.y })
  else if (a.type === 'uri') void followExternalLink(a.uri)
  else if (a.type === 'file') void openFileLink(doc, a.path)
}

export function linkMenu(doc: DocumentModel, page: number, link: LinkItem): ContextMenuItem[] {
  return [
    { id: 'props', label: 'Properties…', icon: Pencil, run: () => void openLinkDialog(doc, page, { link }) },
    {
      id: 'follow',
      label: 'Go to Link Target',
      icon: ExternalLink,
      disabled: link.action.type === 'other' || link.action.type === 'named',
      run: () => followLink(doc, link)
    },
    { id: 'sep', label: '', separator: true },
    { id: 'delete', label: 'Delete', icon: Trash2, shortcut: 'Del', danger: true, run: () => void deleteLink(doc, page, link) }
  ]
}

export async function deleteLink(doc: DocumentModel, page: number, link: LinkItem) {
  try {
    await ops(doc).deleteLink(page, link.id)
    doc.clearSelection()
  } catch (err) {
    showError(err, 'Could not delete the link')
  }
}

export function LinkToolLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const version = usePageVersion(doc, pageIndex)
  const selection = useDocState(doc, (s) => s.selection)
  const [links, setLinks] = useState<LinkItem[]>([])
  const [drag, setDrag] = useState<Drag | null>(null)
  const [pendingRect, setPendingRect] = useState<CssRect | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const sel =
    selection.kind === 'custom' && selection.type === LINK_SELECTION && selection.page === pageIndex ? (selection.data as LinkItem) : null

  useEffect(() => {
    let alive = true
    ops(doc)
      .links(pageIndex)
      .then((l) => {
        if (!alive) return
        setLinks(l)
        const cur = selectedLink(doc)
        if (cur && cur.page === pageIndex) {
          const match = l.find((x) => x.id === cur.data.id)
          if (!match) doc.clearSelection()
          else if (JSON.stringify(match) !== JSON.stringify(cur.data)) selectLink(doc, pageIndex, match)
        }
      })
      .catch((err) => console.warn('Could not list links', err))
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version])

  const local = (e: { clientX: number; clientY: number }): Point => {
    const b = ref.current!.getBoundingClientRect()
    return [e.clientX - b.left, e.clientY - b.top]
  }

  const capture = (e: React.PointerEvent) => {
    ref.current?.setPointerCapture(e.pointerId)
  }

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    capture(e)
    selectLink(doc, pageIndex, null)
    const p = local(e)
    setDrag({ mode: 'draw', a: p, b: p })
  }

  const onLinkDown = (e: React.PointerEvent, link: LinkItem) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    capture(e)
    selectLink(doc, pageIndex, link)
    setDrag({ mode: 'move', link, start: local(e), dx: 0, dy: 0 })
  }

  const onHandleDown = (e: React.PointerEvent, link: LinkItem, h: Handle) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    capture(e)
    const from = geometry.rectToCss(link.rect)
    setDrag({ mode: 'resize', link, handle: h, start: local(e), from, rect: from })
  }

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return
    const p = local(e)
    const clampX = (v: number) => Math.max(0, Math.min(geometry.cssWidth, v))
    const clampY = (v: number) => Math.max(0, Math.min(geometry.cssHeight, v))
    if (drag.mode === 'draw') setDrag({ ...drag, b: [clampX(p[0]), clampY(p[1])] })
    else if (drag.mode === 'move') setDrag({ ...drag, dx: p[0] - drag.start[0], dy: p[1] - drag.start[1] })
    else setDrag({ ...drag, rect: resize(drag.from, drag.handle, p[0] - drag.start[0], p[1] - drag.start[1]) })
  }

  const onUp = (e: React.PointerEvent) => {
    const d = drag
    setDrag(null)
    try {
      ref.current?.releasePointerCapture(e.pointerId)
    } catch {}
    if (!d) return
    if (d.mode === 'draw') {
      const css: CssRect = {
        left: Math.min(d.a[0], d.b[0]),
        top: Math.min(d.a[1], d.b[1]),
        width: Math.abs(d.b[0] - d.a[0]),
        height: Math.abs(d.b[1] - d.a[1])
      }
      if (css.width < MIN || css.height < MIN) return
      const rect = geometry.cssToRect(css)
      setPendingRect(css)
      void openLinkDialog(doc, pageIndex, { rect }).finally(() => setPendingRect(null))
      return
    }
    let rect: Rect | null = null
    if (d.mode === 'move' && Math.hypot(d.dx, d.dy) >= 2) {
      const c = geometry.rectToCss(d.link.rect)
      rect = geometry.cssToRect({ ...c, left: c.left + d.dx, top: c.top + d.dy })
    } else if (d.mode === 'resize') rect = geometry.cssToRect(d.rect)
    if (!rect) return
    const id = d.link.id
    void ops(doc)
      .updateLink(pageIndex, id, { rect })
      .then((l) => selectLink(doc, pageIndex, l))
      .catch((err) => showError(err, 'Could not change the link'))
  }

  const drawn =
    drag?.mode === 'draw'
      ? { left: Math.min(drag.a[0], drag.b[0]), top: Math.min(drag.a[1], drag.b[1]), width: Math.abs(drag.b[0] - drag.a[0]), height: Math.abs(drag.b[1] - drag.a[1]) }
      : pendingRect

  return (
    <div
      ref={ref}
      className="viewer-layer fc-edit-images-links-linklayer"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={() => setDrag(null)}
      onDoubleClick={(e) => {
        // the pointer is captured by this layer, so double-clicks on links arrive here
        const p = local(e)
        const hit = [...links].reverse().find((l) => {
          const c = geometry.rectToCss(l.rect)
          return p[0] >= c.left && p[0] <= c.left + c.width && p[1] >= c.top && p[1] <= c.top + c.height
        })
        if (hit) void openLinkDialog(doc, pageIndex, { link: hit })
      }}
    >
      {links.map((l) => {
        const isSel = sel?.id === l.id
        let c = geometry.rectToCss(l.rect)
        if (isSel && drag?.mode === 'move' && drag.link.id === l.id) c = { ...c, left: c.left + drag.dx, top: c.top + drag.dy }
        if (isSel && drag?.mode === 'resize' && drag.link.id === l.id) c = drag.rect
        return (
          <div
            key={l.id}
            role="button"
            tabIndex={0}
            data-fc-eil=""
            aria-label={`Link: ${l.target}`}
            title={l.target}
            className={`fc-edit-images-links-link ${isSel ? 'is-selected' : ''}`}
            style={{ left: c.left, top: c.top, width: c.width, height: c.height }}
            onPointerDown={(e) => onLinkDown(e, l)}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              selectLink(doc, pageIndex, l)
              showContextMenu(e.clientX, e.clientY, linkMenu(doc, pageIndex, l))
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void openLinkDialog(doc, pageIndex, { link: l })
              } else if (e.key === ' ') {
                e.preventDefault()
                selectLink(doc, pageIndex, l)
              }
            }}
          >
            {isSel &&
              HANDLES.map((h) => (
                <div key={h} className="fc-edit-images-links-handle" style={handlePos(h, c)} onPointerDown={(e) => onHandleDown(e, l, h)} />
              ))}
          </div>
        )
      })}
      {drawn && <div className="fc-edit-images-links-drawn" style={{ ...drawn }} />}
    </div>
  )
}

export function LinkToolbar({ doc }: { doc: DocumentModel }) {
  const selection = useDocState(doc, (s) => s.selection)
  const sel = selection.kind === 'custom' && selection.type === LINK_SELECTION ? (selection.data as LinkItem) : null
  return (
    <div className="fc-edit-images-links-optbar">
      <Link2 size={16} />
      {sel ? (
        <>
          <span className="fc-edit-images-links-ellipsis" title={sel.target}>
            Link to <b>{sel.target}</b>. Drag to move it, drag a handle to resize it.
          </span>
          <Button size="sm" icon={Pencil} onClick={() => void openLinkDialog(doc, selection.kind === 'custom' ? selection.page : 0, { link: sel })}>
            Properties…
          </Button>
          <Button size="sm" icon={Trash2} onClick={() => void deleteLink(doc, selection.kind === 'custom' ? selection.page : 0, sel)}>
            Delete
          </Button>
        </>
      ) : (
        <span>Drag a rectangle where the link should be. Click a link to select it, double-click to edit it.</span>
      )}
      <span className="fc-edit-images-links-spacer" />
      <Button size="sm" icon={Wand2} variant="quiet" onClick={() => void createLinksFromUrls(doc)}>
        Create links from URLs…
      </Button>
      <Button size="sm" variant="quiet" onClick={() => void removeAllLinks(doc)}>
        Remove all links…
      </Button>
      <Button size="sm" variant="primary" onClick={() => returnToEditTool()}>
        Done
      </Button>
    </div>
  )
}
