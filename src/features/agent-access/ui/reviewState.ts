/** One review per window. Decisions remain provisional until the batch is complete. */
import { create } from 'zustand'
import type { TextPreview } from '../engine'
export type Decision = 'pending' | 'accepted' | 'rejected'
export interface InlineReview {
  docId: string
  title: string
  original: TextPreview
  report: TextPreview
  decisions: Decision[]
  selected: number
  showOriginal: boolean
  busy: boolean
  error: string
  grouped: boolean
  decide(indices: number[], accept: boolean): Promise<void>
  cancel(error?: Error): void
}
export const useInlineReview = create<{ review: InlineReview | null }>(() => ({ review: null }))
export function patchReview(patch: Partial<Pick<InlineReview, 'selected' | 'showOriginal'>>) {
  const review = useInlineReview.getState().review
  if (review) useInlineReview.setState({ review: { ...review, ...patch } })
}
export function startReview(options: {
  docId: string
  title: string
  report: TextPreview
  signal: AbortSignal
  preview?: (indices: number[]) => Promise<TextPreview>
}): Promise<number[]> {
  if (useInlineReview.getState().review) return Promise.reject(new Error('Another edit review is open. Finish it first.'))
  if (options.signal.aborted) return Promise.reject(new Error('Review cancelled.'))
  return new Promise((resolve, reject) => {
    let finished = false
    const cancel = (error?: Error) => finish([], error)
    const finish = (accepted: number[], error?: Error) => {
      if (finished) return
      finished = true
      options.signal.removeEventListener('abort', abort)
      useInlineReview.setState({ review: null })
      if (error) reject(error)
      else resolve(accepted)
    }
    const abort = () => cancel(new Error('Review cancelled.'))
    const update = (patch: Partial<InlineReview>) => {
      const review = useInlineReview.getState().review
      if (!finished && review?.cancel === cancel) useInlineReview.setState({ review: { ...review, ...patch } })
    }
    useInlineReview.setState({ review: {
      docId: options.docId, title: options.title, original: options.report, report: options.report,
      decisions: Array.from({ length: options.preview ? options.report.changes.length : 1 }, () => 'pending'),
      selected: 0, showOriginal: false, busy: false, error: '', grouped: !options.preview, cancel,
      decide: async (indices, accept) => {
        const current = useInlineReview.getState().review
        if (finished || current?.cancel !== cancel || current.busy) return
        const next = current.decisions.map((d, i) => indices.includes(i) ? (accept ? 'accepted' : 'rejected') : d) as Decision[]
        const kept = next.flatMap((d, i) => d !== 'rejected' ? [i] : [])
        update({ busy: true, error: '' })
        try {
          // Recompute after rejection: the live page must not keep displaying a rejected edit.
          // Every final subset is checked again for overlap/overflow by the engine.
          const report = options.preview && kept.length ? await options.preview(kept) : current.report
          if (finished) return
          if (!next.includes('pending')) {
            if (kept.length && !report.canApply) throw new Error(report.issues.filter(i => i.blocking).map(i => i.message).join(' '))
            finish(next.flatMap((d, i) => d === 'accepted' ? [i] : []))
          } else update({ decisions: next, report, selected: next.indexOf('pending'), busy: false })
        } catch (e) { update({ busy: false, error: (e as Error).message }) }
      }
    } })
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) abort()
  })
}
