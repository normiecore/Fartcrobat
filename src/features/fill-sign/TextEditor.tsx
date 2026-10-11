import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { showError, usePrefs, type DocumentModel, type PageGeometry } from '@renderer/sdk'
import { FIRST_BASELINE, kindLabel, LINE_HEIGHT, type FillSignItem } from './shared'
import { fsOps, hideItem, unhideItem, useFillSign, waitForRepaint } from './state'

/** The editor that currently has focus; clicking elsewhere on the page commits it first. */
let activeEditor: { id: number; commit: () => Promise<void> } | null = null

export function commitActiveEditor(): Promise<void> {
  return activeEditor ? activeEditor.commit() : Promise.resolve()
}

export const EDITOR_FONT = 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif'

let baselineShiftCache: number | null = null

/**
 * How far (in em) the browser puts the first baseline below where MuPDF puts it, for our
 * line height. Measured once from the actual font so the editor lines up with the rendered text.
 */
export function baselineShift(): number {
  if (baselineShiftCache !== null) return baselineShiftCache
  let shift = 0.1465 // Arial / Liberation Sans
  try {
    const ctx = document.createElement('canvas').getContext('2d')
    if (ctx) {
      ctx.font = `100px ${EDITOR_FONT}`
      const m = ctx.measureText('Hg')
      const asc = m.fontBoundingBoxAscent / 100
      const desc = m.fontBoundingBoxDescent / 100
      if (asc > 0 && desc >= 0) shift = (LINE_HEIGHT - (asc + desc)) / 2 + asc - FIRST_BASELINE
    }
  } catch {}
  baselineShiftCache = shift
  return shift
}

/**
 * In-place text editor for a Fill & Sign text item: a borderless textarea over the page that
 * matches the PDF text (font, size, zoom, rotation). Enter adds a line; Esc, Tab, Ctrl+Enter or
 * clicking elsewhere finishes. Empty text removes the item.
 */
export function TextEditor({ doc, geometry, item }: { doc: DocumentModel; geometry: PageGeometry; item: FillSignItem }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState(item.text)
  const [frozen, setFrozen] = useState(false)
  const valueRef = useRef(value)
  valueRef.current = value
  const itemRef = useRef(item)
  itemRef.current = item
  /** Text known to be in the document (updated when typing is written early, e.g. before A+). */
  const savedText = useRef(item.text)
  const committed = useRef(false)
  const mounted = useRef(false)
  const pageColors = usePrefs().pageColors

  // Keep the PDF rendering of this item out of the page while it is being edited.
  useEffect(() => {
    hideItem(doc, item.page, item.id)
  }, [doc, item.page, item.id])

  const commitRef = useRef<() => Promise<void>>(async () => {})
  commitRef.current = async () => {
    if (committed.current) return
    committed.current = true
    if (activeEditor?.id === item.id) activeEditor = null
    const editing = useFillSign.getState().editing
    const current = itemRef.current
    if (!editing || editing.docId !== doc.id || editing.id !== current.id) {
      // editing was ended by something else (delete, convert, undo): nothing to save
      unhideItem(doc, current.page, current.id)
      return
    }
    const text = valueRef.current.replace(/[ \t\r\n]+$/, '')
    setFrozen(true)
    try {
      if (!text.trim()) {
        const label = `Add ${kindLabel(current.kind)}`
        if (editing.isNew && editing.edits === 0 && doc.state.journal.undoLabel === label) await doc.undo()
        else await fsOps(doc).remove([current.id], current.kind, current.page)
        doc.clearSelection()
      } else if (text !== savedText.current) {
        savedText.current = text
        await fsOps(doc).setText(current.id, text, current.page)
      }
    } catch (err) {
      if ((err as { code?: string }).code !== 'NO_ANNOTATION') showError(err, 'Could not save the text')
    }
    unhideItem(doc, current.page, current.id)
    await waitForRepaint(doc)
    useFillSign.setState((s) => (s.editing && s.editing.docId === doc.id && s.editing.id === current.id ? { editing: null } : {}))
  }

  useLayoutEffect(() => {
    mounted.current = true
    committed.current = false
    activeEditor = { id: item.id, commit: () => commitRef.current() }
    const el = ref.current
    if (el) {
      el.focus({ preventScroll: true })
      const end = el.value.length
      el.setSelectionRange(end, end)
    }
    return () => {
      mounted.current = false
      if (activeEditor?.id === item.id) activeEditor = null
      // Unmounted without finishing (tool switched, page scrolled away): save what was typed.
      // Deferred so that React StrictMode's simulated remount does not commit.
      setTimeout(() => {
        if (!mounted.current && !committed.current) void commitRef.current()
      }, 0)
    }
  }, [item.id])

  /** Saves the text typed so far without closing the editor (before size/colour changes). */
  useEffect(() => {
    const onFlush = (e: Event) => {
      const detail = (e as CustomEvent<{ id: number; done: (p: Promise<unknown>) => void }>).detail
      if (detail.id !== item.id) return
      const text = valueRef.current.replace(/[ \t\r\n]+$/, '')
      if (text.trim() && text !== savedText.current) {
        const e2 = useFillSign.getState().editing
        if (e2) useFillSign.setState({ editing: { ...e2, edits: e2.edits + 1 } })
        savedText.current = text
        detail.done(fsOps(doc).setText(item.id, text, item.page))
      } else detail.done(Promise.resolve())
    }
    window.addEventListener('fc-fill-sign:flush', onFlush)
    return () => window.removeEventListener('fc-fill-sign:flush', onFlush)
  }, [doc, item.id, item.page])

  const fontPx = item.size * geometry.scale
  const origin = geometry.toCss([item.rect[0], item.rect[1]])
  const invert = pageColors !== 'document'
  return (
    <div
      className="fc-fill-sign-editor"
      style={{
        left: origin[0],
        top: origin[1],
        transform: geometry.rotation ? `rotate(${geometry.rotation}deg)` : undefined
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        className={`fc-fill-sign-textarea ${invert ? 'is-inverted' : ''} ${frozen ? 'is-frozen' : ''}`}
        aria-label="Text"
        spellCheck
        value={value}
        readOnly={frozen}
        rows={1}
        wrap="off"
        style={{
          fontFamily: EDITOR_FONT,
          fontSize: fontPx,
          lineHeight: `${LINE_HEIGHT * fontPx}px`,
          color: item.color,
          top: -baselineShift() * fontPx,
          minWidth: Math.max(8, fontPx * 0.6),
          minHeight: LINE_HEIGHT * fontPx
        }}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => void commitRef.current()}
        onKeyDown={(e) => {
          const mod = e.ctrlKey || e.metaKey
          if (e.key === 'Escape' || e.key === 'Tab' || (e.key === 'Enter' && mod)) {
            e.preventDefault()
            e.stopPropagation()
            void commitRef.current()
            ref.current?.blur()
            doc.view?.getViewportElement()?.focus({ preventScroll: true })
            return
          }
          // Shortcuts such as Save act on the document: write the text into it first.
          if (mod && !/^[acvxzy]$/i.test(e.key) && e.key.length === 1) void commitRef.current()
        }}
      />
    </div>
  )
}

/** Asks an open editor for `id` to write its text into the document; resolves when done. */
export function flushEditor(id: number): Promise<unknown> {
  let pending: Promise<unknown> = Promise.resolve()
  window.dispatchEvent(new CustomEvent('fc-fill-sign:flush', { detail: { id, done: (p: Promise<unknown>) => (pending = p) } }))
  return pending.catch((err) => showError(err, 'Could not save the text'))
}
