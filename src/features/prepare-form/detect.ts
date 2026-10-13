/**
 * "Detect form fields automatically": finds places where a form expects input from the page text
 * and its line art. Pure functions (no MuPDF) so the heuristics are easy to test.
 *
 *  - runs of underscores after a label ("Name: ________")          -> text field named "Name"
 *  - horizontal rules with a label on their left or right under them -> text field
 *  - "Signature" / "Sign here" labels                                -> signature field
 *  - "Date" labels                                                   -> date field
 *  - box glyphs (☐ □ ❏), "[ ]" and small drawn squares               -> check box named from the text after it
 *  - empty drawn boxes of text-field size                            -> text field (multi-line when tall)
 */
import type { Rect } from '@shared/geometry'
import type { DetectedField, PFType } from './model'

export interface DetectChar {
  c: string
  rect: Rect
}

export interface DetectLine {
  bbox: Rect
  chars: DetectChar[]
}

export interface DetectShape {
  kind: 'hline' | 'rect'
  rect: Rect
}

export interface DetectInput {
  page: number
  width: number
  height: number
  lines: DetectLine[]
  shapes: DetectShape[]
  /** Rectangles of widgets already on the page (detections overlapping them are dropped). */
  existing: Rect[]
}

/** Empty box characters, including Wingdings boxes exported as private-use code points. */
const BOX_GLYPHS = new Set(['☐', '□', '❏', '❐', '❑', '❒', '◻', '▢', '⬜', '⃞', '', '', '', ''])

const SIGNATURE_RE = /\b(signature|sign here|signed|signer|autograph)\b/i
const DATE_RE = /\b(date|dated|d\.?o\.?b\.?|birth ?day)\b/i

const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1])

function overlap(a: Rect, b: Rect): number {
  const x = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]))
  const y = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  return x * y
}

/** Intersection over the smaller area. */
function overlapRatio(a: Rect, b: Rect): number {
  const m = Math.min(area(a), area(b))
  return m > 0 ? overlap(a, b) / m : 0
}

function vOverlap(a: Rect, b: Rect): number {
  return Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
}

/** Turns label text into a field name ("Full name (as on passport):" -> "Full name"). */
export function nameFromLabel(label: string): string {
  let t = label
    .replace(/\(.*?\)/g, ' ')
    .replace(/[_.…]{2,}/g, ' ')
    .replace(/[:*#?!]+/g, ' ')
    .replace(/[^\p{L}\p{N}' &/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // labels of check boxes can be whole sentences: keep the first words
  const words = t.split(' ')
  if (words.length > 6) t = words.slice(0, 6).join(' ')
  if (t.length > 40) t = t.slice(0, 40).trim()
  return t.replace(/^[-&/' ]+|[-&/' ]+$/g, '')
}

function typeForLabel(label: string, fallback: PFType = 'text'): PFType {
  if (SIGNATURE_RE.test(label)) return 'signature'
  if (DATE_RE.test(label)) return 'date'
  return fallback
}

function charsText(chars: DetectChar[]): string {
  return chars.map((c) => c.c).join('')
}

function unionRect(rects: Rect[]): Rect {
  return rects.reduce(
    (a, r) => [Math.min(a[0], r[0]), Math.min(a[1], r[1]), Math.max(a[2], r[2]), Math.max(a[3], r[3])],
    [Infinity, Infinity, -Infinity, -Infinity] as Rect
  )
}

/** Text between two x positions on a line (label search). */
function textBetween(line: DetectLine, x0: number, x1: number): string {
  return charsText(
    line.chars.filter((c) => (c.rect[0] + c.rect[2]) / 2 >= x0 && (c.rect[0] + c.rect[2]) / 2 <= x1)
  )
}

/** Last "phrase" of a text: what follows the previous blank, colon run or wide gap. */
function lastPhrase(chars: DetectChar[]): string {
  if (!chars.length) return ''
  // split on wide gaps (more than ~1.5 em between characters)
  let start = 0
  for (let i = 1; i < chars.length; i++) {
    const gap = chars[i].rect[0] - chars[i - 1].rect[2]
    const em = chars[i].rect[3] - chars[i].rect[1]
    if (gap > em * 1.5) start = i
  }
  const s = charsText(chars.slice(start)).replace(/_+/g, ' ')
  return s.trim()
}

function fieldHeight(lineHeight: number, type: PFType): number {
  if (type === 'signature') return Math.max(24, Math.min(40, lineHeight * 2.2))
  return Math.max(14, Math.min(24, lineHeight * 1.3))
}

export function detectFields(input: DetectInput): DetectedField[] {
  const out: DetectedField[] = []
  const lines = input.lines.filter((l) => l.chars.length)
  const textRects = lines.map((l) => l.bbox)

  const push = (f: DetectedField) => {
    const r = f.rect
    if (r[2] - r[0] < 4 || r[3] - r[1] < 4) return
    if (r[0] < 0 || r[1] < 0 || r[2] > input.width + 1 || r[3] > input.height + 1) return
    for (const e of input.existing) if (overlapRatio(e, r) > 0.3) return
    for (const o of out) if (overlapRatio(o.rect, r) > 0.3) return
    out.push(f)
  }

  /** Label for a blank that starts at x on a line: the phrase on its left, else the text below it. */
  const labelFor = (line: DetectLine | null, x0: number, x1: number, y: number, prevEnd: number): string => {
    if (line) {
      const left = line.chars.filter((c) => c.rect[2] <= x0 + 1 && c.rect[0] >= prevEnd - 1 && c.c !== '_')
      const phrase = lastPhrase(left)
      if (nameFromLabel(phrase)) return phrase
    }
    // text right below the blank ("Signature" printed under the line)
    const below = lines
      .filter((l) => l.bbox[1] >= y - 2 && l.bbox[1] <= y + 16 && l.bbox[0] < x1 && l.bbox[2] > x0)
      .sort((a, b) => a.bbox[1] - b.bbox[1])[0]
    if (below) return textBetween(below, x0 - 4, x1 + 4).trim()
    return ''
  }

  // 1. runs of underscores in the text
  for (const line of lines) {
    let i = 0
    let prevEnd = -Infinity
    const cs = line.chars
    while (i < cs.length) {
      if (cs[i].c !== '_') {
        i++
        continue
      }
      let j = i
      while (
        j < cs.length &&
        (cs[j].c === '_' || (cs[j].c === ' ' && j + 1 < cs.length && cs[j + 1].c === '_'))
      )
        j++
      const run = cs.slice(i, j).filter((c) => c.c === '_')
      if (run.length >= 3) {
        const r = unionRect(run.map((c) => c.rect))
        const lh = line.bbox[3] - line.bbox[1]
        const label = labelFor(line, r[0], r[2], r[3], prevEnd)
        const type = typeForLabel(label)
        const h = fieldHeight(lh, type)
        const bottom = r[3] - lh * 0.12
        push({
          page: input.page,
          type,
          rect: [r[0], bottom - h, r[2], bottom],
          name: nameFromLabel(label),
          source: 'underscores'
        })
        prevEnd = r[2]
      }
      i = j
    }
  }

  // 2. box glyphs and "[ ]" check boxes
  for (const line of lines) {
    const cs = line.chars
    for (let i = 0; i < cs.length; i++) {
      let rect: Rect | null = null
      let after = i + 1
      let source: DetectedField['source'] = 'glyph'
      if (BOX_GLYPHS.has(cs[i].c)) rect = cs[i].rect
      else if (cs[i].c === '[') {
        let j = i + 1
        while (j < cs.length && cs[j].c === ' ' && j - i <= 4) j++
        if (j < cs.length && cs[j].c === ']' && j > i) {
          rect = unionRect([cs[i].rect, cs[j].rect])
          after = j + 1
          source = 'brackets'
        }
      }
      if (!rect) continue
      // square it around its centre
      const size = Math.max(
        8,
        Math.min(rect[2] - rect[0], rect[3] - rect[1]) * (source === 'glyph' ? 0.8 : 0.75)
      )
      const cx = (rect[0] + rect[2]) / 2
      const cy = (rect[1] + rect[3]) / 2
      // the label runs until the next box on the line
      let k = after
      while (k < cs.length && !BOX_GLYPHS.has(cs[k].c) && cs[k].c !== '[') k++
      const label = charsText(cs.slice(after, k)).trim()
      push({
        page: input.page,
        type: 'checkbox',
        rect: [cx - size / 2, cy - size / 2, cx + size / 2, cy + size / 2],
        name: nameFromLabel(label),
        source
      })
    }
  }

  // 3. line art: horizontal rules and boxes
  for (const sh of input.shapes) {
    const r = sh.rect
    const w = r[2] - r[0]
    const h = r[3] - r[1]
    if (sh.kind === 'hline' || (sh.kind === 'rect' && h <= 2.5 && w >= 30)) {
      if (w < 30) continue
      const y = (r[1] + r[3]) / 2
      // an underline of text (text sitting right on the rule) is not a blank
      const onTop = lines.some(
        (l) =>
          Math.abs(l.bbox[3] - y) < 4 &&
          l.bbox[0] < r[2] - w * 0.2 &&
          l.bbox[2] > r[0] + w * 0.2 &&
          !/^_+$/.test(charsText(l.chars).trim())
      )
      if (onTop) continue
      // label on the left, on the same baseline
      const leftLine = lines
        .filter(
          (l) =>
            vOverlap(l.bbox, [r[0], y - 14, r[2], y + 1]) > 2 && l.bbox[0] < r[0] && r[0] - l.bbox[0] < 400
        )
        .sort((a, b) => b.bbox[2] - a.bbox[2])[0]
      let label = ''
      if (leftLine) {
        const phrase = lastPhrase(leftLine.chars.filter((c) => c.rect[2] <= r[0] + 2))
        if (
          nameFromLabel(phrase) &&
          r[0] - leftLine.chars.filter((c) => c.rect[2] <= r[0] + 2).slice(-1)[0]!.rect[2] < 120
        )
          label = phrase
      }
      if (!label) label = labelFor(null, r[0], r[2], y, -Infinity)
      // a rule without any label is probably decoration (separators, table borders)
      if (!nameFromLabel(label)) continue
      if (w > input.width * 0.85 && !leftLine) continue
      const lh = leftLine ? leftLine.bbox[3] - leftLine.bbox[1] : 12
      const type = typeForLabel(label)
      const fh = fieldHeight(lh, type)
      push({
        page: input.page,
        type,
        rect: [r[0], y - fh, r[2], y - 0.5],
        name: nameFromLabel(label),
        source: 'line'
      })
      continue
    }
    if (sh.kind !== 'rect') continue
    // ignore boxes that contain text (frames around paragraphs, table cells with content)
    const hasText = textRects.some(
      (t) => overlapRatio(t, r) > 0.5 && area(t) < area(r) * 1.5 && overlap(t, r) > area(t) * 0.5
    )
    if (hasText) continue
    const square = w >= 6 && w <= 24 && h >= 6 && h <= 24 && Math.abs(w - h) <= Math.max(w, h) * 0.25
    if (square) {
      const right = lines
        .filter((l) => vOverlap(l.bbox, r) > h * 0.3 && l.bbox[0] >= r[2] - 2 && l.bbox[0] - r[2] < 40)
        .sort((a, b) => a.bbox[0] - b.bbox[0])[0]
      const label = right ? lastPhrase(right.chars.filter((c) => c.rect[0] >= r[2] - 2).slice(0, 60)) : ''
      push({ page: input.page, type: 'checkbox', rect: r, name: nameFromLabel(label), source: 'box' })
      continue
    }
    if (w >= 40 && h >= 12 && h <= 120 && w <= input.width * 0.95) {
      // label on the left or right above
      const leftLine = lines
        .filter(
          (l) =>
            vOverlap(l.bbox, r) > Math.min(h, l.bbox[3] - l.bbox[1]) * 0.5 &&
            l.bbox[2] <= r[0] + 2 &&
            r[0] - l.bbox[2] < 120
        )
        .sort((a, b) => b.bbox[2] - a.bbox[2])[0]
      const above = lines
        .filter((l) => l.bbox[3] <= r[1] + 2 && r[1] - l.bbox[3] < 14 && l.bbox[0] < r[2] && l.bbox[2] > r[0])
        .sort((a, b) => b.bbox[3] - a.bbox[3])[0]
      const label = leftLine ? lastPhrase(leftLine.chars) : above ? lastPhrase(above.chars) : ''
      const type = typeForLabel(label)
      push({ page: input.page, type, rect: r, name: nameFromLabel(label), source: 'box' })
    }
  }
  return out
}
