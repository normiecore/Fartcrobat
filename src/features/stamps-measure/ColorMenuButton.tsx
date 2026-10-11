import { useState } from 'react'
import { ColorPicker, FloatingAt } from '@renderer/sdk'

/**
 * A colour swatch button whose picker floats above everything (the UI kit's ColorButton popover
 * would be clipped inside the scrolling contextual toolbar).
 */
export function ColorMenuButton({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <button
        type="button"
        className="ui-color-button fc-stamps-measure-color"
        style={{ background: value }}
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={!!at}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAt(at ? null : { x: r.left, y: r.bottom + 6 })
        }}
      />
      {at && (
        <FloatingAt x={at.x} y={at.y} onClose={() => setAt(null)}>
          <div
            className="fc-stamps-measure-color-pop"
            role="dialog"
            aria-label={label}
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.stopPropagation()
            }}
          >
            <ColorPicker
              value={value}
              onChange={(c) => {
                if (c) onChange(c)
                setAt(null)
              }}
            />
          </div>
        </FloatingAt>
      )}
    </>
  )
}
