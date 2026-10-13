import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Trash } from 'lucide-react'
import { IconButton, toast, useApp } from '@renderer/sdk'
import { MiniFormat } from './FormatControls'
import { closeFormattingPopover } from './popover'
import {
  cancelSession,
  COMMIT_LABEL,
  commitSession,
  deleteBox,
  dropSession,
  focusEditor,
  isChanged,
  loadDefaults,
  undoLocal,
  redoLocal,
  useEditText
} from './store'

const KEEP =
  '[data-fc-edit-text-frame], [data-fc-edit-text-keep], .ui-dialog-backdrop, .ui-floating, .ui-popover, .ui-popover-scrim'

function isTyping(el: Element | null): boolean {
  if (!el) return false
  if ((el as HTMLElement).isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

/** Floating formatting bar next to the text being edited. */
function MiniToolbar() {
  const id = useEditText((s) => s.session?.id ?? null)
  const busy = useEditText((s) => s.session?.status === 'committing')
  const done = useEditText((s) => !!s.session?.done)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    if (id === null) {
      setPos(null)
      return
    }
    let raf = 0
    let last = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const frame = document.querySelector('[data-fc-edit-text-frame]')
      const viewport = frame?.closest('.viewer-scroll')
      if (!frame || !viewport) {
        if (last !== 'hidden') setPos(null)
        last = 'hidden'
        return
      }
      const r = frame.getBoundingClientRect()
      const v = viewport.getBoundingClientRect()
      if (r.bottom < v.top || r.top > v.bottom || r.right < v.left || r.left > v.right) {
        if (last !== 'hidden') setPos(null)
        last = 'hidden'
        return
      }
      const w = ref.current?.offsetWidth ?? 420
      const h = ref.current?.offsetHeight ?? 40
      let y = r.top - h - 10
      if (y < v.top + 4) y = r.bottom + 10
      y = Math.min(Math.max(y, v.top + 4), v.bottom - h - 4)
      const x = Math.min(Math.max(r.left, v.left + 4), Math.max(v.left + 4, v.right - w - 4))
      const key = `${Math.round(x)},${Math.round(y)}`
      if (key !== last) {
        last = key
        setPos({ x, y })
      }
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [id])

  if (id === null || !pos || done) return null
  return createPortal(
    <div
      ref={ref}
      className="fc-edit-text-mini"
      data-fc-edit-text-keep
      role="toolbar"
      aria-label="Text formatting"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => {
        // keep the text selection in the editor while using the buttons
        const t = e.target as HTMLElement
        if (t.closest('button') && !t.closest('.ui-popover')) e.preventDefault()
      }}
    >
      <MiniFormat />
      <span className="fc-edit-text-mini-sep" />
      <IconButton icon={Trash} label="Delete text box" disabled={busy} onClick={() => deleteBox()} />
      <IconButton
        icon={Check}
        label="Done"
        shortcut="Ctrl+Enter"
        disabled={busy}
        onClick={() => void commitSession()}
      />
    </div>,
    document.body
  )
}

/** Always-mounted listeners: finishing edits on outside clicks, tab switches and page changes. */
export function EditTextGlobal() {
  const sessionId = useEditText((s) => s.session?.id ?? null)

  useEffect(() => {
    void loadDefaults()
  }, [])

  // clicking anywhere outside the text box (and its formatting controls) saves the edit
  useEffect(() => {
    if (sessionId === null) return
    const onDown = (e: PointerEvent) => {
      const s = useEditText.getState().session
      if (!s || s.status !== 'editing') return
      const t = e.target
      if (t instanceof Element && t.closest(KEEP)) return
      void commitSession()
    }
    const onKey = (e: KeyboardEvent) => {
      const s = useEditText.getState().session
      if (!s || s.status !== 'editing') return
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('[data-fc-edit-text-editor]') || useApp.getState().dialogs.length) return
      if (e.key === 'Escape' && target?.closest('[data-fc-edit-text-keep]')) {
        // Esc in the formatting controls steps back to the text (it must neither cancel the
        // edit nor leave the Edit tool); a field's own handler still runs and puts its value back
        e.preventDefault()
        closeFormattingPopover()
        window.setTimeout(focusEditor, 0)
        return
      }
      const mod = navigator.platform.includes('Mac') ? e.metaKey : e.ctrlKey
      if (e.key === 'Escape' && !isTyping(target)) {
        e.preventDefault()
        e.stopPropagation()
        cancelSession()
      } else if (mod && e.key.toLowerCase() === 'z' && !isTyping(target)) {
        if (e.shiftKey ? redoLocal() : undoLocal()) {
          e.preventDefault()
          e.stopPropagation()
        }
      }
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [sessionId])

  // the page changed underneath the editor (not by our own save): close it
  useEffect(() => {
    const s = useEditText.getState().session
    if (!s) return
    return s.doc.onChange((cs) => {
      const cur = useEditText.getState().session
      if (!cur || cur.id !== s.id || cur.status !== 'editing') return
      if (cs.all || cs.structure || cs.pages.includes(cur.page)) {
        dropSession()
        toast('The page changed, so the text you were editing was closed.', { kind: 'warning' })
      }
    })
  }, [sessionId])

  // another operation starts on the document (Save or Print from the menu bar, a tool...): the
  // text is written first so that the operation includes it. The busy state is set right before
  // the operation is sent to the engine, so the edit reaches the engine first.
  // Typing that is not saved into the page yet still counts as an unsaved change (for "Save
  // changes?"): engine replies report the engine's own state, so the flag is set again when one
  // clears it while the text is being edited.
  useEffect(() => {
    const s = useEditText.getState().session
    if (!s) return
    return s.doc.store.subscribe((st, prev) => {
      if (st.busy && st.busy !== prev.busy && st.busy !== COMMIT_LABEL) void commitSession({ quiet: true })
      const cur = useEditText.getState().session
      if (!st.dirty && cur?.id === s.id && cur.status === 'editing' && isChanged(cur))
        s.doc.set({ dirty: true })
    })
  }, [sessionId])

  // a dialog opens while editing (Save changes?, Print, a page tool...): finish the edit first
  useEffect(
    () =>
      useApp.subscribe((st, prev) => {
        if (st.dialogs.length > prev.dialogs.length && useEditText.getState().session) void commitSession()
      }),
    []
  )

  // switching tabs saves the edit; closing the document drops it
  useEffect(
    () =>
      useApp.subscribe((st, prev) => {
        if (st.activeDocId === prev.activeDocId && st.docs === prev.docs) return
        const s = useEditText.getState().session
        if (!s) return
        if (!st.docs.includes(s.doc)) dropSession()
        else if (st.activeDocId !== s.doc.id) void commitSession()
      }),
    []
  )

  return <MiniToolbar />
}
