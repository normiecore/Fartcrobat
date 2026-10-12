import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Rect } from '@shared/geometry'
import type { ZoomMode } from '@shared/types'
import { useDocState, type DocumentModel, type ViewController } from '../document/DocumentModel'
import { useApp } from '../app/store'
import { PageGeometry } from './geometry'
import { clampZoom, computeLayout, fitZoom, PAGE_GAP, spreads, spreadIndexOf, type PageSlot, type ViewLayout } from './layout'
import { PageView } from './PageView'

const OVERSCAN = 800

/** The point under the cursor while zooming, kept in place by the next layout. */
interface Anchor {
  page: number
  fx: number
  fy: number
  clientX: number
  clientY: number
}

/** The top-left of the viewport relative to a page, kept in place across layout changes. */
interface TopAnchor {
  page: number
  fx: number
  fy: number
}

/** A navigation waiting for the layout that contains its page. */
interface PendingScroll {
  page: number
  x?: number | null
  y?: number | null
  /** Reveal this page-space rect (instead of the page top or x/y). */
  rect?: Rect
  center?: boolean
}

/** Where the viewport's top edge is, as a page and a fraction of it. */
function topAnchorOf(el: HTMLElement, layout: ViewLayout): TopAnchor | null {
  const top = el.scrollTop
  const slot = layout.slots.find((s) => s && s.y + s.height + PAGE_GAP > top)
  if (!slot) return null
  return {
    page: slot.index,
    fy: (top - slot.y) / slot.height,
    fx: el.scrollWidth > el.clientWidth ? (el.scrollLeft - slot.x) / slot.width : 0
  }
}

/** Scrolls so that a page-space rect on a laid-out page is visible (only when it is not already). */
function scrollRectIntoView(el: HTMLElement, slot: PageSlot, g: PageGeometry, rect: Rect, center?: boolean) {
  const c = g.rectToCss(rect)
  const top = slot.y + c.top
  const left = slot.x + c.left
  const vVisible = top >= el.scrollTop + 20 && top + c.height <= el.scrollTop + el.clientHeight - 20
  const hVisible = left >= el.scrollLeft && left + c.width <= el.scrollLeft + el.clientWidth
  if (vVisible && hVisible) return
  el.scrollTop = center ? top - el.clientHeight / 2 + c.height / 2 : top - el.clientHeight / 3
  if (!hVisible) el.scrollLeft = left - el.clientWidth / 3
}

export function Viewer({ doc }: { doc: DocumentModel }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const info = useDocState(doc, (s) => s.info)
  const zoom = useDocState(doc, (s) => s.zoom)
  const zoomMode = useDocState(doc, (s) => s.zoomMode)
  const layoutMode = useDocState(doc, (s) => s.layout)
  const cover = useDocState(doc, (s) => s.coverPage)
  const rotation = useDocState(doc, (s) => s.viewRotation)
  const currentPage = useDocState(doc, (s) => s.currentPage)
  const toolId = useApp((s) => (s.spaceHand ? 'hand' : s.toolId))
  const [size, setSize] = useState({ width: 800, height: 600 })
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const anchorRef = useRef<Anchor | null>(null)
  const pendingScrollRef = useRef<PendingScroll | null>(null)
  const continuous = layoutMode === 'continuous' || layoutMode === 'two-page-continuous'

  // Track the viewport size. `.viewer-scroll` reserves the scrollbar gutter, so the width does not
  // change when a vertical scrollbar appears (which would change a Fit Width zoom, which would
  // hide the scrollbar again...).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // In Single Page and Two Page View only the current spread is laid out. It is identified by its
  // first page, so moving within a spread changes neither the layout nor a fit zoom.
  const rows = useMemo(() => spreads(info.pages.length, layoutMode, cover), [info.pages.length, layoutMode, cover])
  const shownRowPage = continuous ? 0 : (rows[spreadIndexOf(rows, currentPage)]?.[0] ?? 0)

  // Fit modes derive the zoom from the viewport; the store follows (below) for everyone else.
  const fitTarget = useMemo(
    () =>
      fitZoom(zoomMode, info.pages, {
        currentPage: shownRowPage,
        rotation,
        layout: layoutMode,
        cover,
        width: size.width,
        height: size.height
      }),
    [zoomMode, info.pages, shownRowPage, rotation, layoutMode, cover, size.width, size.height]
  )
  const viewZoom = fitTarget ?? zoom
  const zoomRef = useRef(viewZoom)
  zoomRef.current = viewZoom
  useLayoutEffect(() => {
    if (fitTarget !== null && doc.state.zoom !== fitTarget) doc.set({ zoom: fitTarget })
  }, [doc, fitTarget, zoom])

  const layout: ViewLayout = useMemo(
    () =>
      computeLayout(info.pages, {
        zoom: viewZoom,
        rotation,
        mode: layoutMode,
        cover,
        containerWidth: size.width,
        currentPage: shownRowPage
      }),
    [info.pages, viewZoom, rotation, layoutMode, cover, size.width, shownRowPage]
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // After a layout change, restore the scroll position: explicit navigation first, then the point
  // under the cursor (zoom with Ctrl+wheel), otherwise keep the top page where it was. The top
  // anchor is then re-read synchronously, so a second layout change in the same frame (before
  // any scroll event) starts from where this one left the view, not from an older position.
  const topAnchorRef = useRef<TopAnchor | null>(null)
  const [navTick, setNavTick] = useState(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const b = el.getBoundingClientRect()
    const p = pendingScrollRef.current
    const a = anchorRef.current
    const t = topAnchorRef.current
    if (p && p.page >= info.pages.length) pendingScrollRef.current = null
    const pSlot = p ? layout.slots[p.page] : undefined
    if (p && pSlot) {
      pendingScrollRef.current = null
      anchorRef.current = null
      const pg = info.pages[p.page]
      const g = new PageGeometry(p.page, pg.width, pg.height, viewZoom, rotation)
      if (p.rect) {
        scrollRectIntoView(el, pSlot, g, p.rect, p.center)
      } else {
        let top = pSlot.y - 8
        let left = el.scrollLeft
        if (p.y !== null && p.y !== undefined) {
          const c = g.toCss([p.x ?? 0, p.y])
          top = pSlot.y + c[1] - 8
          if (p.x !== null && p.x !== undefined && (c[0] < el.scrollLeft || c[0] > el.scrollLeft + el.clientWidth))
            left = Math.max(0, pSlot.x + c[0] - 16)
        }
        el.scrollTop = top
        el.scrollLeft = left
      }
    } else if (a) {
      anchorRef.current = null
      const slot = layout.slots[a.page]
      if (slot) {
        el.scrollLeft = slot.x + a.fx * slot.width - (a.clientX - b.left)
        el.scrollTop = slot.y + a.fy * slot.height - (a.clientY - b.top)
      }
    } else if (t) {
      const slot = layout.slots[t.page]
      if (slot) {
        el.scrollTop = slot.y + t.fy * slot.height
        if (el.scrollWidth > el.clientWidth) el.scrollLeft = slot.x + t.fx * slot.width
      }
    }
    topAnchorRef.current = topAnchorOf(el, layout) ?? topAnchorRef.current
    setScroll({ top: el.scrollTop, left: el.scrollLeft })
    // info/zoom/rotation are captured through layout
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, navTick])

  const updateCurrentPage = useCallback(() => {
    const el = scrollRef.current
    if (!el || !continuous) return
    const top = el.scrollTop
    const slots = layoutRef.current.slots
    const cur = doc.state.currentPage
    // Keep the current page while it is entirely in view: after Last Page (or any navigation to
    // a page near the end) the view cannot scroll that page to the top, and the probe below would
    // pick an earlier page.
    const cs = slots[cur]
    if (cs && cs.y >= top - 1 && cs.y + cs.height <= top + el.clientHeight + 1) return
    const mid = top + Math.min(el.clientHeight * 0.35, 300)
    let best = cur
    for (const s of slots) {
      if (!s) continue
      if (s.y <= mid && s.y + s.height + PAGE_GAP > mid) {
        best = s.index
        break
      }
    }
    if (best !== cur) doc.set({ currentPage: best })
  }, [doc, continuous])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    // A zoom anchor only applies to the layout change it was made for.
    anchorRef.current = null
    setScroll({ top: el.scrollTop, left: el.scrollLeft })
    updateCurrentPage()
    topAnchorRef.current = topAnchorOf(el, layoutRef.current) ?? topAnchorRef.current
  }

  // ---- view controller ------------------------------------------------------------------

  useEffect(() => {
    const syncTopAnchor = () => {
      const el = scrollRef.current
      if (el) topAnchorRef.current = topAnchorOf(el, layoutRef.current) ?? topAnchorRef.current
    }
    const setZoom = (z: number | ZoomMode, anchor?: { clientX: number; clientY: number }) => {
      const el = scrollRef.current
      if (typeof z === 'string') {
        doc.set({ zoomMode: z })
        return
      }
      const nz = clampZoom(z)
      anchorRef.current = null
      // Only a real zoom change re-lays out (and consumes the anchor); an unchanged zoom (at a
      // limit, or the current value) must not leave an anchor behind for a later layout change.
      if (el && nz !== zoomRef.current) {
        const b = el.getBoundingClientRect()
        const cx = anchor?.clientX ?? b.left + el.clientWidth / 2
        const cy = anchor?.clientY ?? b.top + el.clientHeight / 2
        const x = el.scrollLeft + (cx - b.left)
        const y = el.scrollTop + (cy - b.top)
        const slots = layoutRef.current.slots.filter(Boolean)
        let slot = slots.find((s) => y >= s.y && y <= s.y + s.height) ?? slots.find((s) => s.index === doc.state.currentPage)
        if (!slot) slot = slots[0]
        if (slot) {
          anchorRef.current = {
            page: slot.index,
            fx: (x - slot.x) / slot.width,
            fy: (y - slot.y) / slot.height,
            clientX: cx,
            clientY: cy
          }
        }
      }
      doc.set({ zoom: nz, zoomMode: 'custom' })
    }
    const navigate = (index: number, target: Omit<PendingScroll, 'page'>, fromHistory?: boolean) => {
      const n = doc.pageCount
      const page = Math.max(0, Math.min(n - 1, index))
      const from = doc.state.currentPage
      if (page !== from && !fromHistory) {
        doc.history.back.push(from)
        if (doc.history.back.length > 100) doc.history.back.shift()
        doc.history.forward.length = 0
      }
      doc.set({ currentPage: page })
      pendingScrollRef.current = { page, ...target }
      setNavTick((n) => n + 1)
    }
    const controller: ViewController = {
      goToPage(index, opts) {
        navigate(index, { x: opts?.x, y: opts?.y }, opts?.fromHistory)
      },
      scrollToRect(page, rect, opts) {
        const el = scrollRef.current
        if (!el) return
        const slot = layoutRef.current.slots[page]
        if (!slot) {
          // Another spread in Single/Two Page View: show it, then reveal the rect once laid out.
          navigate(page, { rect, center: opts?.center })
          return
        }
        const pg = doc.state.info.pages[page]
        const g = new PageGeometry(page, pg.width, pg.height, zoomRef.current, doc.state.viewRotation)
        scrollRectIntoView(el, slot, g, rect, opts?.center)
        syncTopAnchor()
        if (!continuous && doc.state.currentPage !== page) doc.set({ currentPage: page })
      },
      setZoom,
      scrollBy(dx, dy) {
        scrollRef.current?.scrollBy(dx, dy)
        syncTopAnchor()
      },
      getViewportElement() {
        return scrollRef.current
      },
      visiblePages() {
        const el = scrollRef.current
        if (!el) return []
        const top = el.scrollTop
        const bottom = top + el.clientHeight
        return layoutRef.current.slots
          .filter((s) => s && s.y < bottom && s.y + s.height > top)
          .map((s) => ({ i: s.index, v: Math.min(bottom, s.y + s.height) - Math.max(top, s.y) }))
          .sort((a, b) => b.v - a.v)
          .map((x) => x.i)
      },
      hitTest(clientX, clientY) {
        const el = scrollRef.current
        if (!el) return null
        const b = el.getBoundingClientRect()
        const x = el.scrollLeft + clientX - b.left
        const y = el.scrollTop + clientY - b.top
        const slots = layoutRef.current.slots.filter(Boolean)
        let best = slots.find((s) => y >= s.y && y <= s.y + s.height && x >= s.x - 12 && x <= s.x + s.width + 12)
        if (!best) {
          // nearest page (pages side by side in a spread are told apart horizontally)
          let d = Infinity
          for (const s of slots) {
            const dx = x < s.x ? s.x - x : x > s.x + s.width ? x - s.x - s.width : 0
            const dy = y < s.y ? s.y - y : y > s.y + s.height ? y - s.y - s.height : 0
            const dist = Math.hypot(dx, dy)
            if (dist < d) {
              d = dist
              best = s
            }
          }
        }
        if (!best) return null
        const pg = doc.state.info.pages[best.index]
        const g = new PageGeometry(best.index, pg.width, pg.height, zoomRef.current, doc.state.viewRotation)
        const lx = Math.max(0, Math.min(best.width, x - best.x))
        const ly = Math.max(0, Math.min(best.height, y - best.y))
        return { pageIndex: best.index, point: g.toPage([lx, ly]) }
      }
    }
    doc.view = controller
    // Restore the position when the tab becomes visible again.
    if (doc.state.currentPage > 0) {
      pendingScrollRef.current = { page: doc.state.currentPage }
      setNavTick((n) => n + 1)
    }
    return () => {
      if (doc.view === controller) doc.view = null
    }
  }, [doc, continuous])

  // Ctrl/Cmd + wheel zooms around the cursor; in single-page modes the wheel turns pages.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025))
        doc.view?.setZoom(zoomRef.current * factor, { clientX: e.clientX, clientY: e.clientY })
        return
      }
      if (!continuous) {
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
        const atTop = el.scrollTop <= 0
        const rows = spreads(doc.pageCount, doc.state.layout, doc.state.coverPage)
        const ri = spreadIndexOf(rows, doc.state.currentPage)
        if (e.deltaY > 0 && atBottom && ri < rows.length - 1) {
          e.preventDefault()
          doc.set({ currentPage: rows[ri + 1][0] })
          el.scrollTop = 0
        } else if (e.deltaY < 0 && atTop && ri > 0) {
          e.preventDefault()
          doc.set({ currentPage: rows[ri - 1][0] })
          requestAnimationFrame(() => (el.scrollTop = el.scrollHeight))
        }
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [doc, continuous])

  // Visible pages (virtualisation)
  const viewTop = scroll.top - OVERSCAN
  const viewBottom = scroll.top + size.height + OVERSCAN
  const visible = layout.visibleIndices.filter((i) => {
    const s = layout.slots[i]
    return s && s.y + s.height >= viewTop && s.y <= viewBottom
  })
  const centerY = scroll.top + size.height / 2

  return (
    <div
      ref={scrollRef}
      className={`viewer-scroll tool-${toolId}`}
      tabIndex={0}
      onScroll={onScroll}
      data-doc-id={doc.id}
    >
      <div className="viewer-content" style={{ width: layout.width, height: layout.height }}>
        {visible.map((i) => {
          const s = layout.slots[i]
          const p = info.pages[i]
          const inView = s.y + s.height >= scroll.top && s.y <= scroll.top + size.height
          const vr = inView
            ? {
                left: Math.max(0, scroll.left - s.x),
                top: Math.max(0, scroll.top - s.y),
                width: Math.min(s.width, scroll.left + size.width - s.x) - Math.max(0, scroll.left - s.x),
                height: Math.min(s.height, scroll.top + size.height - s.y) - Math.max(0, scroll.top - s.y)
              }
            : null
          return (
            <PageView
              key={p.id}
              doc={doc}
              pageIndex={i}
              width={p.width}
              height={p.height}
              zoom={viewZoom}
              rotation={rotation}
              left={s.x}
              top={s.y}
              priority={inView ? Math.abs(s.y + s.height / 2 - centerY) / 10000 : 10 + Math.abs(s.y - centerY) / 10000}
              visibleRect={vr}
            />
          )
        })}
      </div>
    </div>
  )
}
