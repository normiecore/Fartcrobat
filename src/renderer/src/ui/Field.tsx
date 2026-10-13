import { useState, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'

export function Field({ label, children, hint, inline }: { label: ReactNode; children: ReactNode; hint?: ReactNode; inline?: boolean }) {
  return (
    <label className={`ui-field ${inline ? 'ui-field-inline' : ''}`}>
      <span className="ui-field-label">{label}</span>
      {children}
      {hint && <span className="ui-field-hint">{hint}</span>}
    </label>
  )
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="text" {...props} className={`ui-input ${props.className ?? ''}`} />
}

const numberText = (v: number) => (Number.isFinite(v) ? String(v) : '')

/**
 * Number field. While it has the focus it may be empty or hold a partial number; valid numbers
 * are passed to onChange as they are typed, and leaving the field shows the value in effect
 * (the last valid one, or what the owner made of it, e.g. clamped to a range).
 */
export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  onFocus,
  onBlur,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> & {
  value: number
  onChange: (v: number) => void
}) {
  const [draft, setDraft] = useState(() => numberText(value))
  const [focused, setFocused] = useState(false)
  const [shown, setShown] = useState(value)
  if (!Object.is(shown, value)) {
    // A new value from outside replaces the text, unless it is the number being typed.
    setShown(value)
    if (!focused && parseFloat(draft) !== value) setDraft(numberText(value))
  }
  return (
    <input
      type="number"
      className="ui-input ui-input-number"
      value={draft}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        setDraft(e.target.value)
        const v = parseFloat(e.target.value)
        if (!Number.isNaN(v)) onChange(v)
      }}
      onFocus={(e) => {
        setFocused(true)
        onFocus?.(e)
      }}
      onBlur={(e) => {
        setFocused(false)
        if (parseFloat(draft) !== value) setDraft(numberText(value))
        onBlur?.(e)
      }}
      {...rest}
    />
  )
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`ui-input ui-textarea ${props.className ?? ''}`} />
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  ...rest
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'> & {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <select className="ui-input ui-select" value={value} onChange={(e) => onChange(e.target.value as T)} {...rest}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  disabled?: boolean
}) {
  return (
    <label className={`ui-check ${disabled ? 'is-disabled' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

export function Radio({
  checked,
  onChange,
  label,
  name
}: {
  checked: boolean
  onChange: () => void
  label: ReactNode
  name: string
}) {
  return (
    <label className="ui-check">
      <input type="radio" name={name} checked={checked} onChange={() => onChange()} />
      <span>{label}</span>
    </label>
  )
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  format
}: {
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step?: number
  format?: (v: number) => string
}) {
  return (
    <span className="ui-slider">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span className="ui-slider-value">{format ? format(value) : value}</span>
    </span>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; title?: string }[]
}) {
  return (
    <div className="ui-segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          className={value === o.value ? 'is-active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
