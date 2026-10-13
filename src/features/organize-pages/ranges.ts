/**
 * Page range parsing and formatting ("1-3, 5, 8-"), shared by the UI and the engine.
 * Ranges are typed with 1-based page numbers; results are 0-based page indices.
 */

export type RangeResult = { ok: true; pages: number[] } | { ok: false; error: string }

const DASH = /\s*[-–—]\s*/

function pageWord(n: number) {
  return n === 1 ? 'page' : 'pages'
}

/**
 * Parses a page range. Accepts numbers ("5"), spans ("2-4", "2–4"), open spans ("7-" to the end,
 * "-3" from the start), the words "all", "last"/"end", "even" and "odd", and page labels (e.g.
 * "iv") when `labels` are given. Separators: commas, semicolons or spaces.
 * Returns sorted, unique 0-based indices.
 */
export function parsePageRange(input: string, count: number, labels?: string[]): RangeResult {
  const text = input.trim()
  if (!text) return { ok: false, error: 'Enter the pages, for example 1-3, 5' }
  if (count <= 0) return { ok: false, error: 'The document has no pages' }
  const out = new Set<number>()
  // Split on commas/semicolons, then on whitespace that is not part of a span.
  const tokens = text
    .split(/[,;]+/)
    .flatMap((part) =>
      part
        .trim()
        .replace(/\s*[-–—]\s*/g, '-')
        .split(/\s+/)
    )
    .filter(Boolean)
  const labelIndex = new Map<string, number>()
  if (labels) {
    labels.forEach((l, i) => {
      const key = l.trim().toLowerCase()
      if (key && !labelIndex.has(key)) labelIndex.set(key, i)
    })
  }
  const resolve = (word: string, isEnd: boolean): number | string => {
    const w = word.trim().toLowerCase()
    if (w === '') return isEnd ? count : 1
    if (w === 'last' || w === 'end') return count
    if (w === 'first' || w === 'start') return 1
    if (/^\d+$/.test(w)) return parseInt(w, 10)
    const li = labelIndex.get(w)
    if (li !== undefined) return li + 1
    return `“${word}” isn't a page number`
  }
  for (const token of tokens) {
    const t = token.toLowerCase()
    if (t === 'all' || t === '*') {
      for (let i = 0; i < count; i++) out.add(i)
      continue
    }
    if (t === 'even' || t === 'odd') {
      for (let i = t === 'even' ? 1 : 0; i < count; i += 2) out.add(i)
      continue
    }
    const span = token.split(DASH)
    if (span.length > 2) return { ok: false, error: `“${token}” isn't a valid range` }
    if (span.length === 2) {
      // A label that itself contains a dash ("A-1") wins over a span.
      const asLabel = labelIndex.get(t)
      if (asLabel !== undefined && !/^\d*-\d*$/.test(t)) {
        out.add(asLabel)
        continue
      }
      const a = resolve(span[0], false)
      const b = resolve(span[1], true)
      if (typeof a === 'string') return { ok: false, error: a }
      if (typeof b === 'string') return { ok: false, error: b }
      if (span[0] === '' && span[1] === '') return { ok: false, error: `“${token}” isn't a valid range` }
      const lo = Math.min(a, b)
      const hi = Math.max(a, b)
      if (lo < 1 || hi > count) return { ok: false, error: outOfRange(lo < 1 ? lo : hi, count) }
      for (let p = lo; p <= hi; p++) out.add(p - 1)
      continue
    }
    const v = resolve(token, false)
    if (typeof v === 'string') return { ok: false, error: v }
    if (v < 1 || v > count) return { ok: false, error: outOfRange(v, count) }
    out.add(v - 1)
  }
  if (!out.size) return { ok: false, error: 'Enter the pages, for example 1-3, 5' }
  return { ok: true, pages: [...out].sort((x, y) => x - y) }
}

function outOfRange(n: number, count: number) {
  return `Page ${n} doesn't exist. This document has ${count} ${pageWord(count)}.`
}

/** Formats 0-based indices as a compact 1-based range: [0,1,2,4] -> "1-3, 5". */
export function formatPageRange(indices: number[]): string {
  const sorted = [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0).sort((a, b) => a - b)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(j > i ? `${sorted[i] + 1}-${sorted[j] + 1}` : `${sorted[i] + 1}`)
    i = j + 1
  }
  return parts.join(', ')
}

/** "page 3", "pages 1-3, 5" — for messages. */
export function describePages(indices: number[]): string {
  if (indices.length === 0) return 'no pages'
  return `${indices.length === 1 ? 'page' : 'pages'} ${formatPageRange(indices)}`
}

export function countLabel(n: number, one = 'page', many = 'pages'): string {
  return `${n} ${n === 1 ? one : many}`
}
