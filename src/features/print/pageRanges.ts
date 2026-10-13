/**
 * Page selection for printing: Acrobat-style page ranges ("1-3, 5, 8-"), page labels ("iii-v"),
 * odd/even subsets. Pure functions (no DOM, no engine) so they can be unit tested.
 */

export interface PageRangeResult {
  /** 0-based page indices in the order they will print. */
  pages: number[]
  /** Plain-language problem with the input, or null. */
  error: string | null
}

export type PageSubset = 'all' | 'odd' | 'even'

const DASHES = /\s*[-–—]\s*/g

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/**
 * Resolves one page reference. Page labels win over physical numbers (Acrobat's "use logical page
 * numbers"), so in a document numbered i, ii, iii, 1, 2… "1" means the page labelled 1.
 */
function resolveOne(token: string, pageCount: number, labels: string[] | undefined): number | null {
  const t = token.trim()
  if (!t) return null
  if (labels) {
    const lower = t.toLowerCase()
    const exact = labels.indexOf(t)
    if (exact >= 0) return exact
    const ci = labels.findIndex((l) => l.toLowerCase() === lower)
    if (ci >= 0) return ci
  }
  if (/^\d+$/.test(t)) {
    const n = parseInt(t, 10)
    if (n >= 1 && n <= pageCount) return n - 1
  }
  return null
}

function rangeError(token: string, pageCount: number): string {
  const nums = token.match(/\d+/g)?.map((n) => parseInt(n, 10)) ?? []
  const outside = nums.find((n) => n < 1 || n > pageCount)
  if (/^[\d\s-]+$/.test(token) && outside !== undefined) {
    return outside < 1
      ? 'Page numbers start at 1.'
      : `There is no page ${outside}. This document has ${plural(pageCount, 'page')}.`
  }
  return `“${token}” isn't a page number or page label in this document.`
}

/** Expands one comma-separated part: a single page, "a-b", "a-" (to the end) or "-b" (from the start). */
function expandToken(token: string, pageCount: number, labels: string[] | undefined): number[] | null {
  const single = resolveOne(token, pageCount, labels)
  if (single !== null) return [single]
  const normalized = token.replace(DASHES, '-')
  const singleNorm = resolveOne(normalized, pageCount, labels)
  if (singleNorm !== null) return [singleNorm]
  // Try every hyphen as the range separator, so labels that contain hyphens ("A-1-A-4") still work.
  for (let i = 0; i < normalized.length; i++) {
    if (normalized[i] !== '-') continue
    const left = normalized.slice(0, i)
    const right = normalized.slice(i + 1)
    if (!left && !right) continue
    const start = left ? resolveOne(left, pageCount, labels) : 0
    const end = right ? resolveOne(right, pageCount, labels) : pageCount - 1
    if (start === null || end === null) continue
    const out: number[] = []
    if (start <= end) for (let p = start; p <= end; p++) out.push(p)
    else for (let p = start; p >= end; p--) out.push(p)
    return out
  }
  return null
}

/**
 * Parses an Acrobat-style page range into 0-based page indices, in the order given.
 *
 *   "1-3, 5, 8-"   pages 1, 2, 3, 5 and 8 to the end
 *   "-3"           pages 1 to 3
 *   "5-1"          pages 5, 4, 3, 2, 1
 *   "iii-v, 2"     by page label
 *
 * Commas or semicolons separate parts; spaces also separate plain numbers ("1 3 5").
 */
export function parsePageRange(text: string, pageCount: number, labels?: string[]): PageRangeResult {
  const trimmed = text.trim()
  if (!trimmed) return { pages: [], error: 'Enter the pages to print, for example 1-3, 5.' }
  if (pageCount <= 0) return { pages: [], error: 'This document has no pages.' }
  const pages: number[] = []
  for (const raw of trimmed.split(/[,;]+/)) {
    const part = raw.trim()
    if (!part) continue
    let expanded = expandToken(part, pageCount, labels)
    if (!expanded && /\s/.test(part.replace(DASHES, '-'))) {
      // "1 3 5" or "1 3-4": treat whitespace as a separator when the whole part isn't a label.
      const sub: number[] = []
      for (const piece of part.replace(DASHES, '-').split(/\s+/)) {
        const e = expandToken(piece, pageCount, labels)
        if (!e) return { pages: [], error: rangeError(piece, pageCount) }
        sub.push(...e)
      }
      expanded = sub
    }
    if (!expanded) return { pages: [], error: rangeError(part, pageCount) }
    pages.push(...expanded)
  }
  if (!pages.length) return { pages: [], error: 'Enter the pages to print, for example 1-3, 5.' }
  return { pages, error: null }
}

/** Keeps odd or even pages (by page number, 1-based). */
export function filterSubset(pages: number[], subset: PageSubset): number[] {
  if (subset === 'all') return pages
  const wantOdd = subset === 'odd'
  return pages.filter((p) => ((p + 1) % 2 === 1) === wantOdd)
}

export interface PageSelection {
  mode: 'all' | 'current' | 'range'
  range: string
  subset: PageSubset
}

/** The pages a print job covers, before imposition. */
export function selectPages(
  sel: PageSelection,
  pageCount: number,
  currentPage: number,
  labels?: string[]
): PageRangeResult {
  let base: PageRangeResult
  if (sel.mode === 'all') base = { pages: Array.from({ length: pageCount }, (_, i) => i), error: null }
  else if (sel.mode === 'current')
    base = { pages: [Math.max(0, Math.min(pageCount - 1, currentPage))], error: null }
  else base = parsePageRange(sel.range, pageCount, labels)
  if (base.error) return base
  const pages = filterSubset(base.pages, sel.subset)
  if (!pages.length) {
    return {
      pages,
      error: sel.subset === 'odd' ? 'There are no odd pages in this selection.' : 'There are no even pages in this selection.'
    }
  }
  return { pages, error: null }
}

/** "1 - 12", or the labels when the document has its own numbering ("i - 24"). */
export function fullRangeText(labels: string[]): string {
  if (!labels.length) return ''
  if (labels.length === 1) return labels[0]
  return `${labels[0]} - ${labels[labels.length - 1]}`
}
