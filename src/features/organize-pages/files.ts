import {
  basename,
  certificateAccess,
  invoke,
  OPEN_FILTERS,
  readFile,
  registry,
  stripExtension,
  unlockCertificateFile,
  unlockFile,
  withProgress,
  type DocUnlock,
  type DocumentModel,
  type EngineClient
} from '@renderer/sdk'
import type { CertificateKey, CertKeyActor } from '@shared/certkeys'
import type { FileFilter } from '@shared/types'
import type docOps from '@engine/ops/doc'
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
  /**
   * How the open document these bytes come from was unlocked (loadOpenDocument): certificate-
   * encrypted bytes then open with its key without asking.
   */
  unlock?: DocUnlock | null
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
  return { name, path: doc.state.filePath, bytes, engineName: name, size: bytes.length, modified: Date.now(), unlock: doc.state.unlock }
}

/** An engine (a tab's, or one of its own) whose doc ops can hold certificate keys. */
export type KeyHolder = Pick<EngineClient, 'ops'>

/**
 * Asks the engine about a file, unlocking it when it is protected: a password saved on this device
 * or one of the person's certificate keys opens it silently, else the person is asked. Returns null
 * when they cancel. `probe` is called with the password to try. `engine` is the engine `probe`
 * runs in: a certificate key is given to it (doc.addCertificateKey) before probing again, so its
 * later calls (insert, combine...) open the file too. `unlock` says how the file was unlocked (for
 * outputs that keep its protection, and the agent audit log).
 */
export async function withUnlock(
  file: { name: string; path: string | null; unlock?: DocUnlock | null },
  engine: KeyHolder,
  probe: (password?: string) => Promise<ProbeResult>,
  opts: { actor?: CertKeyActor; failWithoutKey?: boolean } = {}
): Promise<{ result: Extract<ProbeResult, { ok: true }>; password?: string; unlock?: DocUnlock } | null> {
  const first = await probe()
  if (first.ok) return { result: first }
  if (first.needsCertificate) return withCertificate(file, engine, probe, first.certificate, opts)
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

/** withUnlock for a certificate-encrypted file: the key of the document it comes from, else the person's keys. */
async function withCertificate(
  file: { name: string; path: string | null; unlock?: DocUnlock | null },
  engine: KeyHolder,
  probe: (password?: string) => Promise<ProbeResult>,
  certificate: Extract<ProbeResult, { needsCertificate: true }>['certificate'],
  opts: { actor?: CertKeyActor; failWithoutKey?: boolean }
): Promise<{ result: Extract<ProbeResult, { ok: true }>; unlock: DocUnlock } | null> {
  const doc = engine.ops<typeof docOps>('doc')
  let result: Extract<ProbeResult, { ok: true }> | null = null
  const attempt = async (key: CertificateKey) => {
    await doc.addCertificateKey(key)
    const r = await probe()
    if (r.ok) result = r
    return r.ok
  }
  // Set by `attempt` (TypeScript does not follow assignments made in callbacks).
  const opened = () => result as Extract<ProbeResult, { ok: true }> | null
  const known = file.unlock?.certificateKey
  if (known && (await attempt(known)) && opened()) {
    const via = file.unlock?.via
    return { result: opened()!, unlock: { method: 'source', access: certificateAccess(known.permissions), certificateKey: known, ...(via ? { via } : {}) } }
  }
  const unlocked = await unlockCertificateFile({
    name: file.name,
    filePath: file.path,
    certificate,
    actor: opts.actor,
    failWithoutKey: opts.failWithoutKey,
    attempt
  })
  const probed = opened()
  if (!unlocked || !probed) return null
  return { result: probed, unlock: { method: 'certificate', access: unlocked.access, via: unlocked.via, certificateKey: unlocked.key } }
}

/** Shows the open dialog for files to insert or combine. */
export async function chooseFiles(title: string, multiple: boolean): Promise<string[]> {
  return invoke('file:openDialog', { title, filters: insertFilters(), multiple })
}
