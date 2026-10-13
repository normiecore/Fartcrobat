/**
 * The Recognize Text run, independent of where Tesseract runs (a browser worker in the app, a
 * Node worker in tests): render each page, recognize it, convert the result to page space.
 */
import { ALMOST_NO_TEXT } from './constants'
import { tesseractToLines, type TessBlock } from './layout'
import type { OcrPageImage, OcrPageResult, PageOcrStatus } from './types'

export interface RecognizeOutput {
  blocks: TessBlock[] | null
  /** Angle Tesseract deskewed the image by (0 when it did not). */
  rotateRadians: number
}

/** Something that recognizes page images (one Tesseract worker, reused for every page). */
export interface Recognizer {
  recognize(png: Uint8Array, opts: { dpi: number }, onProgress: (fraction: number) => void): Promise<RecognizeOutput>
}

/** The engine calls the run needs (`doc.ops('ocr')` in the app, the local engine in tests). */
export interface OcrEngineOps {
  status(pages?: number[]): Promise<PageOcrStatus[]>
  renderPage(page: number, opts: { dpi: number }): Promise<OcrPageImage>
}

export interface RunOptions {
  pages: number[]
  /** Tesseract language string ("eng", "eng+fra"). */
  language: string
  dpi: number
  skipPagesWithText: boolean
}

export type PageState = 'waiting' | 'rendering' | 'recognizing' | 'done' | 'skipped' | 'failed'

export interface PageProgress {
  page: number
  state: PageState
  /** Recognition progress of this page, 0..1. */
  fraction: number
  words?: number
  error?: string
}

export interface PageFailure {
  page: number
  message: string
}

export interface RunResult {
  results: OcrPageResult[]
  /** Pages left alone because they already have text. */
  skipped: number[]
  /** Pages that could not be rendered or recognized (the others still are). */
  failed: PageFailure[]
  cancelled: boolean
}

/** After this many pages in a row fail, the run stops with the error (the engine is broken). */
export const MAX_CONSECUTIVE_FAILURES = 3

export class CancelledError extends Error {
  constructor() {
    super('Text recognition was cancelled')
    this.name = 'CancelledError'
  }
}

/** True when a page has text of its own or was recognized before. */
export function pageHasText(st: PageOcrStatus): boolean {
  return st.hasOcrLayer || st.textChars - st.ocrChars >= ALMOST_NO_TEXT
}

/**
 * Recognizes the pages one after the other. The next page is rendered while the current one is
 * recognized. A page that fails is reported and skipped; the run stops with the error when
 * several pages in a row fail. Stops (and returns what is done so far, with `cancelled`) when
 * `signal` aborts.
 */
export async function recognizePages(
  ops: OcrEngineOps,
  recognizer: Recognizer,
  opts: RunOptions,
  hooks: { onPage?: (p: PageProgress) => void; signal?: AbortSignal } = {}
): Promise<RunResult> {
  const { signal } = hooks
  const report = (p: PageProgress) => hooks.onPage?.(p)
  const skipped: number[] = []
  const failed: PageFailure[] = []
  let todo = [...opts.pages]
  if (opts.skipPagesWithText && todo.length) {
    const statuses = await ops.status(todo)
    const withText = new Set(statuses.filter(pageHasText).map((s) => s.page))
    for (const p of todo) if (withText.has(p)) skipped.push(p)
    todo = todo.filter((p) => !withText.has(p))
    for (const p of skipped) report({ page: p, state: 'skipped', fraction: 1 })
  }
  const results: OcrPageResult[] = []
  const render = (page: number) => {
    const pr = ops.renderPage(page, { dpi: opts.dpi })
    pr.catch(() => {}) // awaited below; avoid an unhandled rejection when cancelled first
    return pr
  }
  const cancelled = () => ({ results, skipped, failed, cancelled: true })
  let next = todo.length ? render(todo[0]) : null
  let inARow = 0
  /** Records a failed page; true when the run is over (cancelled). Throws when too many fail. */
  const fail = (page: number, err: unknown): boolean => {
    if (err instanceof CancelledError || signal?.aborted) return true
    if (++inARow >= MAX_CONSECUTIVE_FAILURES) throw err
    const message = err instanceof Error ? err.message : String(err)
    failed.push({ page, message })
    report({ page, state: 'failed', fraction: 1, error: message })
    return false
  }
  for (let i = 0; i < todo.length; i++) {
    if (signal?.aborted) return cancelled()
    const page = todo[i]
    report({ page, state: 'rendering', fraction: 0 })
    let image: OcrPageImage
    try {
      image = await next!
    } catch (err) {
      next = i + 1 < todo.length ? render(todo[i + 1]) : null
      if (fail(page, err)) return cancelled()
      continue
    }
    next = i + 1 < todo.length ? render(todo[i + 1]) : null
    if (signal?.aborted) return cancelled()
    report({ page, state: 'recognizing', fraction: 0 })
    try {
      const out = await recognizer.recognize(image.png, { dpi: image.dpi }, (fraction) =>
        report({ page, state: 'recognizing', fraction })
      )
      const { lines, confidence, words } = tesseractToLines(out.blocks, image, out.rotateRadians)
      results.push({ page, lines, language: opts.language, dpi: image.dpi, confidence })
      report({ page, state: 'done', fraction: 1, words })
      inARow = 0
    } catch (err) {
      if (fail(page, err)) return cancelled()
    }
  }
  return { results, skipped, failed, cancelled: false }
}
