import type { Point, Rect } from '@shared/geometry'
import { getActiveDoc, openToolGroup, prompt, registry, setTool, showError, toast, useApp, type DocumentModel } from '@renderer/sdk'
import {
  clampRectToPage,
  clampSpacing,
  formatToday,
  INITIALS_HEIGHT,
  isDraftId,
  isTextKind,
  kindNoun,
  LINE_HEIGHT,
  markDimensions,
  newDraftId,
  rectAround,
  SIGNATURE_HEIGHT,
  stepSize,
  textBox,
  textTopLeft,
  type FillSignItem,
  type FillSignKind,
  type MarkKind,
  type SignatureKind,
  type TextKind
} from './shared'
import {
  dataUrlToBytes,
  draftCommits,
  fsOps,
  selectedItem,
  selectItem,
  useFillSign,
  type EditingState,
  type SelectedItem,
  type SignatureImage
} from './state'
import { commitActiveEditor, flushEditor } from './TextEditor'

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

// ---- drafts ----------------------------------------------------------------------------------

function draftItem(page: number, kind: TextKind, topLeft: Point, text: string, size: number, color: string): FillSignItem {
  const rect = textBox(topLeft, text, size)
  return { id: newDraftId(), page, kind, rect, bounds: rect, text, size, color, spacing: 0, locked: false }
}

/** The editing state of a draft that is still being typed. */
function openDraft(doc: DocumentModel, id: number): EditingState | null {
  const e = useFillSign.getState().editing
  return e && e.draft && e.docId === doc.id && e.id === id && !draftCommits.has(id) ? e : null
}

function updateDraft(doc: DocumentModel, e: EditingState, patch: Partial<FillSignItem>): FillSignItem {
  const merged = { ...e.item, ...patch }
  const rect = textBox([merged.rect[0], merged.rect[1]], merged.text, merged.size)
  const item = { ...merged, rect, bounds: rect }
  useFillSign.setState({ editing: { ...e, item } })
  selectItem(doc, item.page, item.id, item.kind)
  return item
}

type Target = { draft: EditingState } | { item: FillSignItem } | null

/** What an action on `item` should change: the open draft, or an item in the document. */
async function target(doc: DocumentModel, item: FillSignItem | (SelectedItem & { page: number })): Promise<Target> {
  if (!isDraftId(item.id)) return { item: item as FillSignItem }
  const draft = openDraft(doc, item.id)
  if (draft) return { draft }
  const created = await draftCommits.get(item.id)
  return created ? { item: created } : null
}

// ---- creating ----------------------------------------------------------------------------------

/** Adds an item where the user clicked with a Fill & Sign tool. Text and dates open for typing. */
export async function createAt(doc: DocumentModel, page: number, point: Point, kind: TextKind | MarkKind) {
  const { textSize, color } = useFillSign.getState()
  if (isTextKind(kind)) {
    const pg = doc.state.info.pages[page]
    if (!pg) return
    const text = kind === 'date' ? formatToday(navigator.language) : ''
    const item = draftItem(page, kind, textTopLeft(point, textSize, pg.width, pg.height), text, textSize, color)
    selectItem(doc, page, item.id, item.kind)
    useFillSign.setState({ editing: { docId: doc.id, page, id: item.id, draft: true, item } })
    return
  }
  try {
    const item = await fsOps(doc).addMark(page, point, kind, { size: textSize, color })
    selectItem(doc, page, item.id, item.kind)
  } catch (err) {
    showError(err, `Could not add the ${kindNoun(kind)}`)
  }
}

/** Starts typing into an existing text or date item. */
export function startEditing(doc: DocumentModel, item: FillSignItem) {
  if (!isTextKind(item.kind) || isDraftId(item.id)) return
  if (item.locked) {
    toast('This text is locked and cannot be edited.')
    return
  }
  selectItem(doc, item.page, item.id, item.kind)
  useFillSign.setState({ editing: { docId: doc.id, page: item.page, id: item.id, draft: false, item } })
}

/** Records the new state of the item being edited after an engine change. */
export function noteEdit(next?: FillSignItem) {
  const e = useFillSign.getState().editing
  if (!e || !next || next.id !== e.id) return
  useFillSign.setState({ editing: { ...e, item: next, page: next.page } })
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
    const t = await target(doc, item as FillSignItem)
    if (!t) return
    if ('draft' in t) {
      useFillSign.setState({ editing: null })
      doc.clearSelection()
      return
    }
    const e = useFillSign.getState().editing
    if (e && e.docId === doc.id && e.id === t.item.id) useFillSign.setState({ editing: null })
    await fsOps(doc).remove([t.item.id], t.item.kind, t.item.page)
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
    const t = await target(doc, item)
    if (!t) return null
    if ('draft' in t) {
      const next = updateDraft(doc, t.draft, { size: stepSize(t.draft.item.size, dir) })
      useFillSign.setState({ textSize: next.size })
      return next
    }
    await flushIfEditing(doc, t.item)
    const next = await fsOps(doc).setSize(t.item.id, stepSize(t.item.size, dir), t.item.kind, t.item.page)
    noteEdit(next)
    selectItem(doc, next.page, next.id, next.kind)
    if (isTextKind(next.kind)) useFillSign.setState({ textSize: next.size })
    return next
  } catch (err) {
    showError(err, 'Could not change the size')
    return null
  }
}

export async function changeColor(doc: DocumentModel, item: FillSignItem, color: string) {
  try {
    const t = await target(doc, item)
    if (!t) return
    if ('draft' in t) {
      updateDraft(doc, t.draft, { color })
      return
    }
    await flushIfEditing(doc, t.item)
    noteEdit(await fsOps(doc).setColor(t.item.id, color, t.item.page))
  } catch (err) {
    showError(err, 'Could not change the colour')
  }
}

/** Sets the extra space between the letters of a text item (points; 0 = normal). */
export async function changeSpacing(doc: DocumentModel, item: FillSignItem, spacing: number) {
  try {
    const t = await target(doc, item)
    if (!t) return
    if ('draft' in t) {
      updateDraft(doc, t.draft, { spacing: clampSpacing(spacing, t.draft.item.size) })
      return
    }
    await flushIfEditing(doc, t.item)
    const next = await fsOps(doc).setSpacing(t.item.id, spacing, t.item.page)
    noteEdit(next)
    selectItem(doc, next.page, next.id, next.kind)
  } catch (err) {
    showError(err, 'Could not change the letter spacing')
  }
}

/** Asks for a letter spacing in points (for boxed "comb" fields that need an exact pitch). */
export async function askSpacing(doc: DocumentModel, item: FillSignItem) {
  // write the typed text first: the dialog takes the focus away from the editor
  if (!isDraftId(item.id)) await flushIfEditing(doc, item)
  const max = Math.round(item.size * 4 * 100) / 100
  const value = await prompt({
    title: 'Letter spacing',
    label: 'Extra space between letters, in points',
    message: 'To fill a row of boxes, use the box width minus the width of one letter.',
    initial: String(item.spacing || ''),
    placeholder: '0',
    okLabel: 'Apply',
    validate: (v) => {
      const n = v.trim() === '' ? 0 : Number(v.replace(',', '.'))
      return Number.isFinite(n) && n >= 0 && n <= max ? null : `Enter a number from 0 to ${max}`
    }
  })
  if (value === null) return
  await changeSpacing(doc, item, value.trim() === '' ? 0 : Number(value.replace(',', '.')))
}

export async function convertItem(doc: DocumentModel, item: FillSignItem, kind: TextKind | MarkKind) {
  if (kind === item.kind) return
  try {
    const t = await target(doc, item)
    if (!t) return
    if ('draft' in t) {
      const d = t.draft.item
      if (isTextKind(kind)) {
        updateDraft(doc, t.draft, { kind })
        return
      }
      // a draft has no text in the document yet: put the mark where the text would start
      useFillSign.setState({ editing: null })
      const [w] = markDimensions(kind, d.size)
      const center: Point = [d.rect[0] + w / 2, d.rect[1] + (d.size * LINE_HEIGHT) / 2]
      const mark = await fsOps(doc).addMark(d.page, center, kind, { size: d.size, color: d.color })
      selectItem(doc, mark.page, mark.id, mark.kind)
      return
    }
    const real = t.item
    const e = useFillSign.getState().editing
    if (e && e.docId === doc.id && e.id === real.id) useFillSign.setState({ editing: null })
    const text = kind === 'date' && !isTextKind(real.kind) ? formatToday(navigator.language) : undefined
    const next = await fsOps(doc).convert(real.id, kind, { text }, real.page)
    selectItem(doc, next.page, next.id, next.kind)
    if (isTextKind(next.kind) && !next.text) {
      useFillSign.setState({ editing: { docId: doc.id, page: next.page, id: next.id, draft: false, item: next } })
    }
  } catch (err) {
    showError(err, `Could not change it to a ${kindNoun(kind)}`)
  }
}

export async function moveItem(doc: DocumentModel, item: FillSignItem, dx: number, dy: number) {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return item
  if (isDraftId(item.id)) return item
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
  if (isDraftId(item.id)) return item
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
  void commitActiveEditor()
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

