import { useId, type ReactNode } from 'react'

/**
 * Like the UI kit's Field, but for button groups (Segmented): a <label> around buttons would
 * give the first button the whole group's text as its accessible name.
 */
export function FieldGroup({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <div className="ui-field" role="group" aria-labelledby={id}>
      <span className="ui-field-label" id={id}>
        {label}
      </span>
      {children}
      {hint && <span className="ui-field-hint">{hint}</span>}
    </div>
  )
}
