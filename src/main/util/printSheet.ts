import type { PrintJob } from '@shared/types'

/**
 * CSS size of one sheet image on the paper for the job's sizing mode:
 * - fit: as large as the paper allows (the print feature already keeps content inside the
 *   printable area of each sheet image);
 * - actual: exactly the sheet's size;
 * - shrink: the sheet's size, made smaller only when the paper is smaller (never enlarged).
 */
export function sheetStyle(fit: PrintJob['fit'], widthPt: number, heightPt: number): string {
  const wIn = (widthPt / 72).toFixed(3)
  const hIn = (heightPt / 72).toFixed(3)
  if (fit === 'actual') return `width:${wIn}in;height:${hIn}in`
  if (fit === 'shrink') return `width:${wIn}in;height:${hIn}in;max-width:100%;max-height:100%;object-fit:contain`
  return 'max-width:100%;max-height:100%;width:auto;height:auto'
}
