import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Dialog,
  dirname,
  invoke,
  NumberInput,
  openDialog,
  registry,
  runCommand,
  Select,
  showError,
  TextArea,
  TextInput,
  useDocState,
  usePrefs,
  type DocumentModel
} from '@renderer/sdk'
import { navOps, refreshInfo } from './actions'
import type { DocumentPropertiesData, FontInfo, InitialLayout, InitialMagnification, InitialView, NavigationTab, PropertiesPatch } from './types'
import { customKeyError, formatBytes, formatDate, formatPageList, formatPageSize, pdfVersionLabel } from './util'

type Tab = 'description' | 'security' | 'fonts' | 'initial' | 'custom'

const TABS: { id: Tab; label: string }[] = [
  { id: 'description', label: 'Description' },
  { id: 'security', label: 'Security' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'initial', label: 'Initial View' },
  { id: 'custom', label: 'Custom' }
]

type MetaKey = 'title' | 'author' | 'subject' | 'keywords'

export function openDocumentProperties(doc: DocumentModel, tab: Tab = 'description') {
  void openDialog((close) => <PropertiesDialog doc={doc} close={() => close()} initialTab={tab} />)
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="fc-navigation-props-label">{label}</div>
      <div className="fc-navigation-props-value">{children}</div>
    </>
  )
}

// ---- Description -----------------------------------------------------------------------------------

function DescriptionTab({
  doc,
  meta,
  setMeta,
  props
}: {
  doc: DocumentModel
  meta: Record<MetaKey, string>
  setMeta: (k: MetaKey, v: string) => void
  props: DocumentPropertiesData | null
}) {
  const info = useDocState(doc, (s) => s.info)
  const filePath = useDocState(doc, (s) => s.filePath)
  const title = useDocState(doc, (s) => s.title)
  const current = useDocState(doc, (s) => s.currentPage)
  const units = usePrefs().measurementUnits
  const [stat, setStat] = useState<{ size: number; mtimeMs: number } | null | undefined>(undefined)
  useEffect(() => {
    if (!filePath) {
      setStat(null)
      return
    }
    let alive = true
    invoke('file:stat', filePath)
      .then((s) => alive && setStat(s))
      .catch(() => alive && setStat(null))
    return () => {
      alive = false
    }
  }, [filePath])
  const page = info.pages[current] ?? info.pages[0]
  const m = info.metadata
  const field = (k: MetaKey, label: string, multiline = false) => (
    <Row label={label}>
      {multiline ? (
        <TextArea aria-label={label} rows={2} value={meta[k]} onChange={(e) => setMeta(k, e.target.value)} />
      ) : (
        <TextInput aria-label={label} value={meta[k]} onChange={(e) => setMeta(k, e.target.value)} data-autofocus={k === 'title' ? true : undefined} />
      )}
    </Row>
  )
  return (
    <div className="fc-navigation-props-tab">
      <div className="fc-navigation-props-grid">
        <Row label="File">{title}</Row>
        {field('title', 'Title')}
        {field('author', 'Author')}
        {field('subject', 'Subject')}
        {field('keywords', 'Keywords', true)}
      </div>
      <hr className="fc-navigation-props-sep" />
      <div className="fc-navigation-props-grid">
        <Row label="Created">{formatDate(m.creationDate)}</Row>
        <Row label="Modified">{formatDate(m.modDate)}</Row>
        <Row label="Application">{m.creator || '—'}</Row>
      </div>
      <h4 className="fc-navigation-props-heading">Advanced</h4>
      <div className="fc-navigation-props-grid">
        <Row label="PDF Producer">{m.producer || '—'}</Row>
        <Row label="PDF Version">{info.converted ? `${pdfVersionLabel(info.version)}, converted from ${info.format}` : pdfVersionLabel(info.version)}</Row>
        <Row label="Location">{filePath ? dirname(filePath) : 'Not saved yet'}</Row>
        <Row label="File Size">{stat === undefined ? '…' : stat ? formatBytes(stat.size, true) : 'Not saved yet'}</Row>
        <Row label="Page Size">{page ? formatPageSize(page.width, page.height, units) : '—'}</Row>
        <Row label="Number of Pages">{info.pageCount}</Row>
        <Row label="Tagged PDF">{props ? (props.tagged ? 'Yes' : 'No') : '…'}</Row>
        <Row label="Language">{info.language || '—'}</Row>
        <Row label="Fast Web View">No</Row>
      </div>
    </div>
  )
}

// ---- Security --------------------------------------------------------------------------------------

function SecurityTab({ doc, close }: { doc: DocumentModel; close: () => void }) {
  const info = useDocState(doc, (s) => s.info)
  const p = info.permissions
  const allowed = (v: boolean) => (v ? 'Allowed' : 'Not Allowed')
  const rows: [string, string][] = [
    ['Printing', p.print ? (p['print-hq'] ? 'High Resolution' : 'Low Resolution (150 dpi)') : 'Not Allowed'],
    ['Changing the Document', allowed(p.edit)],
    ['Document Assembly', allowed(p.assemble)],
    ['Content Copying', allowed(p.copy)],
    ['Content Copying for Accessibility', allowed(p.accessibility)],
    ['Page Extraction', allowed(p.copy)],
    ['Commenting', allowed(p.annotate)],
    ['Filling of form fields', allowed(p.form || p.annotate)],
    ['Signing', allowed(p.form || p.annotate)],
    ['Creation of Template Pages', allowed(p.edit && p.assemble)]
  ]
  const encrypted = !!info.encryption
  const change = encrypted ? (registry.commands.has('protect.removeSecurity') ? 'protect.removeSecurity' : null) : registry.commands.has('protect.encrypt') ? 'protect.encrypt' : null
  return (
    <div className="fc-navigation-props-tab">
      <div className="fc-navigation-props-grid">
        <Row label="Security Method">{encrypted ? 'Password Security' : 'No Security'}</Row>
        {encrypted && <Row label="Encryption">{info.encryption!.replace(/^Standard\s+/i, '')}</Row>}
      </div>
      {change && (
        <div className="fc-navigation-props-actions">
          <Button
            size="sm"
            onClick={() => {
              close()
              void runCommand(change)
            }}
          >
            {encrypted ? 'Remove Security…' : 'Protect with a password…'}
          </Button>
        </div>
      )}
      <h4 className="fc-navigation-props-heading">Document Restrictions Summary</h4>
      <div className="fc-navigation-props-grid fc-navigation-props-perms">
        {rows.map(([label, value]) => (
          <Row key={label} label={label}>
            <span className={value === 'Not Allowed' ? 'fc-navigation-denied' : 'fc-navigation-allowed'}>{value}</span>
          </Row>
        ))}
      </div>
      {encrypted && (
        <p className="fc-navigation-hint">
          These restrictions are set by the document's author. Fartcrobat respects them where the PDF format requires it.
        </p>
      )}
    </div>
  )
}

// ---- Fonts -----------------------------------------------------------------------------------------

const FONT_CHUNK = 8

function FontsTab({ doc }: { doc: DocumentModel }) {
  const pageCount = useDocState(doc, (s) => s.info.pageCount)
  const [fonts, setFonts] = useState<FontInfo[]>([])
  const [scanned, setScanned] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const merged = new Map<string, FontInfo>()
    ;(async () => {
      for (let from = 0; from < pageCount && alive; from += FONT_CHUNK) {
        const chunk = await navOps(doc).fonts(from, Math.min(pageCount, from + FONT_CHUNK))
        for (const f of chunk) {
          const key = f.id ? `#${f.id}` : `${f.name}|${f.type}|${f.embedded}`
          const cur = merged.get(key)
          if (cur) cur.pages = [...cur.pages, ...f.pages]
          else merged.set(key, { ...f })
        }
        if (!alive) return
        setFonts([...merged.values()].sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type)))
        setScanned(Math.min(pageCount, from + FONT_CHUNK))
      }
    })().catch((err) => alive && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [doc, pageCount])
  const done = scanned >= pageCount
  return (
    <div className="fc-navigation-props-tab">
      <div className="fc-navigation-fonts-status" aria-live="polite">
        {error
          ? `The fonts could not be read: ${error}`
          : done
            ? `${fonts.length} ${fonts.length === 1 ? 'font' : 'fonts'} used in this document`
            : `Scanning page ${scanned + 1} of ${pageCount}…`}
      </div>
      {!done && !error && (
        <div className="fc-navigation-progress" role="progressbar" aria-valuenow={Math.round((scanned / Math.max(1, pageCount)) * 100)}>
          <div style={{ width: `${(scanned / Math.max(1, pageCount)) * 100}%` }} />
        </div>
      )}
      <ul className="fc-navigation-fonts" aria-label="Fonts">
        {fonts.map((f) => (
          <li key={`${f.id}-${f.name}-${f.type}`} className="fc-navigation-font">
            <div className="fc-navigation-font-name">
              {f.name}{' '}
              <span className={f.embedded ? 'fc-navigation-allowed' : 'fc-navigation-warn'}>
                ({f.embedded ? (f.subset ? 'Embedded Subset' : 'Embedded') : 'Not embedded'})
              </span>
            </div>
            <div className="fc-navigation-font-meta">
              Type: {f.type} · Encoding: {f.encoding} · {f.pages.length === 1 ? 'Page' : 'Pages'} {formatPageList(f.pages)}
            </div>
          </li>
        ))}
      </ul>
      {done && fonts.some((f) => !f.embedded) && (
        <p className="fc-navigation-hint">Fonts that are not embedded are replaced with similar fonts on screen and when printing.</p>
      )}
    </div>
  )
}

// ---- Initial View ----------------------------------------------------------------------------------

const NAV_TABS: { value: NavigationTab; label: string }[] = [
  { value: 'page', label: 'Page Only' },
  { value: 'bookmarks', label: 'Bookmarks Panel and Page' },
  { value: 'thumbnails', label: 'Page Thumbnails Panel and Page' },
  { value: 'attachments', label: 'Attachments Panel and Page' },
  { value: 'layers', label: 'Layers Panel and Page' }
]

const LAYOUTS: { value: InitialLayout; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'single', label: 'Single Page' },
  { value: 'continuous', label: 'Single Page Continuous' },
  { value: 'two-up', label: 'Two-Up (Facing)' },
  { value: 'two-up-continuous', label: 'Two-Up Continuous (Facing)' },
  { value: 'two-up-cover', label: 'Two-Up (Cover Page)' },
  { value: 'two-up-continuous-cover', label: 'Two-Up Continuous (Cover Page)' }
]

const MAGNIFICATIONS: { value: string; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'actual-size', label: 'Actual Size' },
  { value: 'fit-page', label: 'Fit Page' },
  { value: 'fit-width', label: 'Fit Width' },
  { value: 'fit-height', label: 'Fit Height' },
  { value: 'fit-visible', label: 'Fit Visible' },
  ...[0.25, 0.5, 0.75, 1.25, 1.5, 2, 4].map((z) => ({ value: String(z), label: `${z * 100}%` }))
]

function InitialViewTab({ view, setView, pageCount }: { view: InitialView; setView: (v: InitialView) => void; pageCount: number }) {
  const mag = typeof view.magnification === 'number' ? String(view.magnification) : view.magnification
  const magOptions = MAGNIFICATIONS.some((o) => o.value === mag)
    ? MAGNIFICATIONS
    : [...MAGNIFICATIONS, { value: mag, label: `${Math.round(Number(mag) * 100)}%` }]
  return (
    <div className="fc-navigation-props-tab">
      <h4 className="fc-navigation-props-heading">Layout and Magnification</h4>
      <div className="fc-navigation-props-grid">
        <Row label="Navigation tab">
          <Select<NavigationTab> aria-label="Navigation tab" value={view.navigationTab} options={NAV_TABS} onChange={(v) => setView({ ...view, navigationTab: v })} />
        </Row>
        <Row label="Page layout">
          <Select<InitialLayout> aria-label="Page layout" value={view.pageLayout} options={LAYOUTS} onChange={(v) => setView({ ...view, pageLayout: v })} />
        </Row>
        <Row label="Magnification">
          <Select<string>
            aria-label="Magnification"
            value={mag}
            options={magOptions}
            onChange={(v) => setView({ ...view, magnification: (/^[a-z-]+$/.test(v) ? v : parseFloat(v)) as InitialMagnification })}
          />
        </Row>
        <Row label="Open to page">
          <span className="fc-navigation-props-inline">
            <NumberInput
              aria-label="Open to page"
              value={view.openToPage + 1}
              min={1}
              max={pageCount}
              onChange={(v) => setView({ ...view, openToPage: Math.max(0, Math.min(pageCount - 1, Math.round(v) - 1)) })}
            />
            <span className="shell-muted">of {pageCount}</span>
          </span>
        </Row>
      </div>
      {view.openActionIsScript && (
        <p className="fc-navigation-hint">
          This document runs a script when it opens. Changing the page or magnification replaces that script.
        </p>
      )}
      <p className="fc-navigation-hint">These settings are saved in the document and apply whenever it is opened.</p>
    </div>
  )
}

// ---- Custom ----------------------------------------------------------------------------------------

function CustomTab({ entries, setEntries }: { entries: { key: string; value: string }[]; setEntries: (e: { key: string; value: string }[]) => void }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const error = customKeyError(name)
  const exists = entries.some((e) => e.key === name.trim())
  const add = () => {
    setTouched(true)
    if (error) return
    const key = name.trim()
    setEntries(exists ? entries.map((e) => (e.key === key ? { key, value } : e)) : [...entries, { key, value }])
    setSelected(key)
    setTouched(false)
  }
  return (
    <div className="fc-navigation-props-tab">
      <h4 className="fc-navigation-props-heading">Custom Properties</h4>
      <div className="fc-navigation-custom-form">
        <label className="ui-field">
          <span className="ui-field-label">Name</span>
          <TextInput
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setTouched(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                add()
              }
            }}
          />
        </label>
        <label className="ui-field">
          <span className="ui-field-label">Value</span>
          <TextInput
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                add()
              }
            }}
          />
        </label>
        <div className="fc-navigation-custom-buttons">
          <Button size="sm" onClick={add} disabled={!name.trim()}>
            {exists ? 'Change' : 'Add'}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabled={selected === null}
            onClick={() => {
              setEntries(entries.filter((e) => e.key !== selected))
              setSelected(null)
              setName('')
              setValue('')
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      {touched && error && <div className="ui-field-error">{error}</div>}
      <div className="fc-navigation-custom-table" role="listbox" aria-label="Custom properties">
        <div className="fc-navigation-custom-head" role="presentation">
          <span>Name</span>
          <span>Value</span>
        </div>
        {entries.length === 0 && <div className="fc-navigation-custom-empty">No custom properties.</div>}
        {entries.map((e) => (
          <div
            key={e.key}
            role="option"
            tabIndex={0}
            aria-selected={selected === e.key}
            className={`fc-navigation-custom-row ${selected === e.key ? 'is-selected' : ''}`}
            onClick={() => {
              setSelected(e.key)
              setName(e.key)
              setValue(e.value)
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault()
                setSelected(e.key)
                setName(e.key)
                setValue(e.value)
              }
            }}
          >
            <span>{e.key}</span>
            <span>{e.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---- dialog ----------------------------------------------------------------------------------------

function sameView(a: InitialView, b: InitialView, k: keyof InitialView) {
  return a[k] === b[k]
}

export function PropertiesDialog({ doc, close, initialTab = 'description' }: { doc: DocumentModel; close: () => void; initialTab?: Tab }) {
  const info = useDocState(doc, (s) => s.info)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [props, setProps] = useState<DocumentPropertiesData | null>(null)
  const [meta, setMetaState] = useState<Record<MetaKey, string>>(() => ({
    title: info.metadata.title,
    author: info.metadata.author,
    subject: info.metadata.subject,
    keywords: info.metadata.keywords
  }))
  const original = useRef(meta)
  const [view, setView] = useState<InitialView | null>(null)
  const [custom, setCustom] = useState<{ key: string; value: string }[] | null>(null)
  const [saving, setSaving] = useState(false)
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  useEffect(() => {
    let alive = true
    navOps(doc)
      .properties()
      .then((p) => {
        if (!alive) return
        setProps(p)
        setView(p.initialView)
        setCustom(p.custom)
      })
      .catch((err) => showError(err, 'Could not read the document properties'))
    return () => {
      alive = false
    }
  }, [doc])

  const patch = useMemo((): PropertiesPatch => {
    const out: PropertiesPatch = {}
    const metadata: PropertiesPatch['metadata'] = {}
    for (const k of Object.keys(meta) as MetaKey[]) if (meta[k] !== original.current[k]) metadata[k] = meta[k]
    if (Object.keys(metadata).length) out.metadata = metadata
    if (props && view) {
      const iv: NonNullable<PropertiesPatch['initialView']> = {}
      const keys: (keyof InitialView)[] = ['navigationTab', 'pageLayout', 'magnification', 'openToPage']
      for (const k of keys) if (!sameView(view, props.initialView, k)) (iv as Record<string, unknown>)[k] = view[k]
      if (Object.keys(iv).length) out.initialView = iv
    }
    if (props && custom && JSON.stringify(custom) !== JSON.stringify(props.custom)) out.custom = custom
    return out
  }, [meta, props, view, custom])

  const ok = async () => {
    if (!Object.keys(patch).length) {
      close()
      return
    }
    setSaving(true)
    try {
      await navOps(doc).setProperties(patch)
      await refreshInfo(doc)
      close()
    } catch (err) {
      showError(err, 'Could not change the document properties')
      setSaving(false)
    }
  }

  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const i = TABS.findIndex((t) => t.id === tab)
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
    setTab(next.id)
    tabRefs.current[next.id]?.focus()
  }

  return (
    <Dialog
      title="Document Properties"
      onClose={close}
      onSubmit={() => void ok()}
      width={640}
      className="fc-navigation-props"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={() => void ok()} disabled={saving}>
            OK
          </Button>
        </>
      }
    >
      <div className="fc-navigation-tabs" role="tablist" aria-label="Document properties" onKeyDown={onTabKey}>
        {TABS.map((t) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el
            }}
            type="button"
            role="tab"
            id={`fc-navigation-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`fc-navigation-tabpanel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            className={`fc-navigation-tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="fc-navigation-tabpanel" role="tabpanel" id={`fc-navigation-tabpanel-${tab}`} aria-labelledby={`fc-navigation-tab-${tab}`}>
        {tab === 'description' && (
          <DescriptionTab doc={doc} meta={meta} setMeta={(k, v) => setMetaState((m) => ({ ...m, [k]: v }))} props={props} />
        )}
        {tab === 'security' && <SecurityTab doc={doc} close={close} />}
        {tab === 'fonts' && <FontsTab doc={doc} />}
        {tab === 'initial' &&
          (view ? <InitialViewTab view={view} setView={setView} pageCount={info.pageCount} /> : <div className="fc-navigation-loading">Loading…</div>)}
        {tab === 'custom' &&
          (custom ? <CustomTab entries={custom} setEntries={setCustom} /> : <div className="fc-navigation-loading">Loading…</div>)}
      </div>
    </Dialog>
  )
}

