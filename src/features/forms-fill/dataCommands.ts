import {
  basename,
  confirm,
  dirname,
  invoke,
  joinPath,
  readFile,
  showError,
  stripExtension,
  toast,
  writeFile,
  type DocumentModel
} from '@renderer/sdk'
import type fillOps from './engine'
import { formController } from './controller'
import { buildFdf, buildJson, buildXfdf, dataFormat, exportEntries, parseJsonData, parseXfdf, type DataEntry } from './formData'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Forms > Manage Form Data > Export Data… (XFDF, FDF or JSON). */
export async function exportFormData(doc: DocumentModel) {
  try {
    const ctl = formController(doc)
    await ctl.flush()
    const fields = await doc.ops<typeof fillOps>('forms-fill').exportValues()
    const entries = exportEntries(fields)
    if (!entries.length) {
      toast('This document has no form fields to export.', { kind: 'warning' })
      return
    }
    const base = stripExtension(doc.state.title) + '_data.xfdf'
    const defaultPath = doc.state.filePath ? joinPath(dirname(doc.state.filePath), base) : base
    const chosen = await invoke('file:saveDialog', {
      title: 'Export Form Data',
      defaultPath,
      filters: [
        { name: 'XFDF form data', extensions: ['xfdf'] },
        { name: 'FDF form data', extensions: ['fdf'] },
        { name: 'JSON', extensions: ['json'] }
      ]
    })
    if (!chosen) return
    let path = chosen
    let ext = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''
    if (!['xfdf', 'fdf', 'json', 'xml'].includes(ext)) {
      path += '.xfdf'
      ext = 'xfdf'
    }
    const pdfName = doc.state.title
    let bytes: Uint8Array
    if (ext === 'fdf') bytes = buildFdf(fields, pdfName)
    else if (ext === 'json') bytes = new TextEncoder().encode(buildJson(entries, pdfName))
    else bytes = new TextEncoder().encode(buildXfdf(entries, pdfName))
    await writeFile(path, bytes)
    toast(`Exported ${plural(entries.length, 'field value')} to ${basename(path)}.`, { kind: 'success' })
  } catch (err) {
    showError(err, 'Could not export the form data')
  }
}

/** Forms > Manage Form Data > Import Data… */
export async function importFormData(doc: DocumentModel) {
  try {
    const paths = await invoke('file:openDialog', {
      title: 'Import Form Data',
      filters: [
        { name: 'Form data (XFDF, FDF, JSON)', extensions: ['xfdf', 'fdf', 'json', 'xml'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (!paths.length) return
    await importFormDataFrom(doc, paths[0])
  } catch (err) {
    showError(err, 'Could not import the form data')
  }
}

export async function importFormDataFrom(doc: DocumentModel, path: string) {
  const ctl = formController(doc)
  await ctl.flush()
  const bytes = await readFile(path)
  const format = dataFormat(path, bytes)
  let entries: DataEntry[]
  if (format === 'fdf') entries = (await doc.ops<typeof fillOps>('forms-fill').parseFdf(bytes)).fields
  else if (format === 'xfdf') entries = parseXfdf(new TextDecoder().decode(bytes))
  else if (format === 'json') entries = parseJsonData(new TextDecoder().decode(bytes))
  else throw new Error('Choose an XFDF, FDF or JSON form data file')
  const name = basename(path)
  if (!entries.length) {
    toast(`${name} has no field values.`, { kind: 'warning' })
    return
  }
  const r = await ctl.importValues(entries)
  if (!r.imported) {
    toast(`None of the fields in ${name} match the fields of this form.`, { kind: 'warning', timeout: 8000 })
    return
  }
  const unknown = r.unknown.length
    ? ` ${plural(r.unknown.length, 'value')} did not match this form (${r.unknown.slice(0, 3).join(', ')}${r.unknown.length > 3 ? '…' : ''}).`
    : ''
  toast(`Imported ${plural(r.imported, 'field value')} from ${name}.${unknown}`, { kind: r.unknown.length ? 'warning' : 'success', timeout: 6000 })
}

/** Forms > Clear Form: resets every field to its default value (undoable). */
export async function clearForm(doc: DocumentModel) {
  const ok = await confirm({
    title: 'Clear form',
    message: `Clear all the fields in “${doc.state.title}”? Fields go back to their default values. You can undo this.`,
    confirmLabel: 'Clear form',
    danger: true
  })
  if (!ok) return
  try {
    const ctl = formController(doc)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    await ctl.flush()
    await ctl.reset()
    toast('The form was cleared.', { kind: 'success', action: { label: 'Undo', run: () => void doc.undo() } })
  } catch (err) {
    showError(err, 'Could not clear the form')
  }
}
