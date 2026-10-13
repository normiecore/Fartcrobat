import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { showError, usePrefs, type DocumentModel, type PageGeometry } from '@renderer/sdk'
import { FIRST_BASELINE, isDraftId, LINE_HEIGHT, SELECTION_TYPE, type FillSignItem } from './shared'
import { fsOps, hideItem, selectItem, trackDraftCommit, unhideItem, useFillSign, waitForRepaint } from './state'

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
 * matches the PDF text (font, size, letter spacing, zoom, rotation). Enter adds a line; Esc, Tab,
 * Ctrl+Enter or clicking elsewhere finishes. New text (a draft) is added to the document when the
 * typing is finished; empty text adds nothing, or removes an existing item.
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
    if (!isDraftId(item.id)) hideItem(doc, item.page, item.id)
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
    if (doc.isClosed) return
    const text = valueRef.current.replace(/[ \t\r\n]+$/, '')
    setFrozen(true)
    if (editing.draft) {
      const draft = editing.item
      const result = (async (): Promise<FillSignItem | null> => {
        if (!text.trim()) return null
        // Engine calls are queued in order, so a command run by this same key press (Save, Close)
        // sees the text. Mark the document modified right away so Close still asks to save.
        const p = fsOps(doc).addText(draft.page, [draft.rect[0], draft.rect[1]], {
          kind: draft.kind as 'text' | 'date',
          text,
          size: draft.size,
          color: draft.color,
          spacing: draft.spacing,
          topLeft: true
        })
        doc.set({ dirty: true })
        return p
      })().catch((err) => {
        if (!doc.isClosed) showError(err, 'Could not add the text')
        return null
      })
      trackDraftCommit(draft.id, result)
      const created = await result
      if (doc.isClosed) return
      const sel = doc.state.selection
      const draftSelected = sel.kind === 'custom' && sel.type === SELECTION_TYPE && (sel.data as { id: number }).id === draft.id
      if (created && draftSelected) selectItem(doc, created.page, created.id, created.kind)
      else if (draftSelected) doc.clearSelection()
    } else {
      try {
        if (!text.trim()) {
          const p = fsOps(doc).remove([current.id], current.kind, current.page)
          doc.set({ dirty: true })
          await p
          doc.clearSelection()
        } else if (text !== savedText.current) {
          savedText.current = text
          const p = fsOps(doc).setText(current.id, text, current.page)
          doc.set({ dirty: true })
          await p
        }
      } catch (err) {
        if (doc.isClosed) return
        if ((err as { code?: string }).code !== 'NO_ANNOTATION') showError(err, 'Could not save the text')
      }
      unhideItem(doc, current.page, current.id)
    }
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
      if (!isDraftId(item.id) && !committed.current && text.trim() && text !== savedText.current) {
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
          letterSpacing: item.spacing ? `${item.spacing * geometry.scale}px` : undefined,
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
