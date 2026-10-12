/**
 * Shared data model of the Edit Text feature, used by the engine (worker) and the UI.
 *
 * A text box is a list of styled runs. A '\n' inside a run's text is a hard line break (new
 * paragraph); everything else is wrapped by the engine to the box width when `wrap` is set.
 */
import type { Point, Quad, Rect } from '@shared/geometry'

export type Align = 'left' | 'center' | 'right' | 'justify'

/** The standard fonts every PDF viewer has (written without embedding when possible). */
export type StandardFamily = 'Helvetica' | 'Times' | 'Courier'

export const STANDARD_FAMILIES: StandardFamily[] = ['Helvetica', 'Times', 'Courier']

export type FontClass = 'sans' | 'serif' | 'mono'

export interface RunStyle {
  /** A StandardFamily, or 'orig:<font name>' for a font embedded in the document. */
  font: string
  /** Points. */
  size: number
  /** #rrggbb */
  color: string
  bold: boolean
  italic: boolean
  underline: boolean
}

export interface Run extends RunStyle {
  text: string
}

/**
 * Where a text box sits on the page, in page space. `origin` is the top-left corner of the box,
 * `dir` the (unit) direction of the baseline, `width` the box width along `dir`.
 */
export interface Frame {
  origin: Point
  dir: Point
  width: number
}

/** An original font of a text block that can be offered in the font list. */
export interface FontChoice {
  key: string
  /** Display name, without the subset prefix. */
  label: string
  cls: FontClass
  bold: boolean
  italic: boolean
}

/** A paragraph of existing page text, as found by the engine. */
export interface TextBlockInfo {
  /** Stable for one version of the page: "<start>-<end>". */
  id: string
  /** Character range in the engine's page-content text (see engine.ts). */
  start: number
  end: number
  /** Axis-aligned bounds in page space. */
  bbox: Rect
  /** One quad per line, in page space (for covers and hit testing). */
  quads: Quad[]
  frame: Frame
  /** Box height along the frame's "down" direction, in points. */
  height: number
  runs: Run[]
  fonts: FontChoice[]
  align: Align
  /** Baseline-to-baseline distance as a multiple of the font size. */
  lineSpacing: number
  /** Multi-line paragraphs wrap to the box width; single lines grow instead. */
  wrap: boolean
  /** Distance from the box top to the first baseline, as a multiple of the first line's size. */
  ascent: number
  /** Plain text (hard breaks as '\n'). */
  text: string
  /** True when some characters could not be read (no Unicode mapping in the PDF). */
  unreadable: boolean
}

export interface TextEdit {
  /** The block being replaced (null for new text). `check` must equal the block's text. */
  source: { start: number; end: number; check: string } | null
  frame: Frame
  runs: Run[]
  align: Align
  lineSpacing: number
  wrap: boolean
  ascent: number
}

export interface CommitResult {
  /** Page-space bounds of the written text, or null when the box ended up empty. */
  bbox: Rect | null
  /** Original fonts that could not be reused (missing characters), shown to the user. */
  fallbackFonts: string[]
  /** Characters no available font could draw (they were replaced with '?'). */
  unsupported: string[]
  /** Overlapping glyphs of other text that were redrawn after removing the block. */
  restoredGlyphs: number
}

export const DEFAULT_STYLE: RunStyle = {
  font: 'Helvetica',
  size: 12,
  color: '#000000',
  bold: false,
  italic: false,
  underline: false
}

export const LINE_SPACING_PRESETS = [1, 1.15, 1.2, 1.5, 2]

export const FONT_SIZE_PRESETS = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72]

// ---- fonts ------------------------------------------------------------------------------

export function isOrigFont(key: string): boolean {
  return key.startsWith('orig:')
}

/** Removes a subset prefix ("ABCDEF+Calibri" -> "Calibri"). */
export function stripSubset(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '')
}

const MONO = /courier|mono|consol|menlo|typewriter|code|fixed|inconsolata|cousine/i
const SANS =
  /sans|arial|arimo|helvet|verdana|tahoma|calibri|carlito|segoe|gothic|grotesk|inter\b|roboto|lato|ubuntu|cantarell|trebuchet|franklin|futura|avenir|myriad|frutiger|univers|lucida ?grande|montserrat|poppins|raleway|nunito|oswald|candara|corbel|aptos|selawik|bahnschrift|frank ?ruhl|geneva|optima|century ?gothic/i
const SERIF =
  /times|serif|roman|georgia|garamond|cambria|caladea|palatino|minion|book|baskerville|caslon|didot|tinos|charter|constantia|century|bodoni|merriweather|playfair|perpetua|rockwell|sabon|utopia|lora\b|crimson|goudy|bembo|plantin|cochin|hoefler|charis|gentium|literata|stix|cmr\d|lmroman/i

/** Guesses the kind of a font from its name and MuPDF flags (names are more reliable than flags). */
export function classifyFont(name: string, flags: { serif?: boolean; mono?: boolean } = {}): FontClass {
  const n = stripSubset(name)
  if (flags.mono || MONO.test(n)) return 'mono'
  if (SANS.test(n)) return 'sans'
  if (SERIF.test(n)) return 'serif'
  return flags.serif ? 'serif' : 'sans'
}

export function familyForClass(cls: FontClass): StandardFamily {
  return cls === 'serif' ? 'Times' : cls === 'mono' ? 'Courier' : 'Helvetica'
}

/** Base-14 font name for a family and style. */
export function standardFontName(family: StandardFamily, bold: boolean, italic: boolean): string {
  if (family === 'Times') {
    if (bold && italic) return 'Times-BoldItalic'
    if (bold) return 'Times-Bold'
    if (italic) return 'Times-Italic'
    return 'Times-Roman'
  }
  const base = family === 'Courier' ? 'Courier' : 'Helvetica'
  if (bold && italic) return `${base}-BoldOblique`
  if (bold) return `${base}-Bold`
  if (italic) return `${base}-Oblique`
  return base
}

export function isStandardFamily(key: string): key is StandardFamily {
  return (STANDARD_FAMILIES as string[]).includes(key)
}

// ---- runs -------------------------------------------------------------------------------

export function sameStyle(a: RunStyle, b: RunStyle): boolean {
  return (
    a.font === b.font &&
    Math.abs(a.size - b.size) < 0.001 &&
    a.color.toLowerCase() === b.color.toLowerCase() &&
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline
  )
}

export function styleOf(r: RunStyle): RunStyle {
  return { font: r.font, size: r.size, color: r.color, bold: r.bold, italic: r.italic, underline: r.underline }
}

export function runsText(runs: Run[]): string {
  return runs.map((r) => r.text).join('')
}

export function runsLength(runs: Run[]): number {
  let n = 0
  for (const r of runs) n += r.text.length
  return n
}

/** Merges neighbours with the same style and drops empty runs (keeping one run for the style). */
export function normalizeRuns(runs: Run[]): Run[] {
  const out: Run[] = []
  for (const r of runs) {
    if (!r.text) continue
    const last = out[out.length - 1]
    if (last && sameStyle(last, r)) last.text += r.text
    else out.push({ ...r })
  }
  if (!out.length) {
    const first = runs[0] ?? { ...DEFAULT_STYLE, text: '' }
    return [{ ...styleOf(first), text: '' }]
  }
  return out
}

/** Splits runs so that a run boundary exists at each given offset. */
function splitAt(runs: Run[], offsets: number[]): Run[] {
  const cuts = [...new Set(offsets)].sort((a, b) => a - b)
  const out: Run[] = []
  let pos = 0
  for (const r of runs) {
    const end = pos + r.text.length
    let from = 0
    for (const c of cuts) {
      if (c > pos && c < end) {
        out.push({ ...r, text: r.text.slice(from, c - pos) })
        from = c - pos
      }
    }
    out.push({ ...r, text: r.text.slice(from) })
    pos = end
  }
  return out
}

/** Applies a style patch to [start, end). An empty range applies it to everything. */
export function applyStyle(runs: Run[], start: number, end: number, patch: Partial<RunStyle>): Run[] {
  const len = runsLength(runs)
  if (end <= start || len === 0) {
    return normalizeRuns(runs.map((r) => ({ ...r, ...patch })))
  }
  const parts = splitAt(runs, [start, end])
  let pos = 0
  const out = parts.map((r) => {
    const s = pos
    pos += r.text.length
    return s >= start && pos <= end && r.text.length ? { ...r, ...patch } : r
  })
  return normalizeRuns(out)
}

/** Runs covering [start, end) (whole content when the range is empty). */
export function runsInRange(runs: Run[], start: number, end: number): Run[] {
  if (end <= start) return runs
  const parts = splitAt(runs, [start, end])
  const out: Run[] = []
  let pos = 0
  for (const r of parts) {
    const s = pos
    pos += r.text.length
    if (s >= start && pos <= end && r.text.length) out.push(r)
  }
  return out.length ? out : runs
}

/** Style values shared by all runs in the range; `undefined` where they differ. */
export function commonStyle(runs: Run[], start: number, end: number): Partial<RunStyle> {
  const list = runsInRange(runs, start, end).filter((r, _i, all) => r.text.length || all.length === 1)
  const out: Partial<RunStyle> = {}
  if (!list.length) return out
  const keys: (keyof RunStyle)[] = ['font', 'size', 'color', 'bold', 'italic', 'underline']
  for (const k of keys) {
    const v = list[0][k]
    if (list.every((r) => (k === 'color' ? String(r[k]).toLowerCase() === String(v).toLowerCase() : r[k] === v)))
      (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** Style of the character before `offset` (or the first run), used for inserted text. */
export function styleAt(runs: Run[], offset: number): RunStyle {
  let pos = 0
  for (const r of runs) {
    const end = pos + r.text.length
    if (offset > pos && offset <= end) return styleOf(r)
    pos = end
  }
  return styleOf(runs[0] ?? { ...DEFAULT_STYLE, text: '' })
}

/** Replaces [start, end) with text (in the style at `start`, or the given style). */
export function replaceRange(runs: Run[], start: number, end: number, text: string, style?: RunStyle): Run[] {
  const st = style ?? styleAt(runs, start === end ? start : start + 1)
  const parts = splitAt(runs, [start, end])
  const out: Run[] = []
  let pos = 0
  let inserted = false
  for (const r of parts) {
    const s = pos
    pos += r.text.length
    if (s >= start && pos <= end && r.text.length) {
      if (!inserted) {
        out.push({ ...st, text })
        inserted = true
      }
      continue
    }
    if (!inserted && s >= end) {
      out.push({ ...st, text })
      inserted = true
    }
    out.push(r)
  }
  if (!inserted) out.push({ ...st, text })
  return normalizeRuns(out)
}

/** Canonical string of an edit's content, to detect whether anything changed. */
export function editKey(e: { runs: Run[]; frame: Frame; align: Align; lineSpacing: number; wrap: boolean }): string {
  const r = (v: number) => Math.round(v * 100) / 100
  return JSON.stringify({
    runs: normalizeRuns(e.runs).map((x) => [x.text, x.font, r(x.size), x.color.toLowerCase(), x.bold, x.italic, x.underline]),
    frame: [r(e.frame.origin[0]), r(e.frame.origin[1]), r(e.frame.dir[0]), r(e.frame.dir[1]), r(e.frame.width)],
    align: e.align,
    lineSpacing: r(e.lineSpacing),
    wrap: e.wrap
  })
}

// ---- colours ----------------------------------------------------------------------------

export function intToHex(c: number): string {
  return '#' + (c & 0xffffff).toString(16).padStart(6, '0')
}

export function normalizeHex(c: string): string {
  let h = c.trim().replace('#', '').toLowerCase()
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return /^[0-9a-f]{6}$/.test(h) ? '#' + h : '#000000'
}
