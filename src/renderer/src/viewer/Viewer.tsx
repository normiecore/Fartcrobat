import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ZoomMode } from '@shared/types'
import { useDocState, type DocumentModel, type ViewController } from '../document/DocumentModel'
import { useApp } from '../app/store'
import { PageGeometry } from './geometry'
import { clampZoom, computeLayout, fitZoom, spreads, spreadIndexOf, type ViewLayout } from './layout'
import { PageView } from './PageView'

const OVERSCAN = 800

interface Anchor {
  page: number
  fx: number
  fy: number
  clientX: number
  clientY: number
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
  const pendingScrollRef = useRef<{ page: number; x?: number | null; y?: number | null } | null>(null)
  const continuous = layoutMode === 'continuous' || layoutMode === 'two-page-continuous'

  // Track the viewport size.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // Fit modes recompute the zoom when the viewport or page changes.
  useEffect(() => {
    if (zoomMode === 'custom') return
    const z = fitZoom(zoomMode, info.pages, {
      currentPage,
      rotation,
      layout: layoutMode,
      cover,
      width: size.width,
      height: size.height
    })
    if (z !== null && Math.abs(z - doc.state.zoom) > 0.0005) doc.set({ zoom: z })
  }, [doc, zoomMode, info.pages, currentPage, rotation, layoutMode, cover, size.width, size.height])

  const layout: ViewLayout = useMemo(
    () =>
      computeLayout(info.pages, {
        zoom,
        rotation,
        mode: layoutMode,
        cover,
        containerWidth: size.width,
        currentPage
      }),
    // currentPage only matters for non-continuous modes
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [info.pages, zoom, rotation, layoutMode, cover, size.width, continuous ? 0 : currentPage]
  )
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // After a layout change, restore the scroll position: explicit navigation first, then the point
  // under the cursor (zoom with Ctrl+wheel), otherwise keep the top page where it was.
  const topAnchorRef = useRef<{ page: number; fx: number; fy: number } | null>(null)
  const [navTick, setNavTick] = useState(0)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const b = el.getBoundingClientRect()
    const p = pendingScrollRef.current
    const a = anchorRef.current
    const t = topAnchorRef.current
    if (p) {
      const slot = layout.slots[p.page]
      if (!slot) return
      pendingScrollRef.current = null
      anchorRef.current = null
      const pg = info.pages[p.page]
      const g = new PageGeometry(p.page, pg.width, pg.height, zoom, rotation)
      let top = slot.y - 8
      let left = el.scrollLeft
      if (p.y !== null && p.y !== undefined) {
        const c = g.toCss([p.x ?? 0, p.y])
        top = slot.y + c[1] - 8
        if (p.x !== null && p.x !== undefined && (c[0] < el.scrollLeft || c[0] > el.scrollLeft + el.clientWidth))
          left = Math.max(0, slot.x + c[0] - 16)
      }
      el.scrollTop = top
      el.scrollLeft = left
    } else if (a) {
      anchorRef.current = null
      const slot = layout.slots[a.page]
      if (!slot) return
      el.scrollLeft = slot.x + a.fx * slot.width - (a.clientX - b.left)
      el.scrollTop = slot.y + a.fy * slot.height - (a.clientY - b.top)
    } else if (t) {
      const slot = layout.slots[t.page]
      if (!slot) return
      el.scrollTop = slot.y + t.fy * slot.height
      if (el.scrollWidth > el.clientWidth) el.scrollLeft = slot.x + t.fx * slot.width
    }
    setScroll({ top: el.scrollTop, left: el.scrollLeft })
    // info/zoom/rotation are captured through layout
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, navTick])

  const updateCurrentPage = useCallback(() => {
    const el = scrollRef.current
    if (!el || !continuous) return
    const mid = el.scrollTop + Math.min(el.clientHeight * 0.35, 300)
    const slots = layoutRef.current.slots
    let best = doc.state.currentPage
    for (const s of slots) {
      if (!s) continue
      if (s.y <= mid && s.y + s.height + 12 > mid) {
        best = s.index
        break
      }
    }
    if (best !== doc.state.currentPage) doc.set({ currentPage: best })
  }, [doc, continuous])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    setScroll({ top: el.scrollTop, left: el.scrollLeft })
    updateCurrentPage()
    const slots = layoutRef.current.slots
    const top = el.scrollTop
    const slot = slots.find((sl) => sl && sl.y + sl.height + 12 > top)
    if (slot) {
      topAnchorRef.current = {
        page: slot.index,
        fy: (top - slot.y) / slot.height,
        fx: el.scrollWidth > el.clientWidth ? (el.scrollLeft - slot.x) / slot.width : 0
      }
    }
  }

  // ---- view controller ------------------------------------------------------------------

  useEffect(() => {
    const setZoom = (z: number | ZoomMode, anchor?: { clientX: number; clientY: number }) => {
      const el = scrollRef.current
      if (typeof z === 'string') {
        doc.set({ zoomMode: z })
        return
      }
      const nz = clampZoom(z)
      if (el) {
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
    const controller: ViewController = {
      goToPage(index, opts) {
        const n = doc.pageCount
        const page = Math.max(0, Math.min(n - 1, index))
        const from = doc.state.currentPage
        if (page !== from && !(opts as { fromHistory?: boolean } | undefined)?.fromHistory) {
          doc.history.back.push(from)
          if (doc.history.back.length > 100) doc.history.back.shift()
          doc.history.forward.length = 0
        }
        doc.set({ currentPage: page })
        pendingScrollRef.current = { page, x: opts?.x, y: opts?.y }
        setNavTick((n) => n + 1)
      },
      scrollToRect(page, rect, opts) {
        const el = scrollRef.current
        const slot = layoutRef.current.slots[page]
        if (!el) return
        if (!slot) {
          controller.goToPage(page)
          return
        }
        const pg = doc.state.info.pages[page]
        const g = new PageGeometry(page, pg.width, pg.height, doc.state.zoom, doc.state.viewRotation)
        const c = g.rectToCss(rect)
        const top = slot.y + c.top
        const left = slot.x + c.left
        const visible =
          top >= el.scrollTop + 20 &&
          top + c.height <= el.scrollTop + el.clientHeight - 20 &&
          left >= el.scrollLeft &&
          left + c.width <= el.scrollLeft + el.clientWidth
        if (!visible) {
          el.scrollTop = opts?.center ? top - el.clientHeight / 2 + c.height / 2 : top - el.clientHeight / 3
          if (left < el.scrollLeft || left + c.width > el.scrollLeft + el.clientWidth) el.scrollLeft = left - el.clientWidth / 3
        }
        if (!continuous && doc.state.currentPage !== page) doc.set({ currentPage: page })
      },
      setZoom,
      scrollBy(dx, dy) {
        scrollRef.current?.scrollBy(dx, dy)
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
          // nearest page vertically
          let d = Infinity
          for (const s of slots) {
            const dy = y < s.y ? s.y - y : y > s.y + s.height ? y - s.y - s.height : 0
            if (dy < d) {
              d = dy
              best = s
            }
          }
        }
        if (!best) return null
        const pg = doc.state.info.pages[best.index]
        const g = new PageGeometry(best.index, pg.width, pg.height, doc.state.zoom, doc.state.viewRotation)
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
        doc.view?.setZoom(doc.state.zoom * factor, { clientX: e.clientX, clientY: e.clientY })
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
              zoom={zoom}
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
