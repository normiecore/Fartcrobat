// Path decisions for the file tools (open, save, export, extract, combine). Pure, Node-testable.
import { normalizePath, pathKey } from '@shared/paths'
import { FORMAT_INFO, IMAGE_EXT, type ExportFormat, type ImageFormat } from '@features/export-create/shared'
import { InvalidArgs } from './act-common'

/** True for "/home/a.pdf", "C:\\a.pdf", "C:/a.pdf" and "\\\\server\\share\\a.pdf". */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/]/.test(path)
}

/** A path argument: a non-empty absolute path, normalized ("." and ".." removed). */
export function pathArg(value: unknown, name = 'path'): string {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidArgs(`${name} must be the absolute path of a file`)
  const path = value.trim()
  if (!isAbsolutePath(path)) throw new InvalidArgs(`${name} must be an absolute path (got "${path}")`)
  const normalized = normalizePath(path)
  if (normalized === '/' || /^[a-zA-Z]:\\?$/.test(normalized)) throw new InvalidArgs(`${name} must name a file, not a folder`)
  return normalized
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i > 0 ? path.slice(0, i) : path
}

/** The extension of a file name, lower case, without the dot ('' when there is none). */
export function extensionOf(path: string): string {
  return (/\.([^.\\/]+)$/.exec(baseName(path))?.[1] ?? '').toLowerCase()
}

function stem(path: string): string {
  return baseName(path).replace(/\.[^.\\/]+$/, '')
}

function sep(path: string): string {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/** Adds ".pdf" unless the name already ends with it (as the app's Save As does). */
export function pdfPath(path: string): string {
  return extensionOf(path) === 'pdf' ? path : `${path}.pdf`
}

/** Two spellings of one file compare equal (case-folded on Windows and macOS). */
export function samePath(a: string | null | undefined, b: string | null | undefined, platform: string): boolean {
  return !!a && !!b && pathKey(a, platform) === pathKey(b, platform)
}

/** Image format for export_document: the argument, else the path's extension, else PNG. */
export function imageFormatFor(path: string, requested?: unknown): ImageFormat {
  if (requested !== undefined && requested !== null) {
    if (requested !== 'png' && requested !== 'jpeg' && requested !== 'tiff') throw new InvalidArgs('image_format must be "png", "jpeg" or "tiff"')
    return requested
  }
  const ext = extensionOf(path)
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg'
  if (ext === 'tif' || ext === 'tiff') return 'tiff'
  return 'png'
}

const ACCEPTED_EXTENSIONS: Record<ExportFormat, string[]> = {
  word: ['docx'],
  excel: ['xlsx'],
  powerpoint: ['pptx'],
  html: ['html', 'htm'],
  text: ['txt', 'text'],
  image: []
}

const IMAGE_EXTENSIONS: Record<ImageFormat, string[]> = { png: ['png'], jpeg: ['jpg', 'jpeg'], tiff: ['tif', 'tiff'] }

/** The output file for a format: path, with the format's extension added when it has another one or none. */
export function exportPath(path: string, format: ExportFormat, imageFormat: ImageFormat = 'png'): string {
  const accepted = format === 'image' ? IMAGE_EXTENSIONS[imageFormat] : ACCEPTED_EXTENSIONS[format]
  if (accepted.includes(extensionOf(path))) return path
  const ext = format === 'image' ? IMAGE_EXT[imageFormat] : FORMAT_INFO[format].ext
  return `${path}.${ext}`
}

/**
 * Files written for an image export of `pages` (0-based) as single images: the first page goes to
 * `path`, the others are numbered next to it ("Report.png", "Report_2.png"... by page number).
 */
export function imageExportPaths(path: string, pages: number[], imageFormat: Exclude<ImageFormat, 'tiff'>): string[] {
  const first = exportPath(path, 'image', imageFormat)
  const dir = dirName(first)
  const ext = extensionOf(first)
  const name = stem(first)
  return pages.map((p, k) => (k === 0 ? first : `${dir}${sep(first)}${name}_${p + 1}.${ext}`))
}

/**
 * Why a file could not be opened, for the agent: "unsupported" for protection Fartcrobat cannot
 * open (certificate encryption, Microsoft Purview / RMS), else "file_error".
 */
export function openErrorCode(message: string): 'unsupported' | 'file_error' {
  return /unknown encryption handler|unsupported encryption|Adobe\.PubSec|MicrosoftIRMServices|certificate/i.test(message) ? 'unsupported' : 'file_error'
}

/** Message for a file whose protection Fartcrobat cannot open. */
export function unsupportedMessage(name: string, detail: string): string {
  const kind = /IRM|Purview/i.test(detail)
    ? 'Microsoft Purview (Rights Management) protection'
    : /PubSec|certificate/i.test(detail)
      ? 'certificate encryption'
      : 'a kind of encryption'
  return `${name} uses ${kind} that Fartcrobat cannot open. Ask the sender for a copy protected with a password, or open it in the app it was protected with.`
}
