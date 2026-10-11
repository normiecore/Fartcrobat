import { useState } from 'react'
import type { AnnotInfo } from '@engine/ops/annots'
import type { Point, Quad, Rect } from '@shared/geometry'
import {
  Button,
  caretAt,
  charQuad,
  Dialog,
  getLoadedText,
  loadText,
  openDialog,
  rangeQuads,
  registry,
  setTool,
  showError,
  TextArea,
  toast,
  useApp,
  type DocumentModel,
  type PageText,
  type TextRange
} from '@renderer/sdk'
import type markupEngine from './engine'
import type { CreateItem } from './engine'
import { getToolStyle, styleSpec } from './style'
import { TOOL_BY_ID, type MarkupTool } from './tools'

export function markupOps(doc: DocumentModel) {
  return doc.ops<typeof markupEngine>('markup-tools')
}

export function annotOps(doc: DocumentModel) {
  return doc.ops<typeof import('@engine/ops/annots').default>('annots')
}

/** The comments feature opens popups / inline editors for new comments when it is installed. */
export function commentsInstalled(): boolean {
  return registry.features.some((f) => f.id === 'comments')
}

export function keepToolSelected(): boolean {
  return useApp.getState().prefs.keepToolSelected
}

/** Creates annotations (one undo step). Shows the error and returns null when it fails. */
export async function createWith(doc: DocumentModel, tool: MarkupTool, items: CreateItem[]): Promise<AnnotInfo[] | null> {
  try {
    return await markupOps(doc).create(items, tool.undoLabel)
  } catch (err) {
    showError(err, `Could not ${tool.label.charAt(0).toLowerCase()}${tool.label.slice(1)}`)
    return null
  }
}

/** Asks the comments feature to open its editor (popup note or inline text editor). */
export function editAnnotation(doc: DocumentModel, id: number, page: number) {
  window.dispatchEvent(new CustomEvent('fartcrobat:edit-annotation', { detail: { docId: doc.id, id, page } }))
}

/**
 * After a comment was created: go back to the Select tool (unless "Keep tool selected" is on),
 * select the new comment and, for comments with text, open its editor.
 */
export function finishCreate(doc: DocumentModel, tool: MarkupTool, page: number, ids: number[], opts: { edit?: number } = {}) {
  const app = useApp.getState()
  if (!app.prefs.keepToolSelected && app.toolId === tool.id) setTool('select')
  if (ids.length) doc.setSelection({ kind: 'annotations', page, ids })
  if (opts.edit !== undefined && commentsInstalled()) {
    const id = opts.edit
    // let the Select tool's comment layer mount before it is asked to edit
    requestAnimationFrame(() => requestAnimationFrame(() => editAnnotation(doc, id, page)))
  }
}

const TEXT_PROMPTS: Record<string, { title: string; label: string; ok: string }> = {
  note: { title: 'Add sticky note', label: 'Comment', ok: 'Add note' },
  typewriter: { title: 'Add text comment', label: 'Text', ok: 'Add text' },
  textbox: { title: 'Add text box', label: 'Text', ok: 'Add text box' },
  callout: { title: 'Add callout', label: 'Text', ok: 'Add callout' },
  insertText: { title: 'Insert text', label: 'Text to insert', ok: 'Insert' },
  replaceText: { title: 'Replace text', label: 'Replacement text', ok: 'Replace' },
  highlight: { title: 'Add note to text', label: 'Comment', ok: 'Add note' }
}

function TextEntryDialog({ title, label, ok, close }: { title: string; label: string; ok: string; close: (v?: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <Dialog
      title={title}
      onClose={() => close()}
      width={420}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" onClick={() => close(value)}>
            {ok}
          </Button>
        </>
      }
    >
      <label className="ui-field">
        <span className="ui-field-label">{label}</span>
        <TextArea
          data-autofocus
          className="fc-markup-tools-entry"
          value={value}
          rows={4}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              close(value)
            }
          }}
        />
        <span className="ui-field-hint">Ctrl+Enter to finish</span>
      </label>
    </Dialog>
  )
}

/**
 * Text for a new comment. With the comments feature installed the text is typed into its popup or
 * inline editor after creation, so this returns '' straight away; otherwise a small dialog asks
 * for it first. Returns null when the user cancels.
 */
export async function textForNewComment(tool: MarkupTool, promptKey = tool.key): Promise<string | null> {
  if (commentsInstalled()) return ''
  const p = TEXT_PROMPTS[promptKey] ?? TEXT_PROMPTS.note
  const v = await openDialog<string>((close) => <TextEntryDialog title={p.title} label={p.label} ok={p.ok} close={close} />)
  return v === undefined ? null : v
}

// ---- text markup ----------------------------------------------------------------------------

/** Quads (one per line) of character ranges, grouped by page. Loads page text as needed. */
export async function quadsByPage(doc: DocumentModel, ranges: TextRange[]): Promise<Map<number, Quad[]>> {
  const out = new Map<number, Quad[]>()
  for (const r of ranges) {
    const t = getLoadedText(doc, r.page) ?? (await loadText(doc, r.page))
    const quads = rangeQuads(t, r.start, Math.min(r.end, t.text.length))
    if (!quads.length) continue
    out.set(r.page, [...(out.get(r.page) ?? []), ...quads])
  }
  return out
}

/** MuPDF draws a fixed 20×14 pt caret centred in its rect; put its tip just under the text. */
export function caretRectAt(x: number, bottom: number): Rect {
  return [x - 10, bottom - 3, x + 10, bottom + 11]
}

/** Insertion point (between characters) nearest to p: x and the bottom of the text line. */
export function insertionPoint(t: PageText, p: Point): { x: number; bottom: number } | null {
  const idx = caretAt(t, p)
  if (idx < 0) return null
  const line = t.lines.find((l) => idx >= l.start && idx <= l.end)
  if (!line || line.end <= line.start) return null
  if (idx < line.end) {
    const q = charQuad(t, idx)
    return { x: q[0], bottom: Math.max(q[5], q[7]) }
  }
  const q = charQuad(t, line.end - 1)
  return { x: q[2], bottom: Math.max(q[5], q[7]) }
}

/**
 * Applies a text markup tool (highlight, underline, strikethrough, squiggly, replace text) to text
 * ranges. `withNote` also opens a note for it ("Add note to text").
 */
export async function applyTextMarkup(
  doc: DocumentModel,
  tool: MarkupTool,
  ranges: TextRange[],
  opts: { withNote?: boolean } = {}
): Promise<boolean> {
  const byPage = await quadsByPage(doc, ranges)
  if (!byPage.size) return false
  const style = styleSpec(tool, getToolStyle(tool.key))
  if (tool.kind === 'replaceText') {
    const [page, quads] = [...byPage.entries()][0]
    if (byPage.size > 1) toast('Replace text works within one page; only the text on the first page was marked.', { kind: 'warning' })
    const text = await textForNewComment(tool)
    if (text === null) return false
    const last = quads[quads.length - 1]
    try {
      const res = await markupOps(doc).replaceText(page, {
        quads,
        caretRect: caretRectAt(last[6], Math.max(last[5], last[7])),
        color: style.color ?? '#2196F3',
        opacity: style.opacity ?? 1,
        contents: text
      })
      doc.clearSelection()
      finishCreate(doc, tool, page, [res.caret.id], { edit: res.caret.id })
      return true
    } catch (err) {
      showError(err, 'Could not replace text')
      return false
    }
  }
  let contents = ''
  if (opts.withNote) {
    const text = await textForNewComment(tool, 'highlight')
    if (text === null) return false
    contents = text
  }
  const items: CreateItem[] = [...byPage.entries()].map(([page, quads]) => ({
    page,
    spec: { type: tool.markup!, quads, ...style, ...(contents ? { contents } : {}) }
  }))
  const created = await createWith(doc, tool, items)
  if (!created) return false
  doc.clearSelection()
  const first = created[0]
  finishCreate(doc, tool, first.page, created.filter((a) => a.page === first.page).map((a) => a.id), {
    edit: opts.withNote ? first.id : undefined
  })
  return true
}

/** Used by text-selection buttons: markup the current text selection with the given tool. */
export function runSelectionMarkup(toolId: string, opts: { withNote?: boolean } = {}) {
  return async (doc: DocumentModel, sel: { ranges: TextRange[] }) => {
    const tool = TOOL_BY_ID.get(toolId)
    if (!tool) return
    await applyTextMarkup(doc, tool, sel.ranges, opts)
  }
}
