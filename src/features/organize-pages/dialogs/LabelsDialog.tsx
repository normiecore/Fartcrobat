import { useEffect, useId, useState } from 'react'
import {
  Button,
  Dialog,
  Field,
  NumberInput,
  openDialog,
  Radio,
  Select,
  showError,
  TextInput,
  toast,
  type DocumentModel
} from '@renderer/sdk'
import { afterChange, pagesOps } from '../actions'
import { orgOps } from '../files'
import { applyLabelSection, LABEL_STYLES, labelsFor, type LabelRange, type LabelStyle } from '../labels'
import { Summary } from './common'

type Span = 'all' | 'range'

function LabelsDialog({
  doc,
  selected,
  close
}: {
  doc: DocumentModel
  selected: number[]
  close: () => void
}) {
  const id = useId()
  const count = doc.pageCount
  const [ranges, setRanges] = useState<LabelRange[] | null>(null)
  const [span, setSpan] = useState<Span>(selected.length ? 'range' : 'all')
  const [from, setFrom] = useState((selected[0] ?? doc.state.currentPage) + 1)
  const [to, setTo] = useState((selected.length ? selected[selected.length - 1] : doc.state.currentPage) + 1)
  const [mode, setMode] = useState<'new' | 'extend'>('new')
  const [style, setStyle] = useState<LabelStyle>('D')
  const [prefix, setPrefix] = useState('')
  const [start, setStart] = useState(1)

  useEffect(() => {
    let alive = true
    orgOps(doc)
      .labelRanges()
      .then((r) => alive && setRanges(r))
      .catch((err) => {
        showError(err, 'Could not read the page labels')
        if (alive) setRanges([])
      })
    return () => {
      alive = false
    }
  }, [doc])

  const lo = span === 'all' ? 0 : Math.max(1, Math.min(from, to, count)) - 1
  const hi = span === 'all' ? count - 1 : Math.min(count, Math.max(from, to, 1)) - 1
  const next = ranges
    ? applyLabelSection(
        ranges,
        lo,
        hi,
        count,
        mode === 'extend' ? 'extend' : { style, prefix, first: Math.max(1, Math.round(start) || 1) }
      )
    : null
  const preview = next ? labelsFor(next, count) : []
  const sample = preview.slice(lo, Math.min(hi + 1, lo + 4))

  const apply = async (value: LabelRange[]) => {
    close()
    try {
      await afterChange(doc, () =>
        pagesOps(doc).setLabels(
          value.map((r) => ({ start: r.start, style: r.style, prefix: r.prefix, first: r.first }))
        )
      )
      toast(value.length ? 'Page labels updated' : 'Page labels removed', { kind: 'success', timeout: 2500 })
    } catch (err) {
      showError(err, 'Could not change the page labels')
    }
  }

  return (
    <Dialog
      title="Page Labels"
      onClose={close}
      onSubmit={() => next && void apply(next)}
      width={500}
      footer={
        <>
          <Button
            variant="quiet"
            disabled={!ranges?.length}
            onClick={() => void apply([])}
            title="Use plain page numbers again"
          >
            Remove all labels
          </Button>
          <span className="fc-organize-pages-spacer" />
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!next} onClick={() => next && void apply(next)}>
            OK
          </Button>
        </>
      }
    >
      <div className="ui-dialog-message shell-muted">
        Page labels are the page numbers shown in the toolbar and thumbnails, like “i, ii, iii” for a preface.
        They don't change the pages.
      </div>
      <fieldset className="fc-organize-pages-fieldset">
        <legend>Pages</legend>
        <Radio
          name={`${id}-span`}
          checked={span === 'all'}
          onChange={() => setSpan('all')}
          label={`All pages (${count})`}
        />
        <div className="fc-organize-pages-range-row">
          <Radio
            name={`${id}-span`}
            checked={span === 'range'}
            onChange={() => setSpan('range')}
            label="From"
          />
          <NumberInput
            aria-label="From page"
            min={1}
            max={count}
            value={from}
            onFocus={() => setSpan('range')}
            onChange={setFrom}
          />
          <span>to</span>
          <NumberInput
            aria-label="To page"
            min={1}
            max={count}
            value={to}
            onFocus={() => setSpan('range')}
            onChange={setTo}
          />
          <span className="shell-muted">of {count}</span>
        </div>
      </fieldset>
      <fieldset className="fc-organize-pages-fieldset">
        <legend>Numbering</legend>
        <Radio
          name={`${id}-mode`}
          checked={mode === 'new'}
          onChange={() => setMode('new')}
          label="Begin new section"
        />
        <div
          className={`fc-organize-pages-indent fc-organize-pages-row3 ${mode === 'new' ? '' : 'is-disabled'}`}
        >
          <Field label="Style">
            <Select<LabelStyle>
              value={style}
              onChange={setStyle}
              disabled={mode !== 'new'}
              options={LABEL_STYLES.map((s) => ({ value: s.value, label: s.label }))}
            />
          </Field>
          <Field label="Prefix">
            <TextInput
              value={prefix}
              disabled={mode !== 'new'}
              placeholder="e.g. A-"
              onChange={(e) => setPrefix(e.target.value)}
            />
          </Field>
          <Field label="Start">
            <NumberInput
              min={1}
              value={start}
              disabled={mode !== 'new' || style === ''}
              onChange={setStart}
            />
          </Field>
        </div>
        <Radio
          name={`${id}-mode`}
          checked={mode === 'extend'}
          onChange={() => setMode('extend')}
          label="Continue the numbering of the previous section"
        />
      </fieldset>
      <Summary>
        {ranges === null ? (
          'Reading page labels…'
        ) : (
          <>
            Sample: {sample.map((s) => s || '(blank)').join(', ')}
            {hi - lo + 1 > sample.length ? ', …' : ''}
          </>
        )}
      </Summary>
    </Dialog>
  )
}

/** Page Labels… (Acrobat: Organize Pages > More > Page Labels / Number Pages). */
export async function openLabelsDialog(doc: DocumentModel, selected: number[]): Promise<void> {
  await openDialog((close) => <LabelsDialog doc={doc} selected={selected} close={() => close()} />)
}
