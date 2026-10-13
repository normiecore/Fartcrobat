import type { PrintJob } from '@shared/types'
import { invoke, showError, toast, withProgress, type DocumentModel } from '@renderer/sdk'
import { PageImageCache, PrintCancelled, renderSheetForPrint, sheetImages } from './compose'
import { jobOrientation, type Sheet } from './imposition'
import { buildJob, type PrintTarget } from './job'
import { printDpi, type PrintSettings } from './settings'

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Renders every sheet at print resolution and hands the job to the main process. Shows progress
 * with a Cancel button while sheets are prepared.
 */
export async function runPrintJob(doc: DocumentModel, settings: PrintSettings, sheets: Sheet[], target: PrintTarget): Promise<boolean> {
  if (!sheets.length) {
    toast('There is nothing to print with these settings.', { kind: 'warning' })
    return false
  }
  const dpi = printDpi(settings, doc.info.permissions['print-hq'] !== false)
  const orientation = jobOrientation(sheets)
  const cache = new PageImageCache(doc, settings.content, settings.grayscale)
  const k = dpi / 72
  let cancelled = false
  const title = doc.state.title
  const n = sheets.length
  let pages: PrintJob['pages']
  try {
    pages = await withProgress(
      `Preparing “${title}” for printing`,
      async (report) => {
        const out: PrintJob['pages'] = []
        for (let i = 0; i < n; i++) {
          if (cancelled) throw new PrintCancelled()
          report(i / n, `Sheet ${i + 1} of ${n}`)
          const sheet = await renderSheetForPrint(sheets[i], dpi, orientation, (page, scale) => cache.get(page, scale), {
            saveInk: settings.saveInk,
            cancelled: () => cancelled
          })
          out.push(sheet)
          // Free page images unless the next sheet uses them too (poster tiles share one page).
          cache.keepOnly(sheetImages(sheets[i + 1], k))
        }
        report(1, 'Sending to the printer…')
        return out
      },
      { cancel: () => (cancelled = true) }
    )
  } catch (err) {
    cache.clear()
    if (err instanceof PrintCancelled || cancelled) {
      toast('Printing cancelled.')
      return false
    }
    showError(err, 'Could not prepare the pages for printing')
    return false
  }
  cache.clear()

  const job = buildJob(pages, settings, sheets, target, title)
  try {
    const silent = !!job.silent
    const result = await withProgress(`Printing “${title}”`, (report) => {
      report(null, silent ? `Sending ${plural(n, 'sheet')} to ${target.printerLabel}…` : 'Choose your print options in the system dialog…')
      return invoke('print:images', job)
    })
    if (result.ok) {
      toast(silent ? `Sent ${plural(n, 'sheet')} to ${target.printerLabel}.` : 'Sent to the printer.', { kind: 'success', timeout: 3000 })
      return true
    }
    if (/cancel/i.test(result.error ?? '')) {
      toast('Printing cancelled.')
      return false
    }
    showError(new Error(result.error || 'The printer did not accept the job'), 'Could not print')
    return false
  } catch (err) {
    showError(err, 'Could not print')
    return false
  }
}
