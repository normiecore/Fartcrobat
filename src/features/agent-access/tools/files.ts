// Agent tools: open_document, save_document, export_document, close_document, extract_pages, combine_files.
import type { AgentToolName } from '@shared/agent/tools'
import {
  EngineClient,
  basename,
  closeDocument,
  invoke,
  linkDocumentFiles,
  linkSavedPassword,
  openPaths,
  platform,
  stripExtension,
  toast,
  unlockAuditSummary,
  useApp,
  writeFile,
  type DocUnlock,
  type DocumentModel
} from '@renderer/sdk'
import type docOps from '@engine/ops/doc'
import type exportOps from '@features/export-create/engine'
import { ExportCancelled, runExport, type ExportEngine } from '@features/export-create/exporter'
import { DEFAULT_EXPORT_OPTIONS, FORMAT_INFO, type ExportFormat, type ExportOptions } from '@features/export-create/shared'
import { openAsNewDocument, openExtractedPages } from '@features/organize-pages/actions'
import { binderName } from '@features/organize-pages/CombineDialog'
import type organizeOps from '@features/organize-pages/engine'
import type { SourceRef } from '@features/organize-pages/engine'
import { loadFile, orgOps, withPassword } from '@features/organize-pages/files'
import {
  ToolError,
  auditName,
  describeDoc,
  parsePages,
  resolveDoc,
  runAsAgent,
  throwIfAborted,
  type ToolContext,
  type ToolHandler
} from './common'
import { optBoolean, optInteger, plural } from './act-common'
import {
  exportPath,
  imageExportPaths,
  imageFormatFor,
  openErrorCode,
  pathArg,
  pdfPath,
  samePath,
  unsupportedMessage
} from './act-files'
import {
  cancelled,
  checked,
  commitTyping,
  engineTask,
  paragraphs,
  requireConfirmation,
  toolErrorFrom,
  handoff,
  withAttention
} from './act-runtime'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A file that could not be read or opened, as the agent sees it. */
function openFailure(path: string, err: unknown): ToolError {
  const message = messageOf(err)
  if (openErrorCode(message) === 'unsupported') return new ToolError('unsupported', unsupportedMessage(basename(path), message))
  return new ToolError('file_error', `Could not open ${path}: ${message.replace(/^This file could not be opened: /, '')}`)
}

async function exists(path: string): Promise<boolean> {
  try {
    return await invoke('file:exists', path)
  } catch {
    return false
  }
}

async function write(path: string, bytes: Uint8Array) {
  try {
    await writeFile(path, bytes)
  } catch (err) {
    throw new ToolError('file_error', `Could not write ${path}: ${messageOf(err)}`)
  }
}

/** Asks before replacing files that exist (Decline is the default). */
async function confirmReplace(ctx: ToolContext, doc: DocumentModel | null, paths: string[], what: string) {
  const existing: string[] = []
  for (const p of paths) if (await exists(p)) existing.push(p)
  if (!existing.length) return
  await requireConfirmation(
    ctx,
    doc,
    {
      title: existing.length === 1 ? 'Replace file?' : 'Replace files?',
      message: paragraphs(
        existing.length === 1
          ? `${what} would replace “${basename(existing[0])}”, which already exists. The file now there will be lost.`
          : `${what} would replace ${existing.length} files that already exist. The files now there will be lost.`
      ),
      confirmLabel: 'Replace',
      details: existing.slice(0, 8).concat(existing.length > 8 ? [`and ${existing.length - 8} more`] : [])
    },
    existing.length === 1 ? `replace ${existing[0]}` : `replace ${existing.length} files`
  )
}

/** Shows a page once the tab's viewer is up (it may restore the last viewed page first). */
async function showPage(doc: DocumentModel, index: number) {
  doc.set({ currentPage: index })
  for (let i = 0; i < 40 && !doc.view && !doc.isClosed; i++) await new Promise((r) => setTimeout(r, 50))
  doc.view?.goToPage(index)
}

// ---- open ------------------------------------------------------------------------------------

const openDocument: ToolHandler = async (args, ctx) => {
  const path = checked(() => pathArg(args.path))
  const page = checked(() => optInteger(args.page, 'page', 1, Number.MAX_SAFE_INTEGER))
  let doc = useApp.getState().docs.find((d) => !d.isClosed && samePath(d.state.filePath, path, platform)) ?? null
  const alreadyOpen = !!doc
  if (doc) useApp.setState({ activeDocId: doc.id })
  else {
    if (!(await exists(path))) throw new ToolError('file_error', `There is no file at ${path}`)
    let failure: unknown = null
    const [opened] = await handoff(ctx, () => openPaths([path], { onError: (_p, err) => (failure = err) }))
    if (failure !== null) throw openFailure(path, failure)
    if (!opened) throw cancelled(ctx, null, `did not open ${path}`, `${basename(path)} was not opened: the person cancelled its password prompt.`)
    doc = opened
  }
  let shown = doc.state.currentPage
  let note: string | undefined
  if (page !== undefined) {
    shown = Math.min(page, doc.pageCount) - 1
    if (page > doc.pageCount) note = `The document has only ${plural(doc.pageCount, 'page')}; showing the last one.`
    await showPage(doc, shown)
  }
  // How a protected file was unlocked, never with the password.
  ctx.audit({ document: auditName(doc), summary: alreadyOpen ? 'already open' : (unlockAuditSummary(doc.state.unlock) ?? 'opened') })
  return { data: { ...describeDoc(ctx, doc), alreadyOpen, page: shown + 1, ...(note ? { note } : {}) } }
}

// ---- save ------------------------------------------------------------------------------------

/** The app's Save, without its dialogs: signed documents are saved incrementally, encryption is kept. */
async function writeDocument(doc: DocumentModel, path: string): Promise<number> {
  const { bytes, version } = await engineTask('Could not save', () => doc.busyWhile('Saving…', () => doc.core.doc.saveWithVersion({})))
  await write(path, bytes)
  // Edits made while the file was written are not in it: the engine keeps those unsaved.
  await doc.core.doc.markSaved(basename(path), version)
  doc.set({ filePath: path, title: basename(path) })
  void linkDocumentFiles(doc, [path])
  try {
    const recent = await invoke('recent:add', { path, name: basename(path), size: bytes.length, pageCount: doc.pageCount })
    useApp.setState({ recent })
  } catch {}
  toast(`Saved ${basename(path)}`, { kind: 'success', timeout: 2000 })
  return bytes.length
}

const saveDocumentTool: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const target = args.path === undefined ? null : checked(() => pdfPath(pathArg(args.path)))
  const current = doc.state.filePath
  await commitTyping()
  let path: string
  if (!target || samePath(target, current, platform)) {
    if (!current) throw new ToolError('invalid_args', `“${doc.state.title}” has never been saved: give path (an absolute path ending in .pdf).`)
    path = current
    await requireConfirmation(
      ctx,
      doc,
      {
        title: 'Save over the file?',
        message: paragraphs(`Save the changes to “${doc.state.title}” over its file? The file as it is now will be replaced.`),
        confirmLabel: 'Save',
        details: [current]
      },
      `save over ${current}`
    )
  } else {
    path = target
    await confirmReplace(ctx, doc, [target], `Saving “${doc.state.title}”`)
  }
  const size = await writeDocument(doc, path)
  const info = doc.state.info
  ctx.audit({ document: path, summary: `saved to ${path}` })
  return {
    data: {
      ...describeDoc(ctx, doc),
      saved: path,
      bytes: size,
      encrypted: !!info.encryption,
      signatures: info.signatureCount,
      unsavedChanges: doc.state.dirty
    }
  }
}

// ---- export ----------------------------------------------------------------------------------

const FORMATS: ExportFormat[] = ['word', 'excel', 'powerpoint', 'image', 'html', 'text']

const exportDocument: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  const format = args.format as ExportFormat
  if (!FORMATS.includes(format)) throw new ToolError('invalid_args', `format must be one of ${FORMATS.join(', ')}`)
  const raw = checked(() => pathArg(args.path))
  const pages = parsePages(args.pages, doc.pageCount)
  const imageFormat = checked(() => imageFormatFor(raw, args.image_format))
  const dpi = checked(() => optInteger(args.dpi, 'dpi', 36, 600)) ?? DEFAULT_EXPORT_OPTIONS.image.dpi
  if (!doc.state.info.permissions.copy)
    throw new ToolError(
      'failed',
      `The security settings of “${doc.state.title}” don't allow copying or exporting its content. If the person knows its permissions password, remove_security can lift that.`
    )
  const options: ExportOptions = {
    ...DEFAULT_EXPORT_OPTIONS,
    format,
    image: { ...DEFAULT_EXPORT_OPTIONS.image, format: imageFormat, dpi }
  }
  const singleFile = format !== 'image' || imageFormat === 'tiff'
  const target = exportPath(raw, format, imageFormat)
  const targets = singleFile ? [target] : imageExportPaths(raw, pages, imageFormat as 'png' | 'jpeg')
  await confirmReplace(ctx, doc, targets, `Exporting “${doc.state.title}”`)
  const engine: ExportEngine = doc.ops<typeof exportOps>('export-create')
  let result
  try {
    result = await doc.busyWhile(`Exporting to ${FORMAT_INFO[format].short}…`, () =>
      runExport(engine, {
        options,
        pages,
        title: doc.state.info.metadata.title || stripExtension(doc.state.title),
        baseName: stripExtension(basename(target)),
        lang: doc.state.info.language,
        eol: navigator.userAgent.includes('Windows') ? '\r\n' : '\n',
        onProgress: (fraction, message) => ctx.progress(Math.round(Math.max(0, Math.min(1, fraction)) * 100), 100, message),
        isCancelled: () => ctx.signal.aborted
      })
    )
  } catch (err) {
    if (err instanceof ExportCancelled || ctx.signal.aborted) throw new ToolError('aborted', 'The export was cancelled. Nothing was written.')
    throw toolErrorFrom(err, 'Could not export')
  }
  if (result.kind === 'images') {
    for (let k = 0; k < result.files.length; k++) {
      throwIfAborted(ctx)
      await write(targets[k], result.files[k].data)
    }
  } else await write(target, result.data)
  ctx.audit({
    document: auditName(doc),
    summary: targets.length === 1 ? `exported to ${targets[0]}` : `exported ${targets.length} images to ${targets[0]} and others`
  })
  return { data: { format, files: targets, pages: pages.length } }
}

// ---- close -----------------------------------------------------------------------------------

const closeDocumentTool: ToolHandler = async (args, ctx) => {
  if (args.handle === undefined || args.handle === null || args.handle === '')
    throw new ToolError('invalid_args', 'handle is required: the document to close (from list_documents)')
  const doc = resolveDoc(ctx, args.handle)
  const discard = checked(() => optBoolean(args.discard_changes, 'discard_changes')) ?? false
  const handle = describeDoc(ctx, doc).handle
  const name = auditName(doc)
  await commitTyping()
  const dirty = doc.state.dirty
  if (dirty) {
    if (!discard)
      throw new ToolError(
        'invalid_args',
        `“${doc.state.title}” has unsaved changes. Save them with save_document, or pass discard_changes: true to close without saving (the person confirms).`
      )
    await requireConfirmation(
      ctx,
      doc,
      {
        title: 'Close without saving?',
        message: paragraphs(`Close “${doc.state.title}” without saving? The changes made since it was last saved will be lost.`),
        confirmLabel: 'Close Without Saving'
      },
      'close without saving'
    )
  }
  const closed = await closeDocument(doc, { discardChanges: dirty && discard })
  if (!closed) throw cancelled(ctx, doc, 'kept open', `“${doc.state.title}” was not closed: the person chose to keep it open.`)
  ctx.audit({ document: name, summary: dirty ? 'closed without saving' : 'closed' })
  return { data: { closed: handle, discardedChanges: dirty } }
}

// ---- extract ---------------------------------------------------------------------------------

const extractPages: ToolHandler = async (args, ctx) => {
  const doc = resolveDoc(ctx, args.handle)
  if (args.pages === undefined || args.pages === null || args.pages === '')
    throw new ToolError('invalid_args', 'pages is required: the pages to extract, e.g. "3-5"')
  const pages = parsePages(args.pages, doc.pageCount)
  const target = args.path === undefined ? null : checked(() => pdfPath(pathArg(args.path)))
  if (target && samePath(target, doc.state.filePath, platform))
    throw new ToolError('invalid_args', 'path is the document\'s own file: choose another file for the extracted pages')
  if (target) await confirmReplace(ctx, doc, [target], 'Extracting the pages')
  const bytes = await engineTask('Could not extract the pages', () => runAsAgent(doc, () => orgOps(doc).extract(pages)))
  const what = plural(pages.length, 'page')
  if (target) {
    await write(target, bytes)
    await linkDocumentFiles(doc, [target])
    ctx.audit({ document: auditName(doc), summary: `extracted ${what} to ${target}` })
    return { data: { path: target, pageCount: pages.length } }
  }
  // A protected source gives protected pages: the new tab opens with the source's password.
  const opened = await withAttention(() => openExtractedPages(doc, bytes, `Pages from ${stripExtension(doc.state.title)}.pdf`))
  if (!opened) throw new ToolError('failed', 'The extracted pages could not be opened in a new tab (the password prompt was cancelled, or Fartcrobat showed the person why).')
  ctx.audit({ document: auditName(doc), summary: `extracted ${what} to a new tab` })
  return { data: { ...describeDoc(ctx, opened), source: describeDoc(ctx, doc).handle } }
}

// ---- combine ---------------------------------------------------------------------------------

const combineFiles: ToolHandler = async (args, ctx) => {
  if (!Array.isArray(args.paths) || args.paths.length < 2) throw new ToolError('invalid_args', 'paths must list at least two files to combine')
  const paths = checked(() => (args.paths as unknown[]).map((p, i) => pathArg(p, `paths[${i}]`)))
  const target = args.path === undefined ? null : checked(() => pdfPath(pathArg(args.path)))
  for (const p of paths) if (!(await exists(p))) throw new ToolError('file_error', `There is no file at ${p}`)
  if (target) await confirmReplace(ctx, null, [target], 'Combining the files')
  const engine = new EngineClient()
  try {
    await engine.ready()
    const ops = engine.ops<typeof organizeOps>('organize-pages', {
      onProgress: (fraction, message) => ctx.progress(paths.length + Math.round(fraction * 100), paths.length + 100, message)
    })
    const sources: SourceRef[] = []
    const unlocks: (DocUnlock | undefined)[] = []
    for (let i = 0; i < paths.length; i++) {
      throwIfAborted(ctx)
      const path = paths[i]
      ctx.progress(i, paths.length + 100, `Reading ${basename(path)}`)
      const file = await loadFile(path).catch((err) => {
        throw openFailure(path, err)
      })
      let probe
      try {
        probe = await handoff(ctx, () => withPassword(file, (pw) => ops.probe(file.bytes, file.engineName, pw)))
      } catch (err) {
        if (err instanceof ToolError) throw err
        throw openFailure(path, err)
      }
      if (!probe) throw cancelled(ctx, null, `password prompt for ${path} cancelled`, `Nothing was combined: the person cancelled the password prompt for ${file.name}.`)
      sources.push({ data: file.bytes, fileName: file.engineName, password: probe.password, title: stripExtension(file.name) })
      unlocks.push(probe.unlock)
    }
    const { bytes, protection } = await engineTask('Could not combine the files', () =>
      ops.combineWithProtection(sources, { bookmarks: true, keepBookmarks: true })
    )
    throwIfAborted(ctx)
    const derivedFrom = protection ? unlocks[protection.index] : undefined
    // Like open_document, the audit line says how each protected source was unlocked.
    const unlocked = paths.flatMap((p, i) => {
      const how = unlockAuditSummary(unlocks[i])
      return how ? [`${p}: ${how}`] : []
    })
    const how = unlocked.length ? ` (${unlocked.join('; ')})` : ''
    if (target) {
      await write(target, bytes)
      if (derivedFrom?.savedRef) {
        const checked = await engine.ops<typeof docOps>('doc').checkFile(bytes, 'combined.pdf').catch(() => null)
        if (checked?.needsPassword) await linkSavedPassword(derivedFrom, checked.lock, [target])
      }
      ctx.audit({ document: target, summary: `combined ${paths.length} files to ${target}${how}` })
      return { data: { path: target, files: paths.length, protectedLike: protection?.fileName ?? null } }
    }
    const name = binderName(useApp.getState().docs.map((d) => d.state.title))
    // When a file was protected, the result has its protection and opens with its password.
    const password = protection ? sources[protection.index]?.password : undefined
    const opened = await withAttention(() => openAsNewDocument(bytes, name, { password, derivedFrom }))
    if (!opened) throw new ToolError('failed', 'The combined file could not be opened in a new tab (Fartcrobat showed the person why).')
    ctx.audit({ document: auditName(opened), summary: `combined ${paths.length} files into a new tab${how}` })
    return { data: { ...describeDoc(ctx, opened), files: paths.length, protectedLike: protection?.fileName ?? null } }
  } finally {
    engine.terminate()
  }
}

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {
  open_document: openDocument,
  save_document: saveDocumentTool,
  export_document: exportDocument,
  close_document: closeDocumentTool,
  extract_pages: extractPages,
  combine_files: combineFiles
}
