/**
 * edit_text across calls (0.3.1; docs/features/agent-live-review.md, "Live review across calls").
 *
 * An edit_text call proposes its edits, shows them on the page and answers at once with a ticket
 * (ctx.detach). Later edit_text calls of the same connection, for the same document and revision,
 * join that review: the engine proposes the combined set again, and their cards join the reveal.
 * The review is applied once (one undo step) when nothing is pending and either the AI app waits in
 * wait_for_result on one of its tickets or the person clicks Apply accepted changes; then every
 * call's ticket returns that call's own result.
 *
 * Cards are numbered across the review from 0 ("Change 1" is card 0) and never renumbered. The
 * engine numbers the edits of the held proposal from 0; `held` maps them to cards (a card withdrawn
 * by a cancelled call stays a card but leaves the next combined proposal).
 */
import { hasActiveEditors } from '@renderer/app/commands'
import { activateDocument } from '@renderer/app/actions'
import { EngineCallError } from '@renderer/engine/EngineClient'
import type { DocumentModel } from '@renderer/sdk'
import type textOps from '../engine'
import type { ProposalCheck, TextIssue, TextPreview } from '../engine'
import { REVIEW_LIMITS, type TextChange } from '../textEdits'
import { reviewInDocument } from '../ui/InlineReview'
import { useInlineReview, type ReviewControl } from '../ui/reviewState'
import { flashRect } from '../ui/store'
import { clientLabel, runAsAgent, throwIfAborted, ToolError, type ToolContext, type ToolOutput } from './common'
import { engineTask, toolErrorFrom, undoLabel } from './act-runtime'
import { onTicketWait, ticketWaited } from './wait'

type Ops = ReturnType<typeof opsOf>
const opsOf = (doc: DocumentModel) => doc.ops<typeof textOps>('agent-text')

// ---- what the AI app sees -----------------------------------------------------------------------

/**
 * Issues as the AI app numbers its edits: `edit` is 1-based in the call's own list, like
 * acceptedEdits. `numbering` maps the engine's 0-based change index when it ran on a subset.
 */
export function issuesForAgent(issues: TextPreview['issues'], numbering?: number[]) {
  return issues.map(({ change, ...i }) =>
    change === undefined ? i : { ...i, edit: (numbering ? numbering[change] : change) + 1 }
  )
}

/** The report as the AI app sees it: the review's page geometry stays in Fartcrobat. */
export function forAgent(report: TextPreview) {
  const { previews: _previews, proposal: _proposal, pages: _pages, margins: _margins, changes, ...rest } = report
  return {
    ...rest,
    issues: issuesForAgent(rest.issues),
    changes: changes.map((c) => ({
      page: c.page,
      label: c.label,
      before: c.before,
      after: c.after,
      bbox: c.bbox,
      fallbackFonts: c.fallbackFonts,
      ...(c.notes.length ? { notes: c.notes } : {})
    }))
  }
}

/** What an edit_text call answers once its edits are on the page. */
export const DETACHED_MESSAGE =
  'Your edits are on the page in Fartcrobat, where the person accepts or rejects each one. Do not wait for them now: ' +
  'send each further edit as its own edit_text call (same handle and revision) as soon as you have decided it, ' +
  'so the person sees it while you work; it joins this review. When you have sent everything, call wait_for_result ' +
  'with every ticket. The review is applied, as one undo step, once nothing is pending and you are waiting; each ' +
  'ticket then returns its own call\'s acceptedEdits and rejectedEdits.'

// ---- one review at a time -----------------------------------------------------------------------

/** reflow_text or rebuild_document is proposing or reviewing (its copy is held in the worker). */
let reviewing = false

/**
 * Another review holds the page: refuse before switching the person's tab away from it, and before
 * a new proposal replaces the one that review shows.
 */
export function refuseWhileReviewing() {
  if (useInlineReview.getState().review || reviewing || (session && !session.closed))
    throw new ToolError('busy', 'Another edit review is open in Fartcrobat. Wait until the person has finished it.')
}

/** Proposes and reviews (reflow_text, rebuild_document) while no other review can start. */
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  refuseWhileReviewing()
  reviewing = true
  try {
    return await fn()
  } finally {
    reviewing = false
  }
}

// ---- the calls of a review ----------------------------------------------------------------------

interface Call {
  ctx: ToolContext
  changes: TextChange[]
  /** The card of each of the call's edits. */
  cards: number[]
  /** The call's edits (0-based) that a later call replaced. */
  replaced: Set<number>
  /** The AI app waits for this call's result: in wait_for_result, or in the call itself. */
  waiting: boolean
  done: boolean
  resolve(out: ToolOutput): void
  reject(error: unknown): void
  result: Promise<ToolOutput>
}

function newCall(ctx: ToolContext, changes: TextChange[]): Call {
  let resolve!: (out: ToolOutput) => void
  let reject!: (error: unknown) => void
  const result = new Promise<ToolOutput>((a, b) => {
    resolve = a
    reject = b
  })
  // Settled before the call awaits it (a cancel during the proposal): not an unhandled rejection.
  result.catch(() => {})
  // A call that was not detached (no runner) is the AI app waiting.
  return { ctx, changes, cards: [], replaced: new Set(), waiting: !ctx.detach, done: false, resolve, reject, result }
}

function end(call: Call, outcome: { data: ToolOutput } | { error: unknown }) {
  if (call.done) return
  call.done = true
  if ('error' in outcome) call.reject(outcome.error)
  else call.resolve(outcome.data)
}

interface Session {
  doc: DocumentModel
  ops: Ops
  connectionId: number
  revision: number
  /** The edit of each card and the call (and its 0-based edit) that sent it. */
  entries: { change: TextChange; call: Call; local: number }[]
  /** Cards taken back by a cancelled call: left out of the next combined proposal. */
  withdrawn: Set<number>
  /** The card of each edit of the held proposal, in the engine's order. */
  held: number[]
  proposalId: string
  /** The latest proposal, indexed by card. */
  report: TextPreview
  control: ReviewControl | null
  calls: Call[]
  /** Proposals and checks run one at a time, so a check is numbered for the proposal it checks. */
  queue: Promise<unknown>
  closed: boolean
}

/** The edit_text review of this window, from its first proposal until it is applied or ends. */
let session: Session | null = null

function closeSession(s: Session) {
  s.closed = true
  if (session === s) session = null
}

function enqueue<T>(s: Session, fn: () => Promise<T>): Promise<T> {
  const run = s.queue.then(fn, fn)
  s.queue = run.catch(() => {})
  return run
}

/** The AI app waits for the review when it waits for any call of it that is still running. */
function syncWaiting(s: Session) {
  s.control?.setWaiting(s.calls.some((c) => !c.done && c.waiting))
}

const blockOf = (c: TextChange) => (c.block_id !== undefined ? c.page + ':' + c.block_id : null)
const labelOf = (card: number) => 'Change ' + (card + 1)

/**
 * edit_text (not preview_only): opens a review, or joins the open one, and returns this call's
 * result once the review is applied. Answers still_running through ctx.detach once its edits are
 * on the page.
 */
export async function editInReview(
  ctx: ToolContext,
  doc: DocumentModel,
  revision: number,
  changes: TextChange[]
): Promise<ToolOutput> {
  for (;;) {
    const s = session
    if (!s || s.closed) {
      refuseWhileReviewing()
      return open(ctx, doc, revision, changes)
    }
    if (s.connectionId !== ctx.request.connectionId || s.doc !== doc)
      throw new ToolError('busy', 'Another edit review is open in Fartcrobat. Wait until the person has finished it.')
    // The document does not change while its review is open: another revision is an old one.
    if (s.revision !== revision)
      throw new ToolError(
        'failed',
        'The document changed since that revision. Call get_editable_text again and send the edit with the revision it returns; it joins the open review.'
      )
    const call = await enqueue(s, () => join(s, ctx, changes))
    // The review ended while this call waited for its turn: it starts the next one.
    if (!call) continue
    return wait(s, call)
  }
}

async function open(ctx: ToolContext, doc: DocumentModel, revision: number, changes: TextChange[]): Promise<ToolOutput> {
  const ops = opsOf(doc)
  const call = newCall(ctx, changes)
  let shown!: () => void
  const s: Session = {
    doc,
    ops,
    connectionId: ctx.request.connectionId,
    revision,
    entries: [],
    withdrawn: new Set(),
    held: [],
    proposalId: '',
    report: null as unknown as TextPreview,
    control: null,
    calls: [call],
    // Calls that join wait until this review is on the page.
    queue: new Promise<void>((r) => (shown = r)),
    closed: false
  }
  session = s
  let report: TextPreview
  try {
    report = await engineTask('Could not preview text edits', () => ops.propose(revision, changes))
  } catch (err) {
    closeSession(s)
    shown()
    throw err
  }
  const proposal = report.proposal
  const release = () => (proposal ? ops.closeProposal(proposal.id) : Promise.resolve())
  if (ctx.signal.aborted || !report.canApply || !proposal) {
    closeSession(s)
    shown()
    void release().catch(() => {})
    throwIfAborted(ctx)
    return {
      data: {
        ...forAgent(report),
        applied: false,
        note: 'Nothing changed. Resolve the blocking layout issues and preview again.'
      }
    }
  }
  s.entries = changes.map((change, local) => ({ change, call, local }))
  call.cards = changes.map((_, i) => i)
  s.held = [...call.cards]
  s.proposalId = proposal.id
  s.report = report
  let ended: Promise<number[]>
  try {
    activateDocument(doc.id)
    doc.view?.goToPage(report.changes[0].page - 1)
    ended = reviewInDocument({
      doc,
      title: 'Review text changes',
      report,
      // Ended by the person, a change of the document or the last call going away, never by one call.
      signal: new AbortController().signal,
      live: true,
      agent: clientLabel(ctx),
      control: (c) => (s.control = c),
      check: (kept) => enqueue(s, () => check(s, kept)),
      close: release
    })
  } catch (err) {
    closeSession(s)
    void release().catch(() => {})
    throw err
  } finally {
    shown()
  }
  void ended.then(
    (accepted) => finish(s, accepted),
    (error) => fail(s, error)
  )
  return wait(s, call)
}

/** Adds a call's edits to the open review; null when the review has ended meanwhile. */
async function join(s: Session, ctx: ToolContext, changes: TextChange[]): Promise<Call | null> {
  const decisions = s.closed ? null : s.control?.decisions()
  if (!decisions) {
    closeSession(s)
    return null
  }
  throwIfAborted(ctx)
  const call = newCall(ctx, changes)
  const entries = [...s.entries]
  const replaced: { card: number; owner: Call; local: number }[] = []
  changes.forEach((change, local) => {
    const key = blockOf(change)
    const card = key === null ? -1 : entries.findIndex((e) => blockOf(e.change) === key)
    if (card < 0) {
      call.cards.push(entries.length)
      entries.push({ change, call, local })
      return
    }
    const decision = decisions[card]
    if (decision === 'accepted' || decision === 'rejected')
      throw new ToolError(
        'invalid_args',
        `Edit ${local + 1} changes text the person has already ${decision} in this review (${labelOf(card)}). ` +
          'Leave it as decided: it is applied or left out when the review ends. Send your other edits without it.'
      )
    // A pending (or withdrawn) edit of the same block is replaced in place.
    replaced.push({ card, owner: entries[card].call, local: entries[card].local })
    entries[card] = { change, call, local }
    call.cards.push(card)
  })
  const withdrawn = new Set([...s.withdrawn].filter((c) => !replaced.some((r) => r.card === c)))
  const held = entries.map((_, card) => card).filter((card) => !withdrawn.has(card))
  const combined = held.map((card) => entries[card].change)
  const chars = combined.reduce((n, c) => n + c.text.length, 0)
  if (
    combined.length > REVIEW_LIMITS.edits ||
    new Set(combined.map((c) => c.page)).size > REVIEW_LIMITS.pages ||
    chars > REVIEW_LIMITS.chars
  )
    throw new ToolError(
      'invalid_args',
      `One review holds at most ${REVIEW_LIMITS.edits} edits on ${REVIEW_LIMITS.pages} pages (${REVIEW_LIMITS.chars} characters), and these edits would go beyond that. ` +
        'Call wait_for_result with your tickets so the person can finish this review, then inspect the text again and continue.'
    )
  let report: TextPreview
  try {
    report = await s.ops.propose(s.revision, combined, s.proposalId)
  } catch (err) {
    // The review was closed (and its proposal released) while this call was on its way.
    if (err instanceof EngineCallError && err.code === 'STALE_PROPOSAL') {
      closeSession(s)
      return null
    }
    throw toolErrorFrom(err, 'Could not preview text edits')
  }
  if (!report.canApply) {
    // Only this call is refused; the review keeps showing the proposal it had.
    const problems = report.issues
      .filter((i) => i.blocking)
      .map((i) => {
        if (i.change === undefined) return `Page ${i.page}: ${i.message}`
        const card = held[i.change]
        const e = entries[card]
        return e.call === call ? `Edit ${e.local + 1}: ${i.message}` : `${labelOf(card)} (an earlier edit): ${i.message}`
      })
    throw new ToolError(
      'failed',
      `These edits were not added to the review, which keeps the earlier ones as they are. ${problems.join(' ')} ` +
        'Inspect the text again and send them without the conflict.'
    )
  }
  if (!s.control?.decisions()) {
    closeSession(s)
    return null
  }
  for (const r of replaced) r.owner.replaced.add(r.local)
  s.entries = entries
  s.withdrawn = withdrawn
  s.held = held
  s.report = combine(report, held, s.report, entries.length)
  s.calls.push(call)
  s.control.extend(s.report, replaced.map((r) => r.card))
  return call
}

/** The combined proposal indexed by card: withdrawn cards keep what they showed last. */
function combine(report: TextPreview, held: number[], prev: TextPreview, count: number): TextPreview {
  const changes = Array.from({ length: count }, (_, card) => prev.changes[card])
  report.changes.forEach((c, i) => {
    const card = held[i]
    changes[card] = { ...c, index: card, label: labelOf(card) }
  })
  return {
    ...report,
    changes,
    issues: report.issues.map((i) => (i.change === undefined ? i : { ...i, change: held[i.change] }))
  }
}

/** Whether the kept cards can be applied together (issues name cards). */
async function check(s: Session, kept: number[]): Promise<ProposalCheck> {
  const indices = kept.map((card) => s.held.indexOf(card)).filter((i) => i >= 0)
  const result = await s.ops.checkProposal(s.proposalId, indices)
  return {
    ...result,
    issues: result.issues.map((i) => (i.change === undefined ? i : { ...i, change: s.held[i.change] }))
  }
}

/** The call's edits in the review, as its still_running answer lists them. */
function summary(s: Session, call: Call) {
  const decisions = s.control?.decisions() ?? []
  return {
    edits: call.changes.map((c, local) => ({ edit: local + 1, page: c.page + 1, label: labelOf(call.cards[local]) })),
    pending: decisions.filter((d) => d === 'pending').length
  }
}

/** Answers still_running once the call's edits are on the page, then waits for the review. */
async function wait(s: Session, call: Call): Promise<ToolOutput> {
  const { ctx } = call
  const offs: (() => void)[] = []
  const onAbort = () => withdraw(s, call)
  ctx.signal.addEventListener('abort', onAbort)
  offs.push(() => ctx.signal.removeEventListener('abort', onAbort))
  if (ctx.signal.aborted) onAbort()
  else if (ctx.detach && !call.done) {
    const ticket = ctx.detach({ message: DETACHED_MESSAGE, review: summary(s, call) })
    if (ticket) {
      offs.push(
        onTicketWait(ticket, (waiting) => {
          call.waiting = waiting
          syncWaiting(s)
        })
      )
      // The call had answered still_running before (a slow proposal): the AI app may wait already.
      call.waiting = ticketWaited(ticket)
    }
  }
  syncWaiting(s)
  try {
    return await call.result
  } finally {
    for (const off of offs) off()
    call.waiting = false
    syncWaiting(s)
  }
}

/** A cancelled call takes back its pending edits; the ones the person decided stay. */
function withdraw(s: Session, call: Call) {
  if (call.done) return
  const decisions = s.closed ? null : s.control?.decisions()
  const pending = decisions
    ? call.cards.filter((card, local) => !call.replaced.has(local) && s.entries[card]?.call === call && decisions[card] === 'pending')
    : []
  for (const card of pending) s.withdrawn.add(card)
  end(call, { error: new ToolError('aborted', 'The call was cancelled.') })
  if (pending.length) s.control?.withdraw(pending)
  syncWaiting(s)
}

function declined(call: Call, rejected: number[], anyApplied: boolean): ToolError {
  const replaced = [...call.replaced].sort((a, b) => a - b).map((l) => l + 1)
  if (!replaced.length && !anyApplied)
    return new ToolError('declined', 'The person declined the text changes. Nothing changed. Do not retry unless asked.')
  const parts = [
    ...(rejected.length ? [`the person rejected edits ${rejected.join(', ')}`] : []),
    ...(replaced.length ? [`edits ${replaced.join(', ')} were replaced by a later edit_text call, which reports them`] : [])
  ]
  return new ToolError(
    'declined',
    `None of this call's edits was applied: ${parts.join('; ')}. ${anyApplied ? 'Other edits of the review were applied.' : 'Nothing changed.'} Do not retry unless asked.`
  )
}

/** The review ended with these accepted cards: apply them once and answer every call. */
async function finish(s: Session, accepted: number[]) {
  closeSession(s)
  const live = () => s.calls.filter((c) => !c.done)
  if (!accepted.length) {
    for (const c of live()) end(c, { error: declined(c, rejectedOf(c, new Set()), false) })
    return
  }
  if (hasActiveEditors()) {
    const busy = new ToolError('busy', 'The person is typing. Finish editing and inspect the text again.')
    for (const c of live()) end(c, { error: busy })
    return
  }
  const list = [...accepted].sort((a, b) => a - b)
  try {
    // The worker rechecks its revision and layout atomically, including changes during the review.
    const result = await engineTask('Could not apply text edits', () =>
      runAsAgent(s.doc, () => s.ops.apply(s.revision, list.map((card) => s.entries[card].change)))
    )
    // The first edit that was applied, not a rejected one.
    const shown = s.report.changes[list[0]]
    if (shown?.bbox) {
      s.doc.view?.scrollToRect(shown.page - 1, shown.bbox, { center: true })
      flashRect(s.doc.id, shown.page - 1, shown.bbox)
    }
    const label = await undoLabel(s.doc)
    const applied = new Set(list)
    for (const c of live()) {
      try {
        end(c, { data: resultFor(s, c, applied, list, result.issues, label) })
      } catch (error) {
        end(c, { error })
      }
    }
  } catch (error) {
    for (const c of live()) end(c, { error })
  }
}

/** The call's own edits (1-based) that were not applied, except those a later call replaced. */
function rejectedOf(call: Call, applied: Set<number>): number[] {
  return call.changes
    .map((_, local) => local)
    .filter((local) => !call.replaced.has(local) && !applied.has(call.cards[local]))
    .map((local) => local + 1)
}

function resultFor(s: Session, call: Call, applied: Set<number>, list: number[], issues: TextIssue[], label: string | null): ToolOutput {
  const mine = call.changes.map((_, local) => local).filter((local) => !call.replaced.has(local))
  const acceptedEdits = mine.filter((local) => applied.has(call.cards[local])).map((local) => local + 1)
  const rejectedEdits = rejectedOf(call, applied)
  if (!acceptedEdits.length) throw declined(call, rejectedEdits, true)
  call.ctx.audit({ summary: 'edited ' + acceptedEdits.length + ' text blocks' })
  return {
    data: {
      changed: acceptedEdits.length,
      pages: [...new Set(acceptedEdits.map((n) => call.changes[n - 1].page + 1))].sort((a, b) => a - b),
      // The engine numbered the applied edits of the whole review; the AI app knows its own edits.
      issues: issues.flatMap(({ change, ...i }) => {
        if (change === undefined) return [i]
        const e = s.entries[list[change]]
        return e?.call === call ? [{ ...i, edit: e.local + 1 }] : []
      }),
      acceptedEdits,
      rejectedEdits,
      replacedEdits: [...call.replaced].sort((a, b) => a - b).map((l) => l + 1),
      applied: true,
      saved: false,
      undoLabel: label,
      note: 'Changes are visible in Fartcrobat. Inspect with render_page; save_document writes a local PDF.'
    }
  }
}

/** The review ended without being applied: a change of the document, a closed tab. */
function fail(s: Session, error: unknown) {
  closeSession(s)
  for (const c of s.calls)
    end(c, {
      error: c.ctx.signal.aborted
        ? new ToolError('aborted', 'The call was cancelled.')
        : new ToolError('failed', (error as Error)?.message || 'The review ended.')
    })
}

/** For tests: the open edit_text review, if any. */
export function openEditReview(): { calls: number; cards: number } | null {
  return session && !session.closed ? { calls: session.calls.length, cards: session.entries.length } : null
}
