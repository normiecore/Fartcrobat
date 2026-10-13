import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, Dialog, Select, useDocState, type DocumentModel } from '@renderer/sdk'
import {
  DATE_FORMATS,
  formatDate,
  PAGE_NUMBER_FORMATS,
  SLOT_LABELS,
  SLOTS,
  type HeaderFooterSettings,
  type Slot
} from '../shared'
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

export function HeaderFooterDialog({
  doc,
  initial,
  mode,
  intent,
  close
}: {
  doc: DocumentModel
  initial: HeaderFooterSettings
  mode: 'add' | 'replace'
  /** Which command opened the dialog (sets the title); defaults from the mode. */
  intent?: 'add' | 'update'
  close: (ok?: boolean) => void
}) {
  const [s, setS] = useState<HeaderFooterSettings>(initial)
  const [page, setPage] = useState(() => doc.state.currentPage)
  const [busy, setBusy] = useState(false)
  const [numberFormat, setNumberFormat] = useState('Page 1 of n')
  const [dateFormat, setDateFormat] = useState(DATE_FORMATS[0])
  const pageCount = useDocState(doc, (st) => st.info.pageCount)
  const boxes = useRef<Partial<Record<Slot, HTMLTextAreaElement | null>>>({})
  const lastSlot = useRef<Slot>('footerCenter')
  const set = (patch: Partial<HeaderFooterSettings>) => setS((prev) => ({ ...prev, ...patch }))
  // Start typing in the centre footer, where page numbers usually go.
  useEffect(() => boxes.current.footerCenter?.focus(), [])
  const setText = (slot: Slot, value: string) =>
    setS((prev) => ({ ...prev, text: { ...prev.text, [slot]: value } }))

  const insert = (token: string) => {
    const slot = lastSlot.current
    const el = boxes.current[slot]
    const value = s.text[slot]
    const start = el ? el.selectionStart : value.length
    const end = el ? el.selectionEnd : value.length
    const next = value.slice(0, start) + token + value.slice(end)
    setText(slot, next)
    requestAnimationFrame(() => {
      if (!el) return
      el.focus()
      el.setSelectionRange(start + token.length, start + token.length)
    })
  }

  const hasText = SLOTS.some((k) => s.text[k].trim())
  const error = rangeError(s.range, pageCount)
  const canApply = hasText && !error && !busy

  const ok = async () => {
    if (!canApply) return
    setBusy(true)
    const done = await applyMarksFromUi(doc, { ...s, date: new Date().toISOString() }, mode)
    setBusy(false)
    if (done) close(true)
  }

  const title =
    (intent ?? (mode === 'replace' ? 'update' : 'add')) === 'update'
      ? 'Update Header & Footer'
      : 'Add Header & Footer'
  return (
    <Dialog
      title={title}
      onClose={() => close(false)}
      width={1000}
      className="fc-page-marks-dialog"
      footer={
        <>
          {!hasText && <span className="fc-page-marks-footer-hint">Type text in at least one box.</span>}
          <Button onClick={() => close(false)}>Cancel</Button>
          <Button variant="primary" disabled={!canApply} onClick={() => void ok()}>
            {busy ? 'Applying…' : 'OK'}
          </Button>
        </>
      }
    >
      <PresetsBar
        type="HeaderFooter"
        current={s}
        onLoad={(p) => setS({ ...p, date: new Date().toISOString() })}
      />
      <div className="fc-page-marks-layout">
        <div className="fc-page-marks-form">
          <Group title="Font">
            <FontFields font={s.font} onChange={(font) => set({ font })} />
          </Group>
          <Group title="Margins">
            <MarginsFields margins={s.margins} onChange={(margins) => set({ margins })} />
          </Group>
          <Group title="Text" className="fc-page-marks-slots-group">
            <div className="fc-page-marks-slots">
              {SLOTS.map((slot) => (
                <label key={slot} className="fc-page-marks-slot">
                  <span>{SLOT_LABELS[slot]} text</span>
                  <textarea
                    ref={(el) => {
                      boxes.current[slot] = el
                    }}
                    className="ui-input ui-textarea"
                    rows={2}
                    value={s.text[slot]}
                    spellCheck={false}
                    data-slot={slot}
                    onFocus={() => {
                      lastSlot.current = slot
                    }}
                    onChange={(e) => setText(slot, e.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="fc-page-marks-insert">
              <div className="fc-page-marks-insert-item">
                <span className="fc-page-marks-row-label">Page number</span>
                <Select<string>
                  aria-label="Page number format"
                  value={numberFormat}
                  onChange={setNumberFormat}
                  options={PAGE_NUMBER_FORMATS.map((f) => ({ value: f.id, label: f.label }))}
                />
                <Button
                  size="sm"
                  aria-label="Insert page number"
                  onClick={() => insert(PAGE_NUMBER_FORMATS.find((f) => f.id === numberFormat)!.insert)}
                >
                  Insert
                </Button>
              </div>
              <div className="fc-page-marks-insert-item">
                <span className="fc-page-marks-row-label">Date</span>
                <Select<string>
                  aria-label="Date format"
                  value={dateFormat}
                  onChange={setDateFormat}
                  options={DATE_FORMATS.map((f) => ({
                    value: f,
                    label: `${f}  (${formatDate(f, new Date())})`
                  }))}
                />
                <Button size="sm" aria-label="Insert date" onClick={() => insert(`<<${dateFormat}>>`)}>
                  Insert
                </Button>
              </div>
            </div>
            <div className="fc-page-marks-hint">
              Tip: click in a box first. <code>&lt;&lt;1&gt;&gt;</code> is the page number and{' '}
              <code>&lt;&lt;n&gt;&gt;</code> the last page number. Press Enter for a second line.
            </div>
            <CharsetWarning texts={SLOTS.map((k) => s.text[k])} />
          </Group>
          <Group title="Page numbers and range">
            <div className="fc-page-marks-inline">
              <label className="fc-page-marks-mini">
                <span>Start page number</span>
                <NumberField
                  label="Start page number"
                  value={s.startNumber}
                  min={0}
                  max={999999}
                  width={80}
                  onChange={(v) => set({ startNumber: Math.round(v) })}
                />
              </label>
              <span className="fc-page-marks-hint">The first page in the range gets this number.</span>
            </div>
            <PageRangeFields
              range={s.range}
              onChange={(range) => set({ range })}
              pageCount={pageCount}
              currentPage={doc.state.currentPage}
            />
            <Checkbox
              checked={s.shrink}
              onChange={(shrink) => set({ shrink })}
              label="Shrink the page content so the header and footer don’t cover it"
            />
          </Group>
        </div>
        <PreviewPane doc={doc} settings={s} mode={mode} page={page} onPageChange={setPage} />
      </div>
    </Dialog>
  )
}
