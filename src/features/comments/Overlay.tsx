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
    // the properties bar stays inside the visible area while scrolling
    vp.addEventListener('scroll', bump, { passive: true })
    const mo = new MutationObserver((muts) => {
      if (muts.some((m) => (m.type === 'childList' && m.target === content) || (m.target as Element).classList?.contains('viewer-page'))) bump()
    })
    mo.observe(content, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
    return () => {
      ro.disconnect()
      mo.disconnect()
      vp.removeEventListener('scroll', bump)
      cancelAnimationFrame(raf)
    }
  }, [vp])
  return tick
}

const FONT_FAMILY: Record<string, string> = {
  Helv: 'Helvetica, Arial, "Liberation Sans", sans-serif',
  TiRo: '"Times New Roman", Times, "Liberation Serif", serif',
  Cour: '"Courier New", Courier, "Liberation Mono", monospace'
}

/** Where a CSS line box puts the baseline (em below its top) with line-height 1.2 and Arial-like metrics. */
const CSS_BASELINE = 0.9465

/**
 * Text layout of MuPDF's text box appearance (pdf_write_free_text_appearance), so the editor wraps
 * and places lines exactly where they will be drawn: text inset by 1.5 x the border width, first
 * baseline 0.8 em below that, lines 1.2 em apart.
 */
export function freeTextLayout(size: number, border: number) {
  const inset = 1.5 * Math.max(0, border)
  return { inset, firstBaseline: inset + 0.8 * size, lineHeight: 1.2 * size }
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
  const sc = geometry.scale
  const size = a.fontSize ?? 12
  const layout = freeTextLayout(size, a.borderWidth)
  const padX = layout.inset * sc
  // Line boxes start a little above the rect when the text sits close to the top edge.
  let padTop = (layout.firstBaseline - CSS_BASELINE * size) * sc
  let dy = 0
  if (padTop < 0) {
    dy = padTop
    padTop = 0
  }
  const baseHeight = (box.height as number) - dy

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
    el.style.height = `${baseHeight}px`
    setExtra(Math.max(0, el.scrollHeight - baseHeight))
  }, [text, baseHeight])

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
      const needed = ((ref.current?.scrollHeight ?? 0) + dy) / sc
      const h = a.rect[3] - a.rect[1]
      if (needed > h + 1 && geometry.rotation === 0) spec.rect = [a.rect[0], a.rect[1], a.rect[2], Math.min(geometry.height, a.rect[1] + needed)]
      if (Object.keys(spec).length) await annotsOf(doc).update(a.id, spec, a.page)
    } catch (err) {
      showError(err, 'Could not save the text')
    }
  }

  // The box keeps its top edge (page orientation) and grows downwards while typing.
  const height = baseHeight + extra
  const center = { x: (box.left as number) + (box.width as number) / 2, y: (box.top as number) + (box.height as number) / 2 }
  const shift = (extra + dy) / 2
  return (
    <textarea
      ref={ref}
      className="fc-comments-inline-editor"
      aria-label="Text box text"
      value={text}
      spellCheck
      style={{
        left: origin.x + center.x - (box.width as number) / 2,
        top: origin.y + center.y - height / 2,
        width: box.width,
        height,
        transform: `rotate(${geometry.rotation}deg) translateY(${shift}px)`,
        fontSize: size * sc,
        lineHeight: 1.2,
        color: a.textColor ?? '#000',
        fontFamily: FONT_FAMILY[a.fontName ?? ''] ?? FONT_FAMILY.Helv,
        textAlign: (['left', 'center', 'right'] as const)[a.quadding] ?? 'left',
        padding: `${padTop}px ${padX}px ${padX}px`,
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
      // above the comment, else below it, else pinned to the edge of the visible area
      const visTop = vp.scrollTop + 8
      const visBottom = vp.scrollTop + vp.clientHeight - 8
      const above = o.y + css.top - 46
      const below = o.y + css.top + css.height + 10
      const inView = o.y + css.top < visBottom && below > visTop
      const top = !inView || above >= visTop ? above : below + 38 <= visBottom ? below : visTop
      inspector = (
        <Inspector
          key={t.root.id}
          doc={doc}
          annot={t.root}
          left={o.x + css.left}
          top={top}
          minLeft={vp.scrollLeft + 8}
          maxRight={vp.scrollLeft + vp.clientWidth - 8}
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
          // First placement: next to the comment, inside the visible part of the document.
          const visLeft = vp.scrollLeft + 8
          const visRight = vp.scrollLeft + vp.clientWidth - 8
          const visTop = vp.scrollTop + 8
          const visBottom = vp.scrollTop + vp.clientHeight - 8
          left = o.x + css.left + css.width + 14
          if (left + p.width > visRight) {
            // not enough room on the right: open on the left of the comment, else as far right as fits
            const onLeft = o.x + css.left - p.width - 14
            left = onLeft >= visLeft ? onLeft : Math.max(visLeft, visRight - p.width)
          }
          top = o.y + Math.max(0, css.top - 4)
          top = Math.max(visTop, Math.min(top, visBottom - 220))
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
