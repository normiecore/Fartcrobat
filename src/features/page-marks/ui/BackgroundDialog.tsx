import { useState } from 'react'
import {
  Button,
  ColorPicker,
  Dialog,
  Segmented,
  showError,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import type { BackgroundSettings, ColorSource, FileSource } from '../shared'
import { applyMarksFromUi, Group, PageRangeFields, PresetsBar, PreviewPane, rangeError } from './common'
import {
  AppearanceFields,
  FileSourceFields,
  PositionFields,
  useSourceLoader,
  VisibilityFields
} from './appearance'

const BACKGROUND_COLORS = [
  '#FFFFFF',
  '#FFFDE7',
  '#FFF3E0',
  '#FCE4EC',
  '#F3E5F5',
  '#E8EAF6',
  '#E3F2FD',
  '#E0F7FA',
  '#E8F5E9',
  '#F1F8E9',
  '#FFF9C4',
  '#FFE0B2',
  '#D7CCC8',
  '#EEEEEE',
  '#CFD8DC',
  '#000000'
]

export function BackgroundDialog({
  doc,
  initial,
  mode,
  intent,
  close
}: {
  doc: DocumentModel
  initial: BackgroundSettings
  mode: 'add' | 'replace'
  /** Which command opened the dialog (sets the title); defaults from the mode. */
  intent?: 'add' | 'update'
  close: (ok?: boolean) => void
}) {
  const [s, setS] = useState<BackgroundSettings>(initial)
  const [color, setColor] = useState<ColorSource>(
    initial.source.kind === 'color' ? initial.source : { kind: 'color', color: '#FFFDE7' }
  )
  const [file, setFile] = useState<FileSource | null>(initial.source.kind === 'file' ? initial.source : null)
  const [page, setPage] = useState(() => doc.state.currentPage)
  const [busy, setBusy] = useState(false)
  const pageCount = useDocState(doc, (st) => st.info.pageCount)
  const loader = useSourceLoader(doc)
  const inDocument = mode === 'replace' && initial.source.kind === 'file'
  const set = (patch: Partial<BackgroundSettings>) => setS((prev) => ({ ...prev, ...patch }))

  const pickColor = (c: ColorSource) => {
    setColor(c)
    set({ source: c })
  }
  const pickFile = (f: FileSource) => {
    setFile(f)
    set({ source: f })
  }

  const load = async (preset: BackgroundSettings) => {
    if (preset.source.kind === 'file') {
      const src = await loader.reload(preset.source)
      if (!src) return
      setFile(src)
      setS({ ...preset, source: src })
    } else {
      setColor(preset.source)
      setS(preset)
    }
  }

  const sourceError = s.source.kind === 'file' && !s.source.sourceId && !inDocument ? 'Choose a file.' : null
  const error = sourceError ?? rangeError(s.range, pageCount)
  const canApply = !error && !busy && (s.showOnPrint || s.showOnScreen)

  const ok = async () => {
    if (!canApply) return
    setBusy(true)
    const done = await applyMarksFromUi(doc, s, mode)
    setBusy(false)
    if (done) close(true)
  }

  return (
    <Dialog
      title={
        (intent ?? (mode === 'replace' ? 'update' : 'add')) === 'update'
          ? 'Update Background'
          : 'Add Background'
      }
      onClose={() => close(false)}
      width={1000}
      className="fc-page-marks-dialog"
      footer={
        <>
          {sourceError && <span className="fc-page-marks-footer-hint">{sourceError}</span>}
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={!canApply} onClick={() => void ok()}>
            {busy ? 'Applying…' : 'OK'}
          </Button>
        </>
      }
    >
      <PresetsBar type="Background" current={s} onLoad={(p) => void load(p).catch((err) => showError(err))} />
      <div className="fc-page-marks-layout">
        <div className="fc-page-marks-form">
          <Group title="Source">
            <Segmented<'color' | 'file'>
              value={s.source.kind}
              onChange={(k) =>
                k === 'color'
                  ? pickColor(color)
                  : file
                    ? pickFile(file)
                    : set({ source: { kind: 'file', fileName: '', page: 1, scale: 100 } })
              }
              options={[
                { value: 'color', label: 'Colour' },
                { value: 'file', label: 'File (image or PDF)' }
              ]}
            />
            {s.source.kind === 'color' ? (
              <div className="fc-page-marks-source">
                <ColorPicker
                  value={s.source.color}
                  colors={BACKGROUND_COLORS}
                  onChange={(c) => pickColor({ kind: 'color', color: c ?? '#FFFFFF' })}
                />
              </div>
            ) : (
              <FileSourceFields
                source={s.source.fileName ? s.source : null}
                onChange={pickFile}
                loader={loader}
                inDocument={inDocument}
              />
            )}
          </Group>
          <Group title="Appearance">
            <AppearanceFields
              value={s}
              onChange={set}
              showRotation={s.source.kind === 'file'}
              showScale={s.source.kind === 'file'}
            />
            <VisibilityFields value={s} onChange={set} />
          </Group>
          {s.source.kind === 'file' && (
            <PositionFields value={s.position} onChange={(position) => set({ position })} />
          )}
          <Group title="Page range">
            <PageRangeFields
              range={s.range}
              onChange={(range) => set({ range })}
              pageCount={pageCount}
              currentPage={doc.state.currentPage}
            />
          </Group>
        </div>
        <PreviewPane doc={doc} settings={s} mode={mode} page={page} onPageChange={setPage} />
      </div>
    </Dialog>
  )
}
