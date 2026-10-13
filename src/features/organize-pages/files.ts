import {
  basename,
  invoke,
  OPEN_FILTERS,
  prompt,
  readFile,
  registry,
  stripExtension,
  withProgress,
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
 * Asks the engine about a file, prompting for its password when it has one. Returns null when the
 * user cancels the password prompt. `probe` is called with the password to try.
 */
export async function withPassword(
  name: string,
  probe: (password?: string) => Promise<ProbeResult>
): Promise<{ result: Extract<ProbeResult, { ok: true }>; password?: string } | null> {
  let password: string | undefined
  let res = await probe()
  while (!res.ok) {
    const pw = await prompt({
      title: 'Password required',
      message: res.wrongPassword
        ? `The password for “${name}” is incorrect. Try again.`
        : `“${name}” is protected. Enter its open password.`,
      label: 'Password',
      password: true,
      okLabel: 'OK'
    })
    if (pw === null) return null
    password = pw
    res = await probe(pw)
  }
  return { result: res, password }
}

/** Shows the open dialog for files to insert or combine. */
export async function chooseFiles(title: string, multiple: boolean): Promise<string[]> {
  return invoke('file:openDialog', { title, filters: insertFilters(), multiple })
}
