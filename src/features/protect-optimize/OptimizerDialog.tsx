import { useEffect, useState, type ReactNode } from 'react'
import { Info } from 'lucide-react'
import { Button, Checkbox, Dialog, NumberInput, Select, Slider, openDialog, showError, type DocumentModel } from '@renderer/sdk'
import { compressDocument, poOps } from './flows'
import {
  QUALITY_PRESETS,
  formatBytes,
  presetOptions,
  type ImageClassSettings,
  type OptimizeOptions,
  type PhotoImageSettings,
  type QualityPreset,
  type SpaceAudit
} from './shared'
import { loadCompressPrefs, setCompressPrefs, useProtectOptimize } from './state'

const P = 'fc-protect-optimize'

type SectionId = 'images' | 'fonts' | 'objects' | 'userdata' | 'cleanup' | 'audit'

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'images', label: 'Images' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'objects', label: 'Discard objects' },
  { id: 'userdata', label: 'Discard user data' },
  { id: 'cleanup', label: 'Clean up' },
  { id: 'audit', label: 'Space usage' }
]

function matchingPreset(o: OptimizeOptions): QualityPreset | 'custom' {
  for (const p of QUALITY_PRESETS) if (JSON.stringify(presetOptions(p.value)) === JSON.stringify(o)) return p.value
  return 'custom'
}

function qualityName(q: number): string {
  if (q >= 90) return 'Maximum'
  if (q >= 80) return 'High'
  if (q >= 60) return 'Medium'
  if (q >= 40) return 'Low'
  return 'Minimum'
}

function ResolutionRow({
  set,
  onChange,
  label
}: {
  set: ImageClassSettings
  onChange: (patch: Partial<ImageClassSettings>) => void
  label: string
}) {
  return (
    <div className={`${P}-res-row`}>
      <Checkbox checked={set.downsample} onChange={(v) => onChange({ downsample: v })} label="Downsample to" />
      <NumberInput
        aria-label={`${label}: target resolution in ppi`}
        value={set.targetPpi}
        min={9}
        max={2400}
        disabled={!set.downsample}
        onChange={(v) => onChange({ targetPpi: Math.round(v) })}
      />
      <span>ppi for images above</span>
      <NumberInput
        aria-label={`${label}: downsample images above this resolution (ppi)`}
        value={set.abovePpi}
        min={9}
        max={3600}
        disabled={!set.downsample}
        onChange={(v) => onChange({ abovePpi: Math.round(v) })}
      />
      <span>ppi</span>
    </div>
  )
}

function PhotoBlock({ title, set, onChange }: { title: string; set: PhotoImageSettings; onChange: (patch: Partial<PhotoImageSettings>) => void }) {
  return (
    <fieldset className={`${P}-fieldset`}>
      <legend>{title}</legend>
      <ResolutionRow set={set} onChange={onChange} label={title} />
      <div className={`${P}-quality-row`}>
        <span>JPEG quality</span>
        <Slider value={set.quality} min={10} max={100} step={5} onChange={(v) => onChange({ quality: v })} format={(v) => `${v} (${qualityName(v)})`} />
      </div>
      <Checkbox
        checked={set.recompress}
        onChange={(v) => onChange({ recompress: v })}
        label="Also recompress photos stored without JPEG compression"
      />
    </fieldset>
  )
}

function AuditView({ doc }: { doc: DocumentModel }) {
  const [audit, setAudit] = useState<SpaceAudit | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    poOps(doc)
      .audit()
      .then((a) => alive && setAudit(a))
      .catch((err) => alive && setError(String(err?.message ?? err)))
    return () => {
      alive = false
    }
  }, [doc])
  if (error) return <p className="ui-field-error">Could not audit space usage: {error}</p>
  if (!audit) return <p className="shell-muted">Measuring…</p>
  return (
    <div>
      <p className={`${P}-hint`}>What takes up space in this document ({formatBytes(audit.total)} in total):</p>
      <table className={`${P}-audit`} data-testid="space-audit">
        <thead>
          <tr>
            <th scope="col">Content</th>
            <th scope="col">Size</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {audit.categories.map((c) => {
            const pct = audit.total ? (c.bytes / audit.total) * 100 : 0
            return (
              <tr key={c.id}>
                <th scope="row">{c.label}</th>
                <td>{formatBytes(c.bytes)}</td>
                <td>
                  <span className={`${P}-bar`} aria-hidden="true">
                    <span style={{ width: `${Math.max(1, pct)}%` }} />
                  </span>
                  <span className={`${P}-pct`}>{pct < 1 ? '<1' : Math.round(pct)}%</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Checks({ children }: { children: ReactNode }) {
  return <div className={`${P}-check-list`}>{children}</div>
}

/** Acrobat's PDF Optimizer. Resolves with the chosen options (or undefined when cancelled). */
function OptimizerDialog({ doc, initial, close }: { doc: DocumentModel; initial: OptimizeOptions; close: (o?: OptimizeOptions) => void }) {
  const [o, setO] = useState<OptimizeOptions>(initial)
  const [section, setSection] = useState<SectionId>('images')
  const output = useProtectOptimize((s) => s.output)
  const preset = matchingPreset(o)
  const images = (k: keyof OptimizeOptions['images'], patch: Partial<PhotoImageSettings>) =>
    setO((p) => ({ ...p, images: { ...p.images, [k]: { ...p.images[k], ...patch } } }))
  const discard = (patch: Partial<OptimizeOptions['discard']>) => setO((p) => ({ ...p, discard: { ...p.discard, ...patch } }))
  const cleanup = (patch: Partial<OptimizeOptions['cleanup']>) => setO((p) => ({ ...p, cleanup: { ...p.cleanup, ...patch } }))
  const submit = () => {
    // "Above" can't be below the target resolution.
    const fix = <T extends ImageClassSettings>(s: T): T => ({ ...s, abovePpi: Math.max(s.abovePpi, s.targetPpi) })
    close({ ...o, images: { color: fix(o.images.color), gray: fix(o.images.gray), mono: fix(o.images.mono) } })
  }
  return (
    <Dialog
      title="Advanced optimization"
      onClose={() => close()}
      width={780}
      className={`${P}-optimizer`}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={submit} data-testid="optimizer-ok">
            {output === 'tab' ? 'Optimize' : 'Optimize and Save…'}
          </Button>
        </>
      }
    >
      <div className={`${P}-optimizer-top`}>
        <label className="ui-field-label" htmlFor={`${P}-settings`}>
          Settings
        </label>
        <Select<QualityPreset | 'custom'>
          id={`${P}-settings`}
          value={preset}
          onChange={(v) => v !== 'custom' && setO(presetOptions(v))}
          options={[...QUALITY_PRESETS.map((q) => ({ value: q.value as QualityPreset | 'custom', label: q.label })), { value: 'custom', label: 'Custom' }]}
        />
      </div>
      <div className={`${P}-optimizer-main`}>
        <nav className={`${P}-optimizer-nav`} aria-label="Optimizer sections">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" className={section === s.id ? 'is-active' : ''} aria-current={section === s.id} onClick={() => setSection(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className={`${P}-optimizer-body`}>
          {section === 'images' && (
            <>
              <PhotoBlock title="Color images" set={o.images.color} onChange={(p) => images('color', p)} />
              <PhotoBlock title="Grayscale images" set={o.images.gray} onChange={(p) => images('gray', p)} />
              <fieldset className={`${P}-fieldset`}>
                <legend>Monochrome images</legend>
                <ResolutionRow set={o.images.mono} onChange={(p) => images('mono', p)} label="Monochrome images" />
              </fieldset>
              <p className={`${P}-hint`}>
                <Info size={14} /> Resolution is measured where each image is shown on the page, using its largest size. An image is
                only replaced when the result is smaller.
              </p>
            </>
          )}
          {section === 'fonts' && (
            <Checks>
              <Checkbox
                checked={o.fonts.subset}
                onChange={(v) => setO((p) => ({ ...p, fonts: { subset: v } }))}
                label="Subset embedded fonts (keep only the characters the document uses)"
              />
              <p className={`${P}-hint`}>Text stays searchable and selectable. Editing text later may need fonts installed on your computer.</p>
            </Checks>
          )}
          {section === 'objects' && (
            <Checks>
              <Checkbox checked={o.discard.formActions} onChange={(v) => discard({ formActions: v })} label="Discard all form submission, import and reset actions" />
              <Checkbox checked={o.discard.flattenFields} onChange={(v) => discard({ flattenFields: v })} label="Flatten form fields" />
              <Checkbox checked={o.discard.javascript} onChange={(v) => discard({ javascript: v })} label="Discard all JavaScript actions" />
              <Checkbox checked={o.discard.alternateImages} onChange={(v) => discard({ alternateImages: v })} label="Discard all alternate images" />
              <Checkbox checked={o.discard.thumbnails} onChange={(v) => discard({ thumbnails: v })} label="Discard embedded page thumbnails" />
              <Checkbox checked={o.discard.tags} onChange={(v) => discard({ tags: v })} label="Discard document tags (makes the PDF less accessible)" />
              <Checkbox checked={o.discard.bookmarks} onChange={(v) => discard({ bookmarks: v })} label="Discard bookmarks" />
            </Checks>
          )}
          {section === 'userdata' && (
            <Checks>
              <Checkbox checked={o.discard.comments} onChange={(v) => discard({ comments: v })} label="Discard all comments" />
              <Checkbox checked={o.discard.metadata} onChange={(v) => discard({ metadata: v })} label="Discard document information and metadata" />
              <Checkbox checked={o.discard.attachments} onChange={(v) => discard({ attachments: v })} label="Discard file attachments" />
              <Checkbox checked={o.discard.privateData} onChange={(v) => discard({ privateData: v })} label="Discard private data of other applications" />
            </Checks>
          )}
          {section === 'cleanup' && (
            <Checks>
              <Checkbox
                checked={o.cleanup.compressStreams}
                onChange={(v) => cleanup({ compressStreams: v })}
                label="Use Flate to encode streams that are not encoded, and remove ASCII and LZW encodings"
              />
              <Checkbox checked={o.cleanup.removeUnused} onChange={(v) => cleanup({ removeUnused: v })} label="Remove unused objects and merge duplicates" />
              <Checkbox
                checked={o.cleanup.objectStreams}
                onChange={(v) => cleanup({ objectStreams: v })}
                label="Compress document structure (object streams, PDF 1.5 and later)"
              />
              <Checkbox checked={o.cleanup.optimizeContent} onChange={(v) => cleanup({ optimizeContent: v })} label="Optimize page content" />
            </Checks>
          )}
          {section === 'audit' && <AuditView doc={doc} />}
        </div>
      </div>
    </Dialog>
  )
}

export async function openOptimizerDialog(doc: DocumentModel) {
  try {
    await loadCompressPrefs()
    const s = useProtectOptimize.getState()
    const initial = s.advanced ?? presetOptions(s.preset)
    const options = await openDialog<OptimizeOptions>((close) => <OptimizerDialog doc={doc} initial={initial} close={close} />)
    if (!options) return
    setCompressPrefs({ advanced: options })
    await compressDocument(doc, options, useProtectOptimize.getState().output)
  } catch (err) {
    showError(err, 'Could not optimize the document')
  }
}
