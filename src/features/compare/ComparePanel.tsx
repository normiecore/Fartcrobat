import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ArrowDownUp, CheckCircle2, FileOutput, GitCompareArrows, RefreshCw, RotateCcw } from 'lucide-react'
import {
  Button,
  Checkbox,
  IconButton,
  Radio,
  Section,
  Select,
  TextInput,
  ToolPanelFrame,
  type DocumentModel
} from '@renderer/sdk'
import { describeChange, describeLocation } from './core'
import { compareBlocker, exportReport, newComparison, runCompare, selectChange, setOptions, slotPages, stepChange } from './actions'
import { ChooseFileButton, dropProps, SIDE_LABEL, SlotStatus } from './FileChoice'
import { chooseTab, swapSlots } from './sources'
import { ALL_FILTER, getCompare, patchSlot, setCompare, useCompare, type Side } from './store'
import { CATEGORY_LABELS, categoryOf, type ChangeCategory } from './types'

const MAX_LIST = 3000

function SlotRow({ side }: { side: Side }) {
  const slot = useCompare((s) => s.slots[side])
  const [over, setOver] = useState(false)
  const pages = slotPages(slot)
  const error = slot.doc && !slot.allPages && 'error' in pages ? pages.error : null
  return (
    <div className={`fc-compare-slot ${over ? 'is-drop' : ''}`} {...dropProps(side, setOver)}>
      <div className="fc-compare-slot-head">
        <span className={`fc-compare-tag fc-compare-tag--${side}`}>{side === 'old' ? 'Old' : 'New'}</span>
        <span className="fc-compare-slot-name" title={slot.path ?? slot.name}>
          {slot.name || <span className="fc-compare-muted">Choose the {SIDE_LABEL[side].toLowerCase()}</span>}
        </span>
      </div>
      <div className="fc-compare-slot-row">
        <SlotStatus side={side} />
        <ChooseFileButton side={side} />
      </div>
      {slot.doc && (
        <div className="fc-compare-range">
          <Select
            aria-label={`Pages of the ${SIDE_LABEL[side].toLowerCase()}`}
            value={slot.allPages ? 'all' : 'custom'}
            onChange={(v) => patchSlot(side, { allPages: v === 'all', range: slot.range || `1-${slot.doc!.pageCount}` })}
            options={[
              { value: 'all', label: 'All pages' },
              { value: 'custom', label: 'Pages…' }
            ]}
          />
          {!slot.allPages && (
            <TextInput
              aria-label={`Page range of the ${SIDE_LABEL[side].toLowerCase()}`}
              value={slot.range}
              placeholder="e.g. 1-3, 5"
              onChange={(e) => patchSlot(side, { range: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void runCompare()
              }}
            />
          )}
        </div>
      )}
      {error && <div className="ui-field-error fc-compare-range-error">{error}</div>}
    </div>
  )
}

function SetupPanel() {
  const options = useCompare((s) => s.options)
  const running = useCompare((s) => !!s.running)
  // Recomputed on every store change so the button state follows the slots.
  const blocker = useCompare(() => compareBlocker())
  return (
    <ToolPanelFrame
      title="Compare files"
      footer={
        <Button
          variant="primary"
          icon={GitCompareArrows}
          disabled={!!blocker || running}
          title={blocker ?? 'Compare the two files'}
          onClick={() => void runCompare()}
        >
          Compare
        </Button>
      }
    >
      <p className="fc-compare-intro">See every difference between two versions of a document, side by side.</p>
      <Section title="Files">
        <SlotRow side="old" />
        <div className="fc-compare-swap">
          <IconButton icon={ArrowDownUp} label="Swap old and new files" size={16} onClick={swapSlots} />
        </div>
        <SlotRow side="new" />
      </Section>
      <Section title="Compare">
        <div className="fc-compare-options">
          <Radio name="fc-compare-mode" checked={options.mode === 'text'} onChange={() => setOptions({ mode: 'text' })} label="Text only" />
          <Radio
            name="fc-compare-mode"
            checked={options.mode === 'text-images'}
            onChange={() => setOptions({ mode: 'text-images' })}
            label="Text and images"
          />
        </div>
      </Section>
      <Section title="Ignore">
        <div className="fc-compare-options">
          <Checkbox
            checked={options.ignoreWhitespace}
            onChange={(v) => setOptions({ ignoreWhitespace: v })}
            label="Differences in spaces and line breaks"
          />
          <Checkbox checked={options.ignoreCase} onChange={(v) => setOptions({ ignoreCase: v })} label="Upper and lower case" />
        </div>
      </Section>
      <Section title="Also report">
        <div className="fc-compare-options">
          <Checkbox
            checked={options.formatting}
            onChange={(v) => setOptions({ formatting: v })}
            label="Formatting changes (font, size, colour)"
          />
        </div>
      </Section>
    </ToolPanelFrame>
  )
}

const CATEGORY_ORDER: ChangeCategory[] = ['replaced', 'inserted', 'deleted', 'formatting', 'image', 'page']

function ResultsPanel() {
  const session = useCompare((s) => s.session)!
  const filter = useCompare((s) => s.filter)
  const selected = useCompare((s) => s.selected)
  const stale = useCompare((s) => s.stale)
  const running = useCompare((s) => !!s.running)
  const listRef = useRef<HTMLDivElement>(null)
  const { result } = session
  const changes = result.changes.filter((c) => filter[categoryOf(c.type)])
  const filtered = CATEGORY_ORDER.some((k) => !filter[k])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-change-id="${selected}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const toggle = (k: ChangeCategory) => {
    const f = getCompare().filter
    // First click shows only that kind; further clicks add or remove kinds.
    const next = !filtered ? { replaced: false, inserted: false, deleted: false, formatting: false, image: false, page: false, [k]: true } : { ...f, [k]: !f[k] }
    if (!CATEGORY_ORDER.some((c) => next[c])) setCompare({ filter: { ...ALL_FILTER } })
    else setCompare({ filter: next })
    const sel = getCompare().selected
    const still = result.changes.find((c) => c.id === sel && getCompare().filter[categoryOf(c.type)])
    if (!still) selectChange(result.changes.find((c) => getCompare().filter[categoryOf(c.type)])?.id ?? null)
  }

  const total = result.changes.length
  return (
    <ToolPanelFrame
      title="Compare results"
      footer={
        <Button variant="primary" icon={FileOutput} onClick={() => void exportReport()} disabled={running}>
          Export report
        </Button>
      }
    >
      <div className="fc-compare-summary">
        <div className="fc-compare-files">
          <div title={session.old.path ?? session.old.name}>
            <span className="fc-compare-tag fc-compare-tag--old">Old</span> {session.old.name}
          </div>
          <div title={session.new.path ?? session.new.name}>
            <span className="fc-compare-tag fc-compare-tag--new">New</span> {session.new.name}
          </div>
        </div>
        <Button variant="quiet" size="sm" icon={RotateCcw} onClick={newComparison} disabled={running} className="fc-compare-new">
          New comparison
        </Button>
        {total === 0 ? (
          <div className="fc-compare-same">
            <CheckCircle2 size={20} />
            <span>No differences found. The documents are the same.</span>
          </div>
        ) : (
          <div className="fc-compare-total">
            <b>{total}</b> {total === 1 ? 'change' : 'changes'}
            {result.pageByPage && <span className="fc-compare-muted"> · compared page by page</span>}
          </div>
        )}
      </div>
      {stale && (
        <div className="fc-compare-stale" role="status">
          <AlertTriangle size={16} />
          <span>{stale}</span>
          <Button size="sm" icon={RefreshCw} onClick={() => void runCompare()} disabled={running || !!compareBlocker()}>
            Compare again
          </Button>
        </div>
      )}
      {total > 0 && (
        <>
          <div className="fc-compare-filters" role="group" aria-label="Show changes of these kinds">
            {CATEGORY_ORDER.map((k) => (
              <button
                key={k}
                type="button"
                className={`fc-compare-chip fc-compare-chip--${k} ${filter[k] && filtered ? 'is-on' : ''}`}
                aria-pressed={filter[k]}
                disabled={!result.counts[k]}
                onClick={() => toggle(k)}
                title={filtered && filter[k] ? `Hide ${CATEGORY_LABELS[k].toLowerCase()}` : `Show only ${CATEGORY_LABELS[k].toLowerCase()}`}
              >
                <span className="fc-compare-swatch" />
                {CATEGORY_LABELS[k]}
                <span className="fc-compare-chip-count">{result.counts[k]}</span>
              </button>
            ))}
            {filtered && (
              <button type="button" className="fc-compare-chip fc-compare-chip--all" onClick={() => setCompare({ filter: { ...ALL_FILTER } })}>
                Show all
              </button>
            )}
          </div>
          <div
            ref={listRef}
            className="fc-compare-list"
            role="listbox"
            aria-label="Changes"
            tabIndex={-1}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                stepChange(e.key === 'ArrowDown' ? 1 : -1)
                requestAnimationFrame(() =>
                  listRef.current?.querySelector<HTMLElement>(`[data-change-id="${getCompare().selected}"]`)?.focus()
                )
              }
            }}
          >
            {changes.slice(0, MAX_LIST).map((c) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={c.id === selected}
                data-change-id={c.id}
                className={`fc-compare-item fc-compare-item--${categoryOf(c.type)} ${c.id === selected ? 'is-selected' : ''}`}
                onClick={() => selectChange(c.id)}
              >
                <span className="fc-compare-item-bar" />
                <span className="fc-compare-item-body">
                  <span className="fc-compare-item-title">{describeChange(c)}</span>
                  {(c.type === 'formatting' || (c.type === 'image' && c.detail !== describeChange(c))) && c.detail && (
                    <span className="fc-compare-item-detail">{c.detail}</span>
                  )}
                  <span className="fc-compare-item-meta">
                    {c.id}. {describeLocation(c)}
                  </span>
                </span>
              </button>
            ))}
            {changes.length > MAX_LIST && (
              <div className="fc-compare-muted fc-compare-more">
                Showing the first {MAX_LIST} of {changes.length} changes. Use the filters to narrow the list.
              </div>
            )}
            {!changes.length && <div className="fc-compare-muted fc-compare-more">No changes of the selected kinds.</div>}
          </div>
        </>
      )}
    </ToolPanelFrame>
  )
}

/** Left pane of the Compare files tool: the setup, or the results summary after comparing. */
export function ComparePanel({ doc }: { doc: DocumentModel | null }) {
  const hasSession = useCompare((s) => !!s.session)
  // Opened from a document: it is the old file unless chosen otherwise.
  useEffect(() => {
    const s = getCompare()
    if (doc && !s.session && !s.slots.old.doc && !s.slots.old.loading && s.slots.new.doc !== doc) chooseTab('old', doc)
  }, [doc])
  return hasSession ? <ResultsPanel /> : <SetupPanel />
}
