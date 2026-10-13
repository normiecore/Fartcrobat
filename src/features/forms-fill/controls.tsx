import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, PenLine, ShieldCheck } from 'lucide-react'
import type { FieldInfo } from '@engine/ops/forms'
import { openRightPanel, openToolGroup, registry, runCommand, showError, toast, useApp, type DocumentModel } from '@renderer/sdk'
import type { WidgetExtra } from './engine'
import type { FormController } from './controller'
import type { FieldBox } from './FieldLayer'
import { useFormsSettings } from './settings'

export interface ControlProps {
  doc: DocumentModel
  ctl: FormController
  field: FieldInfo
  extra: WidgetExtra | undefined
  box: FieldBox
  readOnly: boolean
  /** Text fields: the formatted text shown while the field is not being edited ("$1,234.50"). */
  display?: string
}

// ---- helpers --------------------------------------------------------------------------------

const SANS = 'Helvetica, Arial, "Liberation Sans", sans-serif'
const SERIF = '"Times New Roman", Times, "Liberation Serif", serif'
const MONO = '"Courier New", Courier, "Liberation Mono", monospace'

export function fontFamily(name: string): string {
  const n = name.toLowerCase()
  if (/^(tiro|tibo|tiit|tibi|times)/.test(n) || n.includes('times') || n.includes('serif')) return SERIF
  if (/^(cour|cobo|coob|cobi)/.test(n) || n.includes('courier') || n.includes('mono')) return MONO
  return SANS
}

let measureCanvas: HTMLCanvasElement | null = null

function textWidth(text: string, px: number, family: string): number {
  measureCanvas ??= document.createElement('canvas')
  const ctx = measureCanvas.getContext('2d')
  if (!ctx) return text.length * px * 0.5
  ctx.font = `${px}px ${family}`
  return ctx.measureText(text).width
}

/** Font size in CSS pixels: the /DA size scaled by zoom, or Acrobat-like auto sizing for 0. */
function fontPx(field: FieldInfo, box: FieldBox, text: string, family: string): number {
  const pad = 4 * box.scale
  if (field.fontSize > 0) return Math.max(1, field.fontSize * box.scale)
  if (field.multiline) return Math.max(1, 12 * box.scale)
  let px = Math.max(4 * box.scale, Math.min((box.height - pad) / 1.15, 24 * box.scale))
  const available = box.width - pad
  const w = text ? textWidth(text, px, family) : 0
  if (w > available && w > 0) px = Math.max(4 * box.scale, (px * available) / w)
  return px
}

function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255]
}

/** Two colours multiplied (how the field highlight blends with the field background). */
function multiplyColors(a: string, b: string): string {
  const x = hexRgb(a)
  const y = hexRgb(b)
  return `rgb(${x.map((v, i) => Math.round((v * y[i]) / 255)).join(', ')})`
}

function labelOf(field: FieldInfo): string {
  return field.tooltip || field.name
}

function useRegister(ctl: FormController, id: number, ref: RefObject<HTMLElement | null>, select = false) {
  useEffect(() => {
    const el = ref.current
    const handle = {
      element: el,
      focus: () => {
        if (!el) return
        el.focus({ preventScroll: true })
        if (select && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select()
      }
    }
    ctl.controls.set(id, handle)
    if (ctl.pendingFocus === id) {
      ctl.pendingFocus = null
      requestAnimationFrame(() => handle.focus())
    }
    return () => {
      if (ctl.controls.get(id) === handle) ctl.controls.delete(id)
    }
  }, [ctl, id, ref, select])
}

/** Tab / Shift+Tab: move to the next field in tab order. */
function handleTab(e: KeyboardEvent, ctl: FormController, id: number, before?: () => void): boolean {
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return false
  e.preventDefault()
  e.stopPropagation()
  before?.()
  ctl.focusNext(id, e.shiftKey ? -1 : 1)
  return true
}

function leaveField(doc: DocumentModel) {
  ;(document.activeElement as HTMLElement | null)?.blur?.()
  doc.view?.getViewportElement()?.focus({ preventScroll: true })
}

function classes(base: string, flags: Record<string, boolean | undefined>): string {
  return [base, ...Object.entries(flags).filter(([, v]) => v).map(([k]) => k)].join(' ')
}

const EDIT_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y'])

// ---- text -----------------------------------------------------------------------------------

export function TextControl({ doc, ctl, field, extra, box, readOnly, display }: ControlProps) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null)
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState(field.value)
  const [pending, setPending] = useState<string | null>(null)
  const draftRef = useRef(field.value)
  const originalRef = useRef(field.value)
  const dirtyRef = useRef(false)
  const fieldRef = useRef(field)
  /** Raw value of the last commit while its new appearance is being drawn. */
  const pendingRawRef = useRef<string | null>(null)
  const highlight = useApp((st) => st.prefs.highlightFormFields)
  const inverted = useApp((st) => st.prefs.pageColors !== 'document')
  const highlightColor = useFormsSettings((st) => st.highlightColor)
  const markedDirtyRef = useRef(false)
  const caretRef = useRef<number | null>(null)
  fieldRef.current = field
  useRegister(ctl, field.id, ref, true)

  const setText = (v: string) => {
    draftRef.current = v
    setDraft(v)
  }

  // Follow the document while the user is not editing.
  useEffect(() => {
    if (!focused && !dirtyRef.current) {
      draftRef.current = field.value
      setDraft(field.value)
      originalRef.current = field.value
    }
  }, [field.value, focused])

  // After a commit the page re-renders; keep showing the new text until the new appearance is
  // drawn: shortly after the layer has the new value (the page was re-rendered at the same time).
  useEffect(() => {
    if (pending === null) return
    const arrived = field.value === pendingRawRef.current
    const t = setTimeout(() => setPending(null), arrived ? 200 : 3000)
    return () => clearTimeout(t)
  }, [field.value, pending])

  useLayoutEffect(() => {
    if (caretRef.current !== null && ref.current) {
      ref.current.setSelectionRange(caretRef.current, caretRef.current)
      caretRef.current = null
    }
  }, [draft])

  const commit = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true
    dirtyRef.current = false
    const f = fieldRef.current
    const raw = draftRef.current
    try {
      const r = await ctl.commitText(f, raw)
      if (!r.ok) {
        draftRef.current = originalRef.current
        setDraft(originalRef.current)
        ctl.focusField(f.id)
        return false
      }
      originalRef.current = raw
      markedDirtyRef.current = false
      if (document.activeElement !== ref.current) {
        pendingRawRef.current = raw
        setPending(f.password ? '*'.repeat(Math.min(raw.length, 64)) : r.display)
      }
      return true
    } catch (err) {
      if (!doc.isClosed) showError(err, `Could not fill in “${labelOf(f)}”`)
      return false
    }
  }, [ctl, doc])

  // Commit what was typed when the control goes away (page scrolled out, layer unmounted).
  useEffect(
    () => () => {
      if (dirtyRef.current && !doc.isClosed) void commit()
      if (ctl.activeEditor?.id === fieldRef.current.id) ctl.activeEditor = null
    },
    [ctl, doc, commit]
  )

  const multiline = field.multiline
  const comb = field.comb && field.maxLen > 0 && !multiline && !field.password
  const family = comb ? MONO : fontFamily(field.fontName)
  // Editing shows the raw value; otherwise the formatted text, like the field's appearance.
  const shown = focused ? draft : (pending ?? (dirtyRef.current || display === undefined ? draft : display))
  let fs = fontPx(field, box, shown, family)
  const style: CSSProperties = {
    ...box.style,
    fontFamily: family,
    textAlign: (['left', 'center', 'right'] as const)[field.alignment] ?? 'left',
    padding: multiline ? `${2 * box.scale}px ${2 * box.scale}px` : `0 ${2 * box.scale}px`,
    '--fc-forms-fill-text': field.textColor
  } as CSSProperties
  if (!focused && pending !== null && !inverted) {
    // Look like the new appearance (background, highlight, border) while it is being drawn.
    const bg = multiplyColors(field.backgroundColor ?? '#ffffff', highlight && !readOnly ? highlightColor : '#ffffff')
    Object.assign(style, {
      '--fc-forms-fill-pending-bg': bg,
      '--fc-forms-fill-pending-border': field.borderColor ?? 'transparent',
      '--fc-forms-fill-pending-bw': `${Math.max(1, box.scale)}px`
    })
  }
  if (comb) {
    const cell = box.width / field.maxLen
    fs = Math.min(fs, (cell / 0.6) * 0.9, box.height * 0.85)
    const charW = 0.6 * fs
    style.letterSpacing = `${cell - charW}px`
    style.paddingLeft = `${(cell - charW) / 2}px`
    style.paddingRight = 0
    style.textAlign = 'left'
  }
  style.fontSize = `${fs}px`
  if (!multiline) style.lineHeight = `${Math.max(1, box.height - 2)}px`

  const onChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const el = e.target
    const next = el.value
    const prev = draftRef.current
    let start = 0
    while (start < prev.length && start < next.length && prev[start] === next[start]) start++
    let endPrev = prev.length
    let endNext = next.length
    while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
      endPrev--
      endNext--
    }
    const change = next.slice(start, endNext)
    const k = ctl.keystroke(fieldRef.current, { value: prev, change, selStart: start, selEnd: endPrev })
    let value = prev.slice(0, start) + k.change + prev.slice(endPrev)
    if (!k.rc) value = prev
    if (field.maxLen > 0 && value.length > field.maxLen && value.length > prev.length) value = prev
    if (extra?.doNotScroll && !multiline && value.length > prev.length) {
      if (textWidth(value, fs, family) > box.width - 4 * box.scale) value = prev
    }
    if (value === prev) {
      // Rejected: undo what the browser already changed in the box.
      el.value = prev
      el.setSelectionRange(start, start)
      return
    }
    if (value !== next) caretRef.current = start + k.change.length
    setText(value)
    dirtyRef.current = value !== originalRef.current
    if (dirtyRef.current && !doc.state.dirty) {
      doc.set({ dirty: true })
      markedDirtyRef.current = true
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (handleTab(e, ctl, field.id, () => void commit())) return
    if (e.key === 'Enter' && !multiline && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      void commit()
      ctl.focusNext(field.id, 1)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      dirtyRef.current = false
      setText(originalRef.current)
      if (markedDirtyRef.current) {
        markedDirtyRef.current = false
        void doc.core.doc.isDirty().then((d) => doc.set({ dirty: d })).catch(() => {})
      }
      leaveField(doc)
      return
    }
    if ((e.ctrlKey || e.metaKey) && e.key.length === 1 && !EDIT_KEYS.has(e.key.toLowerCase())) void commit()
  }

  const common = {
    'aria-label': labelOf(field),
    'aria-required': field.required || undefined,
    'aria-readonly': readOnly || undefined,
    'data-field-name': field.name,
    title: field.tooltip || undefined,
    readOnly,
    tabIndex: readOnly ? -1 : 0,
    spellCheck: !field.doNotSpellCheck,
    maxLength: field.maxLen > 0 ? field.maxLen : undefined,
    className: classes('fc-forms-fill-field fc-forms-fill-text', {
      'is-active': focused,
      'is-pending': !focused && pending !== null,
      'is-required': field.required,
      'is-readonly': readOnly,
      'is-comb': comb
    }),
    style,
    value: shown,
    onChange,
    onKeyDown,
    onFocus: () => {
      if (readOnly) return
      setFocused(true)
      setPending(null)
      if (!dirtyRef.current) originalRef.current = fieldRef.current.value
      ctl.prepare()
      ctl.activeEditor = { id: field.id, flush: () => void commit() }
    },
    onBlur: () => {
      setFocused(false)
      if (ctl.activeEditor?.id === field.id) ctl.activeEditor = null
      void commit()
    }
  }
  if (multiline) return <textarea ref={ref} {...common} />
  return <input ref={ref} type={field.password ? 'password' : 'text'} autoComplete="off" {...common} />
}

// ---- check boxes and radio buttons ------------------------------------------------------------

export function CheckControl({ doc, ctl, field, extra, box, readOnly }: ControlProps) {
  const ref = useRef<HTMLButtonElement>(null)
  useRegister(ctl, field.id, ref)
  const radio = field.type === 'radio'
  const toggle = () => {
    if (readOnly) return
    ctl.toggle(field, extra).catch((err) => showError(err, `Could not change “${labelOf(field)}”`))
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (handleTab(e, ctl, field.id)) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      leaveField(doc)
      return
    }
    if (radio && ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(e.key)) {
      e.preventDefault()
      e.stopPropagation()
      const group = ctl.tabOrder.filter((id) => {
        const f = ctl.fieldsById.get(id)
        return f && f.name === field.name && !f.hidden
      })
      const i = group.indexOf(field.id)
      if (i < 0 || group.length < 2) return
      const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1
      const nextId = group[(i + dir + group.length) % group.length]
      const next = ctl.fieldsById.get(nextId)
      ctl.focusField(nextId)
      if (next && !readOnly) ctl.toggle({ ...next, checked: false }, ctl.extras.get(nextId)).catch((err) => showError(err))
    }
  }
  return (
    <button
      ref={ref}
      type="button"
      role={radio ? 'radio' : 'checkbox'}
      aria-checked={field.checked}
      aria-label={labelOf(field) + (radio && field.onState ? `: ${field.onState}` : '')}
      aria-required={field.required || undefined}
      aria-readonly={readOnly || undefined}
      data-field-name={field.name}
      data-on-state={field.onState ?? undefined}
      title={field.tooltip || undefined}
      tabIndex={readOnly ? -1 : 0}
      className={classes('fc-forms-fill-field fc-forms-fill-check', {
        'is-radio': radio,
        'is-required': field.required,
        'is-readonly': readOnly
      })}
      style={box.style}
      onClick={toggle}
      onFocus={() => ctl.prepare()}
      onKeyDown={onKeyDown}
    />
  )
}

// ---- push buttons ---------------------------------------------------------------------------------

export function ButtonControl({ doc, ctl, field, extra, box }: ControlProps) {
  const ref = useRef<HTMLButtonElement>(null)
  useRegister(ctl, field.id, ref)
  const action = extra?.action ?? null
  return (
    <button
      ref={ref}
      type="button"
      aria-label={labelOf(field)}
      data-field-name={field.name}
      title={field.tooltip || undefined}
      className={classes('fc-forms-fill-field fc-forms-fill-button', { 'has-action': !!action })}
      style={box.style}
      onClick={() => void ctl.runButton(field, action)}
      onKeyDown={(e) => {
        if (handleTab(e, ctl, field.id)) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          leaveField(doc)
        }
      }}
    />
  )
}

// ---- signature fields -------------------------------------------------------------------------------

export function SignatureControl({ doc, ctl, field, extra, box, readOnly }: ControlProps) {
  const ref = useRef<HTMLButtonElement>(null)
  useRegister(ctl, field.id, ref)
  const signed = field.signed
  const title = signed
    ? `Signed by ${extra?.signer || 'an unknown signer'}${extra?.signedAt ? ` on ${new Date(extra.signedAt).toLocaleString()}` : ''} — see Signatures panel`
    : field.tooltip
      ? `${field.tooltip} — click to sign`
      : 'Signature field — click to sign'
  const onClick = () => {
    if (signed) {
      if (registry.rightPanels.some((p) => p.id === 'signatures')) openRightPanel('signatures')
      else toast(`Signed by ${extra?.signer || 'an unknown signer'}.`)
      return
    }
    if (readOnly) {
      toast('This signature field is locked.')
      return
    }
    window.dispatchEvent(
      new CustomEvent('fartcrobat:sign-field', {
        detail: { docId: doc.id, fieldId: field.id, fieldName: field.name, page: field.page, rect: field.rect }
      })
    )
    // The digital-signatures feature listens for the event and starts certificate signing.
    if (registry.features.some((f) => f.id === 'digital-signatures')) return
    const fillSign = registry.toolGroups.some((g) => g.id === 'fillsign')
    toast('Signing with a digital ID is not available in this version of Fartcrobat.', {
      kind: 'warning',
      action: fillSign
        ? {
            label: 'Fill & Sign instead',
            run: () => {
              openToolGroup('fillsign')
              if (registry.commands.has('fillsign.signYourself')) void runCommand('fillsign.signYourself')
            }
          }
        : undefined
    })
  }
  const Icon = signed ? ShieldCheck : PenLine
  return (
    <button
      ref={ref}
      type="button"
      aria-label={signed ? title : `Sign: ${labelOf(field)}`}
      data-field-name={field.name}
      title={title}
      className={classes('fc-forms-fill-field fc-forms-fill-signature', { 'is-signed': signed, 'is-required': field.required })}
      style={box.style}
      onClick={onClick}
      onKeyDown={(e) => {
        if (handleTab(e, ctl, field.id)) return
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          leaveField(doc)
        }
      }}
    >
      {!signed && box.height > 14 && box.width > 60 && (
        <span className="fc-forms-fill-sign-hint" style={{ fontSize: Math.max(10, Math.min(13, box.height * 0.3)) }}>
          <Icon size={Math.max(10, Math.min(16, box.height * 0.35))} />
          Click to sign
        </span>
      )}
    </button>
  )
}

// ---- combo boxes ------------------------------------------------------------------------------------

export function ComboControl(props: ControlProps) {
  return props.field.editable ? <EditableCombo {...props} /> : <SelectCombo {...props} />
}

function chevronSize(box: FieldBox) {
  return Math.max(8, Math.min(18, box.height * 0.6))
}

function SelectCombo({ doc, ctl, field, box, readOnly }: ControlProps) {
  const ref = useRef<HTMLSelectElement>(null)
  const [focused, setFocused] = useState(false)
  useRegister(ctl, field.id, ref)
  const family = fontFamily(field.fontName)
  const fs = fontPx({ ...field, fontSize: field.fontSize || 0 }, box, '', family)
  const known = field.options.some((o) => o.value === field.value)
  return (
    <div
      className={classes('fc-forms-fill-field fc-forms-fill-combo', { 'is-active': focused, 'is-required': field.required, 'is-readonly': readOnly })}
      style={box.style}
      title={field.tooltip || undefined}
    >
      <select
        ref={ref}
        aria-label={labelOf(field)}
        aria-required={field.required || undefined}
        data-field-name={field.name}
        disabled={readOnly}
        value={field.value}
        style={{ fontSize: fs, fontFamily: family, '--fc-forms-fill-text': field.textColor, paddingLeft: 2 * box.scale } as CSSProperties}
        onChange={(e) => {
          ctl.setChoice(field, e.target.value).catch((err) => showError(err, `Could not change “${labelOf(field)}”`))
        }}
        onFocus={() => {
          setFocused(true)
          ctl.prepare()
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (handleTab(e, ctl, field.id)) return
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            leaveField(doc)
          }
        }}
      >
        {!known && <option value={field.value}>{field.value}</option>}
        {field.options.map((o, i) => (
          <option key={`${i}:${o.value}`} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {!readOnly && <ChevronDown className="fc-forms-fill-chevron" size={chevronSize(box)} aria-hidden />}
    </div>
  )
}

function EditableCombo({ doc, ctl, field, box, readOnly }: ControlProps) {
  const ref = useRef<HTMLInputElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const labelFor = (v: string) => field.options.find((o) => o.value === v)?.label ?? v
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState(labelFor(field.value))
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null)
  const dirtyRef = useRef(false)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const fieldRef = useRef(field)
  fieldRef.current = field
  useRegister(ctl, field.id, ref, true)

  useEffect(() => {
    if (!focused && !dirtyRef.current) setDraft(field.options.find((o) => o.value === field.value)?.label ?? field.value)
  }, [field.value, field.options, focused])

  const commit = useCallback(
    async (text?: string) => {
      const t = text ?? draftRef.current
      dirtyRef.current = false
      const f = fieldRef.current
      const opt = f.options.find((o) => o.label === t) ?? f.options.find((o) => o.label.toLowerCase() === t.toLowerCase())
      const value = opt ? opt.value : t
      try {
        const ok = await ctl.setChoice(f, value)
        if (!ok) setDraft(f.options.find((o) => o.value === f.value)?.label ?? f.value)
      } catch (err) {
        showError(err, `Could not change “${labelOf(f)}”`)
      }
    },
    [ctl]
  )

  useEffect(
    () => () => {
      if (dirtyRef.current && !doc.isClosed) void commit()
    },
    [commit, doc]
  )

  const openList = () => {
    const r = wrapRef.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom - 8
    const above = r.top - 8
    const maxHeight = Math.max(120, Math.min(260, Math.max(below, above)))
    const top = below >= Math.min(maxHeight, 160) || below >= above ? r.bottom + 2 : r.top - 2 - maxHeight
    setPos({ left: r.left, top, width: Math.max(r.width, 140), maxHeight })
    const i = field.options.findIndex((o) => o.label === draftRef.current)
    setActive(i)
    setOpen(true)
  }

  // Close the list when the document scrolls.
  useEffect(() => {
    if (!open) return
    const vp = doc.view?.getViewportElement()
    const close = () => setOpen(false)
    vp?.addEventListener('scroll', close)
    window.addEventListener('resize', close)
    return () => {
      vp?.removeEventListener('scroll', close)
      window.removeEventListener('resize', close)
    }
  }, [open, doc])

  const choose = (i: number) => {
    const o = field.options[i]
    if (!o) return
    setDraft(o.label)
    setOpen(false)
    void commit(o.label)
  }

  const family = fontFamily(field.fontName)
  const fs = fontPx(field, box, draft, family)
  const listId = `fc-forms-fill-list-${field.id}`
  return (
    <div
      ref={wrapRef}
      className={classes('fc-forms-fill-field fc-forms-fill-combo is-editable', { 'is-active': focused, 'is-required': field.required, 'is-readonly': readOnly })}
      style={box.style}
      title={field.tooltip || undefined}
    >
      <input
        ref={ref}
        role="combobox"
        aria-label={labelOf(field)}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        data-field-name={field.name}
        readOnly={readOnly}
        tabIndex={readOnly ? -1 : 0}
        autoComplete="off"
        value={draft}
        style={{ fontSize: fs, fontFamily: family, '--fc-forms-fill-text': field.textColor, paddingLeft: 2 * box.scale } as CSSProperties}
        onChange={(e) => {
          const v = e.target.value
          setDraft(v)
          dirtyRef.current = true
          if (!doc.state.dirty) doc.set({ dirty: true })
          const i = field.options.findIndex((o) => v && o.label.toLowerCase().startsWith(v.toLowerCase()))
          setActive(i)
        }}
        onFocus={() => {
          if (readOnly) return
          setFocused(true)
          ctl.prepare()
          ctl.activeEditor = { id: field.id, flush: () => dirtyRef.current && void commit() }
        }}
        onBlur={() => {
          setFocused(false)
          setOpen(false)
          if (ctl.activeEditor?.id === field.id) ctl.activeEditor = null
          if (dirtyRef.current) void commit()
        }}
        onKeyDown={(e) => {
          if (handleTab(e, ctl, field.id, () => dirtyRef.current && void commit())) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open) openList()
            else setActive((a) => Math.max(0, Math.min(field.options.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))))
            return
          }
          if (e.key === 'Enter') {
            e.preventDefault()
            if (open && active >= 0) choose(active)
            else {
              setOpen(false)
              void commit()
              ctl.focusNext(field.id, 1)
            }
            return
          }
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            if (open) setOpen(false)
            else {
              dirtyRef.current = false
              setDraft(labelFor(field.value))
              leaveField(doc)
            }
          }
        }}
      />
      {!readOnly && (
        <button
          type="button"
          tabIndex={-1}
          className="fc-forms-fill-combo-toggle"
          aria-label={`Show choices for ${labelOf(field)}`}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            ref.current?.focus({ preventScroll: true })
            if (open) setOpen(false)
            else openList()
          }}
        >
          <ChevronDown size={chevronSize(box)} />
        </button>
      )}
      {open &&
        pos &&
        createPortal(
          <div
            id={listId}
            role="listbox"
            className="fc-forms-fill-dropdown"
            style={{ left: pos.left, top: pos.top, minWidth: pos.width, maxHeight: pos.maxHeight }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {field.options.map((o, i) => (
              <div
                key={`${i}:${o.value}`}
                role="option"
                aria-selected={o.label === draft}
                className={classes('fc-forms-fill-dropdown-item', { 'is-active': i === active, 'is-selected': o.label === draft })}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                {o.label}
              </div>
            ))}
            {!field.options.length && <div className="fc-forms-fill-dropdown-empty">No choices — type a value</div>}
          </div>,
          document.body
        )}
    </div>
  )
}

// ---- list boxes -----------------------------------------------------------------------------------

export function ListControl({ doc, ctl, field, extra, box, readOnly }: ControlProps) {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const multi = field.multiSelect
  const committed = extra?.selected ?? (field.value ? [field.value] : [])
  const [focused, setFocused] = useState(false)
  const [selected, setSelected] = useState<string[]>(committed)
  const [cursor, setCursor] = useState(() => Math.max(0, field.options.findIndex((o) => committed.includes(o.value))))
  const anchorRef = useRef(cursor)
  const dirtyRef = useRef(false)
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const fieldRef = useRef(field)
  fieldRef.current = field
  useRegister(ctl, field.id, ref)
  const committedKey = committed.join('\u0000')

  useEffect(() => {
    if (!focused && !dirtyRef.current) setSelected(committedKey ? committedKey.split('\u0000') : [])
  }, [committedKey, focused])

  const commit = useCallback(async () => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    const f = fieldRef.current
    const values = selectedRef.current
    try {
      await ctl.setChoice(f, f.multiSelect ? values : (values[0] ?? ''))
    } catch (err) {
      showError(err, `Could not change “${labelOf(f)}”`)
    }
  }, [ctl])

  useEffect(
    () => () => {
      if (dirtyRef.current && !doc.isClosed) void commit()
    },
    [commit, doc]
  )

  const sizePt = field.fontSize > 0 ? field.fontSize : 12
  const fs = sizePt * box.scale
  const lh = sizePt * 1.25 * box.scale
  const inset = 1 * box.scale

  // Show the first visible item like the appearance does.
  useLayoutEffect(() => {
    if (listRef.current && !focused) listRef.current.scrollTop = (extra?.topIndex ?? 0) * lh
  }, [extra?.topIndex, lh, focused])

  const select = (i: number, mode: 'single' | 'toggle' | 'range', commitNow: boolean) => {
    const o = field.options[i]
    if (!o || readOnly) return
    let next: string[]
    if (!multi || mode === 'single') next = [o.value]
    else if (mode === 'toggle') next = selected.includes(o.value) ? selected.filter((v) => v !== o.value) : [...selected, o.value]
    else {
      const [a, b] = [Math.min(anchorRef.current, i), Math.max(anchorRef.current, i)]
      next = field.options.slice(a, b + 1).map((x) => x.value)
    }
    if (mode !== 'range') anchorRef.current = i
    setCursor(i)
    setSelected(next)
    selectedRef.current = next
    dirtyRef.current = true
    if (!doc.state.dirty) doc.set({ dirty: true })
    if (commitNow) void commit()
    const item = listRef.current?.children[i] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (handleTab(e, ctl, field.id, () => void commit())) return
    const n = field.options.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      e.stopPropagation()
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : Math.max(0, Math.min(n - 1, cursor + (e.key === 'ArrowDown' ? 1 : -1)))
      if (multi && (e.ctrlKey || e.metaKey)) {
        setCursor(next)
        ;(listRef.current?.children[next] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
      } else select(next, multi && e.shiftKey ? 'range' : 'single', false)
      return
    }
    if (e.key === ' ') {
      // Space selects (or toggles in a multiple-selection list); never the temporary hand tool.
      e.preventDefault()
      e.stopPropagation()
      select(cursor, multi ? 'toggle' : 'single', false)
      return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && n) {
      // Type-ahead: jump to the next item starting with the typed letter.
      const ch = e.key.toLowerCase()
      for (let k = 1; k <= n; k++) {
        const i = (cursor + k) % n
        if (field.options[i].label.toLowerCase().startsWith(ch)) {
          e.preventDefault()
          e.stopPropagation()
          if (multi) {
            setCursor(i)
            ;(listRef.current?.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
          } else select(i, 'single', false)
          break
        }
      }
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      dirtyRef.current = false
      setSelected(committed)
      leaveField(doc)
    }
  }

  return (
    <div
      ref={ref}
      role="listbox"
      aria-label={labelOf(field)}
      aria-multiselectable={multi || undefined}
      aria-required={field.required || undefined}
      aria-readonly={readOnly || undefined}
      aria-activedescendant={focused ? `fc-forms-fill-opt-${field.id}-${cursor}` : undefined}
      data-field-name={field.name}
      title={field.tooltip || undefined}
      tabIndex={readOnly ? -1 : 0}
      className={classes('fc-forms-fill-field fc-forms-fill-list', { 'is-active': focused, 'is-required': field.required, 'is-readonly': readOnly })}
      style={box.style}
      onFocus={() => {
        setFocused(true)
        ctl.prepare()
        ctl.activeEditor = { id: field.id, flush: () => void commit() }
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setFocused(false)
        if (ctl.activeEditor?.id === field.id) ctl.activeEditor = null
        void commit()
      }}
      onKeyDown={onKeyDown}
    >
      <div
        ref={listRef}
        className="fc-forms-fill-list-items"
        style={{ fontSize: fs, fontFamily: fontFamily(field.fontName), paddingTop: inset, '--fc-forms-fill-text': field.textColor } as CSSProperties}
      >
        {field.options.map((o, i) => (
          <div
            key={`${i}:${o.value}`}
            id={`fc-forms-fill-opt-${field.id}-${i}`}
            role="option"
            aria-selected={selected.includes(o.value)}
            className={classes('fc-forms-fill-list-item', { 'is-selected': selected.includes(o.value), 'is-cursor': focused && i === cursor })}
            style={{ height: lh, lineHeight: `${lh}px`, paddingLeft: 2 * box.scale + inset }}
            onPointerDown={(e) => {
              if (e.button !== 0 || readOnly) return
              const mode = multi && (e.ctrlKey || e.metaKey) ? 'toggle' : multi && e.shiftKey ? 'range' : 'single'
              select(i, mode, !multi)
            }}
          >
            {o.label}
          </div>
        ))}
      </div>
    </div>
  )
}
