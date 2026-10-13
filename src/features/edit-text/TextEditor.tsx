import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Point } from '@shared/geometry'
import { drawResult, runCommand, useApp, useDocState, type PageGeometry } from '@renderer/sdk'
import type editOps from './engine'
import { cssBaseline, cssFamily } from './fonts'
import { closeFormattingPopover } from './popover'
import { caretFromPoint, getSelectionOffsets, readRuns, renderRuns, setSelectionOffsets } from './richText'
import {
  cancelSession,
  commitSession,
  consumeCaret,
  editorChanged,
  insertText,
  nudgeFrame,
  redoLocal,
  setFrame,
  setSelection,
  toggleStyle,
  undoLocal,
  useEditText,
  type EditSession
} from './store'

/** Sessions whose editor has been shown (it is mounted again when its page scrolls back into view). */
const shownSessions = new Set<number>()

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

/** Page render of the paragraph's area without its text, hiding the original glyphs while editing. */
function Cover({
  session,
  geometry,
  onReady
}: {
  session: EditSession
  geometry: PageGeometry
  onReady: () => void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const colorMode = useApp((s) => s.prefs.pageColors)
  const annots = useDocState(session.doc, (s) => s.showAnnotations)
  const block = session.block!
  const { doc, page } = session
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let alive = true
    const dpr = window.devicePixelRatio || 1
    const pad = 4
    const r = geometry.rectToCss([
      block.bbox[0] - pad,
      block.bbox[1] - pad,
      block.bbox[2] + pad,
      block.bbox[3] + pad
    ])
    const timer = window.setTimeout(() => {
      doc
        .ops<typeof editOps>('edit-text')
        .preview(page, { start: block.start, end: block.end, check: block.text }, block.quads, {
          scale: geometry.scale * dpr,
          rotate: geometry.rotation,
          clip: [r.left * dpr, r.top * dpr, (r.left + r.width) * dpr, (r.top + r.height) * dpr],
          colorMode,
          annots
        })
        .then((res) => {
          if (!alive || !ref.current) return
          drawResult(ref.current, res)
          const c = ref.current
          c.style.left = `${res.x / dpr}px`
          c.style.top = `${res.y / dpr}px`
          c.style.width = `${res.width / dpr}px`
          c.style.height = `${res.height / dpr}px`
          c.style.visibility = 'visible'
          onReady()
        })
        .catch((err) => {
          if (alive) {
            console.warn('[edit-text] preview failed', err)
            onReady()
          }
        })
    }, 16)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page, block, geometry, colorMode, annots])
  return <canvas ref={ref} className="fc-edit-text-cover" style={{ visibility: 'hidden' }} aria-hidden />
}

function normalize(d: Point): Point {
  const l = Math.hypot(d[0], d[1]) || 1
  return [d[0] / l, d[1] / l]
}

export function SessionOverlay({ session, geometry }: { session: EditSession; geometry: PageGeometry }) {
  const [coverReady, setCoverReady] = useState(!session.block)
  useEffect(() => {
    // never keep the text hidden for long, even if the preview is slow
    const t = window.setTimeout(() => setCoverReady(true), 600)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <>
      {session.block && <Cover session={session} geometry={geometry} onReady={() => setCoverReady(true)} />}
      <EditorFrame session={session} geometry={geometry} visible={coverReady} />
    </>
  )
}

function EditorFrame({
  session: s,
  geometry,
  visible
}: {
  session: EditSession
  geometry: PageGeometry
  visible: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const lastFocus = useRef(0)
  const pageColors = useApp((st) => st.prefs.pageColors)
  const scale = geometry.scale
  const d = normalize(s.frame.dir)
  const o = geometry.toCss(s.frame.origin)
  const p1 = geometry.toCss([s.frame.origin[0] + d[0], s.frame.origin[1] + d[1]])
  const angle = Math.atan2(p1[1] - o[1], p1[0] - o[0])
  const widthPx = s.frame.width * scale
  const first = s.runs[0]
  const editing = s.status === 'editing'

  // first baseline of the PDF text = ascent * largest size on the first line
  let firstLineSize = first.size
  for (const r of s.runs) {
    firstLineSize = Math.max(firstLineSize, r.size)
    if (r.text.includes('\n')) break
  }
  const familyCss = cssFamily(first.font, s.fonts)
  const cssBase = cssBaseline(familyCss, firstLineSize * scale, s.lineSpacing, first.bold, first.italic)
  const shift = s.ascent * firstLineSize * scale - cssBase
  const anchor = s.wrap ? 0 : s.align === 'center' ? widthPx / 2 : s.align === 'right' ? widthPx : 0
  const pct = s.wrap ? '0%' : s.align === 'center' ? '-50%' : s.align === 'right' ? '-100%' : '0%'

  // render content: on mount, and whenever the store changed it from outside the editor
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const state = useEditText.getState().session
    if (!state || state.id !== s.id) return
    const hadFocus = document.activeElement === root
    renderRuns(root, state.runs, scale, state.fonts)
    if (!mounted.current) {
      mounted.current = true
      lastFocus.current = state.focusToken
      if (shownSessions.has(state.id)) {
        // the page scrolled back into view: take the focus back only when nobody else has it
        const active = document.activeElement
        if (active && active !== document.body && !active.closest('.viewer-scroll')) return
        root.focus({ preventScroll: true })
        setSelectionOffsets(root, state.selection.start, state.selection.end)
        return
      }
      shownSessions.add(state.id)
      root.focus({ preventScroll: true })
      if (!(state.caret && caretFromPoint(root, state.caret[0], state.caret[1])))
        setSelectionOffsets(root, state.selection.start, state.selection.end)
      const sel = getSelectionOffsets(root)
      if (sel) setSelection(sel)
      // the click point is only meaningful once (the page may scroll out of view and back)
      if (state.caret) consumeCaret()
      return
    }
    if (hadFocus || state.focusToken !== lastFocus.current) {
      lastFocus.current = state.focusToken
      root.focus({ preventScroll: true })
      setSelectionOffsets(root, state.selection.start, state.selection.end)
    }
  }, [s.id, s.renderToken, scale])

  // asked to take the focus back (e.g. after Esc in a formatting field)
  useEffect(() => {
    const root = rootRef.current
    const state = useEditText.getState().session
    if (!root || !state || state.id !== s.id || state.focusToken === lastFocus.current) return
    lastFocus.current = state.focusToken
    root.focus({ preventScroll: true })
    setSelectionOffsets(root, state.selection.start, state.selection.end)
  }, [s.id, s.focusToken])

  // keep the selection in the store (formatting applies to it)
  useEffect(() => {
    const onSel = () => {
      const root = rootRef.current
      if (!root || !root.contains(document.getSelection()?.anchorNode ?? null)) return
      const sel = getSelectionOffsets(root)
      if (sel) setSelection(sel)
    }
    document.addEventListener('selectionchange', onSel)
    return () => document.removeEventListener('selectionchange', onSel)
  }, [])

  // native beforeinput: line breaks, undo and formatting go through the store
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onBeforeInput = (e: InputEvent) => {
      switch (e.inputType) {
        case 'insertParagraph':
        case 'insertLineBreak':
          e.preventDefault()
          syncSelection()
          insertText('\n')
          break
        case 'historyUndo':
          e.preventDefault()
          undoLocal()
          break
        case 'historyRedo':
          e.preventDefault()
          redoLocal()
          break
        case 'formatBold':
          e.preventDefault()
          toggleStyle('bold')
          break
        case 'formatItalic':
          e.preventDefault()
          toggleStyle('italic')
          break
        case 'formatUnderline':
          e.preventDefault()
          toggleStyle('underline')
          break
        case 'insertFromDrop':
        case 'deleteByDrag':
          e.preventDefault()
          break
      }
    }
    root.addEventListener('beforeinput', onBeforeInput)
    return () => root.removeEventListener('beforeinput', onBeforeInput)
  }, [])

  const syncSelection = () => {
    const root = rootRef.current
    const sel = root && getSelectionOffsets(root)
    if (sel) setSelection(sel)
  }

  const onInput = () => {
    const root = rootRef.current
    const cur = useEditText.getState().session
    if (!root || !cur) return
    const runs = readRuns(root, scale, cur.runs)
    editorChanged(runs, getSelectionOffsets(root) ?? cur.selection)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = isMac ? e.metaKey : e.ctrlKey
    const key = e.key.toLowerCase()
    const stop = () => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (e.key === 'Escape') {
      stop()
      // Esc first closes an open colour palette, then cancels the edit
      if (!closeFormattingPopover()) cancelSession()
    } else if (mod && e.key === 'Enter') {
      stop()
      void commitSession()
    } else if (mod && !e.altKey && (key === 'b' || key === 'i' || key === 'u')) {
      stop()
      syncSelection()
      toggleStyle(key === 'b' ? 'bold' : key === 'i' ? 'italic' : 'underline')
    } else if (mod && key === 'z') {
      stop()
      if (e.shiftKey) redoLocal()
      else undoLocal()
    } else if (mod && key === 'y') {
      stop()
      redoLocal()
    } else if (mod && key === 's') {
      stop()
      void commitSession().then(() => runCommand(e.shiftKey ? 'file.saveAs' : 'file.save'))
    } else if (e.altKey && !mod && e.key.startsWith('Arrow')) {
      // Alt+arrows move the box (Shift for bigger steps), in screen directions
      stop()
      const step = e.shiftKey ? 10 : 1
      const v: Point =
        e.key === 'ArrowLeft'
          ? [-step, 0]
          : e.key === 'ArrowRight'
            ? [step, 0]
            : e.key === 'ArrowUp'
              ? [0, -step]
              : [0, step]
      const z = geometry.toPage([0, 0])
      const p = geometry.toPage([v[0] * geometry.scale, v[1] * geometry.scale])
      nudgeFrame(p[0] - z[0], p[1] - z[1])
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    if (!text) return
    syncSelection()
    insertText(text)
  }

  // ---- moving and resizing the box -----------------------------------------------------------

  const pageElement = () => frameRef.current?.closest('.viewer-page') as HTMLElement | null

  const startMove = (e: React.PointerEvent) => {
    if (e.button !== 0 || !editing) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const origin = s.frame.origin
    const z0 = geometry.toPage([0, 0])
    let first = true
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const dp = geometry.toPage([ev.clientX - startX, ev.clientY - startY])
      const delta: Point = [dp[0] - z0[0], dp[1] - z0[1]]
      if (first && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 2) return
      const cur = useEditText.getState().session
      if (!cur) return
      setFrame({ ...cur.frame, origin: [origin[0] + delta[0], origin[1] + delta[1]] }, cur.wrap, first)
      first = false
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      rootRef.current?.focus({ preventScroll: true })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const startResize = (side: 'left' | 'right') => (e: React.PointerEvent) => {
    if (e.button !== 0 || !editing) return
    e.preventDefault()
    e.stopPropagation()
    const pageEl = pageElement()
    const root = rootRef.current
    if (!pageEl || !root) return
    // the box as currently shown (a single-line box grows with its text)
    let origin = s.frame.origin
    let width = s.frame.width
    if (!s.wrap) {
      const contentW = root.offsetWidth / scale
      const anchorU =
        s.align === 'center'
          ? s.frame.width / 2 - contentW / 2
          : s.align === 'right'
            ? s.frame.width - contentW
            : 0
      origin = [origin[0] + anchorU * d[0], origin[1] + anchorU * d[1]]
      width = contentW
    }
    const startOrigin = origin
    const startWidth = width
    let first = true
    const target = e.currentTarget as HTMLElement
    target.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => {
      const p = geometry.eventToPage(ev, pageEl)
      const u = (p[0] - startOrigin[0]) * d[0] + (p[1] - startOrigin[1]) * d[1]
      const min = 12
      let o2 = startOrigin
      let w2 = startWidth
      if (side === 'right') w2 = Math.max(min, u)
      else {
        const shiftU = Math.min(u, startWidth - min)
        o2 = [startOrigin[0] + shiftU * d[0], startOrigin[1] + shiftU * d[1]]
        w2 = startWidth - shiftU
      }
      const cur = useEditText.getState().session
      if (!cur) return
      setFrame({ ...cur.frame, origin: o2, width: w2 }, true, first)
      first = false
    }
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
      rootRef.current?.focus({ preventScroll: true })
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  const invert = pageColors !== 'document'
  return (
    <div
      ref={frameRef}
      className={`fc-edit-text-frame ${editing ? '' : 'is-busy'} ${visible ? '' : 'is-pending'}`}
      data-fc-edit-text-frame
      style={{
        left: o[0],
        top: o[1],
        transform: `rotate(${angle}rad) translate(${anchor}px, ${shift}px) translateX(${pct})`,
        width: s.wrap ? widthPx : undefined
      }}
    >
      <div
        className="fc-edit-text-ring"
        onPointerDown={startMove}
        title="Drag to move the text box"
        aria-hidden
      />
      <div
        ref={rootRef}
        className="fc-edit-text-editor"
        data-fc-edit-text-editor
        role="textbox"
        aria-multiline="true"
        aria-label="Edit text"
        contentEditable={editing}
        suppressContentEditableWarning
        spellCheck={false}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => e.preventDefault()}
        onPointerDown={(e) => e.stopPropagation()}
        style={{
          fontFamily: familyCss,
          fontSize: first.size * scale,
          color: first.color,
          fontWeight: first.bold ? 700 : 400,
          fontStyle: first.italic ? 'italic' : 'normal',
          lineHeight: s.lineSpacing,
          whiteSpace: s.wrap ? 'pre-wrap' : 'pre',
          textAlign: s.align,
          width: s.wrap ? widthPx : undefined,
          filter: invert ? 'invert(1) hue-rotate(180deg)' : undefined
        }}
      />
      <div
        className="fc-edit-text-handle is-left"
        onPointerDown={startResize('left')}
        title="Drag to change the width"
        aria-hidden
      />
      <div
        className="fc-edit-text-handle is-right"
        onPointerDown={startResize('right')}
        title="Drag to change the width"
        aria-hidden
      />
    </div>
  )
}
