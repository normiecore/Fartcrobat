import { create } from 'zustand'
import { invoke, showError, type DocumentModel } from '@renderer/sdk'
import type { DigitalIdRecord, MdpPermission, TrustedCertificate, ValidationReport } from '../types'
import { STORE_IDS, STORE_TRUSTED } from '../types'

export interface DocSignatures {
  report: ValidationReport | null
  running: boolean
  error: string | null
}

interface SigState {
  byDoc: Record<string, DocSignatures>
  ids: DigitalIdRecord[]
  idsLoaded: boolean
  trusted: TrustedCertificate[]
  /** What the "drag a rectangle" tool does when the box is drawn. */
  boxMode: { mode: 'sign' | 'certify'; permission: MdpPermission }
  /** Docs whose message bar was dismissed. */
  barHidden: Record<string, boolean>
}

export const useSigStore = create<SigState>(() => ({
  byDoc: {},
  ids: [],
  idsLoaded: false,
  trusted: [],
  boxMode: { mode: 'sign', permission: 2 },
  barHidden: {}
}))

export type SigOps = typeof import('../engine').default

export function sigOps(doc: DocumentModel) {
  return doc.ops<SigOps>('digital-signatures')
}

function setDoc(docId: string, patch: Partial<DocSignatures>) {
  useSigStore.setState((s) => ({
    byDoc: { ...s.byDoc, [docId]: { ...(s.byDoc[docId] ?? EMPTY), ...patch } }
  }))
}

interface Inflight {
  promise: Promise<ValidationReport | null>
  /** Asked again while running: the document may have changed, so validate once more. */
  again: boolean
}

const inflight = new Map<string, Inflight>()

/**
 * Validates every signature of the document (results are kept per document). Calls made while a
 * validation runs are coalesced into one more run, so the stored report always reflects the
 * latest state of the document.
 */
export function validateDocument(doc: DocumentModel): Promise<ValidationReport | null> {
  const running = inflight.get(doc.id)
  if (running) {
    running.again = true
    return running.promise
  }
  const entry: Inflight = { promise: Promise.resolve(null), again: false }
  setDoc(doc.id, { running: true })
  entry.promise = (async () => {
    let report: ValidationReport | null = null
    try {
      do {
        entry.again = false
        try {
          report = await sigOps(doc).validate()
          if (!doc.isClosed && !entry.again) setDoc(doc.id, { report, running: false, error: null })
        } catch (err) {
          report = null
          if (!doc.isClosed && !entry.again) setDoc(doc.id, { running: false, error: err instanceof Error ? err.message : String(err) })
        }
      } while (entry.again && !doc.isClosed)
      return report
    } finally {
      inflight.delete(doc.id)
    }
  })()
  inflight.set(doc.id, entry)
  return entry.promise
}

export function forgetDocument(docId: string) {
  useSigStore.setState((s) => {
    const byDoc = { ...s.byDoc }
    delete byDoc[docId]
    return { byDoc }
  })
}

export function useDocSignatures(doc: DocumentModel | null): DocSignatures {
  return useSigStore((s) => (doc ? s.byDoc[doc.id] : undefined)) ?? EMPTY
}

const EMPTY: DocSignatures = { report: null, running: false, error: null }

// ---- Digital IDs and trust ---------------------------------------------------------------------

export async function loadIds(): Promise<DigitalIdRecord[]> {
  try {
    const v = await invoke('store:get', STORE_IDS)
    const ids = Array.isArray(v) ? (v as DigitalIdRecord[]).filter((x) => x && typeof x.path === 'string') : []
    useSigStore.setState({ ids, idsLoaded: true })
    return ids
  } catch (err) {
    useSigStore.setState({ idsLoaded: true })
    showError(err, 'Could not read your Digital IDs')
    return []
  }
}

export async function saveIds(ids: DigitalIdRecord[]) {
  useSigStore.setState({ ids })
  await invoke('store:set', STORE_IDS, ids)
}

export async function loadTrusted(): Promise<TrustedCertificate[]> {
  try {
    const v = await invoke('store:get', STORE_TRUSTED)
    const trusted = Array.isArray(v) ? (v as TrustedCertificate[]).filter((x) => x && typeof x.fingerprint === 'string') : []
    useSigStore.setState({ trusted })
    return trusted
  } catch (err) {
    showError(err, 'Could not read your trusted certificates')
    return []
  }
}

export async function setTrusted(trusted: TrustedCertificate[]) {
  useSigStore.setState({ trusted })
  await invoke('store:set', STORE_TRUSTED, trusted)
}

export function useTrustedSet(): Set<string> {
  const trusted = useSigStore((s) => s.trusted)
  return trustedSetCache(trusted)
}

let lastTrusted: TrustedCertificate[] | null = null
let lastSet = new Set<string>()
function trustedSetCache(t: TrustedCertificate[]): Set<string> {
  if (t !== lastTrusted) {
    lastTrusted = t
    lastSet = new Set(t.map((x) => x.fingerprint.toUpperCase()))
  }
  return lastSet
}

export function trustedSet(): Set<string> {
  return trustedSetCache(useSigStore.getState().trusted)
}
