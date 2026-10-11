import { create } from 'zustand'
import type { DocumentModel } from '../document/DocumentModel'

/**
 * Annotation ids temporarily left out of page rendering (e.g. while the user drags an annotation,
 * a feature draws a live preview instead).
 */
const useHidden = create<{ byDoc: Record<string, Record<number, number[]>> }>(() => ({ byDoc: {} }))

export function setHiddenAnnotations(doc: DocumentModel, pageIndex: number, ids: number[]) {
  useHidden.setState((s) => ({
    byDoc: { ...s.byDoc, [doc.id]: { ...(s.byDoc[doc.id] ?? {}), [pageIndex]: ids } }
  }))
}

const EMPTY: number[] = []

export function useHiddenAnnotations(doc: DocumentModel, pageIndex: number): number[] {
  return useHidden((s) => s.byDoc[doc.id]?.[pageIndex] ?? EMPTY)
}
