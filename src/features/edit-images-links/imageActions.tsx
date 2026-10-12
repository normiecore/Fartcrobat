import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronUp,
  ClipboardCopy,
  Crop,
  Download,
  FlipHorizontal2,
  FlipVertical2,
  Layers,
  Replace,
  RotateCcw,
  RotateCw,
  Ruler,
  Trash2
} from 'lucide-react'
import { multiplyMatrix, type Matrix, type Rect } from '@shared/geometry'
import {
  Button,
  Checkbox,
  displayShortcut,
  Dialog,
  Field,
  NumberInput,
  invoke,
  openDialog,
  readFile,
  saveBytesAs,
  showError,
  stripExtension,
  toast,
  useApp,
  type ContextMenuItem,
  type DocumentModel
} from '@renderer/sdk'
import type { ArrangeWhere, PageImage, TransformKind } from './engine'
import {
  UNITS,
  errorCode,
  flipAbout,
  ops,
  rectCenter,
  rectToRect,
  refOf,
  rotationAbout,
  selectImage,
  useUi,
  imageKey,
  translation
} from './common'

export const IMAGE_FILTERS = [
  { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp', 'avif', 'jxr', 'pnm', 'ppm', 'pgm', 'pbm'] },
  { name: 'All files', extensions: ['*'] }
]

/**
 * Turns image file bytes into something the PDF engine can embed. Formats MuPDF does not read
 * (WebP, AVIF...) are decoded by the browser and re-encoded as PNG.
 */
export async function loadImageBytes(
  doc: DocumentModel,
  bytes: Uint8Array
): Promise<{ bytes: Uint8Array; width: number; height: number; dpiX: number; dpiY: number }> {
  try {
    const info = await ops(doc).probeImage(bytes)
    return { bytes, ...info }
  } catch (err) {
    if (errorCode(err) !== 'BAD_IMAGE') throw err
  }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]))
  } catch {
    throw new Error('This file is not an image Fartcrobat can read. Use a PNG, JPEG, GIF, BMP, TIFF or WebP image.')
  }
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  const png = new Uint8Array(await blob.arrayBuffer())
  const info = await ops(doc).probeImage(png)
  return { bytes: png, width: info.width, height: info.height, dpiX: 72, dpiY: 72 }
}

/** Asks for an image file. Returns its path and bytes, or null when cancelled. */
export async function pickImageFile(title: string): Promise<{ path: string; bytes: Uint8Array } | null> {
  const paths = await invoke('file:openDialog', { title, filters: IMAGE_FILTERS })
  if (!paths.length) return null
  return { path: paths[0], bytes: await readFile(paths[0]) }
}

function busy<T>(img: PageImage, fn: () => Promise<T>): Promise<T> {
  useUi.setState({ busyKey: imageKey(img) })
  return fn().finally(() => {
    if (useUi.getState().busyKey === imageKey(img)) useUi.setState({ busyKey: null })
  })
}

/** Applies a page-space transformation and keeps the image selected. */
export async function transformImage(doc: DocumentModel, page: number, img: PageImage, m: Matrix, kind: TransformKind) {
  try {
    const next = await busy(img, () => ops(doc).transformImage(page, refOf(img), m, kind))
    selectImage(doc, page, next)
  } catch (err) {
    showError(err, 'Could not change the image')
  }
}

export function rotateImage(doc: DocumentModel, page: number, img: PageImage, degrees: number) {
  const [cx, cy] = rectCenter(img.visible)
  return transformImage(doc, page, img, rotationAbout(degrees, cx, cy), 'rotate')
}

export function flipImage(doc: DocumentModel, page: number, img: PageImage, axis: 'horizontal' | 'vertical') {
  return transformImage(doc, page, img, flipAbout(axis, img.visible), 'flip')
}

export function nudgeImage(doc: DocumentModel, page: number, img: PageImage, dx: number, dy: number) {
  return transformImage(doc, page, img, translation(dx, dy), 'move')
}

export async function deleteImage(doc: DocumentModel, page: number, img: PageImage) {
  try {
    await ops(doc).deleteImage(page, refOf(img))
    doc.clearSelection()
  } catch (err) {
    showError(err, 'Could not delete the image')
  }
}

export async function replaceImage(doc: DocumentModel, page: number, img: PageImage) {
  try {
    const file = await pickImageFile('Replace Image')
    if (!file) return
    const { bytes } = await loadImageBytes(doc, file.bytes)
    const next = await busy(img, () => ops(doc).replaceImage(page, refOf(img), bytes))
    selectImage(doc, page, next)
  } catch (err) {
    showError(err, 'Could not replace the image')
  }
}

export async function cropImage(doc: DocumentModel, page: number, img: PageImage, rect: Rect) {
  try {
    const next = await busy(img, () => ops(doc).cropImage(page, refOf(img), rect))
    selectImage(doc, page, next)
  } catch (err) {
    showError(err, 'Could not crop the image')
  }
}

export function startCrop(doc: DocumentModel, page: number, img: PageImage) {
  useUi.setState({ crop: { docId: doc.id, page, key: imageKey(img) } })
}

const ARRANGE_DONE: Record<ArrangeWhere, string> = {
  front: 'Brought to front',
  forward: 'Brought forward',
  backward: 'Sent backward',
  back: 'Sent to back'
}

export async function arrangeImage(doc: DocumentModel, page: number, img: PageImage, where: ArrangeWhere) {
  try {
    const next = await ops(doc).arrangeImage(page, refOf(img), where)
    selectImage(doc, page, next)
    toast(ARRANGE_DONE[where], { kind: 'success', timeout: 1500 })
  } catch (err) {
    if (errorCode(err) === 'NO_CHANGE') toast((err as Error).message)
    else showError(err, 'Could not change the order')
  }
}

function suggestedName(doc: DocumentModel, page: number, img: PageImage) {
  return `${stripExtension(doc.state.title)}-page${page + 1}-image${img.index + 1}.png`
}

export async function saveImageAs(doc: DocumentModel, page: number, img: PageImage) {
  try {
    const { png } = await ops(doc).imagePng(page, refOf(img))
    const path = await saveBytesAs(png, suggestedName(doc, page, img), [{ name: 'PNG image', extensions: ['png'] }], 'Save Image As')
    if (path) toast('Image saved', { kind: 'success', timeout: 2000 })
  } catch (err) {
    showError(err, 'Could not save the image')
  }
}

export async function copyImage(doc: DocumentModel, page: number, img: PageImage) {
  try {
    const { png } = await ops(doc).imagePng(page, refOf(img))
    await invoke('clipboard:writeImage', png)
    toast('Image copied to the clipboard', { kind: 'success', timeout: 1500 })
  } catch (err) {
    showError(err, 'Could not copy the image')
  }
}

export function arrangeItems(doc: DocumentModel, page: number, img: PageImage): ContextMenuItem[] {
  return [
    { id: 'front', label: 'Bring to Front', icon: ArrowUpToLine, shortcut: displayShortcut('Mod+Shift+]'), run: () => void arrangeImage(doc, page, img, 'front') },
    { id: 'forward', label: 'Bring Forward', icon: ChevronUp, shortcut: displayShortcut('Mod+]'), run: () => void arrangeImage(doc, page, img, 'forward') },
    { id: 'backward', label: 'Send Backward', icon: ChevronDown, shortcut: displayShortcut('Mod+['), run: () => void arrangeImage(doc, page, img, 'backward') },
    { id: 'back', label: 'Send to Back', icon: ArrowDownToLine, shortcut: displayShortcut('Mod+Shift+['), run: () => void arrangeImage(doc, page, img, 'back') }
  ]
}

/** Right-click menu of an image. */
export function imageMenu(doc: DocumentModel, page: number, img: PageImage): ContextMenuItem[] {
  return [
    { id: 'rotate-cw', label: 'Rotate Clockwise', icon: RotateCw, run: () => void rotateImage(doc, page, img, 90) },
    { id: 'rotate-ccw', label: 'Rotate Counterclockwise', icon: RotateCcw, run: () => void rotateImage(doc, page, img, -90) },
    { id: 'flip-h', label: 'Flip Horizontal', icon: FlipHorizontal2, run: () => void flipImage(doc, page, img, 'horizontal') },
    { id: 'flip-v', label: 'Flip Vertical', icon: FlipVertical2, run: () => void flipImage(doc, page, img, 'vertical') },
    { id: 'sep1', label: '', separator: true },
    { id: 'crop', label: 'Crop Image', icon: Crop, run: () => startCrop(doc, page, img) },
    { id: 'replace', label: 'Replace Image…', icon: Replace, run: () => void replaceImage(doc, page, img) },
    { id: 'props', label: 'Position and Size…', icon: Ruler, run: () => void openImageProperties(doc, page, img) },
    { id: 'sep2', label: '', separator: true },
    { id: 'arrange', label: 'Arrange', icon: Layers, submenu: arrangeItems(doc, page, img) },
    { id: 'sep3', label: '', separator: true },
    { id: 'copy', label: 'Copy Image', icon: ClipboardCopy, run: () => void copyImage(doc, page, img) },
    { id: 'save', label: 'Save Image As…', icon: Download, run: () => void saveImageAs(doc, page, img) },
    { id: 'sep4', label: '', separator: true },
    { id: 'delete', label: 'Delete', icon: Trash2, shortcut: 'Del', danger: true, run: () => void deleteImage(doc, page, img) }
  ]
}

// ---- Position and size dialog ---------------------------------------------------------------

function PropertiesBody({ img, pageSize, close }: { img: PageImage; pageSize: [number, number]; close: (r?: { rect: Rect; rotation: number }) => void }) {
  const units = useApp((s) => s.prefs.measurementUnits)
  const u = UNITS[units] ?? UNITS.pt
  const v = img.visible
  const toU = (pt: number) => Math.round(pt * u.perPoint * 10 ** u.digits) / 10 ** u.digits
  const [x, setX] = useState(toU(v[0]))
  const [y, setY] = useState(toU(v[1]))
  const [w, setW] = useState(toU(v[2] - v[0]))
  const [h, setH] = useState(toU(v[3] - v[1]))
  const [rot, setRot] = useState(0)
  const [keep, setKeep] = useState(true)
  const ratio = (v[2] - v[0]) / Math.max(1e-6, v[3] - v[1])
  const valid = w > 0 && h > 0 && [x, y, w, h, rot].every(Number.isFinite)
  const submit = () => {
    if (!valid) return
    const f = 1 / u.perPoint
    close({ rect: [x * f, y * f, (x + w) * f, (y + h) * f], rotation: rot })
  }
  return (
    <Dialog
      title="Position and Size"
      onClose={() => close()}
      onSubmit={submit}
      width={420}
      footer={
        <>
          <Button onClick={() => close()}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            Apply
          </Button>
        </>
      }
    >
      <div className="fc-edit-images-links-props">
        <p className="fc-edit-images-links-muted">
          {img.width} × {img.height} pixels, {img.dpi} pixels per inch. The page is {toU(pageSize[0])} × {toU(pageSize[1])} {u.label}; positions are
          measured from its top-left corner.
        </p>
        <div className="fc-edit-images-links-grid">
          <Field label={`Left (${u.label})`}>
            <NumberInput value={x} step={u.step} onChange={setX} aria-label="Left" />
          </Field>
          <Field label={`Top (${u.label})`}>
            <NumberInput value={y} step={u.step} onChange={setY} aria-label="Top" />
          </Field>
          <Field label={`Width (${u.label})`}>
            <NumberInput
              value={w}
              min={0}
              step={u.step}
              aria-label="Width"
              onChange={(nw) => {
                setW(nw)
                if (keep) setH(toU(nw / u.perPoint / ratio))
              }}
            />
          </Field>
          <Field label={`Height (${u.label})`}>
            <NumberInput
              value={h}
              min={0}
              step={u.step}
              aria-label="Height"
              onChange={(nh) => {
                setH(nh)
                if (keep) setW(toU((nh / u.perPoint) * ratio))
              }}
            />
          </Field>
          <Field label="Rotate by (degrees, clockwise)">
            <NumberInput value={rot} step={15} min={-360} max={360} onChange={setRot} aria-label="Rotate by" />
          </Field>
        </div>
        <Checkbox checked={keep} onChange={setKeep} label="Keep proportions" />
      </div>
    </Dialog>
  )
}

export async function openImageProperties(doc: DocumentModel, page: number, img: PageImage) {
  const info = doc.state.info.pages[page]
  const r = await openDialog<{ rect: Rect; rotation: number }>((close) => (
    <PropertiesBody img={img} pageSize={[info.width, info.height]} close={close} />
  ))
  if (!r) return
  let m = rectToRect(img.visible, r.rect)
  let kind: TransformKind = 'resize'
  if (r.rotation % 360 !== 0) {
    const [cx, cy] = rectCenter(r.rect)
    const rot = rotationAbout(r.rotation, cx, cy)
    m = multiplyMatrix(m, rot)
    kind = 'rotate'
  }
  const same = m.every((val, i) => Math.abs(val - [1, 0, 0, 1, 0, 0][i]) < 1e-4)
  if (same) return
  await transformImage(doc, page, img, m, kind)
}
