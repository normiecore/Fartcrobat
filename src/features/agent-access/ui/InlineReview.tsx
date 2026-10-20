/**
 * The live edit review: the proposal is drawn by the viewer's own renderer from a copy held in the
 * worker (sharp at any zoom) and clipped to the changes revealed so far, with markup on top. Uses
 * the existing page viewer, right rail and UI kit; no modal or PDF annotations.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { inflateRect, type Rect } from '@shared/geometry'
import {
  Button,
  PageCanvas,
  PageGeometry,
  PanelFrame,
  invoke,
  openRightPanel,
  renderQueueFor,
  useApp,
  type CssRect,
  type DocumentModel,
  type PageLayerProps,
  type PageSource
} from '@renderer/sdk'
import type textOps from '../engine'
import type { ProposalCheck, ReviewChange, TextIssue, TextPreview } from '../engine'
import { fontNote, marginNote } from '../textEdits'
import {
  editRegion,
  isRevealed,
  noteInteraction,
  patchReview,
  personIsReading,
  startReview,
  useInlineReview,
  type Decision,
  type InlineReview
} from './reviewState'
import './review.css'

const proposalKey = (p: { id: string; version: number }) => 'rv' + p.id + '.' + p.version
const INTERACTIONS = ['wheel', 'pointerdown', 'keydown', 'touchmove']

/** Where to show a change on the live document (0-based page), or null when it has no place there. */
function changeTarget(report: TextPreview, card: number, pageCount: number): { page: number; rect: Rect } | null {
  const c = report.changes[card]
  if (!c) return null
  const slot = (page: number) => page <= pageCount && report.pages.find((p) => p.page === page)?.live !== false
  const f = c.fragments.find((f) => slot(f.page))
  if (f) return { page: f.page - 1, rect: f.rect }
  if (c.beforeBox && c.beforePage <= pageCount) return { page: c.beforePage - 1, rect: c.beforeBox }
  return null
}

export async function reviewInDocument(options: {
  doc: DocumentModel
  title: string
  report: TextPreview
  signal: AbortSignal
  check?: (kept: number[]) => Promise<ProposalCheck>
  revise?: (rejected: number[]) => Promise<TextPreview>
  /** Releases the proposal held in the worker. */
  close?: () => Promise<unknown>
}) {
  const { doc } = options
  const release = () => void options.close?.().catch(() => {})
  const pending = startReview({
    ...options,
    docId: doc.id,
    onReveal: (card) => {
      // Follow the changes as they arrive, unless the person is reading something else.
      const r = useInlineReview.getState().review
      const target = r && !personIsReading() ? changeTarget(r.report, card, doc.pageCount) : null
      if (target) doc.view?.scrollToRect(target.page, target.rect, { center: true })
    }
  })
  const owned = useInlineReview.getState().review
  // If startReview rejected, never subscribe to or cancel the existing review.
  if (owned?.original !== options.report) {
    release()
    return pending
  }
  const offApp = useApp.subscribe(s => {
    if (doc.isClosed || !s.docs.includes(doc)) owned.cancel(new Error('The document closed during review.'))
  })
  // A save (markSaved, an incremental-save rebase) flags `document` without changing content; only
  // a move of the undo journal shows a document-level edit.
  const position = doc.state.journal.position
  const offChange = doc.onChange(cs => {
    if (cs.pages.length || cs.all || cs.structure || (cs.document && cs.journal.position !== position))
      owned.cancel(new Error('The document changed. Inspect it again and submit a fresh proposal.'))
  })
  // Renders of a replaced proposal are dropped from the viewer's caches at once.
  let shown = options.report.proposal ? proposalKey(options.report.proposal) : ''
  const offStore = useInlineReview.subscribe(s => {
    const p = s.review?.cancel === owned.cancel ? s.review.report.proposal : undefined
    const key = p ? proposalKey(p) : ''
    if (key && key !== shown) {
      if (shown) renderQueueFor(doc).dropPrefix(shown + ':')
      shown = key
    }
  })
  // Scrolling, clicking or typing anywhere means the person is reading: the page stops following.
  const interacted = () => noteInteraction()
  const listen = typeof window.addEventListener === 'function'
  if (listen) for (const type of INTERACTIONS) window.addEventListener(type, interacted, { capture: true, passive: true })
  openRightPanel('agent-review')
  // Fartcrobat may be behind the AI app or minimized: bring it forward, or flash it on Windows.
  void invoke('feature:agent-access:attention').catch(() => {})
  try { return await pending } finally {
    offApp(); offChange(); offStore()
    if (listen) for (const type of INTERACTIONS) window.removeEventListener(type, interacted, { capture: true })
    if (options.report.proposal) renderQueueFor(doc).dropPrefix('rv' + options.report.proposal.id + '.')
    release()
  }
}

function useProposalSource(doc: DocumentModel, proposal: TextPreview['proposal']): PageSource | undefined {
  const id = proposal?.id
  const version = proposal?.version
  return useMemo(() => {
    if (id === undefined || version === undefined) return undefined
    const ops = doc.ops<typeof textOps>('agent-text')
    return { key: proposalKey({ id, version }), render: (page, opts) => ops.renderProposal(id, version, page, opts) }
  }, [doc, id, version])
}

/** What one page layer needs from the review: plain values, so a decision elsewhere does not re-render it. */
function pageView(r: InlineReview | null, docId: string, pageIndex: number) {
  if (!r || r.docId !== docId) return { report: null, sig: '', showOriginal: false, all: false }
  const page = pageIndex + 1
  let sig = ''
  r.report.changes.forEach((c, i) => {
    if (c.beforePage !== page && !c.fragments.some((f) => f.page === page)) return
    sig += i + r.decisions[i][0] + (isRevealed(r, i) ? 'v' : '') + (r.selected === i ? 's' : '') + (r.hovered === i ? 'h' : '') + ','
  })
  return { report: r.report, sig, showOriginal: r.showOriginal, all: r.revealed >= r.order.length }
}

interface Mark {
  card: number
  badge: string
  label: string
  decision: Decision
  focus: boolean
  hovered: boolean
  /** On the proposal page. */
  rects: Rect[]
  /** On the live page: the original lines (struck through while the new text wipes in). */
  strike: Rect[]
  chip: string | null
}
const badgeOf = (c: ReviewChange) => (c.kind === 'title' ? 'T' : c.kind === 'section' ? String(c.index) : String(c.index + 1))

/** The marks and the revealed proposal regions of one page. */
function pageMarks(r: InlineReview, pageIndex: number) {
  const page = pageIndex + 1
  const marks: Mark[] = []
  /** Regions of the proposal to show, per card. */
  const clip: { card: number; rect: Rect }[] = []
  r.report.changes.forEach((c, i) => {
    if (!isRevealed(r, i)) return
    const decision = r.decisions[i]
    let rects = c.fragments.filter((f) => f.page === page).map((f) => f.rect)
    const before = c.beforePage === page
    if (r.mode === 'edit') {
      const region = editRegion(c)
      if (before && region && decision !== 'rejected') clip.push({ card: i, rect: region })
      // A rejected edit is outlined where the original shows again.
      if (before && c.beforeBox && (!rects.length || decision === 'rejected')) rects = [c.beforeBox]
    } else {
      if (before && c.beforeBox) clip.push({ card: i, rect: inflateRect(c.beforeBox, 2) })
      clip.push(...rects.map((x) => ({ card: i, rect: inflateRect(x, 2) })))
    }
    if (!rects.length && !(before && c.beforeLines.length)) return
    marks.push({
      card: i,
      badge: badgeOf(c),
      label: c.label,
      decision,
      focus: r.selected === i || r.hovered === i,
      hovered: r.hovered === i,
      rects,
      strike: before && decision !== 'rejected' ? c.beforeLines : [],
      chip: decision !== 'rejected' ? fontNote(c.styleBefore, c.styleAfter) : null
    })
  })
  return { marks, clip }
}

const rectPath = (rects: CssRect[]) =>
  rects.map((r) => `M${r.left} ${r.top}H${r.left + r.width}V${r.top + r.height}H${r.left}Z`).join('') || 'M0 0Z'

export function InlineReviewLayer({ doc, pageIndex, geometry, visibleRect }: PageLayerProps) {
  const view = useInlineReview(useShallow((s) => pageView(s.review, doc.id, pageIndex)))
  if (!view.report) return null
  return <ReviewPage doc={doc} pageIndex={pageIndex} geometry={geometry} visibleRect={visibleRect ?? null} {...view} report={view.report} />
}

const ReviewPage = memo(function ReviewPage({
  doc,
  pageIndex,
  geometry,
  visibleRect,
  report,
  sig,
  showOriginal,
  all
}: {
  doc: DocumentModel
  pageIndex: number
  geometry: PageGeometry
  visibleRect: CssRect | null
  report: TextPreview
  sig: string
  showOriginal: boolean
  all: boolean
}) {
  const { marks, clip } = useMemo(
    () => pageMarks(useInlineReview.getState().review!, pageIndex),
    [report, sig, pageIndex] // eslint-disable-line react-hooks/exhaustive-deps
  )
  const source = useProposalSource(doc, report.proposal)
  const proposalPage = report.pages.find((p) => p.page === pageIndex + 1)
  const rebuilt = !!report.rebuilt
  // A proposal page of another size (a new design) is drawn fitted into the live page.
  const fitted = proposalPage && !proposalPage.live
  const pg = useMemo(() => {
    if (!proposalPage || !fitted) return geometry
    const f = Math.min(geometry.width / proposalPage.width, geometry.height / proposalPage.height)
    return new PageGeometry(pageIndex, proposalPage.width, proposalPage.height, geometry.zoom * f, geometry.rotation)
  }, [geometry, proposalPage, fitted, pageIndex])
  const offset = { left: (geometry.cssWidth - pg.cssWidth) / 2, top: (geometry.cssHeight - pg.cssHeight) / 2 }
  // Each newly revealed change wipes in: its region starts empty and grows (a CSS transition).
  const [entering, setEntering] = useState<number[]>([])
  const shownRef = useRef<Set<number> | null>(null)
  useLayoutEffect(() => {
    const now = new Set(marks.map((m) => m.card))
    const prev = shownRef.current
    shownRef.current = now
    const fresh = prev ? [...now].filter((c) => !prev.has(c)) : []
    if (!fresh.length || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    setEntering(fresh)
    let frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => setEntering([]))))
    return () => cancelAnimationFrame(frame)
  }, [marks])
  const path = useMemo(() => {
    if (rebuilt && all) return null
    return rectPath(
      clip.map((c) => {
        const css = pg.rectToCss(c.rect)
        return entering.includes(c.card) ? { ...css, width: 0 } : css
      })
    )
  }, [clip, entering, pg, rebuilt, all])
  const focus = marks.find((m) => m.focus)
  const margins = focus && !fitted ? report.margins.find((m) => m.page === pageIndex + 1) : undefined
  const removed = rebuilt && all && !proposalPage && pageIndex >= report.pages.length
  if (!proposalPage && !marks.length && !removed) return null
  return (
    <div className="viewer-layer fc-agent-access-inline-layer" role="group" aria-label="Proposed PDF changes">
      {!showOriginal && marks.flatMap((m) => m.strike.map((r, k) => (
        <div key={'s' + m.card + '.' + k} className="fc-agent-access-review-strike" style={geometry.rectToCss(r)} />
      )))}
      {!showOriginal && fitted && rebuilt && all && <div className="fc-agent-access-review-backdrop" />}
      {!showOriginal && proposalPage && source && (
        <div
          className={'fc-agent-access-review-proposal' + (fitted ? ' is-fitted' : '')}
          style={{ ...offset, width: pg.cssWidth, height: pg.cssHeight, clipPath: path ? `path('${path}')` : undefined }}
        >
          <PageCanvas
            doc={doc}
            pageIndex={pageIndex}
            geometry={pg}
            priority={1}
            visibleRect={fitted ? null : visibleRect}
            source={source}
            label={'Page ' + (pageIndex + 1) + ' proposed edits'}
          />
        </div>
      )}
      {removed && !showOriginal && <div className="fc-agent-access-review-removed">Removed in the new design</div>}
      {margins && marginNote(margins.before, margins.after) && (
        <>
          <div className="fc-agent-access-review-guide is-before" style={geometry.rectToCss(margins.before!)} />
          <div className="fc-agent-access-review-guide is-after" style={geometry.rectToCss(margins.after!)} />
        </>
      )}
      {marks.flatMap((m) =>
        m.rects.map((r, k) => {
          const css = pg.rectToCss(r)
          return (
            <button
              key={'m' + m.card + '.' + k}
              type="button"
              className={'fc-agent-access-review-mark is-' + m.decision + (m.focus ? ' is-focus' : '')}
              style={{ left: css.left + offset.left, top: css.top + offset.top, width: css.width, height: css.height }}
              aria-label={m.label + ', ' + m.decision}
              onPointerEnter={() => { noteInteraction(); patchReview({ hovered: m.card }) }}
              onPointerLeave={() => patchReview({ hovered: -1 })}
              onClick={() => { patchReview({ selected: m.card }); openRightPanel('agent-review') }}
            >
              {k === 0 && (
                <span className="fc-agent-access-review-number" aria-hidden="true">
                  {m.badge}{m.decision === 'accepted' ? ' ✓' : m.decision === 'rejected' ? ' ✕' : ''}
                </span>
              )}
              {k === 0 && m.chip && !showOriginal && <span className="fc-agent-access-review-chip">{m.chip}</span>}
            </button>
          )
        })
      )}
    </div>
  )
})

/** A proposal page without a place in the viewer (a new continuation or design page), at panel width. */
function ProposalThumb({ doc, page, source }: { doc: DocumentModel; page: TextPreview['pages'][number]; source: PageSource }) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setWidth(Math.floor(el.clientWidth))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const geometry = useMemo(
    () => (width ? new PageGeometry(page.page - 1, page.width, page.height, width / (page.width * (96 / 72))) : null),
    [width, page]
  )
  return (
    <div ref={ref} className="fc-agent-access-review-thumb" style={geometry ? { height: geometry.cssHeight } : undefined}>
      {geometry && (
        <PageCanvas doc={doc} pageIndex={page.page - 1} geometry={geometry} priority={2} visibleRect={null} source={source}
          label={'Proposed page ' + page.page} />
      )}
    </div>
  )
}

const stateLabel: Record<Decision, string> = { pending: 'Pending', accepted: 'Accepted', rejected: 'Rejected' }

const ChangeCard = memo(function ChangeCard({
  change,
  card,
  decision,
  selected,
  hovered,
  disabled,
  notes,
  issues,
  decide
}: {
  /** The change as proposed (a rejected paragraph's preview shows its original words instead). */
  change: ReviewChange
  card: number
  decision: Decision
  selected: boolean
  hovered: boolean
  disabled: boolean
  /** Notes of the latest proposal (a rejected section is left out of it). */
  notes: string[]
  /** All issues of the latest proposal; the card shows its own. */
  issues: TextIssue[]
  decide: InlineReview['decide']
}) {
  const ref = useRef<HTMLElement>(null)
  const own = useMemo(() => issues.filter((i) => i.change === card), [issues, card])
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' })
  }, [selected])
  const where = change.kind === 'edit' || change.kind === 'paragraph' ? ' · Page ' + change.page : ''
  return (
    <li>
      <article
        ref={ref}
        className={'fc-agent-access-review-card is-' + decision + (selected ? ' is-selected' : '') + (hovered ? ' is-hovered' : '')}
        aria-label={change.label}
        aria-current={selected || undefined}
        onPointerEnter={() => { noteInteraction(); patchReview({ hovered: card }) }}
        onPointerLeave={() => patchReview({ hovered: -1 })}
        onClick={() => patchReview({ selected: card })}
      >
        <header>
          <b>{change.label}{where}</b>
          <span className="fc-agent-access-review-state">{change.rejectable ? stateLabel[decision] : 'Always kept'}</span>
        </header>
        {change.kind !== 'design' && change.before && <p><del>{change.before}</del></p>}
        {change.kind !== 'design' && <p><ins>{change.after || '(Delete text)'}</ins></p>}
        {notes.length > 0 && <ul className="fc-agent-access-review-notes">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
        {own.map((issue, i) => <p key={i} className="fc-agent-access-review-warning">{issue.message}</p>)}
        {change.rejectable && (
          <div className="fc-agent-access-review-actions">
            <Button size="sm" disabled={disabled || decision === 'accepted'} onClick={(e) => { e.stopPropagation(); void decide([card], true) }}>Accept edit</Button>
            <Button size="sm" disabled={disabled || decision === 'rejected'} onClick={(e) => { e.stopPropagation(); void decide([card], false) }}>Reject edit</Button>
          </div>
        )}
      </article>
    </li>
  )
})

export function InlineReviewPanel({ doc }: { doc: DocumentModel }) {
  const review = useInlineReview(s => (s.review?.docId === doc.id ? s.review : null))
  const selected = review?.selected ?? -1
  useEffect(() => {
    const r = useInlineReview.getState().review
    if (!r || r.docId !== doc.id) return
    const target = changeTarget(r.report, r.selected, doc.pageCount)
    if (target) doc.view?.scrollToRect(target.page, target.rect, { center: true })
  }, [selected, doc])
  const source = useProposalSource(doc, review?.report.proposal)
  if (!review) return <PanelFrame title="Review edits"><p>No edits waiting for this document.</p></PanelFrame>
  const { decisions, original, report } = review
  const rejectableCards = decisions.flatMap((d, i) => (original.changes[i].rejectable ? [i] : []))
  const pending = rejectableCards.filter((i) => decisions[i] === 'pending')
  const count = (d: Decision) => rejectableCards.filter((i) => decisions[i] === d).length
  const shown = review.order.slice(0, review.revealed)
  const revealing = review.revealed < review.order.length
  const checking = review.busy === 'checking'
  const general = report.issues.filter((i) => i.change === undefined)
  const extra = source ? report.pages.filter((p) => p.page > doc.pageCount) : []
  const move = (delta: number) => {
    const at = shown.indexOf(review.selected)
    const next = shown[Math.max(0, Math.min(shown.length - 1, (at < 0 ? 0 : at) + delta))]
    if (next !== undefined) patchReview({ selected: next })
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const key = e.key.toLowerCase()
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (key === 'arrowdown' || key === 'arrowup') move(key === 'arrowdown' ? 1 : -1)
    else if ((key === 'a' || key === 'r') && review.selected >= 0) void review.decide([review.selected], key === 'a')
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  return <section className="fc-agent-access-inline-panel" aria-label={review.title}>
    <PanelFrame title={review.title}>
      <p>{review.mode === 'rebuild'
        ? 'Accept or reject each section of the new design. A rejected section is left out.'
        : review.mode === 'flow'
          ? 'Accept or reject each paragraph. A rejected paragraph keeps its original wording and is still flowed.'
          : 'Accept or reject each edit.'} Accepted changes are applied together, with one Undo step.</p>
      <p role="status">
        {pending.length} pending · {count('accepted')} accepted · {count('rejected')} rejected
        {review.busy === 'updating' ? ' · Updating preview...' : checking ? ' · Checking edits...' : ''}
      </p>
      {review.error && <p role="alert" className="fc-agent-access-review-error">{review.error}</p>}
      {general.map((issue, i) => <p key={i} className="fc-agent-access-review-warning">Page {issue.page}: {issue.message}</p>)}
      <div className="fc-agent-access-review-actions">
        <Button variant="primary" disabled={checking || !pending.length} onClick={() => { review.showAll(); void review.decide(pending, true) }}>Accept all</Button>
        <Button disabled={checking || !pending.length} onClick={() => { review.showAll(); void review.decide(pending, false) }}>Reject remaining</Button>
        <Button onClick={() => review.cancel()}>Discard batch</Button>
      </div>
      <div className="fc-agent-access-review-actions">
        <Button size="sm" onClick={() => patchReview({ showOriginal: !review.showOriginal })}>{review.showOriginal ? 'Show proposed' : 'Show original'}</Button>
        {revealing && <Button size="sm" onClick={() => review.showAll()}>Show all</Button>}
      </div>
      <ol className="fc-agent-access-review-list" aria-label="Changes" tabIndex={0} onKeyDown={onKeyDown}>
        {shown.map((card) => (
          <ChangeCard
            key={card}
            change={original.changes[card]}
            notes={(report.changes[card] ?? original.changes[card]).notes}
            card={card}
            decision={decisions[card]}
            selected={review.selected === card}
            hovered={review.hovered === card}
            disabled={checking}
            issues={report.issues}
            decide={review.decide}
          />
        ))}
      </ol>
      {extra.length > 0 && source && extra.map((p) => (
        <figure key={p.page}>
          <figcaption>Proposed page {p.page}{report.rebuilt ? '' : ' · new continuation page'}</figcaption>
          <ProposalThumb doc={doc} page={p} source={source} />
        </figure>
      ))}
    </PanelFrame>
  </section>
}
