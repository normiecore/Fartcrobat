import { useEffect, useRef, useState } from 'react'
import { FileUp } from 'lucide-react'
import {
  basename,
  Button,
  Checkbox,
  invoke,
  readFile,
  Segmented,
  Select,
  showError,
  Slider,
  type DocumentModel
} from '@renderer/sdk'
import { marksApi } from '../store'
import type { AppearanceOptions, FileSource, Position } from '../shared'
import { Group, NumberField, Row, UnitField } from './common'

const SOURCE_FILTERS = [
  {
    name: 'PDF and image files',
    extensions: ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'jxr', 'xps', 'svg']
  },
  { name: 'All files', extensions: ['*'] }
]

/** Keeps track of files loaded into the engine by a dialog, and releases them when it closes. */
export function useSourceLoader(doc: DocumentModel) {
  const loaded = useRef<string[]>([])
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    const ids = loaded.current
    return () => {
      for (const id of ids)
        void marksApi(doc)
          .releaseSource(id)
          .catch(() => {})
    }
  }, [doc])

  const load = async (path: string): Promise<FileSource | null> => {
    try {
      const bytes = await readFile(path)
      const name = basename(path)
      const info = await doc.busyWhile(`Reading ${name}…`, () => marksApi(doc).loadSource(bytes, name))
      loaded.current.push(info.id)
      setPageCounts((m) => ({ ...m, [info.id]: info.pageCount }))
      return { kind: 'file', fileName: name, filePath: path, page: 1, scale: 100, sourceId: info.id }
    } catch (err) {
      showError(err, `Could not use ${basename(path)}`)
      return null
    }
  }

  const choose = async (): Promise<FileSource | null> => {
    const paths = await invoke('file:openDialog', { title: 'Choose a file', filters: SOURCE_FILTERS })
    if (!paths.length) return null
    return load(paths[0])
  }

  /** A preset or saved setting may point at a file on disk: load it again. */
  const reload = async (src: FileSource): Promise<FileSource | null> => {
    if (src.sourceId && pageCounts[src.sourceId]) return src
    if (!src.filePath) return { ...src, sourceId: undefined }
    const fresh = await load(src.filePath)
    return fresh ? { ...fresh, page: src.page, scale: src.scale } : null
  }

  return {
    choose,
    reload,
    pageCountOf: (src: FileSource) => (src.sourceId ? pageCounts[src.sourceId] : undefined)
  }
}

export function FileSourceFields({
  source,
  onChange,
  loader,
  inDocument
}: {
  source: FileSource | null
  onChange: (s: FileSource) => void
  loader: ReturnType<typeof useSourceLoader>
  /** True when updating marks whose file is already stored in the document. */
  inDocument: boolean
}) {
  const pages = source ? loader.pageCountOf(source) : undefined
  return (
    <div className="fc-page-marks-file">
      <div className="fc-page-marks-inline">
        <span className="fc-page-marks-filename" title={source?.filePath ?? source?.fileName}>
          {source ? source.fileName : 'No file chosen'}
          {source && !source.sourceId && inDocument && (
            <span className="shell-muted"> (already in this PDF)</span>
          )}
        </span>
        <Button
          size="sm"
          icon={FileUp}
          onClick={async () => {
            const picked = await loader.choose()
            if (picked) onChange(picked)
          }}
        >
          {source ? 'Choose another file…' : 'Choose file…'}
        </Button>
      </div>
      {source && (
        <div className="fc-page-marks-inline">
          <label className="fc-page-marks-mini">
            <span>Page</span>
            <NumberField
              label="Page of the file"
              value={source.page}
              min={1}
              max={pages}
              width={64}
              disabled={pages === 1 || (!source.sourceId && inDocument)}
              onChange={(page) => onChange({ ...source, page: Math.round(page) })}
            />
          </label>
          {pages !== undefined && <span className="shell-muted">of {pages}</span>}
          <label className="fc-page-marks-mini">
            <span>Absolute scale (%)</span>
            <NumberField
              label="Absolute scale (%)"
              value={source.scale}
              min={1}
              max={1000}
              width={72}
              onChange={(scale) => onChange({ ...source, scale })}
            />
          </label>
        </div>
      )}
    </div>
  )
}

const ROTATIONS = [
  { value: '0', label: '0°' },
  { value: '45', label: '45°' },
  { value: '-45', label: '−45°' },
  { value: '90', label: '90°' }
]

export function AppearanceFields({
  value,
  onChange,
  showRotation = true,
  showScale = true
}: {
  value: AppearanceOptions
  onChange: (patch: Partial<AppearanceOptions>) => void
  showRotation?: boolean
  showScale?: boolean
}) {
  const preset = ROTATIONS.find((r) => Number(r.value) === value.rotation)?.value ?? 'custom'
  return (
    <>
      {showRotation && (
        <Row label="Rotation">
          <Segmented<string>
            value={preset}
            onChange={(v) => v !== 'custom' && onChange({ rotation: Number(v) })}
            options={[...ROTATIONS, { value: 'custom', label: 'Custom' }]}
          />
          <NumberField
            label="Rotation (degrees)"
            value={value.rotation}
            min={-360}
            max={360}
            width={70}
            onChange={(rotation) => onChange({ rotation })}
          />
          <span className="shell-muted">°</span>
        </Row>
      )}
      <Row label="Opacity">
        <Slider
          value={Math.round(value.opacity * 100)}
          min={0}
          max={100}
          onChange={(v) => onChange({ opacity: v / 100 })}
          format={(v) => `${v}%`}
        />
      </Row>
      {showScale && (
        <Row label="Size">
          <Checkbox
            checked={value.relativeScale !== null}
            onChange={(on) => onChange({ relativeScale: on ? 50 : null })}
            label="Scale relative to the page"
          />
          <NumberField
            label="Scale relative to the page (%)"
            value={value.relativeScale ?? 50}
            min={1}
            max={100}
            width={64}
            disabled={value.relativeScale === null}
            onChange={(relativeScale) => onChange({ relativeScale })}
          />
          <span className="shell-muted">%</span>
        </Row>
      )}
    </>
  )
}

export function VisibilityFields({
  value,
  onChange
}: {
  value: AppearanceOptions
  onChange: (patch: Partial<AppearanceOptions>) => void
}) {
  return (
    <div className="fc-page-marks-visibility">
      <Checkbox
        checked={value.showOnPrint}
        onChange={(showOnPrint) => onChange({ showOnPrint })}
        label="Show when printing"
      />
      <Checkbox
        checked={value.showOnScreen}
        onChange={(showOnScreen) => onChange({ showOnScreen })}
        label="Show on screen"
      />
      {(!value.showOnPrint || !value.showOnScreen) && (
        <div className="fc-page-marks-hint">
          Saved as a layer that PDF apps show or hide when printing and on screen, like Acrobat does. In
          Fartcrobat it takes effect once the file is saved and opened again.
        </div>
      )}
      {!value.showOnPrint && !value.showOnScreen && (
        <div className="ui-field-error">With both options off, it will never be visible.</div>
      )}
    </div>
  )
}

export function PositionFields({ value, onChange }: { value: Position; onChange: (p: Position) => void }) {
  return (
    <Group title="Position">
      <Row label="Vertical">
        <UnitField
          label="Vertical distance"
          value={value.vOffset}
          min={-10000}
          onChange={(vOffset) => onChange({ ...value, vOffset })}
        />
        <span>from</span>
        <Select<Position['vAlign']>
          aria-label="Vertical position from"
          value={value.vAlign}
          onChange={(vAlign) => onChange({ ...value, vAlign })}
          options={[
            { value: 'top', label: 'Top' },
            { value: 'center', label: 'Center' },
            { value: 'bottom', label: 'Bottom' }
          ]}
        />
      </Row>
      <Row label="Horizontal">
        <UnitField
          label="Horizontal distance"
          value={value.hOffset}
          min={-10000}
          onChange={(hOffset) => onChange({ ...value, hOffset })}
        />
        <span>from</span>
        <Select<Position['hAlign']>
          aria-label="Horizontal position from"
          value={value.hAlign}
          onChange={(hAlign) => onChange({ ...value, hAlign })}
          options={[
            { value: 'left', label: 'Left' },
            { value: 'center', label: 'Center' },
            { value: 'right', label: 'Right' }
          ]}
        />
      </Row>
    </Group>
  )
}
