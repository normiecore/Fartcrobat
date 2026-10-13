import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { BookOpen, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FileText, Grid3x3, LayoutGrid, MessageSquareText, Printer } from 'lucide-react'
import {
  Button,
  Checkbox,
  Dialog,
  IconButton,
  invoke,
  NumberInput,
  registry,
  Select,
  TextInput,
  useDocState,
  usePrefs,
  type DocumentModel,
  type Icon
} from '@renderer/sdk'
import type printOps from './engine'
import {
  bookletSheetCount,
  isLandscape,
  layoutSheets,
  PAPER_NAMES,
  PAPERS,
  sheetScale,
  type ImpositionOptions,
  type LayoutMode,
  type PaperName,
  type Sheet
} from './imposition'
import { fullRangeText, selectPages } from './pageRanges'
import type { PrintTarget } from './job'
import {
  CONTENT_OPTIONS,
  formatSize,
  fromPoints,
  impositionOptions,
  PER_SHEET_OPTIONS,
  printDpi,
  toPoints,
  type PrintSettings,
  type Units
} from './settings'
import { SheetPreview } from './SheetPreview'

export interface PrinterInfo {
  name: string
  displayName: string
  isDefault: boolean
}

export type PrintDialogResult =
  | { action: 'print'; settings: PrintSettings; sheets: Sheet[]; target: PrintTarget }
  | { action: 'summarize' }

const MODES: { id: LayoutMode; label: string; icon: Icon; title: string }[] = [
  { id: 'size', label: 'Size', icon: FileText, title: 'One page per sheet, scaled to fit, actual size or a custom scale' },
  { id: 'poster', label: 'Poster', icon: Grid3x3, title: 'Enlarge pages across several sheets that you tape together' },
  { id: 'multiple', label: 'Multiple', icon: LayoutGrid, title: 'Several pages on each sheet' },
  { id: 'booklet', label: 'Booklet', icon: BookOpen, title: 'Fold the printed sheets in half to make a booklet' }
]

const COMMENTS_SUMMARY_COMMAND = 'comments.summarize'
/** Documents longer than this skip counting comments when the dialog opens. */
const SUMMARY_PAGE_LIMIT = 300

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** Native radio styled like the UI kit, with an id so labels and keyboard work. */
function RadioRow({
  name,
  checked,
  onChange,
  children,
  disabled
}: {
  name: string
  checked: boolean
  onChange: () => void
  children: ReactNode
  disabled?: boolean
}) {
  return (
    <label className={`ui-check fc-print-radio ${disabled ? 'is-disabled' : ''}`}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={() => onChange()} />
      <span>{children}</span>
    </label>
  )
}

function Legend({ children }: { children: ReactNode }) {
  return <legend className="fc-print-legend">{children}</legend>
}

let dialogCounter = 0

export function PrintDialog({
  doc,
  initial,
  currentPage: currentPageProp,
  onClose
}: {
  doc: DocumentModel
  initial: PrintSettings
  /** Page printed by "Current page" (defaults to the page shown in the viewer). */
  currentPage?: number
  onClose: (result?: PrintDialogResult) => void
}) {
  const [s, setS] = useState<PrintSettings>(() => ({
    ...initial,
    range: initial.range || fullRangeText(doc.info.pages.map((p) => p.label))
  }))
  const update = (patch: Partial<PrintSettings>) => setS((prev) => ({ ...prev, ...patch }))
  const [uid] = useState(() => `fc-print-${++dialogCounter}`)
  const info = useDocState(doc, (st) => st.info)
  const title = useDocState(doc, (st) => st.title)
  const [currentPage] = useState(() => currentPageProp ?? doc.state.currentPage)
  const prefs = usePrefs()
  const units: Units = prefs.measurementUnits
  const [printers, setPrinters] = useState<PrinterInfo[] | null>(null)
  const [printerError, setPrinterError] = useState<string | null>(null)
  const [moreOptions, setMoreOptions] = useState(initial.subset !== 'all' || initial.reverse)
  const [sheetIndex, setSheetIndex] = useState(0)
  const [summary, setSummary] = useState<{ markups: number; stamps: number; fields: number } | null>(null)
  const printRef = useRef<HTMLButtonElement>(null)
  const submitted = useRef(false)

  const labels = useMemo(() => info.pages.map((p) => p.label), [info])
  const sizes = useMemo(() => info.pages.map((p) => ({ width: p.width, height: p.height })), [info])
  const allowHq = info.permissions['print-hq'] !== false
  const canSummarize = registry.commands.has(COMMENTS_SUMMARY_COMMAND)

  // ---- printers ----------------------------------------------------------------------
  useEffect(() => {
    let alive = true
    invoke('print:printers')
      .then((list) => {
        if (!alive) return
        setPrinters(list)
        setS((prev) => {
          if (list.some((p) => p.name === prev.printer)) return prev
          const pick = list.find((p) => p.isDefault) ?? list[0]
          return { ...prev, printer: pick?.name ?? '' }
        })
      })
      .catch((err) => {
        if (!alive) return
        setPrinters([])
        setPrinterError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [])

  // ---- what the document contains (for the Comments & Forms hint) ----------------------
  useEffect(() => {
    let alive = true
    // Counting loads every page; skip it for very long documents and show generic hints instead.
    if (info.pageCount > SUMMARY_PAGE_LIMIT) return
    const pages = Array.from({ length: info.pageCount }, (_, i) => i)
    doc
      .ops<typeof printOps>('print')
      .contentSummary(pages)
      .then((r) => alive && setSummary({ markups: r.markups, stamps: r.stamps, fields: r.fields }))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [doc, info])


  // Page Up / Page Down page through the preview from anywhere in the dialog, like Acrobat.
  const sheetCount = useRef(0)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'PageDown' && e.key !== 'PageUp') return
      const t = e.target as HTMLElement | null
      if (t?.tagName === 'SELECT' || t?.tagName === 'TEXTAREA') return
      e.preventDefault()
      const step = e.key === 'PageDown' ? 1 : -1
      setSheetIndex((i) => Math.max(0, Math.min(sheetCount.current - 1, Math.min(i, sheetCount.current - 1) + step)))
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // ---- pages and sheets ---------------------------------------------------------------
  const selection = useMemo(
    () => selectPages({ mode: s.pages, range: s.range, subset: s.subset }, info.pageCount, currentPage, labels),
    [s.pages, s.range, s.subset, info.pageCount, currentPage, labels]
  )
  // Only rebuild sheets (and redraw the preview) when a layout setting changes, not e.g. copies.
  const impoKey = JSON.stringify(impositionOptions(s))
  const impo = useMemo(() => JSON.parse(impoKey) as ImpositionOptions, [impoKey])
  const sheets = useMemo(() => {
    if (selection.error) return []
    const date = new Date().toLocaleDateString()
    return layoutSheets(selection.pages, sizes, impo, (page, row, col) => `${title} · Page ${labels[page]} · Row ${row + 1}, Column ${col + 1} · ${date}`)
  }, [selection, sizes, impo, title, labels])
  useEffect(() => {
    sheetCount.current = sheets.length
  }, [sheets])
  const bookletTotal = bookletSheetCount(selection.pages.length)
  const index = Math.min(sheetIndex, Math.max(0, sheets.length - 1))
  const sheet = sheets[index] ?? null
  const scale = sheetScale(sheet ?? undefined)
  const firstPage = sheet?.placements[0]?.page
  const docSize = firstPage !== undefined ? sizes[firstPage] : null

  const noPrinters = printers !== null && printers.length === 0
  const canPrint = !selection.error && sheets.length > 0 && printers !== null

  // Like Acrobat, Enter prints right away: focus the Print button once it is enabled (printers
  // load asynchronously), unless the user already moved on to another control.
  const focusedPrint = useRef(false)
  useEffect(() => {
    if (focusedPrint.current || !canPrint) return
    focusedPrint.current = true
    const active = document.activeElement
    if (!active || active === document.body || active.id === `${uid}-printer`) printRef.current?.focus()
  }, [canPrint, uid])
  const formsWithoutFields = s.content === 'forms' && summary !== null && summary.fields === 0

  const target = (useSystemDialog: boolean): PrintTarget => {
    const p = printers?.find((x) => x.name === s.printer)
    return { printer: p?.name ?? null, systemDialog: useSystemDialog || !p, printerLabel: p?.displayName ?? 'the printer' }
  }

  /** Booklets need double-sided printing; switch it on for them and back off when leaving. */
  const autoDuplex = useRef<{ duplex: boolean; flip: 'long' | 'short' } | null>(null)
  const chooseLayout = (layout: LayoutMode) => {
    const patch: Partial<PrintSettings> = { layout }
    if (layout === 'booklet' && s.layout !== 'booklet') {
      autoDuplex.current = { duplex: s.duplex, flip: s.flip }
      patch.duplex = true
      patch.flip = 'short'
    } else if (layout !== 'booklet' && s.layout === 'booklet' && autoDuplex.current) {
      if (s.duplex && s.flip === 'short') Object.assign(patch, autoDuplex.current)
      autoDuplex.current = null
    }
    update(patch)
    setSheetIndex(0)
  }

  const submit = (useSystemDialog = false) => {
    if (!canPrint || submitted.current) return
    submitted.current = true
    onClose({ action: 'print', settings: s, sheets, target: target(useSystemDialog) })
  }

  const contentHint = (() => {
    if (!summary) {
      if (info.pageCount <= SUMMARY_PAGE_LIMIT) return null
      if (s.content === 'document') return "Comments and markups won't print."
      if (s.content === 'stamps') return "Comments won't print; stamps will."
      if (s.content === 'forms') return 'Only what is typed in form fields prints, for paper forms that are already printed.'
      return null
    }
    const comments = summary.markups
    const stamps = summary.stamps
    if (s.content === 'document' && comments + stamps > 0)
      return `This document has ${plural(comments + stamps, 'comment')}; ${comments + stamps === 1 ? 'it' : 'they'} won't print.`
    if (s.content === 'stamps' && comments > 0)
      return `This document has ${plural(comments, 'comment')}; only stamps will print with the document.`
    if (s.content === 'forms')
      return summary.fields
        ? 'Only what is typed in form fields prints, for paper forms that are already printed.'
        : 'This document has no form fields, so the sheets would be blank.'
    return null
  })()

  const sheetLabel = sheet
    ? `Page ${index + 1} of ${sheets.length}${sheet.side ? ` (sheet ${sheet.sheetNumber}, ${sheet.side})` : ''}`
    : 'Page 0 of 0'

  const unitLabel = units === 'cm' ? 'cm' : units
  const overlapValue = Number(fromPoints(s.overlap, units).toFixed(units === 'in' ? 3 : units === 'pt' ? 0 : 1))

  return (
    <Dialog
      title="Print"
      onClose={() => onClose()}
      width={960}
      className="fc-print-dialog"
      onSubmit={() => submit(false)}
      footer={
        <>
          <span className="fc-print-footer-note">
            {sheets.length > 0 && !selection.error
              ? `${plural(sheets.length, 'sheet')} · ${printDpi(s, allowHq)} dpi${allowHq ? '' : ' (this document only allows low-resolution printing)'}`
              : ''}
          </span>
          <Button onClick={() => onClose()}>Cancel</Button>
          <Button ref={printRef} variant="primary" icon={Printer} disabled={!canPrint} onClick={() => submit(false)}>
            Print
          </Button>
        </>
      }
    >
      <div
        className="fc-print-body"
        onKeyDown={(e) => {
          const tag = (e.target as HTMLElement).tagName
          if (e.key === 'Enter' && tag === 'SELECT') {
            e.preventDefault()
            submit(false)
          }
        }}
      >
        <div className="fc-print-settings">
          {/* ---- printer --------------------------------------------------------------- */}
          <div className="fc-print-row">
            <label className="fc-print-label" htmlFor={`${uid}-printer`}>
              Printer:
            </label>
            <select
              id={`${uid}-printer`}
              className="ui-input ui-select fc-print-printer"
              value={printers === null ? '__loading' : noPrinters ? '' : s.printer}
              disabled={noPrinters}
              onChange={(e) => update({ printer: e.target.value })}
            >
              {printers === null && <option value="__loading">Looking for printers…</option>}
              {noPrinters && <option value="">No printers found</option>}
              {printers?.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.displayName}
                  {p.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              disabled={!canPrint}
              title="Open the system print dialog for this printer to change its own settings (paper tray, quality, stapling…) and print from there"
              onClick={() => submit(true)}
            >
              Properties
            </Button>
          </div>
          {noPrinters && (
            <div className="fc-print-note" role="note">
              {printerError ? `Printers could not be listed (${printerError}). ` : 'No printers were found. '}
              Print opens the system dialog, where you can add a printer or print to a file.
            </div>
          )}
          <div className="fc-print-row fc-print-row-wrap">
            <label className="fc-print-label" htmlFor={`${uid}-copies`}>
              Copies:
            </label>
            <NumberInput
              id={`${uid}-copies`}
              className="ui-input ui-input-number fc-print-copies"
              value={s.copies}
              min={1}
              max={999}
              onChange={(v) => update({ copies: Math.max(1, Math.min(999, Math.round(v))) })}
            />
            <Checkbox checked={s.grayscale} onChange={(v) => update({ grayscale: v })} label="Print in grayscale (black and white)" />
            <Checkbox checked={s.saveInk} onChange={(v) => update({ saveInk: v })} label="Save ink/toner" />
          </div>

          {/* ---- pages to print -------------------------------------------------------- */}
          <fieldset className="fc-print-section">
            <Legend>Pages to Print</Legend>
            <div className="fc-print-radios">
              <RadioRow name={`${uid}-pages`} checked={s.pages === 'all'} onChange={() => update({ pages: 'all' })}>
                All
              </RadioRow>
              <RadioRow name={`${uid}-pages`} checked={s.pages === 'current'} onChange={() => update({ pages: 'current' })}>
                Current page <span className="fc-print-muted">({labels[currentPage] ?? currentPage + 1})</span>
              </RadioRow>
              <div className="fc-print-inline">
                <RadioRow name={`${uid}-pages`} checked={s.pages === 'range'} onChange={() => update({ pages: 'range' })}>
                  Pages
                </RadioRow>
                <TextInput
                  aria-label="Pages to print"
                  className="fc-print-range"
                  value={s.range}
                  placeholder="e.g. 1-3, 5, 8-"
                  onFocus={() => s.pages !== 'range' && update({ pages: 'range' })}
                  onChange={(e) => update({ range: e.target.value, pages: 'range' })}
                />
              </div>
            </div>
            {selection.error ? (
              <div className="ui-field-error fc-print-error" role="alert">
                {selection.error}
              </div>
            ) : (
              s.pages === 'range' && (
                <div className="fc-print-note">
                  {plural(selection.pages.length, 'page')}. Use commas and hyphens: 1-3, 5, 8- (to the end).
                </div>
              )
            )}
            <button
              type="button"
              className="fc-print-disclosure"
              aria-expanded={moreOptions}
              onClick={() => setMoreOptions((v) => !v)}
            >
              {moreOptions ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              More options
            </button>
            {moreOptions && (
              <div className="fc-print-more">
                <label className="fc-print-inline">
                  <span className="fc-print-label">Odd or even pages:</span>
                  <Select
                    value={s.subset}
                    onChange={(v) => update({ subset: v })}
                    options={[
                      { value: 'all', label: 'All pages in range' },
                      { value: 'odd', label: 'Odd pages only' },
                      { value: 'even', label: 'Even pages only' }
                    ]}
                  />
                </label>
                <Checkbox checked={s.reverse} onChange={(v) => update({ reverse: v })} label="Reverse pages" />
              </div>
            )}
          </fieldset>

          {/* ---- page sizing & handling ------------------------------------------------ */}
          <fieldset className="fc-print-section">
            <Legend>Page Sizing &amp; Handling</Legend>
            <div className="fc-print-modes" role="radiogroup" aria-label="Page sizing and handling">
              {MODES.map((m) => (
                <label key={m.id} className={`fc-print-mode ${s.layout === m.id ? 'is-active' : ''}`} title={m.title}>
                  <input
                    type="radio"
                    name={`${uid}-layout`}
                    checked={s.layout === m.id}
                    onChange={() => chooseLayout(m.id)}
                  />
                  <m.icon size={22} strokeWidth={1.5} />
                  <span>{m.label}</span>
                </label>
              ))}
            </div>

            <div className="fc-print-mode-options">
              {s.layout === 'size' && (
                <div className="fc-print-radios fc-print-grid2">
                  <RadioRow name={`${uid}-sizing`} checked={s.sizing === 'fit'} onChange={() => update({ sizing: 'fit' })}>
                    Fit
                  </RadioRow>
                  <RadioRow name={`${uid}-sizing`} checked={s.sizing === 'actual'} onChange={() => update({ sizing: 'actual' })}>
                    Actual size
                  </RadioRow>
                  <RadioRow name={`${uid}-sizing`} checked={s.sizing === 'shrink'} onChange={() => update({ sizing: 'shrink' })}>
                    Shrink oversized pages
                  </RadioRow>
                  <div className="fc-print-inline">
                    <RadioRow name={`${uid}-sizing`} checked={s.sizing === 'custom'} onChange={() => update({ sizing: 'custom' })}>
                      Custom Scale:
                    </RadioRow>
                    <NumberInput
                      aria-label="Custom scale percent"
                      className="ui-input ui-input-number fc-print-small-number"
                      value={s.customScale}
                      min={1}
                      max={1000}
                      onFocus={() => s.sizing !== 'custom' && update({ sizing: 'custom' })}
                      onChange={(v) => update({ customScale: Math.max(1, Math.min(1000, v)), sizing: 'custom' })}
                    />
                    <span>%</span>
                  </div>
                </div>
              )}

              {s.layout === 'poster' && (
                <div className="fc-print-options-grid">
                  <label className="fc-print-inline">
                    <span className="fc-print-label">Tile scale:</span>
                    <NumberInput
                      className="ui-input ui-input-number fc-print-small-number"
                      value={s.tileScale}
                      min={1}
                      max={1000}
                      onChange={(v) => update({ tileScale: Math.max(1, Math.min(1000, v)) })}
                    />
                    <span>%</span>
                  </label>
                  <label className="fc-print-inline">
                    <span className="fc-print-label">Overlap:</span>
                    <NumberInput
                      className="ui-input ui-input-number fc-print-small-number"
                      value={overlapValue}
                      min={0}
                      step={units === 'in' ? 0.05 : units === 'pt' ? 1 : 1}
                      onChange={(v) => update({ overlap: Math.max(0, Math.min(144, toPoints(v, units))) })}
                    />
                    <span>{unitLabel}</span>
                  </label>
                  <Checkbox checked={s.labels} onChange={(v) => update({ labels: v })} label="Labels" />
                  <Checkbox checked={s.cutMarks} onChange={(v) => update({ cutMarks: v })} label="Cut marks" />
                  <Checkbox checked={s.tileLargeOnly} onChange={(v) => update({ tileLargeOnly: v })} label="Tile only large pages" />
                </div>
              )}

              {s.layout === 'multiple' && (
                <div className="fc-print-options-grid">
                  <label className="fc-print-inline">
                    <span className="fc-print-label">Pages per sheet:</span>
                    <select
                      className="ui-input ui-select"
                      aria-label="Pages per sheet"
                      value={String(s.perSheet)}
                      onChange={(e) => update({ perSheet: parseInt(e.target.value, 10) })}
                    >
                      {PER_SHEET_OPTIONS.map((n) => (
                        <option key={n} value={String(n)}>
                          {n}
                        </option>
                      ))}
                      <option value="0">Custom…</option>
                    </select>
                  </label>
                  {s.perSheet === 0 && (
                    <span className="fc-print-inline">
                      <NumberInput
                        aria-label="Columns"
                        className="ui-input ui-input-number fc-print-tiny-number"
                        value={s.gridCols}
                        min={1}
                        max={8}
                        onChange={(v) => update({ gridCols: Math.max(1, Math.min(8, Math.round(v))) })}
                      />
                      <span>by</span>
                      <NumberInput
                        aria-label="Rows"
                        className="ui-input ui-input-number fc-print-tiny-number"
                        value={s.gridRows}
                        min={1}
                        max={8}
                        onChange={(v) => update({ gridRows: Math.max(1, Math.min(8, Math.round(v))) })}
                      />
                    </span>
                  )}
                  <label className="fc-print-inline">
                    <span className="fc-print-label">Page order:</span>
                    <Select
                      aria-label="Page order"
                      value={s.pageOrder}
                      onChange={(v) => update({ pageOrder: v })}
                      options={[
                        { value: 'horizontal', label: 'Horizontal' },
                        { value: 'horizontal-reversed', label: 'Horizontal Reversed' },
                        { value: 'vertical', label: 'Vertical' },
                        { value: 'vertical-reversed', label: 'Vertical Reversed' }
                      ]}
                    />
                  </label>
                  <Checkbox checked={s.pageBorder} onChange={(v) => update({ pageBorder: v })} label="Print page border" />
                  <Checkbox checked={s.autoRotate} onChange={(v) => update({ autoRotate: v })} label="Auto-rotate pages" />
                </div>
              )}

              {s.layout === 'booklet' && (
                <div className="fc-print-options-grid">
                  <label className="fc-print-inline">
                    <span className="fc-print-label">Booklet subset:</span>
                    <Select
                      aria-label="Booklet subset"
                      value={s.bookletSubset}
                      onChange={(v) => {
                        update({ bookletSubset: v })
                        setSheetIndex(0)
                      }}
                      options={[
                        { value: 'both', label: 'Both sides' },
                        { value: 'front', label: 'Front side only' },
                        { value: 'back', label: 'Back side only' }
                      ]}
                    />
                  </label>
                  <span className="fc-print-inline">
                    <span className="fc-print-label">Sheets from</span>
                    <NumberInput
                      aria-label="First sheet"
                      className="ui-input ui-input-number fc-print-tiny-number"
                      value={Math.min(s.sheetFrom, bookletTotal)}
                      min={1}
                      max={bookletTotal}
                      onChange={(v) => update({ sheetFrom: Math.max(1, Math.min(bookletTotal, Math.round(v))) })}
                    />
                    <span>to</span>
                    <NumberInput
                      aria-label="Last sheet"
                      className="ui-input ui-input-number fc-print-tiny-number"
                      value={s.sheetTo > 0 ? Math.min(s.sheetTo, bookletTotal) : bookletTotal}
                      min={1}
                      max={bookletTotal}
                      onChange={(v) => {
                        const to = Math.max(1, Math.min(bookletTotal, Math.round(v)))
                        update({ sheetTo: to >= bookletTotal ? 0 : to })
                      }}
                    />
                  </span>
                  <label className="fc-print-inline">
                    <span className="fc-print-label">Binding:</span>
                    <Select
                      aria-label="Binding"
                      value={s.binding}
                      onChange={(v) => update({ binding: v })}
                      options={[
                        { value: 'left', label: 'Left' },
                        { value: 'right', label: 'Right' }
                      ]}
                    />
                  </label>
                  <div className="fc-print-note fc-print-span">
                    Print on both sides, flipping on the short edge, then fold the stack in half.
                  </div>
                </div>
              )}
            </div>

            <div className="fc-print-duplex">
              <Checkbox checked={s.duplex} onChange={(v) => update({ duplex: v })} label="Print on both sides of paper" />
              <span className={`fc-print-inline ${s.duplex ? '' : 'is-disabled'}`}>
                <RadioRow name={`${uid}-flip`} checked={s.flip === 'long'} disabled={!s.duplex} onChange={() => update({ flip: 'long' })}>
                  Flip on long edge
                </RadioRow>
                <RadioRow name={`${uid}-flip`} checked={s.flip === 'short'} disabled={!s.duplex} onChange={() => update({ flip: 'short' })}>
                  Flip on short edge
                </RadioRow>
              </span>
            </div>
          </fieldset>

          {/* ---- orientation ----------------------------------------------------------- */}
          <fieldset className="fc-print-section" disabled={s.layout === 'booklet'}>
            <Legend>Orientation</Legend>
            <div className="fc-print-radios fc-print-row-wrap">
              <RadioRow name={`${uid}-orient`} checked={s.orientation === 'auto'} onChange={() => update({ orientation: 'auto' })}>
                Auto portrait/landscape
              </RadioRow>
              <RadioRow name={`${uid}-orient`} checked={s.orientation === 'portrait'} onChange={() => update({ orientation: 'portrait' })}>
                Portrait
              </RadioRow>
              <RadioRow name={`${uid}-orient`} checked={s.orientation === 'landscape'} onChange={() => update({ orientation: 'landscape' })}>
                Landscape
              </RadioRow>
            </div>
            {s.layout === 'booklet' && <div className="fc-print-note">Booklets always print on landscape sheets.</div>}
          </fieldset>

          <div className="fc-print-section fc-print-advanced">
            <Checkbox
              checked={s.draft || !allowHq}
              disabled={!allowHq}
              onChange={(v) => update({ draft: v })}
              label="Print as image draft (faster, 150 dpi)"
            />
          </div>
        </div>

        {/* ---- right column: comments & forms and preview ------------------------------ */}
        <div className="fc-print-side">
          <fieldset className="fc-print-section">
            <Legend>Comments &amp; Forms</Legend>
            <div className="fc-print-row">
              <Select aria-label="Comments and forms" value={s.content} onChange={(v) => update({ content: v })} options={CONTENT_OPTIONS} />
              {canSummarize && (
                <Button size="sm" icon={MessageSquareText} onClick={() => onClose({ action: 'summarize' })}>
                  Summarize Comments
                </Button>
              )}
            </div>
            {contentHint && <div className={`fc-print-note ${formsWithoutFields ? 'is-warning' : ''}`}>{contentHint}</div>}
          </fieldset>

          <div className="fc-print-preview-head">
            <span>{scale !== null ? `Scale: ${Math.round(scale * 100)}%` : ''}</span>
            <span>{docSize ? `Document: ${formatSize(docSize.width, docSize.height, units)}` : ''}</span>
          </div>
          <SheetPreview
            doc={doc}
            sheet={sheet}
            content={s.content}
            grayscale={s.grayscale}
            saveInk={s.saveInk}
            message={selection.error ? 'Fix the page range to see a preview.' : sheets.length ? null : 'Nothing to print.'}
            label={`Preview: ${sheetLabel}`}
          />
          <div className="fc-print-nav">
            <IconButton icon={ChevronLeft} label="Previous page" disabled={index <= 0} onClick={() => setSheetIndex(Math.max(0, index - 1))} />
            <span className="fc-print-counter" aria-live="polite">
              {sheetLabel}
            </span>
            <IconButton
              icon={ChevronRight}
              label="Next page"
              disabled={index >= sheets.length - 1}
              onClick={() => setSheetIndex(Math.min(sheets.length - 1, index + 1))}
            />
          </div>
          {sheets.length > 2 && (
            <input
              type="range"
              className="fc-print-slider"
              aria-label="Preview page"
              min={1}
              max={sheets.length}
              value={index + 1}
              onChange={(e) => setSheetIndex(parseInt(e.target.value, 10) - 1)}
            />
          )}
          <div className="fc-print-row fc-print-paper">
            <label className="fc-print-label" htmlFor={`${uid}-paper`}>
              Paper:
            </label>
            <select
              id={`${uid}-paper`}
              className="ui-input ui-select"
              value={s.paper}
              onChange={(e) => update({ paper: e.target.value as PaperName })}
            >
              {PAPER_NAMES.map((name) => (
                <option key={name} value={name}>
                  {PAPERS[name].label} ({formatSize(PAPERS[name].width, PAPERS[name].height, units)})
                </option>
              ))}
            </select>
            <span className="fc-print-note">{sheet ? (isLandscape(sheet) ? 'Landscape' : 'Portrait') : ''}</span>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
