import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import {
  ask,
  Button,
  Checkbox,
  ColorButton,
  Dialog,
  Field,
  NumberInput,
  openDialog,
  Radio,
  Select,
  showError,
  TextArea,
  TextInput,
  type DocumentModel
} from '@renderer/sdk'
import {
  DATE_PATTERNS,
  FONTS,
  TYPE_LABELS,
  type BorderStyle,
  type ButtonAction,
  type CalcOp,
  type CalculateSpec,
  type CheckStyle,
  type FieldProps,
  type FormatSpec,
  type PFField,
  type ValidateSpec,
  type Visibility
} from '../model'
import { checkNotation } from '../scripts'
import { pf, duplicateAcrossPages } from './actions'
import { formatExample, NEGATIVE_STYLES, SEPARATORS, SPECIAL_STYLES, TIME_STYLES } from './format'

type Tab = 'general' | 'appearance' | 'options' | 'actions' | 'format' | 'validate' | 'calculate'

const TAB_LABELS: Record<Tab, string> = {
  general: 'General',
  appearance: 'Appearance',
  options: 'Options',
  actions: 'Actions',
  format: 'Format',
  validate: 'Validate',
  calculate: 'Calculate'
}

function tabsFor(fields: PFField[]): Tab[] {
  if (fields.length > 1) return ['general', 'appearance']
  switch (fields[0].type) {
    case 'text':
    case 'date':
    case 'combo':
      return ['general', 'appearance', 'options', 'format', 'validate', 'calculate']
    case 'checkbox':
    case 'radio':
    case 'list':
      return ['general', 'appearance', 'options']
    case 'button':
      return ['general', 'appearance', 'options', 'actions']
    default:
      return ['general', 'appearance']
  }
}

type Draft = PFField
type SetFn = <K extends keyof Draft>(key: K, value: Draft[K]) => void

/** Opens Acrobat's "Properties" dialog for one or several fields. */
export function openProperties(doc: DocumentModel, ids: number[], tab?: Tab) {
  void (async () => {
    try {
      const fields = await Promise.all(ids.map((id) => pf(doc).get(id)))
      const names = await pf(doc).fieldNames()
      if (!fields.length) return
      await openDialog((close) => (
        <PropertiesDialog doc={doc} fields={fields} names={names} initialTab={tab} close={close} />
      ))
    } catch (err) {
      showError(err, 'Could not open the field properties')
    }
  })()
}

function PropertiesDialog({
  doc,
  fields,
  names,
  initialTab,
  close
}: {
  doc: DocumentModel
  fields: PFField[]
  names: string[]
  initialTab?: Tab
  close: () => void
}) {
  const multi = fields.length > 1
  const tabs = tabsFor(fields)
  const [tab, setTab] = useState<Tab>(initialTab && tabs.includes(initialTab) ? initialTab : 'general')
  const [draft, setDraft] = useState<Draft>(fields[0])
  const [changed, setChanged] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const set: SetFn = (key, value) => {
    setDraft((d) => ({ ...d, [key]: value }))
    setChanged((c) => new Set(c).add(key as string))
  }

  const otherNames = useMemo(() => names.filter((n) => n !== fields[0].name), [names, fields])
  const calcError =
    draft.calculate.kind === 'notation' && changed.has('calculate')
      ? checkNotation(draft.calculate.expr, otherNames)
      : null
  const nameError = changed.has('name') && !draft.name.trim() ? 'Enter a field name' : null

  const save = async (join = false) => {
    if (calcError || nameError) return
    const props: FieldProps = {}
    for (const key of changed) {
      if (key === 'name') continue
      ;(props as Record<string, unknown>)[key] = draft[key as keyof Draft]
    }
    const rename =
      !multi && changed.has('name') && draft.name.trim() !== fields[0].name
        ? { name: draft.name.trim(), join }
        : undefined
    if (!Object.keys(props).length && !rename) {
      close()
      return
    }
    setBusy(true)
    try {
      await pf(doc).update(
        fields.map((f) => f.id),
        props,
        rename
      )
      close()
    } catch (err) {
      setBusy(false)
      if ((err as { code?: string }).code === 'NAME_SHARED') {
        const answer = await ask({
          title: 'Use the same name?',
          message: `A field named “${draft.name.trim()}” already exists. Fields with the same name always show the same value. Use this name anyway?`,
          buttons: [
            { id: 'cancel', label: 'Cancel' },
            { id: 'join', label: 'Use the same name', variant: 'primary' }
          ]
        })
        if (answer === 'join') void save(true)
        return
      }
      showError(err, 'Could not change the field')
    }
  }

  const title = multi ? `Properties of ${fields.length} fields` : `${TYPE_LABELS[fields[0].type]} Properties`
  return (
    <Dialog
      title={title}
      onClose={close}
      width={600}
      className="fc-prepare-form-props"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" disabled={busy || !!calcError || !!nameError} onClick={() => void save()}>
            OK
          </Button>
        </>
      }
    >
      <div className="fc-prepare-form-tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={tab === t ? 'is-active' : ''}
            onClick={() => setTab(t)}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="fc-prepare-form-tabbody" role="tabpanel" aria-label={TAB_LABELS[tab]}>
        {tab === 'general' && <GeneralTab draft={draft} set={set} multi={multi} nameError={nameError} />}
        {tab === 'appearance' && <AppearanceTab draft={draft} set={set} />}
        {tab === 'options' && <OptionsTab draft={draft} set={set} />}
        {tab === 'actions' && <ActionsTab draft={draft} set={set} pageCount={doc.pageCount} />}
        {tab === 'format' && <FormatTab draft={draft} set={set} />}
        {tab === 'validate' && <ValidateTab draft={draft} set={set} />}
        {tab === 'calculate' && <CalculateTab draft={draft} set={set} names={otherNames} error={calcError} />}
      </div>
    </Dialog>
  )
}

function Row({ children }: { children: ReactNode }) {
  return <div className="fc-prepare-form-row">{children}</div>
}

// ---- General ---------------------------------------------------------------------------------

function GeneralTab({
  draft,
  set,
  multi,
  nameError
}: {
  draft: Draft
  set: SetFn
  multi: boolean
  nameError: string | null
}) {
  return (
    <div className="fc-prepare-form-grid">
      {!multi && (
        <>
          <Field
            label={draft.type === 'radio' ? 'Name (radio group)' : 'Name'}
            hint={nameError ?? 'Use a period for groups, e.g. “address.city”.'}
          >
            <TextInput
              data-autofocus
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              aria-invalid={!!nameError}
            />
          </Field>
          <Field label="Tooltip" hint="Shown when someone points at the field. Screen readers read it too.">
            <TextInput value={draft.tooltip} onChange={(e) => set('tooltip', e.target.value)} />
          </Field>
        </>
      )}
      <Row>
        <Field label="Form field">
          <Select<Visibility>
            value={draft.visibility}
            onChange={(v) => set('visibility', v)}
            options={[
              { value: 'visible', label: 'Visible' },
              { value: 'hidden', label: 'Hidden' },
              { value: 'visible-noprint', label: 'Visible but doesn’t print' },
              { value: 'hidden-print', label: 'Hidden but printable' }
            ]}
          />
        </Field>
        <Field label="Orientation">
          <Select<string>
            value={String(draft.orientation)}
            onChange={(v) => set('orientation', parseInt(v, 10))}
            options={[0, 90, 180, 270].map((d) => ({ value: String(d), label: `${d} degrees` }))}
          />
        </Field>
      </Row>
      <div className="fc-prepare-form-checks">
        <Checkbox checked={draft.readOnly} onChange={(v) => set('readOnly', v)} label="Read only" />
        <Checkbox
          checked={draft.required}
          onChange={(v) => set('required', v)}
          label="Required"
          disabled={draft.type === 'button'}
        />
      </div>
    </div>
  )
}

// ---- Appearance ------------------------------------------------------------------------------

const SIZES = [0, 6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72]

function AppearanceTab({ draft, set }: { draft: Draft; set: SetFn }) {
  const toggle = draft.type === 'checkbox' || draft.type === 'radio'
  const textual = draft.type !== 'signature' && !toggle
  const sizes = SIZES.includes(draft.fontSize) ? SIZES : [...SIZES, draft.fontSize].sort((a, b) => a - b)
  return (
    <div className="fc-prepare-form-grid">
      <h4 className="fc-prepare-form-h">Borders and colors</h4>
      <Row>
        <Field label="Border color" inline>
          <ColorButton
            value={draft.borderColor}
            allowNone
            onChange={(v) => set('borderColor', v)}
            title="Border color"
          />
        </Field>
        <Field label="Fill color" inline>
          <ColorButton
            value={draft.fillColor}
            allowNone
            onChange={(v) => set('fillColor', v)}
            title="Fill color"
          />
        </Field>
      </Row>
      <Row>
        <Field label="Line thickness">
          <Select<string>
            value={String(Math.min(3, Math.max(1, draft.borderWidth || 1)))}
            onChange={(v) => set('borderWidth', parseInt(v, 10))}
            options={[
              { value: '1', label: 'Thin' },
              { value: '2', label: 'Medium' },
              { value: '3', label: 'Thick' }
            ]}
          />
        </Field>
        <Field label="Line style">
          <Select<BorderStyle>
            value={draft.borderStyle}
            onChange={(v) => set('borderStyle', v)}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'dashed', label: 'Dashed' },
              { value: 'beveled', label: 'Beveled' },
              { value: 'inset', label: 'Inset' },
              { value: 'underline', label: 'Underline' }
            ]}
          />
        </Field>
      </Row>
      {!draft.borderColor && (
        <p className="fc-prepare-form-hint">Choose a border color to show the border.</p>
      )}
      {draft.type !== 'signature' && (
        <>
          <h4 className="fc-prepare-form-h">{toggle ? 'Check mark' : 'Text'}</h4>
          <Row>
            {textual && (
              <Field label="Font">
                <Select<string>
                  value={draft.fontName}
                  onChange={(v) => set('fontName', v)}
                  options={[
                    ...FONTS.map((f) => ({ value: f.id, label: f.label })),
                    ...(FONTS.some((f) => f.id === draft.fontName)
                      ? []
                      : [{ value: draft.fontName, label: draft.fontName }])
                  ]}
                />
              </Field>
            )}
            <Field label="Font size">
              <Select<string>
                value={String(draft.fontSize)}
                onChange={(v) => set('fontSize', parseFloat(v))}
                options={sizes.map((s) => ({ value: String(s), label: s === 0 ? 'Auto' : String(s) }))}
              />
            </Field>
            <Field label={toggle ? 'Check color' : 'Text color'} inline>
              <ColorButton
                value={draft.textColor}
                onChange={(v) => set('textColor', v ?? '#000000')}
                title={toggle ? 'Check color' : 'Text color'}
              />
            </Field>
          </Row>
        </>
      )}
    </div>
  )
}

// ---- Options ---------------------------------------------------------------------------------

const CHECK_STYLES: { value: CheckStyle; label: string }[] = [
  { value: 'check', label: 'Check ✔' },
  { value: 'circle', label: 'Circle ●' },
  { value: 'cross', label: 'Cross ✘' },
  { value: 'diamond', label: 'Diamond ◆' },
  { value: 'square', label: 'Square ■' },
  { value: 'star', label: 'Star ★' }
]

function OptionsTab({ draft, set }: { draft: Draft; set: SetFn }) {
  switch (draft.type) {
    case 'text':
    case 'date':
      return <TextOptions draft={draft} set={set} />
    case 'checkbox':
    case 'radio':
      return (
        <div className="fc-prepare-form-grid">
          <Row>
            <Field label={draft.type === 'radio' ? 'Button style' : 'Check box style'}>
              <Select<CheckStyle>
                value={draft.checkStyle}
                onChange={(v) => set('checkStyle', v)}
                options={CHECK_STYLES}
              />
            </Field>
            <Field
              label={draft.type === 'radio' ? 'Radio button choice' : 'Export value'}
              hint={
                draft.type === 'radio'
                  ? 'The value the group gets when this button is selected.'
                  : 'The value saved when the box is checked.'
              }
            >
              <TextInput value={draft.exportValue} onChange={(e) => set('exportValue', e.target.value)} />
            </Field>
          </Row>
          <div className="fc-prepare-form-checks">
            <Checkbox
              checked={draft.checkedByDefault}
              onChange={(v) => set('checkedByDefault', v)}
              label={
                draft.type === 'radio' ? 'Button is checked by default' : 'Check box is checked by default'
              }
            />
            {draft.type === 'radio' && (
              <Checkbox
                checked={draft.radiosInUnison}
                onChange={(v) => set('radiosInUnison', v)}
                label="Buttons with the same name and choice are selected in unison"
              />
            )}
          </div>
        </div>
      )
    case 'list':
    case 'combo':
      return <ChoiceOptions draft={draft} set={set} />
    case 'button':
      return (
        <div className="fc-prepare-form-grid">
          <Field label="Label">
            <TextInput
              data-autofocus
              value={draft.caption}
              onChange={(e) => set('caption', e.target.value)}
            />
          </Field>
          <Field label="Behavior when clicked">
            <Select<string>
              value={draft.highlight}
              onChange={(v) => set('highlight', v as Draft['highlight'])}
              options={[
                { value: 'none', label: 'None' },
                { value: 'invert', label: 'Invert' },
                { value: 'outline', label: 'Outline' },
                { value: 'push', label: 'Push' }
              ]}
            />
          </Field>
        </div>
      )
    default:
      return <p className="fc-prepare-form-hint">This field has no options.</p>
  }
}

function TextOptions({ draft, set }: { draft: Draft; set: SetFn }) {
  const limit = draft.maxLen > 0
  return (
    <div className="fc-prepare-form-grid">
      <Row>
        <Field label="Alignment">
          <Select<string>
            value={String(draft.alignment)}
            onChange={(v) => set('alignment', parseInt(v, 10))}
            options={[
              { value: '0', label: 'Left' },
              { value: '1', label: 'Center' },
              { value: '2', label: 'Right' }
            ]}
          />
        </Field>
        <Field label="Default value">
          {draft.multiline ? (
            <TextArea
              rows={2}
              value={draft.defaultValue}
              onChange={(e) => set('defaultValue', e.target.value)}
            />
          ) : (
            <TextInput value={draft.defaultValue} onChange={(e) => set('defaultValue', e.target.value)} />
          )}
        </Field>
      </Row>
      <div className="fc-prepare-form-checks">
        <Checkbox
          checked={draft.multiline}
          disabled={draft.comb}
          onChange={(v) => set('multiline', v)}
          label="Multi-line"
        />
        <Checkbox
          checked={!draft.doNotScroll}
          disabled={draft.comb}
          onChange={(v) => set('doNotScroll', !v)}
          label="Scroll long text"
        />
        <Checkbox
          checked={!draft.doNotSpellCheck}
          onChange={(v) => set('doNotSpellCheck', !v)}
          label="Check spelling"
        />
        <Checkbox
          checked={draft.password}
          disabled={draft.comb || draft.multiline}
          onChange={(v) => set('password', v)}
          label="Password (hide what is typed)"
        />
        <div className="fc-prepare-form-inline-field">
          <Checkbox
            checked={limit && !draft.comb}
            disabled={draft.comb}
            onChange={(v) => set('maxLen', v ? Math.max(1, draft.maxLen || 10) : 0)}
            label="Limit of"
          />
          <NumberInput
            value={draft.maxLen || 10}
            min={1}
            max={9999}
            disabled={!limit || draft.comb}
            aria-label="Character limit"
            onChange={(v) => set('maxLen', Math.max(1, Math.round(v)))}
          />
          <span>characters</span>
        </div>
        <div className="fc-prepare-form-inline-field">
          <Checkbox
            checked={draft.comb}
            onChange={(v) => {
              set('comb', v)
              if (v) {
                set('maxLen', Math.max(1, draft.maxLen || 10))
                set('multiline', false)
                set('password', false)
              }
            }}
            label="Comb of"
          />
          <NumberInput
            value={draft.maxLen || 10}
            min={1}
            max={500}
            disabled={!draft.comb}
            aria-label="Comb characters"
            onChange={(v) => set('maxLen', Math.max(1, Math.round(v)))}
          />
          <span>characters (one per box, e.g. account numbers)</span>
        </div>
      </div>
    </div>
  )
}

function ChoiceOptions({ draft, set }: { draft: Draft; set: SetFn }) {
  const [item, setItem] = useState('')
  const [exportValue, setExportValue] = useState('')
  const [selected, setSelected] = useState(-1)
  const options = draft.options
  const multiDefault = draft.type === 'list' && draft.multiSelect
  const add = () => {
    const label = item.trim()
    if (!label) return
    const value = exportValue.trim() || label
    if (options.some((o) => o.label === label && o.value === value)) return
    set('options', [...options, { label, value }])
    setItem('')
    setExportValue('')
    setSelected(options.length)
  }
  const move = (i: number, d: number) => {
    const j = i + d
    if (j < 0 || j >= options.length) return
    const next = [...options]
    ;[next[i], next[j]] = [next[j], next[i]]
    set('options', next)
    set('sort', false)
    setSelected(j)
  }
  const remove = (i: number) => {
    const o = options[i]
    set(
      'options',
      options.filter((_, k) => k !== i)
    )
    set(
      'defaultSelection',
      draft.defaultSelection.filter((v) => v !== o.value)
    )
    setSelected(-1)
  }
  const toggleDefault = (value: string) => {
    if (multiDefault) {
      set(
        'defaultSelection',
        draft.defaultSelection.includes(value)
          ? draft.defaultSelection.filter((v) => v !== value)
          : [...draft.defaultSelection, value]
      )
    } else set('defaultSelection', draft.defaultSelection[0] === value ? [] : [value])
  }
  return (
    <div className="fc-prepare-form-grid">
      <Row>
        <Field label="Item">
          <TextInput
            data-autofocus
            value={item}
            placeholder="e.g. Japan"
            onChange={(e) => setItem(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                add()
              }
            }}
          />
        </Field>
        <Field label="Export value (optional)">
          <TextInput
            value={exportValue}
            placeholder="Same as item"
            onChange={(e) => setExportValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                e.stopPropagation()
                add()
              }
            }}
          />
        </Field>
        <Button icon={Plus} onClick={add} disabled={!item.trim()} className="fc-prepare-form-add">
          Add
        </Button>
      </Row>
      <div className="fc-prepare-form-items" role="listbox" aria-label="Item list">
        {options.length === 0 && (
          <div className="fc-prepare-form-hint">No items yet. Type an item and press Enter.</div>
        )}
        {options.map((o, i) => (
          <div
            key={`${o.value}-${i}`}
            role="option"
            aria-selected={selected === i}
            className={`fc-prepare-form-item ${selected === i ? 'is-selected' : ''}`}
            onClick={() => setSelected(i)}
          >
            <label className="fc-prepare-form-default" title="Selected by default">
              <input
                type={multiDefault ? 'checkbox' : 'radio'}
                name="pf-default"
                checked={draft.defaultSelection.includes(o.value)}
                onChange={() => toggleDefault(o.value)}
                onClick={(e) => {
                  // clicking the selected radio again clears the default
                  if (!multiDefault && draft.defaultSelection[0] === o.value) {
                    e.preventDefault()
                    toggleDefault(o.value)
                  }
                }}
                aria-label={`Select ${o.label} by default`}
              />
            </label>
            <span className="fc-prepare-form-item-label">{o.label}</span>
            {o.value !== o.label && <span className="fc-prepare-form-item-value">{o.value}</span>}
            <span className="fc-prepare-form-item-actions">
              <button
                className="ui-icon-btn"
                aria-label={`Move ${o.label} up`}
                title="Up"
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                className="ui-icon-btn"
                aria-label={`Move ${o.label} down`}
                title="Down"
                disabled={i === options.length - 1}
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={14} />
              </button>
              <button
                className="ui-icon-btn"
                aria-label={`Delete ${o.label}`}
                title="Delete"
                onClick={() => remove(i)}
              >
                <X size={14} />
              </button>
            </span>
          </div>
        ))}
      </div>
      <p className="fc-prepare-form-hint">The ticked item is selected when the form opens or is cleared.</p>
      <div className="fc-prepare-form-checks">
        <Checkbox checked={draft.sort} onChange={(v) => set('sort', v)} label="Sort items" />
        {draft.type === 'combo' && (
          <Checkbox
            checked={draft.editable}
            onChange={(v) => set('editable', v)}
            label="Allow user to enter custom text"
          />
        )}
        {draft.type === 'combo' && draft.editable && (
          <Checkbox
            checked={!draft.doNotSpellCheck}
            onChange={(v) => set('doNotSpellCheck', !v)}
            label="Check spelling"
          />
        )}
        {draft.type === 'list' && (
          <Checkbox
            checked={draft.multiSelect}
            onChange={(v) => set('multiSelect', v)}
            label="Multiple selection"
          />
        )}
        <Checkbox
          checked={draft.commitOnSelChange}
          onChange={(v) => set('commitOnSelChange', v)}
          label="Commit selected value immediately"
        />
      </div>
    </div>
  )
}

// ---- Actions ---------------------------------------------------------------------------------

function ActionsTab({ draft, set, pageCount }: { draft: Draft; set: SetFn; pageCount: number }) {
  const a = draft.action
  const kind = a.kind
  return (
    <div className="fc-prepare-form-grid">
      <Field label="When the button is clicked">
        <Select<string>
          value={kind}
          onChange={(v) => {
            const next: ButtonAction =
              v === 'url'
                ? { kind: 'url', url: '' }
                : v === 'page'
                  ? { kind: 'page', page: 0 }
                  : ({ kind: v } as ButtonAction)
            set('action', next)
          }}
          options={[
            { value: 'none', label: 'Do nothing' },
            { value: 'reset', label: 'Reset (clear) the form' },
            { value: 'url', label: 'Open a web link' },
            { value: 'page', label: 'Go to a page in this document' },
            { value: 'print', label: 'Print the document' },
            ...(kind === 'other' ? [{ value: 'other', label: 'Keep the current action' }] : [])
          ]}
        />
      </Field>
      {a.kind === 'url' && (
        <Field label="Web address">
          <TextInput
            data-autofocus
            value={a.url}
            placeholder="https://example.com"
            onChange={(e) => set('action', { kind: 'url', url: e.target.value })}
          />
        </Field>
      )}
      {a.kind === 'page' && (
        <Field label={`Page (1–${pageCount})`}>
          <NumberInput
            value={a.page + 1}
            min={1}
            max={pageCount}
            onChange={(v) =>
              set('action', { kind: 'page', page: Math.max(0, Math.min(pageCount - 1, Math.round(v) - 1)) })
            }
          />
        </Field>
      )}
      {a.kind === 'other' && (
        <p className="fc-prepare-form-hint">
          This button runs an action Fartcrobat cannot edit ({a.description}). It is kept unless you choose
          another action.
        </p>
      )}
    </div>
  )
}

// ---- Format ----------------------------------------------------------------------------------

const CURRENCIES = [
  { value: '', label: 'None' },
  { value: '$', label: '$ (Dollar)' },
  { value: '€', label: '€ (Euro)' },
  { value: '£', label: '£ (Pound)' },
  { value: '¥', label: '¥ (Yen / Yuan)' },
  { value: '₹', label: '₹ (Rupee)' },
  { value: 'CHF ', label: 'CHF (Swiss franc)' },
  { value: 'kr ', label: 'kr (Krona / Krone)' },
  { value: 'R$', label: 'R$ (Real)' }
]

function defaultFormat(kind: FormatSpec['kind'], current: FormatSpec): FormatSpec {
  switch (kind) {
    case 'number':
      return { kind: 'number', decimals: 2, separator: 0, negative: 0, currency: '', currencyPrepend: true }
    case 'percent':
      return { kind: 'percent', decimals: 2, separator: 0 }
    case 'date':
      return { kind: 'date', pattern: 'mm/dd/yyyy' }
    case 'time':
      return { kind: 'time', style: 0 }
    case 'special':
      return { kind: 'special', style: 0 }
    case 'mask':
      return { kind: 'mask', mask: '' }
    case 'custom':
      return current.kind === 'custom' ? current : { kind: 'custom', format: '', keystroke: '' }
    default:
      return { kind: 'none' }
  }
}

function FormatTab({ draft, set }: { draft: Draft; set: SetFn }) {
  const f = draft.format
  const category = f.kind === 'mask' ? 'special' : f.kind
  const example = formatExample(f)
  return (
    <div className="fc-prepare-form-grid">
      <Field label="Format category">
        <Select<string>
          value={category}
          onChange={(v) => set('format', defaultFormat(v as FormatSpec['kind'], f))}
          options={[
            { value: 'none', label: 'None' },
            { value: 'number', label: 'Number' },
            { value: 'percent', label: 'Percentage' },
            { value: 'date', label: 'Date' },
            { value: 'time', label: 'Time' },
            { value: 'special', label: 'Special' },
            { value: 'custom', label: 'Custom (JavaScript)' }
          ]}
        />
      </Field>
      {f.kind === 'number' && (
        <>
          <Row>
            <Field label="Decimal places">
              <Select<string>
                value={String(f.decimals)}
                onChange={(v) => set('format', { ...f, decimals: parseInt(v, 10) })}
                options={[0, 1, 2, 3, 4, 5, 6].map((n) => ({ value: String(n), label: String(n) }))}
              />
            </Field>
            <Field label="Separator style">
              <Select<string>
                value={String(f.separator)}
                onChange={(v) => set('format', { ...f, separator: parseInt(v, 10) })}
                options={SEPARATORS.map((l, i) => ({ value: String(i), label: l }))}
              />
            </Field>
          </Row>
          <Row>
            <Field label="Currency symbol">
              <Select<string>
                value={f.currency}
                onChange={(v) => set('format', { ...f, currency: v })}
                options={
                  CURRENCIES.some((c) => c.value === f.currency)
                    ? CURRENCIES
                    : [...CURRENCIES, { value: f.currency, label: f.currency }]
                }
              />
            </Field>
            <Field label="Symbol location">
              <Select<string>
                value={f.currencyPrepend ? 'before' : 'after'}
                disabled={!f.currency}
                onChange={(v) => set('format', { ...f, currencyPrepend: v === 'before' })}
                options={[
                  { value: 'before', label: 'Before number' },
                  { value: 'after', label: 'After number' }
                ]}
              />
            </Field>
          </Row>
          <Field label="Negative numbers">
            <Select<string>
              value={String(f.negative)}
              onChange={(v) => set('format', { ...f, negative: parseInt(v, 10) })}
              options={NEGATIVE_STYLES.map((l, i) => ({ value: String(i), label: l }))}
            />
          </Field>
        </>
      )}
      {f.kind === 'percent' && (
        <Row>
          <Field label="Decimal places">
            <Select<string>
              value={String(f.decimals)}
              onChange={(v) => set('format', { ...f, decimals: parseInt(v, 10) })}
              options={[0, 1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
            />
          </Field>
          <Field label="Separator style">
            <Select<string>
              value={String(f.separator)}
              onChange={(v) => set('format', { ...f, separator: parseInt(v, 10) })}
              options={SEPARATORS.map((l, i) => ({ value: String(i), label: l }))}
            />
          </Field>
        </Row>
      )}
      {f.kind === 'date' && (
        <Row>
          <Field label="Date format">
            <Select<string>
              value={DATE_PATTERNS.includes(f.pattern) ? f.pattern : '__custom'}
              onChange={(v) => set('format', { kind: 'date', pattern: v === '__custom' ? f.pattern : v })}
              options={[
                ...DATE_PATTERNS.map((p) => ({ value: p, label: p })),
                { value: '__custom', label: 'Custom…' }
              ]}
            />
          </Field>
          <Field
            label="Custom format"
            hint="d = day, m = month, y = year, H/h = hour, M = minute, tt = am/pm"
          >
            <TextInput
              value={f.pattern}
              onChange={(e) => set('format', { kind: 'date', pattern: e.target.value })}
            />
          </Field>
        </Row>
      )}
      {f.kind === 'time' && (
        <Field label="Time format">
          <Select<string>
            value={String(f.style)}
            onChange={(v) => set('format', { kind: 'time', style: parseInt(v, 10) })}
            options={TIME_STYLES.map((l, i) => ({ value: String(i), label: l }))}
          />
        </Field>
      )}
      {(f.kind === 'special' || f.kind === 'mask') && (
        <>
          <Field label="Special format">
            <Select<string>
              value={f.kind === 'mask' ? 'mask' : String(f.style)}
              onChange={(v) =>
                set(
                  'format',
                  v === 'mask'
                    ? { kind: 'mask', mask: f.kind === 'mask' ? f.mask : '' }
                    : { kind: 'special', style: parseInt(v, 10) }
                )
              }
              options={[
                ...SPECIAL_STYLES.map((l, i) => ({ value: String(i), label: l })),
                { value: 'mask', label: 'Arbitrary mask' }
              ]}
            />
          </Field>
          {f.kind === 'mask' && (
            <Field
              label="Mask"
              hint="9 = a digit, A = a letter, O = a letter or digit, X = any character. Other characters are typed for the user."
            >
              <TextInput
                data-autofocus
                value={f.mask}
                placeholder="e.g. AA-9999"
                onChange={(e) => set('format', { kind: 'mask', mask: e.target.value })}
              />
            </Field>
          )}
        </>
      )}
      {f.kind === 'custom' && (
        <>
          <Field label="Custom format script">
            <TextArea
              className="fc-prepare-form-code"
              rows={3}
              value={f.format}
              onChange={(e) => set('format', { ...f, format: e.target.value })}
            />
          </Field>
          <Field label="Custom keystroke script">
            <TextArea
              className="fc-prepare-form-code"
              rows={3}
              value={f.keystroke}
              onChange={(e) => set('format', { ...f, keystroke: e.target.value })}
            />
          </Field>
        </>
      )}
      {example && (
        <div className="fc-prepare-form-example">
          Example: <b>{example}</b>
        </div>
      )}
      {f.kind === 'none' && <p className="fc-prepare-form-hint">Text is shown exactly as it is typed.</p>}
    </div>
  )
}

// ---- Validate --------------------------------------------------------------------------------

function ValidateTab({ draft, set }: { draft: Draft; set: SetFn }) {
  const v = draft.validate
  const range = v.kind === 'range' ? v : { kind: 'range' as const, min: null, max: null }
  const num = (s: string): number | null =>
    s.trim() === '' || Number.isNaN(parseFloat(s)) ? null : parseFloat(s)
  return (
    <div className="fc-prepare-form-grid">
      <Radio
        name="pf-validate"
        checked={v.kind === 'none'}
        onChange={() => set('validate', { kind: 'none' })}
        label="Field value is not validated"
      />
      <Radio
        name="pf-validate"
        checked={v.kind === 'range'}
        onChange={() => set('validate', range)}
        label="Field value is in range"
      />
      {v.kind === 'range' && (
        <Row>
          <Field label="From (leave empty for no minimum)">
            <TextInput
              inputMode="decimal"
              defaultValue={v.min ?? ''}
              onChange={(e) => set('validate', { ...v, min: num(e.target.value) } as ValidateSpec)}
            />
          </Field>
          <Field label="To (leave empty for no maximum)">
            <TextInput
              inputMode="decimal"
              defaultValue={v.max ?? ''}
              onChange={(e) => set('validate', { ...v, max: num(e.target.value) } as ValidateSpec)}
            />
          </Field>
        </Row>
      )}
      <Radio
        name="pf-validate"
        checked={v.kind === 'custom'}
        onChange={() => set('validate', { kind: 'custom', script: v.kind === 'custom' ? v.script : '' })}
        label="Run custom validation script"
      />
      {v.kind === 'custom' && (
        <TextArea
          className="fc-prepare-form-code"
          rows={4}
          value={v.script}
          onChange={(e) => set('validate', { kind: 'custom', script: e.target.value })}
          aria-label="Validation script"
        />
      )}
    </div>
  )
}

// ---- Calculate -------------------------------------------------------------------------------

const OPS: { value: CalcOp; label: string }[] = [
  { value: 'SUM', label: 'sum (+)' },
  { value: 'PRD', label: 'product (×)' },
  { value: 'AVG', label: 'average' },
  { value: 'MIN', label: 'minimum' },
  { value: 'MAX', label: 'maximum' }
]

function CalculateTab({
  draft,
  set,
  names,
  error
}: {
  draft: Draft
  set: SetFn
  names: string[]
  error: string | null
}) {
  const c = draft.calculate
  const simple =
    c.kind === 'simple' ? c : { kind: 'simple' as const, op: 'SUM' as CalcOp, fields: [] as string[] }
  const [filter, setFilter] = useState('')
  const setCalc = (next: CalculateSpec) => set('calculate', next)
  return (
    <div className="fc-prepare-form-grid">
      <Radio
        name="pf-calc"
        checked={c.kind === 'none'}
        onChange={() => setCalc({ kind: 'none' })}
        label="Value is not calculated"
      />
      <div className="fc-prepare-form-inline-field">
        <Radio
          name="pf-calc"
          checked={c.kind === 'simple'}
          onChange={() => setCalc(simple)}
          label="Value is the"
        />
        <Select<CalcOp>
          value={simple.op}
          disabled={c.kind !== 'simple'}
          onChange={(op) => setCalc({ ...simple, op })}
          options={OPS}
          aria-label="Calculation"
        />
        <span>of the following fields:</span>
      </div>
      {c.kind === 'simple' && (
        <div className="fc-prepare-form-pick">
          <TextInput
            value={filter}
            placeholder="Filter fields…"
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter fields"
          />
          <div className="fc-prepare-form-pick-list">
            {names.length === 0 && <div className="fc-prepare-form-hint">There are no other fields yet.</div>}
            {names
              .filter((n) => n.toLowerCase().includes(filter.toLowerCase()))
              .map((n) => (
                <Checkbox
                  key={n}
                  checked={simple.fields.includes(n)}
                  onChange={(on) =>
                    setCalc({
                      ...simple,
                      fields: on ? [...simple.fields, n] : simple.fields.filter((x) => x !== n)
                    })
                  }
                  label={n}
                />
              ))}
          </div>
          <div className="fc-prepare-form-hint">
            {simple.fields.length
              ? `Picked: ${simple.fields.join(', ')}`
              : 'Pick the fields to calculate from.'}
          </div>
        </div>
      )}
      <Radio
        name="pf-calc"
        checked={c.kind === 'notation'}
        onChange={() => setCalc({ kind: 'notation', expr: c.kind === 'notation' ? c.expr : '' })}
        label="Simplified field notation"
      />
      {c.kind === 'notation' && (
        <Field
          label=""
          hint={
            error ??
            'Use field names with + − * / and parentheses, e.g. “Price * Quantity + Shipping”. Put a backslash before spaces in names: “Unit\\ price”.'
          }
        >
          <TextArea
            className={`fc-prepare-form-code ${error ? 'is-invalid' : ''}`}
            rows={3}
            value={c.expr}
            onChange={(e) => setCalc({ kind: 'notation', expr: e.target.value })}
            aria-label="Simplified field notation"
            aria-invalid={!!error}
          />
        </Field>
      )}
      <Radio
        name="pf-calc"
        checked={c.kind === 'custom'}
        onChange={() => setCalc({ kind: 'custom', script: c.kind === 'custom' ? c.script : '' })}
        label="Custom calculation script"
      />
      {c.kind === 'custom' && (
        <TextArea
          className="fc-prepare-form-code"
          rows={4}
          value={c.script}
          onChange={(e) => setCalc({ kind: 'custom', script: e.target.value })}
          aria-label="Calculation script"
        />
      )}
      <p className="fc-prepare-form-hint">
        Calculated fields update whenever a field they use changes. Change the order in “Set Field Calculation
        Order”.
      </p>
    </div>
  )
}

// ---- Duplicate across pages -------------------------------------------------------------------

export function openDuplicateDialog(doc: DocumentModel, ids: number[], page: number) {
  void openDialog((close) => <DuplicateDialog doc={doc} ids={ids} page={page} close={close} />)
}

function DuplicateDialog({
  doc,
  ids,
  page,
  close
}: {
  doc: DocumentModel
  ids: number[]
  page: number
  close: () => void
}) {
  const n = doc.pageCount
  const [all, setAll] = useState(true)
  const [from, setFrom] = useState(1)
  const [to, setTo] = useState(n)
  const pages = all
    ? Array.from({ length: n }, (_, i) => i)
    : Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from - 1 + i)
  const targets = pages.filter((p) => p !== page && p >= 0 && p < n)
  return (
    <Dialog
      title="Duplicate Field"
      onClose={close}
      width={440}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!targets.length}
            onClick={() => {
              close()
              void duplicateAcrossPages(doc, ids, targets)
            }}
          >
            Duplicate
          </Button>
        </>
      }
    >
      <p className="ui-dialog-message">
        Put a copy of {ids.length > 1 ? 'these fields' : 'this field'} at the same place on other pages.
        Copies keep the same name, so they always show the same value (handy for a name or date on every
        page).
      </p>
      <div className="fc-prepare-form-grid">
        <Radio name="pf-dup" checked={all} onChange={() => setAll(true)} label={`All pages (${n})`} />
        <div className="fc-prepare-form-inline-field">
          <Radio name="pf-dup" checked={!all} onChange={() => setAll(false)} label="From page" />
          <NumberInput
            value={from}
            min={1}
            max={n}
            disabled={all}
            aria-label="From page"
            onChange={(v) => setFrom(Math.max(1, Math.min(n, Math.round(v))))}
          />
          <span>to</span>
          <NumberInput
            value={to}
            min={1}
            max={n}
            disabled={all}
            aria-label="To page"
            onChange={(v) => setTo(Math.max(1, Math.min(n, Math.round(v))))}
          />
        </div>
        <p className="fc-prepare-form-hint">
          {targets.length
            ? `${targets.length} cop${targets.length === 1 ? 'y' : 'ies'} will be added (the current page is skipped).`
            : 'Choose at least one other page.'}
        </p>
      </div>
    </Dialog>
  )
}
