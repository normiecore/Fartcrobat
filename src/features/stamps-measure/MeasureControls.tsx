import { useEffect, useState } from 'react'
import {
  Button,
  Dialog,
  openDialog,
  saveBytesAs,
  Select,
  showError,
  stripExtension,
  TextInput,
  toast,
  type DocumentModel
} from '@renderer/sdk'
import {
  KIND_LABELS,
  PAGE_UNITS,
  parseFraction,
  POINTS_PER_UNIT,
  PRECISIONS,
  REAL_UNITS,
  sameScale,
  sanitizeScale,
  SCALE_PRESETS,
  scaleToString,
  storeNumber,
  type MeasureScale,
  type PageUnit,
  type RealUnit
} from './measureMath'
import { measureOps, setDocScale } from './measureStore'

function numText(n: number): string {
  return storeNumber(n)
}

/**
 * "[1] [in] = [1] [ft]" plus precision and common presets. Numbers apply when you leave the field
 * or press Enter; menus apply at once.
 */
export function ScaleEditor({
  scale,
  onCommit,
  compact
}: {
  scale: MeasureScale
  onCommit: (s: MeasureScale) => void
  compact?: boolean
}) {
  const [pageText, setPageText] = useState(numText(scale.pageValue))
  const [realText, setRealText] = useState(numText(scale.realValue))

  // Follow outside changes (undo, presets, calibration).
  useEffect(() => {
    setPageText(numText(scale.pageValue))
    setRealText(numText(scale.realValue))
  }, [scale.pageValue, scale.realValue])

  const pageValue = parseFraction(pageText)
  const realValue = parseFraction(realText)
  const pageBad = !(pageValue > 0)
  const realBad = !(realValue > 0)

  const commit = (patch: Partial<MeasureScale>) => {
    const next = sanitizeScale({ ...scale, ...patch })
    if (next && !sameScale(next, scale)) onCommit(next)
  }
  const commitNumbers = () => {
    if (pageBad || realBad) return
    commit({ pageValue, realValue })
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commitNumbers()
    }
  }

  return (
    <div className={`fc-stamps-measure-scale ${compact ? 'is-compact' : ''}`}>
      <div className="fc-stamps-measure-scale-ratio" role="group" aria-label="Scale ratio">
        <TextInput
          className={`fc-stamps-measure-scale-num ${pageBad ? 'is-invalid' : ''}`}
          aria-label="Page distance"
          inputMode="decimal"
          value={pageText}
          onChange={(e) => setPageText(e.target.value)}
          onBlur={commitNumbers}
          onKeyDown={onKey}
        />
        <Select<PageUnit> aria-label="Page unit" value={scale.pageUnit} options={PAGE_UNITS} onChange={(v) => commit({ pageUnit: v })} />
        <span className="fc-stamps-measure-eq">=</span>
        <TextInput
          className={`fc-stamps-measure-scale-num ${realBad ? 'is-invalid' : ''}`}
          aria-label="Real distance"
          inputMode="decimal"
          value={realText}
          onChange={(e) => setRealText(e.target.value)}
          onBlur={commitNumbers}
          onKeyDown={onKey}
        />
        <Select<RealUnit> aria-label="Real unit" value={scale.realUnit} options={REAL_UNITS} onChange={(v) => commit({ realUnit: v })} />
      </div>
      <div className="fc-stamps-measure-scale-extra">
        <label className="fc-stamps-measure-inline">
          <span>Precision</span>
          <Select<string>
            aria-label="Precision"
            value={String(scale.precision)}
            options={PRECISIONS.map((p) => ({ value: String(p.value), label: p.label }))}
            onChange={(v) => commit({ precision: Number(v) })}
          />
        </label>
      </div>
      <div className="fc-stamps-measure-scale-extra">
        <span className="fc-stamps-measure-presets">
          <Select<string>
            aria-label="Common scales"
            value=""
            options={[{ value: '', label: 'Common scales…' }, ...SCALE_PRESETS.map((p, i) => ({ value: String(i), label: p.label }))]}
            onChange={(v) => {
              const p = SCALE_PRESETS[Number(v)]
              if (p) commit({ ...p.scale })
            }}
          />
        </span>
      </div>
    </div>
  )
}

/** Tools > Measure > Set Scale Ratio dialog (also opened from the measuring toolbar). */
export function openScaleDialog(doc: DocumentModel, initial: MeasureScale): Promise<void> {
  return openDialog<void>((close) => <ScaleDialog doc={doc} initial={initial} onClose={() => close()} />).then(() => undefined)
}

function ScaleDialog({ doc, initial, onClose }: { doc: DocumentModel; initial: MeasureScale; onClose: () => void }) {
  const [scale, setScale] = useState(initial)
  const apply = async () => {
    if (!sameScale(scale, initial) && !(await setDocScale(doc, scale))) return
    onClose()
  }
  return (
    <Dialog
      title="Scale ratio"
      width={460}
      onClose={onClose}
      className="fc-stamps-measure-scale-dialog"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void apply()}>
            Apply
          </Button>
        </>
      }
    >
      <div className="ui-dialog-message">
        How long is a distance on the page in real life? Measurements on this document use this scale.
      </div>
      <ScaleEditor scale={scale} onCommit={setScale} />
      <div className="fc-stamps-measure-muted">Now: {scaleToString(scale)}</div>
    </Dialog>
  )
}

/**
 * Calibrate: the user drew a line over something of known size; ask its real length and derive
 * the scale from it.
 */
export function openCalibrateDialog(doc: DocumentModel, lengthPt: number, current: MeasureScale): Promise<boolean> {
  return openDialog<boolean>((close) => <CalibrateDialog doc={doc} lengthPt={lengthPt} current={current} onClose={close} />).then(
    (r) => !!r
  )
}

function CalibrateDialog({
  doc,
  lengthPt,
  current,
  onClose
}: {
  doc: DocumentModel
  lengthPt: number
  current: MeasureScale
  onClose: (ok?: boolean) => void
}) {
  const [text, setText] = useState('')
  const [unit, setUnit] = useState<RealUnit>(current.realUnit)
  const value = parseFraction(text)
  const valid = value > 0
  const pageLen = lengthPt / POINTS_PER_UNIT[current.pageUnit]
  const apply = async () => {
    if (!valid || !(pageLen > 0)) return
    const scale: MeasureScale = { pageValue: 1, pageUnit: current.pageUnit, realValue: value / pageLen, realUnit: unit, precision: current.precision }
    if (await setDocScale(doc, scale)) {
      toast(`Scale set to ${scaleToString(scale)}`, { kind: 'success' })
      onClose(true)
    }
  }
  return (
    <Dialog
      title="Calibrate scale"
      width={420}
      onClose={() => onClose(false)}
      onSubmit={() => void apply()}
      footer={
        <>
          <Button onClick={() => onClose(false)}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => void apply()}>
            Set scale
          </Button>
        </>
      }
    >
      <div className="ui-dialog-message">
        The line you drew is {storeNumber(Math.round(pageLen * 1000) / 1000)} {current.pageUnit} long on the page. How long is it in real life?
      </div>
      <div className="fc-stamps-measure-scale-ratio">
        <TextInput
          data-autofocus
          aria-label="Real length"
          inputMode="decimal"
          placeholder="e.g. 12"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Select<RealUnit> aria-label="Real length unit" value={unit} options={REAL_UNITS} onChange={setUnit} />
      </div>
    </Dialog>
  )
}

function csvCell(v: string | number): string {
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Exports every measurement in the document to a CSV file (opens in any spreadsheet). */
export async function exportMeasurementsCsv(doc: DocumentModel) {
  try {
    const list = await measureOps(doc).listAllMeasurements()
    if (!list.length) {
      toast('This document has no measurements to export.')
      return
    }
    const labels = doc.state.info.pages
    const rows = [
      ['Page', 'Type', 'Value', 'Unit', 'Label', 'Scale', 'Author', 'Date', 'Comment'],
      ...list.map((m) => [
        labels[m.page]?.label ?? String(m.page + 1),
        KIND_LABELS[m.kind],
        storeNumber(m.value),
        m.unit,
        m.label,
        m.scale,
        m.author,
        m.created ? new Date(m.created).toLocaleString() : '',
        m.contents !== m.label ? m.contents : ''
      ])
    ]
    const text = '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
    const path = await saveBytesAs(new TextEncoder().encode(text), `${stripExtension(doc.state.title)} measurements.csv`, [
      { name: 'CSV (spreadsheet)', extensions: ['csv'] }
    ], 'Export Measurements')
    if (path) toast(`Exported ${list.length} measurement${list.length === 1 ? '' : 's'}`, { kind: 'success' })
  } catch (err) {
    showError(err, 'Could not export measurements')
  }
}
