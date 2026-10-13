/** Planning helpers for Split Document (pure; shared by the UI and the engine). */

export interface SplitPart {
  /** First page (0-based, inclusive). */
  start: number
  /** Last page (0-based, inclusive). */
  end: number
  /** Bookmark title when splitting by bookmarks. */
  title?: string
}

/** Splits `count` pages into parts of at most `per` pages. */
export function splitEvery(count: number, per: number): SplitPart[] {
  const n = Math.max(1, Math.floor(per))
  const parts: SplitPart[] = []
  for (let s = 0; s < count; s += n) parts.push({ start: s, end: Math.min(count, s + n) - 1 })
  return parts
}

/**
 * Splits at each top-level bookmark. Pages before the first bookmark form their own part.
 * Bookmarks without a destination are ignored; several bookmarks on the same page keep the first.
 */
export function splitByBookmarks(
  count: number,
  bookmarks: { title: string; page: number | null }[]
): SplitPart[] {
  const starts: { page: number; title: string }[] = []
  const seen = new Set<number>()
  for (const b of bookmarks) {
    if (b.page === null || b.page < 0 || b.page >= count || seen.has(b.page)) continue
    seen.add(b.page)
    starts.push({ page: b.page, title: b.title })
  }
  starts.sort((a, b) => a.page - b.page)
  if (!starts.length) return count > 0 ? [{ start: 0, end: count - 1 }] : []
  const parts: SplitPart[] = []
  if (starts[0].page > 0) parts.push({ start: 0, end: starts[0].page - 1 })
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].page - 1 : count - 1
    parts.push({ start: s.page, end, title: s.title })
  })
  return parts
}

/**
 * Finds the largest `end` (>= start) such that `sizeOf(start, end) <= maxBytes`, assuming sizes grow
 * with the number of pages. Uses exponential then binary search so that large documents need only
 * O(log n) measurements per part. A single page that is already too big becomes its own part.
 */
export function largestFit(
  start: number,
  last: number,
  maxBytes: number,
  sizeOf: (start: number, end: number) => number
): number {
  let good = start
  if (start >= last) return start
  let step = 1
  let bad = -1
  while (true) {
    const probe = Math.min(last, start + step)
    if (sizeOf(start, probe) <= maxBytes) {
      good = probe
      if (probe === last) return last
      step *= 2
    } else {
      bad = probe
      break
    }
  }
  let lo = good
  let hi = bad
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (sizeOf(start, mid) <= maxBytes) lo = mid
    else hi = mid
  }
  return lo
}

/** Splits into parts whose estimated size stays under `maxBytes`. */
export function splitBySize(
  count: number,
  maxBytes: number,
  sizeOf: (start: number, end: number) => number,
  onProgress?: (fraction: number) => void
): SplitPart[] {
  const parts: SplitPart[] = []
  let start = 0
  while (start < count) {
    const end = largestFit(start, count - 1, maxBytes, sizeOf)
    parts.push({ start, end })
    start = end + 1
    onProgress?.(start / count)
  }
  return parts
}

/** Removes characters that are not allowed in file names on Windows, macOS or Linux. */
export function sanitizeFileName(name: string): string {
  const printable = [...name].map((c) => (c.charCodeAt(0) < 32 ? ' ' : c)).join('')
  const cleaned = printable
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  return cleaned.slice(0, 120) || 'Untitled'
}

/**
 * Output file names (without folder) for split parts: "<base> <label> 1.pdf", or the bookmark title
 * when `useTitles` is set. Duplicates get " (2)", " (3)"...
 */
export function partFileNames(
  base: string,
  parts: SplitPart[],
  opts: { label: string; useTitles?: boolean }
): string[] {
  const label = opts.label.trim()
  const used = new Map<string, number>()
  return parts.map((p, i) => {
    let stem =
      opts.useTitles && p.title
        ? sanitizeFileName(p.title)
        : sanitizeFileName(`${base}${label ? ' ' + label : ''} ${i + 1}`)
    const key = stem.toLowerCase()
    const n = used.get(key) ?? 0
    used.set(key, n + 1)
    if (n > 0) stem = `${stem} (${n + 1})`
    return `${stem}.pdf`
  })
}

/** Adds " (2)", " (3)"... before the extension until `exists` says the name is free. */
export async function uniqueName(name: string, exists: (name: string) => Promise<boolean>): Promise<string> {
  if (!(await exists(name))) return name
  const m = /^(.*?)(\.[^.]+)?$/.exec(name)!
  const stem = m[1]
  const ext = m[2] ?? ''
  for (let i = 2; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!(await exists(candidate))) return candidate
  }
  return `${stem} (${Date.now()})${ext}`
}
