/**
 * Types, defaults and small helpers shared by the export-create UI, engine ops and main process.
 * Keep this file free of DOM, Electron and MuPDF imports.
 */

export const FEATURE_ID = 'export-create'

export type ExportFormat = 'word' | 'excel' | 'powerpoint' | 'image' | 'html' | 'text'
export type ImageFormat = 'png' | 'jpeg' | 'tiff'

export interface WordOptions {
  /** 'flowing': editable paragraphs that reflow (Acrobat "Retain Flowing Text"); 'page': text boxes at their exact position. */
  layout: 'flowing' | 'page'
  images: boolean
  /** Turn larger text into Heading styles and bullets/numbers into Word lists. */
  structure: boolean
  tables: boolean
  /** Comments (notes, highlights with notes, replies) become Word comments. */
  comments: boolean
}

export interface ExcelOptions {
  /** One worksheet for all pages instead of one per page. */
  combine: boolean
  /** Convert "1,234.50", "$9.99", "12%" into real numbers. */
  numbers: boolean
}

export interface PowerPointOptions {
  /** 'editable': page image without text plus editable text boxes; 'image': the page as a picture only. */
  mode: 'editable' | 'image'
}

export interface ImageExportOptions {
  format: ImageFormat
  dpi: number
  /** JPEG quality, 1-100. */
  quality: number
  grayscale: boolean
  /** TIFF compression. */
  compression: 'deflate' | 'none'
}

export interface HtmlExportOptions {
  /** 'page': every page laid out exactly like the PDF; 'flowing': a reflowable web page (headings, paragraphs, lists, tables). */
  layout: 'page' | 'flowing'
  images: boolean
}

export interface TextExportOptions {
  /** Separate pages with a form feed character (\f) instead of a blank line. */
  pageBreaks: boolean
  /** 'lines': keep every line as in the PDF; 'paragraphs': join the lines of a paragraph. */
  layout: 'lines' | 'paragraphs'
}

export interface ExportOptions {
  format: ExportFormat
  /** Open the exported file in its app when done. */
  openAfter: boolean
  word: WordOptions
  excel: ExcelOptions
  powerpoint: PowerPointOptions
  image: ImageExportOptions
  html: HtmlExportOptions
  text: TextExportOptions
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'word',
  openAfter: false,
  word: { layout: 'flowing', images: true, structure: true, tables: true, comments: true },
  excel: { combine: false, numbers: true },
  powerpoint: { mode: 'editable' },
  image: { format: 'png', dpi: 150, quality: 85, grayscale: false, compression: 'deflate' },
  html: { layout: 'page', images: true },
  text: { pageBreaks: false, layout: 'lines' }
}

/** Merges stored (possibly partial or outdated) options over the defaults. */
export function normalizeExportOptions(v: unknown): ExportOptions {
  const d = DEFAULT_EXPORT_OPTIONS
  const o = (v && typeof v === 'object' ? v : {}) as Partial<ExportOptions>
  const pick = <T extends object>(def: T, val: unknown): T => {
    const out = { ...def }
    if (val && typeof val === 'object') {
      for (const k of Object.keys(def) as (keyof T)[]) {
        const x = (val as T)[k]
        if (x !== undefined && typeof x === typeof def[k]) out[k] = x
      }
    }
    return out
  }
  const formats: ExportFormat[] = ['word', 'excel', 'powerpoint', 'image', 'html', 'text']
  const image = pick(d.image, o.image)
  if (!['png', 'jpeg', 'tiff'].includes(image.format)) image.format = 'png'
  if (!DPI_CHOICES.includes(image.dpi)) image.dpi = 150
  image.quality = Math.max(1, Math.min(100, Math.round(image.quality)))
  const word = pick(d.word, o.word)
  if (word.layout !== 'flowing' && word.layout !== 'page') word.layout = 'flowing'
  const powerpoint = pick(d.powerpoint, o.powerpoint)
  if (powerpoint.mode !== 'editable' && powerpoint.mode !== 'image') powerpoint.mode = 'editable'
  const html = pick(d.html, o.html)
  if (html.layout !== 'page' && html.layout !== 'flowing') html.layout = 'page'
  const text = pick(d.text, o.text)
  if (text.layout !== 'lines' && text.layout !== 'paragraphs') text.layout = 'lines'
  if (image.compression !== 'deflate' && image.compression !== 'none') image.compression = 'deflate'
  return {
    format: formats.includes(o.format as ExportFormat) ? (o.format as ExportFormat) : d.format,
    openAfter: typeof o.openAfter === 'boolean' ? o.openAfter : d.openAfter,
    word,
    excel: pick(d.excel, o.excel),
    powerpoint,
    image,
    html,
    text
  }
}

export const DPI_CHOICES = [72, 150, 300, 600]

export interface FormatInfo {
  label: string
  short: string
  description: string
  ext: string
  filterName: string
}

export const FORMAT_INFO: Record<ExportFormat, FormatInfo> = {
  word: {
    label: 'Microsoft Word',
    short: 'Word',
    description: 'Word document (.docx)',
    ext: 'docx',
    filterName: 'Word Document'
  },
  excel: {
    label: 'Spreadsheet',
    short: 'Excel',
    description: 'Microsoft Excel Workbook (.xlsx)',
    ext: 'xlsx',
    filterName: 'Excel Workbook'
  },
  powerpoint: {
    label: 'Microsoft PowerPoint',
    short: 'PowerPoint',
    description: 'PowerPoint Presentation (.pptx)',
    ext: 'pptx',
    filterName: 'PowerPoint Presentation'
  },
  image: {
    label: 'Image',
    short: 'Image',
    description: 'PNG, JPEG or TIFF, one image per page',
    ext: 'png',
    filterName: 'Image'
  },
  html: {
    label: 'HTML Web Page',
    short: 'HTML',
    description: 'One web page (.html) with images built in',
    ext: 'html',
    filterName: 'HTML Web Page'
  },
  text: {
    label: 'Text (Plain)',
    short: 'Text',
    description: 'Plain text (.txt)',
    ext: 'txt',
    filterName: 'Text'
  }
}

export const IMAGE_EXT: Record<ImageFormat, string> = { png: 'png', jpeg: 'jpg', tiff: 'tif' }

/** Name of the file for one exported page image: "<name>_Page_<n>.<ext>" (Acrobat's naming). */
export function pageImageName(baseName: string, pageNumber: number, format: ImageFormat): string {
  return `${baseName}_Page_${pageNumber}.${IMAGE_EXT[format]}`
}

/**
 * Parses a page range like "1-3, 5, 8-" into zero-based page indices (sorted, unique).
 * Returns an error message string when the text is invalid.
 */
export function parsePageRange(text: string, pageCount: number): number[] | string {
  const t = text.trim()
  if (!t) return 'Enter the pages to export, for example 1-3, 5'
  const out = new Set<number>()
  for (const raw of t.split(/[,;]+/)) {
    const part = raw.trim()
    if (!part) continue
    const m = /^(\d*)\s*(?:[-–]\s*(\d*))?$/.exec(part)
    if (!m || (!m[1] && m[2] === undefined)) return `“${part}” is not a page number or range`
    const isRange = part.includes('-') || part.includes('–')
    const a = m[1] ? parseInt(m[1], 10) : 1
    const b = isRange ? (m[2] ? parseInt(m[2], 10) : pageCount) : a
    if (a < 1 || b < 1) return 'Page numbers start at 1'
    if (a > pageCount || b > pageCount) return `This document has ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}`
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    for (let p = lo; p <= hi; p++) out.add(p - 1)
  }
  if (!out.size) return 'Enter the pages to export, for example 1-3, 5'
  return [...out].sort((x, y) => x - y)
}

// ---- create ---------------------------------------------------------------------------------

export interface PageSizePreset {
  id: string
  label: string
  /** Points, portrait. */
  width: number
  height: number
}

export const PAGE_SIZES: PageSizePreset[] = [
  { id: 'letter', label: 'Letter (8.5 × 11 in)', width: 612, height: 792 },
  { id: 'legal', label: 'Legal (8.5 × 14 in)', width: 612, height: 1008 },
  { id: 'tabloid', label: 'Tabloid (11 × 17 in)', width: 792, height: 1224 },
  { id: 'a3', label: 'A3 (297 × 420 mm)', width: 841.89, height: 1190.55 },
  { id: 'a4', label: 'A4 (210 × 297 mm)', width: 595.28, height: 841.89 },
  { id: 'a5', label: 'A5 (148 × 210 mm)', width: 419.53, height: 595.28 }
]

export interface ImagePageOptions {
  /** 'image': page is the size of the image at its resolution; otherwise the image is fitted on a page of that size. */
  pageSize: 'image' | 'letter' | 'a4'
  /** Margin around the image in points (fitted page sizes only). */
  margin: number
  /** Turn the page to landscape for images that are wider than they are tall. */
  autoRotate: boolean
}

export const DEFAULT_IMAGE_PAGE_OPTIONS: ImagePageOptions = { pageSize: 'image', margin: 36, autoRotate: true }

export function normalizeImagePageOptions(v: unknown): ImagePageOptions {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<ImagePageOptions>
  const d = DEFAULT_IMAGE_PAGE_OPTIONS
  return {
    pageSize: o.pageSize === 'letter' || o.pageSize === 'a4' || o.pageSize === 'image' ? o.pageSize : d.pageSize,
    margin: typeof o.margin === 'number' && o.margin >= 0 && o.margin <= 144 ? o.margin : d.margin,
    autoRotate: typeof o.autoRotate === 'boolean' ? o.autoRotate : d.autoRotate
  }
}

export interface ImagePlacement {
  pageWidth: number
  pageHeight: number
  /** Scale applied to the image's natural size (points at its resolution). */
  scale: number
  /** Top-left corner of the image on the page. */
  x: number
  y: number
}

/**
 * Where an image of natural size w × h points goes: on a page of its own size, or fitted (never
 * enlarged) and centred inside the margins of a Letter or A4 page, turned to landscape for wide
 * images when autoRotate is on.
 */
export function fitImagePage(w: number, h: number, opts: ImagePageOptions): ImagePlacement {
  if (opts.pageSize === 'image') return { pageWidth: w, pageHeight: h, scale: 1, x: 0, y: 0 }
  const preset = PAGE_SIZES.find((p) => p.id === opts.pageSize) ?? PAGE_SIZES[0]
  let pw = preset.width
  let ph = preset.height
  if (opts.autoRotate && w > h) [pw, ph] = [ph, pw]
  const margin = Math.max(0, Math.min(opts.margin, Math.min(pw, ph) / 2 - 36))
  const scale = Math.min(1, (pw - 2 * margin) / w, (ph - 2 * margin) / h)
  return { pageWidth: pw, pageHeight: ph, scale, x: (pw - w * scale) / 2, y: (ph - h * scale) / 2 }
}

export interface BlankOptions {
  /** A PAGE_SIZES id, or 'custom'. */
  preset: string
  /** Custom size in the chosen unit. */
  width: number
  height: number
  unit: 'in' | 'mm' | 'pt'
  landscape: boolean
  pages: number
}

export const DEFAULT_BLANK: BlankOptions = { preset: 'letter', width: 8.5, height: 11, unit: 'in', landscape: false, pages: 1 }

/** Page size in points for the blank page options. */
export function blankSize(b: BlankOptions): { width: number; height: number } | string {
  let w: number
  let h: number
  const preset = PAGE_SIZES.find((p) => p.id === b.preset)
  if (preset) {
    w = preset.width
    h = preset.height
  } else {
    const f = b.unit === 'in' ? 72 : b.unit === 'mm' ? 72 / 25.4 : 1
    w = b.width * f
    h = b.height * f
  }
  if (!(w >= 72 && h >= 72)) return 'Pages must be at least 1 inch (25.4 mm) wide and tall'
  if (w > 14400 || h > 14400) return 'Pages can be at most 200 inches (5080 mm) wide and tall'
  if (b.landscape !== w > h) [w, h] = [h, w]
  return { width: w, height: h }
}

/** A piece of a new PDF (Create a PDF). */
export type CreatePart =
  /** `path`: where the file was read from (to find a password saved for it). */
  | { kind: 'file'; name: string; data: Uint8Array; password?: string; path?: string }
  | { kind: 'blank'; width: number; height: number; count: number }

export interface HtmlConvertOptions {
  pageSize: 'Letter' | 'A4' | 'Legal'
  landscape: boolean
  /** Margins in inches. */
  margin: number
  printBackground: boolean
}

export const DEFAULT_HTML_CONVERT_OPTIONS: HtmlConvertOptions = {
  pageSize: 'Letter',
  landscape: false,
  margin: 0.5,
  printBackground: true
}

export function normalizeHtmlConvertOptions(v: unknown): HtmlConvertOptions {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<HtmlConvertOptions>
  const d = DEFAULT_HTML_CONVERT_OPTIONS
  return {
    pageSize: o.pageSize === 'A4' || o.pageSize === 'Legal' || o.pageSize === 'Letter' ? o.pageSize : d.pageSize,
    landscape: typeof o.landscape === 'boolean' ? o.landscape : d.landscape,
    margin: typeof o.margin === 'number' && o.margin >= 0 && o.margin <= 2 ? o.margin : d.margin,
    printBackground: typeof o.printBackground === 'boolean' ? o.printBackground : d.printBackground
  }
}

/** Office formats converted through LibreOffice when it is installed. */
export const OFFICE_EXTENSIONS = ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp']
/** Office formats MuPDF can import by itself when LibreOffice is missing. */
export const BUILTIN_OFFICE_EXTENSIONS = ['docx', 'xlsx', 'pptx']
export const HTML_EXTENSIONS = ['html', 'htm', 'xhtml']
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'jxr', 'pnm', 'pbm', 'pgm', 'ppm', 'psd']
/** Everything "Create PDF from File" accepts. */
export const CREATE_EXTENSIONS = [
  'pdf',
  ...IMAGE_EXTENSIONS,
  ...OFFICE_EXTENSIONS,
  ...HTML_EXTENSIONS,
  'txt',
  'xps',
  'oxps',
  'epub',
  'mobi',
  'fb2',
  'cbz',
  'svg'
]

export const LIBREOFFICE_DOWNLOAD_URL = 'https://www.libreoffice.org/download/'

export function extensionOf(name: string): string {
  return (/\.([^./\\]+)$/.exec(name)?.[1] ?? '').toLowerCase()
}

export interface LibreOfficeInfo {
  path: string
  version: string | null
}

// ---- IPC ------------------------------------------------------------------------------------

declare module '@shared/ipc' {
  interface IpcApi {
    /** Finds LibreOffice (preferences path, PATH, standard install folders). */
    'feature:export-create:findLibreOffice': (path?: string) => LibreOfficeInfo | null
    /** Converts an Office file to PDF with LibreOffice. Null when LibreOffice is not installed. */
    'feature:export-create:convertOffice': (path: string) => Uint8Array | null
    /** Converts a local HTML file to PDF with Chromium (no network access). */
    'feature:export-create:convertHtml': (path: string, opts: HtmlConvertOptions) => Uint8Array
    /** Plain text on the clipboard (for Create PDF from Clipboard). */
    'feature:export-create:clipboardText': () => string
  }
}
