import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { setTool, type DocumentModel, type PageGeometry } from '@renderer/sdk'
import type { PFField } from '../model'
import { enterFormEditing, renameField, updateFields } from './actions'
import { openProperties } from './PropertiesDialog'
import { usePF } from './state'

/**
 * Acrobat's small name box under a field that was just placed: field name, "Required field" and
 * "All properties". For radio buttons: the button's choice, the group name and "Add another button".
 */
export function InlineNameBox({ doc, field, geometry }: { doc: DocumentModel; field: PFField; geometry: PageGeometry }) {
  const radio = field.type === 'radio'
  const [name, setName] = useState(field.name)
  const [choice, setChoice] = useState(field.exportValue)
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const committed = useRef(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    setName(field.name)
    setChoice(field.exportValue)
    committed.current = false
  }, [field.id, field.name, field.exportValue])

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    el.select()
  }, [field.id])

  // place it under the field, or above when there is no room, and keep it on the page
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!el) return
    const r = geometry.rectToCss(field.rect)
    const w = el.offsetWidth
    const h = el.offsetHeight
    let top = r.top + r.height + 6
    if (top + h > geometry.cssHeight - 4) top = Math.max(4, r.top - h - 6)
    const left = Math.max(4, Math.min(geometry.cssWidth - w - 4, r.left))
    setPos({ left, top })
  }, [field.rect, geometry, radio])

  // bring the box into view (fields near the bottom of the window)
  useEffect(() => {
    const el = boxRef.current
    if (!pos || !el) return
    const box = geometry.cssToRect({ left: pos.left, top: pos.top, width: el.offsetWidth, height: el.offsetHeight })
    const f = geometry.rectToCss(field.rect)
    const both = geometry.cssToRect({
      left: Math.min(pos.left, f.left),
      top: Math.min(pos.top, f.top),
      width: Math.max(pos.left + el.offsetWidth, f.left + f.width) - Math.min(pos.left, f.left),
      height: Math.max(pos.top + el.offsetHeight, f.top + f.height) - Math.min(pos.top, f.top)
    })
    doc.view?.scrollToRect(field.page, both.every(Number.isFinite) ? both : box)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos === null, field.id])

  // only close the box of this field: another field may have been placed while a rename was saving
  const close = () => usePF.setState((s) => (s.inline?.id === field.id && s.inline.docId === doc.id ? { inline: null } : {}))

  // latest values, so a click elsewhere (which closes the box) still applies the typed name
  const latest = useRef({ name, choice, field })
  latest.current = { name, choice, field }

  const apply = async (): Promise<boolean> => {
    const { name: n0, choice: c0, field: f } = latest.current
    if (f.type === 'radio' && c0.trim() && c0.trim() !== f.exportValue) {
      if (!(await updateFields(doc, [f.id], { exportValue: c0.trim() }))) return false
    }
    const n = n0.trim()
    if (n && n !== f.name) return renameField(doc, f.id, n)
    return true
  }

  const commit = async () => {
    if (committed.current) return
    committed.current = true
    if (!(await apply())) {
      committed.current = false
      inputRef.current?.focus()
      return
    }
    close()
  }

  useEffect(
    () => () => {
      if (!committed.current) {
        committed.current = true
        void apply()
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [field.id]
  )

  return (
    <div
      ref={boxRef}
      className="fc-prepare-form-inline"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? 0 }}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void commit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          committed.current = true
          close()
        }
      }}
      role="dialog"
      aria-label="Field name"
    >
      <button className="fc-prepare-form-inline-close" aria-label="Close" title="Close" onClick={close}>
        <X size={14} />
      </button>
      {radio && (
        <label className="fc-prepare-form-inline-row">
          <span>Radio button choice</span>
          <input className="ui-input" value={choice} onChange={(e) => setChoice(e.target.value)} />
        </label>
      )}
      <label className="fc-prepare-form-inline-row">
        <span>{radio ? 'Group name' : 'Field name'}</span>
        <input ref={inputRef} className="ui-input" value={name} onChange={(e) => setName(e.target.value)} aria-label={radio ? 'Group name' : 'Field name'} />
      </label>
      <label className="ui-check">
        <input type="checkbox" checked={field.required} onChange={(e) => void updateFields(doc, [field.id], { required: e.target.checked })} />
        <span>Required field</span>
      </label>
      <div className="fc-prepare-form-inline-links">
        <button
          className="fc-prepare-form-link"
          onClick={async () => {
            await commit()
            openProperties(doc, [field.id])
          }}
        >
          All properties
        </button>
        {radio && (
          <button
            className="fc-prepare-form-link"
            onClick={async () => {
              await commit()
              usePF.setState({ radioGroup: name.trim() || field.name })
              enterFormEditing('form.radio')
              setTool('form.radio')
            }}
          >
            Add another button
          </button>
        )}
      </div>
    </div>
  )
}
