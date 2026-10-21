/**
 * One review per window. Decisions remain provisional until the batch is complete. Changes are
 * revealed one by one in reading order by a single timer here, not by the page layers.
 *
 * A live review (edit_text, 0.3.1) also takes cards while it is open: every edit_text call of the
 * same conversation adds its edits (ReviewControl.extend), and a cancelled call takes its pending
 * ones back (withdraw). It is applied when nothing is pending and either the AI app is waiting for
 * the decisions (setWaiting) or the person clicks Apply accepted changes.
 */
import { create } from 'zustand'
import { inflateRect, rectsIntersect, rectUnion, type Rect } from '@shared/geometry'
import type { ProposalCheck, ReviewChange, TextPreview } from '../engine'
/** 'withdrawn': the call that sent the edit was cancelled before the person decided it. */
export type Decision = 'pending' | 'accepted' | 'rejected' | 'withdrawn'
export type ReviewMode = 'edit' | 'flow' | 'rebuild'
export interface InlineReview {
  docId: string
  title: string
  mode: ReviewMode
  /**
   * The cards: one per change, in the order they arrived (a live review numbers them across its
   * calls). Their text changes only when a later call replaces a pending edit.
   */
  original: TextPreview
  /** The latest proposal (flow and rebuild get a new one after a rejection). */
  report: TextPreview
  decisions: Decision[]
  /** Cards in the order they are revealed (reading order per arrival); rank[card] is the place. */
  order: number[]
  rank: number[]
  /** How many cards (in reading order) are shown so far. */
  revealed: number
  selected: number
  /**
   * The card a decision left selected because no shown card was pending, or -1. The next card to
   * arrive takes the selection from it; a card the person picks (patchReview) never loses it.
   */
  advanceFrom: number
  hovered: number
  showOriginal: boolean
  /** Edits are being checked (clicks wait), or the preview is being updated. */
  busy: '' | 'checking' | 'updating'
  error: string
  /** Takes edits from more than one call, and is applied when the AI waits or the person asks. */
  live: boolean
  /** Who sends the edits ("Claude"), for the panel. */
  agent: string
  /** Live: the AI app is waiting for the decisions (it has sent everything). */
  aiWaiting: boolean
  decide(cards: number[], accept: boolean): Promise<void>
  showAll(): void
  /** Live: applies the accepted changes now, without waiting for the AI app. */
  apply(): void
  cancel(error?: Error): void
}
export const useInlineReview = create<{ review: InlineReview | null }>(() => ({ review: null }))
export function patchReview(patch: Partial<Pick<InlineReview, 'selected' | 'hovered' | 'showOriginal'>>) {
  const review = useInlineReview.getState().review
  if (review && Object.entries(patch).some(([k, v]) => review[k as keyof InlineReview] !== v))
    useInlineReview.setState({ review: { ...review, ...patch, ...('selected' in patch ? { advanceFrom: -1 } : {}) } })
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
/** Cards that would be applied if nothing else is rejected: not rejected or withdrawn. */
const keptOf = (decisions: Decision[]) => decisions.flatMap((d, i) => (d === 'pending' || d === 'accepted' ? [i] : []))
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

/** The cards in reading order: by page, then from the top (flow and rebuild keep their order). */
export function readingOrder(report: TextPreview, mode: ReviewMode, cards = report.changes.map((_, i) => i)): number[] {
  if (mode !== 'edit') return [...cards].sort((a, b) => a - b)
  const top = (c: ReviewChange) => (c.bbox ?? c.beforeBox)?.[1] ?? 0
  const left = (c: ReviewChange) => (c.bbox ?? c.beforeBox)?.[0] ?? 0
  return [...cards].sort((a, b) => {
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
  /** edit_text across calls: see InlineReview.live. Flow and rebuild are never live. */
  live?: boolean
  /** Who sends the edits, for the panel (default "The AI app"). */
  agent?: string
  /** Live: whether the AI app waits for the decisions from the start (default false). */
  waiting?: boolean
  /** Live: receives the handle that adds edits, withdraws them and reports the AI app waiting. */
  control?: (control: ReviewControl) => void
}

/** How the edit_text calls of a live review change it while it is open (tools/editReview.ts). */
export interface ReviewControl {
  /**
   * Another call joined: `report` is the combined proposal, indexed by card. Cards from the old
   * count up are new; `replaced` are cards whose pending edit a later call replaced (pending again,
   * revealed again). False when the review has ended.
   */
  extend(report: TextPreview, replaced: number[]): boolean
  /** A call was cancelled: its pending cards are taken back (decided ones stay). */
  withdraw(cards: number[]): void
  /** Whether the AI app waits for the decisions now. */
  setWaiting(waiting: boolean): void
  /** The decisions so far, or null once the review has ended. */
  decisions(): Decision[] | null
}

/** Opens the review; resolves with the accepted cards, or none when the person declined. */
export function startReview(options: ReviewOptions): Promise<number[]> {
  if (useInlineReview.getState().review) return Promise.reject(new Error('Another edit review is open. Finish it first.'))
  if (options.signal.aborted) return Promise.reject(new Error('Review cancelled.'))
  const { report } = options
  const mode: ReviewMode = report.rebuilt ? 'rebuild' : report.flow ? 'flow' : 'edit'
  const live = mode === 'edit' && !!options.live
  const count = report.changes.length
  const order = readingOrder(report, mode)
  const rank: number[] = []
  order.forEach((card, i) => (rank[card] = i))
  const stepFor = (n: number) =>
    options.revealStep ?? (reducedMotion() ? 0 : Math.min(REVEAL_STEP_MS, REVEAL_TOTAL_MS / Math.max(1, n)))
  return new Promise((resolve, reject) => {
    let finished = false
    let revealTimer: ReturnType<typeof setTimeout> | undefined
    let reviseTimer: ReturnType<typeof setTimeout> | undefined
    let revising = false
    /** The rejected items the current proposal shows, and the last set that could not be shown. */
    let shownKey = ''
    let failedKey: string | null = null
    /** edit_text: the kept cards last found applicable together ('' before any check). */
    let checkedKey: string | null = null
    /** Live: the person clicked Apply accepted changes. */
    let applyRequested = false
    let step = stepFor(count)
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

    const scheduleReveal = (delay: number) => {
      if (revealTimer === undefined) revealTimer = setTimeout(reveal, delay)
    }
    const reveal = () => {
      revealTimer = undefined
      const r = get()
      if (!r) return
      // Withdrawn cards are skipped without a step.
      let at = r.revealed
      while (at < r.order.length && r.decisions[r.order[at]] === 'withdrawn') at++
      if (at >= r.order.length) {
        if (at !== r.revealed) update({ revealed: at })
        return
      }
      const card = r.order[at]
      // The person decided the card they were on and nothing shown was pending: the arriving one
      // is next (A, A, A... works). A card they went back to themselves keeps the selection.
      const advance = r.advanceFrom >= 0 && r.advanceFrom === r.selected && r.decisions[card] === 'pending'
      update({ revealed: at + 1, ...(advance ? { selected: card, advanceFrom: -1 } : {}) })
      options.onReveal?.(card)
      if (at + 1 < r.order.length) scheduleReveal(step)
    }
    const showAll = () => {
      clearTimeout(revealTimer)
      revealTimer = undefined
      const r = get()
      if (r) update({ revealed: r.order.length })
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

    /**
     * edit_text: once nothing is pending, the kept edits are checked once (the complete proposal
     * was checked when it was made), and the review finishes when it may: at once for a single
     * call, else when the AI app waits or the person clicks Apply. `undo` is the last decision,
     * which a failed check takes back so the person changes another one first.
     */
    const settleEdit = async (undo?: Map<number, Decision>) => {
      const r = get()
      if (!r || r.busy === 'checking' || r.decisions.includes('pending')) return
      const kept = keptOf(r.decisions)
      const key = kept.join()
      if (acceptedOf(r, r.decisions).length && key !== checkedKey) {
        if (kept.length === r.decisions.length) checkedKey = key
        else {
          update({ busy: 'checking' })
          const takeBack = (error: string) => {
            const now = get()
            if (!now) return
            applyRequested = false
            const decisions = undo ? now.decisions.map((d, i) => undo.get(i) ?? d) : now.decisions
            update({ decisions, busy: '', error, ...(undo ? { selected: r.selected } : {}) })
          }
          try {
            const result = await options.check!(kept)
            if (!get()) return
            if (!result.canApply) return takeBack(blockingMessage(result))
            checkedKey = key
            update({ busy: '' })
          } catch (e) {
            return takeBack((e as Error).message)
          }
        }
      }
      const now = get()
      if (!now || now.decisions.includes('pending')) return
      // Decided again while the check ran (a new call, a withdrawal): check what is decided now.
      const accepted = acceptedOf(now, now.decisions)
      if (accepted.length && keptOf(now.decisions).join() !== checkedKey) return settleEdit()
      if (live && !now.aiWaiting && !applyRequested) return
      finish(accepted)
    }

    /** Revealed pending cards after `from` in reveal order, then from the start. */
    const nextPending = (r: InlineReview, decisions: Decision[], from: number) => {
      const at = r.rank[from] ?? -1
      const after = [...r.order.slice(at + 1), ...r.order.slice(0, at + 1)]
      return after.find((c) => decisions[c] === 'pending' && r.rank[c] < r.revealed) ?? from
    }

    const decide = async (cards: number[], accept: boolean) => {
      const current = get()
      if (!current || current.busy === 'checking') return
      const valid = cards.filter(
        (c) => c >= 0 && c < current.decisions.length && rejectable(current, c) && current.decisions[c] !== 'withdrawn'
      )
      if (!valid.length) return
      const prev = current.decisions
      const next = prev.map((d, i) => (valid.includes(i) ? (accept ? 'accepted' : 'rejected') : d)) as Decision[]
      const decidedSelected = valid.includes(current.selected)
      const selected = decidedSelected ? nextPending(current, next, current.selected) : current.selected
      const advanceFrom = decidedSelected ? (selected === current.selected ? selected : -1) : current.advanceFrom
      update({ decisions: next, selected, advanceFrom, error: '' })
      if (mode !== 'edit') {
        if (rejectedOf(current, next).join() !== rejectedOf(current, prev).join()) scheduleRevise()
        return maybeFinish()
      }
      if (!next.includes('pending')) return settleEdit(new Map(valid.map((c) => [c, prev[c]])))
      // A rejected edit that touches a kept one can change how the kept one is written: check now.
      const kept = keptOf(next)
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
      // Decisions made meanwhile may have left nothing pending.
      void settleEdit()
    }

    const apply = () => {
      if (!live || !get()) return
      applyRequested = true
      void settleEdit()
    }

    const control: ReviewControl = {
      extend(next, replaced) {
        const r = get()
        if (!r || mode !== 'edit') return false
        const old = r.decisions.length
        const fresh = [...new Set([...replaced.filter((c) => c >= 0 && c < old), ...next.changes.map((_, i) => i).slice(old)])]
        const decisions = next.changes.map((_, i) => (fresh.includes(i) ? 'pending' : (r.decisions[i] ?? 'pending'))) as Decision[]
        // Shown cards stay shown; new and replaced ones join the queue, in reading order.
        const shown = r.order.slice(0, r.revealed).filter((c) => !fresh.includes(c))
        const queued = readingOrder(next, mode, [...r.order.slice(r.revealed).filter((c) => !fresh.includes(c)), ...fresh])
        const order = [...shown, ...queued]
        const rank: number[] = []
        order.forEach((card, i) => (rank[card] = i))
        step = stepFor(queued.length)
        checkedKey = null
        const all = step <= 0
        useInlineReview.setState({
          review: {
            ...r,
            original: next,
            report: next,
            decisions,
            order,
            rank,
            revealed: all ? order.length : shown.length,
            error: ''
          }
        })
        if (!all && queued.length) scheduleReveal(Math.min(step, 250))
        return true
      },
      withdraw(cards) {
        const r = get()
        if (!r || !live) return
        const gone = cards.filter((c) => r.decisions[c] === 'pending')
        if (!gone.length) return
        const decisions = r.decisions.map((d, i) => (gone.includes(i) ? 'withdrawn' : d)) as Decision[]
        // Nothing left to decide or apply: the review closes.
        if (decisions.every((d) => d === 'withdrawn')) return finish([])
        const selected = gone.includes(r.selected) ? nextPending(r, decisions, r.selected) : r.selected
        update({ decisions, selected: decisions[selected] === 'withdrawn' ? (decisions.findIndex((d) => d !== 'withdrawn')) : selected })
        void settleEdit()
      },
      setWaiting(waiting) {
        const r = get()
        if (!r || !live || r.aiWaiting === waiting) return
        update({ aiWaiting: waiting })
        if (waiting) void settleEdit()
      },
      decisions: () => get()?.decisions ?? null
    }

    step = stepFor(count)
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
        advanceFrom: -1,
        hovered: -1,
        showOriginal: false,
        busy: '',
        error: '',
        live,
        agent: options.agent ?? 'The AI app',
        aiWaiting: live && !!options.waiting,
        decide,
        showAll,
        apply,
        cancel
      }
    })
    if (live) options.control?.(control)
    if (step > 0 && count) scheduleReveal(Math.min(step, 250))
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  })
}
