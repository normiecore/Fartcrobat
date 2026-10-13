import { useId, type ReactNode } from 'react'
import { NumberInput, Radio, Segmented, Select, TextInput, type DocumentModel } from '@renderer/sdk'
import { formatPageRange, parsePageRange, type RangeResult } from '../ranges'

export type ScopeKind = 'all' | 'selected' | 'current' | 'range'

export interface Scope {
  kind: ScopeKind
  text: string
}

/** Initial page scope: the selection (or current page) when there is one. */
export function initialScope(selected: number[], fallback: 'all' | 'current' = 'current'): Scope {
  if (selected.length) return { kind: 'selected', text: formatPageRange(selected) }
  return { kind: fallback, text: '' }
}

export function resolveScope(doc: DocumentModel, scope: Scope, selected: number[]): RangeResult {
  const count = doc.pageCount
  switch (scope.kind) {
    case 'all':
      return { ok: true, pages: Array.from({ length: count }, (_, i) => i) }
    case 'selected':
      return selected.length ? { ok: true, pages: selected } : { ok: false, error: 'No pages are selected' }
    case 'current':
      return { ok: true, pages: [Math.min(doc.state.currentPage, count - 1)] }
    case 'range':
      return parsePageRange(
        scope.text,
        count,
        doc.state.info.pages.map((p) => p.label)
      )
  }
}

/** "Which pages" radio group used by Rotate, Delete, Extract and Page Labels. */
export function PageScope({
  doc,
  value,
  onChange,
  selected,
  allowAll = true,
  label = 'Pages'
}: {
  doc: DocumentModel
  value: Scope
  onChange: (s: Scope) => void
  selected: number[]
  allowAll?: boolean
  label?: string
}) {
  const name = useId()
  const count = doc.pageCount
  const res = resolveScope(doc, value, selected)
  return (
    <fieldset className="fc-organize-pages-fieldset">
      <legend>{label}</legend>
      {allowAll && (
        <Radio
          name={name}
          checked={value.kind === 'all'}
          onChange={() => onChange({ ...value, kind: 'all' })}
          label={`All pages (${count})`}
        />
      )}
      {selected.length > 0 && (
        <Radio
          name={name}
          checked={value.kind === 'selected'}
          onChange={() => onChange({ ...value, kind: 'selected' })}
          label={`Selected ${selected.length === 1 ? 'page' : 'pages'} (${formatPageRange(selected)})`}
        />
      )}
      {selected.length === 0 && (
        <Radio
          name={name}
          checked={value.kind === 'current'}
          onChange={() => onChange({ ...value, kind: 'current' })}
          label={`Current page (${doc.state.currentPage + 1})`}
        />
      )}
      <div className="fc-organize-pages-range-row">
        <Radio
          name={name}
          checked={value.kind === 'range'}
          onChange={() => onChange({ ...value, kind: 'range' })}
          label="Pages:"
        />
        <TextInput
          aria-label="Page range"
          value={value.text}
          placeholder={`e.g. 1-3, 5 (of ${count})`}
          onFocus={() => value.kind !== 'range' && onChange({ ...value, kind: 'range' })}
          onChange={(e) => onChange({ kind: 'range', text: e.target.value })}
        />
      </div>
      {value.kind === 'range' && value.text.trim() !== '' && !res.ok && (
        <div className="ui-field-error">{res.error}</div>
      )}
    </fieldset>
  )
}

export type Where = 'before' | 'after'
export type PageChoice = 'first' | 'last' | 'page'

export interface Location {
  where: Where
  page: PageChoice
  number: number
}

/** Location defaulting to "after page N" for gap N (N = number of pages before the gap). */
export function locationForGap(gap: number, count: number): Location {
  if (gap <= 0) return { where: 'before', page: 'first', number: 1 }
  if (gap >= count) return { where: 'after', page: 'last', number: count }
  return { where: 'after', page: 'page', number: gap }
}

/** The insertion gap (0..count) for a location. */
export function gapForLocation(loc: Location, count: number): number {
  const n =
    loc.page === 'first'
      ? 1
      : loc.page === 'last'
        ? count
        : Math.max(1, Math.min(count, Math.round(loc.number) || 1))
  return loc.where === 'before' ? n - 1 : n
}

export function LocationPicker({
  value,
  onChange,
  count
}: {
  value: Location
  onChange: (l: Location) => void
  count: number
}) {
  return (
    <fieldset className="fc-organize-pages-fieldset">
      <legend>Location</legend>
      <div className="fc-organize-pages-location">
        <Segmented<Where>
          value={value.where}
          onChange={(where) => onChange({ ...value, where })}
          options={[
            { value: 'before', label: 'Before' },
            { value: 'after', label: 'After' }
          ]}
        />
        <Select<PageChoice>
          aria-label="Page"
          value={value.page}
          onChange={(page) => onChange({ ...value, page })}
          options={[
            { value: 'first', label: 'First page' },
            { value: 'last', label: 'Last page' },
            { value: 'page', label: 'Page' }
          ]}
        />
        {value.page === 'page' && (
          <NumberInput
            aria-label="Page number"
            min={1}
            max={count}
            value={value.number}
            onChange={(number) => onChange({ ...value, number })}
          />
        )}
        {value.page === 'page' && <span className="shell-muted">of {count}</span>}
      </div>
    </fieldset>
  )
}

export function Summary({ children, tone }: { children: ReactNode; tone?: 'warning' | 'error' }) {
  return <div className={`fc-organize-pages-summary ${tone ? `is-${tone}` : ''}`}>{children}</div>
}
