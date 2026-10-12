import type * as MuPDF from 'mupdf'
import type { Rect } from '@shared/geometry'
import { normalizeRect, rectIntersection, transformRect } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer, type Transfer } from '@engine/define'
import pageOps from '@engine/ops/pages'
import { Session, type PDFPage } from '@engine/session'
import { catalog, isNull, pageBoxes, readRect } from '@engine/util/pdf'
import {
  applyMarks,
  loadedSources,
  loadSourceFile,
  readEntries,
  readMarkSettings,
  removeMarks,
  type ApplyOptions,
  type PreviewTarget
} from './pdfmarks'
import {
  MARK_NAMES,
  MARK_TYPES,
  normalizeSettings,
  resolvePageRange,
  type MarkGroup,
  type MarkSettings,
  type MarksListing,
  type MarkType,
  type PageBox,
  type SetBoxesRequest
} from './shared'

export interface Bitmap {
  width: number
  height: number
  /** Device-pixel position of the bitmap's top-left corner (page space x scale). */
  x: number
  y: number
  /** ImageBitmap in the browser worker; raw RGBA pixels in Node. */
  bitmap?: ImageBitmap
  pixels?: Uint8ClampedArray
}

export interface PreviewResult extends Bitmap {
  /** False when the page is outside the chosen page range (shown without the new marks). */
  inRange: boolean
  /** Why the marks are not shown (e.g. no text typed yet). */
  message?: string
}

export interface BoxesView extends Bitmap {
  /** Device pixels per point. */
  scale: number
  /** Page-space rectangles (origin at the top-left of the current crop box). */
  media: Rect
  crop: Rect
  trim: Rect | null
  bleed: Rect | null
  art: Rect | null
}

export interface SourceInfo {
  id: string
  kind: 'image' | 'pdf'
  pageCount: number
}

async function toBitmap<T extends object>(pix: MuPDF.Pixmap, extra: T): Promise<Transfer<T & Bitmap>> {
  const width = pix.getWidth()
  const height = pix.getHeight()
  const x = pix.getX()
  const y = pix.getY()
  const pixels = new Uint8ClampedArray(pix.getPixels())
  pix.destroy()
  if (typeof createImageBitmap === 'function' && typeof ImageData === 'function') {
    const bitmap = await createImageBitmap(
      new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height)
    )
    const result: T & Bitmap = { ...extra, width, height, x, y, bitmap }
    return withTransfer(result, [bitmap])
  }
  const result: T & Bitmap = { ...extra, width, height, x, y, pixels }
  return withTransfer(result, [pixels.buffer as ArrayBuffer])
}

/**
 * Renders a page (contents, annotations, widgets) into a white RGBA pixmap. `annotsOf` draws the
 * annotations of another page with the same geometry (a preview copy has none of its own).
 */
function renderPage(
  s: Session,
  page: PDFPage,
  scale: number,
  region?: Rect,
  opts: { annots?: boolean; annotsOf?: PDFPage } = {}
): MuPDF.Pixmap {
  const m = s.mupdf
  const b = region ?? (page.getBounds() as Rect)
  const box: Rect = [
    Math.floor(b[0] * scale),
    Math.floor(b[1] * scale),
    Math.ceil(b[2] * scale),
    Math.ceil(b[3] * scale)
  ]
  if (box[2] <= box[0]) box[2] = box[0] + 1
  if (box[3] <= box[1]) box[3] = box[1] + 1
  if ((box[2] - box[0]) * (box[3] - box[1]) > 30_000_000)
    throw new EngineError('Preview too large', 'TOO_LARGE')
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, box, true)
  pix.clear(255)
  const dev = new m.DrawDevice([scale, 0, 0, scale, 0, 0], pix)
  try {
    page.runPageContents(dev, m.Matrix.identity)
    if (opts.annots !== false) {
      const annots = opts.annotsOf ?? page
      annots.runPageAnnots(dev, m.Matrix.identity)
      annots.runPageWidgets(dev, m.Matrix.identity)
    }
    dev.close()
  } finally {
    dev.destroy()
  }
  return pix
}

/**
 * Copies one page into a new scratch document for a preview. The optional content configuration
 * comes along (with the same graft map, so hidden layers stay hidden) and so does the page's
 * transparency group, which graftPage leaves out.
 */
function previewCopy(s: Session, pageIndex: number): PreviewTarget {
  const tmp = new s.mupdf.PDFDocument()
  const session = new Session(s.mupdf)
  const map = tmp.newGraftMap()
  try {
    const ocp = catalog(s.pdf).get('OCProperties')
    if (!isNull(ocp)) catalog(tmp).put('OCProperties', map.graftObject(ocp))
    map.graftPage(-1, s.pdf, pageIndex)
    const group = s.pdf.findPage(pageIndex).get('Group')
    if (!isNull(group)) tmp.findPage(0).put('Group', map.graftObject(group))
    // Not setDocument(): a scratch copy needs no undo journal.
    session.doc = tmp
    return { page: pageIndex, session, map }
  } catch (err) {
    map.destroy()
    tmp.destroy()
    throw err
  }
}

function mediaRect(s: Session, pageIndex: number): Rect {
  const page = s.page(pageIndex)
  const mediaUser = readRect(s.pdf.findPage(pageIndex).getInheritable('MediaBox'))
  return normalizeRect(
    transformRect(mediaUser, page.getTransform() as [number, number, number, number, number, number])
  )
}

function boxRect(s: Session, pageIndex: number, box: PageBox): Rect | null {
  const obj =
    box === 'CropBox' ? s.pdf.findPage(pageIndex).getInheritable(box) : s.pdf.findPage(pageIndex).get(box)
  if (isNull(obj)) return null
  const page = s.page(pageIndex)
  return normalizeRect(
    transformRect(readRect(obj), page.getTransform() as [number, number, number, number, number, number])
  )
}

/** Bounds (page space) of everything that is not white on the page, or null for a blank page. */
export function contentBoundsOf(s: Session, pageIndex: number): Rect | null {
  const media = mediaRect(s, pageIndex)
  const area = (media[2] - media[0]) * (media[3] - media[1])
  const scale = Math.min(1, Math.sqrt(2_000_000 / Math.max(1, area)))
  const pix = renderPage(s, s.page(pageIndex), scale, media, { annots: false })
  try {
    const w = pix.getWidth()
    const h = pix.getHeight()
    const x0 = pix.getX()
    const y0 = pix.getY()
    const px = pix.getPixels()
    let minX = w
    let minY = h
    let maxX = -1
    let maxY = -1
    for (let y = 0; y < h; y++) {
      const row = y * w * 4
      for (let x = 0; x < w; x++) {
        const k = row + x * 4
        if (px[k] < 245 || px[k + 1] < 245 || px[k + 2] < 245) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < 0) return null
    // One pixel of slack so faint anti-aliased edges of the outermost glyphs are not cut off.
    const r: Rect = [
      (x0 + minX - 1) / scale,
      (y0 + minY - 1) / scale,
      (x0 + maxX + 2) / scale,
      (y0 + maxY + 2) / scale
    ]
    return rectIntersection(r, media) ?? r
  } finally {
    pix.destroy()
  }
}

function listMarks(s: Session): MarksListing {
  const doc = s.pdf
  const n = s.pageCount()
  const groups = new Map<string, MarkGroup>()
  const croppedPages: number[] = []
  for (let i = 0; i < n; i++) {
    for (const e of readEntries(doc.findPage(i))) {
      if (e.kind !== 'mark' || !e.type) continue
      let key = ''
      try {
        key = `${e.type}:${e.ref.get('FartcrobatSettings').resolve().asString()}`
      } catch {
        key = `${e.type}:?`
      }
      let g = groups.get(key)
      if (!g) {
        const settings = readMarkSettings(e.ref)
        if (!settings) continue
        g = { type: e.type, pages: [], settings }
        groups.set(key, g)
      }
      if (!g.pages.includes(i)) g.pages.push(i)
    }
    try {
      const b = pageBoxes(doc, i)
      if (b.cropBox.some((v, k) => Math.abs(v - b.mediaBox[k]) > 0.01)) croppedPages.push(i)
    } catch {}
  }
  const order = (t: MarkType) => MARK_TYPES.indexOf(t)
  return {
    groups: [...groups.values()].sort((a, b) => order(a.type) - order(b.type) || a.pages[0] - b.pages[0]),
    croppedPages
  }
}

const applyLabel = (settings: MarkSettings, opts: ApplyOptions) =>
  `${opts.mode === 'replace' ? 'Update' : 'Add'} ${MARK_NAMES[settings.type]}`

export default defineOps('page-marks', {
  /** Marks found in the document, grouped by type and settings, and the cropped pages. */
  list(s): MarksListing {
    return listMarks(s)
  },

  /** Adds marks (one undo step). With mode 'replace', marks of the same type are removed first. */
  apply: mutation(applyLabel, (s, settings: MarkSettings, opts: ApplyOptions) => {
    const pages = applyMarks(s, settings, opts)
    if (pages.length) s.touch(...pages)
    s.documentChanged()
    return { pages: pages.length }
  }),

  /** Removes every mark of a type from every page (one undo step). */
  remove: mutation(
    (type: MarkType) => `Remove ${MARK_NAMES[type]}`,
    (s, type: MarkType) => {
      const pages = removeMarks(s, type)
      if (!pages.length)
        throw new EngineError(
          `This document has no ${MARK_NAMES[type].toLowerCase()} made with Fartcrobat`,
          'NO_MARKS'
        )
      s.touch(...pages)
      s.documentChanged()
      return { pages: pages.length }
    }
  ),

  /**
   * Preview of one page with the marks applied. They are applied to a copy of the page, so the
   * document and its undo/redo history are never touched.
   */
  async preview(s, pageIndex: number, settings: MarkSettings, opts: ApplyOptions & { scale: number }) {
    const scale = Math.max(0.05, Math.min(4, opts.scale))
    const norm = normalizeSettings(settings)
    const inRange = !!norm && resolvePageRange(norm.range, s.pageCount()).includes(pageIndex)
    let message: string | undefined
    const target = previewCopy(s, pageIndex)
    let pix: MuPDF.Pixmap
    try {
      try {
        applyMarks(s, settings, opts, target)
      } catch (err) {
        if (!(err instanceof EngineError)) throw err
        message = err.message
      }
      pix = renderPage(s, target.session.page(0), scale, undefined, { annotsOf: s.page(pageIndex) })
    } finally {
      target.map.destroy()
      target.session.closeDocument()
    }
    return toBitmap(pix, { inRange, message })
  },

  /** Loads an image or document to use as a watermark or background. */
  loadSource(s, data: Uint8Array, fileName: string): SourceInfo {
    const loaded = loadSourceFile(s, data, fileName)
    const id = `src-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    loadedSources(s).set(id, loaded)
    return { id, kind: loaded.kind, pageCount: loaded.pageCount }
  },

  releaseSource(s, id: string) {
    const map = loadedSources(s)
    const src = map.get(id)
    if (!src) return
    map.delete(id)
    try {
      if (src.kind === 'pdf') src.doc.destroy()
      else src.image.destroy()
    } catch {}
  },

  // ---- crop -----------------------------------------------------------------------------------

  /** Content bounding box of a page (page space), or null when the page is blank. */
  contentBounds(s, pageIndex: number): Rect | null {
    return contentBoundsOf(s, pageIndex)
  },

  /** The whole MediaBox of a page rendered at `scale`, with the page boxes, for the crop dialog. */
  async boxes(s, pageIndex: number, scale: number) {
    const media = mediaRect(s, pageIndex)
    const sc = Math.max(0.05, Math.min(4, scale))
    const pix = renderPage(s, s.page(pageIndex), sc, media)
    const crop = s.pageBounds(pageIndex)
    return toBitmap(pix, {
      scale: sc,
      media,
      crop,
      trim: boxRect(s, pageIndex, 'TrimBox'),
      bleed: boxRect(s, pageIndex, 'BleedBox'),
      art: boxRect(s, pageIndex, 'ArtBox')
    })
  },

  /** Sets (or removes) a page box on several pages as one undo step, using core pages.setBox. */
  setBoxes: mutation(
    (req: SetBoxesRequest) =>
      req.margins === null && !req.removeWhiteMargins
        ? req.box === 'CropBox'
          ? 'Remove Crop'
          : 'Remove Page Boxes'
        : req.box === 'CropBox'
          ? 'Crop Pages'
          : 'Set Page Boxes',
    (s, req: SetBoxesRequest) => {
      const count = s.pageCount()
      const pages = [...new Set(req.pages)]
        .filter((i) => Number.isInteger(i) && i >= 0 && i < count)
        .sort((a, b) => a - b)
      if (!pages.length) throw new EngineError('No pages selected', 'NO_PAGES')
      const setBox = pageOps.ops.setBox
      let changed = 0
      pages.forEach((i, k) => {
        const media = mediaRect(s, i)
        let rect: Rect | null = null
        if (req.removeWhiteMargins) {
          const bounds = contentBoundsOf(s, i)
          if (!bounds) return
          rect = bounds
        } else if (req.margins) {
          const m = req.margins
          rect = [media[0] + m.left, media[1] + m.top, media[2] - m.right, media[3] - m.bottom]
          if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) {
            throw new EngineError(`The margins are larger than page ${i + 1}`, 'BAD_MARGINS')
          }
        }
        if (rect) {
          setBox(s, [i], rect, req.box)
        } else {
          setBox(s, [i], null, req.box)
          // A box inherited from the page tree would still apply: pin the page to its MediaBox.
          if (req.box === 'CropBox' && !isNull(s.pdf.findPage(i).getInheritable('CropBox'))) {
            setBox(s, [i], mediaRect(s, i), req.box)
          }
        }
        changed++
        if (pages.length > 20 && k % 10 === 9)
          s.progress((k + 1) / pages.length, `Page ${k + 1} of ${pages.length}`)
      })
      if (!changed)
        throw new EngineError(
          'The selected pages are blank, so there are no white margins to remove',
          'BLANK'
        )
      return { pages: changed }
    }
  )
})
