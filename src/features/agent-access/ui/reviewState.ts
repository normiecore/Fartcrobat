/**
 * One review per window. Decisions remain provisional until the batch is complete. Changes are
 * revealed one by one in reading order by a single timer here, not by the page layers.
 */
import { create } from 'zustand'
import { inflateRect, rectsIntersect, rectUnion, type Rect } from '@shared/geometry'
import type { ProposalCheck, ReviewChange, TextPreview } from '../engine'
export type Decision = 'pending' | 'accepted' | 'rejected'
export type ReviewMode = 'edit' | 'flow' | 'rebuild'
export interface InlineReview {
  docId: string
  title: string
  mode: ReviewMode
  /** The cards: one per change, in the call's order. Their text does not change during the review. */
  original: TextPreview
  /** The latest proposal (flow and rebuild get a new one after a rejection). */
  report: TextPreview
  decisions: Decision[]
  /** Cards in reading order; rank[card] is the card's place in it. */
  order: number[]
  rank: number[]
  /** How many cards (in reading order) are shown so far. */
  revealed: number
  selected: number
  hovered: number
  showOriginal: boolean
  /** Edits are being checked (clicks wait), or the preview is being updated. */
  busy: '' | 'checking' | 'updating'
  error: string
  decide(cards: number[], accept: boolean): Promise<void>
  showAll(): void
  cancel(error?: Error): void
}
export const useInlineReview = create<{ review: InlineReview | null }>(() => ({ review: null }))
export function patchReview(patch: Partial<Pick<InlineReview, 'selected' | 'hovered' | 'showOriginal'>>) {
  const review = useInlineReview.getState().review
  if (review && Object.entries(patch).some(([k, v]) => review[k as keyof InlineReview] !== v))
    useInlineReview.setState({ review: { ...review, ...patch } })
}

/** About 0.4 s per change, at most about 6 s in all. */
export const REVEAL_STEP_MS = 400
export const REVEAL_TOTAL_MS = 6000
/** Several rejections within this time make one new preview. */
export const REVISE_DELAY_MS = 300
/** The page follows new changes only while the person has not scrolled, hovered or clicked for this long. */
export const READING_MS = 3000

let lastInteraction = 0
/** The person scrolled, hovered a change or clicked: stop moving the page for a while. */
export function noteInteraction() {
  lastInteraction = Date.now()
}
export function personIsReading() {
  return Date.now() - lastInteraction < READING_MS
}
function reducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export const isRevealed = (r: InlineReview, card: number) => r.rank[card] < r.revealed
const rejectable = (r: { original: TextPreview }, card: number) => r.original.changes[card]?.rejectable !== false
/** Change indices of the rejected cards. */
const rejectedOf = (r: InlineReview, decisions: Decision[]) =>
  decisions.flatMap((d, i) => (d === 'rejected' ? [r.original.changes[i].index] : []))
/** What the person accepted: the rejectable cards (title and design cards are always kept). */
const acceptedOf = (r: InlineReview, decisions: Decision[]) =>
  decisions.flatMap((d, i) => (d === 'accepted' && rejectable(r, i) ? [i] : []))
const blockingMessage = (c: ProposalCheck) =>
  c.issues
    .filter((i) => i.blocking)
    .map((i) => i.message)
    .join(' ')

/** The page area an edit covers: its old and new text. */
export function editRegion(c: ReviewChange): Rect | null {
  const box = c.beforeBox && c.bbox ? rectUnion(c.beforeBox, c.bbox) : (c.beforeBox ?? c.bbox)
  return box ? inflateRect(box, 2) : null
}

/** Reading order: by page, then from the top. */
function readingOrder(report: TextPreview, mode: ReviewMode): number[] {
  const cards = report.changes.map((_, i) => i)
  if (mode !== 'edit') return cards
  const top = (c: ReviewChange) => (c.bbox ?? c.beforeBox)?.[1] ?? 0
  const left = (c: ReviewChange) => (c.bbox ?? c.beforeBox)?.[0] ?? 0
  return cards.sort((a, b) => {
    const x = report.changes[a]
    const y = report.changes[b]
    return x.page - y.page || top(x) - top(y) || left(x) - left(y) || a - b
  })
}

export interface ReviewOptions {
  docId: string
  title: string
  report: TextPreview
  signal: AbortSignal
  /** edit_text: whether the kept edits (change indices) can be applied together. */
  check?: (kept: number[]) => Promise<ProposalCheck>
  /** reflow_text and rebuild_document: a new proposal with the rejected items (change indices). */
  revise?: (rejected: number[]) => Promise<TextPreview>
  /** A card was revealed. */
  onReveal?: (card: number) => void
  /** Milliseconds per change (default: about 0.4 s, at most about 6 s in all; 0 shows all at once). */
  revealStep?: number
}

/** Opens the review; resolves with the accepted cards, or none when the person declined. */
export function startReview(options: ReviewOptions): Promise<number[]> {
  if (useInlineReview.getState().review) return Promise.reject(new Error('Another edit review is open. Finish it first.'))
  if (options.signal.aborted) return Promise.reject(new Error('Review cancelled.'))
  const { report } = options
  const mode: ReviewMode = report.rebuilt ? 'rebuild' : report.flow ? 'flow' : 'edit'
  const count = report.changes.length
  const order = readingOrder(report, mode)
  const rank: number[] = []
  order.forEach((card, i) => (rank[card] = i))
  return new Promise((resolve, reject) => {
    let finished = false
    let revealTimer: ReturnType<typeof setTimeout> | undefined
    let reviseTimer: ReturnType<typeof setTimeout> | undefined
    let revising = false
    /** The rejected items the current proposal shows, and the last set that could not be shown. */
    let shownKey = ''
    let failedKey: string | null = null
    const get = () => {
      const review = useInlineReview.getState().review
      return !finished && review?.cancel === cancel ? review : null
    }
    const update = (patch: Partial<InlineReview>) => {
      const review = get()
      if (review) useInlineReview.setState({ review: { ...review, ...patch } })
    }
    const finish = (accepted: number[], error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(revealTimer)
      clearTimeout(reviseTimer)
      options.signal.removeEventListener('abort', abort)
      useInlineReview.setState({ review: null })
      if (error) reject(error)
      else resolve(accepted)
    }
    const cancel = (error?: Error) => finish([], error)
    const abort = () => cancel(new Error('Review cancelled.'))

    const step = options.revealStep ?? (reducedMotion() ? 0 : Math.min(REVEAL_STEP_MS, REVEAL_TOTAL_MS / Math.max(1, count)))
    const reveal = () => {
      const r = get()
      if (!r || r.revealed >= count) return
      const card = order[r.revealed]
      // The person decided the card they were on: the arriving one is next (A, A, A... works).
      const selected = r.decisions[r.selected] !== 'pending' && r.decisions[card] === 'pending' ? card : r.selected
      update({ revealed: r.revealed + 1, selected })
      options.onReveal?.(card)
      if (r.revealed + 1 < count) revealTimer = setTimeout(reveal, step)
    }
    const showAll = () => {
      clearTimeout(revealTimer)
      update({ revealed: count })
    }

    /** Finishes when nothing is pending and the proposal shows what was decided. */
    const maybeFinish = () => {
      const r = get()
      if (!r || r.decisions.includes('pending')) return
      const accepted = acceptedOf(r, r.decisions)
      if (!accepted.length) return finish([])
      if (reviseTimer !== undefined || revising) return
      if (rejectedOf(r, r.decisions).join() !== shownKey) return
      finish(accepted)
    }
    const runRevise = async () => {
      reviseTimer = undefined
      const r = get()
      if (!r || revising) return
      const rejected = rejectedOf(r, r.decisions)
      const key = rejected.join()
      // Nothing to show when every item is rejected: that declines the change.
      if (key === shownKey || !acceptedOf(r, r.decisions.map((d) => (d === 'pending' ? 'accepted' : d))).length) {
        update({ busy: '' })
        return maybeFinish()
      }
      revising = true
      try {
        const next = await options.revise!(rejected)
        if (!get()) return
        shownKey = key
        failedKey = null
        update({ report: next, error: '' })
      } catch (e) {
        if (!get()) return
        failedKey = key
        update({ error: (e as Error).message })
      } finally {
        revising = false
      }
      const now = rejectedOf(get()!, get()!.decisions).join()
      if (now !== shownKey && now !== failedKey) return runRevise()
      update({ busy: '' })
      maybeFinish()
    }
    const scheduleRevise = () => {
      clearTimeout(reviseTimer)
      update({ busy: 'updating' })
      reviseTimer = setTimeout(() => void runRevise(), REVISE_DELAY_MS)
    }

    /** Revealed pending cards after `from` in reading order, then from the start. */
    const nextPending = (r: InlineReview, decisions: Decision[], from: number) => {
      const after = [...order.slice(rank[from] + 1), ...order.slice(0, rank[from] + 1)]
      return after.find((c) => decisions[c] === 'pending' && rank[c] < r.revealed) ?? from
    }

    const decide = async (cards: number[], accept: boolean) => {
      const current = get()
      if (!current || current.busy === 'checking') return
      const valid = cards.filter((c) => c >= 0 && c < count && rejectable(current, c))
      if (!valid.length) return
      const prev = current.decisions
      const next = prev.map((d, i) => (valid.includes(i) ? (accept ? 'accepted' : 'rejected') : d)) as Decision[]
      const selected = valid.includes(current.selected) ? nextPending(current, next, current.selected) : current.selected
      update({ decisions: next, selected, error: '' })
      if (mode !== 'edit') {
        if (rejectedOf(current, next).join() !== rejectedOf(current, prev).join()) scheduleRevise()
        return maybeFinish()
      }
      const kept = next.flatMap((d, i) => (d !== 'rejected' ? [i] : []))
      if (!next.includes('pending')) {
        const accepted = acceptedOf(current, next)
        // The complete proposal was checked when it was made; a subset is checked once, here.
        if (!accepted.length || kept.length === count) return finish(accepted)
        update({ busy: 'checking' })
        try {
          const result = await options.check!(kept)
          if (!get()) return
          if (result.canApply) return finish(accepted)
          // The last decision is not recorded: the person changes another one first.
          update({ decisions: prev, selected: current.selected, busy: '', error: blockingMessage(result) })
        } catch (e) {
          update({ decisions: prev, busy: '', error: (e as Error).message })
        }
        return
      }
      // A rejected edit that touches a kept one can change how the kept one is written: check now.
      const touches =
        !accept &&
        valid.some((v) => {
          const a = editRegion(current.original.changes[v])
          return kept.some((k) => {
            const b = editRegion(current.original.changes[k])
            return (
              !!a && !!b && current.original.changes[k].page === current.original.changes[v].page && rectsIntersect(a, b)
            )
          })
        })
      if (!touches || !options.check) return
      update({ busy: 'checking' })
      try {
        const result = await options.check(kept)
        update({ busy: '', error: result.canApply ? '' : blockingMessage(result) })
      } catch (e) {
        update({ busy: '', error: (e as Error).message })
      }
    }

    useInlineReview.setState({
      review: {
        docId: options.docId,
        title: options.title,
        mode,
        original: report,
        report,
        decisions: report.changes.map((c) => (c.rejectable ? 'pending' : 'accepted')),
        order,
        rank,
        revealed: step > 0 ? 0 : count,
        selected: order.find((c) => report.changes[c].rejectable) ?? 0,
        hovered: -1,
        showOriginal: false,
        busy: '',
        error: '',
        decide,
        showAll,
        cancel
      }
    })
    if (step > 0 && count) revealTimer = setTimeout(reveal, Math.min(step, 250))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  })
}
