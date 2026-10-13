import { useId } from 'react'
import {
  Bold,
  Italic,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Underline
} from 'lucide-react'
import { ColorButton, IconButton, displayShortcut } from '@renderer/sdk'
import { fontOptions } from './fonts'
import { commonStyle, FONT_SIZE_PRESETS, LINE_SPACING_PRESETS, type Align, type RunStyle } from './model'
import { applyStyle, setParagraph, toggleStyle, useEditText } from './store'

/** Formatting values shown by the controls: the current selection's, or the new-text defaults. */
export function useFormatState() {
  const session = useEditText((s) => s.session)
  const defaults = useEditText((s) => s.defaults)
  if (session) {
    const st = commonStyle(session.runs, session.selection.start, session.selection.end)
    return {
      editing: true,
      style: st,
      align: session.align,
      lineSpacing: session.lineSpacing,
      fonts: session.fonts,
      disabled: session.status !== 'editing'
    }
  }
  return {
    editing: false,
    style: defaults as Partial<RunStyle>,
    align: defaults.align,
    lineSpacing: defaults.lineSpacing,
    fonts: [],
    disabled: false
  }
}

const ALIGNS: { value: Align; label: string; icon: typeof TextAlignStart }[] = [
  { value: 'left', label: 'Align left', icon: TextAlignStart },
  { value: 'center', label: 'Center', icon: TextAlignCenter },
  { value: 'right', label: 'Align right', icon: TextAlignEnd },
  { value: 'justify', label: 'Justify', icon: TextAlignJustify }
]

function FontSelect({
  value,
  fonts,
  disabled
}: {
  value: string | undefined
  fonts: ReturnType<typeof useFormatState>['fonts']
  disabled: boolean
}) {
  const options = fontOptions(fonts)
  return (
    <select
      className="ui-input ui-select fc-edit-text-font"
      aria-label="Font"
      title="Font"
      disabled={disabled}
      value={value ?? ''}
      onChange={(e) => e.target.value && applyStyle({ font: e.target.value })}
    >
      {value === undefined && <option value="">Mixed fonts</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function SizeInput({ value, disabled }: { value: number | undefined; disabled: boolean }) {
  const listId = useId()
  const commit = (raw: string, focus: boolean) => {
    const v = parseFloat(raw)
    if (Number.isFinite(v) && v >= 1 && v <= 999) applyStyle({ size: Math.round(v * 10) / 10 }, { focus })
  }
  return (
    <>
      <input
        key={value ?? 'mixed'}
        type="number"
        className="ui-input fc-edit-text-size"
        aria-label="Font size"
        title="Font size (points)"
        list={listId}
        min={1}
        max={999}
        step={0.5}
        disabled={disabled}
        defaultValue={value ?? ''}
        placeholder="—"
        onChange={(e) => {
          // choosing from the list or using the arrows applies straight away
          const native = e.nativeEvent as InputEvent
          if (!native.inputType || native.inputType === 'insertReplacementText') commit(e.target.value, false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit((e.target as HTMLInputElement).value, true)
          } else if (e.key === 'Escape') {
            ;(e.target as HTMLInputElement).value = value !== undefined ? String(value) : ''
          }
        }}
        onBlur={(e) => {
          if (e.target.value !== String(value ?? '')) commit(e.target.value, false)
        }}
      />
      <datalist id={listId}>
        {FONT_SIZE_PRESETS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </>
  )
}

function StyleToggles({ style, disabled }: { style: Partial<RunStyle>; disabled: boolean }) {
  return (
    <span className="fc-edit-text-toggles" role="group" aria-label="Text style">
      <IconButton
        icon={Bold}
        label="Bold"
        shortcut={displayShortcut('Mod+B')}
        active={style.bold === true}
        disabled={disabled}
        onClick={() => toggleStyle('bold')}
      />
      <IconButton
        icon={Italic}
        label="Italic"
        shortcut={displayShortcut('Mod+I')}
        active={style.italic === true}
        disabled={disabled}
        onClick={() => toggleStyle('italic')}
      />
      <IconButton
        icon={Underline}
        label="Underline"
        shortcut={displayShortcut('Mod+U')}
        active={style.underline === true}
        disabled={disabled}
        onClick={() => toggleStyle('underline')}
      />
    </span>
  )
}

function AlignButtons({ align, disabled }: { align: Align; disabled: boolean }) {
  return (
    <span className="fc-edit-text-toggles" role="group" aria-label="Alignment">
      {ALIGNS.map((a) => (
        <IconButton
          key={a.value}
          icon={a.icon}
          label={a.label}
          active={align === a.value}
          disabled={disabled}
          onClick={() => setParagraph({ align: a.value })}
        />
      ))}
    </span>
  )
}

function LineSpacing({ value, disabled, id }: { value: number; disabled: boolean; id?: string }) {
  const presets = LINE_SPACING_PRESETS.some((p) => Math.abs(p - value) < 0.005)
    ? LINE_SPACING_PRESETS
    : [...LINE_SPACING_PRESETS, value].sort((a, b) => a - b)
  return (
    <select
      id={id}
      className="ui-input ui-select fc-edit-text-spacing"
      aria-label="Line spacing"
      title="Line spacing"
      disabled={disabled}
      value={String(presets.find((p) => Math.abs(p - value) < 0.005) ?? value)}
      onChange={(e) => setParagraph({ lineSpacing: parseFloat(e.target.value) })}
    >
      {presets.map((p) => (
        <option key={p} value={String(p)}>
          {p.toFixed(2)}
        </option>
      ))}
    </select>
  )
}

/** Full formatting controls for the Edit panel. */
export function PanelFormat() {
  const f = useFormatState()
  const spacingId = useId()
  const disabled = f.disabled
  return (
    <div className="fc-edit-text-format" data-fc-edit-text-keep>
      <div className="fc-edit-text-row">
        <FontSelect value={f.style.font} fonts={f.fonts} disabled={disabled} />
      </div>
      <div className="fc-edit-text-row">
        <SizeInput value={f.style.size} disabled={disabled} />
        <span className="fc-edit-text-unit">pt</span>
        <StyleToggles style={f.style} disabled={disabled} />
      </div>
      <div className="fc-edit-text-row">
        {/* first in its row, so its colour palette fits inside the panel */}
        <ColorButton
          title="Text colour"
          value={f.style.color ?? null}
          onChange={(c) => c && applyStyle({ color: c.toLowerCase() })}
        />
        <span className="fc-edit-text-sep" />
        <AlignButtons align={f.align} disabled={disabled} />
      </div>
      <div className="fc-edit-text-row">
        <label className="fc-edit-text-label" htmlFor={spacingId}>
          Line spacing
        </label>
        <LineSpacing id={spacingId} value={f.lineSpacing} disabled={disabled} />
      </div>
      <p className="fc-edit-text-hint">
        {f.editing
          ? 'Changes apply to the selected text, or to the whole box when nothing is selected.'
          : 'These settings are used for new text. Click text on the page to change it.'}
      </p>
    </div>
  )
}

/** Compact controls for the floating toolbar next to the text being edited. */
export function MiniFormat() {
  const f = useFormatState()
  return (
    <>
      <FontSelect value={f.style.font} fonts={f.fonts} disabled={f.disabled} />
      <SizeInput value={f.style.size} disabled={f.disabled} />
      <ColorButton
        title="Text colour"
        value={f.style.color ?? null}
        onChange={(c) => c && applyStyle({ color: c.toLowerCase() })}
      />
      <StyleToggles style={f.style} disabled={f.disabled} />
    </>
  )
}
