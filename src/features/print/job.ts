import type { PrintJob } from '@shared/types'
import { jobOrientation, type Sheet } from './imposition'
import type { PrintSettings } from './settings'

export interface PrintTarget {
  /** Chosen printer, or null when none is available. */
  printer: string | null
  /** Show the system print dialog (Properties, or no printer available) instead of printing silently. */
  systemDialog: boolean
  /** Shown in messages. */
  printerLabel: string
}

/** The job handed to the main process (print:images). */
export function buildJob(
  pages: PrintJob['pages'],
  settings: PrintSettings,
  sheets: Sheet[],
  target: PrintTarget,
  jobName: string
): PrintJob {
  return {
    pages,
    silent: !target.systemDialog && target.printer !== null,
    copies: Math.max(1, Math.min(999, Math.round(settings.copies) || 1)),
    color: !settings.grayscale,
    landscape: jobOrientation(sheets) === 'landscape',
    fit: 'fit',
    deviceName: target.printer ?? undefined,
    duplex: settings.duplex ? (settings.flip === 'short' ? 'shortEdge' : 'longEdge') : 'simplex',
    jobName,
    pageSize: settings.paper
  }
}

