import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Copy, Pencil, Trash } from 'lucide-react'
import type { Point } from '@shared/geometry'
import {
  getActiveDoc,
  invoke,
  registry,
  runCommand,
  showContextMenu,
  showError,
  toast,
  useApp,
  useDocState,
  usePageVersion,
  type ContextMenuItem,
  type DocumentModel,
  type PageLayerProps
} from '@renderer/sdk'
import type editOps from './engine'
import type { MarkType, TextBlockInfo } from './model'
import { beginEdit, beginNewText, commitSession, loadBlocks, markName, useEditText } from './store'
import { SessionOverlay } from './TextEditor'

/** Paragraphs of a page, reloaded whenever the page changes. */
function usePageBlocks(doc: DocumentModel, page: number, enabled: boolean): TextBlockInfo[] | null {
  const version = usePageVersion(doc, page)
  const [blocks, setBlocks] = useState<{ version: number; list: TextBlockInfo[] } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    loadBlocks(doc, page).then(
      (list) => alive && setBlocks({ version, list }),
      (err) => {
        // A page deleted while its text was loading: its layer is about to go away.
        if (alive && (err as { code?: string })?.code !== 'BAD_PAGE') showError(err, 'Could not read the text on this page')
      }
    )
    return () => {
      alive = false
    }
  }, [doc, page, version, enabled])
  return blocks && blocks.version === version ? blocks.list : null
}

async function deleteBlock(doc: DocumentModel, page: number, b: TextBlockInfo) {
  await commitSession()
  try {
    await doc.ops<typeof editOps>('edit-text').commit(page, {
      source: { start: b.start, end: b.end, check: b.text },
      frame: b.frame,
      runs: [{ ...b.runs[0], text: '' }],
      align: b.align,
      lineSpacing: b.lineSpacing,
      wrap: b.wrap,
      ascent: b.ascent
    })
  } catch (err) {
    showError(err, 'Could not delete the text')
  }
}

function unit(d: Point): Point {
  const l = Math.hypot(d[0], d[1]) || 1
  return [d[0] / l, d[1] / l]
}

/** CSS placement of a paragraph's outline, turned with its text (rotated text gets a rotated box). */
function boxStyle(
  block: TextBlockInfo,
  geometry: PageLayerProps['geometry'],
  pad: number
): React.CSSProperties {
  const d = unit(block.frame.dir)
  const o = geometry.toCss(block.frame.origin)
  const p1 = geometry.toCss([block.frame.origin[0] + d[0], block.frame.origin[1] + d[1]])
  const angle = Math.atan2(p1[1] - o[1], p1[0] - o[0])
  return {
    left: o[0],
    top: o[1],
    width: block.frame.width * geometry.scale + 2 * pad,
    height: block.height * geometry.scale + 2 * pad,
    transform: `rotate(${angle}rad) translate(${-pad}px, ${-pad}px)`
  }
}

function BlockBox({
  doc,
  page,
  block,
  geometry
}: {
  doc: DocumentModel
  page: number
  block: TextBlockInfo
  geometry: PageLayerProps['geometry']
}) {
  const ref = useRef<HTMLDivElement>(null)
  const open = (caret: Point | null, pagePoint: Point | null) =>
    void beginEdit(doc, page, block, caret, pagePoint)
  const label = block.text.replace(/\s+/g, ' ').trim()
  return (
    <div
      ref={ref}
      className="fc-edit-text-box"
      role="button"
      tabIndex={0}
      aria-label={`Edit text: ${label.length > 60 ? label.slice(0, 57) + '…' : label}`}
      title="Click to edit this text"
      style={boxStyle(block, geometry, 2)}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const pageEl = ref.current?.closest('.viewer-page')
        open([e.clientX, e.clientY], pageEl ? geometry.eventToPage(e, pageEl) : null)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          open(null, null)
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault()
          e.stopPropagation()
          void deleteBlock(doc, page, block)
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        showContextMenu(e.clientX, e.clientY, [
          { id: 'edit', label: 'Edit Text', icon: Pencil, run: () => open(null, null) },
          {
            id: 'copy',
            label: 'Copy Text',
            icon: Copy,
            run: () =>
              void invoke('clipboard:writeText', block.text).catch((err) => showError(err, 'Could not copy'))
          },
          { id: 'sep', label: '', separator: true },
          {
            id: 'delete',
            label: 'Delete Text Box',
            icon: Trash,
            shortcut: 'Del',
            danger: true,
            run: () => void deleteBlock(doc, page, block)
          }
        ])
      }}
    />
  )
}

const MARK_COMMANDS: Record<MarkType, string[]> = {
  HeaderFooter: ['marks.headerFooter.update', 'marks.headerFooter.remove'],
  Watermark: ['marks.watermark.update', 'marks.watermark.remove'],
  Background: ['marks.background.update', 'marks.background.remove'],
  Bates: ['marks.bates.add', 'marks.bates.remove']
}

/** Commands offered for text that belongs to a page mark (those that are registered). */
function markItems(mark: MarkType): ContextMenuItem[] {
  return MARK_COMMANDS[mark]
    .map((id) => registry.commands.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => {
      const ctx = { doc: getActiveDoc() }
      let enabled = true
      let label = c.id
      try {
        enabled = c.enabled ? c.enabled(ctx) : true
        label = typeof c.label === 'function' ? c.label(ctx) : c.label
      } catch {
        enabled = false
      }
      return {
        id: c.id,
        label,
        icon: c.icon,
        disabled: !enabled,
        run: () => void commitSession().then(() => runCommand(c.id))
      }
    })
}

/**
 * Text drawn by a header, footer, watermark or Bates number: it is changed with the tool that
 * added it, so clicking it offers that tool's Update and Remove commands.
 */
function MarkBox({ block, geometry }: { block: TextBlockInfo; geometry: PageLayerProps['geometry'] }) {
  const ref = useRef<HTMLElement | null>(null)
  const mark = block.mark!
  const name = markName(mark)
  const Name = name[0].toUpperCase() + name.slice(1)
  const label = block.text.replace(/\s+/g, ' ').trim()
  // a watermark or background lies across the page content: only a small tag is clickable, so
  // the text and images under it stay easy to click
  const passive = mark === 'Watermark' || mark === 'Background'
  const open = (x: number, y: number) => {
    const items = markItems(mark)
    if (!items.length) {
      toast(
        `This ${name} was added with “Add header, watermark or background”, which can change or remove it.`
      )
      return
    }
    showContextMenu(x, y, items)
  }
  const handlers = {
    ref: (el: HTMLElement | null) => {
      ref.current = el
    },
    role: 'button',
    tabIndex: 0,
    'aria-haspopup': 'menu' as const,
    'aria-label': `${Name}: ${label.length > 50 ? label.slice(0, 47) + '…' : label}`,
    title: `${Name} — click to update or remove it`,
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.stopPropagation()
      void commitSession()
      open(e.clientX, e.clientY)
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        const r = ref.current!.getBoundingClientRect()
        open(r.left, r.bottom)
      }
    },
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      open(e.clientX, e.clientY)
    }
  }
  if (!passive)
    return <div className="fc-edit-text-box is-mark" style={boxStyle(block, geometry, 2)} {...handlers} />
  const o = geometry.toCss(block.frame.origin)
  return (
    <>
      <div className="fc-edit-text-box is-mark is-passive" style={boxStyle(block, geometry, 2)} aria-hidden />
      <button type="button" className="fc-edit-text-mark-tag" style={{ left: o[0], top: o[1] }} {...handlers}>
        {Name}
        <ChevronDown size={12} aria-hidden />
      </button>
    </>
  )
}

const area = (b: TextBlockInfo) => b.frame.width * b.height

/** Tool layer for "Edit text & images" and "Add text". */
export function EditLayer({ doc, pageIndex, geometry }: PageLayerProps) {
  const toolId = useApp((s) => s.toolId)
  const session = useEditText((s) => s.session)
  const contentMode = toolId === 'edit.content'
  const addMode = toolId === 'edit.addText'
  const allowed = useDocState(doc, (s) => s.info.permissions?.edit !== false)
  const blocks = usePageBlocks(doc, pageIndex, contentMode && allowed)
  const mine = session && session.doc === doc && session.page === pageIndex ? session : null
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ a: Point; b: Point } | null>(null)
  const gesture = useRef<{ a: Point; skip: boolean } | null>(null)

  const local = (e: { clientX: number; clientY: number }): Point => {
    const b = ref.current!.getBoundingClientRect()
    return [e.clientX - b.left, e.clientY - b.top]
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (!addMode || e.button !== 0) return
    e.preventDefault()
    // a click while text is being edited only finishes that edit
    const skip = !!useEditText.getState().session
    const a = local(e)
    gesture.current = { a, skip }
    if (!skip) setDrag({ a, b: a })
    ref.current?.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g || g.skip) return
    setDrag({ a: g.a, b: local(e) })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current
    gesture.current = null
    setDrag(null)
    if (!g || g.skip) return
    const b = local(e)
    // new text reads left to right on screen, also in a rotated view
    const z = geometry.toPage([0, 0])
    const r = geometry.toPage([1, 0])
    const dir = unit([r[0] - z[0], r[1] - z[1]])
    const wide = Math.abs(b[0] - g.a[0]) > 8
    // a click puts the top-left corner of the text there; a drag sets the width that text wraps to
    const origin = geometry.toPage(wide ? [Math.min(g.a[0], b[0]), Math.min(g.a[1], b[1])] : g.a)
    const width = wide ? Math.max(12, Math.abs(b[0] - g.a[0]) / geometry.scale) : null
    void beginNewText(doc, pageIndex, origin, width, dir)
  }

  return (
    <div
      ref={ref}
      className={`viewer-layer fc-edit-text-layer ${addMode ? 'is-add' : ''}`}
      style={{ pointerEvents: addMode ? 'auto' : 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {contentMode &&
        allowed &&
        blocks &&
        // larger boxes first, so a small box inside or across a big one stays clickable
        [...blocks]
          .sort((a, b) => area(b) - area(a))
          .map((b) =>
            mine?.block && mine.block.id === b.id ? null : b.mark ? (
              <MarkBox key={b.id} block={b} geometry={geometry} />
            ) : (
              <BlockBox key={b.id} doc={doc} page={pageIndex} block={b} geometry={geometry} />
            )
          )}
      {drag && Math.abs(drag.b[0] - drag.a[0]) > 8 && (
        <div
          className="fc-edit-text-marquee"
          style={{
            left: Math.min(drag.a[0], drag.b[0]),
            top: Math.min(drag.a[1], drag.b[1]),
            width: Math.abs(drag.b[0] - drag.a[0]),
            height: Math.max(12, Math.abs(drag.b[1] - drag.a[1]))
          }}
        />
      )}
      {mine && <SessionOverlay key={mine.id} session={mine} geometry={geometry} />}
    </div>
  )
}
