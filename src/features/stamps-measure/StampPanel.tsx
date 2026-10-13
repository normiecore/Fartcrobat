import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, Ellipsis, ImagePlus, Pencil, Pin, Search, Stamp, Trash2 } from 'lucide-react'
import {
  Button,
  confirm,
  DropdownMenu,
  EmptyState,
  FloatingAt,
  prompt,
  setPrefs,
  setTool,
  TextInput,
  ToolPanelFrame,
  useApp,
  usePrefs,
  type DocumentModel
} from '@renderer/sdk'
import { BUILTIN_STAMPS, CATEGORY_LABELS, customStampDef, type StampCategory, type StampDef } from './stampCatalog'
import { openCustomStampDialog } from './CustomStampDialog'
import { EscapeGuard, useEscapeGuard } from './escapeGuard'
import { useStampPreview } from './stampRender'
import { deleteCustomStamp, loadStamps, renameCustomStamp, selectStamp, useCurrentStamp, useStamps } from './stampStore'
import { clickRect } from './stampGeometry'
import { placeStamp } from './stampPlace'

const ORDER: StampCategory[] = ['dynamic', 'signhere', 'standard', 'custom']

function StampTile({ def, doc, active, onPick }: { def: StampDef; doc: DocumentModel | null; active: boolean; onPick: () => void }) {
  const preview = useStampPreview(def, doc)
  const custom = def.category === 'custom'
  const id = def.id.slice('custom:'.length)
  return (
    <div className={`fc-stamps-measure-tile ${active ? 'is-active' : ''}`}>
      <button
        type="button"
        className="fc-stamps-measure-tile-btn"
        aria-label={`${def.label} stamp`}
        aria-pressed={active}
        title={def.label}
        onClick={onPick}
      >
        <span className="fc-stamps-measure-tile-img">
          {preview ? <img src={preview} alt="" draggable={false} /> : <span className="fc-stamps-measure-tile-loading" />}
        </span>
        <span className="fc-stamps-measure-tile-label">{def.label}</span>
      </button>
      {custom && (
        <DropdownMenu
          align="right"
          trigger={(t) => (
            <>
              <button
                type="button"
                className="fc-stamps-measure-tile-more"
                aria-label={`More options for ${def.label}`}
                title="Rename or delete"
                {...t}
              >
                <Ellipsis size={14} />
              </button>
              {t['aria-expanded'] && <EscapeGuard />}
            </>
          )}
          items={[
            {
              id: 'rename',
              label: 'Rename…',
              icon: Pencil,
              run: () =>
                void (async () => {
                  const name = await prompt({
                    title: 'Rename stamp',
                    label: 'Name',
                    initial: def.label,
                    okLabel: 'Rename',
                    validate: (v) => (v.trim() ? null : 'Enter a name')
                  })
                  if (name) await renameCustomStamp(id, name.trim())
                })()
            },
            {
              id: 'delete',
              label: 'Delete',
              icon: Trash2,
              danger: true,
              run: () =>
                void (async () => {
                  const ok = await confirm({
                    title: 'Delete stamp',
                    message: `Delete the custom stamp “${def.label}”? Stamps already placed in documents stay.`,
                    confirmLabel: 'Delete',
                    danger: true
                  })
                  if (ok) await deleteCustomStamp(id)
                })()
            }
          ]}
        />
      )}
    </div>
  )
}

/** The stamp palette: Dynamic, Sign Here, Standard Business and Custom stamps. */
export function StampPalette({ doc, onPicked, compact }: { doc: DocumentModel | null; onPicked?: () => void; compact?: boolean }) {
  const custom = useStamps((s) => s.custom)
  const selectedId = useStamps((s) => s.selectedId)
  const [query, setQuery] = useState('')
  useEffect(() => {
    void loadStamps()
  }, [])
  const all = useMemo(() => [...BUILTIN_STAMPS, ...custom.map(customStampDef)], [custom])
  const q = query.trim().toLowerCase()
  const filtered = q ? all.filter((d) => d.label.toLowerCase().includes(q) || CATEGORY_LABELS[d.category].toLowerCase().includes(q)) : all
  const pick = (def: StampDef) => {
    selectStamp(def.id)
    setTool('stamps.stamp')
    onPicked?.()
  }
  return (
    <div className={`fc-stamps-measure-palette ${compact ? 'is-compact' : ''}`}>
      <div className="fc-stamps-measure-search">
        <Search size={14} />
        <TextInput
          type="search"
          aria-label="Search stamps"
          placeholder="Search stamps"
          autoFocus={compact}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {ORDER.map((cat) => {
        const items = filtered.filter((d) => d.category === cat)
        if (cat !== 'custom' && !items.length) return null
        if (cat === 'custom' && q && !items.length) return null
        return (
          <section key={cat} className="fc-stamps-measure-cat" aria-label={CATEGORY_LABELS[cat]}>
            <div className="fc-stamps-measure-cat-header">
              <h4>{CATEGORY_LABELS[cat]}</h4>
              {cat === 'custom' && (
                <Button size="sm" variant="quiet" icon={ImagePlus} onClick={() => void openCustomStampDialog().then((c) => c && onPicked?.())}>
                  Create
                </Button>
              )}
            </div>
            {items.length ? (
              <div className="fc-stamps-measure-grid">
                {items.map((d) => (
                  <StampTile key={d.id} def={d} doc={doc} active={d.id === selectedId} onPick={() => pick(d)} />
                ))}
              </div>
            ) : (
              <div className="fc-stamps-measure-muted fc-stamps-measure-custom-empty">
                Turn a logo, signature or any picture or PDF page into a stamp you can reuse.
              </div>
            )}
          </section>
        )
      })}
      {q && !filtered.length && <EmptyState icon={Stamp} title="No stamps match" />}
    </div>
  )
}

/** Left pane of "Add a stamp". */
export function StampPanel({ doc }: { doc: DocumentModel | null }) {
  return (
    <ToolPanelFrame
      title="Add a stamp"
      footer={
        <Button icon={ImagePlus} onClick={() => void openCustomStampDialog()}>
          Create custom stamp…
        </Button>
      }
    >
      <p className="fc-stamps-measure-hint">Pick a stamp, then click on the page to place it — or drag to choose its size.</p>
      <StampPalette doc={doc} />
    </ToolPanelFrame>
  )
}

/** Contextual toolbar of the Stamp tool. */
export function StampToolbar({ doc }: { doc: DocumentModel }) {
  const def = useCurrentStamp()
  const preview = useStampPreview(def, doc)
  const prefs = usePrefs()
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const open = !!at
  const close = () => setAt(null)
  // Esc closes the palette, not the Stamp tool too
  useEscapeGuard(open)
  useEffect(() => {
    void loadStamps()
  }, [])
  const placeCentered = () => {
    const page = doc.state.currentPage
    const info = doc.state.info.pages[page]
    if (!info) return
    void placeStamp(doc, page, def, clickRect(def, [info.width / 2, info.height / 2], info.width, info.height))
  }
  return (
    <div className="fc-stamps-measure-toolbar" role="group" aria-label="Stamp options">
      <span className="fc-stamps-measure-toolbar-label">Stamp</span>
      <button
        type="button"
        className="fc-stamps-measure-picker"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Choose stamp (current: ${def.label})`}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt(at ? null : { x: r.left, y: r.bottom + 4 })
        }}
      >
        {preview ? <img src={preview} alt="" /> : <Stamp size={16} />}
        <span>{def.label}</span>
        <ChevronDown size={14} />
      </button>
      {at && (
        <FloatingAt x={at.x} y={at.y} onClose={close}>
          <div className="fc-stamps-measure-palette-popover" role="dialog" aria-label="Stamps">
            <StampPalette doc={doc} compact onPicked={close} />
          </div>
        </FloatingAt>
      )}
      <Button size="sm" variant="quiet" onClick={placeCentered} title="Place the stamp in the middle of the current page">
        Place on page
      </Button>
      <Button size="sm" variant="quiet" icon={ImagePlus} onClick={() => void openCustomStampDialog()}>
        Custom stamp…
      </Button>
      <span className="fc-stamps-measure-spacer" />
      <button
        type="button"
        className={`ui-icon-btn ${prefs.keepToolSelected ? 'is-active' : ''}`}
        aria-pressed={prefs.keepToolSelected}
        aria-label="Keep tool selected"
        title="Keep tool selected"
        onClick={() => void setPrefs({ keepToolSelected: !useApp.getState().prefs.keepToolSelected })}
      >
        <Pin size={16} />
      </button>
      <span className="fc-stamps-measure-hint">Click to place · drag to size · Esc to stop</span>
    </div>
  )
}
