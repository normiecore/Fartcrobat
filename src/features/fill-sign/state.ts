import { create } from 'zustand'
import type { Point } from '@shared/geometry'
import { getActiveDoc, invoke, setHiddenAnnotations, showError, type DocumentModel } from '@renderer/sdk'
import { DEFAULT_COLOR, DEFAULT_TEXT_SIZE, SELECTION_TYPE, clampSize, type FillSignItem, type FillSignKind, type SignatureKind } from './shared'
import type ops from './engine'

export const STORE_KEYS = {
  signature: 'fill-sign:signature',
  initials: 'fill-sign:initials',
  textSize: 'fill-sign:textSize',
  color: 'fill-sign:color'
} as const

/** A signature or initials image: a transparent PNG data URL and its pixel size. */
export interface SignatureImage {
  dataUrl: string
  width: number
  height: number
}

export interface EditingState {
  docId: string
  page: number
  id: number
  /**
   * New text that is not in the document yet: it is added as one "Add Text" step when the typing
   * is finished, and nothing is added if it is left empty. Size, colour and spacing changes made
   * meanwhile only change `item`.
   */
  draft: boolean
  /** Latest known state of the item (the page's item list may not have caught up yet). */
  item: FillSignItem
}

export interface PlacingState {
  kind: SignatureKind
  image: SignatureImage
  /** Tool to return to after placing. */
  returnTool: string
}

interface FillSignState {
  loaded: boolean
  signature: SignatureImage | null
  initials: SignatureImage | null
  /** Default size for new text and marks (Preferences > Signatures, A-/A+ with nothing selected). */
  textSize: number
  /** Colour for new text and marks. */
  color: string
  editing: EditingState | null
  placing: PlacingState | null
  /** The "Sign yourself" menu, open at a screen position. */
  menu: { x: number; y: number } | null
  /** Pointer position over a page while a mark tool is active (for the hover preview). */
  hover: { docId: string; page: number; point: Point } | null
}

export const useFillSign = create<FillSignState>(() => ({
  loaded: false,
  signature: null,
  initials: null,
  textSize: DEFAULT_TEXT_SIZE,
  color: DEFAULT_COLOR,
  editing: null,
  placing: null,
  menu: null,
  hover: null
}))

export type FillSignOps = typeof ops

export function fsOps(doc: DocumentModel) {
  return doc.ops<FillSignOps>('fill-sign')
}

// ---- drafts ----------------------------------------------------------------------------------

/**
 * Commits of drafts that are under way, by draft id. An action that reaches a draft while its
 * commit is running (e.g. a menu click that took the focus from the editor) waits for it and then
 * acts on the created item (null when the draft was empty and nothing was added).
 */
export const draftCommits = new Map<number, Promise<FillSignItem | null>>()

export function trackDraftCommit(id: number, commit: Promise<FillSignItem | null>) {
  draftCommits.set(id, commit)
  const forget = () => void setTimeout(() => draftCommits.delete(id), 5000)
  commit.then(forget, forget)
}

// ---- selection -------------------------------------------------------------------------------

export interface SelectedItem {
  id: number
  kind: FillSignKind
}

export function selectedItem(doc: DocumentModel | null): (SelectedItem & { page: number }) | null {
  const sel = doc?.state.selection
  if (!sel || sel.kind !== 'custom' || sel.type !== SELECTION_TYPE) return null
  const data = sel.data as SelectedItem
  return { ...data, page: sel.page }
}

export function selectItem(doc: DocumentModel, page: number, id: number, kind: FillSignKind) {
  doc.setSelection({ kind: 'custom', type: SELECTION_TYPE, page, data: { id, kind } satisfies SelectedItem })
}

// ---- saved signatures ------------------------------------------------------------------------

/** Reads a data URL's pixel size. */
export function imageSize(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => reject(new Error('The saved image could not be read'))
    img.src = dataUrl
  })
}

async function toImage(value: unknown): Promise<SignatureImage | null> {
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return null
  try {
    const { width, height } = await imageSize(value)
    if (!width || !height) return null
    return { dataUrl: value, width, height }
  } catch {
    return null
  }
}

let loading: Promise<void> | null = null

/** Loads saved signatures and defaults from the settings store (once). */
export function loadSaved(force = false): Promise<void> {
  if (loading && !force) return loading
  loading = (async () => {
    try {
      const [sig, ini, size, color] = await Promise.all([
        invoke('store:get', STORE_KEYS.signature),
        invoke('store:get', STORE_KEYS.initials),
        invoke('store:get', STORE_KEYS.textSize),
        invoke('store:get', STORE_KEYS.color)
      ])
      useFillSign.setState({
        loaded: true,
        signature: await toImage(sig),
        initials: await toImage(ini),
        textSize: typeof size === 'number' && size > 0 ? clampSize(size) : DEFAULT_TEXT_SIZE,
        color: typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_COLOR
      })
    } catch (err) {
      useFillSign.setState({ loaded: true })
      showError(err, 'Could not load your saved signatures')
    }
  })()
  return loading
}

/** Saves (or with null, deletes) the stored signature or initials. */
export async function saveSignature(kind: SignatureKind, image: SignatureImage | null) {
  useFillSign.setState(kind === 'signature' ? { signature: image } : { initials: image })
  try {
    await invoke('store:set', STORE_KEYS[kind], image ? image.dataUrl : undefined)
  } catch (err) {
    showError(err, `Could not save your ${kind === 'signature' ? 'signature' : 'initials'}`)
  }
}

export async function setDefaultTextSize(size: number) {
  const v = clampSize(size)
  useFillSign.setState({ textSize: v })
  try {
    await invoke('store:set', STORE_KEYS.textSize, v)
  } catch (err) {
    showError(err, 'Could not save the default text size')
  }
}

export async function setDefaultColor(color: string) {
  useFillSign.setState({ color })
  try {
    await invoke('store:set', STORE_KEYS.color, color)
  } catch (err) {
    showError(err, 'Could not save the colour')
  }
}

// ---- hiding items while a live preview replaces them -------------------------------------------

const hidden = new Map<string, Set<number>>()

function syncHidden(doc: DocumentModel, page: number) {
  const set = hidden.get(`${doc.id}:${page}`)
  setHiddenAnnotations(doc, page, set ? [...set] : [])
}

/** Leaves an item out of the page rendering (the editor or a drag preview shows it instead). */
export function hideItem(doc: DocumentModel, page: number, id: number) {
  const key = `${doc.id}:${page}`
  const set = hidden.get(key) ?? new Set<number>()
  set.add(id)
  hidden.set(key, set)
  syncHidden(doc, page)
}

export function unhideItem(doc: DocumentModel, page: number, id: number) {
  const set = hidden.get(`${doc.id}:${page}`)
  if (!set?.delete(id)) return
  syncHidden(doc, page)
}

// ---- misc ------------------------------------------------------------------------------------

export function activeDocOrNull(): DocumentModel | null {
  return getActiveDoc()
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()))
}

/**
 * Resolves once a page re-render requested after a change has most likely been painted: lets
 * React commit, then waits for the engine to answer a cheap call queued behind the render.
 * Used to keep live previews on screen until the real rendering replaces them (no flicker).
 */
export async function waitForRepaint(doc: DocumentModel, minMs = 60): Promise<void> {
  const start = performance.now()
  await nextFrame()
  await nextFrame()
  try {
    await doc.core.doc.isDirty()
  } catch {}
  await nextFrame()
  const left = minMs - (performance.now() - start)
  if (left > 0) await new Promise((r) => setTimeout(r, left))
}

/** PNG data URL -> bytes. */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',')
  const b64 = dataUrl.slice(comma + 1)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
