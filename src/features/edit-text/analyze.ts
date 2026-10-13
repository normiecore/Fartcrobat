/**
 * Groups page text lines into editable paragraphs ("text boxes") and describes each one in a
 * form the editor understands: styled runs, box geometry, alignment and line spacing.
 */
import type { Point, Quad, Rect } from '@shared/geometry'
import type { RawChar, RawLine } from './extract'
import {
  classifyFont,
  familyForClass,
  intToHex,
  normalizeRuns,
  runsText,
  stripSubset,
  type Align,
  type FontChoice,
  type Run,
  type TextBlockInfo
} from './model'

/** A line measured in its own text frame (u along the baseline, v perpendicular, "down"). */
interface MLine {
  raw: RawLine
  d: Point
  n: Point
  /** Non-space characters with their projections. */
  chars: { ch: RawChar; idx: number; u0: number; u1: number; top: number; bottom: number; v: number }[]
  u0: number
  u1: number
  v: number
  top: number
  bottom: number
  size: number
  font: string
  fonts: Set<string>
}

export interface AnalyzedBlock {
  info: TextBlockInfo
  lines: RawLine[]
  /** Every character of the block (spaces included). */
  chars: RawChar[]
}

const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1]

function measure(raw: RawLine): MLine | null {
  if (raw.wmode !== 0) return null
  const len = Math.hypot(raw.dir[0], raw.dir[1]) || 1
  const d: Point = [raw.dir[0] / len, raw.dir[1] / len]
  const n: Point = [-d[1], d[0]]
  const chars: MLine['chars'] = []
  const sizes = new Map<number, number>()
  const fontCount = new Map<string, number>()
  for (let idx = 0; idx < raw.chars.length; idx++) {
    const ch = raw.chars[idx]
    if (/\s/.test(ch.c)) continue
    const q = ch.quad
    const us = [dot([q[0], q[1]], d), dot([q[2], q[3]], d), dot([q[4], q[5]], d), dot([q[6], q[7]], d)]
    const vs = [dot([q[0], q[1]], n), dot([q[2], q[3]], n), dot([q[4], q[5]], n), dot([q[6], q[7]], n)]
    chars.push({
      ch,
      idx,
      u0: Math.min(...us),
      u1: Math.max(...us),
      top: Math.min(...vs),
      bottom: Math.max(...vs),
      v: dot([ch.ox, ch.oy], n)
    })
    const sz = Math.round(ch.size * 100) / 100
    sizes.set(sz, (sizes.get(sz) ?? 0) + 1)
    fontCount.set(ch.font, (fontCount.get(ch.font) ?? 0) + 1)
  }
  if (!chars.length) return null
  const vSorted = chars.map((c) => c.v).sort((a, b) => a - b)
  let font = ''
  let best = -1
  for (const [f, c] of fontCount) if (c > best) [font, best] = [f, c]
  return {
    raw,
    d,
    n,
    chars,
    u0: Math.min(...chars.map((c) => c.u0)),
    u1: Math.max(...chars.map((c) => c.u1)),
    v: vSorted[vSorted.length >> 1],
    top: Math.min(...chars.map((c) => c.top)),
    bottom: Math.max(...chars.map((c) => c.bottom)),
    size: Math.max(...chars.map((c) => c.ch.size)),
    font,
    fonts: new Set(fontCount.keys())
  }
}

interface Para {
  lines: MLine[]
  gap: number
}

function fits(p: Para, l: MLine): boolean {
  const last = p.lines[p.lines.length - 1]
  if (dot(last.d, l.d) < 0.999) return false
  // baseline distance (both lines share the same frame)
  const gap = l.v - last.v
  const ref = Math.max(last.size, l.size)
  if (gap < 0.6 * ref || gap > 1.75 * ref) return false
  if (p.lines.length >= 2 && Math.abs(gap - p.gap) > 0.2 * p.gap + 0.5) return false
  const ratio = l.size / last.size
  if (ratio < 0.85 || ratio > 1.18) return false
  if (!(last.fonts.has(l.font) || l.fonts.has(last.font))) return false
  // horizontal overlap with the paragraph
  const left = Math.min(...p.lines.map((x) => x.u0))
  const right = Math.max(...p.lines.map((x) => x.u1))
  const overlap = Math.min(right, l.u1) - Math.max(left, l.u0)
  if (overlap < 0.5 * Math.min(right - left, l.u1 - l.u0)) return false
  // an indented line after lines sharing a left edge starts a new paragraph
  if (p.lines.length >= 2 && p.lines.every((x) => Math.abs(x.u0 - left) < 1) && l.u0 > left + 0.8 * l.size)
    return false
  return true
}

function wordWidth(l: MLine): number {
  // width of the first word of a line
  const raw = l.raw.chars
  const first = l.chars[0]
  let last = first
  for (const c of l.chars) {
    let gapBefore = false
    for (let k = first.idx; k < c.idx; k++) if (/\s/.test(raw[k].c)) gapBefore = true
    if (gapBefore) break
    last = c
  }
  return last.u1 - first.u0
}

function round(v: number, digits = 2) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

function detectAlign(lines: MLine[], pageCenter: Point, pageExtent: number): Align {
  const tol = 1.5
  const left = Math.min(...lines.map((l) => l.u0))
  const right = Math.max(...lines.map((l) => l.u1))
  if (lines.length === 1) {
    const l = lines[0]
    const uc = dot(pageCenter, l.d)
    const mid = (l.u0 + l.u1) / 2
    if (Math.abs(mid - uc) < 1.5 && l.u0 - (uc - pageExtent / 2) > 0.15 * pageExtent) return 'center'
    return 'left'
  }
  const sameLeft = lines.every((l) => Math.abs(l.u0 - left) <= tol)
  const sameRight = lines.every((l) => Math.abs(l.u1 - right) <= tol)
  const body = lines.slice(0, -1)
  const lastLine = lines[lines.length - 1]
  if (sameLeft && !sameRight) {
    const bodyFull = body.every((l) => Math.abs(l.u1 - right) <= tol)
    if (body.length >= 2 && bodyFull && lastLine.u1 < right - tol) return 'justify'
    return 'left'
  }
  if (sameRight && !sameLeft) return 'right'
  if (!sameLeft && !sameRight) {
    const mid = (left + right) / 2
    if (lines.every((l) => Math.abs((l.u0 + l.u1) / 2 - mid) <= tol)) return 'center'
  }
  return 'left'
}

function styleOfChar(ch: RawChar, embedded: (font: string) => boolean): Omit<Run, 'text'> {
  const key = embedded(ch.font) ? 'orig:' + ch.font : familyForClass(classifyFont(ch.font, ch))
  return {
    font: key,
    size: round(ch.size),
    color: intToHex(ch.color),
    bold: ch.bold,
    italic: ch.italic,
    underline: false
  }
}

function buildBlock(
  p: Para,
  embedded: (font: string) => boolean,
  pageCenter: Point,
  pageExtent: number
): AnalyzedBlock {
  const lines = p.lines
  const first = lines[0]
  const { d, n } = first
  // all lines share the first line's frame (see fits())
  const proj = lines.map((l) => ({ v: l.v, top: l.top, bottom: l.bottom, u0: l.u0, u1: l.u1 }))
  const left = Math.min(...proj.map((x) => x.u0))
  const right = Math.max(...proj.map((x) => x.u1))
  const width = right - left
  const size0 = first.size
  const ascent = Math.max(0.5, (proj[0].v - proj[0].top) / size0)
  const top = proj[0].v - ascent * size0
  const bottom = Math.max(...proj.map((x) => x.bottom))
  const origin: Point = [left * d[0] + top * n[0], left * d[1] + top * n[1]]
  const sizes = lines.map((l) => l.size).sort((a, b) => a - b)
  const domSize = sizes[sizes.length >> 1]
  let lineSpacing = 1.2
  if (lines.length > 1) {
    let sum = 0
    for (let k = 1; k < proj.length; k++) sum += proj[k].v - proj[k - 1].v
    lineSpacing = round(sum / (proj.length - 1) / domSize)
  }
  const align = detectAlign(lines, pageCenter, pageExtent)

  // average width of a space, for line-break analysis
  let spaceW = 0
  let spaces = 0
  for (const l of lines) {
    const raw = l.raw.chars
    for (let k = 0; k + 1 < raw.length; k++) {
      if (raw[k].c === ' ' && !/\s/.test(raw[k + 1].c)) {
        const a = dot([raw[k].ox, raw[k].oy], d)
        const b = dot([raw[k + 1].ox, raw[k + 1].oy], d)
        if (b > a) {
          spaceW += b - a
          spaces++
        }
      }
    }
  }
  spaceW = spaces ? spaceW / spaces : 0.28 * domSize

  // line breaks: a break is "hard" (kept as a new line) when the next line's first word would
  // have fitted on the line, i.e. the author ended the line on purpose
  const breaks = lines
    .slice(0, -1)
    .map((l, li) => align !== 'justify' && l.u1 - l.u0 + spaceW + wordWidth(lines[li + 1]) <= width + 0.5)
  // list-like blocks (addresses, short items): when some lines clearly end on purpose and even the
  // longest line is only a few words, every line is its own item
  const words = (l: MLine) =>
    l.raw.chars
      .map((c) => c.c)
      .join('')
      .trim()
      .split(/\s+/).length
  if (breaks.some(Boolean) && Math.max(...lines.map(words)) <= 5) breaks.fill(true)

  // content
  const runs: Run[] = []
  const all: RawChar[] = []
  let unreadable = false
  lines.forEach((l, li) => {
    const raw = l.raw.chars
    all.push(...raw)
    let end = raw.length
    while (end > 0 && /\s/.test(raw[end - 1].c)) end--
    let start = 0
    if (li > 0) while (start < end && /\s/.test(raw[start].c)) start++
    for (let k = start; k < end; k++) {
      const ch = raw[k]
      if (ch.c === '\uFFFD') unreadable = true
      const text = ch.c === '\t' ? ' ' : ch.c
      runs.push({ ...styleOfChar(ch, embedded), text })
    }
    if (li < lines.length - 1) {
      const lastCh = raw[Math.max(0, end - 1)]
      const style = styleOfChar(lastCh, embedded)
      if (breaks[li]) runs.push({ ...style, text: '\n' })
      else if (!/[-‐‑­]$/.test(lastCh.c)) runs.push({ ...style, text: ' ' })
    }
  })
  const norm = normalizeRuns(runs)

  // fonts offered in the font list
  const fonts: FontChoice[] = []
  for (const r of norm) {
    if (!r.font.startsWith('orig:') || fonts.some((f) => f.key === r.font)) continue
    const name = r.font.slice(5)
    const sample = all.find((c) => c.font === name)
    fonts.push({
      key: r.font,
      label: stripSubset(name),
      cls: classifyFont(name, sample ?? {}),
      bold: !!sample?.bold,
      italic: !!sample?.italic
    })
  }

  // geometry in page space
  const P = (u: number, v: number): Point => [u * d[0] + v * n[0], u * d[1] + v * n[1]]
  const quads: Quad[] = proj.map((x) => {
    const a = P(x.u0, x.top)
    const b = P(x.u1, x.top)
    const c = P(x.u0, x.bottom)
    const e = P(x.u1, x.bottom)
    return [a[0], a[1], b[0], b[1], c[0], c[1], e[0], e[1]]
  })
  const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]])
  const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]])
  const bbox: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  const start = lines[0].raw.start
  const end = lines[lines.length - 1].raw.end
  const info: TextBlockInfo = {
    id: `${start}-${end}`,
    start,
    end,
    bbox,
    quads,
    frame: { origin, dir: d, width: Math.max(1, width) },
    height: bottom - top,
    runs: norm,
    fonts,
    align,
    lineSpacing,
    wrap: lines.length > 1,
    ascent: round(ascent, 4),
    text: runsText(norm),
    unreadable
  }
  return { info, lines: lines.map((l) => l.raw), chars: all }
}

/** Finds the editable paragraphs of a page. */
export function analyzeLines(
  raw: RawLine[],
  opts: { pageWidth: number; pageHeight: number; embedded: (font: string) => boolean }
): AnalyzedBlock[] {
  const paras: Para[] = []
  for (const r of raw) {
    const l = measure(r)
    if (!l) continue
    let target: Para | null = null
    for (let k = paras.length - 1; k >= Math.max(0, paras.length - 6); k--) {
      if (fits(paras[k], l)) {
        target = paras[k]
        break
      }
    }
    if (target) {
      const last = target.lines[target.lines.length - 1]
      const gap = l.v - last.v
      target.gap =
        target.lines.length === 1 ? gap : (target.gap * (target.lines.length - 1) + gap) / target.lines.length
      target.lines.push(l)
    } else paras.push({ lines: [l], gap: 0 })
  }
  const center: Point = [opts.pageWidth / 2, opts.pageHeight / 2]
  return paras.map((p) => {
    const d = p.lines[0].d
    const extent = Math.abs(d[0]) * opts.pageWidth + Math.abs(d[1]) * opts.pageHeight
    return buildBlock(p, opts.embedded, center, extent)
  })
}
