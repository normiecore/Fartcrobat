/**
 * Keyboard use of the click-to-place tools: with a sticky note, text comment, text box or attach
 * file tool active, Enter places the comment in the middle of what is visible (then the usual text
 * entry or file chooser follows).
 */
import type { Point } from '@shared/geometry'
import { getActiveDoc, useApp, type DocumentModel } from '@renderer/sdk'
import { placeAttachment, placeNote, placeTypewriter } from './layers/ClickLayer'
import { createShape, TEXTBOX_DEFAULT_SIZE } from './layers/ShapeLayer'
import { useKeys } from './layers/shared'
import { TOOL_BY_ID, type ToolKind } from './tools'

const PLACEABLE = new Set<ToolKind>(['note', 'typewriter', 'textbox', 'attach'])

/** Page and page-space point in the middle of the visible part of the document. */
export function viewCentre(doc: DocumentModel): { pageIndex: number; point: Point } | null {
  const vp = doc.view?.getViewportElement()
  if (vp) {
    const r = vp.getBoundingClientRect()
    const hit = doc.view?.hitTest(r.left + r.width / 2, r.top + r.height / 2)
    if (hit) return hit
  }
  const pageIndex = doc.state.currentPage
  const page = doc.state.info.pages[pageIndex]
  return page ? { pageIndex, point: [page.width / 2, page.height / 2] } : null
}

let placing = false

export function KeyboardPlacement() {
  const toolId = useApp((s) => s.toolId)
  const hasDoc = useApp((s) => !!s.activeDocId)
  const tool = TOOL_BY_ID.get(toolId)
  useKeys(hasDoc && !!tool && PLACEABLE.has(tool.kind), (e) => {
    if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || !tool) return false
    // Enter on a button, link or menu item keeps its usual meaning.
    if ((e.target as HTMLElement | null)?.closest?.('button, a[href], [role="button"], [role="menuitem"], [role="option"]')) return false
    const doc = getActiveDoc()
    const at = doc && viewCentre(doc)
    const page = at && doc.state.info.pages[at.pageIndex]
    if (!doc || !at || !page || placing) return false
    const size = { width: page.width, height: page.height }
    const [x, y] = at.point
    placing = true
    let done: Promise<unknown>
    if (tool.kind === 'note') done = placeNote(doc, tool, at.pageIndex, at.point, size)
    else if (tool.kind === 'typewriter') done = placeTypewriter(doc, tool, at.pageIndex, at.point, size)
    else if (tool.kind === 'attach') done = placeAttachment(doc, tool, at.pageIndex, at.point, size)
    else {
      const a: Point = [x - TEXTBOX_DEFAULT_SIZE[0] / 2, y - TEXTBOX_DEFAULT_SIZE[1] / 2]
      done = createShape(doc, tool, at.pageIndex, a, a, size)
    }
    void done.finally(() => {
      placing = false
    })
    return true
  })
  return null
}
