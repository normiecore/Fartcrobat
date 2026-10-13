/**
 * Recognize Text: runs Tesseract on the chosen pages with a progress dialog, then writes the text
 * layer in one undoable step.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import { Check, CircleDashed, CircleSlash, Loader2, ScanText, TriangleAlert } from 'lucide-react'
import { Button, Dialog, openDialog, runCommand, showError, toast, type DocumentModel } from '@renderer/sdk'
import type ocrOps from './engine'
import { languageName, refreshLanguages, useLanguages } from './languages'
import { recognizePages, type PageProgress, type RunResult } from './pipeline'
import { LanguageUnavailableError, startTesseract, type TesseractSession } from './tesseract'
import type { OcrApplySummary } from './types'
import { markRecognized } from './scanBar'

const P = 'fc-ocr'

export interface RecognizeRequest {
  pages: number[]
  language: string
  dpi: number
  skipPagesWithText: boolean
}

type Phase = 'starting' | 'recognizing' | 'applying'

interface RunState {
  /** A run is in progress (the progress dialog closes itself when this turns false). */
  active: boolean
  docId: string | null
  title: string
  phase: Phase
  pages: PageProgress[]
  /** Progress of writing the text layer (applying phase), 0..1. */
  applied: number
  language: string
  dpi: number
  cancel: (() => void) | null
  stop: (() => void) | null
}

/** The run in progress (there is at most one at a time). */
export const useRun = create<RunState>(() => ({
  active: false,
  docId: null,
  title: '',
  phase: 'starting',
  pages: [],
  applied: 0,
  language: 'eng',
  dpi: 300,
  cancel: null,
  stop: null
}))

export function ocrOpsOf(doc: DocumentModel) {
  return doc.ops<typeof ocrOps>('ocr')
}

function updatePage(p: PageProgress) {
  useRun.setState((s) => ({ pages: s.pages.map((x) => (x.page === p.page ? { ...x, ...p } : x)) }))
}

const STATE_LABEL: Record<PageProgress['state'], string> = {
  waiting: 'Waiting',
  rendering: 'Preparing…',
  recognizing: 'Recognizing…',
  done: 'Done',
  skipped: 'Skipped: already has text',
  failed: 'Failed'
}

function StateIcon({ state }: { state: PageProgress['state'] }) {
  switch (state) {
    case 'done':
      return <Check size={14} className={`${P}-state-icon is-done`} />
    case 'skipped':
      return <CircleSlash size={14} className={`${P}-state-icon is-skipped`} />
    case 'failed':
      return <TriangleAlert size={14} className={`${P}-state-icon is-failed`} />
    case 'waiting':
      return <CircleDashed size={14} className={`${P}-state-icon`} />
    default:
      return <Loader2 size={14} className={`${P}-state-icon is-busy`} />
  }
}

function ProgressDialog({ close }: { close: () => void }) {
  const run = useRun()
  useEffect(() => {
    if (!run.active) close()
  }, [run.active, close])
  const total = run.pages.filter((p) => p.state !== 'skipped').length
  const finished = run.pages.filter((p) => p.state === 'done').length
  const current = run.pages.find((p) => p.state === 'rendering' || p.state === 'recognizing')
  const fraction = total ? (finished + (current?.state === 'recognizing' ? current.fraction : 0)) / total : 0
  const position = current ? run.pages.filter((p) => p.state !== 'skipped').indexOf(current) + 1 : finished
  let status: string
  if (run.phase === 'starting') status = 'Starting text recognition…'
  else if (run.phase === 'applying') status = 'Adding the recognized text to the document…'
  else if (current) status = `Page ${current.page + 1} (${position} of ${total}): ${STATE_LABEL[current.state].toLowerCase()}`
  else status = 'Finishing…'
  const remaining = total - finished
  const shown = run.phase === 'applying' ? run.applied : fraction
  return (
    <Dialog
      title="Recognizing text"
      width={460}
      className={`${P}-progress`}
      onClose={() => run.cancel?.()}
      footer={
        <>
          {run.stop && finished > 0 && remaining > 0 && run.phase === 'recognizing' && (
            <Button onClick={() => run.stop?.()} title="Stop now and keep the text of the pages already recognized">
              {finished === 1 ? 'Stop and keep 1 page' : `Stop and keep ${finished} pages`}
            </Button>
          )}
          <Button onClick={() => run.cancel?.()} disabled={run.phase === 'applying' || !run.cancel} data-testid="ocr-cancel">
            Cancel
          </Button>
        </>
      }
    >
      <div className={`${P}-progress-head`}>
        <ScanText size={18} />
        <span>
          {languageName(run.language)} · {run.dpi} dpi
        </span>
      </div>
      <div
        className={`progress-bar ${run.phase === 'starting' ? 'is-indeterminate' : ''}`}
        role="progressbar"
        aria-label="Overall progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(shown * 100)}
      >
        <div style={{ width: run.phase === 'starting' ? '30%' : `${Math.round(shown * 100)}%` }} />
      </div>
      <div className={`${P}-progress-status`} aria-live="polite" data-testid="ocr-progress-status">
        {status}
      </div>
      {run.pages.length > 1 && (
        <ul className={`${P}-progress-pages`} aria-label="Pages">
          {run.pages.map((p) => (
            <li key={p.page} className={`${P}-progress-page is-${p.state}`}>
              <StateIcon state={p.state} />
              <span className={`${P}-progress-page-label`}>Page {p.page + 1}</span>
              <span className={`${P}-progress-page-state`}>
                {p.state === 'recognizing'
                  ? `${Math.round(p.fraction * 100)}%`
                  : p.state === 'done' && p.words !== undefined
                    ? p.words === 1
                      ? '1 word'
                      : `${p.words} words`
                    : STATE_LABEL[p.state]}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  )
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`
}

function summarize(run: RunResult, applied: OcrApplySummary[]): { message: string; kind: 'success' | 'warning' | 'info' } {
  if (!run.results.length && run.skipped.length && !run.cancelled) {
    return {
      kind: 'info',
      message:
        (run.skipped.length === 1
          ? 'The page already has text, so it was not recognized again.'
          : `All ${run.skipped.length} pages already have text, so they were not recognized again.`) +
        ' To recognize them anyway, turn off “Skip pages that already have text”.'
    }
  }
  const withText = applied.filter((a) => a.words > 0)
  const words = applied.reduce((n, a) => n + a.words, 0)
  const parts: string[] = []
  let kind: 'success' | 'warning' | 'info' = 'success'
  if (withText.length) {
    parts.push(
      `Recognized ${plural(words, 'word', 'words')} on ${plural(withText.length, 'page', 'pages')}. You can now search, select and copy the text.`
    )
  } else if (run.results.length) {
    parts.push(run.results.length === 1 ? 'No text was found on the page.' : 'No text was found on these pages.')
    kind = 'warning'
  }
  const empty = run.results.length - withText.length
  if (withText.length && empty > 0) parts.push(`No text was found on ${plural(empty, 'page', 'pages')}.`)
  if (run.skipped.length) {
    parts.push(
      run.skipped.length === 1
        ? '1 page was skipped because it already has text.'
        : `${run.skipped.length} pages were skipped because they already have text.`
    )
    if (!run.results.length) kind = 'info'
  }
  const conf = run.results.filter((r) => r.lines.length && (r.confidence ?? 100) < 60)
  if (conf.length) {
    parts.push('Some text was hard to read: a higher resolution or the right language may give better results.')
    if (kind === 'success') kind = 'warning'
  }
  if (run.cancelled) parts.unshift('Stopped.')
  return { message: parts.join(' '), kind }
}

let running = false

/**
 * Recognizes text on the given pages and adds it as an invisible text layer (one undo step).
 * Returns the per-page summary, or null when nothing was changed (cancelled, failed).
 */
export async function recognizeText(doc: DocumentModel, req: RecognizeRequest): Promise<OcrApplySummary[] | null> {
  if (running) {
    toast('Text recognition is already running.', { kind: 'warning' })
    return null
  }
  if (!req.pages.length) {
    toast('Choose at least one page to recognize.', { kind: 'warning' })
    return null
  }
  if (doc.info.permissions.edit === false) {
    toast("Text can't be recognized: the security settings of this document don't allow changes.", { kind: 'error' })
    return null
  }
  running = true
  const controller = new AbortController()
  let keep = false
  useRun.setState({
    active: true,
    docId: doc.id,
    title: doc.state.title,
    phase: 'starting',
    language: req.language,
    dpi: req.dpi,
    pages: req.pages.map((page) => ({ page, state: 'waiting', fraction: 0 })),
    applied: 0,
    cancel: () => controller.abort(),
    stop: () => {
      keep = true
      controller.abort()
    }
  })
  void openDialog((close) => <ProgressDialog close={close} />)
  let tesseract: TesseractSession | null = null
  try {
    const installed = useLanguages.getState().loaded ? useLanguages.getState().installed : await refreshLanguages()
    let run: RunResult
    try {
      tesseract = await startTesseract(req.language, installed, controller.signal)
      useRun.setState({ phase: 'recognizing' })
      run = await recognizePages(ocrOpsOf(doc), tesseract, req, { onPage: updatePage, signal: controller.signal })
    } catch (err) {
      if (controller.signal.aborted) {
        toast('Text recognition was cancelled. Nothing was changed.')
        return null
      }
      throw err
    } finally {
      tesseract?.terminate()
    }
    if (run.cancelled && !keep) {
      toast('Text recognition was cancelled. Nothing was changed.')
      return null
    }
    if (doc.isClosed) return null
    useRun.setState({ phase: 'applying', cancel: null, stop: null })
    const writer = doc.ops<typeof ocrOps>('ocr', { onProgress: (f) => useRun.setState({ applied: f }) })
    const applied = run.results.length ? await writer.addTextLayer(run.results) : []
    if (applied.some((a) => a.words > 0)) markRecognized(doc)
    const { message, kind } = summarize(run, applied)
    if (message) {
      toast(message, {
        kind,
        timeout: 8000,
        action: applied.some((a) => a.words > 0) ? { label: 'Find text', run: () => void runCommand('edit.find') } : undefined
      })
    }
    return applied
  } catch (err) {
    if (err instanceof LanguageUnavailableError) toast(err.message, { kind: 'error', timeout: 10000 })
    else showError(err, 'Text recognition failed')
    return null
  } finally {
    running = false
    useRun.setState({ active: false, docId: null, cancel: null, stop: null, pages: [] })
  }
}

/** Removes the text added by Recognize Text from every page (one undoable step). */
export async function removeRecognizedText(doc: DocumentModel) {
  try {
    const ops = ocrOpsOf(doc)
    const status = await ops.status()
    const pages = status.filter((s) => s.hasOcrLayer).map((s) => s.page)
    if (!pages.length) {
      toast('This document has no recognized text to remove.')
      return
    }
    await ops.removeTextLayer(pages)
    toast(`Removed the recognized text from ${plural(pages.length, 'page', 'pages')}.`, {
      action: { label: 'Undo', run: () => void doc.undo() }
    })
  } catch (err) {
    showError(err, 'Could not remove the recognized text')
  }
}
