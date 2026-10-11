import { useState } from 'react'

export const ANNOTATION_COLORS = [
  '#FFEB3B', '#FFC107', '#FF9800', '#F44336', '#E91E63', '#9C27B0', '#3F51B5', '#2196F3',
  '#03A9F4', '#00BCD4', '#4CAF50', '#8BC34A', '#795548', '#9E9E9E', '#000000', '#FFFFFF'
]

/** Swatch grid plus a custom colour input. `allowNone` adds a "no colour" swatch. */
export function ColorPicker({
  value,
  onChange,
  allowNone,
  colors = ANNOTATION_COLORS
}: {
  value: string | null
  onChange: (v: string | null) => void
  allowNone?: boolean
  colors?: string[]
}) {
  const [custom, setCustom] = useState(value && !colors.includes(value.toUpperCase()) ? value : '#1473E6')
  return (
    <div className="ui-colors">
      {allowNone && (
        <button
          type="button"
          className={`ui-swatch ui-swatch-none ${value === null ? 'is-active' : ''}`}
          title="No colour"
          onClick={() => onChange(null)}
        />
      )}
      {colors.map((c) => (
        <button
          type="button"
          key={c}
          title={c}
          className={`ui-swatch ${value?.toUpperCase() === c ? 'is-active' : ''}`}
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <input
        type="color"
        className="ui-swatch-custom"
        title="Custom colour"
        value={custom}
        onChange={(e) => {
          setCustom(e.target.value)
          onChange(e.target.value)
        }}
      />
    </div>
  )
}

/** Small button showing a colour that opens a ColorPicker popover. */
export function ColorButton({
  value,
  onChange,
  allowNone,
  title
}: {
  value: string | null
  onChange: (v: string | null) => void
  allowNone?: boolean
  title?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <span className="ui-color-button-wrap">
      <button
        type="button"
        className="ui-color-button"
        title={title ?? 'Colour'}
        onClick={() => setOpen((o) => !o)}
        style={{ background: value ?? 'transparent' }}
      >
        {value === null && <span className="ui-swatch-none-line" />}
      </button>
      {open && (
        <>
          <div className="ui-popover-scrim" onMouseDown={() => setOpen(false)} />
          <div className="ui-popover">
            <ColorPicker
              value={value}
              allowNone={allowNone}
              onChange={(v) => {
                onChange(v)
                setOpen(false)
              }}
            />
          </div>
        </>
      )}
    </span>
  )
}
