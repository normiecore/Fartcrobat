import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownUp,
  ChevronDown,
  ChevronUp,
  Columns2,
  FileOutput,
  FilePlus2,
  GitCompareArrows,
  Layers,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import {
  Button,
  displayShortcut,
  IconButton,
  nextZoomStep,
  openToolGroup,
  Segmented,
  useApp,
  type DocumentModel,
  type PageGeometry
} from '@renderer/sdk'
import { describeChange } from './core'
import { compareBlocker, exportReport, runCompare, selectChange, stepChange } from './actions'
import { ChooseFileButton, dropProps, SIDE_LABEL, SlotStatus } from './FileChoice'
import { swapSlots } from './sources'
import { PageImage } from './PageImage'
import { clampZoom, computeLayout, fitWidthZoom, HEAD_H, LABEL_H, visibleRows, type RowLayout, type ViewLayout } from './layout'
import { getCompare, setCompare, useCompare, type Session, type Side } from './store'
import { categoryOf, type Change } from './types'

const OVERSCAN = 700

// ---- setup ------------------------------------------------------------------------------------

function FileCard({ side }: { side: Side }) {
  const slot = useCompare((s) => s.slots[side])
  const [over, setOver] = useState(false)
  const doc = slot.doc
  const page = doc?.state.info.pages[0]
  const thumbW = 150
  const thumbH = page ? Math.min(220, (thumbW * page.height) / page.width) : 190
  const cssW = page ? (thumbH * page.width) / page.height : thumbW
  return (
    <div className={`fc-compare-card ${over ? 'is-drop' : ''} ${doc ? 'has-file' : ''}`} {...dropProps(side, setOver)}>
      <div className="fc-compare-card-label">
        <span className={`fc-compare-tag fc-compare-tag--${side}`}>{side === 'old' ? 'Old' : 'New'}</span>
        {SIDE_LABEL[side]}
      </div>
      <div className="fc-compare-card-thumb" style={{ height: 224 }}>
        {doc && page ? (
          <div className="fc-compare-card-page" style={{ width: cssW, height: thumbH }}>
            <PageImage doc={doc} pageIndex={0} pageWidth={page.width} pageHeight={page.height} cssWidth={cssW} cssHeight={thumbH} />
          </div>
        ) : (
          <div className="fc-compare-card-empty">
            <FilePlus2 size={36} strokeWidth={1.4} />
            <span>Drop a file here</span>
          </div>
        )}
      </div>
      <div className="fc-compare-card-name" title={slot.path ?? slot.name}>
        {slot.name || 'No file chosen'}
      </div>
      <SlotStatus side={side} />
      <ChooseFileButton side={side} variant={doc ? 'secondary' : 'primary'} size="md" />
    </div>
  )
}

function SetupLanding() {
  const blocker = useCompare(() => compareBlocker())
  const running = useCompare((s) => !!s.running)
  return (
    <div className="fc-compare-landing">
      <div className="fc-compare-landing-inner">
        <h2>Compare files</h2>
        <p className="fc-compare-muted">
          Choose the old and new versions of a document. Drop files on the boxes, or pick them from your open documents, recent
          files or your computer.
        </p>
        <div className="fc-compare-cards">
          <FileCard side="old" />
          <div className="fc-compare-cards-mid">
            <IconButton icon={ArrowDownUp} label="Swap old and new files" onClick={swapSlots} className="fc-compare-swap-h" />
          </div>
          <FileCard side="new" />
        </div>
        <div className="fc-compare-landing-actions">
          <Button variant="primary" icon={GitCompareArrows} disabled={!!blocker || running} onClick={() => void runCompare()}>
            Compare
          </Button>
          {blocker && !running && <span className="fc-compare-muted">{blocker}</span>}
        </div>
      </div>
    </div>
  )
}

function ProgressCard() {
  const running = useCompare((s) => s.running)
  if (!running) return null
  const pct = Math.round(running.fraction * 100)
  return (
    <div className="fc-compare-progress-wrap">
      <div className="fc-compare-progress" role="progressbar" aria-label="Comparing documents" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="fc-compare-progress-title">Comparing documents…</div>
        <div className="fc-compare-progress-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="fc-compare-muted fc-compare-progress-msg">{running.message}</div>
        <Button onClick={running.cancel}>Cancel</Button>
      </div>
    </div>
  )
}

// ---- results ----------------------------------------------------------------------------------

type ByPage = Map<number, Change[]>

const isPageChange = (c: Change) => c.type === 'pageAdded' || c.type === 'pageRemoved' || c.type === 'pageMoved'

function Highlights({
  changes,
  side,
  geometry,
  selected
}: {
  changes: Change[]
  side: Side
  geometry: PageGeometry
  selected: number | null
}) {
  return (
    <>
      {changes.map((c) => {
        const part = side === 'old' ? c.old : c.new
        if (!part || isPageChange(c)) return null
        const cat = categoryOf(c.type)
        return part.rects.map((r, k) => {
          const css = geometry.rectToCss(r)
          const pad = part.anchor ? 0 : 1.5
          return (
            <div
              key={`${c.id}-${k}`}
              data-change-id={c.id}
              data-side={side}
              className={`fc-compare-hl fc-compare-hl--${cat} ${part.anchor ? 'is-anchor' : ''} ${c.id === selected ? 'is-selected' : ''}`}
              style={{
                left: css.left - pad - (part.anchor ? 1 : 0),
                top: css.top - pad,
                width: part.anchor ? 3 : css.width + 2 * pad,
                height: css.height + 2 * pad
              }}
              title={`${c.id}. ${describeChange(c)}${c.detail && c.type !== 'image' ? ` — ${c.detail}` : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                selectChange(c.id, false)
              }}
            />
          )
        })
      })}
    </>
  )
}

function pageBadges(changes: Change[], side: Side): { label: string; cls: string; id: number }[] {
  const out: { label: string; cls: string; id: number }[] = []
  for (const c of changes) {
    if (c.type === 'pageAdded' && side === 'new') out.push({ label: 'Added', cls: 'inserted', id: c.id })
    if (c.type === 'pageRemoved' && side === 'old') out.push({ label: 'Removed', cls: 'deleted', id: c.id })
    if (c.type === 'pageMoved')
      out.push({
        label: side === 'new' ? `Moved from page ${c.old!.page + 1}` : `Moved to page ${c.new!.page + 1}`,
        cls: 'page',
        id: c.id
      })
  }
  return out
}

const PageBox = memo(function PageBox({
  doc,
  side,
  slot,
  changes,
  selected,
  priority,
  stacked
}: {
  doc: DocumentModel
  side: Side
  slot: NonNullable<RowLayout['old']>
  changes: Change[]
  selected: number | null
  priority: number
  stacked?: boolean
}) {
  const g = slot.geometry
  const badges = pageBadges(changes, side)
  const frame = badges.length ? `is-${badges[0].cls}` : ''
  const sel = badges.some((b) => b.id === selected)
  const info = doc.state.info.pages[slot.page]
  return (
    <>
      {!stacked && (
        <div className="fc-compare-page-label" style={{ left: slot.x, top: slot.y - LABEL_H, width: g.cssWidth }}>
          <span>
            {side === 'old' ? 'Old' : 'New'} · page {slot.page + 1}
          </span>
          {badges.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`fc-compare-badge fc-compare-badge--${b.cls}`}
              onClick={() => selectChange(b.id, false)}
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
      <div
        className={`fc-compare-page ${frame} ${sel ? 'is-selected' : ''} ${stacked ? 'is-stacked' : ''}`}
        data-side={side}
        data-page={slot.page}
        style={{ left: slot.x, top: slot.y, width: g.cssWidth, height: g.cssHeight }}
      >
        {!stacked &&
          (doc.isClosed ? (
            <div className="fc-compare-closed">This document was closed</div>
          ) : (
            <PageImage
              doc={doc}
              pageIndex={slot.page}
              pageWidth={info?.width ?? g.width}
              pageHeight={info?.height ?? g.height}
              cssWidth={g.cssWidth}
              cssHeight={g.cssHeight}
              priority={priority}
            />
          ))}
        <Highlights changes={changes} side={side} geometry={g} selected={selected} />
      </div>
    </>
  )
})

function OverlayStack({ session, row, priority }: { session: Session; row: RowLayout; priority: number }) {
  const o = row.old
  const n = row.new
  const base = (n ?? o)!
  const w = base.geometry.cssWidth
  const h = Math.max(o?.geometry.cssHeight ?? 0, n?.geometry.cssHeight ?? 0)
  return (
    <>
      <div className="fc-compare-page-label" style={{ left: base.x, top: base.y - LABEL_H, width: w }}>
        <span>
          {o ? `Old page ${o.page + 1}` : 'Not in the old file'} · {n ? `new page ${n.page + 1}` : 'not in the new file'}
        </span>
      </div>
      <div className="fc-compare-overlay-stack" style={{ left: base.x, top: base.y, width: w, height: h }}>
        {o && !session.old.doc.isClosed && (
          <PageImage
            doc={session.old.doc}
            pageIndex={o.page}
            pageWidth={o.geometry.width}
            pageHeight={o.geometry.height}
            cssWidth={o.geometry.cssWidth}
            cssHeight={o.geometry.cssHeight}
            priority={priority}
            className="fc-compare-overlay-old"
          />
        )}
        {n && !session.new.doc.isClosed && (
          <PageImage
            doc={session.new.doc}
            pageIndex={n.page}
            pageWidth={n.geometry.width}
            pageHeight={n.geometry.height}
            cssWidth={n.geometry.cssWidth}
            cssHeight={n.geometry.cssHeight}
            priority={priority}
            className="fc-compare-overlay-new"
          />
        )}
      </div>
      {o && n && !session.new.doc.isClosed && (
        // A faint copy of the new page on top keeps the matching content readable as light grey.
        <div className="fc-compare-overlay-ghost" style={{ left: base.x, top: base.y, width: w, height: h }}>
          <PageImage
            doc={session.new.doc}
            pageIndex={n.page}
            pageWidth={n.geometry.width}
            pageHeight={n.geometry.height}
            cssWidth={n.geometry.cssWidth}
            cssHeight={n.geometry.cssHeight}
            priority={priority + 1}
          />
        </div>
      )}
    </>
  )
}

function ResultsView({ session }: { session: Session }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const overlay = useCompare((s) => s.overlay)
  const zoomState = useCompare((s) => s.zoom)
  const fitWidth = useCompare((s) => s.fitWidth)
  const filter = useCompare((s) => s.filter)
  const selected = useCompare((s) => s.selected)
  const focusTick = useCompare((s) => s.focusTick)
  const [size, setSize] = useState({ width: 900, height: 600 })
  const [scroll, setScroll] = useState({ top: 0, left: 0 })
  const { result } = session
  const oldDoc = session.old.doc
  const newDoc = session.new.doc

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    ro.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const zoom = fitWidth ? fitWidthZoom(result.rows, oldDoc, newDoc, size.width, overlay) : zoomState
  const layout: ViewLayout = useMemo(
    () => computeLayout(result.rows, oldDoc, newDoc, zoom, size.width, overlay),
    [result.rows, oldDoc, newDoc, zoom, size.width, overlay]
  )

  const { oldBy, newBy } = useMemo(() => {
    const oldBy: ByPage = new Map()
    const newBy: ByPage = new Map()
    for (const c of result.changes) {
      if (!filter[categoryOf(c.type)]) continue
      if (c.old) oldBy.set(c.old.page, [...(oldBy.get(c.old.page) ?? []), c])
      if (c.new) newBy.set(c.new.page, [...(newBy.get(c.new.page) ?? []), c])
    }
    return { oldBy, newBy }
  }, [result.changes, filter])

  // Keep the point under the cursor (or the middle of the view) in place when the zoom or mode changes.
  const anchorRef = useRef<{ ratio: number; offset: number } | null>(null)
  const prevLayout = useRef(layout)
  useLayoutEffect(() => {
    const el = scrollRef.current
    const prev = prevLayout.current
    prevLayout.current = layout
    if (!el || prev === layout || prev.height === layout.height) return
    const a = anchorRef.current ?? { ratio: (el.scrollTop + el.clientHeight / 2) / prev.height, offset: el.clientHeight / 2 }
    anchorRef.current = null
    el.scrollTop = a.ratio * layout.height - a.offset
    setScroll({ top: el.scrollTop, left: el.scrollLeft })
  }, [layout])

  // Scroll to the selected change when asked (list click, next/previous).
  const handledTick = useRef(-1)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el || handledTick.current === focusTick) return
    handledTick.current = focusTick
    const c = result.changes.find((x) => x.id === selected)
    if (!c) return
    const spans: { top: number; bottom: number; left: number; right: number }[] = []
    for (const side of ['old', 'new'] as Side[]) {
      const part = side === 'old' ? c.old : c.new
      if (!part) continue
      const row = layout.rows.find((r) => r[side]?.page === part.page)
      const slot = row?.[side]
      if (!row || !slot) continue
      if (isPageChange(c)) {
        // whole pages: bring the top of the row under the column headers
        spans.push({ top: row.y, bottom: row.y + el.clientHeight, left: slot.x, right: slot.x + slot.geometry.cssWidth })
        continue
      }
      for (const r of part.rects) {
        const css = slot.geometry.rectToCss(r)
        spans.push({ top: slot.y + css.top, bottom: slot.y + css.top + css.height, left: slot.x + css.left, right: slot.x + css.left + css.width })
      }
    }
    if (!spans.length) return
    const top = Math.min(...spans.map((s) => s.top))
    const bottom = Math.max(...spans.map((s) => s.bottom))
    const viewH = el.clientHeight - HEAD_H
    let target: number
    if (bottom - top < viewH * 0.8) target = (top + bottom) / 2 - HEAD_H - viewH / 2
    else target = top - HEAD_H - 10
    el.scrollTop = Math.max(0, target)
    const left = Math.min(...spans.map((s) => s.left))
    const right = Math.max(...spans.map((s) => s.right))
    if (left < el.scrollLeft || right > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, (left + right) / 2 - el.clientWidth / 2)
    setScroll({ top: el.scrollTop, left: el.scrollLeft })
  }, [focusTick, selected, layout, result.changes])

  const setZoom = (z: number, anchorClientY?: number) => {
    const el = scrollRef.current
    if (el) {
      const offset = anchorClientY !== undefined ? anchorClientY - el.getBoundingClientRect().top : el.clientHeight / 2
      anchorRef.current = { ratio: (el.scrollTop + offset) / layout.height, offset }
    }
    setCompare({ zoom: clampZoom(z), fitWidth: false })
  }

  // Ctrl/Cmd + wheel zooms; Ctrl/Cmd +/-/0 zoom the comparison instead of the hidden document.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const z = getCompare().fitWidth ? zoom : getCompare().zoom
      setZoom(z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), e.clientY)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const app = useApp.getState()
      if (app.dialogs.length || app.paletteOpen) return
      const z = getCompare().fitWidth ? zoom : getCompare().zoom
      if (e.code === 'Equal' || e.code === 'NumpadAdd') setZoom(nextZoomStep(z, 1))
      else if (e.code === 'Minus' || e.code === 'NumpadSubtract') setZoom(nextZoomStep(z, -1))
      else if (e.code === 'Digit0' || e.code === 'Digit2') setCompare({ fitWidth: true })
      else if (e.code === 'Digit1') setZoom(1)
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const visible = visibleRows(layout, scroll.top - OVERSCAN, scroll.top + size.height + OVERSCAN)
  const center = scroll.top + size.height / 2
  const changes = result.changes.filter((c) => filter[categoryOf(c.type)])
  const index = changes.findIndex((c) => c.id === selected)
  const zoomPct = Math.round(zoom * 100)

  return (
    <div className="fc-compare-results">
      <div className="fc-compare-toolbar" role="toolbar" aria-label="Compare results">
        <div className="fc-compare-toolbar-group">
          <IconButton
            icon={ChevronUp}
            label="Previous change"
            shortcut={displayShortcut('Shift+F7')}
            disabled={!changes.length}
            onClick={() => stepChange(-1)}
          />
          <span className="fc-compare-counter" aria-live="polite">
            {changes.length ? (index >= 0 ? `Change ${index + 1} of ${changes.length}` : `${changes.length} changes`) : 'No changes'}
          </span>
          <IconButton
            icon={ChevronDown}
            label="Next change"
            shortcut={displayShortcut('F7')}
            disabled={!changes.length}
            onClick={() => stepChange(1)}
          />
        </div>
        <Segmented
          value={overlay ? 'overlay' : 'side'}
          onChange={(v) => setCompare({ overlay: v === 'overlay' })}
          options={[
            {
              value: 'side',
              label: (
                <span className="fc-compare-seg">
                  <Columns2 size={14} /> Side by side
                </span>
              ),
              title: 'Old and new pages next to each other'
            },
            {
              value: 'overlay',
              label: (
                <span className="fc-compare-seg">
                  <Layers size={14} /> Single page overlay
                </span>
              ),
              title: 'The new page drawn over the old one: matching content fades to white, differences stay dark'
            }
          ]}
        />
        <div className="fc-compare-toolbar-group">
          <IconButton icon={ZoomOut} label="Zoom out" shortcut={displayShortcut('Mod+-')} onClick={() => setZoom(nextZoomStep(zoom, -1))} />
          <button
            type="button"
            className={`fc-compare-zoom ${fitWidth ? 'is-fit' : ''}`}
            title={fitWidth ? 'Zoom: fit width' : 'Fit width'}
            aria-label={`Zoom ${zoomPct}%. Fit width`}
            onClick={() => setCompare({ fitWidth: true })}
          >
            {fitWidth ? `Fit · ${zoomPct}%` : `${zoomPct}%`}
          </button>
          <IconButton icon={ZoomIn} label="Zoom in" shortcut={displayShortcut('Mod+=')} onClick={() => setZoom(nextZoomStep(zoom, 1))} />
        </div>
        <span className="fc-compare-toolbar-spacer" />
        <IconButton icon={FileOutput} label="Export report" onClick={() => void exportReport()} />
        <IconButton icon={X} label="Close Compare files" onClick={() => openToolGroup(null)} />
      </div>
      <div
        ref={scrollRef}
        className={`fc-compare-scroll ${overlay ? 'is-overlay' : ''}`}
        tabIndex={0}
        aria-label="Compared pages"
        onScroll={(e) => setScroll({ top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}
        onKeyDown={(e) => {
          if ((e.key === 'n' || e.key === 'p') && !e.ctrlKey && !e.metaKey && !e.altKey) {
            e.preventDefault()
            stepChange(e.key === 'n' ? 1 : -1)
          }
        }}
      >
        <div className="fc-compare-content" style={{ width: layout.width, height: layout.height }}>
          <div className="fc-compare-colheads" style={{ width: layout.width }}>
            {overlay ? (
              <div className="fc-compare-colhead" style={{ left: layout.colOld.x, width: layout.colOld.width }}>
                <span className="fc-compare-tag fc-compare-tag--old">Old</span>
                <span className="fc-compare-colhead-name">{session.old.name}</span>
                <span className="fc-compare-colhead-plus">+</span>
                <span className="fc-compare-tag fc-compare-tag--new">New</span>
                <span className="fc-compare-colhead-name">{session.new.name}</span>
                <span className="fc-compare-colhead-hint">Matching content is pale, differences are dark</span>
              </div>
            ) : (
              <>
                <div className="fc-compare-colhead" style={{ left: layout.colOld.x, width: layout.colOld.width }} title={session.old.path ?? ''}>
                  <span className="fc-compare-tag fc-compare-tag--old">Old</span>
                  <span className="fc-compare-colhead-name">{session.old.name}</span>
                </div>
                <div className="fc-compare-colhead" style={{ left: layout.colNew.x, width: layout.colNew.width }} title={session.new.path ?? ''}>
                  <span className="fc-compare-tag fc-compare-tag--new">New</span>
                  <span className="fc-compare-colhead-name">{session.new.name}</span>
                </div>
              </>
            )}
          </div>
          {visible.map((row) => {
            const inView = row.y + row.height >= scroll.top && row.y <= scroll.top + size.height
            const priority = inView ? Math.abs(row.y + row.height / 2 - center) / 10000 : 10 + Math.abs(row.y - center) / 10000
            const oldChanges = row.old ? (oldBy.get(row.old.page) ?? []) : []
            const newChanges = row.new ? (newBy.get(row.new.page) ?? []) : []
            if (overlay) {
              return (
                <div key={row.index}>
                  <OverlayStack session={session} row={row} priority={priority} />
                  {row.old && (
                    <PageBox doc={oldDoc} side="old" slot={row.old} changes={oldChanges} selected={selected} priority={priority} stacked />
                  )}
                  {row.new && (
                    <PageBox doc={newDoc} side="new" slot={row.new} changes={newChanges} selected={selected} priority={priority} stacked />
                  )}
                </div>
              )
            }
            return (
              <div key={row.index}>
                {row.old && <PageBox doc={oldDoc} side="old" slot={row.old} changes={oldChanges} selected={selected} priority={priority} />}
                {row.new && <PageBox doc={newDoc} side="new" slot={row.new} changes={newChanges} selected={selected} priority={priority} />}
                {row.placeholder && (
                  <div
                    className="fc-compare-placeholder"
                    style={{ left: row.placeholder.x, top: row.placeholder.y, width: row.placeholder.width, height: row.placeholder.height }}
                  >
                    {row.placeholder.side === 'old' ? 'Not in the old file' : 'Not in the new file'}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** The Compare files document view: file choice, progress, then the side-by-side results. */
export function CompareView() {
  const session = useCompare((s) => s.session)
  return (
    <div className="fc-compare-view">
      {session ? <ResultsView key={session.id} session={session} /> : <SetupLanding />}
      <ProgressCard />
    </div>
  )
}
