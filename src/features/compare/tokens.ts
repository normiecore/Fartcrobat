import type { PageText } from '@engine/ops/text'
import type { Rect } from '@shared/geometry'
import type { Token } from './types'

/** Punctuation split off the end of a word ("team." -> "team" + "."). */
const TRAIL = new Set([...'.,;:!?)]}”’"\'»…'])
/** Punctuation split off the start of a word ("“hello" -> "“" + "hello"). */
const LEAD = new Set([...'([{“‘"\'«'])

const isSpace = (c: string) => /\s/.test(c)

/** Normalises a word for comparison: compatibility forms (ligatures), no soft hyphens. */
export function normalizeWord(s: string): string {
  return s.normalize('NFKC').replace(/\u00ad/g, '')
}

function charRect(q: Float32Array, i: number): Rect {
  const k = i * 8
  const xs = [q[k], q[k + 2], q[k + 4], q[k + 6]]
  const ys = [q[k + 1], q[k + 3], q[k + 5], q[k + 7]]
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}

function unionRect(a: Rect | null, b: Rect): Rect {
  return a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b
}

interface Piece {
  start: number
  end: number
  ws: string
}

/** Splits a whitespace-delimited word [start, end) into leading punctuation, core and trailing punctuation. */
function splitPunctuation(text: string, start: number, end: number, ws: string): Piece[] {
  let a = start
  let b = end
  const lead: Piece[] = []
  const trail: Piece[] = []
  while (b - a > 1 && TRAIL.has(text[b - 1])) {
    trail.unshift({ start: b - 1, end: b, ws: '' })
    b--
  }
  while (b - a > 1 && LEAD.has(text[a])) {
    lead.push({ start: a, end: a + 1, ws: '' })
    a++
  }
  const pieces = [...lead, { start: a, end: b, ws: '' }, ...trail]
  pieces[0].ws = ws
  return pieces
}

/**
 * Splits the text of a page into word tokens with positions and formatting. Words are separated
 * by whitespace; punctuation at either end becomes its own token so "finance," vs "audit," reads
 * as a change of one word. A word hyphenated over a line break is joined back together.
 */
export function tokenizePage(t: PageText): Token[] {
  const text = t.text
  const spans = t.spans
  let spanIdx = 0
  const spanAt = (i: number) => {
    while (spanIdx < spans.length && spans[spanIdx].end <= i) spanIdx++
    // spans are in order; fall back to a linear search if we jumped backwards
    const s = spans[spanIdx]
    if (s && s.start <= i && i < s.end) return s
    return spans.find((x) => x.start <= i && i < x.end) ?? null
  }
  const tokens: (Token & { blockLine: number; lineEnd: boolean })[] = []
  t.lines.forEach((line, li) => {
    let i = line.start
    let ws = ' '
    let first = true
    while (i < line.end) {
      if (isSpace(text[i])) {
        let j = i
        while (j < line.end && isSpace(text[j])) j++
        ws = first ? ' ' : text.slice(i, j).replace(/[\u00a0\u2007\u202f]/g, ' ')
        i = j
        continue
      }
      let j = i
      while (j < line.end && !isSpace(text[j])) j++
      for (const p of splitPunctuation(text, i, j, ws)) {
        let rect: Rect | null = null
        for (let k = p.start; k < p.end; k++) rect = unionRect(rect, charRect(t.quads, k))
        const span = spanAt(p.start)
        const raw = text.slice(p.start, p.end)
        tokens.push({
          text: raw,
          norm: normalizeWord(raw),
          rects: [rect ?? [0, 0, 0, 0]],
          line: li,
          ws: p.ws,
          font: span?.font ?? '',
          size: span ? Math.round(span.size * 10) / 10 : 0,
          color: span?.color ?? 0,
          flags: span?.flags ?? 0,
          blockLine: line.block,
          lineEnd: false
        })
      }
      first = false
      ws = ' '
      i = j
    }
    if (tokens.length && tokens[tokens.length - 1].line === li) tokens[tokens.length - 1].lineEnd = true
  })

  // Join words hyphenated over a line break ("compar-" + "ison" -> "comparison").
  const out: Token[] = []
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]
    const next = tokens[k + 1]
    if (
      tok.lineEnd &&
      next &&
      next.line === tok.line + 1 &&
      next.blockLine === tok.blockLine &&
      /[\p{L}][-\u00ad]$/u.test(tok.text) &&
      /^\p{Ll}/u.test(next.text)
    ) {
      const joined = tok.text.slice(0, -1) + next.text
      out.push({
        text: joined,
        norm: normalizeWord(joined),
        rects: [...tok.rects, ...next.rects],
        line: tok.line,
        ws: tok.ws,
        font: tok.font,
        size: tok.size,
        color: tok.color,
        flags: tok.flags
      })
      k++
      continue
    }
    const { blockLine: _b, lineEnd: _e, ...plain } = tok
    out.push(plain)
  }
  return out
}
