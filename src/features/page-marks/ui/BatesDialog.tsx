import { useEffect, useRef, useState } from 'react'
import { Button, Dialog, TextInput, useDocState, type DocumentModel } from '@renderer/sdk'
import { formatBates, resolvePageRange, SLOT_LABELS, SLOTS, type BatesSettings, type Slot } from '../shared'
import {
  applyMarksFromUi,
  CharsetWarning,
  FontFields,
  Group,
  MarginsFields,
  NumberField,
  PageRangeFields,
  PresetsBar,
  PreviewPane,
  rangeError
} from './common'

export function BatesDialog({
  doc,
  initial,
  mode,
  intent,
  close
}: {
  doc: DocumentModel
  initial: BatesSettings
  mode: 'add' | 'replace'
  /** Which command opened the dialog (sets the title); defaults from the mode. */
  intent?: 'add' | 'update'
  close: (ok?: boolean) => void
}) {
  const [s, setS] = useState<BatesSettings>(initial)
  const [page, setPage] = useState(() => doc.state.currentPage)
  const [busy, setBusy] = useState(false)
  const pageCount = useDocState(doc, (st) => st.info.pageCount)
  const prefixRef = useRef<HTMLInputElement>(null)
  const set = (patch: Partial<BatesSettings>) => setS((prev) => ({ ...prev, ...patch }))
  useEffect(() => prefixRef.current?.focus(), [])

  const error = rangeError(s.range, pageCount)
  const canApply = !error && !busy
  const pages = error ? [] : resolvePageRange(s.range, pageCount)
  const first = formatBates(s, s.start)
  const last = formatBates(s, s.start + Math.max(0, pages.length - 1))

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
          ? 'Update Bates Numbering'
          : 'Add Bates Numbering'
      }
      onClose={() => close(false)}
      width={1000}
      className="fc-page-marks-dialog"
      onSubmit={() => void ok()}
      footer={
        <>
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={!canApply} onClick={() => void ok()}>
            {busy ? 'Applying…' : 'OK'}
          </Button>
        </>
      }
    >
      <PresetsBar type="Bates" current={s} onLoad={setS} />
      <div className="fc-page-marks-layout">
        <div className="fc-page-marks-form">
          <Group title="Bates number">
            <div className="fc-page-marks-bates">
              <label className="fc-page-marks-mini">
                <span>Prefix</span>
                <input
                  ref={prefixRef}
                  type="text"
                  className="ui-input"
                  aria-label="Prefix"
                  value={s.prefix}
                  placeholder="e.g. SMITH-"
                  onChange={(e) => set({ prefix: e.target.value })}
                />
              </label>
              <label className="fc-page-marks-mini">
                <span>Number of digits</span>
                <NumberField
                  label="Number of digits"
                  value={s.digits}
                  min={1}
                  max={15}
                  width={70}
                  onChange={(v) => set({ digits: Math.round(v) })}
                />
              </label>
              <label className="fc-page-marks-mini">
                <span>Start number</span>
                <NumberField
                  label="Start number"
                  value={s.start}
                  min={0}
                  max={999999999999}
                  width={110}
                  onChange={(v) => set({ start: Math.round(v) })}
                />
              </label>
              <label className="fc-page-marks-mini">
                <span>Suffix</span>
                <TextInput
                  aria-label="Suffix"
                  value={s.suffix}
                  placeholder="e.g. -CONF"
                  onChange={(e) => set({ suffix: e.target.value })}
                />
              </label>
            </div>
            <div className="fc-page-marks-hint" aria-live="polite">
              {pages.length > 1 ? (
                <>
                  Numbers will run from <b>{first}</b> to <b>{last}</b>.
                </>
              ) : (
                <>
                  The number will be <b>{first}</b>.
                </>
              )}
            </div>
            <CharsetWarning texts={[s.prefix, s.suffix]} />
          </Group>
          <Group title="Position">
            <div className="fc-page-marks-slotpicker" role="radiogroup" aria-label="Position on the page">
              {SLOTS.map((slot: Slot) => (
                <button
                  key={slot}
                  type="button"
                  role="radio"
                  aria-checked={s.slot === slot}
                  className={`fc-page-marks-slotbtn ${s.slot === slot ? 'is-active' : ''}`}
                  onClick={() => set({ slot })}
                >
                  {SLOT_LABELS[slot]}
                </button>
              ))}
            </div>
            <MarginsFields margins={s.margins} onChange={(margins) => set({ margins })} />
          </Group>
          <Group title="Font">
            <FontFields font={s.font} onChange={(font) => set({ font })} />
          </Group>
          <Group title="Page range">
            <PageRangeFields
              range={s.range}
              onChange={(range) => set({ range })}
              pageCount={pageCount}
              currentPage={doc.state.currentPage}
            />
            <div className="fc-page-marks-hint">Bates numbers are added to this document only.</div>
          </Group>
        </div>
        <PreviewPane doc={doc} settings={s} mode={mode} page={page} onPageChange={setPage} />
      </div>
    </Dialog>
  )
}
