/**
 * Print settings: defaults, validation of stored values and what is remembered between jobs.
 * Pure (no DOM) so it can be unit tested.
 */
import {
  defaultPaperForLocale,
  PAPERS,
  type BookletBinding,
  type BookletSubset,
  type ImpositionOptions,
  type LayoutMode,
  type Orientation,
  type PageOrder,
  type PaperName,
  type SizingMode
} from './imposition'
import type { PageSubset } from './pageRanges'

/** What "Comments & Forms" prints. */
export type PrintContent = 'markups' | 'document' | 'stamps' | 'forms'

export const CONTENT_OPTIONS: { value: PrintContent; label: string }[] = [
  { value: 'markups', label: 'Document and Markups' },
  { value: 'document', label: 'Document' },
  { value: 'stamps', label: 'Document and Stamps' },
  { value: 'forms', label: 'Form fields only' }
]

export const PER_SHEET_OPTIONS = [2, 4, 6, 9, 16] as const

export interface PrintSettings {
  /** Printer name ('' when no printer is available: the system dialog is used). */
  printer: string
  copies: number
  grayscale: boolean
  saveInk: boolean
  /** Print as image draft: 150 dpi instead of 300 dpi. */
  draft: boolean
  pages: 'all' | 'current' | 'range'
  range: string
  subset: PageSubset
  reverse: boolean
  layout: LayoutMode
  sizing: SizingMode
  customScale: number
  /** Pages per sheet, or 0 for a custom columns × rows grid. */
  perSheet: number
  gridCols: number
  gridRows: number
  pageOrder: PageOrder
  pageBorder: boolean
  autoRotate: boolean
  binding: BookletBinding
  bookletSubset: BookletSubset
  sheetFrom: number
  /** 0 = last sheet. */
  sheetTo: number
  tileScale: number
  /** Poster tile overlap, in points. */
  overlap: number
  cutMarks: boolean
  labels: boolean
  tileLargeOnly: boolean
  orientation: Orientation
  content: PrintContent
  paper: PaperName
  duplex: boolean
  flip: 'long' | 'short'
}

export function defaultSettings(locale?: string | null): PrintSettings {
  return {
    printer: '',
    copies: 1,
    grayscale: false,
    saveInk: false,
    draft: false,
    pages: 'all',
    range: '',
    subset: 'all',
    reverse: false,
    layout: 'size',
    sizing: 'fit',
    customScale: 100,
    perSheet: 2,
    gridCols: 2,
    gridRows: 2,
    pageOrder: 'horizontal',
    pageBorder: false,
    autoRotate: true,
    binding: 'left',
    bookletSubset: 'both',
    sheetFrom: 1,
    sheetTo: 0,
    tileScale: 100,
    overlap: 18,
    cutMarks: true,
    labels: true,
    tileLargeOnly: false,
    orientation: 'auto',
    content: 'markups',
    paper: defaultPaperForLocale(locale),
    duplex: false,
    flip: 'long'
  }
}

/** Settings that describe one particular job and are not carried over to the next one. */
const PER_JOB: (keyof PrintSettings)[] = ['copies', 'pages', 'range', 'subset', 'reverse', 'sheetFrom', 'sheetTo']

/** The part of the settings remembered for next time (store key 'print:settings'). */
export function persistable(s: PrintSettings): Partial<PrintSettings> {
  const out: Partial<PrintSettings> = { ...s }
  for (const k of PER_JOB) delete out[k]
  return out
}

const ENUMS: Partial<Record<keyof PrintSettings, readonly string[]>> = {
  pages: ['all', 'current', 'range'],
  subset: ['all', 'odd', 'even'],
  layout: ['size', 'poster', 'multiple', 'booklet'],
  sizing: ['fit', 'actual', 'shrink', 'custom'],
  pageOrder: ['horizontal', 'horizontal-reversed', 'vertical', 'vertical-reversed'],
  binding: ['left', 'right'],
  bookletSubset: ['both', 'front', 'back'],
  orientation: ['auto', 'portrait', 'landscape'],
  content: ['markups', 'document', 'stamps', 'forms'],
  paper: Object.keys(PAPERS),
  flip: ['long', 'short']
}

const RANGES: Partial<Record<keyof PrintSettings, [number, number]>> = {
  copies: [1, 999],
  customScale: [1, 1000],
  perSheet: [0, 16],
  gridCols: [1, 8],
  gridRows: [1, 8],
  sheetFrom: [1, 100000],
  sheetTo: [0, 100000],
  tileScale: [1, 1000],
  overlap: [0, 144]
}

/** Merges stored (untrusted) values over the defaults, dropping anything malformed. */
export function sanitizeSettings(raw: unknown, defaults: PrintSettings): PrintSettings {
  const out: PrintSettings = { ...defaults }
  if (!raw || typeof raw !== 'object') return out
  const src = raw as Record<string, unknown>
  for (const key of Object.keys(defaults) as (keyof PrintSettings)[]) {
    const v = src[key]
    if (v === undefined) continue
    const def = defaults[key]
    if (typeof def === 'boolean') {
      if (typeof v === 'boolean') (out as any)[key] = v
    } else if (typeof def === 'number') {
      const range = RANGES[key]
      if (typeof v === 'number' && Number.isFinite(v) && (!range || (v >= range[0] && v <= range[1]))) (out as any)[key] = v
    } else if (typeof def === 'string') {
      const allowed = ENUMS[key]
      if (typeof v === 'string' && (!allowed || allowed.includes(v))) (out as any)[key] = v
    }
  }
  if (out.perSheet !== 0 && !(PER_SHEET_OPTIONS as readonly number[]).includes(out.perSheet)) out.perSheet = defaults.perSheet
  return out
}

/** Imposition options for the current settings. */
export function impositionOptions(s: PrintSettings): ImpositionOptions {
  return {
    mode: s.layout,
    paper: PAPERS[s.paper],
    orientation: s.orientation,
    sizing: s.sizing,
    customScale: s.customScale,
    perSheet: s.perSheet || s.gridCols * s.gridRows,
    grid: s.perSheet === 0 ? { cols: s.gridCols, rows: s.gridRows } : null,
    pageOrder: s.pageOrder,
    pageBorder: s.pageBorder,
    autoRotate: s.autoRotate,
    binding: s.binding,
    bookletSubset: s.bookletSubset,
    sheetFrom: s.sheetFrom,
    sheetTo: s.sheetTo,
    tileScale: s.tileScale,
    overlap: s.overlap,
    cutMarks: s.cutMarks,
    labels: s.labels,
    tileLargeOnly: s.tileLargeOnly,
    reverse: s.reverse
  }
}

/** Rendering resolution for a job. Documents that only allow low-quality printing get 150 dpi. */
export function printDpi(s: Pick<PrintSettings, 'draft'>, allowHighQuality: boolean): number {
  return s.draft || !allowHighQuality ? 150 : 300
}

export type Units = 'pt' | 'in' | 'mm' | 'cm'

const PER_POINT: Record<Units, number> = { pt: 1, in: 1 / 72, mm: 25.4 / 72, cm: 2.54 / 72 }

export function fromPoints(pt: number, units: Units): number {
  return pt * PER_POINT[units]
}

export function toPoints(v: number, units: Units): number {
  return v / PER_POINT[units]
}

function trimNumber(v: number, digits: number): string {
  return String(Number(v.toFixed(digits)))
}

/** "8.5 × 11 in", "210 × 297 mm". */
export function formatSize(width: number, height: number, units: Units): string {
  const u = units === 'cm' ? 'mm' : units
  const digits = u === 'in' ? 2 : 0
  return `${trimNumber(fromPoints(width, u), digits)} × ${trimNumber(fromPoints(height, u), digits)} ${u}`
}
