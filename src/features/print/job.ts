import type { PrintJob } from '@shared/types'
import { jobOrientation, type Sheet } from './imposition'
import type { PrintSettings } from './settings'

export interface PrintTarget {
  /** Printer to print on silently; null opens the system print dialog. */
  printer: string | null
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
    silent: target.printer !== null,
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

