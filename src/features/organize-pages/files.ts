import {
  basename,
  invoke,
  OPEN_FILTERS,
  readFile,
  registry,
  stripExtension,
  unlockFile,
  withProgress,
  type DocUnlock,
  type DocumentModel
} from '@renderer/sdk'
import type { FileFilter } from '@shared/types'
import type organizeOps from './engine'
import type { ProbeResult } from './engine'
import type { ClientOps } from '@engine/define'

export type OrgOps = ClientOps<typeof organizeOps>

export function orgOps(
  doc: DocumentModel,
  onProgress?: (fraction: number, message?: string) => void
): OrgOps {
  return doc.ops<typeof organizeOps>('organize-pages', onProgress ? { onProgress } : undefined)
}

/** A file read from disk and ready for the engine (Office files already converted when possible). */
export interface LoadedFile {
  /** Display name (the original file name). */
  name: string
  path: string | null
  /** Bytes the engine opens (PDF, image, ...). */
  bytes: Uint8Array
  /** File name used by the engine to pick the importer. */
  engineName: string
  size: number
  modified: number
  password?: string
}

function extensionOf(name: string) {
  return (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase()
}

/** File dialog filters: everything the app can open plus extensions handled by converters. */
export function insertFilters(): FileFilter[] {
  const extra = registry.fileConverters.flatMap((c) => c.extensions)
  const [all, ...rest] = OPEN_FILTERS
  return [{ ...all, extensions: [...new Set([...all.extensions, ...extra])] }, ...rest]
}

/** Reads a file, converting it to PDF first when a registered converter handles its type. */
export async function loadFile(path: string): Promise<LoadedFile> {
  const name = basename(path)
  const ext = extensionOf(name)
  let stat: { size: number; mtimeMs: number } | null = null
  try {
    stat = await invoke('file:stat', path)
  } catch {}
  const converter = registry.fileConverters.find((c) => c.extensions.includes(ext))
  if (converter) {
    const converted = await withProgress(`Converting ${name} to PDF…`, () => converter.convert(path)).catch(
      (err) => {
        console.warn('Converter failed, using the built-in importer', err)
        return null
      }
    )
    if (converted) {
      return {
        name,
        path,
        bytes: converted,
        engineName: stripExtension(name) + '.pdf',
        size: stat?.size ?? converted.length,
        modified: stat?.mtimeMs ?? 0
      }
    }
  }
  const bytes = await readFile(path)
  return {
    name,
    path,
    bytes,
    engineName: name,
    size: stat?.size ?? bytes.length,
    modified: stat?.mtimeMs ?? 0
  }
}

/** Current content of an open document (including unsaved changes) as a loaded file. */
export async function loadOpenDocument(doc: DocumentModel): Promise<LoadedFile> {
  const bytes = await doc.saveBytes({})
  const name = doc.state.title.toLowerCase().endsWith('.pdf') ? doc.state.title : doc.state.title + '.pdf'
  return { name, path: doc.state.filePath, bytes, engineName: name, size: bytes.length, modified: Date.now() }
}

/**
 * Asks the engine about a file, unlocking it when it has a password: with a password saved on this
 * device, else by asking the person. Returns null when they cancel. `probe` is called with the
 * password to try; `unlock` says how the file was unlocked (for outputs that keep its protection).
 */
export async function withPassword(
  file: { name: string; path: string | null },
  probe: (password?: string) => Promise<ProbeResult>
): Promise<{ result: Extract<ProbeResult, { ok: true }>; password?: string; unlock?: DocUnlock } | null> {
  const first = await probe()
  if (first.ok) return { result: first }
  // CONTRACT STUB (renderer builder replaces): certificate-encrypted files unlock with the person's keys.
  if (first.needsCertificate) throw new Error(`${file.name} is encrypted with certificates, which cannot be opened yet`)
  let result: Extract<ProbeResult, { ok: true }> | null = null
  const unlocked = await unlockFile({
    name: file.name,
    filePath: file.path,
    lock: first.lock,
    okLabel: 'OK',
    attempt: async (pw) => {
      const r = await probe(pw)
      if (!r.ok) return null
      result = r
      return r.access ?? 'user'
    }
  })
  if (!unlocked || !result) return null
  const { password, ...unlock } = unlocked
  return { result, password, unlock }
}

/** Shows the open dialog for files to insert or combine. */
export async function chooseFiles(title: string, multiple: boolean): Promise<string[]> {
  return invoke('file:openDialog', { title, filters: insertFilters(), multiple })
}
