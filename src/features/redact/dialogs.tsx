import { useEffect, useRef, useState } from 'react'
import { CircleCheck, ShieldAlert } from 'lucide-react'
import {
  Button,
  Checkbox,
  Dialog,
  Radio,
  TextInput,
  getActiveDoc,
  openDialog,
  showError,
  toast,
  type DocumentModel
} from '@renderer/sdk'
import { HIDDEN_ITEMS, type HiddenItemId, type HiddenScan, type MarkInfo, type SanitizeReport } from './shared'
import { markNeedsReload, markSpecs, pagesPhrase, plural, runWithProgress, saveRedactedCopy } from './actions'
import { refreshMarks } from './store'

type RedactOps = typeof import('./engine').default

// ---- Apply ----------------------------------------------------------------------------------------

function ApplyDialog({
  marks,
  total,
  signed,
  close
}: {
  marks: MarkInfo[]
  total: number
  signed: number
  close: (r?: { removeHidden: boolean }) => void
}) {
  const [removeHidden, setRemoveHidden] = useState(true)
  const pages = pagesPhrase(marks.map((m) => m.page), total)
  return (
    <Dialog
      title="Apply redactions"
      onClose={() => close()}
      width={500}
      className="fc-redact-dialog"
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="danger" data-autofocus onClick={() => close({ removeHidden })}>
            Apply
          </Button>
        </>
      }
    >
      <div className="ui-dialog-message">
        <p className="fc-redact-apply-lead">
          {marks.length === 1 ? 'The content under 1 redaction mark' : `The content under ${marks.length} redaction marks`} on {pages} will be removed:
          text, images and drawings under the marks, and comments and form fields in those areas.
        </p>
        <div className="fc-redact-warning" role="note">
          <ShieldAlert size={18} />
          <span>Redaction marks will be applied permanently and cannot be undone after you save.</span>
        </div>
        {signed > 0 && (
          <p className="fc-redact-note">
            This document has {signed === 1 ? 'a digital signature' : `${signed} digital signatures`}. Redacting changes the signed
            content, so {signed === 1 ? 'the signature' : 'the signatures'} will no longer be valid.
          </p>
        )}
      </div>
      <Checkbox checked={removeHidden} onChange={setRemoveHidden} label="Also remove hidden information" />
      <div className="ui-field-hint fc-redact-indent">Metadata, attachments, comments, hidden text and other information you may not see on the page.</div>
    </Dialog>
  )
}

export async function openApplyDialog(marks: MarkInfo[], total: number, signed = 0) {
  return openDialog<{ removeHidden: boolean }>((close) => <ApplyDialog marks={marks} total={total} signed={signed} close={close} />)
}

/** Asks for confirmation, then applies all marks (or the given ones). */
export async function applyRedactions(doc: DocumentModel | null = getActiveDoc(), ids?: number[]) {
  if (!doc) return
  const all = await refreshMarks(doc)
  const marks = ids?.length ? all.filter((m) => ids.includes(m.id)) : all
  if (!marks.length) {
    toast('There are no redaction marks to apply. Mark text or areas first.', { kind: 'info' })
    return
  }
  const answer = await openApplyDialog(marks, doc.pageCount, doc.info.signatureCount)
  if (!answer) return
  try {
    const report = await runWithProgress('Applying redactions…', (onProgress) =>
      doc.ops<RedactOps>('redact', { onProgress }).apply(ids?.length ? marks.map((m) => m.id) : null)
    )
    markNeedsReload(doc)
    doc.clearSelection()
    const extra: string[] = []
    if (report.removedAnnotations) extra.push(plural(report.removedAnnotations, 'comment'))
    if (report.removedFields) extra.push(plural(report.removedFields, 'form field'))
    const msg = `Applied ${plural(report.marks, 'redaction')} on ${pagesPhrase(report.pages, doc.pageCount)}${
      extra.length ? ` and removed ${extra.join(' and ')} in the redacted areas` : ''
    }.`
    if (answer.removeHidden) {
      toast(msg, { kind: 'success' })
      await openSanitizeDialog(doc, { afterApply: true })
    } else {
      toast(`${msg} Save the document to make it permanent.`, {
        kind: 'success',
        timeout: 10000,
        action: { label: 'Save As…', run: () => void saveRedactedCopy(doc) }
      })
    }
  } catch (err) {
    showError(err, 'Could not apply redactions')
  }
}

// ---- Remove hidden information --------------------------------------------------------------------

const UNITS: Record<HiddenItemId, [string, string]> = {
  metadata: ['item', 'items'],
  attachments: ['file', 'files'],
  bookmarks: ['bookmark', 'bookmarks'],
  comments: ['comment', 'comments'],
  forms: ['field', 'fields'],
  hiddenText: ['character', 'characters'],
  hiddenLayers: ['layer', 'layers'],
  searchIndex: ['index', 'indexes'],
  javascript: ['script', 'scripts'],
  externalLinks: ['link', 'links'],
  overlapping: ['character', 'characters']
}

function countLabel(id: HiddenItemId, n: number) {
  if (!n) return 'None found'
  const [one, many] = UNITS[id]
  return `${n} ${n === 1 ? one : many}`
}

type Phase = { kind: 'scanning'; fraction: number } | { kind: 'choose'; scan: HiddenScan } | { kind: 'working' } | { kind: 'done'; report: SanitizeReport }

function SanitizeDialog({ doc, afterApply, close }: { doc: DocumentModel; afterApply: boolean; close: () => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning', fraction: 0 })
  const [checked, setChecked] = useState<Partial<Record<HiddenItemId, boolean>>>({})
  const [forms, setForms] = useState<'flatten' | 'remove'>('flatten')
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    let alive = true
    doc
      .ops<RedactOps>('redact', { onProgress: (fraction) => alive && setPhase({ kind: 'scanning', fraction }) })
      .scanHidden()
      .then((scan) => {
        if (!alive) return
        const initial: Partial<Record<HiddenItemId, boolean>> = {}
        for (const it of HIDDEN_ITEMS) initial[it.id] = scan[it.id].count > 0 && !it.optional
        setChecked(initial)
        setPhase({ kind: 'choose', scan })
      })
      .catch((err) => {
        if (!alive) return
        showError(err, 'Could not examine the document')
        closeRef.current()
      })
    return () => {
      alive = false
    }
  }, [doc])

  const selected = HIDDEN_ITEMS.filter((it) => checked[it.id]).map((it) => it.id)

  const remove = async () => {
    setPhase({ kind: 'working' })
    try {
      const report = await doc.ops<RedactOps>('redact').sanitize({ items: selected, forms })
      markNeedsReload(doc)
      setPhase({ kind: 'done', report })
    } catch (err) {
      showError(err, 'Could not remove hidden information')
      close()
    }
  }

  let body: React.ReactNode
  let footer: React.ReactNode
  if (phase.kind === 'scanning' || phase.kind === 'working') {
    body = (
      <div className="fc-redact-scanning" role="status">
        <div className={`progress-bar ${phase.kind === 'working' || phase.fraction === 0 ? 'is-indeterminate' : ''}`}>
          <div style={{ width: phase.kind === 'scanning' && phase.fraction ? `${Math.round(phase.fraction * 100)}%` : '30%' }} />
        </div>
        <span className="shell-muted">{phase.kind === 'scanning' ? 'Looking for hidden information…' : 'Removing…'}</span>
      </div>
    )
    footer = <Button onClick={close} disabled={phase.kind === 'working'}>Cancel</Button>
  } else if (phase.kind === 'choose') {
    const found = HIDDEN_ITEMS.filter((it) => phase.scan[it.id].count > 0).length
    body = (
      <>
        <p className="ui-dialog-message">
          {found
            ? 'Choose what to remove from this document. The items are removed now and leave the file when you save.'
            : 'No hidden information was found in this document.'}
        </p>
        <ul className="fc-redact-hidden-list" aria-label="Hidden information">
          {HIDDEN_ITEMS.map((it) => {
            const item = phase.scan[it.id]
            const disabled = item.count === 0
            return (
              <li key={it.id} className={`fc-redact-hidden-item ${disabled ? 'is-empty' : ''}`}>
                <label className="fc-redact-hidden-row">
                  <input
                    type="checkbox"
                    checked={!!checked[it.id]}
                    disabled={disabled}
                    onChange={(e) => setChecked((c) => ({ ...c, [it.id]: e.target.checked }))}
                    aria-describedby={`fc-redact-hidden-${it.id}`}
                  />
                  <span className="fc-redact-hidden-label">{it.label}</span>
                  <span className={`fc-redact-badge ${disabled ? '' : 'is-found'}`}>{countLabel(it.id, item.count)}</span>
                </label>
                <div id={`fc-redact-hidden-${it.id}`} className="fc-redact-hidden-desc">
                  {it.description}
                  {item.details.length > 0 && <span className="fc-redact-hidden-details">{item.details.join(' · ')}</span>}
                </div>
                {it.id === 'forms' && checked.forms && !disabled && (
                  <div className="fc-redact-hidden-sub" role="radiogroup" aria-label="Form fields">
                    <Radio name="fc-redact-forms" checked={forms === 'flatten'} onChange={() => setForms('flatten')} label="Flatten: keep how the fields look, remove the fields" />
                    <Radio name="fc-redact-forms" checked={forms === 'remove'} onChange={() => setForms('remove')} label="Remove the fields and the values typed into them" />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      </>
    )
    footer = (
      <>
        <Button onClick={close}>{found ? 'Cancel' : 'Close'}</Button>
        {found > 0 && (
          <Button variant="danger" disabled={!selected.length} onClick={() => void remove()}>
            Remove
          </Button>
        )}
      </>
    )
  } else {
    const order = HIDDEN_ITEMS.map((it) => it.id)
    const removed = [...phase.report.removed].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    body = (
      <div className="fc-redact-done">
        <div className="fc-redact-done-head">
          <CircleCheck size={22} />
          <span>{removed.length ? 'Hidden information was removed.' : 'Nothing needed to be removed.'}</span>
        </div>
        {removed.length > 0 && (
          <ul className="fc-redact-done-list">
            {removed.map((r) => (
              <li key={r.id}>
                <span>{HIDDEN_ITEMS.find((it) => it.id === r.id)?.label}</span>
                <span className="fc-redact-badge">{countLabel(r.id, r.count)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="shell-muted">
          {afterApply ? 'Redactions and removals ' : 'The removals '}are permanent once you save the document. Until then you can still undo
          them.
        </p>
      </div>
    )
    footer = (
      <>
        <Button onClick={close}>Close</Button>
        <Button
          variant="primary"
          onClick={() => {
            close()
            void saveRedactedCopy(doc)
          }}
        >
          Save As…
        </Button>
      </>
    )
  }

  return (
    <Dialog title="Remove hidden information" onClose={close} width={600} className="fc-redact-dialog fc-redact-sanitize" footer={footer}>
      {body}
    </Dialog>
  )
}

export async function openSanitizeDialog(doc: DocumentModel | null = getActiveDoc(), opts: { afterApply?: boolean } = {}) {
  if (!doc) return
  await openDialog((close) => <SanitizeDialog doc={doc} afterApply={!!opts.afterApply} close={() => close()} />)
}

// ---- Mark page range ------------------------------------------------------------------------------

type RangeMode = 'current' | 'all' | 'even' | 'odd' | 'custom'

/** Parses "1-3, 5, 8-" into 0-based page indices. Returns an error message for invalid input. */
export function parsePageRange(input: string, count: number): number[] | string {
  const out = new Set<number>()
  const parts = input
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean)
  if (!parts.length) return 'Enter pages, for example 1-3, 5'
  for (const part of parts) {
    const m = /^(\d+)?\s*(?:(-)\s*(\d+)?)?$/.exec(part)
    if (!m || (!m[1] && !m[3])) return `“${part}” is not a page or range`
    const a = m[1] ? parseInt(m[1], 10) : 1
    const b = m[2] ? (m[3] ? parseInt(m[3], 10) : count) : a
    if (a < 1 || b < 1 || a > count || b > count) return `Pages go from 1 to ${count}`
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) out.add(p - 1)
  }
  return [...out].sort((x, y) => x - y)
}

function PageRangeDialog({ doc, close }: { doc: DocumentModel; close: (pages?: number[]) => void }) {
  const count = doc.pageCount
  const current = doc.state.currentPage
  const [mode, setMode] = useState<RangeMode>('current')
  const [custom, setCustom] = useState(`${current + 1}`)
  const pages: number[] | string =
    mode === 'current'
      ? [current]
      : mode === 'all'
        ? [...Array(count).keys()]
        : mode === 'even'
          ? [...Array(count).keys()].filter((i) => i % 2 === 1)
          : mode === 'odd'
            ? [...Array(count).keys()].filter((i) => i % 2 === 0)
            : parsePageRange(custom, count)
  const error = typeof pages === 'string' ? pages : pages.length === 0 ? 'No pages match' : null
  const submit = () => {
    if (!error && typeof pages !== 'string') close(pages)
  }
  return (
    <Dialog
      title="Mark page range"
      onClose={() => close()}
      onSubmit={submit}
      width={440}
      className="fc-redact-dialog"
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" disabled={!!error} onClick={submit}>
            Mark {typeof pages !== 'string' && pages.length ? plural(pages.length, 'page') : 'pages'}
          </Button>
        </>
      }
    >
      <p className="ui-dialog-message">Everything on these pages is removed when you apply the redactions.</p>
      <div className="fc-redact-range" role="radiogroup" aria-label="Pages">
        <Radio name="fc-redact-range" checked={mode === 'current'} onChange={() => setMode('current')} label={`Current page (${current + 1})`} />
        <Radio name="fc-redact-range" checked={mode === 'all'} onChange={() => setMode('all')} label={`All pages (${count})`} />
        <Radio name="fc-redact-range" checked={mode === 'even'} onChange={() => setMode('even')} label="Even pages only" />
        <Radio name="fc-redact-range" checked={mode === 'odd'} onChange={() => setMode('odd')} label="Odd pages only" />
        <div className="fc-redact-range-custom">
          <Radio name="fc-redact-range" checked={mode === 'custom'} onChange={() => setMode('custom')} label="Pages" />
          <TextInput
            aria-label="Page range"
            value={custom}
            placeholder="e.g. 1-3, 5"
            onFocus={() => setMode('custom')}
            onChange={(e) => {
              setMode('custom')
              setCustom(e.target.value)
            }}
          />
        </div>
        {mode === 'custom' && error && <span className="ui-field-error">{error}</span>}
      </div>
    </Dialog>
  )
}

export async function openPageRangeDialog(doc: DocumentModel | null = getActiveDoc()) {
  if (!doc) return
  const pages = await openDialog<number[]>((close) => <PageRangeDialog doc={doc} close={close} />)
  if (!pages?.length) return
  const info = doc.state.info
  const marks = await markSpecs(
    doc,
    pages.map((p) => ({ page: p, kind: 'page' as const, rect: [0, 0, info.pages[p].width, info.pages[p].height] as [number, number, number, number] }))
  )
  if (marks.length) toast(`Marked ${plural(marks.length, 'page')} for redaction.`, { kind: 'success', timeout: 3000 })
}
