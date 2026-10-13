import { normalizePath, pathKey as platformPathKey } from '@shared/paths'
import type { DocInfo, OpenResult, Preferences, SaveOptions } from '@shared/types'
import { DocumentModel } from '../document/DocumentModel'
import { EngineClient } from '../engine/EngineClient'
import { basename, invoke, OPEN_FILTERS, PDF_FILTER, platform, readFile, stripExtension, writeFile } from '../platform'
import { ask, confirm, prompt } from '../ui/dialogs'
import { commitActiveEditors, hasActiveEditors } from './commands'
import { registry } from './registry'
import { getActiveDoc, useApp } from './store'
import { showError, toast, withProgress } from './ui-services'

// ---- preferences --------------------------------------------------------------------------

export async function setPrefs(patch: Partial<Preferences>) {
  useApp.setState((s) => ({ prefs: { ...s.prefs, ...patch } }))
  try {
    const prefs = await invoke('prefs:set', patch)
    useApp.setState({ prefs })
  } catch (err) {
    showError(err, 'Could not save preferences')
  }
}

export async function refreshRecent() {
  try {
    useApp.setState({ recent: await invoke('recent:list') })
  } catch {}
}

// ---- opening --------------------------------------------------------------------------------

interface ViewMemory {
  page: number
  zoom: number
  zoomMode: DocumentModel['state']['zoomMode']
}

function extensionOf(name: string) {
  return (/\.([^.]+)$/.exec(name)?.[1] ?? '').toLowerCase()
}

function askPassword(name: string, wrong: boolean | undefined): Promise<string | null> {
  return prompt({
    title: 'Password required',
    message: wrong
      ? `The password for “${name}” is incorrect. Try again.`
      : `“${name}” is protected. Enter the document open password.`,
    label: 'Password',
    password: true,
    okLabel: 'Open'
  })
}

/**
 * Opens bytes as a new tab. Prompts for a password when needed. `filePath` is null for documents
 * that do not exist on disk yet (created, combined, converted); pass `dirty` for those so the
 * tab asks to be saved: the engine then reports them unsaved until they are. A file that cannot
 * be opened is reported with `onError` when given (agent access), else shown to the user.
 */
export async function openBytes(
  bytes: Uint8Array,
  name: string,
  opts: { filePath?: string | null; dirty?: boolean; activate?: boolean; onError?: (err: unknown) => void } = {}
): Promise<DocumentModel | null> {
  const engine = new EngineClient()
  try {
    await engine.ready()
    const doc = engine.ops<typeof import('@engine/ops/doc').default>('doc')
    let res: OpenResult = await doc.open(bytes, { fileName: name, dirty: opts.dirty })
    while (!res.ok) {
      const pw = await askPassword(name, res.wrongPassword)
      if (pw === null) {
        engine.terminate()
        return null
      }
      res = await doc.authenticate(pw, { dirty: opts.dirty })
    }
    return addDocument(engine, res.info, name, opts)
  } catch (err) {
    engine.terminate()
    if (opts.onError) opts.onError(err)
    else showError(err, `Could not open ${name}`)
    return null
  }
}

function addDocument(
  engine: EngineClient,
  info: DocInfo,
  name: string,
  opts: { filePath?: string | null; dirty?: boolean; activate?: boolean }
): DocumentModel {
  const prefs = useApp.getState().prefs
  const converted = info.converted
  const title = converted ? stripExtension(name) + '.pdf' : name
  const filePath = converted ? null : (opts.filePath ?? null)
  const doc = new DocumentModel(engine, info, {
    title,
    filePath,
    zoomMode: typeof prefs.defaultZoom === 'string' ? prefs.defaultZoom : 'custom',
    layout: prefs.defaultLayout,
    dirty: opts.dirty || converted
  })
  if (typeof prefs.defaultZoom === 'number') doc.set({ zoom: prefs.defaultZoom, zoomMode: 'custom' })
  if (filePath && prefs.restoreLastView) {
    void invoke('store:get', `view:${filePath}`).then((v) => {
      const mem = v as ViewMemory | undefined
      if (mem && mem.page < info.pageCount) {
        doc.set({ zoom: mem.zoom, zoomMode: mem.zoomMode, currentPage: mem.page })
        doc.view?.goToPage(mem.page)
      }
    })
  }
  useApp.setState((s) => ({
    docs: [...s.docs, doc],
    activeDocId: opts.activate === false ? s.activeDocId : doc.id
  }))
  for (const hook of registry.documentOpenHooks) {
    try {
      hook(doc)
    } catch (err) {
      console.error('onDocumentOpen hook failed', err)
    }
  }
  return doc
}

const pathKey = (path: string) => platformPathKey(path, platform)

/** Opens of files still in progress, by pathKey: a second request for the same file waits for the first. */
const opening = new Map<string, Promise<DocumentModel | null>>()

async function openPath(path: string, onError?: (err: unknown) => void): Promise<DocumentModel | null> {
  const name = basename(path)
  try {
    let bytes: Uint8Array | null = null
    const ext = extensionOf(name)
    const converter = registry.fileConverters.find((c) => c.extensions.includes(ext))
    if (converter) {
      bytes = await withProgress(`Converting ${name} to PDF…`, () => converter.convert(path)).catch((err) => {
        console.warn('Converter failed, falling back to built-in import', err)
        return null
      })
      if (bytes) return await openBytes(bytes, stripExtension(name) + '.pdf', { filePath: null, dirty: true, onError })
    }
    bytes = await readFile(path)
    const doc = await openBytes(bytes, name, { filePath: path, onError })
    if (doc && doc.state.filePath) {
      const recent = await invoke('recent:add', { path, name, size: bytes.length, pageCount: doc.pageCount })
      useApp.setState({ recent: recent })
    }
    return doc
  } catch (err) {
    if (onError) onError(err)
    else showError(err, `Could not open ${name}`)
    void invoke('recent:remove', path).then((recent) => useApp.setState({ recent }))
    return null
  }
}

/**
 * Opens files from disk (dialog, drag and drop, command line, recent list). Resolves with the tab
 * of each path (null when it was not opened). Files that cannot be opened are reported with
 * `opts.onError` when given (agent access), else shown to the user.
 */
export async function openPaths(
  paths: string[],
  opts: { onError?: (path: string, err: unknown) => void } = {}
): Promise<(DocumentModel | null)[]> {
  const out: (DocumentModel | null)[] = []
  for (const raw of paths) {
    const path = normalizePath(raw)
    const key = pathKey(path)
    const existing = useApp.getState().docs.find((d) => d.state.filePath && pathKey(d.state.filePath) === key)
    if (existing) {
      useApp.setState({ activeDocId: existing.id })
      out.push(existing)
      continue
    }
    // Already being opened (a double-click on a recent file, a second launch...): show that tab.
    const pending = opening.get(key)
    if (pending) {
      const doc = await pending
      const open = !!doc && useApp.getState().docs.includes(doc)
      if (open) useApp.setState({ activeDocId: doc.id })
      out.push(open ? doc : null)
      continue
    }
    const onError = opts.onError
    const task = openPath(path, onError ? (err) => onError(path, err) : undefined)
    opening.set(key, task)
    try {
      out.push(await task)
    } finally {
      opening.delete(key)
    }
  }
  return out
}

export async function openFileDialog() {
  const paths = await invoke('file:openDialog', { title: 'Open', filters: OPEN_FILTERS, multiple: true })
  if (paths.length) await openPaths(paths)
}

/** Creates a new untitled tab from PDF bytes produced by a tool (combine, create, convert...). */
export async function openNewDocument(bytes: Uint8Array, name: string): Promise<DocumentModel | null> {
  return openBytes(bytes, name.toLowerCase().endsWith('.pdf') ? name : name + '.pdf', { filePath: null, dirty: true })
}

// ---- saving ---------------------------------------------------------------------------------

/** Saves a document. Asks for a location when it has none (or when saveAs is set). */
export async function saveDocument(
  doc: DocumentModel,
  opts: { saveAs?: boolean; saveOptions?: SaveOptions } = {}
): Promise<boolean> {
  if (hasActiveEditors()) await commitActiveEditors()
  let path = doc.state.filePath
  if (!path || opts.saveAs) {
    const suggested = path ?? doc.state.title
    const chosen = await invoke('file:saveDialog', {
      title: opts.saveAs ? 'Save As' : 'Save',
      defaultPath: suggested.toLowerCase().endsWith('.pdf') ? suggested : stripExtension(suggested) + '.pdf',
      filters: [PDF_FILTER]
    })
    if (!chosen) return false
    path = chosen.toLowerCase().endsWith('.pdf') ? chosen : chosen + '.pdf'
    // The save dialog only checked the name that was typed; ask before replacing another file.
    if (path !== chosen && path !== doc.state.filePath && (await invoke('file:exists', path))) {
      const replace = await confirm({
        title: 'Replace file?',
        message: `“${basename(path)}” already exists. Do you want to replace it?`,
        confirmLabel: 'Replace',
        danger: true
      })
      if (!replace) return false
    }
  }
  try {
    const { bytes, version } = await doc.busyWhile('Saving…', () => doc.core.doc.saveWithVersion(opts.saveOptions ?? {}))
    await writeFile(path, bytes)
    // Edits made while the file was being written are not in it: the engine keeps those unsaved
    // and reports the dirty state with this call, so it is not set here.
    await doc.core.doc.markSaved(basename(path), version)
    doc.set({ filePath: path, title: basename(path) })
    const recent = await invoke('recent:add', { path, name: basename(path), size: bytes.length, pageCount: doc.pageCount })
    useApp.setState({ recent })
    toast(`Saved ${basename(path)}`, { kind: 'success', timeout: 2000 })
    return true
  } catch (err) {
    showError(err, 'Could not save')
    return false
  }
}

/**
 * Replaces the document content with new bytes (e.g. after signing or optimising), writes them to
 * disk at `path` and reloads the tab from that file. With `path` null the new content is only in
 * memory and the tab stays unsaved. The password the document was opened with is reused; when
 * the new bytes need another one, pass it as `opts.password` or the user is asked for it.
 */
export async function replaceDocumentBytes(
  doc: DocumentModel,
  bytes: Uint8Array,
  path: string | null,
  opts: { password?: string } = {}
) {
  if (path) await writeFile(path, bytes)
  let res = await doc.core.doc.reload(bytes, { password: opts.password, dirty: !path })
  while (!res.ok) {
    const pw = await askPassword(doc.state.title, res.wrongPassword)
    if (pw === null) throw new Error('The new document requires a password')
    res = await doc.core.doc.reload(bytes, { password: pw, dirty: !path })
  }
  doc.set({
    info: res.info,
    filePath: path ?? doc.state.filePath,
    title: path ? basename(path) : doc.state.title,
    dirty: !path,
    selection: { kind: 'none' }
  })
  if (path) await doc.core.doc.markSaved(basename(path))
}

/**
 * File > Revert: reloads the document from its file in the same tab, discarding unsaved
 * changes and the undo history. The tab keeps its place, page and zoom. When the file cannot
 * be read the tab stays as it was and the user is told why. Returns true when reverted.
 */
export async function revertDocument(doc: DocumentModel): Promise<boolean> {
  const path = doc.state.filePath
  if (!path) return false
  const page = doc.state.currentPage
  try {
    const bytes = await doc.busyWhile('Reverting…', () => readFile(path))
    let res = await doc.core.doc.reload(bytes, {})
    while (!res.ok) {
      const pw = await askPassword(doc.state.title, res.wrongPassword)
      if (pw === null) return false
      res = await doc.core.doc.reload(bytes, { password: pw })
    }
    await doc.core.doc.markSaved(basename(path))
    doc.set({ info: res.info, selection: { kind: 'none' } })
    const target = Math.min(page, res.info.pageCount - 1)
    if (doc.state.currentPage !== target) doc.view?.goToPage(target)
    return true
  } catch (err) {
    showError(err, `Could not revert ${doc.state.title}`)
    return false
  }
}

// ---- closing --------------------------------------------------------------------------------

async function rememberView(doc: DocumentModel) {
  const s = doc.state
  if (!s.filePath) return
  const mem: ViewMemory = { page: s.currentPage, zoom: s.zoom, zoomMode: s.zoomMode }
  try {
    await invoke('store:set', `view:${s.filePath}`, mem)
  } catch {}
}

/**
 * Asks whether to save a document with unsaved changes, and saves it if asked to. Returns false
 * when the user cancelled (or the save did not happen); true when the document may be closed.
 */
async function settleUnsaved(doc: DocumentModel): Promise<boolean> {
  if (!doc.state.dirty) return true
  useApp.setState({ activeDocId: doc.id })
  const answer = await ask({
    title: 'Save changes?',
    message: `Do you want to save changes to “${doc.state.title}” before closing?`,
    buttons: [
      { id: 'discard', label: "Don't Save", variant: 'quiet' },
      { id: 'cancel', label: 'Cancel' },
      { id: 'save', label: 'Save', variant: 'primary' }
    ]
  })
  if (answer === null || answer === 'cancel') return false
  if (answer === 'save' && !(await saveDocument(doc))) return false
  return true
}

/**
 * Closes a tab, asking to save unsaved changes. Returns false if the user cancelled.
 * `discardChanges` closes without asking (agent access, after the person agreed).
 */
export async function closeDocument(doc: DocumentModel, opts: { discardChanges?: boolean } = {}): Promise<boolean> {
  if (hasActiveEditors()) await commitActiveEditors()
  if (!opts.discardChanges && !(await settleUnsaved(doc))) return false
  await removeDocument(doc)
  return true
}

/** Closes a tab without asking. */
async function removeDocument(doc: DocumentModel) {
  if (!useApp.getState().docs.includes(doc)) return
  await rememberView(doc)
  useApp.setState((s) => {
    const idx = s.docs.findIndex((d) => d.id === doc.id)
    const docs = s.docs.filter((d) => d.id !== doc.id)
    let activeDocId = s.activeDocId
    if (activeDocId === doc.id) activeDocId = docs[Math.min(idx, docs.length - 1)]?.id ?? null
    return { docs, activeDocId }
  })
  doc.close()
}

let closingAll: Promise<boolean> | null = null

/**
 * Closes every tab. Unsaved documents are asked about first, one by one; nothing is closed when
 * the user cancels any of them. Returns false if the user cancelled. Calls made while one is
 * running share its result instead of asking again.
 */
export function closeAllDocuments(): Promise<boolean> {
  closingAll ??= (async () => {
    try {
      const docs = [...useApp.getState().docs]
      const discarded = new Set<DocumentModel>()
      for (const doc of docs) {
        if (!doc.state.dirty) continue
        if (!(await settleUnsaved(doc))) return false
        if (doc.state.dirty) discarded.add(doc)
      }
      for (const doc of docs) {
        // A document changed again while the others were being asked about.
        if (doc.state.dirty && !discarded.has(doc) && !(await settleUnsaved(doc))) return false
        await removeDocument(doc)
      }
      return true
    } finally {
      closingAll = null
    }
  })()
  return closingAll
}

/**
 * Quits the app (File > Exit, Cmd+Q). The main process asks every window, one at a time, about
 * its unsaved documents (see answerCloseRequest) and quits once all of them agreed.
 */
export async function quitApp() {
  await invoke('app:quit')
}

let closeRequest: Promise<void> | null = null

/**
 * Answers the main process asking whether this window may close (closing the window, quitting).
 * Unsaved documents are asked about first, one by one; only when none was cancelled are the
 * tabs closed, so cancelling leaves every tab open. Repeated requests while the questions are
 * on screen share the same answer instead of stacking dialogs.
 */
export function answerCloseRequest(): Promise<void> {
  if (closeRequest) return closeRequest
  closeRequest = (async () => {
    let ok = true
    try {
      if (hasActiveEditors()) await commitActiveEditors()
      // Every unsaved tab, in tab order (also tabs opened while the questions were showing).
      const settled = new Set<DocumentModel>()
      for (;;) {
        const next = useApp.getState().docs.find((d) => d.state.dirty && !settled.has(d))
        if (!next) break
        if (!(await settleUnsaved(next))) {
          ok = false
          break
        }
        settled.add(next)
      }
      if (ok) for (const doc of [...useApp.getState().docs]) await removeDocument(doc)
    } catch (err) {
      ok = false
      showError(err, 'Could not close the window')
    }
    try {
      await invoke(ok ? 'app:quitConfirmed' : 'app:quitCancelled')
    } catch (err) {
      showError(err)
    }
  })().finally(() => {
    closeRequest = null
  })
  return closeRequest
}

// ---- UI state -------------------------------------------------------------------------------

export function activateDocument(id: string | null) {
  useApp.setState({ activeDocId: id })
}

export function setTool(id: string) {
  const prev = registry.tools.get(useApp.getState().toolId)
  const next = registry.tools.get(id)
  if (!next) {
    console.warn(`Unknown tool ${id}`)
    return
  }
  const ctx = { doc: getActiveDoc() }
  if (prev && prev.id !== id) prev.onDeactivate?.(ctx)
  useApp.setState({ toolId: id })
  if (!prev || prev.id !== id) next.onActivate?.(ctx)
}

export function openToolGroup(id: string | null) {
  if (id === null) {
    useApp.setState({ toolGroupId: null, leftPaneOpen: true })
    setTool('select')
    return
  }
  const group = registry.toolGroups.find((g) => g.id === id)
  if (!group) return
  const doc = getActiveDoc()
  if (group.requiresDocument !== false && !doc) {
    toast('Open a PDF first to use this tool.')
    // Open the tool on the file the user picks, as Acrobat does.
    void openFileDialog()
      .then(() => {
        if (getActiveDoc()) openToolGroup(id)
      })
      .catch((err) => showError(err, 'Could not open the file'))
    return
  }
  if (group.run && !group.panel) {
    void Promise.resolve(group.run({ doc })).catch((err) => showError(err))
    return
  }
  useApp.setState({ toolGroupId: id, leftPaneOpen: true, readMode: false })
  if (group.defaultTool) setTool(group.defaultTool)
}

export function toggleRightPanel(id: string) {
  useApp.setState((s) => ({ rightPanelId: s.rightPanelId === id ? null : id, readMode: false }))
}

export function openRightPanel(id: string) {
  useApp.setState({ rightPanelId: id, readMode: false })
}
