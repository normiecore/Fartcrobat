/**
 * Export a PDF: asks where to save, runs the export with a progress window (Cancel works between
 * pages), writes the file(s) and offers to open the result.
 */
import {
  ask,
  basename,
  dirname,
  invoke,
  isMac,
  joinPath,
  registry,
  runCommand,
  showError,
  stripExtension,
  toast,
  withProgress,
  writeFile,
  type DocumentModel
} from '@renderer/sdk'
import type exportOps from './engine'
import { ExportCancelled, runExport, type ExportEngine } from './exporter'
import { getState, loadSettings, setState, type PageScope } from './state'
import { FORMAT_INFO, IMAGE_EXT, parsePageRange, type ExportFormat, type ExportOptions } from './shared'

/** Pages to export for a scope, or an error message. */
export function scopePages(doc: DocumentModel, scope: PageScope, range: string): number[] | string {
  const n = doc.pageCount
  if (scope === 'current') return [Math.min(n - 1, doc.state.currentPage)]
  if (scope === 'range') return parsePageRange(range, n)
  return Array.from({ length: n }, (_, i) => i)
}

/** Name of the PDF without its extension ("Report.pdf" -> "Report"). */
export function baseNameOf(doc: DocumentModel): string {
  const name = stripExtension(basename(doc.state.filePath ?? doc.state.title)) || 'Document'
  // Characters most file systems refuse.
  return name.replace(/[\\/:*?"<>|]+/g, '_')
}

function defaultFolder(doc: DocumentModel): string | null {
  return doc.state.filePath ? dirname(doc.state.filePath) : null
}

async function explainRestricted(doc: DocumentModel) {
  const canRemove = registry.commands.has('protect.removeSecurity')
  const answer = await ask({
    title: 'Exporting isn’t allowed',
    message: (
      <>
        <p>The author of “{doc.state.title}” has restricted this document so that its content can’t be copied or exported.</p>
        <p>{canRemove ? 'If you know its permissions password, you can remove the security and then export it.' : 'Ask the author for a copy that allows copying.'}</p>
      </>
    ),
    buttons: canRemove
      ? [
          { id: 'ok', label: 'OK' },
          { id: 'remove', label: 'Remove Security…', variant: 'primary' }
        ]
      : [{ id: 'ok', label: 'OK', variant: 'primary' }]
  })
  if (answer === 'remove') await runCommand('protect.removeSecurity')
}

/** Asks for the destination: a file for most formats, a folder for one image per page. */
async function chooseDestination(doc: DocumentModel, format: ExportFormat, options: ExportOptions): Promise<string | null> {
  const base = baseNameOf(doc)
  const folder = defaultFolder(doc)
  if (format === 'image' && options.image.format !== 'tiff') {
    const picked = await invoke('file:openDialog', {
      title: 'Choose a folder for the images',
      directory: true,
      ...(folder ? { defaultPath: folder } : {})
    })
    return picked[0] ?? null
  }
  const ext = format === 'image' ? IMAGE_EXT.tiff : FORMAT_INFO[format].ext
  const name = `${base}.${ext}`
  const chosen = await invoke('file:saveDialog', {
    title: `Export to ${FORMAT_INFO[format].label}`,
    defaultPath: folder ? joinPath(folder, name) : name,
    filters: [{ name: format === 'image' ? 'TIFF Image' : FORMAT_INFO[format].filterName, extensions: format === 'image' ? ['tif', 'tiff'] : [ext] }]
  })
  if (!chosen) return null
  return /\.[a-z0-9]{2,5}$/i.test(basename(chosen)) ? chosen : `${chosen}.${ext}`
}

async function confirmOverwrite(paths: string[]): Promise<boolean> {
  const existing: string[] = []
  for (const p of paths) if (await invoke('file:exists', p)) existing.push(p)
  if (!existing.length) return true
  const answer = await ask({
    title: 'Replace existing files?',
    message:
      existing.length === 1
        ? `“${basename(existing[0])}” already exists in this folder. Do you want to replace it?`
        : `${existing.length} of the images (such as “${basename(existing[0])}”) already exist in this folder. Do you want to replace them?`,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'replace', label: 'Replace', variant: 'primary' }
    ]
  })
  return answer === 'replace'
}

async function openResult(path: string) {
  const err = await invoke('shell:openPath', path)
  if (err) toast(`Could not open ${basename(path)}: ${err}`, { kind: 'error' })
}

/**
 * Exports the document. `format` defaults to the format chosen in the panel; `pages` to the
 * panel's page choice (all pages for the menu commands).
 */
export async function exportDocument(doc: DocumentModel, format?: ExportFormat, opts: { pages?: number[] } = {}): Promise<boolean> {
  await loadSettings()
  const st = getState()
  if (st.busy) return false
  const fmt = format ?? st.options.format
  const options: ExportOptions = { ...st.options, format: fmt }
  if (!doc.state.info.permissions.copy) {
    await explainRestricted(doc)
    return false
  }
  const pages = opts.pages ?? scopePages(doc, st.scope, st.range)
  if (typeof pages === 'string') {
    toast(pages, { kind: 'error' })
    return false
  }
  const dest = await chooseDestination(doc, fmt, options)
  if (!dest) return false
  const base = baseNameOf(doc)
  let cancelled = false
  setState({ busy: true })
  try {
    const engine: ExportEngine = doc.ops<typeof exportOps>('export-create')
    const label = FORMAT_INFO[fmt].short
    const result = await withProgress(
      `Exporting to ${label}…`,
      (report) =>
        runExport(engine, {
          options,
          pages,
          title: doc.state.info.metadata.title || stripExtension(doc.state.title),
          baseName: fmt === 'image' && options.image.format !== 'tiff' ? base : stripExtension(basename(dest)),
          lang: doc.state.info.language,
          eol: navigator.userAgent.includes('Windows') ? '\r\n' : '\n',
          onProgress: (fraction, message) => report(Math.max(0, Math.min(1, fraction)), message),
          isCancelled: () => cancelled
        }),
      {
        cancel: () => {
          cancelled = true
        }
      }
    )
    if (result.kind === 'images') {
      const paths = result.files.map((f) => joinPath(dest, f.name))
      if (!(await confirmOverwrite(paths))) return false
      await withProgress('Saving images…', async (report) => {
        for (let k = 0; k < result.files.length; k++) {
          report(k / result.files.length, `Saving ${result.files[k].name}`)
          await writeFile(paths[k], result.files[k].data)
        }
      })
      setState((s) => ({ outcomes: { ...s.outcomes, [doc.id]: { format: fmt, path: dest, files: paths } } }))
      toast(`Saved ${paths.length === 1 ? basename(paths[0]) : `${paths.length} images`} in “${basename(dest) || dest}”`, {
        kind: 'success',
        action: { label: isMac ? 'Show in Finder' : 'Show in folder', run: () => void invoke('shell:showItemInFolder', paths[0]) }
      })
      return true
    }
    await writeFile(dest, result.data)
    setState((s) => ({ outcomes: { ...s.outcomes, [doc.id]: { format: fmt, path: dest, files: [dest] } } }))
    if (options.openAfter) void openResult(dest)
    toast(`Exported “${basename(dest)}”`, { kind: 'success', action: { label: 'Open', run: () => void openResult(dest) } })
    return true
  } catch (err) {
    if (err instanceof ExportCancelled || cancelled) {
      toast('Export cancelled')
      return false
    }
    showError(err, 'Could not export')
    return false
  } finally {
    setState({ busy: false })
  }
}
