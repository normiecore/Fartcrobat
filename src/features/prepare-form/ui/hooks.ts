import { useEffect, useState } from 'react'
import { useDocState, usePageVersion, type DocumentModel } from '@renderer/sdk'
import type { PageTabs, PFField } from '../model'
import { pf } from './actions'

/** Fields of one page in tab order; refetched when the page or the form changes. */
export function usePageFields(doc: DocumentModel, pageIndex: number): [PFField[], (f: PFField[]) => void] {
  const version = usePageVersion(doc, pageIndex)
  const docVersion = useDocState(doc, (s) => s.docVersion)
  const [fields, setFields] = useState<PFField[]>([])
  useEffect(() => {
    let alive = true
    pf(doc)
      .listPage(pageIndex)
      .then((f) => {
        if (alive) setFields(f)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [doc, pageIndex, version, docVersion])
  return [fields, setFields]
}

/** Every field of the document (for the Fields panel). */
export function useAllFields(doc: DocumentModel): { fields: PFField[]; tabs: PageTabs[]; loaded: boolean } {
  const docVersion = useDocState(doc, (s) => s.docVersion)
  const globalVersion = useDocState(doc, (s) => s.globalVersion)
  // a number, not the object: the model replaces the pageVersions object after every engine call
  const pagesVersion = useDocState(doc, (s) => Object.values(s.pageVersions).reduce((a, b) => a + b, 0))
  const [state, setState] = useState<{ fields: PFField[]; tabs: PageTabs[]; loaded: boolean }>({ fields: [], tabs: [], loaded: false })
  useEffect(() => {
    let alive = true
    const t = window.setTimeout(() => {
      pf(doc)
        .listAll()
        .then((r) => {
          if (alive) setState({ ...r, loaded: true })
        })
        .catch(() => {})
    }, 30)
    return () => {
      alive = false
      window.clearTimeout(t)
    }
  }, [doc, docVersion, globalVersion, pagesVersion])
  return state
}
