import { useState } from 'react'
import { FileText } from 'lucide-react'
import {
  Button,
  Dialog,
  NumberInput,
  openDialog,
  showError,
  toast,
  withProgress,
  type DocumentModel
} from '@renderer/sdk'
import { afterChange, undoAction } from '../actions'
import { chooseFiles, loadFile, orgOps, withPassword, type LoadedFile } from '../files'
import { countLabel } from '../ranges'
import { isOrganizeOpen, selectIndices } from '../store'
import { Summary } from './common'

interface Source {
  file: LoadedFile
  pageCount: number
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.round(v) || lo))
}

function ReplaceDialog({
  doc,
  source: initial,
  selected,
  close
}: {
  doc: DocumentModel
  source: Source
  selected: number[]
  close: () => void
}) {
  const count = doc.pageCount
  const [source, setSource] = useState(initial)
  const first = selected.length ? selected[0] : doc.state.currentPage
  const last = selected.length ? selected[selected.length - 1] : doc.state.currentPage
  const [from, setFrom] = useState(first + 1)
  const [to, setTo] = useState(last + 1)
  const [srcFrom, setSrcFrom] = useState(1)
  const [srcTo, setSrcTo] = useState(Math.min(source.pageCount, last - first + 1))
  const a = clamp(Math.min(from, to), 1, count)
  const b = clamp(Math.max(from, to), 1, count)
  const sa = clamp(Math.min(srcFrom, srcTo), 1, source.pageCount)
  const sb = clamp(Math.max(srcFrom, srcTo), 1, source.pageCount)
  const n = b - a + 1
  const m = sb - sa + 1
  const pagesText = (x: number, y: number) => (x === y ? `page ${x}` : `pages ${x}–${y}`)

  const changeFile = async () => {
    const next = await pickReplacement(doc)
    if (!next) return
    setSource(next)
    setSrcFrom(1)
    setSrcTo(Math.min(next.pageCount, n))
  }

  const submit = async () => {
    close()
    try {
      const res = await withProgress('Replacing pages…', () =>
        afterChange(doc, () =>
          orgOps(doc).replace(a - 1, b - 1, {
            data: source.file.bytes,
            fileName: source.file.engineName,
            password: source.file.password,
            pages: Array.from({ length: m }, (_, k) => sa - 1 + k)
          })
        )
      )
      const total = res.replaced + res.inserted
      if (isOrganizeOpen(doc))
        selectIndices(
          doc,
          Array.from({ length: total }, (_, k) => a - 1 + k),
          { focus: a - 1, anchor: a - 1 }
        )
      else doc.view?.goToPage(a - 1)
      toast(`Replaced ${pagesText(a, b)}`, { kind: 'success', action: undoAction(doc) })
    } catch (err) {
      showError(err, 'Could not replace the pages')
    }
  }

  return (
    <Dialog
      title="Replace Pages"
      onClose={close}
      width={540}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()}>
            Replace
          </Button>
        </>
      }
    >
      <fieldset className="fc-organize-pages-fieldset">
        <legend>Original</legend>
        <div className="fc-organize-pages-range-row">
          <span>Replace pages</span>
          <NumberInput
            aria-label="First page to replace"
            min={1}
            max={count}
            value={from}
            onChange={setFrom}
          />
          <span>to</span>
          <NumberInput aria-label="Last page to replace" min={1} max={count} value={to} onChange={setTo} />
          <span className="shell-muted">
            of {doc.state.title} ({countLabel(count)})
          </span>
        </div>
      </fieldset>
      <fieldset className="fc-organize-pages-fieldset">
        <legend>Replacement</legend>
        <div className="fc-organize-pages-file">
          <FileText size={18} />
          <span className="fc-organize-pages-file-name" title={source.file.path ?? source.file.name}>
            {source.file.name}
          </span>
          <span className="shell-muted">{countLabel(source.pageCount)}</span>
          <Button size="sm" variant="quiet" onClick={() => void changeFile()}>
            Choose another file…
          </Button>
        </div>
        <div className="fc-organize-pages-range-row">
          <span>With pages</span>
          <NumberInput
            aria-label="First replacement page"
            min={1}
            max={source.pageCount}
            value={srcFrom}
            onChange={setSrcFrom}
          />
          <span>to</span>
          <NumberInput
            aria-label="Last replacement page"
            min={1}
            max={source.pageCount}
            value={srcTo}
            onChange={setSrcTo}
          />
        </div>
      </fieldset>
      <Summary>
        {pagesText(a, b).replace(/^p/, 'P')} of this document will show {pagesText(sa, sb)} of{' '}
        {source.file.name}.
        {m > n && ` The ${countLabel(m - n, 'extra page', 'extra pages')} will be added after page ${b}.`}
        {m < n && ` ${pagesText(a + m, b).replace(/^p/, 'P')} will be removed.`}
        <div className="shell-muted fc-organize-pages-note">
          Links, bookmarks, form fields and comments of the original pages are kept.
        </div>
      </Summary>
    </Dialog>
  )
}

async function pickReplacement(doc: DocumentModel): Promise<Source | null> {
  const [path] = await chooseFiles('Choose the file with the replacement pages', false)
  if (!path) return null
  try {
    const file = await loadFile(path)
    const probe = await withPassword(file.name, (pw) => orgOps(doc).probe(file.bytes, file.engineName, pw))
    if (!probe) return null
    return { file: { ...file, password: probe.password }, pageCount: probe.result.pageCount }
  } catch (err) {
    showError(err, 'Could not open the replacement file')
    return null
  }
}

/** Document > Replace Pages…: pick a file, then choose which pages replace which. */
export async function openReplaceFlow(doc: DocumentModel, selected: number[]) {
  const source = await pickReplacement(doc)
  if (!source) return
  await openDialog((close) => (
    <ReplaceDialog doc={doc} source={source} selected={selected} close={() => close()} />
  ))
}
