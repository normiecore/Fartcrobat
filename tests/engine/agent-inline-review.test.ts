import { afterEach, describe, expect, it, vi } from 'vitest'
import { startReview, useInlineReview } from '@features/agent-access/ui/reviewState'
import type { TextPreview } from '@features/agent-access/engine'
const report: TextPreview = {
  revision: 1, canApply: true, issues: [], previews: [],
  changes: [0, 1].map(i => ({ page: i + 1, before: 'old', after: 'new', bbox: null, fallbackFonts: [] }))
}
const options = () => ({ docId: 'doc-1', title: 'Review edits', report, signal: new AbortController().signal })
afterEach(() => useInlineReview.getState().review?.cancel())
describe('inline review decisions', () => {
  it('re-previews without rejected edits and returns only the accepted subset', async () => {
    const preview = vi.fn(async () => report)
    const pending = startReview({ ...options(), preview })
    await useInlineReview.getState().review!.decide([0], false)
    expect(preview).toHaveBeenLastCalledWith([1])
    expect(useInlineReview.getState().review!.decisions).toEqual(['rejected', 'pending'])
    await useInlineReview.getState().review!.decide([1], true)
    expect(await pending).toEqual([1])
    expect(useInlineReview.getState().review).toBeNull()
  })
  it('does not apply accepted choices if the user discards the batch', async () => {
    const pending = startReview({ ...options(), preview: async () => report })
    await useInlineReview.getState().review!.decide([0], true)
    useInlineReview.getState().review!.cancel()
    expect(await pending).toEqual([])
  })
  it('keeps a linked flow atomic', async () => {
    const pending = startReview(options())
    expect(useInlineReview.getState().review!.decisions).toEqual(['pending'])
    expect(useInlineReview.getState().review!.grouped).toBe(true)
    await useInlineReview.getState().review!.decide([0], true)
    expect(await pending).toEqual([0])
  })
  it('refuses a subset that would overlap even when the original complete proposal was valid', async () => {
    const preview = vi.fn(async () => ({ ...report, canApply: false, issues: [{ page: 1, code: 'overlap', message: 'Overlaps the retained text', blocking: true }] }))
    const pending = startReview({ ...options(), preview })
    await useInlineReview.getState().review!.decide([0], false)
    await useInlineReview.getState().review!.decide([1], true)
    expect(useInlineReview.getState().review!.error).toContain('Overlaps')
    expect(useInlineReview.getState().review!.decisions).toEqual(['rejected', 'pending'])
    useInlineReview.getState().review!.cancel()
    expect(await pending).toEqual([])
  })
  it('cancels during preview without resurrecting the review or consuming another review', async () => {
    let complete!: (value: TextPreview) => void
    const controller = new AbortController()
    const pending = startReview({ ...options(), signal: controller.signal, preview: () => new Promise(r => { complete = r }) })
    const rejected = expect(pending).rejects.toThrow(/cancelled/)
    const decision = useInlineReview.getState().review!.decide([0], true)
    controller.abort()
    await rejected
    const second = startReview({ ...options(), docId: 'doc-2' })
    complete(report)
    await decision
    expect(useInlineReview.getState().review!.docId).toBe('doc-2')
    useInlineReview.getState().review!.cancel()
    expect(await second).toEqual([])
  })
  it('rejects concurrent reviews and ignores repeated clicks during preview', async () => {
    let complete!: (value: TextPreview) => void
    const preview = vi.fn(() => new Promise<TextPreview>(r => { complete = r }))
    const pending = startReview({ ...options(), preview })
    await expect(startReview(options())).rejects.toThrow(/Another edit review/)
    const decision = useInlineReview.getState().review!.decide([0], true)
    await useInlineReview.getState().review!.decide([1], true)
    expect(preview).toHaveBeenCalledTimes(1)
    complete(report)
    await decision
    expect(useInlineReview.getState().review!.decisions).toEqual(['accepted', 'pending'])
    useInlineReview.getState().review!.cancel()
    expect(await pending).toEqual([])
  })
})
