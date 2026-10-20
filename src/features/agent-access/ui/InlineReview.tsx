/** Uses the existing page viewer, right rail and UI kit; no modal or PDF annotations. */
import { useEffect, useMemo } from 'react'
import { Button, PanelFrame, invoke, openRightPanel, useApp, type DocumentModel, type PageLayerProps } from '@renderer/sdk'
import type { TextPreview } from '../engine'
import { toBase64 } from '../tools/contextShape'
import { patchReview, startReview, useInlineReview } from './reviewState'

export async function reviewInDocument(options: {
  doc: DocumentModel
  title: string
  report: TextPreview
  signal: AbortSignal
  preview?: (indices: number[]) => Promise<TextPreview>
}) {
  const { doc } = options
  const pending = startReview({ ...options, docId: doc.id })
  const owned = useInlineReview.getState().review
  // If startReview rejected, never subscribe to or cancel the existing review.
  if (owned?.original !== options.report) return pending
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
  openRightPanel('agent-review')
  // Fartcrobat may be behind the AI app or minimized: bring it forward, or flash it on Windows.
  void invoke('feature:agent-access:attention').catch(() => {})
  try { return await pending } finally { offApp(); offChange() }
}

export function InlineReviewLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const review = useInlineReview(s => s.review)
  const preview = review?.docId === doc.id ? review.report.previews.find(p => p.page === pageIndex + 1) : undefined
  const bytes = review?.showOriginal ? preview?.before : preview?.after
  const image = useMemo(() => bytes?.length ? 'data:image/png;base64,' + toBase64(bytes) : undefined, [bytes])
  if (!review || !preview) return null
  return <div className="viewer-layer fc-agent-access-inline-layer" aria-label="Proposed PDF changes">
    {image && <img alt={'Page ' + (pageIndex + 1) + ' proposed edits'} draggable={false} src={image}
      style={{ width: geometry.width, height: geometry.height, objectFit: 'contain', transformOrigin: '0 0', transform: 'matrix(' + geometry.matrix.join(',') + ')' }} />}
    {!review.showOriginal && review.original.changes.map((c, i) => {
      const index = review.grouped ? 0 : i
      if (c.page !== pageIndex + 1 || !c.bbox || review.decisions[index] === 'rejected') return null
      return <button key={i} className={'fc-agent-access-review-mark' + (review.selected === index ? ' is-selected' : '')}
        aria-label={'Review change ' + (i + 1)} style={geometry.rectToCss(c.bbox)}
        onClick={() => { patchReview({ selected: index }); openRightPanel('agent-review') }} />
    })}
    <span className="fc-agent-access-review-badge">{review.showOriginal ? 'Original document' : 'Proposed edits · awaiting approval'}</span>
  </div>
}

export function InlineReviewPanel({ doc }: { doc: DocumentModel }) {
  const review = useInlineReview(s => s.review)
  useEffect(() => {
    if (!review || review.docId !== doc.id) return
    const c = review.original.changes[review.selected]
    if (c?.bbox && c.page <= doc.pageCount) doc.view?.scrollToRect(c.page - 1, c.bbox, { center: true })
  }, [review?.selected, review?.docId, doc]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!review || review.docId !== doc.id) return <PanelFrame title="Review edits"><p>No edits waiting for this document.</p></PanelFrame>
  const pending = review.decisions.flatMap((d, i) => d === 'pending' ? [i] : [])
  const selected = review.selected
  const change = review.original.changes[selected]
  return <section className="fc-agent-access-inline-panel" aria-label={review.title}>
    <PanelFrame title={review.title}>
      <p>See the proposed edits on the document. Accept or reject each edit, or accept all. Accepted choices are applied together once this batch is reviewed, with one Undo step.</p>
      {review.grouped && <p>This layout is one linked change so columns and pages stay consistent.</p>}
      <div className="fc-agent-access-review-actions">
        <Button disabled={review.busy} onClick={() => patchReview({ showOriginal: !review.showOriginal })}>{review.showOriginal ? 'Show proposed' : 'Show original'}</Button>
        <Button disabled={review.busy || selected === 0} onClick={() => patchReview({ selected: selected - 1 })}>Previous</Button>
        <Button disabled={review.busy || selected === review.decisions.length - 1} onClick={() => patchReview({ selected: selected + 1 })}>Next</Button>
      </div>
      <p role="status">{pending.length} pending · {review.decisions.filter(d => d === 'accepted').length} accepted · {review.decisions.filter(d => d === 'rejected').length} rejected</p>
      {review.report.issues.map((issue, i) => <p key={i} className="fc-agent-access-review-warning">Page {issue.page}: {issue.message}</p>)}
      {review.error && <p role="alert">{review.error}</p>}
      <div className="fc-agent-access-review-actions">
        <Button variant="primary" disabled={review.busy} onClick={() => void review.decide(pending, true)}>Accept all</Button>
        <Button disabled={review.busy} onClick={() => void review.decide(pending, false)}>Reject remaining</Button>
        <Button onClick={() => review.cancel()}>Discard batch</Button>
      </div>
      {!review.grouped && change && <article className="fc-agent-access-text-diff">
        <b>Change {selected + 1} · Page {change.page} · {review.decisions[selected]}</b>
        <p><del>{change.before || '(New text)'}</del></p>
        <p><ins>{change.after || '(Delete text)'}</ins></p>
        <div className="fc-agent-access-review-actions">
          <Button disabled={review.busy || review.decisions[selected] === 'accepted'} onClick={() => void review.decide([selected], true)}>Accept edit</Button>
          <Button disabled={review.busy || review.decisions[selected] === 'rejected'} onClick={() => void review.decide([selected], false)}>Reject edit</Button>
        </div>
      </article>}
      {review.grouped && review.original.changes.map((c, i) => <article key={i} className="fc-agent-access-text-diff"><b>Page {c.page}</b><p><del>{c.before}</del></p><p><ins>{c.after}</ins></p></article>)}
      {review.report.previews.filter(p => p.page > doc.pageCount || review.report.rebuilt).map(p => <figure key={p.page}>
        <figcaption>Proposed page {p.page}{p.page > doc.pageCount ? ' · new continuation page' : ''}</figcaption>
        <img alt={'Proposed layout page ' + p.page} src={'data:image/png;base64,' + toBase64(p.after)} />
      </figure>)}
    </PanelFrame>
  </section>
}
