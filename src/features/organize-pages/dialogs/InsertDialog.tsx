import { useEffect, useId, useState } from 'react'
import { Clipboard, File, FilePlus2, FileText, FolderOpen } from 'lucide-react'
import {
  Button,
  Dialog,
  Field,
  NumberInput,
  openDialog,
  Radio,
  Segmented,
  Select,
  showError,
  TextInput,
  useApp,
  type DocumentModel
} from '@renderer/sdk'
import {
  describeClipboard,
  insertBlankPages,
  insertFileSources,
  insertFromClipboard,
  readClipboard
} from '../actions'
import { chooseFiles, loadFile, loadOpenDocument, orgOps, withPassword, type LoadedFile } from '../files'
import type { OrganizeClipboard } from '../ipc'
import { countLabel, parsePageRange } from '../ranges'
import { LocationPicker, Summary, gapForLocation, locationForGap, type Location } from './common'

export type InsertSourceKind = 'file' | 'open' | 'blank' | 'clipboard'

export interface PickedFile {
  file: LoadedFile
  pageCount: number
}

type SizePreset = 'same' | 'letter' | 'legal' | 'tabloid' | 'a3' | 'a4' | 'a5' | 'custom'
type Unit = 'in' | 'mm' | 'pt'

const PRESETS: Record<Exclude<SizePreset, 'same' | 'custom'>, [number, number]> = {
  letter: [612, 792],
  legal: [612, 1008],
  tabloid: [792, 1224],
  a3: [842, 1191],
  a4: [595, 842],
  a5: [420, 595]
}

const UNIT_PT: Record<Unit, number> = { in: 72, mm: 72 / 25.4, pt: 1 }

function round(v: number) {
  return Math.round(v * 100) / 100
}

/** Picks a file to insert pages from and asks for its password when needed. */
export async function pickInsertFile(
  doc: DocumentModel,
  title = 'Insert Pages from File'
): Promise<PickedFile | null> {
  const [path] = await chooseFiles(title, false)
  if (!path) return null
  try {
    const file = await loadFile(path)
    const probe = await withPassword(file.name, (pw) => orgOps(doc).probe(file.bytes, file.engineName, pw))
    if (!probe) return null
    return { file: { ...file, password: probe.password }, pageCount: probe.result.pageCount }
  } catch (err) {
    showError(err, 'Could not open the file')
    return null
  }
}

function InsertDialog({
  doc,
  initialSource,
  initialFile,
  gap,
  close
}: {
  doc: DocumentModel
  initialSource: InsertSourceKind
  initialFile?: PickedFile
  gap: number
  close: () => void
}) {
  const id = useId()
  const count = doc.pageCount
  const docs = useApp((s) => s.docs)
  const others = docs.filter((d) => d.id !== doc.id)
  const [source, setSource] = useState<InsertSourceKind>(initialSource)
  const [file, setFile] = useState<PickedFile | null>(initialFile ?? null)
  const [openId, setOpenId] = useState<string>(others[0]?.id ?? '')
  const [allPages, setAllPages] = useState(true)
  const [rangeText, setRangeText] = useState('')
  const [location, setLocation] = useState<Location>(locationForGap(gap, count))
  const [preset, setPreset] = useState<SizePreset>('same')
  const [landscape, setLandscape] = useState(false)
  const [unit, setUnit] = useState<Unit>('in')
  const [custom, setCustom] = useState<[number, number]>([8.5, 11])
  const [blankCount, setBlankCount] = useState(1)
  const [clip, setClip] = useState<OrganizeClipboard | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (source !== 'clipboard') return
    let alive = true
    readClipboard()
      .then((c) => alive && setClip(c))
      .catch(() => alive && setClip({ files: [], image: null, text: '' }))
    return () => {
      alive = false
    }
  }, [source])

  const openDoc = others.find((d) => d.id === openId) ?? null
  const srcCount =
    source === 'file' ? (file?.pageCount ?? 0) : source === 'open' ? (openDoc?.pageCount ?? 0) : 0
  const range = !allPages && srcCount ? parsePageRange(rangeText, srcCount) : null
  const at = gapForLocation(location, count)
  const refPage = doc.state.info.pages[Math.max(0, Math.min(count - 1, at === 0 ? 0 : at - 1))]

  let size: [number, number] | null = null
  if (preset === 'same') size = refPage ? [refPage.width, refPage.height] : [612, 792]
  else if (preset === 'custom')
    size = custom[0] > 0 && custom[1] > 0 ? [custom[0] * UNIT_PT[unit], custom[1] * UNIT_PT[unit]] : null
  else {
    const [w, h] = PRESETS[preset]
    size = landscape ? [h, w] : [w, h]
  }

  const clipEmpty = !!clip && !clip.files.length && !(clip.image && clip.image.length) && !clip.text.trim()
  let ready = false
  if (source === 'file') ready = !!file && (allPages || !!range?.ok)
  else if (source === 'open') ready = !!openDoc && (allPages || !!range?.ok)
  else if (source === 'blank')
    ready =
      !!size &&
      size[0] >= 3 &&
      size[1] >= 3 &&
      size[0] <= 14400 &&
      size[1] <= 14400 &&
      blankCount >= 1 &&
      blankCount <= 1000
  else ready = !!clip && !clipEmpty

  const chooseFile = async () => {
    const picked = await pickInsertFile(doc)
    if (picked) {
      setFile(picked)
      setAllPages(true)
      setRangeText('')
    }
  }

  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      const pages = !allPages && range?.ok ? range.pages : undefined
      if (source === 'file' && file) {
        close()
        await insertFileSources(doc, at, [{ file: file.file, pages }])
      } else if (source === 'open' && openDoc) {
        const loaded = await loadOpenDocument(openDoc)
        close()
        await insertFileSources(doc, at, [{ file: loaded, pages }])
      } else if (source === 'blank' && size) {
        close()
        await insertBlankPages(doc, at, { width: size[0], height: size[1], count: Math.round(blankCount) })
      } else if (source === 'clipboard') {
        close()
        await insertFromClipboard(doc, at)
      }
    } catch (err) {
      showError(err, 'Could not insert the pages')
    } finally {
      setBusy(false)
    }
  }

  const pagesChooser = (n: number) =>
    n > 1 && (
      <div className="fc-organize-pages-indent">
        <Radio
          name={`${id}-pages`}
          checked={allPages}
          onChange={() => setAllPages(true)}
          label={`All ${n} pages`}
        />
        <div className="fc-organize-pages-range-row">
          <Radio
            name={`${id}-pages`}
            checked={!allPages}
            onChange={() => setAllPages(false)}
            label="Pages:"
          />
          <TextInput
            aria-label="Pages to insert"
            value={rangeText}
            placeholder="e.g. 1-3, 5"
            onFocus={() => setAllPages(false)}
            onChange={(e) => {
              setAllPages(false)
              setRangeText(e.target.value)
            }}
          />
        </div>
        {!allPages && rangeText.trim() && range && !range.ok && (
          <div className="ui-field-error">{range.error}</div>
        )}
      </div>
    )

  const insertCount =
    source === 'blank'
      ? Math.round(blankCount)
      : source === 'file' || source === 'open'
        ? allPages
          ? srcCount
          : range?.ok
            ? range.pages.length
            : 0
        : null

  return (
    <Dialog
      title="Insert Pages"
      onClose={close}
      onSubmit={() => void submit()}
      width={560}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!ready || busy} onClick={() => void submit()}>
            Insert
          </Button>
        </>
      }
    >
      <Field label="Insert">
        <div className="fc-organize-pages-seg-wrap">
          <Segmented<InsertSourceKind>
            value={source}
            onChange={setSource}
            options={[
              {
                value: 'file',
                label: (
                  <span className="fc-organize-pages-seg">
                    <File size={14} /> From file
                  </span>
                )
              },
              {
                value: 'open',
                label: (
                  <span className="fc-organize-pages-seg">
                    <FileText size={14} /> Open document
                  </span>
                )
              },
              {
                value: 'blank',
                label: (
                  <span className="fc-organize-pages-seg">
                    <FilePlus2 size={14} /> Blank page
                  </span>
                )
              },
              {
                value: 'clipboard',
                label: (
                  <span className="fc-organize-pages-seg">
                    <Clipboard size={14} /> Clipboard
                  </span>
                )
              }
            ]}
          />
        </div>
      </Field>

      {source === 'file' && (
        <div className="fc-organize-pages-source">
          <div className="fc-organize-pages-file">
            <FileText size={18} />
            <span className="fc-organize-pages-file-name" title={file?.file.path ?? undefined}>
              {file ? file.file.name : 'No file chosen'}
            </span>
            {file && <span className="shell-muted">{countLabel(file.pageCount)}</span>}
            <Button
              size="sm"
              icon={FolderOpen}
              onClick={() => void chooseFile()}
              data-autofocus={!file || undefined}
            >
              {file ? 'Change…' : 'Choose file…'}
            </Button>
          </div>
          {file && pagesChooser(file.pageCount)}
        </div>
      )}

      {source === 'open' && (
        <div className="fc-organize-pages-source">
          {others.length ? (
            <>
              <Field label="Document">
                <Select<string>
                  value={openId}
                  onChange={setOpenId}
                  options={others.map((d) => ({
                    value: d.id,
                    label: `${d.state.title} (${countLabel(d.pageCount)})`
                  }))}
                />
              </Field>
              {openDoc && pagesChooser(openDoc.pageCount)}
            </>
          ) : (
            <div className="shell-muted">Open another document in a tab to insert its pages here.</div>
          )}
        </div>
      )}

      {source === 'blank' && (
        <div className="fc-organize-pages-source">
          <div className="fc-organize-pages-row2">
            <Field label="Page size">
              <Select<SizePreset>
                value={preset}
                onChange={setPreset}
                options={[
                  {
                    value: 'same',
                    label: `Same as page ${at === 0 ? 1 : at} (${round((refPage?.width ?? 612) / 72)} × ${round((refPage?.height ?? 792) / 72)} in)`
                  },
                  { value: 'letter', label: 'Letter (8.5 × 11 in)' },
                  { value: 'legal', label: 'Legal (8.5 × 14 in)' },
                  { value: 'tabloid', label: 'Tabloid (11 × 17 in)' },
                  { value: 'a3', label: 'A3 (297 × 420 mm)' },
                  { value: 'a4', label: 'A4 (210 × 297 mm)' },
                  { value: 'a5', label: 'A5 (148 × 210 mm)' },
                  { value: 'custom', label: 'Custom size' }
                ]}
              />
            </Field>
            <Field label="Number of pages">
              <NumberInput
                min={1}
                max={1000}
                value={blankCount}
                onChange={(v) => setBlankCount(Math.max(1, Math.min(1000, Math.round(v))))}
              />
            </Field>
          </div>
          {preset !== 'same' && preset !== 'custom' && (
            <Field label="Orientation">
              <div className="fc-organize-pages-seg-wrap">
                <Segmented<'portrait' | 'landscape'>
                  value={landscape ? 'landscape' : 'portrait'}
                  onChange={(v) => setLandscape(v === 'landscape')}
                  options={[
                    { value: 'portrait', label: 'Portrait' },
                    { value: 'landscape', label: 'Landscape' }
                  ]}
                />
              </div>
            </Field>
          )}
          {preset === 'custom' && (
            <div className="fc-organize-pages-range-row">
              <span>Width</span>
              <NumberInput
                aria-label="Width"
                min={0.1}
                step={unit === 'pt' ? 1 : 0.1}
                value={custom[0]}
                onChange={(v) => setCustom([v, custom[1]])}
              />
              <span>Height</span>
              <NumberInput
                aria-label="Height"
                min={0.1}
                step={unit === 'pt' ? 1 : 0.1}
                value={custom[1]}
                onChange={(v) => setCustom([custom[0], v])}
              />
              <Select<Unit>
                aria-label="Units"
                value={unit}
                onChange={(u) => {
                  setCustom([
                    round((custom[0] * UNIT_PT[unit]) / UNIT_PT[u]),
                    round((custom[1] * UNIT_PT[unit]) / UNIT_PT[u])
                  ])
                  setUnit(u)
                }}
                options={[
                  { value: 'in', label: 'inches' },
                  { value: 'mm', label: 'mm' },
                  { value: 'pt', label: 'points' }
                ]}
              />
            </div>
          )}
        </div>
      )}

      {source === 'clipboard' && (
        <div className="fc-organize-pages-source">
          <div className="fc-organize-pages-file">
            <Clipboard size={18} />
            <span>{clip ? describeClipboard(clip) : 'Reading the clipboard…'}</span>
          </div>
          <div className="shell-muted fc-organize-pages-note">
            Copied images and text become new pages. Copied PDF or image files are inserted.
          </div>
        </div>
      )}

      <LocationPicker value={location} onChange={setLocation} count={count} />
      <Summary>
        {insertCount !== null && insertCount > 0
          ? `Inserts ${countLabel(insertCount)} ${at === 0 ? 'at the beginning' : at >= count ? 'at the end' : `after page ${at}`}.`
          : `New pages go ${at === 0 ? 'at the beginning' : at >= count ? 'at the end' : `after page ${at}`}.`}
      </Summary>
    </Dialog>
  )
}

/** Opens the Insert Pages dialog. For "file", the file is chosen first (as in Acrobat). */
export async function openInsertDialog(doc: DocumentModel, source: InsertSourceKind, gap: number) {
  let file: PickedFile | undefined
  if (source === 'file') {
    const picked = await pickInsertFile(doc)
    if (!picked) return
    file = picked
  }
  await openDialog((close) => (
    <InsertDialog doc={doc} initialSource={source} initialFile={file} gap={gap} close={() => close()} />
  ))
}
