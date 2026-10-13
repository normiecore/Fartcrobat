/**
 * Types and pure helpers shared by the page-marks engine (worker) and UI.
 * Nothing in here may touch the DOM or MuPDF.
 */

export type MarkType = 'HeaderFooter' | 'Watermark' | 'Background' | 'Bates'

export const MARK_TYPES: MarkType[] = ['HeaderFooter', 'Watermark', 'Background', 'Bates']

/** Plain-language names, as used in Acrobat's menus. */
export const MARK_NAMES: Record<MarkType, string> = {
  HeaderFooter: 'Header & Footer',
  Watermark: 'Watermark',
  Background: 'Background',
  Bates: 'Bates Numbering'
}

/** Names inside a sentence ("Added the watermark…"). */
export const MARK_NAMES_LOWER: Record<MarkType, string> = {
  HeaderFooter: 'header & footer',
  Watermark: 'watermark',
  Background: 'background',
  Bates: 'Bates numbering'
}

export type FontFamily = 'Helvetica' | 'Times' | 'Courier'

export interface FontSpec {
  family: FontFamily
  bold: boolean
  italic: boolean
  /** Points. */
  size: number
  /** #rrggbb */
  color: string
  underline: boolean
}

export interface PageRange {
  kind: 'all' | 'range'
  /** 1-based, inclusive (kind 'range'). */
  from?: number
  to?: number
  subset: 'all' | 'odd' | 'even'
}

export interface Margins {
  top: number
  bottom: number
  left: number
  right: number
}

export type Slot =
  'headerLeft' | 'headerCenter' | 'headerRight' | 'footerLeft' | 'footerCenter' | 'footerRight'

export const SLOTS: Slot[] = [
  'headerLeft',
  'headerCenter',
  'headerRight',
  'footerLeft',
  'footerCenter',
  'footerRight'
]

export const SLOT_LABELS: Record<Slot, string> = {
  headerLeft: 'Left header',
  headerCenter: 'Center header',
  headerRight: 'Right header',
  footerLeft: 'Left footer',
  footerCenter: 'Center footer',
  footerRight: 'Right footer'
}

export interface HeaderFooterSettings {
  type: 'HeaderFooter'
  font: FontSpec
  margins: Margins
  text: Record<Slot, string>
  /** Number shown on the first page of the range. */
  startNumber: number
  range: PageRange
  /** Scale the page content down so the header and footer never overlap it. */
  shrink: boolean
  /** When the marks were made (ISO); date tokens use it. */
  date: string
}

export interface Position {
  vAlign: 'top' | 'center' | 'bottom'
  /** Distance from the chosen edge, points (for 'center': positive moves down). */
  vOffset: number
  hAlign: 'left' | 'center' | 'right'
  /** Distance from the chosen edge, points (for 'center': positive moves right). */
  hOffset: number
}

export type TextSource = { kind: 'text'; text: string; font: FontSpec; align: 'left' | 'center' | 'right' }
export type FileSource = {
  kind: 'file'
  fileName: string
  /** 1-based page of a PDF source. */
  page: number
  /** Absolute scale in percent of the file's natural size. */
  scale: number
  /** Id of a file loaded with page-marks.loadSource; absent = reuse the file already in the document. */
  sourceId?: string
  /** Where the file was chosen from (kept in saved presets only, never written into the PDF). */
  filePath?: string
}
export type ColorSource = { kind: 'color'; color: string }

export interface AppearanceOptions {
  /** Degrees, counter-clockwise. */
  rotation: number
  /** 0..1 */
  opacity: number
  /** Percent of the page the mark fills, or null to use the font size / absolute scale. */
  relativeScale: number | null
  position: Position
  showOnPrint: boolean
  showOnScreen: boolean
  range: PageRange
}

export interface WatermarkSettings extends AppearanceOptions {
  type: 'Watermark'
  source: TextSource | FileSource
  /** Behind the page content (true) or on top of it. */
  behind: boolean
}

export interface BackgroundSettings extends AppearanceOptions {
  type: 'Background'
  source: ColorSource | FileSource
}

export interface BatesSettings {
  type: 'Bates'
  prefix: string
  suffix: string
  digits: number
  start: number
  slot: Slot
  font: FontSpec
  margins: Margins
  range: PageRange
}

export type MarkSettings = HeaderFooterSettings | WatermarkSettings | BackgroundSettings | BatesSettings

export interface MarkGroup {
  type: MarkType
  /** 0-based page indices carrying marks made with these settings. */
  pages: number[]
  settings: MarkSettings
}

export interface MarksListing {
  groups: MarkGroup[]
  /** Pages whose CropBox differs from the MediaBox. */
  croppedPages: number[]
}

export type PageBox = 'CropBox' | 'TrimBox' | 'BleedBox' | 'ArtBox'

export interface SetBoxesRequest {
  pages: number[]
  box: PageBox
  /** Margins from the MediaBox in points (displayed orientation); null removes the box. */
  margins: Margins | null
  /** Crop each page to its own content instead of using the margins. */
  removeWhiteMargins?: boolean
}

// ---- defaults -------------------------------------------------------------------------------

export const DEFAULT_FONT: FontSpec = {
  family: 'Helvetica',
  bold: false,
  italic: false,
  size: 10,
  color: '#000000',
  underline: false
}

export const ALL_PAGES: PageRange = { kind: 'all', subset: 'all' }

export function defaultHeaderFooter(): HeaderFooterSettings {
  return {
    type: 'HeaderFooter',
    font: { ...DEFAULT_FONT },
    margins: { top: 36, bottom: 36, left: 72, right: 72 },
    text: {
      headerLeft: '',
      headerCenter: '',
      headerRight: '',
      footerLeft: '',
      footerCenter: '',
      footerRight: ''
    },
    startNumber: 1,
    range: { ...ALL_PAGES },
    shrink: false,
    date: new Date().toISOString()
  }
}

export function defaultWatermark(): WatermarkSettings {
  return {
    type: 'Watermark',
    source: {
      kind: 'text',
      text: '',
      font: { ...DEFAULT_FONT, size: 72, color: '#FF0000' },
      align: 'center'
    },
    rotation: 45,
    opacity: 0.5,
    relativeScale: null,
    behind: false,
    showOnPrint: true,
    showOnScreen: true,
    position: { vAlign: 'center', vOffset: 0, hAlign: 'center', hOffset: 0 },
    range: { ...ALL_PAGES }
  }
}

export function defaultBackground(): BackgroundSettings {
  return {
    type: 'Background',
    source: { kind: 'color', color: '#FFFDE7' },
    rotation: 0,
    opacity: 1,
    relativeScale: 100,
    showOnPrint: true,
    showOnScreen: true,
    position: { vAlign: 'center', vOffset: 0, hAlign: 'center', hOffset: 0 },
    range: { ...ALL_PAGES }
  }
}

export function defaultBates(): BatesSettings {
  return {
    type: 'Bates',
    prefix: '',
    suffix: '',
    digits: 6,
    start: 1,
    slot: 'footerRight',
    font: { ...DEFAULT_FONT },
    margins: { top: 36, bottom: 36, left: 72, right: 72 },
    range: { ...ALL_PAGES }
  }
}

// ---- page ranges ----------------------------------------------------------------------------

/** Page indices (0-based, ascending) selected by a range, for a document of `count` pages. */
export function resolvePageRange(range: PageRange, count: number): number[] {
  let from = 1
  let to = count
  if (range.kind === 'range') {
    from = Math.max(1, Math.floor(range.from ?? 1))
    to = Math.min(count, Math.floor(range.to ?? count))
  }
  const out: number[] = []
  for (let n = from; n <= to; n++) {
    if (range.subset === 'odd' && n % 2 === 0) continue
    if (range.subset === 'even' && n % 2 === 1) continue
    out.push(n - 1)
  }
  return out
}

/** Short human description, e.g. "All pages" or "Pages 2–5 (odd)". */
export function describePageRange(range: PageRange, count: number): string {
  const sub = range.subset === 'odd' ? ' (odd pages)' : range.subset === 'even' ? ' (even pages)' : ''
  if (range.kind === 'all') return (range.subset === 'all' ? 'All pages' : 'All') + sub
  const from = Math.max(1, range.from ?? 1)
  const to = Math.min(count, range.to ?? count)
  return (from === to ? `Page ${from}` : `Pages ${from}–${to}`) + sub
}

/** Summarises a list of 0-based page indices: "1–3, 5". */
export function describePages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts: string[] = []
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++
    parts.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}–${sorted[j] + 1}`)
    i = j + 1
  }
  return parts.join(', ')
}

// ---- tokens ---------------------------------------------------------------------------------

export const PAGE_NUMBER_FORMATS: { id: string; label: string; insert: string }[] = [
  { id: '1', label: '1', insert: '<<1>>' },
  { id: '1 of n', label: '1 of n', insert: '<<1>> of <<n>>' },
  { id: '1/n', label: '1/n', insert: '<<1>>/<<n>>' },
  { id: 'Page 1', label: 'Page 1', insert: 'Page <<1>>' },
  { id: 'Page 1 of n', label: 'Page 1 of n', insert: 'Page <<1>> of <<n>>' }
]

export const DATE_FORMATS = [
  'm/d/yyyy',
  'mm/dd/yyyy',
  'm/d/yy',
  'mm/dd/yy',
  'd/m/yyyy',
  'dd/mm/yyyy',
  'dd/mm/yy',
  'dd.mm.yyyy',
  'yyyy-mm-dd',
  'mmmm d, yyyy',
  'd mmmm yyyy'
]

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
]

/** Formats a date with an Acrobat-style pattern (m, mm, mmmm, d, dd, yy, yyyy). */
export function formatDate(pattern: string, date: Date): string {
  return pattern.replace(/mmmm|yyyy|mm|dd|yy|m|d/g, (tok) => {
    const m = date.getMonth() + 1
    const d = date.getDate()
    const y = date.getFullYear()
    switch (tok) {
      case 'mmmm':
        return MONTHS[m - 1]
      case 'yyyy':
        return String(y)
      case 'yy':
        return String(y % 100).padStart(2, '0')
      case 'mm':
        return String(m).padStart(2, '0')
      case 'm':
        return String(m)
      case 'dd':
        return String(d).padStart(2, '0')
      case 'd':
        return String(d)
      default:
        return tok
    }
  })
}

function isDatePattern(s: string): boolean {
  return /^(?=.*[ymd])[ymd\s/.,-]+$/.test(s) || DATE_FORMATS.includes(s)
}

export interface TokenContext {
  /** Number to print for this page. */
  page: number
  /** Number to print for "n" (the last number of the range). */
  total: number
  date: Date
}

/**
 * Replaces Acrobat-style tokens: <<1>> page number, <<n>> total, <<1 of n>>, <<1/n>>, <<Page 1>>,
 * <<Page 1 of n>> and dates such as <<m/d/yyyy>>. Unknown tokens are left as typed.
 */
export function expandTokens(text: string, ctx: TokenContext): string {
  return text.replace(/<<([^<>]{1,40})>>/g, (whole, inner: string) => {
    const t = inner.trim()
    switch (t) {
      case '1':
        return String(ctx.page)
      case 'n':
        return String(ctx.total)
      case '1 of n':
        return `${ctx.page} of ${ctx.total}`
      case '1/n':
        return `${ctx.page}/${ctx.total}`
      case 'Page 1':
        return `Page ${ctx.page}`
      case 'Page 1 of n':
        return `Page ${ctx.page} of ${ctx.total}`
    }
    if (isDatePattern(t)) return formatDate(t, ctx.date)
    return whole
  })
}

export function formatBates(s: Pick<BatesSettings, 'prefix' | 'suffix' | 'digits'>, n: number): string {
  return `${s.prefix}${String(n).padStart(Math.max(1, Math.min(15, Math.round(s.digits))), '0')}${s.suffix}`
}

// ---- text encoding for base-14 fonts (WinAnsiEncoding) ----------------------------------------

const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80,
  0x201a: 0x82,
  0x0192: 0x83,
  0x201e: 0x84,
  0x2026: 0x85,
  0x2020: 0x86,
  0x2021: 0x87,
  0x02c6: 0x88,
  0x2030: 0x89,
  0x0160: 0x8a,
  0x2039: 0x8b,
  0x0152: 0x8c,
  0x017d: 0x8e,
  0x2018: 0x91,
  0x2019: 0x92,
  0x201c: 0x93,
  0x201d: 0x94,
  0x2022: 0x95,
  0x2013: 0x96,
  0x2014: 0x97,
  0x02dc: 0x98,
  0x2122: 0x99,
  0x0161: 0x9a,
  0x203a: 0x9b,
  0x0153: 0x9c,
  0x017e: 0x9e,
  0x0178: 0x9f
}

/** WinAnsiEncoding byte for a Unicode code point, or -1 when the standard fonts cannot show it. */
export function winAnsiCode(cp: number): number {
  if (cp === 0x09) return 0x20
  if (cp >= 0x20 && cp <= 0x7e) return cp
  if (cp >= 0xa0 && cp <= 0xff) return cp
  return WIN_ANSI_EXTRA[cp] ?? -1
}

/** Characters in `text` the standard PDF fonts cannot display (deduplicated). */
export function unsupportedChars(text: string): string[] {
  const out = new Set<string>()
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') continue
    if (winAnsiCode(ch.codePointAt(0)!) < 0) out.add(ch)
  }
  return [...out]
}

// ---- units ----------------------------------------------------------------------------------

export type Unit = 'pt' | 'in' | 'mm' | 'cm'

export const POINTS_PER_UNIT: Record<Unit, number> = { pt: 1, in: 72, mm: 72 / 25.4, cm: 72 / 2.54 }

export const UNIT_LABELS: Record<Unit, string> = { pt: 'pt', in: 'in', mm: 'mm', cm: 'cm' }

export function toUnit(points: number, unit: Unit): number {
  const v = points / POINTS_PER_UNIT[unit]
  const digits = unit === 'pt' ? 1 : unit === 'mm' ? 1 : 2
  const f = 10 ** digits
  return Math.round(v * f) / f
}

export function fromUnit(value: number, unit: Unit): number {
  return value * POINTS_PER_UNIT[unit]
}

// ---- settings (de)serialisation -------------------------------------------------------------

/** Validates and fills in settings read from a document (they may come from an older version). */
export function normalizeSettings(raw: unknown): MarkSettings | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<MarkSettings>
  switch (r.type) {
    case 'HeaderFooter': {
      const d = defaultHeaderFooter()
      const s = r as Partial<HeaderFooterSettings>
      return {
        ...d,
        ...s,
        font: { ...d.font, ...s.font },
        margins: { ...d.margins, ...s.margins },
        text: { ...d.text, ...s.text },
        range: { ...d.range, ...s.range }
      }
    }
    case 'Watermark': {
      const d = defaultWatermark()
      const s = r as Partial<WatermarkSettings>
      const source =
        s.source?.kind === 'text'
          ? { ...(d.source as TextSource), ...s.source, font: { ...DEFAULT_FONT, ...s.source.font } }
          : (s.source ?? d.source)
      return {
        ...d,
        ...s,
        source,
        position: { ...d.position, ...s.position },
        range: { ...d.range, ...s.range }
      }
    }
    case 'Background': {
      const d = defaultBackground()
      const s = r as Partial<BackgroundSettings>
      return {
        ...d,
        ...s,
        source: s.source ?? d.source,
        position: { ...d.position, ...s.position },
        range: { ...d.range, ...s.range }
      }
    }
    case 'Bates': {
      const d = defaultBates()
      const s = r as Partial<BatesSettings>
      return {
        ...d,
        ...s,
        font: { ...d.font, ...s.font },
        margins: { ...d.margins, ...s.margins },
        range: { ...d.range, ...s.range }
      }
    }
    default:
      return null
  }
}

/** Settings as stored in the document: file sources lose their transient source id. */
export function storableSettings(s: MarkSettings): MarkSettings {
  if ((s.type === 'Watermark' || s.type === 'Background') && s.source.kind === 'file') {
    const { sourceId: _id, filePath: _path, ...rest } = s.source
    return { ...s, source: rest } as MarkSettings
  }
  return s
}
