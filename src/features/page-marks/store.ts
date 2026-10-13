import { create } from 'zustand'
import { showError, type DocumentModel } from '@renderer/sdk'
import { scheduleMenuUpdate } from '@renderer/app/commands'
import type marksOps from './engine'
import type { MarkGroup, MarksListing, MarkType } from './shared'

export function marksApi(doc: DocumentModel, onProgress?: (fraction: number, message?: string) => void) {
  return doc.ops<typeof marksOps>('page-marks', onProgress ? { onProgress } : undefined)
}

/** Marks found in each open document (kept in sync after every change). */
export const useMarks = create<{ byDoc: Record<string, MarksListing> }>(() => ({ byDoc: {} }))

const EMPTY: MarksListing = { groups: [], croppedPages: [] }

export function listingOf(doc: DocumentModel | null): MarksListing {
  if (!doc) return EMPTY
  return useMarks.getState().byDoc[doc.id] ?? EMPTY
}

export function useListing(doc: DocumentModel | null): MarksListing {
  return useMarks((s) => (doc ? (s.byDoc[doc.id] ?? EMPTY) : EMPTY))
}

export function groupsOf(listing: MarksListing, type: MarkType): MarkGroup[] {
  return listing.groups.filter((g) => g.type === type)
}

export function hasMarks(doc: DocumentModel | null, type: MarkType): boolean {
  return groupsOf(listingOf(doc), type).length > 0
}

const pending = new Map<string, { timer: number; waiters: (() => void)[] }>()
const failed = new Set<string>()

/**
 * Re-reads the marks of a document. Bursts of calls are coalesced; every caller's promise
 * resolves once the listing is up to date.
 */
export function refreshMarks(doc: DocumentModel, delay = 120): Promise<void> {
  return new Promise((resolve) => {
    const prev = pending.get(doc.id)
    if (prev) window.clearTimeout(prev.timer)
    const waiters = prev ? prev.waiters : []
    waiters.push(resolve)
    const timer = window.setTimeout(async () => {
      pending.delete(doc.id)
      try {
        if (doc.isClosed) {
          useMarks.setState((s) => {
            const byDoc = { ...s.byDoc }
            delete byDoc[doc.id]
            return { byDoc }
          })
          return
        }
        const listing = await marksApi(doc).list()
        const before = useMarks.getState().byDoc[doc.id]
        useMarks.setState((s) => ({ byDoc: { ...s.byDoc, [doc.id]: listing } }))
        // Update/Remove items in the native menu depend on what the document contains.
        if (JSON.stringify(before) !== JSON.stringify(listing)) scheduleMenuUpdate()
        failed.delete(doc.id)
      } catch (err) {
        // Say so once per document, not on every change.
        if (!doc.isClosed && !failed.has(doc.id)) {
          failed.add(doc.id)
          showError(err, 'Could not read the headers, watermarks and backgrounds of this document')
        }
      } finally {
        for (const w of waiters) w()
      }
    }, delay)
    pending.set(doc.id, { timer, waiters })
  })
}

/** Starts tracking a newly opened document. */
export function trackDocument(doc: DocumentModel) {
  void refreshMarks(doc, 0)
  doc.onChange((cs) => {
    if (cs.document || cs.structure || cs.all) void refreshMarks(doc)
  })
}
