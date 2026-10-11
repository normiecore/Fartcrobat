import type { Point, Rect } from '@shared/geometry'
import { getActiveDoc, openToolGroup, registry, setTool, showError, toast, useApp, type DocumentModel } from '@renderer/sdk'
import {
  clampRectToPage,
  formatToday,
  INITIALS_HEIGHT,
  isTextKind,
  kindNoun,
  rectAround,
  SIGNATURE_HEIGHT,
  stepSize,
  type FillSignItem,
  type FillSignKind,
  type MarkKind,
  type SignatureKind,
  type TextKind
} from './shared'
import { dataUrlToBytes, fsOps, selectedItem, selectItem, useFillSign, type SignatureImage } from './state'
import { flushEditor } from './TextEditor'

/** Tool ids, as listed in the cross-feature contracts. */
export const TOOL_KIND: Record<string, TextKind | MarkKind> = {
  'fillsign.text': 'text',
  'fillsign.date': 'date',
  'fillsign.cross': 'cross',
  'fillsign.check': 'check',
  'fillsign.dot': 'dot',
  'fillsign.line': 'line',
  'fillsign.box': 'box'
}

export const KIND_TOOL: Record<TextKind | MarkKind, string> = {
  text: 'fillsign.text',
  date: 'fillsign.date',
  cross: 'fillsign.cross',
  check: 'fillsign.check',
  dot: 'fillsign.dot',
  line: 'fillsign.line',
  box: 'fillsign.box'
}

export const PLACE_TOOL = 'fillsign.place'

export function isFillSignTool(toolId: string): boolean {
  return toolId in TOOL_KIND || toolId === PLACE_TOOL
}

/** Switches to a Fill & Sign tool. */
export function activateFillTool(id: string) {
  setTool(id)
}

/** Opens the Fill & Sign tools pane (as Tools > Fill & Sign does) and optionally picks a tool. */
export function openFillSign(toolId?: string) {
  if (!getActiveDoc()) {
    openToolGroup('fillsign')
    return
  }
  if (useApp.getState().toolGroupId !== 'fillsign' && registry.toolGroups.some((g) => g.id === 'fillsign')) openToolGroup('fillsign')
  if (toolId) setTool(toolId)
}

// ---- creating ----------------------------------------------------------------------------------

/** Adds an item where the user clicked with a Fill & Sign tool. Text items open for typing. */
export async function createAt(doc: DocumentModel, page: number, point: Point, kind: TextKind | MarkKind) {
  const { textSize, color } = useFillSign.getState()
  const fs = fsOps(doc)
  try {
    if (isTextKind(kind)) {
      const text = kind === 'date' ? formatToday(navigator.language) : ''
      const item = await fs.addText(page, point, { kind, text, size: textSize, color })
      selectItem(doc, page, item.id, item.kind)
      useFillSign.setState({ editing: { docId: doc.id, page, id: item.id, isNew: true, edits: 0, item } })
    } else {
      const item = await fs.addMark(page, point, kind, { size: textSize, color })
      selectItem(doc, page, item.id, item.kind)
    }
  } catch (err) {
    showError(err, `Could not add the ${kindNoun(kind)}`)
  }
}

/** Starts typing into an existing text or date item. */
export function startEditing(doc: DocumentModel, item: FillSignItem) {
  if (!isTextKind(item.kind)) return
  if (item.locked) {
    toast('This text is locked and cannot be edited.')
    return
  }
  selectItem(doc, item.page, item.id, item.kind)
  useFillSign.setState({ editing: { docId: doc.id, page: item.page, id: item.id, isNew: false, edits: 0, item } })
}

/** Records an engine change made while the editor is open (and the item's new state). */
export function noteEdit(next?: FillSignItem) {
  const e = useFillSign.getState().editing
  if (!e) return
  const item = next && next.id === e.id ? next : e.item
  useFillSign.setState({ editing: { ...e, edits: e.edits + 1, item, page: item.page } })
}

/** Writes text typed into an open editor for this item into the document first. */
async function flushIfEditing(doc: DocumentModel, item: { id: number }) {
  const e = useFillSign.getState().editing
  if (e && e.docId === doc.id && e.id === item.id) await flushEditor(item.id)
}

// ---- changing ----------------------------------------------------------------------------------

export async function deleteItem(doc: DocumentModel, item: { id: number; kind: FillSignKind; page: number; locked?: boolean }) {
  if (item.locked) {
    toast(`This ${kindNoun(item.kind)} is locked and cannot be deleted.`)
    return
  }
  try {
    const e = useFillSign.getState().editing
    if (e && e.docId === doc.id && e.id === item.id) useFillSign.setState({ editing: null })
    await fsOps(doc).remove([item.id], item.kind, item.page)
    doc.clearSelection()
  } catch (err) {
    showError(err, `Could not delete the ${kindNoun(item.kind)}`)
  }
}

export async function deleteSelected(doc: DocumentModel) {
  const sel = selectedItem(doc)
  if (sel) await deleteItem(doc, sel)
}

export async function changeSize(doc: DocumentModel, item: FillSignItem, dir: 1 | -1) {
  try {
    await flushIfEditing(doc, item)
    const size = stepSize(item.size, dir)
    const next = await fsOps(doc).setSize(item.id, size, item.kind, item.page)
    noteEdit(next)
    selectItem(doc, next.page, next.id, next.kind)
    if (isTextKind(item.kind)) useFillSign.setState({ textSize: next.size })
    return next
  } catch (err) {
    showError(err, 'Could not change the size')
    return null
  }
}

export async function changeColor(doc: DocumentModel, item: FillSignItem, color: string) {
  try {
    await flushIfEditing(doc, item)
    const next = await fsOps(doc).setColor(item.id, color, item.page)
    noteEdit(next)
  } catch (err) {
    showError(err, 'Could not change the colour')
  }
}

export async function convertItem(doc: DocumentModel, item: FillSignItem, kind: TextKind | MarkKind) {
  if (kind === item.kind) return
  try {
    const e = useFillSign.getState().editing
    if (e && e.docId === doc.id && e.id === item.id) useFillSign.setState({ editing: null })
    const text = kind === 'date' && !isTextKind(item.kind) ? formatToday(navigator.language) : undefined
    const next = await fsOps(doc).convert(item.id, kind, { text }, item.page)
    selectItem(doc, next.page, next.id, next.kind)
    if (isTextKind(next.kind) && !next.text) {
      useFillSign.setState({ editing: { docId: doc.id, page: next.page, id: next.id, isNew: false, edits: 0, item: next } })
    }
  } catch (err) {
    showError(err, `Could not change it to a ${kindNoun(kind)}`)
  }
}

export async function moveItem(doc: DocumentModel, item: FillSignItem, dx: number, dy: number) {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return item
  try {
    await flushIfEditing(doc, item)
    const next = await fsOps(doc).move(item.id, dx, dy, item.kind, item.page)
    noteEdit(next)
    selectItem(doc, next.page, next.id, next.kind)
    return next
  } catch (err) {
    showError(err, `Could not move the ${kindNoun(item.kind)}`)
    return null
  }
}

export async function resizeItem(doc: DocumentModel, item: FillSignItem, rect: Rect) {
  try {
    await flushIfEditing(doc, item)
    const next = await fsOps(doc).resize(item.id, rect, item.kind, item.page)
    noteEdit(next)
    selectItem(doc, next.page, next.id, next.kind)
    return next
  } catch (err) {
    showError(err, `Could not resize the ${kindNoun(item.kind)}`)
    return null
  }
}

// ---- signatures --------------------------------------------------------------------------------

/** Natural placement size of a signature image in points. */
export function naturalSize(kind: SignatureKind, image: SignatureImage, pageWidth: number): [number, number] {
  let h = kind === 'signature' ? SIGNATURE_HEIGHT : INITIALS_HEIGHT
  let w = (h * image.width) / Math.max(1, image.height)
  const maxW = pageWidth * 0.8
  if (w > maxW) {
    h = (h * maxW) / w
    w = maxW
  }
  return [w, h]
}

/** Makes the signature follow the pointer; the next click on a page places it. */
export function startPlacing(kind: SignatureKind, image: SignatureImage) {
  const doc = getActiveDoc()
  if (!doc) {
    toast('Open a PDF first to sign it.')
    return
  }
  const current = useApp.getState().toolId
  useFillSign.setState({
    placing: { kind, image, returnTool: current === PLACE_TOOL ? 'select' : current },
    menu: null
  })
  if (selectedItem(doc)) doc.clearSelection()
  setTool(PLACE_TOOL)
}

export async function placeSignature(doc: DocumentModel, page: number, center: Point) {
  const placing = useFillSign.getState().placing
  if (!placing) return
  const pg = doc.state.info.pages[page]
  if (!pg) return
  const [w, h] = naturalSize(placing.kind, placing.image, pg.width)
  const rect = clampRectToPage(rectAround(center, w, h), pg.width, pg.height)
  try {
    const item = await fsOps(doc).addSignature(page, rect, dataUrlToBytes(placing.image.dataUrl), placing.kind)
    useFillSign.setState({ placing: null })
    setTool(placing.returnTool)
    selectItem(doc, page, item.id, item.kind)
  } catch (err) {
    showError(err, `Could not place your ${placing.kind === 'signature' ? 'signature' : 'initials'}`)
  }
}

export function cancelPlacing() {
  const placing = useFillSign.getState().placing
  useFillSign.setState({ placing: null })
  if (useApp.getState().toolId === PLACE_TOOL) setTool(placing?.returnTool ?? 'select')
}

