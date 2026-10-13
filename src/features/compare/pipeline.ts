import type { ClientOps } from '@engine/define'
import { compareText, finalizeResult, visualDiff, type ProgressFn } from './core'
import type compareOps from './engine'
import type { CompareOptions, CompareResult, PageTokens, Raster, TextCompareResult, VisualRegion } from './types'

/** One side of a comparison: the compare engine ops of the document's engine. */
export interface CompareSource {
  ops: Pick<ClientOps<typeof compareOps>, 'extract' | 'raster'>
  /** Pages to compare (0-based). */
  pages: number[]
}

type PageMeta = Pick<PageTokens, 'width' | 'height' | 'textRects' | 'imageRects'>

/** Where the CPU-heavy work runs: a Web Worker in the app, inline in tests. */
export interface DiffBackend {
  compareText(oldPages: PageTokens[], newPages: PageTokens[], opts: CompareOptions, progress: ProgressFn): Promise<TextCompareResult>
  visualDiff(a: Raster, b: Raster, oldPage: PageMeta, newPage: PageMeta): Promise<VisualRegion[]>
}

export const inlineBackend: DiffBackend = {
  async compareText(oldPages, newPages, opts, progress) {
    return compareText(oldPages, newPages, opts, progress)
  },
  async visualDiff(a, b, oldPage, newPage) {
    return visualDiff(a, b, oldPage, newPage)
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Comparison cancelled')
    this.name = 'CancelledError'
  }
}

/** Pages are read in batches so the document stays responsive (its viewer shares the engine). */
const BATCH = 12
/** Resolution of the image/graphics comparison. */
const VISUAL_DPI = 50

async function extractAll(src: CompareSource, report: (done: number) => void, check: () => void): Promise<PageTokens[]> {
  const out: PageTokens[] = []
  for (let k = 0; k < src.pages.length; k += BATCH) {
    check()
    out.push(...(await src.ops.extract(src.pages.slice(k, k + BATCH))))
    report(out.length)
  }
  return out
}

/**
 * Runs a whole comparison: reads both documents, aligns pages, diffs the text and, for "text and
 * images", compares page renders outside the text. `isCancelled` is polled between steps.
 */
export async function runComparison(
  oldSrc: CompareSource,
  newSrc: CompareSource,
  opts: CompareOptions,
  backend: DiffBackend,
  progress: ProgressFn = () => {},
  isCancelled: () => boolean = () => false
): Promise<CompareResult> {
  const started = Date.now()
  const check = () => {
    if (isCancelled()) throw new CancelledError()
  }
  const total = oldSrc.pages.length + newSrc.pages.length
  const readShare = opts.mode === 'text' ? 0.6 : 0.45
  const textShare = opts.mode === 'text' ? 0.4 : 0.15
  let readOld = 0
  let readNew = 0
  const onRead = () =>
    progress((readShare * (readOld + readNew)) / Math.max(1, total), `Reading pages (${readOld + readNew} of ${total})`)
  const [oldPages, newPages] = await Promise.all([
    extractAll(oldSrc, (n) => ((readOld = n), onRead()), check),
    extractAll(newSrc, (n) => ((readNew = n), onRead()), check)
  ])
  check()
  const text = await backend.compareText(oldPages, newPages, opts, (f, msg) => progress(readShare + textShare * f, msg))
  check()
  const visual: { oldPage: number; newPage: number; regions: VisualRegion[] }[] = []
  if (opts.mode === 'text-images') {
    const oldBy = new Map(oldPages.map((p) => [p.page, p]))
    const newBy = new Map(newPages.map((p) => [p.page, p]))
    const pairs = text.visualPairs
    for (let k = 0; k < pairs.length; k++) {
      check()
      const [o, n] = pairs[k]
      const op = oldBy.get(o)!
      const np = newBy.get(n)!
      const width = Math.round(Math.min(1200, Math.max(160, (Math.max(op.width, np.width) / 72) * VISUAL_DPI)))
      const [a, b] = await Promise.all([oldSrc.ops.raster(o, width), newSrc.ops.raster(n, width)])
      check()
      const regions = await backend.visualDiff(a, b, op, np)
      if (regions.length) visual.push({ oldPage: o, newPage: n, regions })
      progress(readShare + textShare + ((1 - readShare - textShare) * (k + 1)) / pairs.length, `Comparing images (page ${k + 1} of ${pairs.length})`)
    }
  }
  return finalizeResult(text, visual, {
    options: opts,
    oldPages: oldSrc.pages,
    newPages: newSrc.pages,
    elapsed: Date.now() - started
  })
}
