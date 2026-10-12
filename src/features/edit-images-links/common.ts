import { create } from 'zustand'
import type { Matrix, Rect } from '@shared/geometry'
import { registry, setTool, useApp, type DocumentModel } from '@renderer/sdk'
import type engineOps from './engine'
import type { LinkItem, PageImage } from './engine'

export const FEATURE_ID = 'edit-images-links'
export const IMAGE_SELECTION = 'edit-images-links:image'
export const LINK_SELECTION = 'edit-images-links:link'
export const EDIT_CONTENT_TOOL = 'edit.content'
export const ADD_IMAGE_TOOL = 'edit.addImage'
export const LINK_TOOL = 'edit.link'

export function ops(doc: DocumentModel, onProgress?: (fraction: number, message?: string) => void) {
  return doc.ops<typeof engineOps>(FEATURE_ID, onProgress ? { onProgress } : undefined)
}

export interface ImageSelection {
  kind: 'custom'
  type: typeof IMAGE_SELECTION
  page: number
  data: PageImage
}

export interface LinkSelection {
  kind: 'custom'
  type: typeof LINK_SELECTION
  page: number
  data: LinkItem
}

export function selectedImage(doc: DocumentModel | null | undefined): ImageSelection | null {
  const s = doc?.state.selection
  return s && s.kind === 'custom' && s.type === IMAGE_SELECTION ? (s as ImageSelection) : null
}

export function selectedLink(doc: DocumentModel | null | undefined): LinkSelection | null {
  const s = doc?.state.selection
  return s && s.kind === 'custom' && s.type === LINK_SELECTION ? (s as LinkSelection) : null
}

export function selectImage(doc: DocumentModel, page: number, image: PageImage | null) {
  if (image) doc.setSelection({ kind: 'custom', type: IMAGE_SELECTION, page, data: image })
  else if (selectedImage(doc)) doc.clearSelection()
}

export function selectLink(doc: DocumentModel, page: number, link: LinkItem | null) {
  if (link) doc.setSelection({ kind: 'custom', type: LINK_SELECTION, page, data: link })
  else if (selectedLink(doc)) doc.clearSelection()
}

export const refOf = (i: PageImage) => ({ index: i.index, xref: i.xref, loc: i.loc })

/** Error code of an engine call failure. */
export function errorCode(err: unknown): string | null {
  return typeof err === 'object' && err && 'code' in err ? String((err as { code: unknown }).code) : null
}

/** Transient UI state shared between the layers of all pages. */
interface UiState {
  /** Image being cropped: doc id + page + loc key. */
  crop: { docId: string; page: number; key: string } | null
  /** Image chosen for the Add Image tool, waiting to be placed. */
  pending: PendingImage | null
  /** "Create Go to View" flow: waiting for the user to navigate and press Set Link. */
  goToView: GoToViewRequest | null
  /** Ids of images whose edit is being committed (keeps the drag preview visible meanwhile). */
  busyKey: string | null
}

export interface PendingImage {
  bytes: Uint8Array
  name: string
  width: number
  height: number
  dpiX: number
  dpiY: number
  /** Object URL for the cursor preview. */
  url: string
}

export interface GoToViewRequest {
  docId: string
  onSet: (dest: { page: number; x: number; y: number; zoom: number }) => void | Promise<void>
  onCancel: () => void
}

export const useUi = create<UiState>(() => ({ crop: null, pending: null, goToView: null, busyKey: null }))

export const imageKey = (i: PageImage) => `${i.xref}:${i.loc.join('/')}`

let menuClosedAt = 0
useApp.subscribe((s, prev) => {
  if (prev.contextMenu && !s.contextMenu) menuClosedAt = performance.now()
})

/** True while a context menu is open, or when this very key press just closed it (its listener may run first). */
export function contextMenuActive(): boolean {
  return !!useApp.getState().contextMenu || performance.now() - menuClosedAt < 80
}

/** True while something else owns the keyboard: a dialog, the command palette or a context menu. */
export function keyboardTaken(e: KeyboardEvent): boolean {
  const s = useApp.getState()
  if (contextMenuActive()) {
    // Escape only closes the menu: keep it from also leaving the current tool
    if (e.key === 'Escape') e.preventDefault()
    return true
  }
  return !!s.dialogs.length || s.paletteOpen
}

/** The tool to return to after placing an image or cancelling: Edit text & images if available. */
export function returnToEditTool() {
  setTool(registry.tools.has(EDIT_CONTENT_TOOL) ? EDIT_CONTENT_TOOL : 'select')
}

// ---- page-space matrices ------------------------------------------------------------------------

export function translation(dx: number, dy: number): Matrix {
  return [1, 0, 0, 1, dx, dy]
}

/** Maps rectangle `a` onto rectangle `b` (page space). */
export function rectToRect(a: Rect, b: Rect): Matrix {
  const sx = (b[2] - b[0]) / Math.max(1e-6, a[2] - a[0])
  const sy = (b[3] - b[1]) / Math.max(1e-6, a[3] - a[1])
  return [sx, 0, 0, sy, b[0] - a[0] * sx, b[1] - a[1] * sy]
}

/** Rotation by `degrees` clockwise on screen around point (cx, cy) of page space. */
export function rotationAbout(degrees: number, cx: number, cy: number): Matrix {
  const r = (degrees * Math.PI) / 180
  const c = Math.abs(Math.cos(r)) < 1e-12 ? 0 : Math.cos(r)
  const s = Math.abs(Math.sin(r)) < 1e-12 ? 0 : Math.sin(r)
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]
}

/** Mirror around the centre of a rectangle. */
export function flipAbout(axis: 'horizontal' | 'vertical', r: Rect): Matrix {
  const cx = (r[0] + r[2]) / 2
  const cy = (r[1] + r[3]) / 2
  return axis === 'horizontal' ? [-1, 0, 0, 1, 2 * cx, 0] : [1, 0, 0, -1, 0, 2 * cy]
}

export function rectCenter(r: Rect): [number, number] {
  return [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2]
}

export const UNITS: Record<'pt' | 'in' | 'mm' | 'cm', { label: string; perPoint: number; step: number; digits: number }> = {
  pt: { label: 'pt', perPoint: 1, step: 1, digits: 1 },
  in: { label: 'in', perPoint: 1 / 72, step: 0.01, digits: 2 },
  mm: { label: 'mm', perPoint: 25.4 / 72, step: 0.5, digits: 1 },
  cm: { label: 'cm', perPoint: 2.54 / 72, step: 0.05, digits: 2 }
}
