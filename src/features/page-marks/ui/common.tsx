import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronLeft,
  ChevronRight,
  Italic,
  Underline
} from 'lucide-react'
import {
  Button,
  ColorButton,
  drawResult,
  invoke,
  prompt,
  Select,
  showError,
  toast,
  useDocState,
  usePrefs,
  withProgress,
  type DocumentModel
} from '@renderer/sdk'
import { marksApi } from '../store'
import { rememberSettings } from '../memory'
import {
  fromUnit,
  MARK_NAMES_LOWER,
  toUnit,
  UNIT_LABELS,
  unsupportedChars,
  type FontSpec,
  type Margins,
  type MarkSettings,
  type MarkType,
  type PageRange,
  type Unit
} from '../shared'

export function useUnit(): Unit {
  return usePrefs().measurementUnits as Unit
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return ''
  return String(Math.round(v * 1000) / 1000)
}

/** Number input that lets people type freely (decimals, empty while editing) and clamps on change. */
export function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  label,
  width,
  disabled,
  id
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  label: string
  width?: number
  disabled?: boolean
  id?: string
}) {
  const [text, setText] = useState(fmt(value))
  const last = useRef(value)
  useEffect(() => {
    if (value !== last.current) {
      last.current = value
      setText(fmt(value))
    }
  }, [value])
  return (
    <input
      id={id}
      type="number"
      className="ui-input ui-input-number"
      aria-label={label}
      title={label}
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      style={width ? { width } : undefined}
      onChange={(e) => {
        setText(e.target.value)
        let v = parseFloat(e.target.value)
        if (Number.isNaN(v)) return
        if (min !== undefined) v = Math.max(min, v)
        if (max !== undefined) v = Math.min(max, v)
        last.current = v
        onChange(v)
      }}
      onBlur={() => setText(fmt(last.current))}
    />
  )
}

/** A length in points, shown and edited in the user's measurement unit. */
export function UnitField({
  value,
  onChange,
  label,
  min = 0,
  max,
  disabled
}: {
  value: number
  onChange: (points: number) => void
  label: string
  min?: number
  max?: number
  disabled?: boolean
}) {
  const unit = useUnit()
  const step = unit === 'in' || unit === 'cm' ? 0.1 : 1
  return (
    <NumberField
      label={`${label} (${UNIT_LABELS[unit]})`}
      value={toUnit(value, unit)}
      step={step}
      min={min === undefined ? undefined : toUnit(min, unit)}
      max={max === undefined ? undefined : toUnit(max, unit)}
      disabled={disabled}
      onChange={(v) => onChange(fromUnit(v, unit))}
    />
  )
}

/** A labelled group of controls. */
export function Group({
  title,
  children,
  className
}: {
  title: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <fieldset className={`fc-page-marks-group ${className ?? ''}`}>
      <legend>{title}</legend>
      {children}
    </fieldset>
  )
}

/** Label + control on one row. */
export function Row({
  label,
  children,
  htmlFor
}: {
  label: ReactNode
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div className="fc-page-marks-row">
      <label className="fc-page-marks-row-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="fc-page-marks-row-controls">{children}</div>
    </div>
  )
}

export function MarginsFields({ margins, onChange }: { margins: Margins; onChange: (m: Margins) => void }) {
  const unit = useUnit()
  const set = (k: keyof Margins) => (v: number) => onChange({ ...margins, [k]: v })
  return (
    <div className="fc-page-marks-margins">
      {(['top', 'bottom', 'left', 'right'] as const).map((k) => (
        <label key={k} className="fc-page-marks-mini">
          <span>
            {k[0].toUpperCase() + k.slice(1)} ({UNIT_LABELS[unit]})
          </span>
          <UnitField
            label={`${k[0].toUpperCase() + k.slice(1)} margin`}
            value={margins[k]}
            onChange={set(k)}
          />
        </label>
      ))}
    </div>
  )
}

const FAMILIES: { value: FontSpec['family']; label: string }[] = [
  { value: 'Helvetica', label: 'Helvetica (sans serif)' },
  { value: 'Times', label: 'Times (serif)' },
  { value: 'Courier', label: 'Courier (monospaced)' }
]

function Toggle({
  on,
  onChange,
  label,
  icon: Icon
}: {
  on: boolean
  onChange: (v: boolean) => void
  label: string
  icon: typeof Bold
}) {
  return (
    <button
      type="button"
      className={`ui-icon-btn fc-page-marks-toggle ${on ? 'is-active' : ''}`}
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() => onChange(!on)}
    >
      <Icon size={16} />
    </button>
  )
}

export function FontFields({
  font,
  onChange,
  sizeDisabled,
  align
}: {
  font: FontSpec
  onChange: (f: FontSpec) => void
  sizeDisabled?: boolean
  align?: { value: 'left' | 'center' | 'right'; onChange: (v: 'left' | 'center' | 'right') => void }
}) {
  const set = (patch: Partial<FontSpec>) => onChange({ ...font, ...patch })
  return (
    <div className="fc-page-marks-font">
      <Select<FontSpec['family']>
        aria-label="Font"
        value={font.family}
        onChange={(family) => set({ family })}
        options={FAMILIES}
      />
      <NumberField
        label="Font size (pt)"
        value={font.size}
        min={1}
        max={500}
        onChange={(size) => set({ size })}
        width={68}
        disabled={sizeDisabled}
      />
      <ColorButton value={font.color} onChange={(c) => set({ color: c ?? '#000000' })} title="Text colour" />
      <span className="fc-page-marks-toggles">
        <Toggle on={font.bold} onChange={(bold) => set({ bold })} label="Bold" icon={Bold} />
        <Toggle on={font.italic} onChange={(italic) => set({ italic })} label="Italic" icon={Italic} />
        <Toggle
          on={font.underline}
          onChange={(underline) => set({ underline })}
          label="Underline"
          icon={Underline}
        />
      </span>
      {align && (
        <span className="fc-page-marks-toggles" role="radiogroup" aria-label="Alignment">
          <Toggle
            on={align.value === 'left'}
            onChange={() => align.onChange('left')}
            label="Align left"
            icon={AlignLeft}
          />
          <Toggle
            on={align.value === 'center'}
            onChange={() => align.onChange('center')}
            label="Align center"
            icon={AlignCenter}
          />
          <Toggle
            on={align.value === 'right'}
            onChange={() => align.onChange('right')}
            label="Align right"
            icon={AlignRight}
          />
        </span>
      )}
    </div>
  )
}

export function rangeError(range: PageRange, pageCount: number): string | null {
  if (range.kind === 'all') {
    if (range.subset === 'even' && pageCount < 2) return 'This document has no even pages'
    return null
  }
  const from = range.from ?? 1
  const to = range.to ?? pageCount
  if (!Number.isInteger(from) || !Number.isInteger(to)) return 'Enter whole page numbers'
  if (from < 1 || to > pageCount) return `Pages must be between 1 and ${pageCount}`
  if (from > to) return 'The first page must come before the last page'
  if (range.subset !== 'all') {
    const any = Array.from({ length: to - from + 1 }, (_, k) => from + k).some((n) =>
      range.subset === 'odd' ? n % 2 === 1 : n % 2 === 0
    )
    if (!any) return `There are no ${range.subset} pages in this range`
  }
  return null
}

export function PageRangeFields({
  range,
  onChange,
  pageCount,
  currentPage
}: {
  range: PageRange
  onChange: (r: PageRange) => void
  pageCount: number
  currentPage: number
}) {
  const name = useId()
  const err = rangeError(range, pageCount)
  return (
    <div className="fc-page-marks-range">
      <label className="ui-check">
        <input
          type="radio"
          name={name}
          checked={range.kind === 'all'}
          onChange={() => onChange({ ...range, kind: 'all' })}
        />
        <span>All pages</span>
      </label>
      <label className="ui-check fc-page-marks-range-from">
        <input
          type="radio"
          name={name}
          checked={range.kind === 'range'}
          onChange={() =>
            onChange({
              ...range,
              kind: 'range',
              from: range.from ?? currentPage + 1,
              to: range.to ?? pageCount
            })
          }
        />
        <span>Pages from</span>
      </label>
      <NumberField
        label="First page"
        value={range.from ?? 1}
        min={1}
        max={pageCount}
        width={64}
        onChange={(from) =>
          onChange({ ...range, kind: 'range', from: Math.round(from), to: range.to ?? pageCount })
        }
      />
      <span>to</span>
      <NumberField
        label="Last page"
        value={range.to ?? pageCount}
        min={1}
        max={pageCount}
        width={64}
        onChange={(to) => onChange({ ...range, kind: 'range', from: range.from ?? 1, to: Math.round(to) })}
      />
      <span className="shell-muted">of {pageCount}</span>
      <Select<PageRange['subset']>
        aria-label="Which pages"
        value={range.subset}
        onChange={(subset) => onChange({ ...range, subset })}
        options={[
          { value: 'all', label: 'All pages in range' },
          { value: 'odd', label: 'Odd pages only' },
          { value: 'even', label: 'Even pages only' }
        ]}
      />
      {err && (
        <div className="ui-field-error fc-page-marks-error" role="alert">
          {err}
        </div>
      )}
    </div>
  )
}

/** Warns about characters the standard PDF fonts cannot show. */
export function CharsetWarning({ texts }: { texts: string[] }) {
  const bad = unsupportedChars(texts.join(''))
  if (!bad.length) return null
  return (
    <div className="fc-page-marks-warning" role="status">
      The standard PDF fonts can’t show {bad.slice(0, 8).join(' ')}
      {bad.length > 8 ? ' …' : ''} — {bad.length === 1 ? 'it' : 'they'} will appear as “?”.
    </div>
  )
}

// ---- preview ---------------------------------------------------------------------------------

/**
 * Exact preview of a page with the marks applied (rendered by the engine, the document itself is
 * never changed), with page navigation.
 */
export function PreviewPane({
  doc,
  settings,
  mode,
  page,
  onPageChange,
  maxWidth = 320,
  maxHeight = 400
}: {
  doc: DocumentModel
  settings: MarkSettings
  mode: 'add' | 'replace'
  page: number
  onPageChange: (p: number) => void
  maxWidth?: number
  maxHeight?: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const info = useDocState(doc, (s) => s.info)
  const count = info.pageCount
  const pg = info.pages[Math.min(page, count - 1)]
  const cssScale = Math.min(maxWidth / pg.width, maxHeight / pg.height)
  const [status, setStatus] = useState<{
    busy: boolean
    message?: string
    inRange: boolean
    error?: string
    ready: boolean
  }>({
    busy: true,
    inRange: true,
    ready: false
  })
  const token = useRef(0)
  const key = JSON.stringify(settings)
  useEffect(() => {
    const my = ++token.current
    setStatus((s) => ({ ...s, busy: true }))
    const timer = window.setTimeout(async () => {
      try {
        const dpr = window.devicePixelRatio || 1
        const r = await marksApi(doc).preview(page, JSON.parse(key) as MarkSettings, {
          mode,
          scale: cssScale * dpr
        })
        if (my !== token.current || !canvasRef.current) {
          r.bitmap?.close()
          return
        }
        drawResult(canvasRef.current, { ...r })
        canvasRef.current.style.width = `${r.width / dpr}px`
        canvasRef.current.style.height = `${r.height / dpr}px`
        setStatus({ busy: false, message: r.message, inRange: r.inRange, ready: true })
      } catch (err) {
        if (my !== token.current) return
        setStatus((s) => ({ ...s, busy: false, error: err instanceof Error ? err.message : String(err) }))
      }
    }, 140)
    return () => window.clearTimeout(timer)
  }, [doc, page, key, mode, cssScale])

  const note = status.error ?? (!status.inRange ? 'This page is not in the page range' : status.message)
  return (
    <div className="fc-page-marks-preview" aria-label="Preview">
      <div className="fc-page-marks-preview-title">Preview</div>
      <div
        className="fc-page-marks-preview-frame"
        style={{ width: pg.width * cssScale + 2, height: pg.height * cssScale + 2 }}
      >
        <canvas
          ref={canvasRef}
          className="fc-page-marks-preview-canvas"
          data-ready={status.ready && !status.busy ? 'true' : 'false'}
        />
        {note && <div className="fc-page-marks-preview-note">{note}</div>}
      </div>
      <div className="fc-page-marks-preview-nav">
        <button
          type="button"
          className="ui-icon-btn"
          aria-label="Previous page"
          disabled={page <= 0}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span>
          Page{' '}
          <NumberField
            label="Preview page"
            value={page + 1}
            min={1}
            max={count}
            width={56}
            onChange={(v) => onPageChange(Math.round(v) - 1)}
          />{' '}
          of {count}
        </span>
        <button
          type="button"
          className="ui-icon-btn"
          aria-label="Next page"
          disabled={page >= count - 1}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  )
}

// ---- presets ---------------------------------------------------------------------------------

interface Preset {
  name: string
  settings: MarkSettings
}

type PresetStore = Partial<Record<MarkType, Preset[]>>

const PRESETS_KEY = 'page-marks:presets'

async function readPresets(): Promise<PresetStore> {
  const v = (await invoke('store:get', PRESETS_KEY)) as PresetStore | undefined
  return v && typeof v === 'object' ? v : {}
}

/** "Saved settings" picker with Save and Delete, like Acrobat's. */
export function PresetsBar<T extends MarkSettings>({
  type,
  current,
  onLoad
}: {
  type: MarkType
  current: T
  onLoad: (s: T) => void
}) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [selected, setSelected] = useState('')
  useEffect(() => {
    readPresets()
      .then((all) => setPresets(all[type] ?? []))
      .catch((err) => showError(err, 'Could not read saved settings'))
  }, [type])

  const write = async (list: Preset[]) => {
    const all = await readPresets()
    all[type] = list
    await invoke('store:set', PRESETS_KEY, all)
    setPresets(list)
  }

  const save = async () => {
    const name = await prompt({
      title: 'Save settings',
      label: 'Name',
      initial: selected,
      okLabel: 'Save',
      validate: (v) => (v.trim() ? null : 'Enter a name')
    })
    if (!name) return
    try {
      const list = presets.filter((p) => p.name !== name.trim())
      list.push({ name: name.trim(), settings: JSON.parse(JSON.stringify(current)) })
      list.sort((a, b) => a.name.localeCompare(b.name))
      await write(list)
      setSelected(name.trim())
      toast(`Saved “${name.trim()}”`, { kind: 'success', timeout: 2000 })
    } catch (err) {
      showError(err, 'Could not save the settings')
    }
  }

  return (
    <div className="fc-page-marks-presets">
      <label className="fc-page-marks-row-label" htmlFor={`fc-page-marks-presets-${type}`}>
        Saved settings
      </label>
      <select
        id={`fc-page-marks-presets-${type}`}
        className="ui-input ui-select"
        value={selected}
        onChange={(e) => {
          const name = e.target.value
          setSelected(name)
          const p = presets.find((x) => x.name === name)
          if (p) onLoad(JSON.parse(JSON.stringify(p.settings)) as T)
        }}
      >
        <option value="">{presets.length ? 'Choose…' : 'None saved yet'}</option>
        {presets.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      <Button size="sm" onClick={() => void save()}>
        Save settings…
      </Button>
      <Button
        size="sm"
        variant="quiet"
        disabled={!selected}
        onClick={() =>
          void write(presets.filter((p) => p.name !== selected))
            .then(() => setSelected(''))
            .catch((err) => showError(err, 'Could not delete the settings'))
        }
      >
        Delete
      </Button>
    </div>
  )
}

// ---- applying ---------------------------------------------------------------------------------

/** Applies marks as one undoable step, with a progress indicator for long documents. */
export async function applyMarksFromUi(
  doc: DocumentModel,
  settings: MarkSettings,
  mode: 'add' | 'replace'
): Promise<boolean> {
  const name = MARK_NAMES_LOWER[settings.type]
  const verb = mode === 'replace' ? 'Updating' : 'Adding'
  try {
    const run = (report?: (f: number | null, m?: string) => void) =>
      marksApi(doc, report ? (f, m) => report(f, m) : undefined).apply(settings, { mode })
    const res =
      doc.pageCount > 40
        ? await withProgress(`${verb} ${name}…`, (report) => run(report))
        : await doc.busyWhile(`${verb} ${name}…`, () => run())
    rememberSettings(settings)
    toast(
      `${mode === 'replace' ? 'Updated' : 'Added'} ${name} on ${res.pages} ${res.pages === 1 ? 'page' : 'pages'}`,
      {
        kind: 'success',
        timeout: 2500
      }
    )
    return true
  } catch (err) {
    showError(err, `Could not ${mode === 'replace' ? 'update' : 'add'} the ${name}`)
    return false
  }
}
