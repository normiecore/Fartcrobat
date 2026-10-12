import { useEffect, useMemo, useState } from 'react'
import {
  ChevronLeft,
  EyeOff,
  FileText,
  Files,
  ScanSearch,
  ShieldCheck,
  SlidersHorizontal,
  SquareDashed,
  TextCursorInput,
  Trash2
} from 'lucide-react'
import {
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Radio,
  Section,
  Select,
  TextArea,
  TextInput,
  ToolPanelFrame,
  ToolRow,
  hitContext,
  loadText,
  rangeQuads,
  rangeRects,
  setTool,
  showError,
  toast,
  useApp,
  useDocState,
  usePrefs,
  type DocumentModel,
  type PageText
} from '@renderer/sdk'
import { overlayTextOf, type MarkInfo, type MarkSpec } from './shared'
import { PATTERNS, findOnPage, type FindMode, type FindQuery, type PatternId } from './patterns'
import { deleteMarks, goToMark, markSpecs, plural } from './actions'
import { applyRedactions, openPageRangeDialog, openSanitizeDialog } from './dialogs'
import { openPropertiesDialog } from './PropertiesForm'
import { formatSize, textUnderMark } from './geometry'
import {
  emptyFind,
  findStateOf,
  SELECTION_TYPE,
  setFind,
  useMarks,
  useRedactUi,
  type FindResult,
  type MarkSelectionData
} from './store'

export function RedactPanel({ doc }: { doc: DocumentModel | null }) {
  const view = useRedactUi((s) => s.view)
  if (!doc) {
    return (
      <ToolPanelFrame title="Redact a PDF">
        <EmptyState icon={ShieldCheck} title="Open a PDF to redact it" />
      </ToolPanelFrame>
    )
  }
  return view === 'find' ? <FindPanel key={doc.id} doc={doc} /> : <MainPanel key={doc.id} doc={doc} />
}

// ---- main view ------------------------------------------------------------------------------------

/** Text under each mark, for the list (loaded lazily from the page text). */
function useMarkLabels(doc: DocumentModel, marks: MarkInfo[]): Record<number, string> {
  const [labels, setLabels] = useState<Record<number, string>>({})
  const key = marks.map((m) => `${m.id}:${m.page}:${m.rect.map((v) => Math.round(v)).join(',')}`).join('|')
  useEffect(() => {
    let alive = true
    const pages = [...new Set(marks.map((m) => m.page))]
    void (async () => {
      const out: Record<number, string> = {}
      for (const p of pages) {
        let t: PageText
        try {
          t = await loadText(doc, p)
        } catch {
          continue
        }
        for (const m of marks) if (m.page === p && m.kind !== 'page') out[m.id] = textUnderMark(t, m)
      }
      if (alive) setLabels(out)
    })()
    return () => {
      alive = false
    }
    // marks are captured through key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, key])
  return labels
}

function MarkRow({ doc, mark, label, selected }: { doc: DocumentModel; mark: MarkInfo; label: string; selected: boolean }) {
  const units = usePrefs().measurementUnits
  const Icon = mark.kind === 'text' ? TextCursorInput : mark.kind === 'page' ? FileText : SquareDashed
  const title = mark.kind === 'page' ? 'Whole page' : label || (mark.kind === 'area' ? `Area ${formatSize(mark.rect, units)}` : 'Text')
  const overlay = overlayTextOf(mark.props)
  const hover = (on: boolean) => useRedactUi.setState({ hover: on ? { docId: doc.id, id: mark.id } : null })
  return (
    <div
      className={`fc-redact-mark-row ${selected ? 'is-selected' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`${title}, page ${mark.page + 1}`}
      aria-pressed={selected}
      onClick={() => goToMark(doc, mark)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          goToMark(doc, mark)
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          e.stopPropagation()
          void deleteMarks(doc, [mark.id])
        }
      }}
      onMouseEnter={() => hover(true)}
      onMouseLeave={() => hover(false)}
      onFocus={() => hover(true)}
      onBlur={() => hover(false)}
    >
      <span className="fc-redact-mark-swatch" style={{ background: mark.props.fillColor ?? 'transparent', borderColor: mark.props.outlineColor }}>
        <Icon size={12} />
      </span>
      <span className="fc-redact-mark-text">
        <span className="fc-redact-mark-label">{title}</span>
        {overlay && <span className="fc-redact-mark-overlay">Overlay: {overlay}</span>}
      </span>
      <IconButton
        icon={Trash2}
        size={14}
        label="Delete mark"
        className="fc-redact-mark-delete"
        onClick={(e) => {
          e.stopPropagation()
          void deleteMarks(doc, [mark.id])
        }}
      />
    </div>
  )
}

function MainPanel({ doc }: { doc: DocumentModel }) {
  const marks = useMarks(doc)
  const toolId = useApp((s) => s.toolId)
  const selection = useDocState(doc, (s) => s.selection)
  const pageLabels = useDocState(doc, (s) => s.info.pages)
  const labels = useMarkLabels(doc, marks)
  const selectedIds = selection.kind === 'custom' && selection.type === SELECTION_TYPE ? ((selection.data as MarkSelectionData).ids ?? []) : []
  const selected = new Set(selectedIds)
  const byPage = useMemo(() => {
    const m = new Map<number, MarkInfo[]>()
    for (const mark of marks) m.set(mark.page, [...(m.get(mark.page) ?? []), mark])
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [marks])
  const pages = byPage.length

  return (
    <ToolPanelFrame
      title="Redact a PDF"
      footer={
        <Button
          variant="danger"
          icon={ShieldCheck}
          className="fc-redact-apply-btn"
          disabled={!marks.length}
          onClick={() => void applyRedactions(doc)}
        >
          {marks.length ? `Apply ${plural(marks.length, 'redaction')}` : 'Apply redactions'}
        </Button>
      }
    >
      <div className="fc-redact-panel">
        <Section>
          <ToolRow
            icon={TextCursorInput}
            label="Redact text & images"
            description="Drag across text or draw a box"
            active={toolId === 'redact.mark'}
            onClick={() => setTool(toolId === 'redact.mark' ? 'select' : 'redact.mark')}
          />
          <ToolRow icon={ScanSearch} label="Find text & redact" description="Words, phrases or patterns like emails" onClick={() => useRedactUi.setState({ view: 'find' })} />
          <ToolRow icon={Files} label="Mark page range" description="Remove whole pages of content" onClick={() => void openPageRangeDialog(doc)} />
          <ToolRow icon={SlidersHorizontal} label="Properties" description="Fill colour and overlay text" onClick={() => void openPropertiesDialog(doc)} />
          <ToolRow icon={EyeOff} label="Remove hidden information" description="Metadata, attachments, hidden text…" onClick={() => void openSanitizeDialog(doc)} />
        </Section>
        <Section
          title={marks.length ? `Marks (${marks.length} on ${plural(pages, 'page')})` : 'Marks'}
          actions={
            marks.length > 1 ? (
              <Button size="sm" variant="quiet" onClick={() => void deleteMarks(doc, marks.map((m) => m.id))}>
                Delete all
              </Button>
            ) : undefined
          }
        >
          {marks.length === 0 ? (
            <EmptyState icon={SquareDashed} title="No redaction marks yet">
              Mark text or areas. Nothing is removed until you apply the marks.
            </EmptyState>
          ) : (
            <div className="fc-redact-mark-list" role="list">
              {byPage.map(([page, list]) => (
                <div key={page} role="listitem" className="fc-redact-mark-group">
                  <div className="fc-redact-mark-page">Page {pageLabels[page]?.label ?? page + 1}</div>
                  {list.map((m) => (
                    <MarkRow key={m.id} doc={doc} mark={m} label={labels[m.id] ?? ''} selected={selected.has(m.id)} />
                  ))}
                </div>
              ))}
            </div>
          )}
        </Section>
      </div>
    </ToolPanelFrame>
  )
}

// ---- Find text & redact -----------------------------------------------------------------------------

let searchToken = 0

async function runSearch(doc: DocumentModel, query: FindQuery) {
  const token = ++searchToken
  setFind(doc.id, { ...emptyFind(query), running: true })
  const results: FindResult[] = []
  const checked: Record<string, boolean> = {}
  const n = doc.pageCount
  try {
    for (let p = 0; p < n; p++) {
      if (token !== searchToken || doc.isClosed) return
      const t = await loadText(doc, p)
      for (const h of findOnPage(t, query)) {
        const ctx = hitContext(t, h, 28)
        const key = `${p}:${h.start}:${h.end}`
        results.push({ key, page: p, start: h.start, end: h.end, ...ctx })
        checked[key] = true
      }
      if (p % 4 === 3 || p === n - 1) {
        setFind(doc.id, { results: [...results], checked: { ...checked }, pagesSearched: p + 1 })
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    if (token === searchToken) setFind(doc.id, { running: false, done: true, pagesSearched: n })
  } catch (err) {
    if (token === searchToken) setFind(doc.id, { running: false, done: true })
    showError(err, 'Search failed')
  }
}

function queryReady(q: FindQuery): boolean {
  if (q.mode === 'phrase') return q.phrase.trim().length > 0
  if (q.mode === 'list') return q.list.some((w) => w.trim())
  return true
}

function FindPanel({ doc }: { doc: DocumentModel }) {
  const state = useRedactUi((s) => s.find[doc.id]) ?? emptyFind()
  const [query, setQuery] = useState<FindQuery>(state.query)
  const [listText, setListText] = useState(state.query.list.join('\n'))
  const results = state.results
  const checkedCount = results.filter((r) => state.checked[r.key]).length
  const allChecked = results.length > 0 && checkedCount === results.length
  const pagesWithResults = new Set(results.map((r) => r.page)).size

  const set = (patch: Partial<FindQuery>) => setQuery((q) => ({ ...q, ...patch }))
  const search = () => {
    const q = { ...query, list: listText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) }
    setQuery(q)
    if (queryReady(q)) void runSearch(doc, q)
  }

  const back = () => {
    searchToken++
    useRedactUi.setState({ view: 'main' })
  }

  const markChecked = async () => {
    const chosen = results.filter((r) => state.checked[r.key])
    if (!chosen.length) return
    const specs: MarkSpec[] = []
    for (const r of chosen) {
      const t = await loadText(doc, r.page)
      const quads = rangeQuads(t, r.start, Math.min(r.end, t.text.length))
      if (quads.length) specs.push({ page: r.page, kind: 'text', quads })
    }
    const marks = await markSpecs(doc, specs)
    if (!marks.length) return
    toast(`Marked ${plural(marks.length, 'result')} for redaction. Apply the marks to remove the text.`, { kind: 'success' })
    setFind(doc.id, emptyFind(state.query))
    useRedactUi.setState({ view: 'main' })
  }

  const reveal = async (r: FindResult) => {
    setFind(doc.id, { active: r.key })
    const t = await loadText(doc, r.page)
    const rects = rangeRects(t, r.start, Math.min(r.end, t.text.length))
    if (rects.length) doc.view?.scrollToRect(r.page, rects[0], { center: true })
    else doc.view?.goToPage(r.page)
  }

  const pattern = PATTERNS.find((p) => p.id === query.pattern)!
  const summary = state.running
    ? `Searching… ${plural(results.length, 'result')} so far`
    : state.done
      ? results.length
        ? `${plural(results.length, 'result')} on ${plural(pagesWithResults, 'page')}`
        : 'No results'
      : ''

  const byPage = new Map<number, FindResult[]>()
  for (const r of results) byPage.set(r.page, [...(byPage.get(r.page) ?? []), r])

  return (
    <ToolPanelFrame
      title="Find text & redact"
      footer={
        results.length ? (
          <Button variant="primary" className="fc-redact-apply-btn" disabled={!checkedCount} onClick={() => void markChecked()}>
            Mark {checkedCount === results.length ? 'all' : checkedCount} for redaction
          </Button>
        ) : undefined
      }
    >
      <div className="fc-redact-panel fc-redact-find">
        <button type="button" className="fc-redact-back" onClick={back}>
          <ChevronLeft size={16} />
          <span>Redact a PDF</span>
        </button>
        <form
          className="fc-redact-find-form"
          onSubmit={(e) => {
            e.preventDefault()
            search()
          }}
        >
          <div className="fc-redact-find-modes" role="radiogroup" aria-label="Search for">
            {(
              [
                ['phrase', 'Single word or phrase'],
                ['list', 'Multiple words or phrases'],
                ['pattern', 'Patterns']
              ] as [FindMode, string][]
            ).map(([mode, label]) => (
              <Radio key={mode} name="fc-redact-find-mode" checked={query.mode === mode} onChange={() => set({ mode })} label={label} />
            ))}
          </div>
          {query.mode === 'phrase' && (
            <TextInput
              autoFocus
              aria-label="Word or phrase"
              placeholder="Word or phrase to find"
              value={query.phrase}
              onChange={(e) => set({ phrase: e.target.value })}
            />
          )}
          {query.mode === 'list' && (
            <TextArea
              aria-label="Words or phrases, one per line"
              placeholder={'One word or phrase per line\ne.g. Jane Smith\nProject Falcon'}
              value={listText}
              rows={5}
              onChange={(e) => setListText(e.target.value)}
            />
          )}
          {query.mode === 'pattern' && (
            <>
              <Select<PatternId>
                aria-label="Pattern"
                value={query.pattern}
                onChange={(pattern) => set({ pattern })}
                options={PATTERNS.map((p) => ({ value: p.id, label: p.label }))}
              />
              <span className="ui-field-hint">For example: {pattern.example}</span>
            </>
          )}
          {query.mode !== 'pattern' && (
            <div className="fc-redact-find-options">
              <Checkbox checked={query.wholeWords} onChange={(v) => set({ wholeWords: v })} label="Whole words only" />
              <Checkbox checked={query.matchCase} onChange={(v) => set({ matchCase: v })} label="Match case" />
            </div>
          )}
          <Button type="submit" variant="primary" icon={ScanSearch} disabled={query.mode === 'list' ? !listText.trim() : !queryReady(query)}>
            Search
          </Button>
        </form>

        {(state.running || state.done) && (
          <div className="fc-redact-results" aria-live="polite">
            <div className="fc-redact-results-head">
              <span className="fc-redact-results-summary">{summary}</span>
              {results.length > 0 && (
                <Checkbox
                  checked={allChecked}
                  onChange={(v) => {
                    const checked: Record<string, boolean> = {}
                    for (const r of results) checked[r.key] = v
                    setFind(doc.id, { checked })
                  }}
                  label="Check all"
                />
              )}
            </div>
            {[...byPage.entries()].map(([page, list]) => (
              <div key={page} className="fc-redact-result-group">
                <div className="fc-redact-mark-page">Page {page + 1}</div>
                {list.map((r) => (
                  <div key={r.key} className={`fc-redact-result ${state.active === r.key ? 'is-active' : ''}`}>
                    <input
                      type="checkbox"
                      aria-label={`Mark “${r.match}” on page ${page + 1}`}
                      checked={!!state.checked[r.key]}
                      onChange={(e) => setFind(doc.id, (f) => ({ checked: { ...f.checked, [r.key]: e.target.checked } }))}
                    />
                    <button type="button" className="fc-redact-result-text" onClick={() => void reveal(r)} title="Show on the page">
                      {r.before && <span className="shell-muted">…{r.before}</span>}
                      <mark>{r.match}</mark>
                      {r.after && <span className="shell-muted">{r.after}…</span>}
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </ToolPanelFrame>
  )
}

/** Opens the Find & Redact view with a fresh search (keeps the last query). */
export function resetFind(docId: string) {
  setFind(docId, emptyFind(findStateOf(docId).query))
}
