import type { Rect } from '@shared/geometry'
import {
  ask,
  getActiveDoc,
  openToolGroup,
  setTool,
  showError,
  toast,
  useApp,
  type DocumentModel,
  type Selection
} from '@renderer/sdk'
import type pfOps from '../engine'
import { DEFAULT_SIZE, SELECTION_TYPE, TYPE_LABELS, type FieldProps, type PFField, type PFType, type TabOrder } from '../model'
import { usePF } from './state'

export const pf = (doc: DocumentModel) => doc.ops<typeof pfOps>('prepare-form')

export const TOOL_TYPES: Record<string, PFType> = {
  'form.text': 'text',
  'form.checkbox': 'checkbox',
  'form.radio': 'radio',
  'form.list': 'list',
  'form.dropdown': 'combo',
  'form.button': 'button',
  'form.signature': 'signature',
  'form.date': 'date'
}

export const TYPE_TOOLS: Record<PFType, string> = Object.fromEntries(Object.entries(TOOL_TYPES).map(([k, v]) => [v, k])) as Record<PFType, string>

export const isFormTool = (id: string) => id.startsWith('form.')

// ---- selection ------------------------------------------------------------------------------

export function fieldSelection(sel: Selection): { page: number; ids: number[] } | null {
  if (sel.kind !== 'custom' || sel.type !== SELECTION_TYPE) return null
  const ids = (sel.data as { ids?: number[] } | null)?.ids ?? []
  return { page: sel.page, ids }
}

export function selectedIds(doc: DocumentModel | null): number[] {
  if (!doc) return []
  return fieldSelection(doc.state.selection)?.ids ?? []
}

export function selectFields(doc: DocumentModel, page: number, ids: number[]) {
  if (!ids.length) {
    clearFieldSelection(doc)
    return
  }
  doc.setSelection({ kind: 'custom', type: SELECTION_TYPE, page, data: { ids } })
}

export function clearFieldSelection(doc: DocumentModel) {
  if (fieldSelection(doc.state.selection)) doc.setSelection({ kind: 'none' })
}

/** Refreshes DocInfo (hasForm) after the first field was added or the last one removed. */
export async function refreshInfo(doc: DocumentModel) {
  try {
    const info = await doc.core.doc.info()
    doc.set({ info })
  } catch {}
}

/** Makes sure the form editing mode is on (opens "Prepare a form" when another group is open). */
export function enterFormEditing(tool = 'form.select') {
  const s = useApp.getState()
  if (s.toolGroupId !== 'prepareform' && s.toolGroupId !== 'requestsign') openToolGroup('prepareform')
  setTool(tool)
}

// ---- creating -----------------------------------------------------------------------------

export async function createField(doc: DocumentModel, type: PFType, page: number, rect: Rect): Promise<PFField | null> {
  const st = usePF.getState()
  let name: string | undefined
  const props: FieldProps = {}
  if (type === 'radio' && st.radioGroup) name = st.radioGroup
  const signer = st.pendingSigner
  if (signer && (type === 'signature' || type === 'date')) {
    // periods would make a field hierarchy ("J. Smith" -> "J" > " Smith")
    const who = signer.name.replace(/\./g, '').replace(/\s+/g, ' ').trim() || 'signer'
    name = type === 'signature' ? `Signature ${who}` : `Date ${who}`
    props.tooltip = type === 'signature' ? `Signature of ${signer.name}` : `Date signed by ${signer.name}`
    if (type === 'signature') props.required = true
  }
  try {
    const f = await pf(doc).create({ type, page, rect, name, props })
    selectFields(doc, page, [f.id])
    usePF.setState({ inline: signer ? null : { docId: doc.id, id: f.id, page }, radioGroup: null, pendingSigner: null })
    if (!useApp.getState().prefs.keepToolSelected) setTool('form.select')
    if (!doc.state.info.hasForm) void refreshInfo(doc)
    return f
  } catch (err) {
    showError(err, `Could not add the ${TYPE_LABELS[type].toLowerCase()}`)
    return null
  }
}

/**
 * Places a field of default size in the middle of what is on screen (Enter while a field tool is
 * active), so fields can be added without a mouse.
 */
export async function placeInView(doc: DocumentModel, type: PFType): Promise<PFField | null> {
  let page = doc.state.currentPage
  let point: [number, number] | null = null
  const vp = doc.view?.getViewportElement()
  if (vp) {
    const b = vp.getBoundingClientRect()
    const hit = doc.view?.hitTest(b.left + b.width / 2, b.top + b.height / 2)
    if (hit) {
      page = hit.pageIndex
      point = hit.point
    }
  }
  const pg = doc.state.info.pages[page]
  if (!pg) return null
  const [w, h] = DEFAULT_SIZE[type]
  const cx = point?.[0] ?? pg.width / 2
  const cy = point?.[1] ?? pg.height / 2
  const x = Math.max(0, Math.min(pg.width - w, cx - w / 2))
  const y = Math.max(0, Math.min(pg.height - h, cy - h / 2))
  return createField(doc, type, page, [x, y, x + w, y + h])
}

// ---- editing ------------------------------------------------------------------------------

/** Renames a field, asking before two fields would share a name (and value). */
export async function renameField(doc: DocumentModel, id: number, name: string): Promise<boolean> {
  try {
    await pf(doc).rename(id, name)
    return true
  } catch (err) {
    if ((err as { code?: string }).code !== 'NAME_SHARED') {
      showError(err, 'Could not rename the field')
      return false
    }
  }
  const answer = await ask({
    title: 'Use the same name?',
    message: `A field named “${name}” already exists. Fields with the same name always show the same value — useful for repeating a name or a date on several pages. Use this name anyway?`,
    buttons: [
      { id: 'cancel', label: 'Cancel' },
      { id: 'join', label: 'Use the same name', variant: 'primary' }
    ]
  })
  if (answer !== 'join') return false
  try {
    await pf(doc).rename(id, name, { join: true })
    return true
  } catch (err) {
    showError(err, 'Could not rename the field')
    return false
  }
}

export async function updateFields(doc: DocumentModel, ids: number[], props: FieldProps): Promise<boolean> {
  try {
    await pf(doc).update(ids, props)
    return true
  } catch (err) {
    showError(err, 'Could not change the field')
    return false
  }
}

export async function deleteFields(doc: DocumentModel, ids: number[]) {
  if (!ids.length) return
  try {
    await pf(doc).delete(ids)
    clearFieldSelection(doc)
    const inline = usePF.getState().inline
    if (inline && ids.includes(inline.id)) usePF.setState({ inline: null })
    void refreshInfo(doc)
  } catch (err) {
    showError(err, 'Could not delete the field')
  }
}

export async function deleteSelected(doc: DocumentModel) {
  await deleteFields(doc, selectedIds(doc))
}

export async function duplicateSelected(doc: DocumentModel) {
  const sel = fieldSelection(doc.state.selection)
  if (!sel?.ids.length) return
  try {
    const created = await pf(doc).duplicate(sel.ids, { offset: [12, 12] })
    selectFields(doc, sel.page, created.map((f) => f.id))
  } catch (err) {
    showError(err, 'Could not duplicate the field')
  }
}

export async function duplicateAcrossPages(doc: DocumentModel, ids: number[], pages: number[]) {
  try {
    const created = await pf(doc).duplicate(ids, { pages })
    toast(created.length === 1 ? 'Added 1 copy. Copies share the same name and value.' : `Added ${created.length} copies. Copies share the same name and value.`, { kind: 'success' })
  } catch (err) {
    showError(err, 'Could not duplicate the field')
  }
}

export async function copySelected(doc: DocumentModel) {
  const sel = fieldSelection(doc.state.selection)
  if (!sel?.ids.length) return
  try {
    const clips = await pf(doc).copy(sel.ids)
    usePF.setState({ clipboard: clips, clipboardPage: sel.page })
    toast(clips.length === 1 ? 'Copied 1 field' : `Copied ${clips.length} fields`, { timeout: 1500 })
  } catch (err) {
    showError(err, 'Could not copy')
  }
}

export async function pasteFields(doc: DocumentModel, page?: number) {
  const { clipboard: clips, clipboardPage } = usePF.getState()
  if (!clips?.length) return
  const target = page ?? doc.view?.visiblePages()[0] ?? doc.state.currentPage
  // pasting onto the page the fields came from: shift them so they do not cover the originals
  const d = target === clipboardPage ? 12 : 0
  try {
    const created = await pf(doc).paste(target, clips, [d, d])
    selectFields(doc, target, created.map((f) => f.id))
    usePF.setState({
      clipboard: clips.map((c) => ({ ...c, rect: [c.rect[0] + d, c.rect[1] + d, c.rect[2] + d, c.rect[3] + d] as Rect })),
      clipboardPage: target
    })
    if (!doc.state.info.hasForm) void refreshInfo(doc)
  } catch (err) {
    showError(err, 'Could not paste')
  }
}

export async function nudgeSelected(doc: DocumentModel, dx: number, dy: number) {
  const ids = selectedIds(doc)
  if (!ids.length) return
  try {
    await pf(doc).move(ids, dx, dy)
  } catch (err) {
    showError(err, 'Could not move the field')
  }
}

export async function selectAllFields(doc: DocumentModel, page?: number) {
  const p = page ?? doc.state.currentPage
  try {
    const fields = await pf(doc).listPage(p)
    selectFields(doc, p, fields.map((f) => f.id))
    if (!fields.length) toast('There are no fields on this page.')
  } catch (err) {
    showError(err)
  }
}

// ---- arranging ----------------------------------------------------------------------------

export type ArrangeMode =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'center-x'
  | 'center-y'
  | 'page-center-x'
  | 'page-center-y'
  | 'page-center-both'
  | 'distribute-x'
  | 'distribute-y'
  | 'match-width'
  | 'match-height'
  | 'match-both'

/** New rectangles for an arrange command; `anchor` is the field the others follow. */
export function arrangeRects(fields: PFField[], anchor: PFField, mode: ArrangeMode, pageSize: [number, number]): { id: number; rect: Rect }[] {
  const a = anchor.rect
  const out: { id: number; rect: Rect }[] = []
  const move = (f: PFField, dx: number, dy: number) => out.push({ id: f.id, rect: [f.rect[0] + dx, f.rect[1] + dy, f.rect[2] + dx, f.rect[3] + dy] })
  const w = (r: Rect) => r[2] - r[0]
  const h = (r: Rect) => r[3] - r[1]
  if (mode === 'distribute-x' || mode === 'distribute-y') {
    const k = mode === 'distribute-x' ? 0 : 1
    const sorted = [...fields].sort((p, q) => p.rect[k] - q.rect[k])
    if (sorted.length < 3) return out
    const first = sorted[0].rect
    const last = sorted[sorted.length - 1].rect
    const total = sorted.reduce((sum, f) => sum + (k === 0 ? w(f.rect) : h(f.rect)), 0)
    const span = last[k + 2] - first[k]
    const gap = (span - total) / (sorted.length - 1)
    let pos = first[k]
    for (const f of sorted) {
      const d = pos - f.rect[k]
      if (k === 0) move(f, d, 0)
      else move(f, 0, d)
      pos += (k === 0 ? w(f.rect) : h(f.rect)) + gap
    }
    return out
  }
  for (const f of fields) {
    const r = f.rect
    switch (mode) {
      case 'left':
        move(f, a[0] - r[0], 0)
        break
      case 'right':
        move(f, a[2] - r[2], 0)
        break
      case 'top':
        move(f, 0, a[1] - r[1])
        break
      case 'bottom':
        move(f, 0, a[3] - r[3])
        break
      case 'center-x':
        move(f, (a[0] + a[2]) / 2 - (r[0] + r[2]) / 2, 0)
        break
      case 'center-y':
        move(f, 0, (a[1] + a[3]) / 2 - (r[1] + r[3]) / 2)
        break
      case 'page-center-x': {
        // centre the group as a whole
        const g0 = Math.min(...fields.map((x) => x.rect[0]))
        const g1 = Math.max(...fields.map((x) => x.rect[2]))
        move(f, pageSize[0] / 2 - (g0 + g1) / 2, 0)
        break
      }
      case 'page-center-y': {
        const g0 = Math.min(...fields.map((x) => x.rect[1]))
        const g1 = Math.max(...fields.map((x) => x.rect[3]))
        move(f, 0, pageSize[1] / 2 - (g0 + g1) / 2)
        break
      }
      case 'page-center-both': {
        const g = [Math.min(...fields.map((x) => x.rect[0])), Math.min(...fields.map((x) => x.rect[1])), Math.max(...fields.map((x) => x.rect[2])), Math.max(...fields.map((x) => x.rect[3]))]
        move(f, pageSize[0] / 2 - (g[0] + g[2]) / 2, pageSize[1] / 2 - (g[1] + g[3]) / 2)
        break
      }
      case 'match-width':
        out.push({ id: f.id, rect: [r[0], r[1], r[0] + w(a), r[3]] })
        break
      case 'match-height':
        out.push({ id: f.id, rect: [r[0], r[1], r[2], r[1] + h(a)] })
        break
      case 'match-both':
        out.push({ id: f.id, rect: [r[0], r[1], r[0] + w(a), r[1] + h(a)] })
        break
    }
  }
  return out
}

export async function arrangeSelected(doc: DocumentModel, mode: ArrangeMode, anchorId?: number) {
  const sel = fieldSelection(doc.state.selection)
  if (!sel?.ids.length) return
  try {
    const all = await pf(doc).listPage(sel.page)
    const fields = all.filter((f) => sel.ids.includes(f.id))
    const anchor = fields.find((f) => f.id === anchorId) ?? fields[0]
    const pg = doc.state.info.pages[sel.page]
    const moves = arrangeRects(fields, anchor, mode, [pg.width, pg.height]).filter((m) => {
      const f = fields.find((x) => x.id === m.id)!
      return m.rect.some((v, i) => Math.abs(v - f.rect[i]) > 0.01)
    })
    if (moves.length) await pf(doc).setRects(moves)
  } catch (err) {
    showError(err, 'Could not arrange the fields')
  }
}

export async function setTabOrder(doc: DocumentModel, page: number, order: TabOrder, ids?: number[]) {
  try {
    await pf(doc).setTabOrder(page, order, ids)
  } catch (err) {
    showError(err, 'Could not change the tab order')
  }
}

export function activeDoc(): DocumentModel | null {
  return getActiveDoc()
}
