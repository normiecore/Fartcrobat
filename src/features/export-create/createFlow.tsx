/**
 * Create a PDF: from files (converted and combined), images, the clipboard, blank pages and local
 * HTML files, plus Office and HTML conversion when such files are opened.
 */
import {
  basename,
  EngineClient,
  invoke,
  openNewDocument,
  openPaths,
  openToolGroup,
  readFile,
  showError,
  stripExtension,
  toast,
  unlockFile,
  useApp,
  withProgress,
  type DocumentModel
} from '@renderer/sdk'
import type docOpsT from '@engine/ops/doc'
import type exportOps from './engine'
import {
  BUILTIN_OFFICE_EXTENSIONS,
  CREATE_EXTENSIONS,
  HTML_EXTENSIONS,
  IMAGE_EXTENSIONS,
  LIBREOFFICE_DOWNLOAD_URL,
  OFFICE_EXTENSIONS,
  blankSize,
  extensionOf,
  type BlankOptions,
  type CreatePart,
  type ImagePageOptions
} from './shared'
import { getState, loadSettings, setState } from './state'

export const CREATE_FILTERS = [
  { name: 'All supported files', extensions: CREATE_EXTENSIONS },
  { name: 'PDF files', extensions: ['pdf'] },
  { name: 'Images', extensions: IMAGE_EXTENSIONS },
  { name: 'Office documents', extensions: OFFICE_EXTENSIONS },
  { name: 'Web pages', extensions: HTML_EXTENSIONS },
  { name: 'All files', extensions: ['*'] }
]

const IMAGE_FILTERS = [{ name: 'Images', extensions: IMAGE_EXTENSIONS }]
const HTML_FILTERS = [{ name: 'Web pages', extensions: HTML_EXTENSIONS }]

class Cancelled extends Error {}

/** An error message without Electron's "Error invoking remote method …" wrapping. */
function errorText(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

/** Opens the new PDF in a tab and leaves Create a PDF so the document shows. */
async function openCreated(bytes: Uint8Array, name: string): Promise<DocumentModel | null> {
  const doc = await openNewDocument(bytes, name)
  if (doc && useApp.getState().toolGroupId === 'create') openToolGroup(null)
  return doc
}

// ---- LibreOffice hints --------------------------------------------------------------------

const HINT_KEY = 'export-create:libreOfficeHintShown'

/** Tells once that LibreOffice converts Office files better than the built-in importer. */
async function hintLibreOffice(ext: string) {
  if (!BUILTIN_OFFICE_EXTENSIONS.includes(ext)) {
    toast(
      `Opening .${ext} files needs LibreOffice, which is free. Install it from ${LIBREOFFICE_DOWNLOAD_URL} — or set where it is in Preferences > Convert.`,
      { kind: 'warning', timeout: 12000 }
    )
    return
  }
  try {
    if (await invoke('store:get', HINT_KEY)) return
    await invoke('store:set', HINT_KEY, true)
  } catch {}
  toast(`Install LibreOffice for best Office conversion quality: ${LIBREOFFICE_DOWNLOAD_URL}`, { kind: 'info', timeout: 12000 })
}

/** Office file -> PDF bytes with LibreOffice; null when LibreOffice is not installed. */
export async function convertOffice(path: string): Promise<Uint8Array | null> {
  let bytes: Uint8Array | null
  try {
    bytes = await invoke('feature:export-create:convertOffice', path)
  } catch (err) {
    const ext = extensionOf(path)
    const fallback = BUILTIN_OFFICE_EXTENSIONS.includes(ext) ? ' Trying the built-in converter instead.' : ''
    const reason = errorText(err).replace(/\.$/, '')
    toast(`LibreOffice could not convert ${basename(path)}: ${reason}.${fallback}`, { kind: 'warning', timeout: 10000 })
    throw err
  }
  if (!bytes) void hintLibreOffice(extensionOf(path))
  return bytes
}

/** Local HTML file -> PDF bytes (Chromium, offline). */
export async function convertHtml(path: string): Promise<Uint8Array> {
  await loadSettings()
  return invoke('feature:export-create:convertHtml', path, getState().html)
}

// ---- building ---------------------------------------------------------------------------

/** Builds a new PDF in a throwaway engine (no document needs to be open). */
async function buildPdf(
  parts: CreatePart[],
  opts: { image?: ImagePageOptions; title?: string },
  report?: (fraction: number | null, message?: string) => void
): Promise<Uint8Array> {
  const engine = new EngineClient()
  try {
    await engine.ready()
    for (;;) {
      try {
        const ops = engine.ops<typeof exportOps>('export-create', { onProgress: (f, m) => report?.(f, m) })
        return await ops.build(parts, opts)
      } catch (err) {
        const code = (err as { code?: string }).code
        const m = /^(.*?) is password protected$|^The password for (.*?) is incorrect$/.exec((err as Error).message)
        if ((code === 'NEEDS_PASSWORD' || code === 'WRONG_PASSWORD') && m) {
          const name = m[1] ?? m[2]
          const part = parts.find((p) => p.kind === 'file' && p.name === name)
          if (!part || part.kind !== 'file') throw err
          // Tried on the file alone: a password saved on this device, else the person.
          const docOps = engine.ops<typeof docOpsT>('doc')
          const checked = await docOps.checkFile(part.data, part.name)
          const lock = checked.needsPassword ? checked.lock : null
          // The progress window would cover the question: put it away while asking.
          const progress = useApp.getState().progress
          useApp.setState({ progress: null })
          const unlocked = await unlockFile({
            name,
            filePath: part.path ?? null,
            lock,
            wrong: code === 'WRONG_PASSWORD',
            attempt: async (pw) => {
              const r = await docOps.checkFile(part.data, part.name, pw)
              return r.needsPassword ? r.access : 'user'
            }
          }).finally(() => useApp.setState({ progress }))
          if (!unlocked) throw new Cancelled()
          part.password = unlocked.password
          continue
        }
        throw err
      }
    }
  } finally {
    engine.terminate()
  }
}

/** Reads a file as a part of a new PDF, converting Office and HTML files first. */
async function partFromPath(path: string): Promise<CreatePart> {
  const name = basename(path)
  const ext = extensionOf(name)
  if (HTML_EXTENSIONS.includes(ext)) return { kind: 'file', name: stripExtension(name) + '.pdf', data: await convertHtml(path) }
  if (OFFICE_EXTENSIONS.includes(ext)) {
    const pdf = await convertOffice(path)
    if (pdf) return { kind: 'file', name: stripExtension(name) + '.pdf', data: pdf }
    if (!BUILTIN_OFFICE_EXTENSIONS.includes(ext)) throw new Error(`${name} needs LibreOffice to be converted`)
  }
  return { kind: 'file', name, data: await readFile(path), path }
}

function newName(paths: string[], fallback: string): string {
  return paths.length === 1 ? stripExtension(basename(paths[0])) + '.pdf' : fallback
}

async function run<T>(title: string, task: (report: (fraction: number | null, message?: string) => void) => Promise<T>): Promise<T | null> {
  setState({ creating: true })
  try {
    return await withProgress(title, task)
  } catch (err) {
    if (err instanceof Cancelled) return null
    showError(new Error(errorText(err)), 'Could not create the PDF')
    return null
  } finally {
    setState({ creating: false })
  }
}

/**
 * Creates one PDF from files: each is converted (Office through LibreOffice, web pages through
 * Chromium, images placed on pages) and they are combined in the order given.
 */
export async function createFromPaths(paths: string[], opts: { name?: string } = {}): Promise<DocumentModel | null> {
  if (!paths.length) return null
  await loadSettings()
  // One PDF: just open it.
  if (paths.length === 1 && extensionOf(paths[0]) === 'pdf') {
    await openPaths(paths)
    if (useApp.getState().toolGroupId === 'create') openToolGroup(null)
    return null
  }
  const bytes = await run(paths.length === 1 ? `Creating PDF from ${basename(paths[0])}…` : `Combining ${paths.length} files…`, async (report) => {
    const parts: CreatePart[] = []
    for (let k = 0; k < paths.length; k++) {
      report(k / (paths.length + 1), `Converting ${basename(paths[k])}`)
      parts.push(await partFromPath(paths[k]))
    }
    report(paths.length / (paths.length + 1), 'Building the PDF')
    return buildPdf(parts, { image: getState().imagePage, title: paths.length === 1 ? stripExtension(basename(paths[0])) : undefined })
  })
  if (!bytes) return null
  return openCreated(bytes, opts.name ?? newName(paths, 'Combined.pdf'))
}

/** File > Create > PDF from File… (several files are combined into one PDF). */
export async function createFromFileDialog() {
  const paths = await invoke('file:openDialog', { title: 'Create PDF from File', filters: CREATE_FILTERS, multiple: true })
  if (paths.length) await createFromPaths(paths)
}

/** One PDF from images, laid out with the page options. */
export async function createFromImages(paths: string[]): Promise<DocumentModel | null> {
  const bad = paths.filter((p) => !IMAGE_EXTENSIONS.includes(extensionOf(p)))
  if (bad.length) {
    toast(`${basename(bad[0])} is not an image`, { kind: 'error' })
    return null
  }
  return createFromPaths(paths, { name: newName(paths, 'Images.pdf') })
}

export async function createFromImagesDialog() {
  const paths = await invoke('file:openDialog', { title: 'Create PDF from Images', filters: IMAGE_FILTERS, multiple: true })
  if (paths.length) await createFromImages(paths)
}

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp', 'image/tiff': 'tif' }

function sniffImage(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'png'
  if (data[0] === 0xff && data[1] === 0xd8) return 'jpg'
  if (data[0] === 0x47 && data[1] === 0x49) return 'gif'
  if (data[0] === 0x42 && data[1] === 0x4d) return 'bmp'
  if (data[0] === 0x49 || data[0] === 0x4d) return 'tif'
  if (data[8] === 0x57 && data[9] === 0x45) return 'webp'
  return MIME_EXT['image/png']
}

/** File > Create > PDF from Clipboard: a copied image (screenshot) or copied text. */
export async function createFromClipboard(): Promise<DocumentModel | null> {
  await loadSettings()
  let image: Uint8Array | null = null
  let text = ''
  try {
    image = await invoke('clipboard:readImage')
    if (!image?.length) text = await invoke('feature:export-create:clipboardText')
  } catch (err) {
    showError(err, 'Could not read the clipboard')
    return null
  }
  if (!image?.length && !text.trim()) {
    toast('The clipboard is empty. Copy an image or some text first.', { kind: 'warning' })
    return null
  }
  const part: CreatePart = image?.length
    ? { kind: 'file', name: `Clipboard.${sniffImage(image)}`, data: image }
    : { kind: 'file', name: 'Clipboard.txt', data: new TextEncoder().encode(text) }
  const bytes = await run('Creating PDF from the clipboard…', (report) => buildPdf([part], { image: getState().imagePage, title: 'Clipboard' }, report))
  if (!bytes) return null
  return openCreated(bytes, 'Clipboard.pdf')
}

/** File > Create > Blank Page. */
export async function createBlank(b: BlankOptions): Promise<DocumentModel | null> {
  const size = blankSize(b)
  if (typeof size === 'string') {
    toast(size, { kind: 'error' })
    return null
  }
  const pages = Math.max(1, Math.min(500, Math.round(b.pages)))
  const bytes = await run('Creating blank pages…', (report) => buildPdf([{ kind: 'blank', ...size, count: pages }], { title: 'Untitled' }, report))
  if (!bytes) return null
  return openCreated(bytes, 'Untitled.pdf')
}

/** Create > PDF from HTML file (offline; Chromium lays the page out). */
export async function createFromHtml(path: string): Promise<DocumentModel | null> {
  const bytes = await run(`Converting ${basename(path)}…`, () => convertHtml(path))
  if (!bytes) return null
  return openCreated(bytes, stripExtension(basename(path)) + '.pdf')
}

export async function createFromHtmlDialog() {
  const paths = await invoke('file:openDialog', { title: 'Create PDF from HTML File', filters: HTML_FILTERS })
  if (paths[0]) await createFromHtml(paths[0])
}

export type CreateList = 'files' | 'images'

/** Adds files to the "Multiple files" or "Images" list (no duplicates). */
export function addCreateFiles(list: CreateList, paths: string[]) {
  const items = [...getState()[list]]
  for (const path of paths) {
    if (list === 'images' && !IMAGE_EXTENSIONS.includes(extensionOf(path))) {
      toast(`${basename(path)} is not an image`, { kind: 'warning' })
      continue
    }
    if (!items.some((f) => f.path === path)) items.push({ path, name: basename(path) })
  }
  setState({ [list]: items })
}

export async function pickCreateFiles(list: CreateList) {
  const paths = await invoke('file:openDialog', {
    title: list === 'images' ? 'Add Images' : 'Add Files',
    filters: list === 'images' ? IMAGE_FILTERS : CREATE_FILTERS,
    multiple: true
  })
  addCreateFiles(list, paths)
}

/** Creates the PDF from the "Multiple files" or "Images" list, and empties the list when done. */
export async function createFromList(list: CreateList): Promise<DocumentModel | null> {
  const items = getState()[list]
  if (!items.length) return null
  const doc = list === 'images' ? await createFromImages(items.map((f) => f.path)) : await createFromPaths(items.map((f) => f.path))
  if (doc) setState({ [list]: [] })
  return doc
}
