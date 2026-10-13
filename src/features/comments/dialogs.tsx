import { useState } from 'react'
import { Button, Checkbox, Dialog, Field, Radio, Segmented, Select } from '@renderer/sdk'
import type { SummaryOptions } from './engine'

export interface SummarizeChoice {
  options: Omit<SummaryOptions, 'ids' | 'title'>
  onlyShowing: boolean
}

type LayoutChoice = 'comments-only' | 'separate' | 'single' | 'connectors'

const LAYOUTS: { id: LayoutChoice; label: string }[] = [
  { id: 'connectors', label: 'Document and comments with connector lines on single pages' },
  { id: 'single', label: 'Document and comments with sequence numbers on single pages' },
  { id: 'separate', label: 'Document and comments with sequence numbers on separate pages' },
  { id: 'comments-only', label: 'Comments only' }
]

/** Tiny picture of each summary layout, like Acrobat's Summarize Options. */
function LayoutPicture({ id }: { id: LayoutChoice }) {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => <i key={i} />)
  if (id === 'comments-only') {
    return (
      <span className="fc-comments-layoutpic">
        <span className="fc-comments-layoutpic-list">{lines(6)}</span>
      </span>
    )
  }
  if (id === 'separate') {
    return (
      <span className="fc-comments-layoutpic">
        <span className="fc-comments-layoutpic-doc">
          <b>1</b>
          <b>2</b>
        </span>
        <span className="fc-comments-layoutpic-list">{lines(5)}</span>
      </span>
    )
  }
  return (
    <span className="fc-comments-layoutpic is-wide">
      <span className="fc-comments-layoutpic-doc">
        <b>1</b>
        <b>2</b>
      </span>
      {id === 'connectors' && <span className="fc-comments-layoutpic-connector" />}
      <span className="fc-comments-layoutpic-list">{lines(4)}</span>
    </span>
  )
}

export function SummarizeDialog({ close, hasFilter }: { close: (r?: SummarizeChoice) => void; hasFilter: boolean }) {
  const [layout, setLayout] = useState<LayoutChoice>('connectors')
  const [sort, setSort] = useState<NonNullable<SummaryOptions['sort']>>('page')
  const [size, setSize] = useState<NonNullable<SummaryOptions['fontSize']>>('medium')
  const [onlyShowing, setOnlyShowing] = useState(false)
  const [empty, setEmpty] = useState(false)
  const submit = () =>
    close({
      options: {
        layout: layout === 'connectors' ? 'single' : layout,
        connectors: layout === 'connectors',
        sort,
        fontSize: size,
        includeEmptyPages: layout !== 'comments-only' && empty
      },
      onlyShowing
    })
  return (
    <Dialog
      title="Summarize Comments"
      onClose={() => close()}
      width={620}
      onSubmit={submit}
      className="fc-comments-summarize"
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={submit}>
            Create PDF Comment Summary
          </Button>
        </>
      }
    >
      <p className="fc-comments-dialog-intro">Creates a new PDF that lists every comment with its author, date, text and replies.</p>
      <div className="fc-comments-layouts" role="radiogroup" aria-label="Layout">
        {LAYOUTS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="radio"
            aria-checked={layout === l.id}
            className={`fc-comments-layout ${layout === l.id ? 'is-active' : ''}`}
            onClick={() => setLayout(l.id)}
          >
            <LayoutPicture id={l.id} />
            <span>{l.label}</span>
          </button>
        ))}
      </div>
      <div className="fc-comments-summarize-grid">
        <Field label="Sort comments by">
          <Select
            value={sort}
            onChange={setSort}
            options={[
              { value: 'page', label: 'Page' },
              { value: 'author', label: 'Author' },
              { value: 'date', label: 'Date' },
              { value: 'type', label: 'Type' }
            ]}
          />
        </Field>
        <Field label="Font size">
          <Segmented
            value={size}
            onChange={setSize}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large' }
            ]}
          />
        </Field>
      </div>
      <Field label="Include">
        <div className="fc-comments-radios">
          <Radio name="fc-sum-include" checked={!onlyShowing} onChange={() => setOnlyShowing(false)} label="All comments" />
          <Radio
            name="fc-sum-include"
            checked={onlyShowing}
            onChange={() => setOnlyShowing(true)}
            label={hasFilter ? 'Only the comments currently shown in the Comments list' : 'Only the comments currently shown (no filter is active)'}
          />
        </div>
      </Field>
      <Checkbox
        checked={empty && layout !== 'comments-only'}
        disabled={layout === 'comments-only'}
        onChange={setEmpty}
        label="Include pages with no comments"
      />
    </Dialog>
  )
}

export function FlattenDialog({ close, count, hasForm }: { close: (r?: { widgets: boolean }) => void; count: number; hasForm: boolean }) {
  const [widgets, setWidgets] = useState(false)
  return (
    <Dialog
      title="Flatten Comments"
      onClose={() => close()}
      width={480}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="danger" onClick={() => close({ widgets })} disabled={!count && !widgets}>
            Flatten
          </Button>
        </>
      }
    >
      <div className="ui-dialog-message">
        {count ? (
          <>
            This merges all {count} {count === 1 ? 'comment' : 'comments'} into the page content. They will look the same, but can no
            longer be selected, edited, moved or replied to. You can still undo this until you close the document.
          </>
        ) : (
          <>This document has no comments. You can flatten its form fields instead.</>
        )}
      </div>
      {hasForm && <Checkbox checked={widgets} onChange={setWidgets} label="Also flatten form fields (they will no longer be fillable)" />}
    </Dialog>
  )
}
