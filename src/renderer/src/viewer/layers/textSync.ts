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

/**
 * loadText for pointer handlers and effects that do not wait for it: gives null when the text
 * could not be read, and says nothing when that is because the document was closed meanwhile.
 */
export function tryLoadText(doc: DocumentModel, page: number): Promise<PageText | null> {
  return loadText(doc, page).catch((err) => {
    if (!doc.isClosed) console.warn(`Could not read the text of page ${page + 1}`, err)
    return null
  })
}
