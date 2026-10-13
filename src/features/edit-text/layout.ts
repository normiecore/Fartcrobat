/**
 * Lays out styled text inside a text box: hard breaks, word wrapping, alignment (including
 * justification) and baseline positions. Pure: glyph shaping is supplied by the caller, so the
 * same code runs against real font metrics in the engine and fake ones in tests.
 *
 * Coordinates are in the box frame: u along the baseline from the box's left edge, v downwards
 * from the box's top edge, both in points.
 */
import type { Align, RunStyle } from './model'

export interface ShapedGlyph {
  ch: string
  /** Advance in points (already multiplied by the font size). */
  adv: number
  /** Hex character code for the content stream; '' = a positional gap (space without a glyph). */
  code: string
  /** Font slot id (fonts are grouped into content-stream segments by slot). */
  slot: string
  space: boolean
}

export interface LayoutRun {
  style: RunStyle
  text: string
  shape: (ch: string) => ShapedGlyph
}

export interface LaidGlyph {
  g: ShapedGlyph
  run: number
  /** Position of the glyph origin along the baseline. */
  u: number
  /** Extra space added after this glyph (justification), in points. */
  extra: number
}

export interface LaidLine {
  glyphs: LaidGlyph[]
  /** Baseline offset from the top of the box. */
  v: number
  /** Width of the line without trailing spaces. */
  width: number
  /** Largest font size on the line. */
  size: number
  /** u of the first glyph (alignment offset). */
  offset: number
}

export interface LayoutOptions {
  wrap: boolean
  width: number
  align: Align
  lineSpacing: number
  ascent: number
}

export interface LayoutResult {
  lines: LaidLine[]
  /** Extent of the laid out text along u (min offset .. max end). */
  left: number
  right: number
  height: number
}

interface Item {
  g: ShapedGlyph
  run: number
  size: number
}

const EPS = 0.01

export function layoutText(runs: LayoutRun[], opts: LayoutOptions): LayoutResult {
  // 1. shape everything, split into paragraphs at hard breaks
  const paragraphs: { items: Item[]; size: number }[] = [{ items: [], size: runs[0]?.style.size ?? 12 }]
  runs.forEach((r, ri) => {
    for (const ch of Array.from(r.text)) {
      if (ch === '\n') {
        paragraphs.push({ items: [], size: r.style.size })
        continue
      }
      const cur = paragraphs[paragraphs.length - 1]
      if (!cur.items.length) cur.size = r.style.size
      cur.items.push({ g: r.shape(ch), run: ri, size: r.style.size })
    }
  })

  // 2. break paragraphs into lines
  const raw: { items: Item[]; last: boolean; size: number }[] = []
  for (const p of paragraphs) {
    const lines = breakParagraph(p.items, opts)
    lines.forEach((items, i) => raw.push({ items, last: i === lines.length - 1, size: p.size }))
  }

  // 3. place glyphs
  const out: LaidLine[] = []
  let left = Infinity
  let right = -Infinity
  let prevSize = 0
  let v = 0
  raw.forEach((line, k) => {
    const items = line.items
    let end = items.length
    while (end > 0 && items[end - 1].g.space) end--
    let width = 0
    for (let i = 0; i < end; i++) width += items[i].g.adv
    const size = items.length ? Math.max(...items.map((it) => it.size)) : line.size
    let offset = 0
    let extra = 0
    if (opts.align === 'center') offset = (opts.width - width) / 2
    else if (opts.align === 'right') offset = opts.width - width
    else if (opts.align === 'justify' && opts.wrap && !line.last) {
      let gaps = 0
      let start = 0
      while (start < end && items[start].g.space) start++
      for (let i = start; i < end; i++) if (items[i].g.space) gaps++
      if (gaps > 0 && opts.width - width > EPS) extra = (opts.width - width) / gaps
    }
    const glyphs: LaidGlyph[] = []
    let u = offset
    let leading = true
    items.forEach((it, i) => {
      if (!it.g.space) leading = false
      const add = extra && it.g.space && !leading && i < end ? extra : 0
      glyphs.push({ g: it.g, run: it.run, u, extra: add })
      u += it.g.adv + add
    })
    const lineWidth = width + (extra ? extra * glyphs.filter((g) => g.extra > 0).length : 0)
    v = k === 0 ? opts.ascent * size : v + opts.lineSpacing * Math.max(prevSize, size)
    prevSize = size
    if (end > 0) {
      left = Math.min(left, offset)
      right = Math.max(right, offset + lineWidth)
    }
    out.push({ glyphs, v, width: lineWidth, size, offset })
  })
  if (left === Infinity) {
    left = 0
    right = 0
  }
  const lastSize = out.length ? out[out.length - 1].size : 0
  return { lines: out, left, right, height: v + 0.3 * lastSize }
}

/** Greedy line breaking at spaces; words longer than the box are split between characters. */
function breakParagraph(items: Item[], opts: LayoutOptions): Item[][] {
  if (!opts.wrap) return [items]
  const max = opts.width + EPS
  const lines: Item[][] = []
  let line: Item[] = []
  let lineW = 0 // width up to the last non-space item
  let pending: Item[] = [] // spaces waiting for the next word
  let pendingW = 0
  let i = 0
  const flush = () => {
    lines.push(line)
    line = []
    lineW = 0
    pending = []
    pendingW = 0
  }
  while (i < items.length) {
    if (items[i].g.space) {
      pending.push(items[i])
      pendingW += items[i].g.adv
      i++
      continue
    }
    // next word
    let j = i
    let wordW = 0
    while (j < items.length && !items[j].g.space) {
      wordW += items[j].g.adv
      j++
    }
    const word = items.slice(i, j)
    const hasContent = line.some((it) => !it.g.space)
    if (hasContent && lineW + pendingW + wordW > max) {
      // wrap: the spaces at the break are dropped
      flush()
    } else {
      line.push(...pending)
      lineW += pendingW
      pending = []
      pendingW = 0
    }
    if (!line.some((it) => !it.g.space) && lineW + wordW > max) {
      // the word alone is too long: split it
      for (const it of word) {
        if (line.some((x) => !x.g.space) && lineW + it.g.adv > max) flush()
        line.push(it)
        lineW += it.g.adv
      }
    } else {
      line.push(...word)
      lineW += wordW
    }
    i = j
  }
  // trailing spaces stay on the last line (they do not count towards its width)
  line.push(...pending)
  lines.push(line)
  return lines
}
