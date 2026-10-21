import { afterEach, describe, expect, it, vi } from 'vitest'
import { REVISE_DELAY_MS, patchReview, startReview, useInlineReview, type ReviewControl, type ReviewOptions } from '@features/agent-access/ui/reviewState'
import type { ProposalCheck, ReviewChange, TextPreview } from '@features/agent-access/engine'
import type { Rect } from '@shared/geometry'

function change(index: number, page: number, bbox: Rect | null, extra: Partial<ReviewChange> = {}): ReviewChange {
  return {
    index, kind: 'edit', label: 'Change ' + (index + 1), page, beforePage: page, before: 'old', after: 'new', bbox,
    fallbackFonts: [], beforeBox: bbox, beforeLines: bbox ? [bbox] : [], fragments: bbox ? [{ page, rect: bbox }] : [],
    notes: [], rejectable: true, ...extra
  }
}
const preview = (changes: ReviewChange[], extra: Partial<TextPreview> = {}): TextPreview => ({
  revision: 1, canApply: true, issues: [], previews: [], pages: [], margins: [], changes, proposal: { id: 'p1', version: 1 }, ...extra
})
/** Two edits on different pages. */
const report = preview([change(0, 1, [72, 100, 300, 120]), change(1, 2, [72, 100, 300, 120])])
const ok: ProposalCheck = { canApply: true, issues: [] }
const options = (extra: Partial<ReviewOptions> = {}): ReviewOptions => ({
  docId: 'doc-1', title: 'Review edits', report, signal: new AbortController().signal, revealStep: 0, check: async () => ok, ...extra
})
const review = () => useInlineReview.getState().review!
afterEach(() => {
  useInlineReview.getState().review?.cancel()
  vi.useRealTimers()
})

describe('inline review decisions (edit_text)', () => {
  it('a rejection only hides the edit; the kept subset is checked once, before finishing', async () => {
    const check = vi.fn(async () => ok)
    const pending = startReview(options({ check }))
    await review().decide([0], false)
    expect(check).not.toHaveBeenCalled()
    expect(review().decisions).toEqual(['rejected', 'pending'])
    await review().decide([1], true)
    expect(check).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenLastCalledWith([1])
    expect(await pending).toEqual([1])
    expect(useInlineReview.getState().review).toBeNull()
  })
  it('accepting everything never asks the worker', async () => {
    const check = vi.fn(async () => ok)
    const pending = startReview(options({ check }))
    await review().decide([0, 1], true)
    expect(await pending).toEqual([0, 1])
    expect(check).not.toHaveBeenCalled()
  })
  it('does not apply accepted choices if the user discards the batch', async () => {
    const pending = startReview(options())
    await review().decide([0], true)
    review().cancel()
    expect(await pending).toEqual([])
  })
  it('a decision can be changed while others are pending', async () => {
    const pending = startReview(options())
    await review().decide([0], false)
    await review().decide([0], true)
    expect(review().decisions).toEqual(['accepted', 'pending'])
    await review().decide([1], true)
    expect(await pending).toEqual([0, 1])
  })
  it('refuses a subset that would overlap even when the original complete proposal was valid', async () => {
    const check = vi.fn(async () => ({ canApply: false, issues: [{ page: 1, code: 'overlap', message: 'Overlaps the retained text', blocking: true }] }))
    const pending = startReview(options({ check }))
    await review().decide([0], false)
    await review().decide([1], true)
    expect(review().error).toContain('Overlaps')
    expect(review().decisions).toEqual(['rejected', 'pending'])
    review().cancel()
    expect(await pending).toEqual([])
  })
  it('checks at once when a rejected edit touches a kept edit on the same page', async () => {
    const touching = preview([change(0, 1, [72, 100, 300, 120]), change(1, 1, [72, 118, 300, 140]), change(2, 2, [72, 100, 300, 120])])
    const check = vi.fn(async (): Promise<ProposalCheck> => ({ canApply: false, issues: [{ page: 1, code: 'text_overlap', message: 'Two proposed text blocks would overlap.', blocking: true, change: 1 }] }))
    startReview(options({ report: touching, check }))
    await review().decide([2], false)
    expect(check).not.toHaveBeenCalled()
    await review().decide([0], false)
    expect(check).toHaveBeenLastCalledWith([1])
    expect(review().decisions).toEqual(['rejected', 'pending', 'rejected'])
    expect(review().error).toContain('would overlap')
    expect(review().busy).toBe('')
  })
  it('cancels during a check without resurrecting the review or consuming another review', async () => {
    let complete!: (value: ProposalCheck) => void
    const controller = new AbortController()
    const pending = startReview(options({ signal: controller.signal, check: () => new Promise(r => { complete = r }) }))
    const rejected = expect(pending).rejects.toThrow(/cancelled/)
    await review().decide([0], false)
    const decision = review().decide([1], true)
    controller.abort()
    await rejected
    const second = startReview(options({ docId: 'doc-2' }))
    complete(ok)
    await decision
    expect(review().docId).toBe('doc-2')
    review().cancel()
    expect(await second).toEqual([])
  })
  it('rejects concurrent reviews and ignores clicks while the edits are checked', async () => {
    let complete!: (value: ProposalCheck) => void
    const check = vi.fn(() => new Promise<ProposalCheck>(r => { complete = r }))
    const pending = startReview(options({ check }))
    await expect(startReview(options())).rejects.toThrow(/Another edit review/)
    await review().decide([0], false)
    const decision = review().decide([1], true)
    expect(review().busy).toBe('checking')
    await review().decide([0], true)
    expect(check).toHaveBeenCalledTimes(1)
    complete(ok)
    await decision
    expect(await pending).toEqual([1])
  })
})

describe('reflow and rebuild reviews', () => {
  const flow = preview(
    [0, 1, 2].map((i) => change(i, 1, [72, 100 + i * 40, 300, 130 + i * 40], { kind: 'paragraph', label: 'Paragraph ' + (i + 1) })),
    { flow: { pages: [1], addedPages: 0, placements: [], warnings: [] } }
  )
  it('several rejections make one new preview; finishing waits for it', async () => {
    vi.useFakeTimers()
    const revise = vi.fn(async (rejected: number[]) => ({ ...flow, proposal: { id: 'p1', version: 2 }, changes: flow.changes.map((c) => rejected.includes(c.index) ? { ...c, after: c.before } : c) }))
    const pending = startReview(options({ report: flow, revise }))
    expect(review().mode).toBe('flow')
    await review().decide([0], false)
    expect(review().busy).toBe('updating')
    await vi.advanceTimersByTimeAsync(REVISE_DELAY_MS / 2)
    await review().decide([1], false)
    await review().decide([2], true)
    // Nothing pending, but the preview is not up to date yet.
    expect(useInlineReview.getState().review).not.toBeNull()
    await vi.advanceTimersByTimeAsync(REVISE_DELAY_MS)
    expect(revise).toHaveBeenCalledTimes(1)
    expect(revise).toHaveBeenLastCalledWith([0, 1])
    expect(await pending).toEqual([2])
  })
  it('a preview that cannot be made keeps the review open until the decision changes', async () => {
    vi.useFakeTimers()
    const revise = vi.fn(async (): Promise<TextPreview> => { throw new Error('The text does not fit the supplied regions.') })
    const pending = startReview(options({ report: flow, revise }))
    await review().decide([1, 2], true)
    await review().decide([0], false)
    await vi.advanceTimersByTimeAsync(REVISE_DELAY_MS)
    expect(review().error).toContain('does not fit')
    expect(review().busy).toBe('')
    await review().decide([0], true)
    await vi.advanceTimersByTimeAsync(REVISE_DELAY_MS)
    expect(revise).toHaveBeenCalledTimes(1)
    expect(await pending).toEqual([0, 1, 2])
  })
  it('rebuild: the title and design are kept; rejecting every section declines without a preview', async () => {
    vi.useFakeTimers()
    const rebuild = preview(
      [
        change(0, 1, [40, 40, 300, 70], { kind: 'title', label: 'Title', rejectable: false }),
        change(1, 1, [40, 80, 500, 300], { kind: 'section', label: 'Summary' }),
        change(2, 2, [40, 40, 500, 300], { kind: 'section', label: 'Experience' }),
        change(3, 1, null, { kind: 'design', label: 'Page design', rejectable: false })
      ],
      { rebuilt: true }
    )
    const revise = vi.fn(async () => rebuild)
    const pending = startReview(options({ report: rebuild, revise }))
    expect(review().decisions).toEqual(['accepted', 'pending', 'pending', 'accepted'])
    await review().decide([0, 3], false)
    expect(review().decisions).toEqual(['accepted', 'pending', 'pending', 'accepted'])
    await review().decide([1, 2], false)
    expect(await pending).toEqual([])
    expect(revise).not.toHaveBeenCalled()
  })
})

describe('live reveal', () => {
  const many = preview([
    change(0, 2, [72, 100, 300, 120]),
    change(1, 1, [72, 300, 300, 320]),
    change(2, 1, [72, 100, 300, 120])
  ])
  it('reveals changes one by one in reading order, and Show all skips ahead', async () => {
    vi.useFakeTimers()
    const onReveal = vi.fn()
    startReview(options({ report: many, revealStep: undefined, onReveal }))
    expect(review().order).toEqual([2, 1, 0])
    expect(review().revealed).toBe(0)
    expect(review().selected).toBe(2)
    await vi.advanceTimersByTimeAsync(250)
    expect(review().revealed).toBe(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(review().revealed).toBe(2)
    expect(onReveal.mock.calls.map(([c]) => c)).toEqual([2, 1])
    review().showAll()
    expect(review().revealed).toBe(3)
    await vi.advanceTimersByTimeAsync(2000)
    expect(onReveal).toHaveBeenCalledTimes(2)
  })
  it('after a decision the selection moves only to a card that is already shown', async () => {
    vi.useFakeTimers()
    startReview(options({ report: many, revealStep: undefined }))
    await vi.advanceTimersByTimeAsync(250)
    expect(review().revealed).toBe(1)
    await review().decide([2], true)
    // Card 1 is next in reading order but not shown yet: A again must not decide it unseen.
    expect(review().selected).toBe(2)
    await vi.advanceTimersByTimeAsync(400)
    await review().decide([1], false)
    expect(review().selected).toBe(1)
    expect(review().decisions).toEqual(['pending', 'rejected', 'accepted'])
  })
  it('a decided card the person went back to keeps the selection while changes arrive', async () => {
    vi.useFakeTimers()
    const ten = preview(Array.from({ length: 10 }, (_, i) => change(i, 1, [72, 20 + i * 30, 300, 40 + i * 30])))
    startReview(options({ report: ten, revealStep: 400 }))
    await vi.advanceTimersByTimeAsync(1100)
    expect(review().revealed).toBe(3)
    await review().decide([0], true)
    await review().decide([1], true)
    patchReview({ selected: 0 })
    await vi.advanceTimersByTimeAsync(400)
    expect(review().revealed).toBe(4)
    expect(review().selected).toBe(0)
    await review().decide([review().selected], false)
    expect(review().decisions.slice(0, 4)).toEqual(['rejected', 'accepted', 'pending', 'pending'])
  })
  it('caps the whole reveal at about 6 seconds', async () => {
    vi.useFakeTimers()
    const thirty = preview(Array.from({ length: 30 }, (_, i) => change(i, 1, [72, 20 + i * 20, 300, 35 + i * 20])))
    startReview(options({ report: thirty, revealStep: undefined }))
    await vi.advanceTimersByTimeAsync(6000)
    expect(review().revealed).toBe(30)
  })
  it('stops when the review ends', async () => {
    vi.useFakeTimers()
    const onReveal = vi.fn()
    startReview(options({ report: many, revealStep: undefined, onReveal }))
    review().cancel()
    await vi.advanceTimersByTimeAsync(5000)
    expect(onReveal).not.toHaveBeenCalled()
  })
})

describe('live review across calls (edit_text)', () => {
  /** A live review and its control, as tools/editReview.ts opens it. */
  function live(extra: Partial<ReviewOptions> = {}) {
    let control!: ReviewControl
    const pending = startReview(options({ live: true, agent: 'Claude', control: (c) => (control = c), ...extra }))
    return { pending, control }
  }
  /** The combined proposal after another call added `more` cards. */
  const grown = (more: ReviewChange[], base = report) => preview([...base.changes, ...more], { proposal: { id: 'p1', version: 2 } })

  it('waits for the AI app once nothing is pending, then finishes', async () => {
    const check = vi.fn(async () => ok)
    const { pending, control } = live({ check })
    await review().decide([0], true)
    await review().decide([1], false)
    expect(check).toHaveBeenCalledTimes(1)
    // Decided, checked, but the AI app may still send edits.
    expect(review().live).toBe(true)
    expect(review().aiWaiting).toBe(false)
    control.setWaiting(true)
    expect(await pending).toEqual([0])
    expect(check).toHaveBeenCalledTimes(1)
  })
  it('the person can apply without waiting for the AI app', async () => {
    const { pending } = live()
    await review().decide([0, 1], true)
    expect(useInlineReview.getState().review).not.toBeNull()
    review().apply()
    expect(await pending).toEqual([0, 1])
  })
  it('an AI app already waiting gets the review applied when the last card is decided', async () => {
    const { pending, control } = live()
    control.setWaiting(true)
    await review().decide([0], true)
    expect(useInlineReview.getState().review).not.toBeNull()
    await review().decide([1], true)
    expect(await pending).toEqual([0, 1])
  })
  it('cards of a later call join the open review and its reading order', async () => {
    vi.useFakeTimers()
    const onReveal = vi.fn()
    const { pending, control } = live({ revealStep: undefined, onReveal })
    await vi.advanceTimersByTimeAsync(2000)
    expect(review().revealed).toBe(2)
    await review().decide([0, 1], true)
    // A card higher on page 1 and one on page 2 arrive.
    expect(control.extend(grown([change(2, 2, [72, 300, 300, 320]), change(3, 1, [72, 40, 300, 60])]), [])).toBe(true)
    expect(review().decisions).toEqual(['accepted', 'accepted', 'pending', 'pending'])
    expect(review().order).toEqual([0, 1, 3, 2])
    expect(review().revealed).toBe(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(review().revealed).toBe(4)
    expect(onReveal.mock.calls.map(([c]) => c)).toEqual([0, 1, 3, 2])
    control.setWaiting(true)
    expect(useInlineReview.getState().review).not.toBeNull()
    await review().decide([2, 3], true)
    expect(await pending).toEqual([0, 1, 2, 3])
  })
  it('a replaced card is pending again and revealed again', async () => {
    const { pending, control } = live()
    await review().decide([1], true)
    const next = preview([change(0, 1, [72, 100, 300, 140], { after: 'newer' }), report.changes[1]], { proposal: { id: 'p1', version: 2 } })
    control.extend(next, [0])
    expect(review().decisions).toEqual(['pending', 'accepted'])
    expect(review().original.changes[0].after).toBe('newer')
    expect(review().order).toEqual([1, 0])
    review().cancel()
    expect(await pending).toEqual([])
  })
  it('a withdrawn card is never applied; the decided ones stay', async () => {
    const check = vi.fn(async () => ok)
    const { pending, control } = live({ check })
    await review().decide([0], true)
    control.withdraw([0, 1])
    // Only the pending card goes.
    expect(review().decisions).toEqual(['accepted', 'withdrawn'])
    expect(check).toHaveBeenLastCalledWith([0])
    await review().decide([1], true)
    expect(review().decisions).toEqual(['accepted', 'withdrawn'])
    control.setWaiting(true)
    expect(await pending).toEqual([0])
  })
  it('closes when every card is withdrawn', async () => {
    const { pending, control } = live()
    control.withdraw([0, 1])
    expect(await pending).toEqual([])
    expect(useInlineReview.getState().review).toBeNull()
    expect(control.decisions()).toBeNull()
    expect(control.extend(report, [])).toBe(false)
  })
  it('a kept set that cannot be applied stops Apply until a decision changes', async () => {
    let fits = false
    const check = vi.fn(async (): Promise<ProposalCheck> => (fits ? ok : { canApply: false, issues: [{ page: 1, code: 'text_overlap', message: 'Two proposed text blocks would overlap.', blocking: true }] }))
    const { pending, control } = live({ check })
    await review().decide([0], false)
    await review().decide([1], true)
    // The last decision is taken back, as in a single call's review.
    expect(review().decisions).toEqual(['rejected', 'pending'])
    expect(review().error).toContain('overlap')
    fits = true
    await review().decide([1], true)
    control.setWaiting(true)
    expect(await pending).toEqual([1])
  })
  it('flow and rebuild reviews are never live', async () => {
    const flow = preview([change(0, 1, [72, 100, 300, 130], { kind: 'paragraph' })], { flow: { pages: [1], addedPages: 0, placements: [], warnings: [] } })
    const control = vi.fn()
    const pending = startReview(options({ report: flow, live: true, control, revise: async () => flow }))
    expect(review().live).toBe(false)
    expect(control).not.toHaveBeenCalled()
    await review().decide([0], true)
    expect(await pending).toEqual([0])
  })
})
