import type { IpcArgs, IpcChannel, IpcEvents, IpcResult, PreloadApi } from '@shared/ipc'
import type { FileFilter } from '@shared/types'

function bridge(): PreloadApi {
  const api = (window as any).api as PreloadApi | undefined
  if (!api) throw new Error('Preload bridge missing')
  return api
}

/** Typed call into the main process. */
export function invoke<K extends IpcChannel>(channel: K, ...args: IpcArgs<K>): Promise<IpcResult<K>> {
  return bridge().invoke(channel, ...args)
}

export function onMainEvent<K extends keyof IpcEvents>(event: K, listener: IpcEvents[K]): () => void {
  return bridge().on(event, listener)
}

export function pathForFile(file: File): string {
  return bridge().pathForFile(file)
}

export const platform: string = (window as any).api?.platform ?? 'linux'
export const isMac = platform === 'darwin'

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return i > 0 ? path.slice(0, i) : path
}

export function stripExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, '')
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? dir + name : dir + sep + name
}

export const PDF_FILTER: FileFilter = { name: 'PDF files', extensions: ['pdf'] }

export const OPEN_FILTERS: FileFilter[] = [
  {
    name: 'All supported files',
    extensions: [
      'pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'xps', 'oxps', 'epub', 'cbz', 'svg', 'txt',
      'docx', 'xlsx', 'pptx', 'html', 'htm', 'fb2', 'mobi'
    ]
  },
  PDF_FILTER,
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp'] },
  { name: 'Office documents', extensions: ['docx', 'xlsx', 'pptx'] },
  { name: 'All files', extensions: ['*'] }
]

/** Reads a file from disk through the main process. */
export function readFile(path: string): Promise<Uint8Array> {
  return invoke('file:read', path)
}

/** Writes a file atomically through the main process. */
export function writeFile(path: string, data: Uint8Array): Promise<void> {
  return invoke('file:write', path, data)
}

/** Shows a native save dialog and writes the data there. Returns the chosen path or null. */
export async function saveBytesAs(
  data: Uint8Array,
  defaultName: string,
  filters: FileFilter[] = [PDF_FILTER],
  title?: string
): Promise<string | null> {
  const path = await invoke('file:saveDialog', { defaultPath: defaultName, filters, title })
  if (!path) return null
  await writeFile(path, data)
  return path
}
