import { useEffect, useState } from 'react'
import { CheckCircle2, FolderOpen, Search, TriangleAlert } from 'lucide-react'
import { Button, Checkbox, Field, invoke, isMac, Select, setPrefs, showError, TextInput, usePrefs } from '@renderer/sdk'
import { DPI_CHOICES, FORMAT_INFO, LIBREOFFICE_DOWNLOAD_URL, type ExportFormat, type LibreOfficeInfo } from './shared'
import { loadSettings, setHtmlConvert, setImagePage, setOptions, useExportCreate } from './state'

const P = 'fc-export-create'

type Detection = { state: 'idle' } | { state: 'checking' } | { state: 'found'; info: LibreOfficeInfo; asked: string } | { state: 'missing'; asked: string }

function LibreOfficeSetting() {
  const prefs = usePrefs()
  const [path, setPath] = useState(prefs.libreOfficePath)
  const [detection, setDetection] = useState<Detection>({ state: 'idle' })
  useEffect(() => setPath(prefs.libreOfficePath), [prefs.libreOfficePath])

  const detect = async (asked = path) => {
    setDetection({ state: 'checking' })
    try {
      const info = await invoke('feature:export-create:findLibreOffice', asked.trim())
      setDetection(info ? { state: 'found', info, asked: asked.trim() } : { state: 'missing', asked: asked.trim() })
    } catch (err) {
      setDetection({ state: 'idle' })
      showError(err, 'Could not look for LibreOffice')
    }
  }
  const save = (value: string) => {
    setPath(value)
    void setPrefs({ libreOfficePath: value.trim() })
  }
  const browse = async () => {
    const picked = await invoke('file:openDialog', {
      title: 'Where is LibreOffice?',
      filters: isMac ? [{ name: 'All files', extensions: ['*'] }] : [{ name: 'LibreOffice', extensions: navigator.userAgent.includes('Windows') ? ['exe'] : ['*'] }],
      defaultPath: isMac ? '/Applications' : undefined
    })
    if (picked[0]) {
      let p = picked[0]
      // Choosing the app bundle on macOS means its soffice program.
      if (isMac && p.endsWith('.app')) p += '/Contents/MacOS/soffice'
      save(p)
      void detect(p)
    }
  }

  return (
    <div className={`${P}-lo`}>
      <Field label="LibreOffice (converts Word, Excel and PowerPoint files)" hint="Leave empty to find it automatically.">
        <div className={`${P}-lo-row`}>
          <TextInput
            value={path}
            placeholder={isMac ? '/Applications/LibreOffice.app/Contents/MacOS/soffice' : navigator.userAgent.includes('Windows') ? 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' : '/usr/bin/soffice'}
            onChange={(e) => setPath(e.target.value)}
            onBlur={() => save(path)}
            aria-label="LibreOffice program"
          />
          <Button icon={FolderOpen} onClick={() => void browse()}>
            Browse…
          </Button>
          <Button icon={Search} onClick={() => void detect()} disabled={detection.state === 'checking'} data-testid="lo-detect">
            {detection.state === 'checking' ? 'Looking…' : 'Detect'}
          </Button>
        </div>
      </Field>
      {detection.state === 'found' && (
        <p className={`${P}-note is-success`} data-testid="lo-status">
          <CheckCircle2 size={14} />
          <span>
            {detection.asked && detection.asked !== detection.info.path ? `The program you entered doesn’t work. Found ` : 'Found '}
            LibreOffice{detection.info.version ? ` ${detection.info.version}` : ''} at {detection.info.path}.
            {detection.asked && detection.asked !== detection.info.path && (
              <>
                {' '}
                <button type="button" className={`${P}-link`} onClick={() => save(detection.info.path)}>
                  Use it
                </button>
              </>
            )}
          </span>
        </p>
      )}
      {detection.state === 'missing' && (
        <p className={`${P}-note is-warning`} data-testid="lo-status">
          <TriangleAlert size={14} />
          <span>
            LibreOffice was not found. Word, Excel and PowerPoint files still open with the built-in converter, with simpler layout. Get LibreOffice
            for free at {LIBREOFFICE_DOWNLOAD_URL}{' '}
            <button type="button" className={`${P}-link`} onClick={() => void invoke('shell:openExternal', LIBREOFFICE_DOWNLOAD_URL)}>
              (open the download page)
            </button>
          </span>
        </p>
      )}
    </div>
  )
}

export function ConvertSettings() {
  const options = useExportCreate((s) => s.options)
  const imagePage = useExportCreate((s) => s.imagePage)
  const html = useExportCreate((s) => s.html)
  useEffect(() => {
    void loadSettings()
  }, [])
  const formats: ExportFormat[] = ['word', 'excel', 'powerpoint', 'image', 'html', 'text']
  return (
    <div className="prefs-grid">
      <LibreOfficeSetting />
      <Field label="Export a PDF to">
        <Select<ExportFormat> value={options.format} onChange={(format) => setOptions({ format })} options={formats.map((f) => ({ value: f, label: FORMAT_INFO[f].label }))} />
      </Field>
      <Field label="Word documents">
        <Select<'flowing' | 'page'>
          value={options.word.layout}
          onChange={(layout) => setOptions((o) => ({ ...o, word: { ...o.word, layout } }))}
          options={[
            { value: 'flowing', label: 'Retain flowing text' },
            { value: 'page', label: 'Retain page layout' }
          ]}
        />
      </Field>
      <Field label="Images">
        <Select<string>
          value={`${options.image.format}:${options.image.dpi}`}
          onChange={(v) => {
            const [format, dpi] = v.split(':')
            setOptions((o) => ({ ...o, image: { ...o.image, format: format as 'png' | 'jpeg' | 'tiff', dpi: parseInt(dpi, 10) } }))
          }}
          options={(['png', 'jpeg', 'tiff'] as const).flatMap((f) => DPI_CHOICES.map((d) => ({ value: `${f}:${d}`, label: `${f === 'jpeg' ? 'JPEG' : f.toUpperCase()}, ${d} dpi` })))}
        />
      </Field>
      <Field label="Pages made from images">
        <Select<string>
          value={imagePage.pageSize}
          onChange={(v) => setImagePage({ pageSize: v as 'image' | 'letter' | 'a4' })}
          options={[
            { value: 'image', label: 'Same size as each image' },
            { value: 'letter', label: 'Letter, image fitted inside the margins' },
            { value: 'a4', label: 'A4, image fitted inside the margins' }
          ]}
        />
      </Field>
      <Field label="Web pages (HTML) to PDF">
        <Select<string>
          value={`${html.pageSize}:${html.landscape ? 'l' : 'p'}`}
          onChange={(v) => {
            const [pageSize, o] = v.split(':')
            setHtmlConvert({ pageSize: pageSize as 'Letter' | 'A4' | 'Legal', landscape: o === 'l' })
          }}
          options={(['Letter', 'A4', 'Legal'] as const).flatMap((s) => [
            { value: `${s}:p`, label: `${s}, portrait` },
            { value: `${s}:l`, label: `${s}, landscape` }
          ])}
        />
      </Field>
      <div className="prefs-checks">
        <Checkbox checked={html.printBackground} onChange={(printBackground) => setHtmlConvert({ printBackground })} label="Include background colours and images of web pages" />
        <Checkbox checked={options.openAfter} onChange={(openAfter) => setOptions({ openAfter })} label="Open exported files when they are ready" />
      </div>
    </div>
  )
}
