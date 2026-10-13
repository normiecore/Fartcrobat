import { useEffect } from 'react'
import { Crosshair, Eye, EyeOff, FileSpreadsheet, Pentagon, Ruler, Spline, Trash2 } from 'lucide-react'
import {
  Button,
  Checkbox,
  EmptyState,
  IconButton,
  Section,
  Segmented,
  setTool,
  showError,
  ToolPanelFrame,
  ToolRow,
  useApp,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { ColorMenuButton } from './ColorMenuButton'
import { KIND_LABELS, scaleToString, type MeasureKind } from './measureMath'
import { exportMeasurementsCsv, openScaleDialog, ScaleEditor } from './MeasureControls'
import {
  KIND_TOOL,
  liveReadout,
  loadMeasureSettings,
  measureOps,
  setDocScale,
  setMeasureSettings,
  TOOL_KIND,
  useDocScale,
  useMeasure,
  usePageMeasurements
} from './measureStore'
import type { MeasurementInfo } from './engine'

type AnnotOps = typeof import('@engine/ops/annots').default

export const KIND_ICONS = { distance: Ruler, perimeter: Spline, area: Pentagon } as const

const TOOL_DESCRIPTIONS: Record<MeasureKind, string> = {
  distance: 'Click two points',
  perimeter: 'Click points, double-click to finish',
  area: 'Click corners, click the first one to close'
}

function MeasurementRow({ doc, m, selected }: { doc: DocumentModel; m: MeasurementInfo; selected: boolean }) {
  const Icon = KIND_ICONS[m.kind]
  const select = () => {
    setTool('select')
    doc.setSelection({ kind: 'annotations', page: m.page, ids: [m.id] })
    doc.view?.scrollToRect(m.page, m.rect, { center: true })
  }
  return (
    <li className={`fc-stamps-measure-item ${selected ? 'is-selected' : ''}`}>
      <button type="button" className="fc-stamps-measure-item-main" onClick={select} title="Select on the page">
        <Icon size={16} style={{ color: m.color ?? undefined }} />
        <span className="fc-stamps-measure-item-text">
          <span className="fc-stamps-measure-item-value">{m.label || '—'}</span>
          <span className="fc-stamps-measure-item-sub">
            {KIND_LABELS[m.kind]}
            {m.scale ? ` · ${m.scale}` : ''}
          </span>
        </span>
      </button>
      {m.ours && (
        <IconButton
          icon={m.showLabel ? Eye : EyeOff}
          size={15}
          label={m.showLabel ? 'Hide value on page' : 'Show value on page'}
          onClick={() => void measureOps(doc).setLineCaption(m.id, !m.showLabel, m.page).catch((err) => showError(err))}
        />
      )}
      <IconButton
        icon={Trash2}
        size={15}
        label="Delete measurement"
        onClick={() =>
          void doc
            .ops<AnnotOps>('annots')
            .delete([m.id], m.page)
            .catch((err) => showError(err, 'Could not delete'))
        }
      />
    </li>
  )
}

/** "Measurement info": live values while drawing. */
function MeasurementInfoBox({ doc }: { doc: DocumentModel }) {
  const live = useMeasure((s) => s.live)
  const scale = useDocScale(doc)
  const mine = live && live.docId === doc.id && live.points.length ? live : null
  const r = mine ? liveReadout(mine, scale) : null
  return (
    <div className="fc-stamps-measure-info" aria-live="polite">
      {r ? (
        <dl>
          {[...r.rows, { label: 'Scale', value: scaleToString(scale) }].map((row) => (
            <div key={row.label} className="fc-stamps-measure-info-row">
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="fc-stamps-measure-muted">Values appear here while you measure.</div>
      )}
    </div>
  )
}

export function MeasurePanel({ doc }: { doc: DocumentModel | null }) {
  useEffect(() => {
    void loadMeasureSettings()
  }, [])
  if (!doc) {
    return (
      <ToolPanelFrame title="Measure objects">
        <EmptyState icon={Ruler} title="Open a PDF to measure" />
      </ToolPanelFrame>
    )
  }
  return <MeasurePanelBody doc={doc} />
}

function MeasurePanelBody({ doc }: { doc: DocumentModel }) {
  const toolId = useApp((s) => s.toolId)
  const settings = useMeasure((s) => s.settings)
  const calibrating = useMeasure((s) => s.calibrating)
  const scale = useDocScale(doc)
  const page = useDocState(doc, (s) => s.currentPage)
  const selection = useDocState(doc, (s) => s.selection)
  const list = usePageMeasurements(doc, page)
  const pageLabel = useDocState(doc, (s) => s.info.pages[page]?.label ?? String(page + 1))
  const selectedIds = selection.kind === 'annotations' && selection.page === page ? selection.ids : []
  const scaleText = scaleToString(scale)
  // measurements drawn with another scale or precision can be brought in line in one step
  const other = list.filter((m) => m.ours && m.scale && (m.scale !== scaleText || m.precision !== scale.precision))

  return (
    <ToolPanelFrame
      title="Measure objects"
      footer={
        <Button icon={FileSpreadsheet} onClick={() => void exportMeasurementsCsv(doc)}>
          Export to spreadsheet…
        </Button>
      }
    >
      <div role="group" aria-label="Measuring tools">
        {(['distance', 'perimeter', 'area'] as MeasureKind[]).map((k) => (
          <ToolRow
            key={k}
            icon={KIND_ICONS[k]}
            label={KIND_LABELS[k]}
            description={TOOL_DESCRIPTIONS[k]}
            active={toolId === KIND_TOOL[k]}
            onClick={() => setTool(KIND_TOOL[k])}
          />
        ))}
      </div>

      <Section title="Scale">
        <ScaleEditor scale={scale} onCommit={(s) => void setDocScale(doc, s)} />
        <div className="fc-stamps-measure-row">
          <Button
            size="sm"
            variant={calibrating ? 'primary' : 'secondary'}
            icon={Crosshair}
            onClick={() => {
              const on = !useMeasure.getState().calibrating
              useMeasure.setState({ calibrating: on, live: null })
              if (on) setTool('measure.distance')
            }}
          >
            {calibrating ? 'Draw over a known length…' : 'Calibrate…'}
          </Button>
          {other.length > 0 && (
            <Button
              size="sm"
              variant="quiet"
              title={`Recalculate with ${scaleText}`}
              onClick={() =>
                void measureOps(doc)
                  .rescaleMeasurements(
                    other.map((m) => m.id),
                    scale,
                    page
                  )
                  .catch((err) => showError(err))
              }
            >
              Apply to {other.length} on this page
            </Button>
          )}
        </div>
      </Section>

      <Section title="Options">
        <div className="fc-stamps-measure-options">
          <Checkbox checked={settings.snap} onChange={(v) => setMeasureSettings({ snap: v })} label="Snap to lines, ends and text" />
          <Checkbox checked={settings.showLabels} onChange={(v) => setMeasureSettings({ showLabels: v })} label="Show values on the page" />
          <span className="fc-stamps-measure-inline">
            <span>Colour</span>
            <ColorMenuButton value={settings.color} onChange={(c) => setMeasureSettings({ color: c })} label="Measurement colour" />
          </span>
        </div>
      </Section>

      <Section title="Measurement info">
        <MeasurementInfoBox doc={doc} />
      </Section>

      <Section title={`On page ${pageLabel}${list.length ? ` (${list.length})` : ''}`}>
        {list.length ? (
          <ul className="fc-stamps-measure-list" aria-label="Measurements on this page">
            {list.map((m) => (
              <MeasurementRow key={m.id} doc={doc} m={m} selected={selectedIds.includes(m.id)} />
            ))}
          </ul>
        ) : (
          <div className="fc-stamps-measure-muted">No measurements on this page yet.</div>
        )}
      </Section>
    </ToolPanelFrame>
  )
}

/** Contextual toolbar for the measuring tools. */
export function MeasureToolbar({ doc }: { doc: DocumentModel }) {
  const toolId = useApp((s) => s.toolId)
  const kind = TOOL_KIND[toolId] ?? 'distance'
  const scale = useDocScale(doc)
  const settings = useMeasure((s) => s.settings)
  const calibrating = useMeasure((s) => s.calibrating)
  useEffect(() => {
    void loadMeasureSettings()
  }, [])
  return (
    <div className="fc-stamps-measure-toolbar" role="group" aria-label="Measuring options">
      <Segmented<MeasureKind>
        value={kind}
        onChange={(k) => setTool(KIND_TOOL[k])}
        options={(['distance', 'perimeter', 'area'] as MeasureKind[]).map((k) => {
          const Icon = KIND_ICONS[k]
          return {
            value: k,
            title: `${KIND_LABELS[k]}: ${TOOL_DESCRIPTIONS[k].toLowerCase()}`,
            label: (
              <span className="fc-stamps-measure-seg">
                <Icon size={14} />
                {KIND_LABELS[k]}
              </span>
            )
          }
        })}
      />
      <Button size="sm" variant="quiet" title="Change the scale ratio" onClick={() => void openScaleDialog(doc, scale)}>
        Scale: {scaleToString(scale)}
      </Button>
      <Checkbox checked={settings.snap} onChange={(v) => setMeasureSettings({ snap: v })} label="Snap" />
      <ColorMenuButton value={settings.color} onChange={(c) => setMeasureSettings({ color: c })} label="Measurement colour" />
      <span className="fc-stamps-measure-spacer" />
      <span className="fc-stamps-measure-hint">
        {calibrating
          ? 'Calibrating: draw a line over something whose real length you know'
          : kind === 'distance'
            ? 'Click two points · Shift for 45° · Esc cancels'
            : kind === 'perimeter'
              ? 'Click points · double-click or Enter to finish · Backspace undoes a point'
              : 'Click corners · click the first point or press Enter to close'}
      </span>
    </div>
  )
}
