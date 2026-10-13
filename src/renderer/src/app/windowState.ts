import type { DocumentModel } from '../document/DocumentModel'
import { invoke } from '../platform'
import { useApp } from './store'

let installed = false

/**
 * Tells the main process which files this window has open, so that if the window's renderer
 * crashes, reloading it reopens them.
 */
export function reportOpenFiles() {
  if (installed) return
  installed = true
  let last = ''
  const subs = new Map<DocumentModel, () => void>()
  const report = () => {
    const paths = useApp
      .getState()
      .docs.map((d) => d.state.filePath)
      .filter((p): p is string => !!p)
    const key = JSON.stringify(paths)
    if (key === last) return
    last = key
    void invoke('window:setOpenFiles', paths).catch(() => {})
  }
  const sync = () => {
    const docs = useApp.getState().docs
    for (const [doc, unsub] of subs) {
      if (!docs.includes(doc)) {
        unsub()
        subs.delete(doc)
      }
    }
    for (const doc of docs) {
      if (!subs.has(doc)) subs.set(doc, doc.store.subscribe((s, p) => s.filePath !== p.filePath && report()))
    }
    report()
  }
  useApp.subscribe((s, prev) => {
    if (s.docs !== prev.docs) sync()
  })
  sync()
}
