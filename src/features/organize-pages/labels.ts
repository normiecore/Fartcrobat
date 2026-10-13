/** Page label ("Number Pages…") range logic (pure; shared by the UI, engine and tests). */
import { formatPageLabel } from '@engine/util/pdf'

export type LabelStyle = 'D' | 'R' | 'r' | 'A' | 'a' | ''

export interface LabelRange {
  /** First page (0-based) of the section. */
  start: number
  style: LabelStyle
  prefix: string
  /** Number of the section's first page (>= 1). */
  first: number
}

export const LABEL_STYLES: { value: LabelStyle; label: string }[] = [
  { value: 'D', label: '1, 2, 3, …' },
  { value: 'r', label: 'i, ii, iii, …' },
  { value: 'R', label: 'I, II, III, …' },
  { value: 'a', label: 'a, b, c, …' },
  { value: 'A', label: 'A, B, C, …' },
  { value: '', label: 'None (prefix only)' }
]

/** Numbering of pages without a label section: plain page numbers. */
const DEFAULT_RANGE: LabelRange = { start: 0, style: 'D', prefix: '', first: 1 }

/** The section in effect for page `i`. */
export function rangeAt(ranges: LabelRange[], i: number): LabelRange {
  let found: LabelRange = DEFAULT_RANGE
  for (const r of ranges) if (r.start <= i && r.start >= found.start) found = r
  return found
}

/** Label of page `i` under the given sections. */
export function labelOf(ranges: LabelRange[], i: number): string {
  const r = rangeAt(ranges, i)
  // Same fallback as the engine's pageLabels(): an empty label shows the page number.
  return formatPageLabel(r.style || null, r.prefix, r.first + (i - r.start)) || String(i + 1)
}

export function labelsFor(ranges: LabelRange[], count: number): string[] {
  const sorted = normalizeRanges(ranges, count)
  return Array.from({ length: count }, (_, i) => labelOf(sorted, i))
}

function continues(prev: LabelRange, next: LabelRange) {
  return (
    prev.style === next.style &&
    prev.prefix === next.prefix &&
    prev.first + (next.start - prev.start) === next.first
  )
}

/**
 * Sorts sections, drops ones outside the document or overridden by a later section on the same
 * page, and removes sections that merely continue the previous one.
 */
export function normalizeRanges(ranges: LabelRange[], count: number): LabelRange[] {
  const byStart = new Map<number, LabelRange>()
  for (const r of ranges) {
    if (!Number.isInteger(r.start) || r.start < 0 || r.start >= count) continue
    byStart.set(r.start, { ...r, first: Math.max(1, Math.round(r.first || 1)) })
  }
  const sorted = [...byStart.values()].sort((a, b) => a.start - b.start)
  const out: LabelRange[] = []
  for (const r of sorted) {
    const prev = out.length ? out[out.length - 1] : r.start > 0 ? DEFAULT_RANGE : null
    if (prev && continues(prev, r)) continue
    out.push(r)
  }
  // A lone default section at page 1 is the same as having no labels at all.
  if (out.length === 1 && out[0].start === 0 && continues(DEFAULT_RANGE, out[0])) return []
  return out
}

/**
 * Applies a new numbering section to pages `from`..`to` (0-based, inclusive), or extends the
 * preceding section over them (`'extend'`). Pages after `to` keep the labels they had.
 */
export function applyLabelSection(
  ranges: LabelRange[],
  from: number,
  to: number,
  count: number,
  section: Omit<LabelRange, 'start'> | 'extend'
): LabelRange[] {
  const lo = Math.max(0, Math.min(from, to))
  const hi = Math.min(count - 1, Math.max(from, to))
  const old = normalizeRanges(ranges, count)
  const out: LabelRange[] = old.filter((r) => r.start < lo)
  if (section !== 'extend') out.push({ ...section, start: lo })
  if (hi + 1 < count) {
    const r = rangeAt(old, hi + 1)
    if (r.start <= hi)
      out.push({ start: hi + 1, style: r.style, prefix: r.prefix, first: r.first + (hi + 1 - r.start) })
  }
  out.push(...old.filter((r) => r.start > hi))
  return normalizeRanges(out, count)
}
