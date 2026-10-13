import { invoke, openNewDocument, showError, toast, useApp, withProgress, type DocumentModel } from '@renderer/sdk'
import type pageOps from '@engine/ops/pages'
import { loadFile, orgOps, withPassword, type LoadedFile } from './files'
import type { OrganizeClipboard } from './ipc'
import { isNoopMove, movedIndices } from './order'
import { countLabel, describePages } from './ranges'
import { clearSelection, isOrganizeOpen, ORGANIZE_GROUP, selectIndices, setFocusIndex } from './store'
import './ipc'

export function pagesOps(doc: DocumentModel) {
  return doc.ops<typeof pageOps>('pages')
}

/**
 * Runs an engine change and waits until the document model has picked up the new page list, so
 * that callers can select the resulting pages.
 */
export async function afterChange<T>(doc: DocumentModel, fn: () => Promise<T>): Promise<T> {
  const before = doc.state.info
  const result = await fn()
  if (doc.state.info === before) {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(done, 4000)
      const unsub = doc.store.subscribe((s) => {
        if (s.info !== before) done()
      })
      function done() {
        window.clearTimeout(timer)
        unsub()
        resolve()
      }
    })
  }
  return result
}

/** Titles of tool output being opened right now (see markToolOutputUnsaved). */
const pendingUnsaved = new Set<string>()

/**
 * Opens tool output (combined or extracted pages) as a new, unsaved tab: closing it asks to save
 * and the tab shows the unsaved-changes marker.
 */
export async function openAsNewDocument(bytes: Uint8Array, name: string): Promise<DocumentModel | null> {
  const title = name.toLowerCase().endsWith('.pdf') ? name : name + '.pdf'
  pendingUnsaved.add(title)
  try {
    const doc = await openNewDocument(bytes, title)
    // Already done by the onDocumentOpen hook; repeating it is harmless and waits for it.
    if (doc) await orgOps(doc).markUnsaved()
    return doc
  } finally {
    pendingUnsaved.delete(title)
  }
}

/**
 * onDocumentOpen hook. Marks a document opened by openAsNewDocument as unsaved in its engine
 * before the viewer's first engine calls, so the "unsaved" state never flickers off.
 */
export function markToolOutputUnsaved(doc: DocumentModel) {
  if (doc.state.filePath || !pendingUnsaved.delete(doc.state.title)) return
  void orgOps(doc)
    .markUnsaved()
    .catch((err) => console.warn('Could not mark the new document as unsaved', err))
}

/**
 * "Undo" button for a toast. It only undoes while the change it reports is still the last one, so
 * a late click never undoes something else.
 */
export function undoAction(doc: DocumentModel) {
  const position = doc.state.journal.position
  const label = doc.state.journal.undoLabel
  return {
    label: 'Undo',
    run: () => {
      const j = doc.state.journal
      if (doc.isClosed || !j.canUndo || j.position !== position || j.undoLabel !== label) {
        toast('That change was already undone or followed by other changes. Use Edit > Undo instead.', {
          kind: 'warning'
        })
        return
      }
      void doc.undo().catch((err) => showError(err, 'Could not undo'))
    }
  }
}

/** Selects pages after an operation when the grid is open (and moves the viewer there otherwise). */
function reveal(doc: DocumentModel, indices: number[]) {
  if (!indices.length) return
  if (isOrganizeOpen(doc)) selectIndices(doc, indices, { focus: indices[0], anchor: indices[0] })
  else doc.view?.goToPage(indices[0])
}

export async function rotatePages(doc: DocumentModel, indices: number[], degrees: number) {
  if (!indices.length) {
    toast('Select the pages to rotate first.')
    return
  }
  try {
    await afterChange(doc, () => pagesOps(doc).rotate(indices, degrees))
  } catch (err) {
    showError(err, 'Could not rotate the pages')
  }
}

export async function deletePages(doc: DocumentModel, indices: number[]): Promise<boolean> {
  if (!indices.length) {
    toast('Select the pages to delete first.')
    return false
  }
  if (indices.length >= doc.pageCount) {
    toast("You can't delete every page — a PDF needs at least one page.", { kind: 'warning' })
    return false
  }
  const first = Math.min(...indices)
  try {
    await afterChange(doc, () => pagesOps(doc).delete(indices))
  } catch (err) {
    showError(err, 'Could not delete the pages')
    return false
  }
  if (isOrganizeOpen(doc)) {
    clearSelection(doc)
    setFocusIndex(doc, Math.min(first, doc.pageCount - 1))
  }
  toast(`Deleted ${describePages(indices)}`, { kind: 'success', action: undoAction(doc) })
  return true
}

export async function duplicatePages(doc: DocumentModel, indices: number[], at?: number) {
  if (!indices.length) {
    toast('Select the pages to duplicate first.')
    return
  }
  try {
    const created = await afterChange(doc, () => orgOps(doc).duplicate(indices, at))
    reveal(doc, created)
  } catch (err) {
    showError(err, 'Could not duplicate the pages')
  }
}

/** Moves (or with `copy`, duplicates) pages to the gap `gap` (0 = before the first page). */
export async function movePages(doc: DocumentModel, indices: number[], gap: number, copy = false) {
  if (!indices.length) return
  if (copy) {
    await duplicatePages(doc, indices, gap)
    return
  }
  const count = doc.pageCount
  if (isNoopMove(count, indices, gap)) return
  const after = movedIndices(count, indices, gap)
  try {
    await afterChange(doc, () => pagesOps(doc).move(indices, gap))
    if (isOrganizeOpen(doc)) selectIndices(doc, after, { focus: after[0], anchor: after[0] })
  } catch (err) {
    showError(err, 'Could not move the pages')
  }
}

/**
 * Copies pages (with their comments, links and form fields) to the end of another open document,
 * as one undoable step there. Used when pages are dragged onto another document's tab.
 */
export async function copyPagesToDocument(source: DocumentModel, indices: number[], target: DocumentModel) {
  if (!indices.length || target.isClosed) return
  try {
    const bytes = await orgOps(source).extract(indices)
    await afterChange(target, () =>
      orgOps(target).insertFiles(-1, [{ data: bytes, fileName: 'pages.pdf' }], { bookmarks: false })
    )
    toast(`Copied ${countLabel(indices.length)} to the end of ${target.state.title}`, {
      kind: 'success',
      action: {
        label: 'Show',
        run: () => {
          if (target.isClosed) return
          const first = Math.max(0, target.pageCount - indices.length)
          const copied = Array.from({ length: target.pageCount - first }, (_, k) => first + k)
          // The grid (or the viewer) of the target opens at its current page.
          if (useApp.getState().toolGroupId === ORGANIZE_GROUP)
            selectIndices(target, copied, { focus: first, anchor: first })
          else target.set({ currentPage: first })
          useApp.setState({ activeDocId: target.id })
        }
      }
    })
  } catch (err) {
    showError(err, `Could not copy the pages to ${target.state.title}`)
  }
}

export async function insertBlankPages(
  doc: DocumentModel,
  gap: number,
  opts: { width: number; height: number; count: number }
) {
  try {
    const before = doc.pageCount
    await afterChange(doc, () => pagesOps(doc).insertBlank(gap, opts))
    const added = doc.pageCount - before
    reveal(
      doc,
      Array.from({ length: added }, (_, k) => gap + k)
    )
    toast(`Inserted ${countLabel(added, 'blank page', 'blank pages')}`, { kind: 'success', timeout: 2500 })
  } catch (err) {
    showError(err, 'Could not insert the pages')
  }
}

export interface InsertSource {
  file: LoadedFile
  pages?: number[]
}

/** Inserts pages from files at `gap` as one undoable step. */
export async function insertFileSources(
  doc: DocumentModel,
  gap: number,
  sources: InsertSource[]
): Promise<number[] | null> {
  if (!sources.length) return null
  try {
    const created = await withProgress(
      sources.length > 1 ? `Inserting ${sources.length} files…` : `Inserting ${sources[0].file.name}…`,
      () =>
        afterChange(doc, () =>
          orgOps(doc).insertFiles(
            gap,
            sources.map((s) => ({
              data: s.file.bytes,
              fileName: s.file.engineName,
              password: s.file.password,
              pages: s.pages
            }))
          )
        )
    )
    reveal(doc, created)
    toast(`Inserted ${countLabel(created.length)}`, {
      kind: 'success',
      timeout: 2500,
      action: undoAction(doc)
    })
    return created
  } catch (err) {
    showError(err, 'Could not insert the pages')
    return null
  }
}

/** Reads files from disk (asking for passwords) and inserts all their pages at `gap`. */
export async function insertPaths(doc: DocumentModel, gap: number, paths: string[]) {
  const sources: InsertSource[] = []
  for (const path of paths) {
    let file: LoadedFile
    try {
      file = await loadFile(path)
    } catch (err) {
      showError(err, `Could not read ${path}`)
      continue
    }
    try {
      const probe = await withPassword(file.name, (pw) => orgOps(doc).probe(file.bytes, file.engineName, pw))
      if (!probe) continue
      sources.push({ file: { ...file, password: probe.password } })
    } catch (err) {
      showError(err, `Could not open ${file.name}`)
    }
  }
  return insertFileSources(doc, gap, sources)
}

export async function readClipboard(): Promise<OrganizeClipboard> {
  return invoke('feature:organize-pages:readClipboard')
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Turns copied text into a simple HTML document the engine lays out on Letter pages. */
export function textToHtml(text: string): Uint8Array {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('\n')
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
@page { margin: 72pt; }
body { font-family: sans-serif; font-size: 11pt; line-height: 1.4; }
p { margin: 0 0 9pt 0; white-space: pre-wrap; }
</style></head><body>${paragraphs}</body></html>`
  return new TextEncoder().encode(html)
}

/** Insert > From Clipboard: copied files, an image, or text become pages at `gap`. */
export async function insertFromClipboard(doc: DocumentModel, gap: number) {
  let clip: OrganizeClipboard
  try {
    clip = await readClipboard()
  } catch (err) {
    showError(err, 'Could not read the clipboard')
    return
  }
  if (clip.files.length) {
    await insertPaths(doc, gap, clip.files)
    return
  }
  const now = Date.now()
  if (clip.image && clip.image.length) {
    await insertFileSources(doc, gap, [
      {
        file: {
          name: 'Clipboard image',
          path: null,
          bytes: clip.image,
          engineName: 'clipboard.png',
          size: clip.image.length,
          modified: now
        }
      }
    ])
    return
  }
  if (clip.text.trim()) {
    const bytes = textToHtml(clip.text)
    await insertFileSources(doc, gap, [
      {
        file: {
          name: 'Clipboard text',
          path: null,
          bytes,
          engineName: 'clipboard.html',
          size: bytes.length,
          modified: now
        }
      }
    ])
    return
  }
  toast('The clipboard is empty. Copy an image, some text or a file first.', { kind: 'warning' })
}

export function describeClipboard(clip: OrganizeClipboard): string {
  if (clip.files.length)
    return clip.files.length === 1
      ? `A copied file: ${clip.files[0].split(/[\\/]/).pop()}`
      : `${clip.files.length} copied files`
  if (clip.image && clip.image.length) return 'A copied image'
  if (clip.text.trim()) return `Copied text (${clip.text.trim().length.toLocaleString()} characters)`
  return 'The clipboard is empty'
}
