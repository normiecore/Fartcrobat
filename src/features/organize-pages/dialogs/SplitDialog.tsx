import { useEffect, useId, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import {
  Button,
  Checkbox,
  Dialog,
  Field,
  invoke,
  joinPath,
  NumberInput,
  openDialog,
  Radio,
  showError,
  stripExtension,
  TextInput,
  toast,
  withProgress,
  writeFile,
  type DocumentModel
} from '@renderer/sdk'
import { orgOps } from '../files'
import { protectionNote } from '../protection'
import { countLabel } from '../ranges'
import {
  partFileNames,
  sanitizeFileName,
  splitByBookmarks,
  splitEvery,
  uniqueName,
  type SplitPart
} from '../split'
import { Summary } from './common'
import { chooseFolder, defaultFolder, showFolderAction } from './ExtractDialog'

type Mode = 'pages' | 'size' | 'bookmarks'

interface Bookmark {
  title: string
  page: number | null
}

export interface SplitSettings {
  mode: Mode
  pagesPer: number
  maxMB: number
  folder: string
  label: string
  useTitles: boolean
  noOverwrite: boolean
}

/** Splits the document into files in `settings.folder`. Returns the written file names. */
export async function runSplit(
  doc: DocumentModel,
  settings: SplitSettings,
  bookmarks: Bookmark[]
): Promise<string[] | null> {
  const count = doc.pageCount
  const base = sanitizeFileName(stripExtension(doc.state.title))
  try {
    return await withProgress('Splitting document…', async (report) => {
      let parts: SplitPart[]
      if (settings.mode === 'pages') parts = splitEvery(count, settings.pagesPer)
      else if (settings.mode === 'bookmarks') parts = splitByBookmarks(count, bookmarks)
      else {
        report(0, 'Measuring pages…')
        parts = await doc
          .ops<typeof import('../engine').default>('organize-pages', {
            onProgress: (f) => report(f * 0.5, 'Measuring pages…')
          })
          .splitPlanBySize(Math.round(settings.maxMB * 1024 * 1024))
      }
      if (parts.length < 2)
        throw new Error(
          'These settings would create only one file. Choose a smaller size or fewer pages per file.'
        )
      const names = partFileNames(base, parts, {
        label: settings.label,
        useTitles: settings.mode === 'bookmarks' && settings.useTitles
      })
      const written: string[] = []
      const offset = settings.mode === 'size' ? 0.5 : 0
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        report(
          offset + ((1 - offset) * i) / parts.length,
          `Writing ${names[i]} (${i + 1} of ${parts.length})`
        )
        const bytes = await orgOps(doc).extract(
          Array.from({ length: p.end - p.start + 1 }, (_, k) => p.start + k)
        )
        const name = settings.noOverwrite
          ? await uniqueName(names[i], (n) => invoke('file:exists', joinPath(settings.folder, n)))
          : names[i]
        await writeFile(joinPath(settings.folder, name), bytes)
        written.push(name)
      }
      report(1)
      return written
    })
  } catch (err) {
    showError(err, 'Could not split the document')
    return null
  }
}

function SplitDialog({ doc, close }: { doc: DocumentModel; close: () => void }) {
  const name = useId()
  const count = doc.pageCount
  const [bookmarks, setBookmarks] = useState<Bookmark[] | null>(null)
  const [s, setS] = useState<SplitSettings>({
    mode: 'pages',
    pagesPer: Math.max(1, Math.min(10, Math.ceil(count / 2))),
    maxMB: 5,
    folder: defaultFolder(doc) ?? '',
    label: 'Part',
    useTitles: true,
    noOverwrite: true
  })
  const set = (patch: Partial<SplitSettings>) => setS((v) => ({ ...v, ...patch }))
  useEffect(() => {
    let alive = true
    doc.core.nav
      .outline()
      .then((o) => alive && setBookmarks(o.map((b) => ({ title: b.title, page: b.dest?.page ?? null }))))
      .catch(() => alive && setBookmarks([]))
    return () => {
      alive = false
    }
  }, [doc])
  const usable = (bookmarks ?? []).filter((b) => b.page !== null)
  const base = sanitizeFileName(stripExtension(doc.state.title))
  let parts: SplitPart[] | null = null
  if (s.mode === 'pages') parts = splitEvery(count, s.pagesPer)
  else if (s.mode === 'bookmarks') parts = splitByBookmarks(count, usable)
  const names = parts
    ? partFileNames(base, parts, { label: s.label, useTitles: s.mode === 'bookmarks' && s.useTitles })
    : []
  // With bookmark titles as names, the label only names a part before the first bookmark.
  const labelUnused = s.mode === 'bookmarks' && s.useTitles && !!parts && parts.every((p) => !!p.title)
  const valid =
    !!s.folder &&
    (s.mode === 'size'
      ? s.maxMB > 0
      : s.mode === 'bookmarks'
        ? usable.length > 0 && (parts?.length ?? 0) > 1
        : (parts?.length ?? 0) > 1)
  const submit = async () => {
    if (!valid) return
    close()
    const written = await runSplit(doc, s, usable)
    if (!written) return
    // The parts keep the document's protection (see docs/features/organize-pages.md).
    const protection = await orgOps(doc)
      .protection()
      .catch(() => null)
    const note = protection ? '. ' + protectionNote(protection, doc.state.title, 'They keep') : ''
    toast(`Split into ${countLabel(written.length, 'file', 'files')} in ${s.folder}${note}`, {
      kind: 'success',
      action: showFolderAction(s.folder)
    })
  }
  return (
    <Dialog
      title="Split Document"
      onClose={close}
      onSubmit={() => void submit()}
      width={540}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void submit()}>
            Split
          </Button>
        </>
      }
    >
      <fieldset className="fc-organize-pages-fieldset">
        <legend>Split by</legend>
        <div className="fc-organize-pages-range-row">
          <Radio
            name={name}
            checked={s.mode === 'pages'}
            onChange={() => set({ mode: 'pages' })}
            label="Number of pages:"
          />
          <NumberInput
            aria-label="Pages per file"
            min={1}
            max={count}
            value={s.pagesPer}
            onFocus={() => set({ mode: 'pages' })}
            onChange={(v) => set({ pagesPer: Math.max(1, Math.round(v)) })}
          />
          <span className="shell-muted">pages per file</span>
        </div>
        <div className="fc-organize-pages-range-row">
          <Radio
            name={name}
            checked={s.mode === 'size'}
            onChange={() => set({ mode: 'size' })}
            label="File size:"
          />
          <NumberInput
            aria-label="Maximum file size in MB"
            min={0.1}
            step={0.5}
            value={s.maxMB}
            onFocus={() => set({ mode: 'size' })}
            onChange={(v) => set({ maxMB: Math.max(0.1, v) })}
          />
          <span className="shell-muted">MB per file (approximately)</span>
        </div>
        <div className="fc-organize-pages-range-row">
          <Radio
            name={name}
            checked={s.mode === 'bookmarks'}
            onChange={() => set({ mode: 'bookmarks' })}
            label="Top-level bookmarks"
          />
          <span className="shell-muted">
            {bookmarks === null
              ? 'Reading bookmarks…'
              : usable.length
                ? `(${countLabel(usable.length, 'bookmark', 'bookmarks')})`
                : '(this document has no bookmarks)'}
          </span>
        </div>
      </fieldset>
      <Field label="Save the files in">
        <div className="fc-organize-pages-folder">
          <TextInput value={s.folder} readOnly title={s.folder} aria-label="Output folder" />
          <Button
            icon={FolderOpen}
            onClick={() =>
              void chooseFolder('Choose where to save the split files', s.folder || undefined).then((dir) => {
                if (dir) set({ folder: dir })
              })
            }
          >
            Change…
          </Button>
        </div>
      </Field>
      <div className="fc-organize-pages-row2">
        <Field label="Label added to file names">
          <TextInput
            value={s.label}
            onChange={(e) => set({ label: e.target.value })}
            placeholder="Part"
            className="fc-organize-pages-input"
            disabled={labelUnused}
            title={labelUnused ? 'The files are named after the bookmarks' : undefined}
          />
        </Field>
        <div className="fc-organize-pages-checks is-tight">
          {s.mode === 'bookmarks' && (
            <Checkbox
              checked={s.useTitles}
              onChange={(v) => set({ useTitles: v })}
              label="Use bookmark titles as file names"
            />
          )}
          <Checkbox
            checked={s.noOverwrite}
            onChange={(v) => set({ noOverwrite: v })}
            label="Don't overwrite existing files"
          />
        </div>
      </div>
      <Summary tone={!valid && s.mode !== 'size' && s.folder ? 'warning' : undefined}>
        {s.mode === 'size' ? (
          <>The number of files is worked out when you split. Each file will be about {s.maxMB} MB or less.</>
        ) : parts && parts.length > 1 ? (
          <>
            Creates {countLabel(parts.length, 'file', 'files')}:
            <ul className="fc-organize-pages-parts">
              {parts.slice(0, 4).map((p, i) => (
                <li key={i}>
                  <b>{names[i]}</b>{' '}
                  <span className="shell-muted">
                    — {p.start === p.end ? `page ${p.start + 1}` : `pages ${p.start + 1}–${p.end + 1}`}
                  </span>
                </li>
              ))}
              {parts.length > 4 && (
                <li className="shell-muted">and {countLabel(parts.length - 4, 'more file', 'more files')}</li>
              )}
            </ul>
          </>
        ) : s.mode === 'bookmarks' && !usable.length ? (
          'Choose another way to split: this document has no top-level bookmarks.'
        ) : (
          'These settings would create only one file.'
        )}
      </Summary>
    </Dialog>
  )
}

export async function openSplitDialog(doc: DocumentModel): Promise<void> {
  await openDialog((close) => <SplitDialog doc={doc} close={() => close()} />)
}
