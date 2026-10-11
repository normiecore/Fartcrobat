import type { DocumentModel } from '../../document/DocumentModel'
import type { PageText } from '../../document/textModel'

/** Synchronous view of page texts that have finished loading (for pointer handlers). */
const loaded = new WeakMap<DocumentModel, Map<number, { version: number; text: PageText }>>()

export function getLoadedText(doc: DocumentModel, page: number): PageText | null {
  const e = loaded.get(doc)?.get(page)
  return e && e.version === doc.pageVersion(page) ? e.text : null
}

export async function loadText(doc: DocumentModel, page: number): Promise<PageText> {
  const version = doc.pageVersion(page)
  const text = await doc.pageText(page)
  let m = loaded.get(doc)
  if (!m) {
    m = new Map()
    loaded.set(doc, m)
  }
  m.set(page, { version, text })
  return text
}
