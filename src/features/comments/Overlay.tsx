/**
 * Floating comment UI that lives inside the document's scroll area (so it scrolls with the pages
 * and is not clipped at page edges): pop-up notes, the properties bar of the selected comment and
 * the inline text box editor.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AnnotInfo } from '@engine/ops/annots'
import {
  PageGeometry,
  setHiddenAnnotations,
  showError,
  useActiveDoc,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { rotatedBox } from './AnnotationLayer'
import { Inspector } from './Inspector'
import { PopupNote } from './PopupNote'
import { annotsOf, closePopupsFor, useCommentsUi, useThreads, type InlineEdit } from './state'

/** The active document's scroll container once the viewer is mounted. */
function useViewportElement(doc: DocumentModel | null): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!doc) {
      setEl(null)
      return
    }
    const check = () => {
      const v = doc.view?.getViewportElement() ?? null
      const next = v && v.isConnected ? v : null
      setEl((prev) => (prev === next ? prev : next))
    }
    check()
    const t = window.setInterval(check, 300)
    return () => window.clearInterval(t)
  }, [doc])
  return el
}

/** Re-renders when pages move (zoom, layout, resize, pages mounting). */
function useLayoutTick(vp: HTMLElement): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const content = vp.querySelector('.viewer-content')
    if (!content) return
    let raf = 0
    const bump = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          setTick((t) => t + 1)
        })
    }
    const ro = new ResizeObserver(bump)
    ro.observe(content)
    ro.observe(vp)
    const mo = new MutationObserver((muts) => {
      if (muts.some((m) => (m.type === 'childList' && m.target === content) || (m.target as Element).classList?.contains('viewer-page'))) bump()
    })
    mo.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    return () => {
      ro.disconnect()
      mo.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [vp])
  return tick
}

const FONT_FAMILY: Record<string, string> = {
  TiRo: '"Times New Roman", Times, serif',
  Cour: '"Courier New", Courier, monospace'
}

function InlineEditor({
  doc,
  edit,
  annot: a,
  geometry,
  origin
}: {
  doc: DocumentModel
  edit: InlineEdit
  annot: AnnotInfo
  geometry: PageGeometry
  origin: { x: number; y: number }
}) {
  const [text, setText] = useState(a.contents)
  const [extra, setExtra] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  const box = rotatedBox(geometry, a.rect)
  const pad = (Math.max(0, a.borderWidth) / 2 + 2) * geometry.scale

  useEffect(() => {
    setHiddenAnnotations(doc, a.page, [a.id])
    const el = ref.current
    if (el) {
      el.focus({ preventScroll: true })
      if (edit.isNew) el.select()
      else el.setSelectionRange(el.value.length, el.value.length)
    }
    return () => setHiddenAnnotations(doc, a.page, [])
    // run once per edited annotation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a.id])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const base = (box.height as number) || 0
    el.style.height = `${base}px`
    setExtra(Math.max(0, el.scrollHeight - base))
  }, [text, box.height])

  const finish = async (save: boolean) => {
    if (done.current) return
    done.current = true
    useCommentsUi.setState({ editing: null })
    try {
      if (edit.isNew && !(save ? text : a.contents).trim()) {
        await annotsOf(doc).delete([a.id], a.page)
        return
      }
      if (!save) return
      const spec: { contents?: string; rect?: [number, number, number, number] } = {}
      if (text !== a.contents) spec.contents = text
      // grow the box downwards (in page orientation) so all the text fits
      const needed = (ref.current?.scrollHeight ?? 0) / geometry.scale
      const h = a.rect[3] - a.rect[1]
      if (needed > h + 1 && geometry.rotation === 0) spec.rect = [a.rect[0], a.rect[1], a.rect[2], Math.min(geometry.height, a.rect[1] + needed)]
      if (Object.keys(spec).length) await annotsOf(doc).update(a.id, spec, a.page)
    } catch (err) {
      showError(err, 'Could not save the text')
    }
  }

  const height = (box.height as number) + extra
  return (
    <textarea
      ref={ref}
      className="fc-comments-inline-editor"
      aria-label="Text box text"
      value={text}
      spellCheck
      style={{
        ...box,
        left: origin.x + (box.left as number),
        top: origin.y + (box.top as number) + (geometry.rotation === 0 ? 0 : -extra / 2),
        height,
        fontSize: (a.fontSize ?? 12) * geometry.scale,
        color: a.textColor ?? '#000',
        fontFamily: FONT_FAMILY[a.fontName ?? ''] ?? 'Helvetica, Arial, sans-serif',
        textAlign: (['left', 'center', 'right'] as const)[a.quadding] ?? 'left',
        padding: pad,
        background: a.color && a.color !== 'transparent' ? a.color : 'rgba(255, 255, 255, 0.92)'
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => void finish(true)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          void finish(false)
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault()
          void finish(true)
        }
      }}
    />
  )
}

function OverlayContent({ doc, vp }: { doc: DocumentModel; vp: HTMLElement }) {
  useLayoutTick(vp)
  const zoom = useDocState(doc, (s) => s.zoom)
  const rotation = useDocState(doc, (s) => s.viewRotation)
  const info = useDocState(doc, (s) => s.info)
  const show = useDocState(doc, (s) => s.showAnnotations)
  const selection = useDocState(doc, (s) => s.selection)
  const { threads, list, fresh } = useThreads(doc)
  const allPopups = useCommentsUi((s) => s.popups)
  const editing = useCommentsUi((s) => s.editing)
  const dragging = useCommentsUi((s) => s.dragging)
  const popups = allPopups.filter((p) => p.docId === doc.id)

  // Close pop-ups of comments that were deleted (or undone away).
  useEffect(() => {
    if (!fresh) return
    const ids = new Set(list.map((a) => a.id))
    const gone = useCommentsUi.getState().popups.filter((p) => p.docId === doc.id && !ids.has(p.id))
    if (gone.length) closePopupsFor(doc.id, gone.map((g) => g.id))
    const ed = useCommentsUi.getState().editing
    if (ed && ed.docId === doc.id && !ids.has(ed.id)) useCommentsUi.setState({ editing: null })
  }, [doc, fresh, list])

  if (!show) return null
  const content = vp.querySelector<HTMLElement>('.viewer-content')
  const originOf = (page: number) => {
    const el = content?.querySelector<HTMLElement>(`.viewer-page[data-page-index="${page}"]`)
    const pg = info.pages[page]
    if (!el || !content || !pg) return null
    return { x: content.offsetLeft + el.offsetLeft, y: content.offsetTop + el.offsetTop, g: new PageGeometry(page, pg.width, pg.height, zoom, rotation) }
  }

  // properties bar for a single selected comment (or one group)
  let inspector: React.ReactNode = null
  if (selection.kind === 'annotations' && selection.ids.length && !dragging) {
    const t = threads.find((x) => selection.ids.includes(x.root.id))
    const groupIds = t ? [t.root.id, ...t.group.map((g) => g.id)] : []
    const o = t ? originOf(t.root.page) : null
    if (t && o && selection.ids.every((id) => groupIds.includes(id)) && editing?.id !== t.root.id) {
      const css = o.g.rectToCss(t.root.rect)
      const above = css.top > 52
      inspector = (
        <Inspector
          key={t.root.id}
          doc={doc}
          annot={t.root}
          left={o.x + Math.max(0, Math.min(css.left, o.g.cssWidth - 120))}
          top={above ? o.y + css.top - 46 : o.y + css.top + css.height + 10}
        />
      )
    }
  }

  let editor: React.ReactNode = null
  if (editing && editing.docId === doc.id) {
    const a = list.find((x) => x.id === editing.id)
    const o = originOf(editing.page)
    if (a && o) editor = <InlineEditor key={a.id} doc={doc} edit={editing} annot={a} geometry={o.g} origin={o} />
  }

  return (
    <div className="fc-comments-overlay">
      {inspector}
      {editor}
      {popups.map((p) => {
        const t = threads.find((x) => x.root.id === p.id)
        const o = originOf(p.page)
        if (!t || !o) return null
        const css = o.g.rectToCss(t.root.rect)
        let left: number
        let top: number
        if (p.pos) {
          const c = o.g.toCss(p.pos)
          left = o.x + c[0]
          top = o.y + c[1]
        } else {
          left = o.x + css.left + css.width + 14
          top = o.y + Math.max(0, css.top - 4)
          // not enough room on the right: open on the left of the comment
          const room = Math.max(vp.scrollWidth, vp.clientWidth)
          if (left + p.width > room - 8) left = Math.max(o.x + 8, o.x + css.left - p.width - 14)
        }
        return (
          <PopupNote
            key={`${p.docId}:${p.id}`}
            doc={doc}
            entry={p}
            thread={t}
            list={list}
            left={left}
            top={top}
            toPagePos={(l, tp) => o.g.toPage([l - o.x, tp - o.y])}
          />
        )
      })}
    </div>
  )
}

export function CommentOverlayHost() {
  const doc = useActiveDoc()
  const vp = useViewportElement(doc)
  if (!doc || !vp) return null
  return createPortal(<OverlayContent key={doc.id} doc={doc} vp={vp} />, vp)
}
