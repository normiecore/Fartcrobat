import { useEffect, useState } from 'react'
import { CheckCircle2, FolderOpen, Info, Lock, Shrink, SlidersHorizontal, TriangleAlert } from 'lucide-react'
import { Button, EmptyState, Section, ToolPanelFrame, basename, invoke, openPaths, useDocState, type DocumentModel } from '@renderer/sdk'
import { compressDocument, describeReport, savedSize } from './flows'
import { openOptimizerDialog } from './OptimizerDialog'
import { QUALITY_PRESETS, compressedName, formatBytes, presetOptions, type QualityPreset } from './shared'
import { loadCompressPrefs, setCompressPrefs, useProtectOptimize, type CompressOutput } from './state'

const P = 'fc-protect-optimize'

function CompressPanelBody({ doc }: { doc: DocumentModel }) {
  const preset = useProtectOptimize((s) => s.preset)
  const output = useProtectOptimize((s) => s.output)
  const result = useProtectOptimize((s) => s.results[doc.id])
  const title = useDocState(doc, (s) => s.title)
  const dirty = useDocState(doc, (s) => s.dirty)
  const filePath = useDocState(doc, (s) => s.filePath)
  const encrypted = useDocState(doc, (s) => !!s.info.encryption)
  const signed = useDocState(doc, (s) => s.info.signatureCount > 0)
  const [size, setSize] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadCompressPrefs()
  }, [])
  useEffect(() => {
    let alive = true
    void savedSize(doc).then((n) => alive && setSize(n))
    return () => {
      alive = false
    }
  }, [doc, dirty, filePath])

  const run = async () => {
    setBusy(true)
    try {
      await compressDocument(doc, presetOptions(preset), output)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`${P}-panel`}>
      <div className={`${P}-filesize`}>
        <span className="shell-muted">File size</span>
        <b data-testid="compress-current-size">{size !== null ? formatBytes(size) : dirty ? 'Unsaved changes' : 'Not saved yet'}</b>
      </div>

      <Section title="Quality">
        <div className={`${P}-cards`} role="radiogroup" aria-label="Quality">
          {QUALITY_PRESETS.map((q) => (
            <label key={q.value} className={`${P}-card ${preset === q.value ? 'is-active' : ''}`}>
              <input
                type="radio"
                name={`${P}-quality-${doc.id}`}
                value={q.value}
                checked={preset === q.value}
                onChange={() => setCompressPrefs({ preset: q.value as QualityPreset })}
              />
              <span className={`${P}-card-text`}>
                <span className={`${P}-card-label`}>
                  {q.label}
                  {q.value === 'medium' && <span className={`${P}-tag`}>Recommended</span>}
                </span>
                <span className={`${P}-card-desc`}>{q.description}</span>
              </span>
            </label>
          ))}
        </div>
      </Section>

      <Section title="When done">
        <div className={`${P}-radios`} role="radiogroup" aria-label="When done">
          {(
            [
              ['save', 'Save as a new file', compressedName(title)],
              ['tab', 'Open in a new tab', 'Review it, then save it yourself']
            ] as [CompressOutput, string, string][]
          ).map(([value, label, detail]) => (
            <label key={value} className={`ui-check ${P}-radio`}>
              <input type="radio" name={`${P}-output-${doc.id}`} checked={output === value} onChange={() => setCompressPrefs({ output: value })} />
              <span>
                {label}
                <span className={`${P}-radio-detail`}>{detail}</span>
              </span>
            </label>
          ))}
        </div>
      </Section>

      <Button variant="primary" icon={Shrink} className={`${P}-wide`} disabled={busy} onClick={() => void run()} data-testid="compress-run">
        {busy ? 'Compressing…' : 'Compress'}
      </Button>
      <Button variant="quiet" icon={SlidersHorizontal} className={`${P}-wide`} disabled={busy} onClick={() => void openOptimizerDialog(doc)}>
        Advanced optimization…
      </Button>

      {encrypted && (
        <div className={`${P}-note`}>
          <Lock size={16} />
          <span>This PDF is password protected. The compressed copy keeps its password and permissions.</span>
        </div>
      )}
      {signed && (
        <div className={`${P}-note is-warning`}>
          <TriangleAlert size={16} />
          <span>This PDF is signed. Compressing writes a new file, so the signatures in the copy will not be valid.</span>
        </div>
      )}
      {dirty && !result && (
        <div className={`${P}-note`}>
          <Info size={16} />
          <span>Your unsaved changes are included in the compressed copy.</span>
        </div>
      )}

      {result && (
        <div className={`${P}-result ${result.smaller ? 'is-success' : ''}`} role="status" data-testid="compress-result">
          {result.smaller ? <CheckCircle2 size={20} /> : <Info size={20} />}
          <div className={`${P}-result-body`}>
            <div className={`${P}-result-title`}>{result.summary}</div>
            {result.smaller && (
              <ul>
                {describeReport(result).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            {result.path && (
              <>
                <div className={`${P}-result-file`} title={result.path}>
                  {basename(result.path)}
                </div>
                <div className={`${P}-result-actions`}>
                  {result.path !== doc.state.filePath && (
                    <Button size="sm" onClick={() => void openPaths([result.path!])}>
                      Open
                    </Button>
                  )}
                  <Button size="sm" variant="quiet" icon={FolderOpen} onClick={() => void invoke('shell:showItemInFolder', result.path!)}>
                    Show in folder
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export function CompressPanel({ doc }: { doc: DocumentModel | null }) {
  return (
    <ToolPanelFrame title="Compress a PDF">
      {doc ? <CompressPanelBody key={doc.id} doc={doc} /> : <EmptyState icon={Shrink} title="Open a PDF to compress it" />}
    </ToolPanelFrame>
  )
}
