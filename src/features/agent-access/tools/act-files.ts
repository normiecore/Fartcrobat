// Path decisions for the file tools (open, save, export, extract, combine). Pure, Node-testable.
import { normalizePath, pathKey } from '@shared/paths'
import { FORMAT_INFO, IMAGE_EXT, type ExportFormat, type ImageFormat } from '@features/export-create/shared'
import { InvalidArgs } from './act-common'

/** True for "/home/a.pdf", "C:\\a.pdf", "C:/a.pdf" and "\\\\server\\share\\a.pdf". */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path) || /^\\\\[^\\/]+[\\/]/.test(path)
}

/** Names Windows keeps for devices, with or without an extension ("NUL", "com1.pdf", "CONIN$"). */
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i

/**
 * A path argument: a non-empty absolute path, normalized ("." and ".." removed). `platform` is
 * the app's (process.platform). Windows device and namespace paths (\\?\..., \\.\...) are refused:
 * no file needs them. On Windows any two leading separators make a network path, as they do for
 * the file system; elsewhere a network path is refused, since it would be read as a relative one.
 */
export function pathArg(value: unknown, platform: string, name = 'path'): string {
  if (typeof value !== 'string' || !value.trim()) throw new InvalidArgs(`${name} must be the absolute path of a file`)
  let path = value.trim()
  if (/^[\\/]{2}[?.](?:[\\/]|$)/.test(path)) throw new InvalidArgs(`${name} must be the path of a file, not a device or a \\\\?\\ or \\\\.\\ path`)
  const windows = platform === 'win32'
  if (windows && /^[\\/]{2}[^\\/]/.test(path)) path = '\\\\' + path.slice(2)
  if (!isAbsolutePath(path)) throw new InvalidArgs(`${name} must be an absolute path (got "${path}")`)
  if (!windows && path.startsWith('\\\\')) throw new InvalidArgs(`${name}: network paths such as \\\\server\\share only work on Windows (got "${path}")`)
  const normalized = normalizePath(path)
  if (normalized === '/' || /^[a-zA-Z]:\\?$/.test(normalized)) throw new InvalidArgs(`${name} must name a file, not a folder`)
  // A computer may be called "aux.example.com": only the names after it are file names.
  const names = normalized.split('\\').slice(normalized.startsWith('\\\\') ? 3 : 0)
  if (windows && names.some((part) => DEVICE_NAME.test(part.split('.')[0].trimEnd())))
    throw new InvalidArgs(`${name} uses a name Windows keeps for devices (got "${normalized}")`)
  return normalized
}

/**
 * The computer a network path (\\server\share\...) is on, lower case and without a WebDAV
 * "@SSL" or "@port" suffix, so one server is asked about once. Null for paths on this computer.
 */
export function networkHost(path: string): string | null {
  const m = /^\\\\([^\\/]+)/.exec(path)
  if (!m) return null
  const host = m[1].toLowerCase()
  return host.replace(/@.*$/, '').replace(/\.$/, '') || host
}

/** Network servers `paths` use that are not in `known`, in first-use order. */
export function newNetworkHosts(paths: string[], known: ReadonlySet<string>): string[] {
  const hosts: string[] = []
  for (const p of paths) {
    const host = networkHost(p)
    if (host && !known.has(host) && !hosts.includes(host)) hosts.push(host)
  }
  return hosts
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
 * open (Microsoft Purview / RMS, kinds of certificate encryption it does not read: MuPDF's
 * "unknown encryption handler: 'Adobe.PubSec'"), else "file_error". Certificate-encrypted files
 * Fartcrobat reads fail with the codes certificateFailure handles.
 */
export function openErrorCode(message: string): 'unsupported' | 'file_error' {
  return /unknown encryption handler|unsupported encryption|Adobe\.PubSec|MicrosoftIRMServices/i.test(message) ? 'unsupported' : 'file_error'
}

/** Why the Windows certificate store could not be searched, for the agent. */
function windowsStoreReason(state: unknown): string | null {
  if (state === 'constrained') return 'Windows only lets PowerShell run in Constrained Language Mode there'
  if (state === 'unavailable') return 'Windows PowerShell could not be started'
  return null
}

/**
 * Why a certificate-encrypted file was not opened although the person did not cancel (they were
 * told why in Fartcrobat): what the agent is told, or null for other errors.
 * - NO_CERTIFICATE (CertificateUnavailableError): none of the person's keys opens it;
 *   "unsupported" when only keys Fartcrobat cannot use yet (elliptic-curve) match.
 * - CERTIFICATE_FAILED (CertificateKeyFailedError): a key that matches could not be used.
 * - CERTIFICATE_OPEN_FAILED (engine): a key opened it, but the file is damaged.
 */
export function certificateFailure(name: string, err: unknown): { code: 'unsupported' | 'failed' | 'file_error'; message: string } | null {
  const e = err as { code?: unknown; message?: unknown; unsupportedKey?: unknown; windowsStore?: unknown; label?: unknown } | null
  if (!e || typeof e !== 'object') return null
  const message = typeof e.message === 'string' ? e.message : ''
  if (e.code === 'CERTIFICATE_OPEN_FAILED') {
    const reason = message.replace(/^.*could not be opened: /s, '').replace(/\.$/, '')
    return {
      code: 'file_error',
      message: `${name} is certificate-encrypted and one of the person's keys unlocked it, but the file could not be opened: ${reason}. Ask the sender for a new copy.`
    }
  }
  if (e.code === 'CERTIFICATE_FAILED')
    return {
      code: 'failed',
      message: `${name} was not opened: the person's key “${String(e.label ?? '')}” could not be used. Fartcrobat told them: ${message} Never ask for keys, PINs or passwords in chat.`
    }
  if (e.code !== 'NO_CERTIFICATE') return null
  const busy = e.windowsStore === 'busy'
  const store = windowsStoreReason(e.windowsStore)
  const storeNote = busy
    ? ' The Windows certificate store did not answer in time (it may have been waiting for a smart card PIN), so a certificate there may open it: try again later.'
    : store
      ? ` Fartcrobat could not search the Windows certificate store on this computer (${store}), so a certificate there may open it but cannot be used.`
      : ''
  if (e.unsupportedKey)
    return {
      code: 'unsupported',
      message: `${name} is encrypted for an elliptic-curve certificate, which Fartcrobat cannot open yet.${storeNote} Ask the sender for a copy encrypted for an RSA certificate or protected with a password.`
    }
  return {
    code: 'failed',
    message: `${name} is encrypted with certificates, and none of the person's ${store || busy ? 'Digital IDs' : 'certificates or Digital IDs'} opens it.${storeNote} Fartcrobat showed them who it is encrypted for; they can add the Digital ID it needs in Fartcrobat (Preferences > Digital IDs) and try again. Never ask for keys or passwords in chat.`
  }
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
