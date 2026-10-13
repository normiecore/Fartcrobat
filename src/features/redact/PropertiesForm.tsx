import { useEffect, useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import {
  Button,
  Checkbox,
  ColorButton,
  Dialog,
  Field,
  NumberInput,
  Radio,
  Segmented,
  Select,
  TextInput,
  openDialog,
  showError,
  type DocumentModel
} from '@renderer/sdk'
import {
  OVERLAY_FONTS,
  REDACTION_CODE_SETS,
  overlayTextOf,
  type OverlayAlign,
  type OverlayFont,
  type RedactionProps
} from './shared'
import { currentProps, loadProps, marksOf, redactOps, saveProps, useRedactUi } from './store'

function fontCss(font: OverlayFont) {
  const f = OVERLAY_FONTS.find((x) => x.id === font) ?? OVERLAY_FONTS[0]
  return { fontFamily: f.css, fontWeight: f.weight }
}

/** How the redacted area will look once applied. */
export function RedactionPreview({ props, label = 'Preview' }: { props: RedactionProps; label?: string }) {
  const text = overlayTextOf(props)
  const size = props.autoSize ? 18 : Math.min(32, Math.max(6, props.fontSize * 1.33))
  const content = text ? (props.repeat ? Array(24).fill(text).join('  ') : text) : ''
  return (
    <div className="fc-redact-preview-wrap" aria-label={label}>
      <div className="fc-redact-preview-page">
        <span className="fc-redact-preview-line">Name: Jane Example</span>
        <div
          className={`fc-redact-preview ${props.fillColor ? '' : 'is-unfilled'} ${props.repeat ? 'is-repeat' : ''}`}
          style={{
            background: props.fillColor ?? undefined,
            color: props.textColor,
            textAlign: props.align,
            fontSize: size,
            ...fontCss(props.font)
          }}
        >
          <span>{content}</span>
        </div>
        <span className="fc-redact-preview-line">Phone: (555) 010-0199</span>
      </div>
      <div className="fc-redact-preview-mark" style={{ borderColor: props.outlineColor }} title="Mark before applying">
        Marked
      </div>
    </div>
  )
}

export function PropertiesForm({ value, onChange }: { value: RedactionProps; onChange: (p: RedactionProps) => void }) {
  const set = (patch: Partial<RedactionProps>) => onChange({ ...value, ...patch })
  const codeSet = REDACTION_CODE_SETS.find((cs) => cs.codes.some((c) => c.code === value.code)) ?? REDACTION_CODE_SETS[0]
  const textOff = value.overlay === 'none'
  return (
    <div className="fc-redact-props">
      <RedactionPreview props={value} />
      <div className="fc-redact-props-row">
        <Field label="Redacted area fill colour" inline>
          <ColorButton value={value.fillColor} allowNone onChange={(c) => set({ fillColor: c })} title="Fill colour of redacted areas" />
        </Field>
        <Field label="Mark outline colour" inline>
          <ColorButton value={value.outlineColor} onChange={(c) => c && set({ outlineColor: c })} title="Outline colour of marks before applying" />
        </Field>
      </div>
      <fieldset className="fc-redact-fieldset">
        <legend>Overlay text</legend>
        <div className="fc-redact-overlay-choice">
          <Radio name="fc-redact-overlay" checked={value.overlay === 'none'} onChange={() => set({ overlay: 'none' })} label="None" />
          <Radio name="fc-redact-overlay" checked={value.overlay === 'custom'} onChange={() => set({ overlay: 'custom' })} label="Custom text" />
          <Radio name="fc-redact-overlay" checked={value.overlay === 'code'} onChange={() => set({ overlay: 'code' })} label="Redaction code" />
        </div>
        {value.overlay === 'custom' && (
          <TextInput
            aria-label="Custom overlay text"
            value={value.customText}
            placeholder="e.g. REDACTED"
            maxLength={200}
            onChange={(e) => set({ customText: e.target.value })}
          />
        )}
        {value.overlay === 'code' && (
          <div className="fc-redact-props-row">
            <Select
              aria-label="Code set"
              value={codeSet.id}
              onChange={(id) => {
                const cs = REDACTION_CODE_SETS.find((c) => c.id === id)!
                set({ code: cs.codes[0].code })
              }}
              options={REDACTION_CODE_SETS.map((cs) => ({ value: cs.id, label: cs.label }))}
            />
            <Select
              aria-label="Redaction code"
              value={value.code}
              onChange={(code) => set({ code })}
              options={codeSet.codes.map((c) => ({ value: c.code, label: `${c.code} ${c.description}` }))}
            />
          </div>
        )}
        <div className={`fc-redact-props-grid ${textOff ? 'is-disabled' : ''}`} aria-disabled={textOff}>
          <Field label="Font">
            <Select<OverlayFont>
              value={value.font}
              disabled={textOff}
              onChange={(font) => set({ font })}
              options={OVERLAY_FONTS.map((f) => ({ value: f.id, label: f.label }))}
            />
          </Field>
          <Field label="Font size">
            <NumberInput
              value={value.fontSize}
              min={4}
              max={72}
              disabled={textOff || value.autoSize}
              aria-label="Font size"
              onChange={(v) => set({ fontSize: Math.max(4, Math.min(72, v)) })}
            />
          </Field>
          <Field label="Font colour">
            <ColorButton value={value.textColor} onChange={(c) => c && set({ textColor: c })} title="Overlay text colour" />
          </Field>
          <Field label="Alignment">
            <Segmented<OverlayAlign>
              value={value.align}
              onChange={(align) => set({ align })}
              options={[
                { value: 'left', label: <AlignLeft size={14} />, title: 'Left' },
                { value: 'center', label: <AlignCenter size={14} />, title: 'Centre' },
                { value: 'right', label: <AlignRight size={14} />, title: 'Right' }
              ]}
            />
          </Field>
        </div>
        <div className="fc-redact-props-checks">
          <Checkbox checked={value.autoSize} disabled={textOff} onChange={(v) => set({ autoSize: v })} label="Auto-size text to fit the redacted area" />
          <Checkbox checked={value.repeat} disabled={textOff} onChange={(v) => set({ repeat: v })} label="Repeat overlay text" />
        </div>
      </fieldset>
    </div>
  )
}

/** Preferences > Redaction: the defaults used for new marks. */
export function RedactionSettings() {
  const props = useRedactUi((s) => s.props)
  useEffect(() => {
    void loadProps()
  }, [])
  return (
    <div className="fc-redact-settings">
      <p className="shell-muted">These properties are used for new redaction marks. The overlay text is drawn when you apply redactions.</p>
      <PropertiesForm value={props} onChange={(p) => void saveProps(p)} />
    </div>
  )
}

function PropertiesDialog({
  initial,
  title,
  existing,
  close
}: {
  initial: RedactionProps
  title: string
  existing: number
  close: (r?: { props: RedactionProps; updateExisting: boolean }) => void
}) {
  const [props, setProps] = useState(initial)
  const [updateExisting, setUpdateExisting] = useState(existing > 0)
  return (
    <Dialog
      title={title}
      onClose={() => close()}
      width={560}
      className="fc-redact-dialog"
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={() => close({ props, updateExisting })}>
            OK
          </Button>
        </>
      }
    >
      <PropertiesForm value={props} onChange={setProps} />
      {existing > 0 && (
        <div className="fc-redact-dialog-extra">
          <Checkbox
            checked={updateExisting}
            onChange={setUpdateExisting}
            label={existing === 1 ? 'Also change the existing redaction mark' : `Also change the ${existing} existing redaction marks`}
          />
        </div>
      )}
    </Dialog>
  )
}

/** Redaction Properties: edits the defaults for new marks (and optionally the existing marks). */
export async function openPropertiesDialog(doc: DocumentModel | null) {
  await loadProps()
  const marks = doc ? marksOf(doc) : []
  const r = await openDialog<{ props: RedactionProps; updateExisting: boolean }>((close) => (
    <PropertiesDialog initial={currentProps()} title="Redaction properties" existing={marks.length} close={close} />
  ))
  if (!r) return
  await saveProps(r.props)
  if (doc && r.updateExisting && marks.length) {
    try {
      await redactOps(doc).update(
        marks.map((m) => m.id),
        r.props
      )
    } catch (err) {
      showError(err, 'Could not change the redaction marks')
    }
  }
}

/** Properties of specific marks (right-click a mark > Properties). */
export async function openMarkPropertiesDialog(doc: DocumentModel, ids: number[]) {
  const mark = marksOf(doc).find((m) => ids.includes(m.id))
  if (!mark) return
  const r = await openDialog<{ props: RedactionProps; updateExisting: boolean }>((close) => (
    <PropertiesDialog
      initial={mark.props}
      title={ids.length > 1 ? `Properties of ${ids.length} redaction marks` : 'Redaction mark properties'}
      existing={0}
      close={close}
    />
  ))
  if (!r) return
  try {
    await redactOps(doc).update(ids, r.props)
  } catch (err) {
    showError(err, 'Could not change the redaction mark')
  }
}
