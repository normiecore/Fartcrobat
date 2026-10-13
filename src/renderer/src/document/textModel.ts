import type { PageText } from '@engine/ops/text'
import type { Point, Quad, Rect } from '@shared/geometry'
import { quadToRect } from '@shared/geometry'

export type { PageText }

/** A range of characters [start, end) on one page. */
export interface TextRange {
  page: number
  start: number
  end: number
}

export function charQuad(t: PageText, i: number): Quad {
  const q = t.quads
  const k = i * 8
  return [q[k], q[k + 1], q[k + 2], q[k + 3], q[k + 4], q[k + 5], q[k + 6], q[k + 7]]
}

export function charRect(t: PageText, i: number): Rect {
  return quadToRect(charQuad(t, i))
}

function lineIndexOf(t: PageText, charIndex: number): number {
  let lo = 0
  let hi = t.lines.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const l = t.lines[mid]
    if (charIndex < l.start) hi = mid - 1
    else if (charIndex > l.end) lo = mid + 1
    else return mid
  }
  return Math.max(0, Math.min(t.lines.length - 1, lo))
}

function distToRect(p: Point, r: Rect): number {
  const dx = Math.max(r[0] - p[0], 0, p[0] - r[2])
  const dy = Math.max(r[1] - p[1], 0, p[1] - r[3])
  return Math.hypot(dx, dy)
}

/** True when p lies on (or very close to) a character. */
export function isOverText(t: PageText, p: Point, pad = 2): boolean {
  for (const line of t.lines) {
    const b = line.bbox
    if (p[0] < b[0] - pad || p[0] > b[2] + pad || p[1] < b[1] - pad || p[1] > b[3] + pad) continue
    return true
  }
  return false
}

/** Index of the line nearest to p: inside its bbox vertically first, else by distance. */
function nearestLineIndex(t: PageText, p: Point): number {
  let best = -1
  let bestD = Infinity
  for (let li = 0; li < t.lines.length; li++) {
    const b = t.lines[li].bbox
    const d = distToRect(p, b) + (p[1] >= b[1] && p[1] <= b[3] ? 0 : 1000)
    if (d < bestD) {
      bestD = d
      best = li
    }
  }
  if (bestD >= 1000) {
    // not vertically inside any line; pick nearest by plain distance
    bestD = Infinity
    for (let li = 0; li < t.lines.length; li++) {
      const d = distToRect(p, t.lines[li].bbox)
      if (d < bestD) {
        bestD = d
        best = li
      }
    }
  }
  return best
}

/** Text runs along x (false for vertical lines, e.g. on /Rotate 90 pages). */
function isHorizontal(line: { dir: Point }): boolean {
  return Math.abs(line.dir[0]) >= Math.abs(line.dir[1])
}

/**
 * Finds the caret position (index between characters) closest to point p, in reading order.
 * Returns -1 when the page has no text.
 */
export function caretAt(t: PageText, p: Point): number {
  if (!t.lines.length) return -1
  const line = t.lines[nearestLineIndex(t, p)]
  const horizontal = isHorizontal(line)
  for (let i = line.start; i < line.end; i++) {
    const r = charRect(t, i)
    if (horizontal) {
      const mid = (r[0] + r[2]) / 2
      if (line.dir[0] >= 0 ? p[0] < mid : p[0] > mid) return i
    } else {
      const mid = (r[1] + r[3]) / 2
      if (line.dir[1] >= 0 ? p[1] < mid : p[1] > mid) return i
    }
  }
  return line.end
}

/**
 * Index of the character under point p (or the nearest character of the nearest line). Unlike
 * caretAt, which returns the gap between two characters, this is the character itself: use it to
 * pick the word or line under a double or triple click. Returns -1 when the page has no text.
 */
export function charIndexAt(t: PageText, p: Point): number {
  if (!t.lines.length) return -1
  const line = t.lines[nearestLineIndex(t, p)]
  if (line.end <= line.start) return line.start
  const horizontal = isHorizontal(line)
  let best = line.start
  let bestD = Infinity
  for (let i = line.start; i < line.end; i++) {
    const r = charRect(t, i)
    const d = horizontal ? Math.max(r[0] - p[0], 0, p[0] - r[2]) : Math.max(r[1] - p[1], 0, p[1] - r[3])
    if (d < bestD) {
      bestD = d
      best = i
      if (d === 0) break
    }
  }
  return best
}

/** Expands [a, b) to whole words. */
export function wordAt(t: PageText, index: number): { start: number; end: number } | null {
  if (index < 0 || index >= t.text.length) return null
  const isWord = (c: string) => /[\p{L}\p{N}_'’-]/u.test(c)
  if (!isWord(t.text[index])) return { start: index, end: index + 1 }
  let s = index
  let e = index + 1
  while (s > 0 && isWord(t.text[s - 1])) s--
  while (e < t.text.length && isWord(t.text[e])) e++
  return { start: s, end: e }
}

export function lineAt(t: PageText, index: number): { start: number; end: number } | null {
  if (!t.lines.length) return null
  const l = t.lines[lineIndexOf(t, index)]
  return { start: l.start, end: l.end }
}

/** Selection rectangles (one per line segment) for a character range, in page space. */
export function rangeRects(t: PageText, start: number, end: number): Rect[] {
  const rects: Rect[] = []
  if (end <= start) return rects
  for (const line of t.lines) {
    const s = Math.max(start, line.start)
    const e = Math.min(end, line.end)
    if (e <= s) continue
    let r: Rect | null = null
    for (let i = s; i < e; i++) {
      const c = charRect(t, i)
      r = r ? [Math.min(r[0], c[0]), Math.min(r[1], c[1]), Math.max(r[2], c[2]), Math.max(r[3], c[3])] : c
    }
    if (r) {
      // Use the full line thickness for a tidy look: the line's height for horizontal text, its
      // width for vertical text (e.g. on /Rotate 90 pages), never its length.
      r = isHorizontal(line)
        ? [r[0], Math.min(r[1], line.bbox[1]), r[2], Math.max(r[3], line.bbox[3])]
        : [Math.min(r[0], line.bbox[0]), r[1], Math.max(r[2], line.bbox[2]), r[3]]
      rects.push(r)
    }
  }
  return rects
}

/** Character quads for a range, one merged quad per line (for highlight/redact annotations). */
export function rangeQuads(t: PageText, start: number, end: number): Quad[] {
  const quads: Quad[] = []
  for (const line of t.lines) {
    const s = Math.max(start, line.start)
    const e = Math.min(end, line.end)
    if (e <= s) continue
    // skip leading/trailing spaces
    let a = s
    let b = e
    while (a < b && /\s/.test(t.text[a])) a++
    while (b > a && /\s/.test(t.text[b - 1])) b--
    if (b <= a) continue
    const first = charQuad(t, a)
    const last = charQuad(t, b - 1)
    // ul, ur, ll, lr
    quads.push([first[0], first[1], last[2], last[3], first[4], first[5], last[6], last[7]])
  }
  return quads
}

export function rangeText(t: PageText, start: number, end: number): string {
  return t.text.slice(start, end)
}

// ---- search ------------------------------------------------------------------------------

export interface SearchOptions {
  matchCase?: boolean
  wholeWords?: boolean
  /** Treat the query as a regular expression (used by Find & Redact patterns). */
  regex?: boolean
}

export interface SearchHit {
  page: number
  start: number
  end: number
}

interface Normalized {
  text: string
  /** [start[i], end[i]) = the original characters that produced UTF-16 unit i of `text` */
  start: number[]
  end: number[]
}

/**
 * Collapses runs of whitespace (including line breaks) to single spaces and folds compatibility
 * characters and (unless matchCase) case, keeping an index map back to the original text. Folding
 * can change lengths ('ﬁ' -> 'fi', 'İ' -> 'i̇', and astral characters are two UTF-16 units), so the
 * map has one entry per UTF-16 unit of the output.
 */
function normalize(text: string, matchCase: boolean): Normalized {
  const out: string[] = []
  const start: number[] = []
  const end: number[] = []
  let prevSpace = false
  for (let i = 0; i < text.length; ) {
    const c = String.fromCodePoint(text.codePointAt(i)!)
    const next = i + c.length
    if (/\s/.test(c)) {
      if (!prevSpace) {
        out.push(' ')
        start.push(i)
        end.push(next)
        prevSpace = true
      }
    } else {
      // Fold common ligatures and drop soft hyphens so "office" matches "oﬃce".
      const nfkc = c === '­' ? '' : c.normalize('NFKC')
      const folded = matchCase ? nfkc : nfkc.toLowerCase()
      out.push(folded)
      for (let k = 0; k < folded.length; k++) {
        start.push(i)
        end.push(next)
      }
      if (folded) prevSpace = false
    }
    i = next
  }
  return { text: out.join(''), start, end }
}

const WORD = /[\p{L}\p{N}_]/u

export function searchPage(t: PageText, query: string, opts: SearchOptions = {}): SearchHit[] {
  const hits: SearchHit[] = []
  if (!query) return hits
  const n = normalize(t.text, !!opts.matchCase)
  if (opts.regex) {
    let re: RegExp
    try {
      re = new RegExp(query, opts.matchCase ? 'gu' : 'giu')
    } catch {
      return hits
    }
    for (const m of n.text.matchAll(re)) {
      if (!m[0].length) continue
      const s = m.index!
      const e = s + m[0].length
      hits.push({ page: t.pageIndex, start: n.start[s], end: n.end[e - 1] })
    }
    return hits
  }
  const q = normalize(query.trim(), !!opts.matchCase).text
  if (!q) return hits
  let from = 0
  for (;;) {
    const s = n.text.indexOf(q, from)
    if (s < 0) break
    const e = s + q.length
    from = s + 1
    if (opts.wholeWords) {
      const before = s > 0 ? n.text[s - 1] : ' '
      const after = e < n.text.length ? n.text[e] : ' '
      if (WORD.test(before) || WORD.test(after)) continue
    }
    hits.push({ page: t.pageIndex, start: n.start[s], end: n.end[e - 1] })
  }
  return hits
}

/** A short excerpt around a hit, for result lists. */
export function hitContext(t: PageText, hit: SearchHit, radius = 40): { before: string; match: string; after: string } {
  const clean = (s: string) => s.replace(/\s+/g, ' ')
  return {
    before: clean(t.text.slice(Math.max(0, hit.start - radius), hit.start)).trimStart(),
    match: clean(t.text.slice(hit.start, hit.end)),
    after: clean(t.text.slice(hit.end, hit.end + radius)).trimEnd()
  }
}
