import { useState } from 'react'
import {
  Button,
  Checkbox,
  Dialog,
  dirname,
  invoke,
  joinPath,
  openDialog,
  showError,
  stripExtension,
  toast,
  useApp,
  withProgress,
  writeFile,
  type DocumentModel
} from '@renderer/sdk'
import { deletePages, openExtractedPages } from '../actions'
import { orgOps } from '../files'
import { protectionNote } from '../protection'
import { countLabel, describePages } from '../ranges'
import { sanitizeFileName, uniqueName } from '../split'
import { PageScope, Summary, initialScope, resolveScope, type Scope } from './common'

/** Folder suggested for files written next to a document. */
export function defaultFolder(doc: DocumentModel): string | undefined {
  if (doc.state.filePath) return dirname(doc.state.filePath)
  return useApp.getState().systemInfo?.documentsPath
}

export async function chooseFolder(title: string, defaultPath?: string): Promise<string | null> {
  const dirs = await invoke('file:openDialog', { title, directory: true, defaultPath })
  return dirs[0] ?? null
}

export function showFolderAction(dir: string) {
  return { label: 'Show folder', run: () => void invoke('shell:openPath', dir) }
}

export async function extractPages(
  doc: DocumentModel,
  pages: number[],
  opts: { deleteAfter: boolean; separate: boolean }
): Promise<boolean> {
  const base = stripExtension(doc.state.title)
  if (opts.deleteAfter && pages.length >= doc.pageCount) {
    toast("All pages can't be deleted after extracting — a PDF needs at least one page.", { kind: 'warning' })
    return false
  }
  try {
    // Extracted files keep the document's protection (see docs/features/organize-pages.md).
    const protection = await orgOps(doc).protection()
    if (opts.separate) {
      const dir = await chooseFolder('Choose a folder for the extracted pages', defaultFolder(doc))
      if (!dir) return false
      const labels = doc.state.info.pages.map((p) => p.label)
      const written: string[] = []
      await withProgress(`Extracting ${countLabel(pages.length)}…`, async (report) => {
        for (let k = 0; k < pages.length; k++) {
          const p = pages[k]
          report(k / pages.length, `Page ${p + 1} of ${doc.pageCount}`)
          const bytes = await orgOps(doc).extract([p])
          const label = labels[p] && labels[p] !== String(p + 1) ? labels[p] : String(p + 1)
          const name = await uniqueName(`${sanitizeFileName(`${base} - page ${label}`)}.pdf`, (n) =>
            invoke('file:exists', joinPath(dir, n))
          )
          await writeFile(joinPath(dir, name), bytes)
          written.push(name)
        }
        report(1)
      })
      if (opts.deleteAfter) await deletePages(doc, pages)
      const note = protection
        ? '. ' + protectionNote(protection, doc.state.title, written.length > 1 ? 'They keep' : 'It keeps')
        : ''
      toast(`Extracted ${countLabel(written.length, 'file', 'files')} to ${dir}${note}`, {
        kind: 'success',
        action: showFolderAction(dir)
      })
      return true
    }
    const bytes = await withProgress(`Extracting ${countLabel(pages.length)}…`, () =>
      orgOps(doc).extract(pages)
    )
    if (opts.deleteAfter) await deletePages(doc, pages)
    const opened = await openExtractedPages(doc, bytes, `Pages from ${base}.pdf`)
    if (opened && protection) toast(protectionNote(protection, doc.state.title, 'The new document keeps'))
    return true
  } catch (err) {
    showError(err, 'Could not extract the pages')
    return false
  }
}

function ExtractDialog({
  doc,
  selected,
  close
}: {
  doc: DocumentModel
  selected: number[]
  close: () => void
}) {
  const [scope, setScope] = useState<Scope>(initialScope(selected))
  const [deleteAfter, setDeleteAfter] = useState(false)
  const [separate, setSeparate] = useState(false)
  const res = resolveScope(doc, scope, selected)
  const tooMany = deleteAfter && res.ok && res.pages.length >= doc.pageCount
  const ok = res.ok && !tooMany
  const submit = () => {
    if (!ok) return
    close()
    void extractPages(doc, res.pages, { deleteAfter, separate })
  }
  return (
    <Dialog
      title="Extract Pages"
      onClose={close}
      onSubmit={submit}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!ok} onClick={submit}>
            Extract
          </Button>
        </>
      }
    >
      <PageScope doc={doc} value={scope} onChange={setScope} selected={selected} />
      <div className="fc-organize-pages-checks">
        <Checkbox checked={deleteAfter} onChange={setDeleteAfter} label="Delete pages after extracting" />
        <Checkbox checked={separate} onChange={setSeparate} label="Extract pages as separate files" />
      </div>
      <Summary tone={tooMany ? 'warning' : undefined}>
        {tooMany
          ? "All pages can't be deleted — a PDF needs at least one page."
          : res.ok
            ? separate
              ? `Saves ${countLabel(res.pages.length, 'file', 'files')} (one per page) in a folder you choose.`
              : `Opens ${describePages(res.pages)} as a new document.`
            : ' '}
      </Summary>
    </Dialog>
  )
}

export async function openExtractDialog(doc: DocumentModel, selected: number[]): Promise<void> {
  await openDialog((close) => <ExtractDialog doc={doc} selected={selected} close={() => close()} />)
}
