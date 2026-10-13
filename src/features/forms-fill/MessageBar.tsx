import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Asterisk, Info, TriangleAlert, X } from 'lucide-react'
import {
  Button,
  getActiveDoc,
  IconButton,
  registry,
  setPrefs,
  useActiveDoc,
  useApp,
  useDocState,
  type DocumentModel
} from '@renderer/sdk'
import { formController } from './controller'
import { clearForm } from './dataCommands'
import { loadFormsSettings, useFormsSettings } from './settings'

interface FormSummary {
  fillable: number
  /** Required fields that are still empty, in tab order. */
  emptyRequired: number[]
}

/** Counts fillable fields and empty required fields (refreshed when the document changes). */
function useFormSummary(doc: DocumentModel): FormSummary | null {
  const docVersion = useDocState(doc, (s) => s.docVersion)
  const [summary, setSummary] = useState<FormSummary | null>(null)
  useEffect(() => {
    let alive = true
    const ctl = formController(doc)
    ctl
      .snapshot()
      .then((snap) => {
        if (!alive) return
        const byId = new Map(snap.fields.map((f) => [f.id, f]))
        const fillable = snap.fields.filter((f) => ['text', 'checkbox', 'radio', 'combo', 'list'].includes(f.type) && !f.hidden)
        const seen = new Set<string>()
        const emptyRequired: number[] = []
        for (const id of snap.tabOrder) {
          const f = byId.get(id)
          if (!f || !f.required || f.hidden || f.readOnly || seen.has(f.name)) continue
          if (!['text', 'checkbox', 'radio', 'combo', 'list'].includes(f.type)) continue
          seen.add(f.name)
          const v = snap.values[f.name]
          const empty = Array.isArray(v) ? v.length === 0 : !v || ((f.type === 'checkbox' || f.type === 'radio') && v === 'Off')
          if (empty) emptyRequired.push(id)
        }
        setSummary({ fillable: fillable.length, emptyRequired })
      })
      .catch((err) => {
        if (alive && !doc.isClosed) console.warn('Could not read the form', err)
      })
    return () => {
      alive = false
    }
  }, [doc, docVersion])
  return summary
}

const dismissed = new Set<string>()

/** "This document contains interactive form fields." under the document toolbar. */
function MessageBar() {
  const doc = useActiveDoc()
  return doc ? <DocMessageBar key={doc.id} doc={doc} /> : null
}

function DocMessageBar({ doc }: { doc: DocumentModel }) {
  const readMode = useApp((s) => s.readMode)
  const groupId = useApp((s) => s.toolGroupId)
  const highlight = useApp((s) => s.prefs.highlightFormFields)
  const show = useFormsSettings((s) => s.showMessageBar)
  const summary = useFormSummary(doc)
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [, setTick] = useState(0)
  const docView = !!registry.toolGroups.find((g) => g.id === groupId)?.documentView

  const info = useDocState(doc, (s) => s.info)

  useLayoutEffect(() => {
    setHost(document.querySelector<HTMLElement>('.shell-docarea'))
  }, [readMode, docView])

  // While a form is being edited (Prepare a form) the fill bar would only get in the way and shift
  // the page under the pointer, as Acrobat also hides it there.
  const editingForm = groupId === 'prepareform' || groupId === 'requestsign'
  if (!host?.isConnected || readMode || docView || editingForm || !show || dismissed.has(doc.id)) return null
  if (!summary || summary.fillable === 0) return null
  const canFill = info.permissions.form !== false || info.permissions.annotate !== false
  const message = info.hasXfa
    ? 'This form uses dynamic XFA, which Fartcrobat does not support. Its static form fields are shown and can be filled in.'
    : canFill
      ? 'This document contains interactive form fields.'
      : "This document contains interactive form fields, but its security settings don't allow filling them in."
  const nextRequired = () => {
    const ctl = formController(doc)
    const active = ctl.activeEditor?.id ?? null
    const order = ctl.tabOrder
    const pos = active === null ? -1 : order.indexOf(active)
    const target = summary.emptyRequired.find((id) => order.indexOf(id) > pos) ?? summary.emptyRequired[0]
    if (target !== undefined) ctl.focusField(target)
  }
  return createPortal(
    <div className={`fc-forms-fill-msgbar ${info.hasXfa || !canFill ? 'is-warning' : ''}`} role="region" aria-label="Form message bar">
      <div className="fc-forms-fill-msgbar-main">
        {info.hasXfa || !canFill ? <TriangleAlert size={16} className="fc-forms-fill-msgbar-icon" /> : <Info size={16} className="fc-forms-fill-msgbar-icon" />}
        <span className="fc-forms-fill-msgbar-text" title={message}>
          {message}
        </span>
        {canFill && summary.emptyRequired.length > 0 && (
          <Button
            size="sm"
            variant="quiet"
            icon={Asterisk}
            className="fc-forms-fill-msgbar-required"
            onClick={nextRequired}
            title="Go to the next required field that is still empty"
          >
            {summary.emptyRequired.length === 1 ? '1 required field left' : `${summary.emptyRequired.length} required fields left`}
          </Button>
        )}
      </div>
      <div className="fc-forms-fill-msgbar-actions">
        <Button
          size="sm"
          variant="secondary"
          aria-pressed={highlight}
          className={highlight ? 'fc-forms-fill-pressed' : ''}
          onClick={() => void setPrefs({ highlightFormFields: !highlight })}
        >
          Highlight existing fields
        </Button>
        {canFill && (
          <Button size="sm" variant="secondary" onClick={() => void clearForm(doc)}>
            Clear form
          </Button>
        )}
        <IconButton
          icon={X}
          size={16}
          label="Close the message bar"
          onClick={() => {
            dismissed.add(doc.id)
            setTick((t) => t + 1)
          }}
        />
      </div>
    </div>,
    host
  )
}

/** Tab from the page moves into the form, like Acrobat. */
function useTabIntoForm() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (!t?.classList?.contains('viewer-scroll')) return
      const doc = getActiveDoc()
      if (!doc || useApp.getState().dialogs.length) return
      if (formController(doc).focusFirst(e.shiftKey ? -1 : 1)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

export function FormsGlobal() {
  useEffect(() => {
    void loadFormsSettings()
  }, [])
  useTabIntoForm()
  return <MessageBar />
}
