import { useEffect, useState, type DragEvent, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, ClipboardPaste, File, FilePlus2, FileCode2, Files, Images, Info, Plus, Upload, X } from 'lucide-react'
import {
  Button,
  Checkbox,
  invoke,
  NumberInput,
  pathForFile,
  registry,
  runCommand,
  Segmented,
  Select,
  ToolPanelFrame,
  ToolRow,
  type DocumentModel,
  type Icon
} from '@renderer/sdk'
import {
  addCreateFiles,
  CREATE_FILTERS,
  createBlank,
  createFromClipboard,
  createFromHtml,
  createFromList,
  createFromPaths,
  pickCreateFiles,
  type CreateList
} from './createFlow'
import { HTML_EXTENSIONS, PAGE_SIZES, blankSize, extensionOf, type HtmlConvertOptions, type ImagePageOptions } from './shared'
import { loadSettings, setBlank, setHtmlConvert, setImagePage, setState, useExportCreate, type CreateSource } from './state'

const P = 'fc-export-create'

interface SourceInfo {
  id: CreateSource
  label: string
  description: string
  icon: Icon
}

export const SOURCES: SourceInfo[] = [
  { id: 'file', label: 'Single file', description: 'Word, Excel, PowerPoint, images, web pages and more', icon: File },
  { id: 'files', label: 'Multiple files', description: 'Combine several files into one PDF', icon: Files },
  { id: 'images', label: 'Images', description: 'Scans, photos and screenshots, one per page', icon: Images },
  { id: 'clipboard', label: 'Clipboard', description: 'A copied screenshot, picture or text', icon: ClipboardPaste },
  { id: 'blank', label: 'Blank page', description: 'Empty pages of the size you choose', icon: FilePlus2 },
  { id: 'html', label: 'HTML file', description: 'A web page saved on your computer', icon: FileCode2 }
]

/** Left pane of Create a PDF: what to create the PDF from. */
export function CreatePanel(_props: { doc: DocumentModel | null }) {
  const source = useExportCreate((s) => s.source)
  useEffect(() => {
    void loadSettings()
  }, [])
  return (
    <ToolPanelFrame title="Create a PDF">
      <div className={`${P}-sources`} role="group" aria-label="Create from">
        {SOURCES.map((s) => (
          <ToolRow key={s.id} icon={s.icon} label={s.label} description={s.description} active={s.id === source} onClick={() => setState({ source: s.id })} />
        ))}
      </div>
    </ToolPanelFrame>
  )
}

function useDropZone(accept: (paths: string[]) => void) {
  const [over, setOver] = useState(false)
  return {
    over,
    props: {
      onDragOver: (e: DragEvent) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false)
        if (!e.dataTransfer.files.length) return
        // Handled here: the window would otherwise open the files as they are.
        e.preventDefault()
        e.stopPropagation()
        const paths = [...e.dataTransfer.files].map(pathForFile).filter(Boolean)
        if (paths.length) accept(paths)
      }
    }
  }
}

function Card({ icon: Ico, title, children, footer }: { icon: Icon; title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className={`${P}-card`}>
      <div className={`${P}-card-head`}>
        <span className={`${P}-card-icon`}>
          <Ico size={22} />
        </span>
        <h2>{title}</h2>
      </div>
      <div className={`${P}-card-body`}>{children}</div>
      {footer && <div className={`${P}-card-footer`}>{footer}</div>}
    </div>
  )
}

function DropArea({ label, hint, onPick, onDrop }: { label: string; hint: string; onPick: () => void; onDrop: (paths: string[]) => void }) {
  const drop = useDropZone(onDrop)
  return (
    <div className={`${P}-drop ${drop.over ? 'is-over' : ''}`} {...drop.props}>
      <Upload size={28} />
      <div className={`${P}-drop-text`}>Drag a file here, or</div>
      <Button variant="primary" onClick={onPick} data-testid="create-select">
        {label}
      </Button>
      <div className={`${P}-drop-hint`}>{hint}</div>
    </div>
  )
}

function ImagePageOptionsForm({ o }: { o: ImagePageOptions }) {
  return (
    <div className={`${P}-grid`}>
      <label className={`${P}-label`} htmlFor={`${P}-imgpage-size`}>
        Page size
      </label>
      <Select<ImagePageOptions['pageSize']>
        id={`${P}-imgpage-size`}
        value={o.pageSize}
        onChange={(pageSize) => setImagePage({ pageSize })}
        options={[
          { value: 'image', label: 'Same as each image' },
          { value: 'letter', label: 'Letter (8.5 × 11 in), fitted' },
          { value: 'a4', label: 'A4 (210 × 297 mm), fitted' }
        ]}
      />
      {o.pageSize !== 'image' && (
        <>
          <label className={`${P}-label`} htmlFor={`${P}-imgpage-margin`}>
            Margins
          </label>
          <Select<string>
            id={`${P}-imgpage-margin`}
            value={String(o.margin)}
            onChange={(v) => setImagePage({ margin: parseFloat(v) })}
            options={[
              { value: '0', label: 'None' },
              { value: '18', label: 'Narrow (¼ in)' },
              { value: '36', label: 'Normal (½ in)' },
              { value: '72', label: 'Wide (1 in)' }
            ]}
          />
          <span />
          <Checkbox checked={o.autoRotate} onChange={(autoRotate) => setImagePage({ autoRotate })} label="Turn pages to landscape for wide images" />
        </>
      )}
    </div>
  )
}

function FileList({ list }: { list: CreateList }) {
  const items = useExportCreate((s) => s[list])
  const creating = useExportCreate((s) => s.creating)
  const images = list === 'images'
  const drop = useDropZone((paths) => addCreateFiles(list, paths))
  const move = (i: number, d: number) => {
    const all = [...items]
    ;[all[i], all[i + d]] = [all[i + d], all[i]]
    setState({ [list]: all })
  }
  const remove = (i: number) => setState({ [list]: items.filter((_, k) => k !== i) })
  return (
    <div className={`${P}-files ${drop.over ? 'is-over' : ''}`} {...drop.props}>
      {items.length === 0 ? (
        <div className={`${P}-files-empty`}>
          <Upload size={24} />
          <span>{images ? 'Drag images here, or add them. Each image becomes a page.' : 'Drag files here, or add them. They are combined in this order.'}</span>
        </div>
      ) : (
        <ol className={`${P}-files-list`} aria-label={images ? 'Images' : 'Files to combine'}>
          {items.map((f, i) => (
            <li key={f.path} title={f.path}>
              <span className={`${P}-files-index`}>{i + 1}</span>
              <span className={`${P}-files-name`}>{f.name}</span>
              <button type="button" className="ui-icon-btn" aria-label={`Move ${f.name} up`} disabled={i === 0 || creating} onClick={() => move(i, -1)}>
                <ArrowUp size={14} />
              </button>
              <button type="button" className="ui-icon-btn" aria-label={`Move ${f.name} down`} disabled={i === items.length - 1 || creating} onClick={() => move(i, 1)}>
                <ArrowDown size={14} />
              </button>
              <button type="button" className="ui-icon-btn" aria-label={`Remove ${f.name}`} disabled={creating} onClick={() => remove(i)}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className={`${P}-files-actions`}>
        <Button icon={Plus} onClick={() => void pickCreateFiles(list)} disabled={creating}>
          {images ? 'Add images…' : 'Add files…'}
        </Button>
        {items.length > 0 && (
          <Button variant="quiet" onClick={() => setState({ [list]: [] })} disabled={creating}>
            Clear list
          </Button>
        )}
      </div>
    </div>
  )
}

function BlankForm() {
  const b = useExportCreate((s) => s.blank)
  const creating = useExportCreate((s) => s.creating)
  const size = blankSize(b)
  const custom = b.preset === 'custom'
  const unitLabel = b.unit === 'in' ? 'in' : b.unit === 'mm' ? 'mm' : 'pt'
  return (
    <Card
      icon={FilePlus2}
      title="Blank page"
      footer={
        <Button variant="primary" disabled={creating || typeof size === 'string'} onClick={() => void createBlank(b)} data-testid="create-blank">
          Create
        </Button>
      }
    >
      <div className={`${P}-grid`}>
        <label className={`${P}-label`} htmlFor={`${P}-blank-size`}>
          Page size
        </label>
        <Select<string>
          id={`${P}-blank-size`}
          value={b.preset}
          onChange={(preset) => setBlank({ preset })}
          options={[...PAGE_SIZES.map((p) => ({ value: p.id, label: p.label })), { value: 'custom', label: 'Custom size' }]}
        />
        {custom && (
          <>
            <span className={`${P}-label`}>Width × height</span>
            <span className={`${P}-size`}>
              <NumberInput aria-label="Width" value={b.width} min={0.1} step={b.unit === 'in' ? 0.25 : 1} onChange={(width) => setBlank({ width })} />
              <span>×</span>
              <NumberInput aria-label="Height" value={b.height} min={0.1} step={b.unit === 'in' ? 0.25 : 1} onChange={(height) => setBlank({ height })} />
              <Select<'in' | 'mm' | 'pt'>
                aria-label="Units"
                value={b.unit}
                onChange={(unit) => setBlank({ unit })}
                options={[
                  { value: 'in', label: 'in' },
                  { value: 'mm', label: 'mm' },
                  { value: 'pt', label: 'pt' }
                ]}
              />
            </span>
          </>
        )}
        <span className={`${P}-label`}>Orientation</span>
        <Segmented<'portrait' | 'landscape'>
          value={b.landscape ? 'landscape' : 'portrait'}
          onChange={(v) => setBlank({ landscape: v === 'landscape' })}
          options={[
            { value: 'portrait', label: 'Portrait' },
            { value: 'landscape', label: 'Landscape' }
          ]}
        />
        <label className={`${P}-label`} htmlFor={`${P}-blank-pages`}>
          Number of pages
        </label>
        <NumberInput id={`${P}-blank-pages`} value={b.pages} min={1} max={500} onChange={(pages) => setBlank({ pages: Math.max(1, Math.min(500, Math.round(pages))) })} />
      </div>
      {typeof size === 'string' ? (
        <p className="ui-field-error">{size}</p>
      ) : (
        <p className={`${P}-hint`}>
          <Info size={14} />
          <span>
            {Math.round((size.width / 72) * 100) / 100} × {Math.round((size.height / 72) * 100) / 100} in
            {custom ? ` (${unitLabel} as entered)` : ''}. Add text, fields or pages to it afterwards.
          </span>
        </p>
      )}
    </Card>
  )
}

function HtmlForm({ o }: { o: HtmlConvertOptions }) {
  const creating = useExportCreate((s) => s.creating)
  const pick = async () => {
    const paths = await invoke('file:openDialog', { title: 'Create PDF from HTML File', filters: [{ name: 'Web pages', extensions: HTML_EXTENSIONS }] })
    if (paths[0]) await createFromHtml(paths[0])
  }
  return (
    <Card icon={FileCode2} title="HTML file">
      <div className={`${P}-grid`}>
        <label className={`${P}-label`} htmlFor={`${P}-html-size`}>
          Page size
        </label>
        <Select<HtmlConvertOptions['pageSize']>
          id={`${P}-html-size`}
          value={o.pageSize}
          onChange={(pageSize) => setHtmlConvert({ pageSize })}
          options={[
            { value: 'Letter', label: 'Letter (8.5 × 11 in)' },
            { value: 'A4', label: 'A4 (210 × 297 mm)' },
            { value: 'Legal', label: 'Legal (8.5 × 14 in)' }
          ]}
        />
        <span className={`${P}-label`}>Orientation</span>
        <Segmented<'portrait' | 'landscape'>
          value={o.landscape ? 'landscape' : 'portrait'}
          onChange={(v) => setHtmlConvert({ landscape: v === 'landscape' })}
          options={[
            { value: 'portrait', label: 'Portrait' },
            { value: 'landscape', label: 'Landscape' }
          ]}
        />
        <label className={`${P}-label`} htmlFor={`${P}-html-margin`}>
          Margins
        </label>
        <Select<string>
          id={`${P}-html-margin`}
          value={String(o.margin)}
          onChange={(v) => setHtmlConvert({ margin: parseFloat(v) })}
          options={[
            { value: '0', label: 'None' },
            { value: '0.25', label: 'Narrow (¼ in)' },
            { value: '0.5', label: 'Normal (½ in)' },
            { value: '1', label: 'Wide (1 in)' }
          ]}
        />
        <span />
        <Checkbox checked={o.printBackground} onChange={(printBackground) => setHtmlConvert({ printBackground })} label="Include background colours and images" />
      </div>
      <DropArea
        label={creating ? 'Converting…' : 'Select an HTML file'}
        hint="Fartcrobat works offline: pictures and styles from the internet are left out. To convert a page from the web, save it as a complete web page first."
        onPick={() => void pick()}
        onDrop={(paths) => {
          const html = paths.find((p) => HTML_EXTENSIONS.includes(extensionOf(p)))
          if (html) void createFromHtml(html)
        }}
      />
    </Card>
  )
}

/** The main area of Create a PDF (replaces the page view; covers Home when no document is open). */
export function CreateView(_props: { doc?: DocumentModel }) {
  const source = useExportCreate((s) => s.source)
  const files = useExportCreate((s) => s.files)
  const images = useExportCreate((s) => s.images)
  const imagePage = useExportCreate((s) => s.imagePage)
  const html = useExportCreate((s) => s.html)
  const creating = useExportCreate((s) => s.creating)
  useEffect(() => {
    void loadSettings()
  }, [])
  let body: ReactNode
  switch (source) {
    case 'file':
      body = (
        <Card icon={File} title="Create a PDF from a file">
          <DropArea
            label="Select a file"
            hint="Word, Excel and PowerPoint files are converted with LibreOffice when it is installed. Images, web pages, text, XPS and e-books work too."
            onPick={() =>
              void invoke('file:openDialog', { title: 'Create PDF from File', filters: CREATE_FILTERS }).then((p) => (p[0] ? createFromPaths([p[0]]) : null))
            }
            onDrop={(paths) => void createFromPaths([paths[0]])}
          />
        </Card>
      )
      break
    case 'files': {
      const hasCombine = registry.commands.has('combine.open')
      body = (
        <Card
          icon={Files}
          title="Combine files into one PDF"
          footer={
            <>
              {hasCombine && (
                <Button variant="quiet" onClick={() => void runCommand('combine.open')}>
                  More options in Combine files…
                </Button>
              )}
              <Button variant="primary" disabled={creating || files.length === 0} onClick={() => void createFromList('files')} data-testid="create-combine">
                {creating ? 'Creating…' : 'Create PDF'}
              </Button>
            </>
          }
        >
          <FileList list="files" />
        </Card>
      )
      break
    }
    case 'images': {
      body = (
        <Card
          icon={Images}
          title="Create a PDF from images"
          footer={
            <Button variant="primary" disabled={creating || images.length === 0} onClick={() => void createFromList('images')} data-testid="create-images">
              {creating ? 'Creating…' : 'Create PDF'}
            </Button>
          }
        >
          <ImagePageOptionsForm o={imagePage} />
          <FileList list="images" />
        </Card>
      )
      break
    }
    case 'clipboard':
      body = (
        <Card
          icon={ClipboardPaste}
          title="Create a PDF from the clipboard"
          footer={
            <Button variant="primary" disabled={creating} onClick={() => void createFromClipboard()} data-testid="create-clipboard">
              Create from clipboard
            </Button>
          }
        >
          <p className={`${P}-lead`}>
            Copy a screenshot, a picture or some text in any app, then create a PDF from it. Pictures are placed on a page using the image settings
            below; text is laid out on Letter pages.
          </p>
          <ImagePageOptionsForm o={imagePage} />
        </Card>
      )
      break
    case 'blank':
      body = <BlankForm />
      break
    case 'html':
      body = <HtmlForm o={html} />
      break
  }
  return (
    <div className={`${P}-view`} data-testid="create-view">
      <div className={`${P}-view-inner`}>{body}</div>
    </div>
  )
}
