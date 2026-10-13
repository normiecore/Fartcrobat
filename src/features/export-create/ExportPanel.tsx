import { useEffect } from 'react'
import { CheckCircle2, FileCode2, FileOutput, FileSpreadsheet, FileText, FileType, FolderOpen, Image, Info, Lock, Presentation } from 'lucide-react'
import {
  basename,
  Button,
  Checkbox,
  EmptyState,
  invoke,
  isMac,
  Section,
  Segmented,
  Select,
  Slider,
  TextInput,
  ToolPanelFrame,
  useDocState,
  type DocumentModel,
  type Icon
} from '@renderer/sdk'
import { baseNameOf, exportDocument, scopePages } from './exportFlow'
import { DPI_CHOICES, FORMAT_INFO, IMAGE_EXT, pageImageName, type ExportFormat, type ExportOptions, type ImageFormat } from './shared'
import { loadSettings, setOptions, setState, useExportCreate, type PageScope } from './state'

const P = 'fc-export-create'

export const FORMAT_ICONS: Record<ExportFormat, Icon> = {
  word: FileText,
  excel: FileSpreadsheet,
  powerpoint: Presentation,
  image: Image,
  html: FileCode2,
  text: FileType
}

const FORMATS: ExportFormat[] = ['word', 'excel', 'powerpoint', 'image', 'html', 'text']

function FormatList({ value }: { value: ExportFormat }) {
  return (
    <div className={`${P}-formats`} role="radiogroup" aria-label="Convert to">
      {FORMATS.map((f) => {
        const Ico = FORMAT_ICONS[f]
        const active = f === value
        return (
          <button
            key={f}
            type="button"
            role="radio"
            aria-checked={active}
            className={`${P}-format ${active ? 'is-active' : ''}`}
            data-format={f}
            onClick={() => setOptions({ format: f })}
            onKeyDown={(e) => {
              const i = FORMATS.indexOf(f)
              const next = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? i - 1 : null
              if (next === null) return
              e.preventDefault()
              const nf = FORMATS[(next + FORMATS.length) % FORMATS.length]
              setOptions({ format: nf })
              ;(e.currentTarget.parentElement?.querySelector(`[data-format="${nf}"]`) as HTMLElement | null)?.focus()
            }}
            tabIndex={active ? 0 : -1}
          >
            <span className={`${P}-format-icon is-${f}`}>
              <Ico size={18} />
            </span>
            <span className={`${P}-format-text`}>
              <span className={`${P}-format-label`}>{FORMAT_INFO[f].label}</span>
              <span className={`${P}-format-desc`}>{FORMAT_INFO[f].description}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function RadioRow<T extends string>({ name, value, options, onChange }: { name: string; value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className={`${P}-radios`} role="radiogroup">
      {options.map((o) => (
        <label key={o.value} className={`ui-check ${P}-radio`}>
          <input type="radio" name={name} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span>
            {o.label}
            {o.hint && <span className={`${P}-radio-hint`}>{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  )
}

function FormatOptions({ o, doc }: { o: ExportOptions; doc: DocumentModel }) {
  const set = <K extends keyof ExportOptions>(key: K, patch: Partial<ExportOptions[K]>) =>
    setOptions((cur) => ({ ...cur, [key]: { ...(cur[key] as object), ...patch } }))
  switch (o.format) {
    case 'word':
      return (
        <>
          <RadioRow
            name={`${P}-word-layout`}
            value={o.word.layout}
            onChange={(layout) => set('word', { layout })}
            options={[
              { value: 'flowing', label: 'Retain flowing text', hint: 'Editable paragraphs, headings, lists and tables that reflow' },
              { value: 'page', label: 'Retain page layout', hint: 'Looks exactly like the PDF; text in frames' }
            ]}
          />
          <div className={`${P}-checks`}>
            <Checkbox checked={o.word.images} onChange={(images) => set('word', { images })} label="Include images and drawings" />
            <Checkbox checked={o.word.structure} onChange={(structure) => set('word', { structure })} label="Detect headings and lists" />
            <Checkbox checked={o.word.tables} onChange={(tables) => set('word', { tables })} label="Detect tables" />
          </div>
        </>
      )
    case 'excel':
      return (
        <>
          <RadioRow
            name={`${P}-excel-sheets`}
            value={o.excel.combine ? 'one' : 'each'}
            onChange={(v) => set('excel', { combine: v === 'one' })}
            options={[
              { value: 'each', label: 'One worksheet per page' },
              { value: 'one', label: 'Combine all pages into one worksheet' }
            ]}
          />
          <div className={`${P}-checks`}>
            <Checkbox checked={o.excel.numbers} onChange={(numbers) => set('excel', { numbers })} label="Turn numbers like $1,234.50 and 12% into numbers" />
          </div>
        </>
      )
    case 'powerpoint':
      return (
        <RadioRow
          name={`${P}-pptx-mode`}
          value={o.powerpoint.mode}
          onChange={(mode) => set('powerpoint', { mode })}
          options={[
            { value: 'editable', label: 'Editable text', hint: 'Text boxes on top of a picture of the page' },
            { value: 'image', label: 'Pictures only', hint: 'Each slide shows the page as an image' }
          ]}
        />
      )
    case 'image': {
      const img = o.image
      const base = baseNameOf(doc)
      return (
        <>
          <div className={`${P}-grid`}>
            <label className={`${P}-label`} htmlFor={`${P}-img-format`}>
              Format
            </label>
            <Select<ImageFormat>
              id={`${P}-img-format`}
              value={img.format}
              onChange={(format) => set('image', { format })}
              options={[
                { value: 'png', label: 'PNG' },
                { value: 'jpeg', label: 'JPEG' },
                { value: 'tiff', label: 'TIFF (one file, all pages)' }
              ]}
            />
            <label className={`${P}-label`} htmlFor={`${P}-img-dpi`}>
              Resolution
            </label>
            <Select<string>
              id={`${P}-img-dpi`}
              value={String(img.dpi)}
              onChange={(v) => set('image', { dpi: parseInt(v, 10) })}
              options={DPI_CHOICES.map((d) => ({ value: String(d), label: `${d} dpi${d === 72 ? ' (screen)' : d === 150 ? ' (standard)' : d === 300 ? ' (print)' : ' (high)'}` }))}
            />
            <span className={`${P}-label`}>Colour</span>
            <Segmented<'color' | 'gray'>
              value={img.grayscale ? 'gray' : 'color'}
              onChange={(v) => set('image', { grayscale: v === 'gray' })}
              options={[
                { value: 'color', label: 'Colour' },
                { value: 'gray', label: 'Grayscale' }
              ]}
            />
            {img.format === 'jpeg' && (
              <>
                <span className={`${P}-label`}>Quality</span>
                <Slider value={img.quality} min={10} max={100} step={5} onChange={(quality) => set('image', { quality })} format={(v) => `${v}%`} />
              </>
            )}
            {img.format === 'tiff' && (
              <>
                <label className={`${P}-label`} htmlFor={`${P}-img-comp`}>
                  Compression
                </label>
                <Select<'deflate' | 'none'>
                  id={`${P}-img-comp`}
                  value={img.compression}
                  onChange={(compression) => set('image', { compression })}
                  options={[
                    { value: 'deflate', label: 'ZIP (lossless, smaller)' },
                    { value: 'none', label: 'None' }
                  ]}
                />
              </>
            )}
          </div>
          <p className={`${P}-hint`}>
            <Info size={14} />
            <span>
              {img.format === 'tiff'
                ? 'All pages go into one multi-page TIFF file.'
                : `One file per page, for example “${pageImageName(base, 1, img.format)}”, in the folder you choose.`}
              {' '}
              {pixelHint(doc, img.dpi)}
            </span>
          </p>
        </>
      )
    }
    case 'html':
      return (
        <>
          <RadioRow
            name={`${P}-html-layout`}
            value={o.html.layout}
            onChange={(layout) => set('html', { layout })}
            options={[
              { value: 'page', label: 'Exact page layout', hint: 'Every page looks like the PDF' },
              { value: 'flowing', label: 'Reflowable web page', hint: 'Headings, paragraphs, lists and tables that fit any screen' }
            ]}
          />
          <div className={`${P}-checks`}>
            <Checkbox checked={o.html.images} onChange={(images) => set('html', { images })} label="Include images (built into the page)" />
          </div>
        </>
      )
    case 'text':
      return (
        <>
          <RadioRow
            name={`${P}-text-layout`}
            value={o.text.layout}
            onChange={(layout) => set('text', { layout })}
            options={[
              { value: 'lines', label: 'Keep the lines as in the PDF' },
              { value: 'paragraphs', label: 'Join lines into paragraphs' }
            ]}
          />
          <div className={`${P}-checks`}>
            <Checkbox checked={o.text.pageBreaks} onChange={(pageBreaks) => set('text', { pageBreaks })} label="Mark page breaks (form feed character)" />
          </div>
        </>
      )
  }
}

function pixelHint(doc: DocumentModel, dpi: number): string {
  const p = doc.state.info.pages[doc.state.currentPage] ?? doc.state.info.pages[0]
  if (!p) return ''
  const w = Math.round((p.width * dpi) / 72)
  const h = Math.round((p.height * dpi) / 72)
  return `This page will be ${w} × ${h} pixels.`
}

function PagesChoice({ doc, scope, range }: { doc: DocumentModel; scope: PageScope; range: string }) {
  const count = useDocState(doc, (s) => s.info.pageCount)
  const current = useDocState(doc, (s) => s.currentPage)
  const error = scope === 'range' ? scopePages(doc, scope, range) : null
  return (
    <div className={`${P}-radios`} role="radiogroup" aria-label="Pages">
      <label className={`ui-check ${P}-radio`}>
        <input type="radio" name={`${P}-scope`} checked={scope === 'all'} onChange={() => setState({ scope: 'all' })} />
        <span>All pages ({count})</span>
      </label>
      <label className={`ui-check ${P}-radio`}>
        <input type="radio" name={`${P}-scope`} checked={scope === 'current'} onChange={() => setState({ scope: 'current' })} />
        <span>Current page ({current + 1})</span>
      </label>
      <label className={`ui-check ${P}-radio ${P}-range`}>
        <input type="radio" name={`${P}-scope`} checked={scope === 'range'} onChange={() => setState({ scope: 'range' })} />
        <span>Pages</span>
        <TextInput
          aria-label="Pages to export"
          placeholder={`e.g. 1-3, ${Math.min(count, 5)}`}
          value={range}
          onFocus={() => setState({ scope: 'range' })}
          onChange={(e) => setState({ range: e.target.value, scope: 'range' })}
        />
      </label>
      {typeof error === 'string' && range.trim() !== '' && <span className="ui-field-error">{error}</span>}
    </div>
  )
}

function Outcome({ doc }: { doc: DocumentModel }) {
  const outcome = useExportCreate((s) => s.outcomes[doc.id])
  if (!outcome) return null
  const one = outcome.files.length === 1
  return (
    <div className={`${P}-result`} role="status" data-testid="export-result">
      <CheckCircle2 size={18} />
      <div className={`${P}-result-body`}>
        <div className={`${P}-result-title`}>{one ? 'Exported' : `Exported ${outcome.files.length} images`}</div>
        <div className={`${P}-result-file`} title={outcome.path}>
          {basename(one ? outcome.files[0] : outcome.path)}
        </div>
        <div className={`${P}-result-actions`}>
          {one && (
            <Button size="sm" onClick={() => void invoke('shell:openPath', outcome.files[0])}>
              Open
            </Button>
          )}
          <Button size="sm" variant="quiet" icon={FolderOpen} onClick={() => void invoke('shell:showItemInFolder', outcome.files[0])}>
            {isMac ? 'Show in Finder' : 'Show in folder'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function ExportBody({ doc }: { doc: DocumentModel }) {
  const options = useExportCreate((s) => s.options)
  const scope = useExportCreate((s) => s.scope)
  const range = useExportCreate((s) => s.range)
  const restricted = useDocState(doc, (s) => !s.info.permissions.copy)
  const dirty = useDocState(doc, (s) => s.dirty)
  return (
    <div className={`${P}-panel`}>
      <Section title="Convert to">
        <FormatList value={options.format} />
      </Section>
      <Section title="Options">
        <FormatOptions o={options} doc={doc} />
      </Section>
      <Section title="Pages">
        <PagesChoice doc={doc} scope={scope} range={range} />
      </Section>
      {!(options.format === 'image' && options.image.format !== 'tiff') && (
        <div className={`${P}-checks`}>
          <Checkbox checked={options.openAfter} onChange={(openAfter) => setOptions({ openAfter })} label="Open the file when it’s ready" />
        </div>
      )}
      {restricted && (
        <p className={`${P}-note is-warning`}>
          <Lock size={14} />
          <span>This document’s security settings don’t allow copying its content, so it can’t be exported.</span>
        </p>
      )}
      {dirty && !restricted && (
        <p className={`${P}-note`}>
          <Info size={14} />
          <span>Your unsaved changes are included.</span>
        </p>
      )}
      <Outcome doc={doc} />
    </div>
  )
}

function ExportButton({ doc }: { doc: DocumentModel }) {
  const format = useExportCreate((s) => s.options.format)
  const image = useExportCreate((s) => s.options.image.format)
  const busy = useExportCreate((s) => s.busy)
  const scope = useExportCreate((s) => s.scope)
  const range = useExportCreate((s) => s.range)
  const invalid = typeof scopePages(doc, scope, range) === 'string'
  const label = format === 'image' ? `Export to ${IMAGE_EXT[image] === 'tif' ? 'TIFF' : image.toUpperCase()}` : `Export to ${FORMAT_INFO[format].short}`
  return (
    <Button variant="primary" icon={FileOutput} className={`${P}-export-btn`} disabled={busy || invalid} onClick={() => void exportDocument(doc)} data-testid="export-run">
      {busy ? 'Exporting…' : `${label}…`}
    </Button>
  )
}

export function ExportPanel({ doc }: { doc: DocumentModel | null }) {
  useEffect(() => {
    void loadSettings()
  }, [])
  return (
    <ToolPanelFrame title="Export a PDF" footer={doc ? <ExportButton key={doc.id} doc={doc} /> : undefined}>
      {doc ? <ExportBody key={doc.id} doc={doc} /> : <EmptyState icon={FileOutput} title="Open a PDF to export it" />}
    </ToolPanelFrame>
  )
}
