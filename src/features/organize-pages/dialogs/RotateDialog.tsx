import { useState } from 'react'
import { RotateCcw, RotateCw } from 'lucide-react'
import { Button, Dialog, Field, openDialog, Segmented, Select, type DocumentModel } from '@renderer/sdk'
import { rotatePages } from '../actions'
import { filterPages } from '../order'
import { countLabel } from '../ranges'
import { PageScope, Summary, initialScope, resolveScope, type Scope } from './common'

type Direction = '-90' | '90' | '180'
type Parity = 'both' | 'even' | 'odd'
type Orientation = 'both' | 'portrait' | 'landscape'

function RotateDialog({
  doc,
  selected,
  initial,
  close
}: {
  doc: DocumentModel
  selected: number[]
  initial: Direction
  close: () => void
}) {
  const [direction, setDirection] = useState<Direction>(initial)
  const [scope, setScope] = useState<Scope>(initialScope(selected, 'all'))
  const [parity, setParity] = useState<Parity>('both')
  const [orientation, setOrientation] = useState<Orientation>('both')
  const res = resolveScope(doc, scope, selected)
  const pages = doc.state.info.pages
  let target: number[] = res.ok ? res.pages : []
  if (parity !== 'both') {
    const keep = new Set(filterPages(pages, parity))
    target = target.filter((i) => keep.has(i))
  }
  if (orientation !== 'both') {
    const keep = new Set(filterPages(pages, orientation))
    target = target.filter((i) => keep.has(i))
  }
  const submit = () => {
    if (!target.length) return
    close()
    void rotatePages(doc, target, parseInt(direction, 10))
  }
  return (
    <Dialog
      title="Rotate Pages"
      onClose={close}
      onSubmit={submit}
      width={460}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={!target.length} onClick={submit}>
            Rotate
          </Button>
        </>
      }
    >
      <Field label="Direction">
        <div className="fc-organize-pages-seg-wrap">
          <Segmented<Direction>
            value={direction}
            onChange={setDirection}
            options={[
              {
                value: '-90',
                label: (
                  <span className="fc-organize-pages-seg">
                    <RotateCcw size={14} /> Counterclockwise
                  </span>
                )
              },
              {
                value: '90',
                label: (
                  <span className="fc-organize-pages-seg">
                    <RotateCw size={14} /> Clockwise
                  </span>
                )
              },
              { value: '180', label: '180°' }
            ]}
          />
        </div>
      </Field>
      <PageScope doc={doc} value={scope} onChange={setScope} selected={selected} />
      <div className="fc-organize-pages-row2">
        <Field label="Page numbers">
          <Select<Parity>
            value={parity}
            onChange={setParity}
            options={[
              { value: 'both', label: 'Even and odd pages' },
              { value: 'even', label: 'Even pages only' },
              { value: 'odd', label: 'Odd pages only' }
            ]}
          />
        </Field>
        <Field label="Orientation">
          <Select<Orientation>
            value={orientation}
            onChange={setOrientation}
            options={[
              { value: 'both', label: 'Portrait and landscape' },
              { value: 'portrait', label: 'Portrait pages only' },
              { value: 'landscape', label: 'Landscape pages only' }
            ]}
          />
        </Field>
      </div>
      <Summary tone={res.ok && !target.length ? 'warning' : undefined}>
        {!res.ok
          ? ' '
          : target.length
            ? `${countLabel(target.length)} will be rotated.`
            : 'No pages match these choices.'}
      </Summary>
    </Dialog>
  )
}

/** Document > Rotate Pages… */
export async function openRotateDialog(
  doc: DocumentModel,
  selected: number[],
  direction: 90 | -90 | 180 = 90
): Promise<void> {
  await openDialog((close) => (
    <RotateDialog
      doc={doc}
      selected={selected}
      initial={String(direction) as Direction}
      close={() => close()}
    />
  ))
}
