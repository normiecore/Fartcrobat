/**
 * Parses "1-3, 5, 8-" (1-based, open ranges allowed) into sorted page indices. Returns an error
 * message when the text is not a valid range for a document with `count` pages.
 */
export function parsePageRange(text: string, count: number): number[] | string {
  const parts = text
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return 'Enter the pages to recognize, for example 1-3, 5'
  const pages = new Set<number>()
  for (const part of parts) {
    const m = /^(\d+)?\s*(?:(-|–|to)\s*(\d+)?)?$/i.exec(part)
    if (!m || (!m[1] && !m[3])) return `“${part}” is not a page or range`
    const from = m[1] ? parseInt(m[1], 10) : 1
    const to = m[2] ? (m[3] ? parseInt(m[3], 10) : count) : from
    if (from < 1 || to < 1 || from > count || to > count) return `This document has pages 1 to ${count}`
    if (from > to) return `“${part}” goes backwards`
    for (let p = from; p <= to; p++) pages.add(p - 1)
  }
  return [...pages].sort((a, b) => a - b)
}
