import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, Segmented, showError, useDocState, type DocumentModel } from '@renderer/sdk'
import { DEFAULT_FONT, type FileSource, type TextSource, type WatermarkSettings } from '../shared'
import {
  applyMarksFromUi,
  CharsetWarning,
  FontFields,
  Group,
  PageRangeFields,
  PresetsBar,
  PreviewPane,
  rangeError,
  Row
} from './common'
import {
  AppearanceFields,
  FileSourceFields,
  PositionFields,
  useSourceLoader,
  VisibilityFields
} from './appearance'

export function WatermarkDialog({
  doc,
  initial,
  mode,
  intent,
  close
}: {
  doc: DocumentModel
  initial: WatermarkSettings
  mode: 'add' | 'replace'
  /** Which command opened the dialog (sets the title); defaults from the mode. */
  intent?: 'add' | 'update'
  close: (ok?: boolean) => void
}) {
  const [s, setS] = useState<WatermarkSettings>(initial)
  // Remember the other source while switching between Text and File.
  const [text, setText] = useState<TextSource>(
    initial.source.kind === 'text'
      ? initial.source
      : { kind: 'text', text: '', font: { ...DEFAULT_FONT, size: 72, color: '#FF0000' }, align: 'center' }
  )
  const [file, setFile] = useState<FileSource | null>(initial.source.kind === 'file' ? initial.source : null)
  const [page, setPage] = useState(() => doc.state.currentPage)
  const [busy, setBusy] = useState(false)
  const pageCount = useDocState(doc, (st) => st.info.pageCount)
  const loader = useSourceLoader(doc)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const inDocument = mode === 'replace' && initial.source.kind === 'file'
  const set = (patch: Partial<WatermarkSettings>) => setS((prev) => ({ ...prev, ...patch }))

  useEffect(() => {
    if (s.source.kind === 'text') textRef.current?.focus()
    // only on open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickText = (t: TextSource) => {
    setText(t)
    set({ source: t })
  }
  const pickFile = (f: FileSource) => {
    setFile(f)
    set({ source: f })
  }

  const load = async (preset: WatermarkSettings) => {
    if (preset.source.kind === 'file') {
      const src = await loader.reload(preset.source)
      if (!src) return
      setFile(src)
      setS({ ...preset, source: src })
    } else {
      setText(preset.source)
      setS(preset)
    }
  }

  const sourceError =
    s.source.kind === 'text'
      ? s.source.text.trim()
        ? null
        : 'Type the watermark text.'
      : !s.source.sourceId && !inDocument
        ? 'Choose a file.'
        : null
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
          ? 'Update Watermark'
          : 'Add Watermark'
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
      <PresetsBar type="Watermark" current={s} onLoad={(p) => void load(p).catch((err) => showError(err))} />
      <div className="fc-page-marks-layout">
        <div className="fc-page-marks-form">
          <Group title="Source">
            <Segmented<'text' | 'file'>
              value={s.source.kind}
              onChange={(k) =>
                k === 'text'
                  ? pickText(text)
                  : file
                    ? pickFile(file)
                    : set({ source: { kind: 'file', fileName: '', page: 1, scale: 100 } })
              }
              options={[
                { value: 'text', label: 'Text' },
                { value: 'file', label: 'File (image or PDF)' }
              ]}
            />
            {s.source.kind === 'text' ? (
              <div className="fc-page-marks-source">
                <textarea
                  ref={textRef}
                  className="ui-input ui-textarea"
                  aria-label="Watermark text"
                  placeholder="e.g. CONFIDENTIAL"
                  rows={2}
                  value={s.source.text}
                  onChange={(e) => pickText({ ...(s.source as TextSource), text: e.target.value })}
                />
                <FontFields
                  font={s.source.font}
                  sizeDisabled={s.relativeScale !== null}
                  onChange={(font) => pickText({ ...(s.source as TextSource), font })}
                  align={{
                    value: s.source.align,
                    onChange: (align) => pickText({ ...(s.source as TextSource), align })
                  }}
                />
                {s.relativeScale !== null && (
                  <div className="fc-page-marks-hint">The size follows “Scale relative to the page”.</div>
                )}
                <CharsetWarning texts={[s.source.text]} />
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
            <AppearanceFields value={s} onChange={set} />
            <Row label="Location">
              <Segmented<'top' | 'behind'>
                value={s.behind ? 'behind' : 'top'}
                onChange={(v) => set({ behind: v === 'behind' })}
                options={[
                  { value: 'top', label: 'On top of the page' },
                  { value: 'behind', label: 'Behind the page' }
                ]}
              />
            </Row>
            <VisibilityFields value={s} onChange={set} />
          </Group>
          <PositionFields value={s.position} onChange={(position) => set({ position })} />
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
