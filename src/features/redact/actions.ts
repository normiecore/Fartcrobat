/** Redact actions used by the panel, tool, commands and dialogs. */
import type { Rect } from '@shared/geometry'
import {
  PDF_FILTER,
  basename,
  dirname,
  invoke,
  joinPath,
  openToolGroup,
  readFile,
  showError,
  stripExtension,
  toast,
  useApp,
  writeFile,
  type DocumentModel,
  type TextRange
} from '@renderer/sdk'
import { rangeQuads } from '@renderer/document/textModel'
import type { MarkInfo, MarkSpec } from './shared'
import { currentProps, loadProps, redactOps, selectMarks, useRedactUi } from './store'

/** Runs an engine task, showing the progress dialog only when it takes more than a moment. */
export async function runWithProgress<T>(title: string, task: (report: (fraction: number, message?: string) => void) => Promise<T>): Promise<T> {
  let shown = false
  let last: { fraction: number; message?: string } = { fraction: 0 }
  const timer = window.setTimeout(() => {
    shown = true
    useApp.setState({ progress: { title, fraction: last.fraction, message: last.message } })
  }, 350)
  try {
    return await task((fraction, message) => {
      last = { fraction, message }
      if (shown) useApp.setState((s) => ({ progress: s.progress ? { ...s.progress, fraction, message } : s.progress }))
    })
  } finally {
    window.clearTimeout(timer)
    if (shown) useApp.setState({ progress: null })
  }
}

export function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`
}

/** "page 3", "pages 1, 2 and 4", "12 pages", "all 5 pages" */
export function pagesPhrase(pages: number[], total?: number): string {
  const list = [...new Set(pages)].sort((a, b) => a - b).map((p) => String(p + 1))
  if (list.length === 1) return `page ${list[0]}`
  if (total && list.length === total) return total === 2 ? 'both pages' : `all ${total} pages`
  if (list.length <= 5) return `pages ${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`
  return `${list.length} pages`
}

// ---- marking ------------------------------------------------------------------------------------

/** Marks text ranges (each range becomes one mark). */
export async function markRanges(doc: DocumentModel, ranges: TextRange[]): Promise<MarkInfo[]> {
  const specs: MarkSpec[] = []
  for (const r of ranges) {
    if (r.end <= r.start) continue
    const t = await doc.pageText(r.page)
    const quads = rangeQuads(t, r.start, Math.min(r.end, t.text.length))
    if (quads.length) specs.push({ page: r.page, kind: 'text', quads })
  }
  if (!specs.length) return []
  return markSpecs(doc, specs)
}

export async function markSpecs(doc: DocumentModel, specs: MarkSpec[]): Promise<MarkInfo[]> {
  await loadProps()
  try {
    return await redactOps(doc).mark(specs, currentProps())
  } catch (err) {
    showError(err, 'Could not mark for redaction')
    return []
  }
}

export async function markArea(doc: DocumentModel, page: number, rect: Rect) {
  return markSpecs(doc, [{ page, kind: 'area', rect }])
}

export async function deleteMarks(doc: DocumentModel, ids: number[]) {
  if (!ids.length) return
  try {
    await redactOps(doc).remove(ids)
    doc.clearSelection()
  } catch (err) {
    showError(err, 'Could not delete the redaction mark')
  }
}

export function goToMark(doc: DocumentModel, mark: MarkInfo, select = true) {
  doc.view?.scrollToRect(mark.page, mark.rect, { center: true })
  if (select) selectMarks(doc, mark.page, [mark.id])
}

export function openRedactPanel(view: 'main' | 'find' = 'main') {
  useRedactUi.setState({ view })
  if (useApp.getState().toolGroupId !== 'redact') openToolGroup('redact')
}

// ---- applying -----------------------------------------------------------------------------------

const needsReload = new WeakSet<DocumentModel>()

/** Remembers that the document must be reloaded from disk after its next save. */
export function markNeedsReload(doc: DocumentModel) {
  needsReload.add(doc)
}

/** Save As with "_Redacted" added to the name (as Acrobat suggests). */
export async function saveRedactedCopy(doc: DocumentModel): Promise<boolean> {
  const path = doc.state.filePath
  const stem = stripExtension(doc.state.title).replace(/_Redacted$/i, '')
  const name = `${stem}_Redacted.pdf`
  try {
    const chosen = await invoke('file:saveDialog', {
      title: 'Save Redacted Copy',
      defaultPath: path ? joinPath(dirname(path), name) : name,
      filters: [PDF_FILTER]
    })
    if (!chosen) return false
    const target = chosen.toLowerCase().endsWith('.pdf') ? chosen : chosen + '.pdf'
    const bytes = await doc.busyWhile('Saving…', () => doc.saveBytes({}))
    await writeFile(target, bytes)
    await doc.core.doc.markSaved(basename(target))
    doc.set({ filePath: target, title: basename(target), dirty: false })
    try {
      const recent = await invoke('recent:add', { path: target, name: basename(target), size: bytes.length, pageCount: doc.pageCount })
      useApp.setState({ recent })
    } catch {}
    toast(`Saved ${basename(target)}`, { kind: 'success', timeout: 3000 })
    return true
  } catch (err) {
    showError(err, 'Could not save the redacted document')
    return false
  }
}

async function reloadFromDisk(doc: DocumentModel) {
  const path = doc.state.filePath
  if (!path || doc.isClosed || doc.state.dirty) return
  try {
    const bytes = await readFile(path)
    const res = await doc.core.doc.reload(bytes, {})
    if (!res.ok) return // password-protected copy: keep the session (saves stay full rewrites)
    doc.set({ info: res.info, selection: { kind: 'none' }, dirty: false })
    await doc.core.doc.markSaved(basename(path))
  } catch (err) {
    if (!doc.isClosed) console.error('Could not reload the redacted document', err)
  }
}

/**
 * After redactions were applied (or hidden information removed) and the document was saved, the
 * tab is reloaded from the saved file: the removed content is then gone from memory too, so later
 * incremental saves (e.g. when signing) cannot bring the original bytes back.
 */
export function watchForSave(doc: DocumentModel) {
  const unsubscribe = doc.store.subscribe((s, prev) => {
    if (doc.isClosed) {
      unsubscribe()
      return
    }
    if (!needsReload.has(doc)) return
    const saved = prev.dirty && !s.dirty && s.journal.position === prev.journal.position
    if (!saved) return
    needsReload.delete(doc)
    // let the save finish updating the file path first
    window.setTimeout(() => void reloadFromDisk(doc), 50)
  })
}

