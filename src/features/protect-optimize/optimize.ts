/**
 * PDF Optimizer (engine side). Works on a private copy of the document so the open document and its
 * undo history are never touched: downsamples and recompresses images, subsets fonts, discards
 * objects and user data, and cleans up the file structure.
 */
import type * as MuPDF from 'mupdf'
import { EngineError } from '@engine/define'
import type { PDFDocument, PDFObject, Session } from '@engine/session'
import { catalog, countSignatures, isNull, readName, walkFields } from '@engine/util/pdf'
import type { ImageReport, OptimizeOptions, OptimizeReport, SpaceAudit, SpaceCategory } from './shared'

type Mupdf = Session['mupdf']

// ---- small PDF helpers ----------------------------------------------------------------------

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

/** Filter names of a stream dictionary, in decoding order. */
export function filterNames(dict: PDFObject): string[] {
  const f = dict.get('Filter')
  if (isNull(f)) return []
  const r = f.resolve()
  if (r.isName()) return [r.asName()]
  if (r.isArray()) {
    const out: string[] = []
    for (let i = 0; i < r.length; i++) out.push(safe(() => r.get(i).resolve().asName(), ''))
    return out
  }
  return []
}

function decodeParmsList(dict: PDFObject, count: number): (PDFObject | null)[] {
  const p = dict.get('DecodeParms')
  const out: (PDFObject | null)[] = new Array(count).fill(null)
  if (isNull(p)) return out
  const r = p.resolve()
  if (r.isArray()) {
    for (let i = 0; i < Math.min(count, r.length); i++) out[i] = isNull(r.get(i)) ? null : r.get(i)
  } else if (count > 0) out[0] = p
  return out
}

function setFilters(pdf: PDFDocument, dict: PDFObject, filters: string[], parms: (PDFObject | null)[]) {
  if (filters.length === 0) {
    dict.delete('Filter')
    dict.delete('DecodeParms')
    return
  }
  if (filters.length === 1) {
    dict.put('Filter', pdf.newName(filters[0]))
    if (parms[0]) dict.put('DecodeParms', parms[0])
    else dict.delete('DecodeParms')
    return
  }
  const fa = pdf.newArray()
  for (const f of filters) fa.push(pdf.newName(f))
  dict.put('Filter', fa)
  if (parms.some((p) => p)) {
    const pa = pdf.newArray()
    for (const p of parms) pa.push(p ?? pdf.newNull())
    dict.put('DecodeParms', pa)
  } else dict.delete('DecodeParms')
}

/** Decodes an ASCII85 (btoa-style, `~>` terminated) stream. */
export function decodeAscii85(data: Uint8Array): Uint8Array {
  // Worst case: every character is "z" (four zero bytes).
  const out = new Uint8Array(data.length * 4 + 4)
  let o = 0
  let tuple = 0
  let count = 0
  let i = 0
  if (data.length >= 2 && data[0] === 0x3c && data[1] === 0x7e) i = 2 // optional "<~"
  for (; i < data.length; i++) {
    const c = data[i]
    if (c === 0x7e) break // "~>"
    if (c <= 0x20) continue
    if (c === 0x7a && count === 0) {
      out[o++] = 0
      out[o++] = 0
      out[o++] = 0
      out[o++] = 0
      continue
    }
    if (c < 0x21 || c > 0x75) throw new Error('Invalid ASCII85 data')
    tuple = tuple * 85 + (c - 33)
    count++
    if (count === 5) {
      out[o++] = (tuple >>> 24) & 255
      out[o++] = (tuple >>> 16) & 255
      out[o++] = (tuple >>> 8) & 255
      out[o++] = tuple & 255
      tuple = 0
      count = 0
    }
  }
  if (count > 0) {
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84
    const bytes = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255]
    for (let k = 0; k < count - 1; k++) out[o++] = bytes[k]
  }
  return out.slice(0, o)
}

export function decodeAsciiHex(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(data.length / 2))
  let o = 0
  let hi = -1
  for (let i = 0; i < data.length; i++) {
    const c = data[i]
    if (c === 0x3e) break // ">"
    let v: number
    if (c >= 0x30 && c <= 0x39) v = c - 0x30
    else if (c >= 0x41 && c <= 0x46) v = c - 55
    else if (c >= 0x61 && c <= 0x66) v = c - 87
    else continue
    if (hi < 0) hi = v
    else {
      out[o++] = (hi << 4) | v
      hi = -1
    }
  }
  if (hi >= 0) out[o++] = hi << 4
  return out.slice(0, o)
}

/** zlib (FlateDecode) compression. */
export async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** PNG row prediction (picks the best of None/Sub/Up/Paeth per row), for /Predictor 15. */
export function pngPredict(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, n: number, stride = width * n): Uint8Array {
  const rowLen = width * n
  const out = new Uint8Array((rowLen + 1) * height)
  const cand = [new Uint8Array(rowLen), new Uint8Array(rowLen), new Uint8Array(rowLen), new Uint8Array(rowLen)]
  for (let y = 0; y < height; y++) {
    const row = y * stride
    const prev = (y - 1) * stride
    const sums = [0, 0, 0, 0]
    for (let x = 0; x < rowLen; x++) {
      const v = pixels[row + x]
      const a = x >= n ? pixels[row + x - n] : 0
      const b = y > 0 ? pixels[prev + x] : 0
      const c = x >= n && y > 0 ? pixels[prev + x - n] : 0
      const p = a + b - c
      const pa = Math.abs(p - a)
      const pb = Math.abs(p - b)
      const pc = Math.abs(p - c)
      const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      const f0 = v
      const f1 = (v - a) & 255
      const f2 = (v - b) & 255
      const f3 = (v - paeth) & 255
      cand[0][x] = f0
      cand[1][x] = f1
      cand[2][x] = f2
      cand[3][x] = f3
      sums[0] += f0 < 128 ? f0 : 256 - f0
      sums[1] += f1 < 128 ? f1 : 256 - f1
      sums[2] += f2 < 128 ? f2 : 256 - f2
      sums[3] += f3 < 128 ? f3 : 256 - f3
    }
    let best = 0
    for (let k = 1; k < 4; k++) if (sums[k] < sums[best]) best = k
    const o = y * (rowLen + 1)
    out[o] = best === 3 ? 4 : best
    out.set(cand[best], o + 1)
  }
  return out
}

/** Number of distinct colours, counting at most `limit + 1`. */
export function countColors(pixels: Uint8Array | Uint8ClampedArray, n: number, limit: number): number {
  const seen = new Set<number>()
  for (let i = 0; i < pixels.length; i += n) {
    const key = n === 1 ? pixels[i] : n === 3 ? (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2] : (pixels[i] << 24) | (pixels[i + 1] << 16) | (pixels[i + 2] << 8) | pixels[i + 3]
    seen.add(key)
    if (seen.size > limit) return seen.size
  }
  return seen.size
}

/** Thresholds 8-bit gray pixels into 1-bit rows (MSB first). `paintIsZero`: dark pixels become 0. */
export function packBits(gray: Uint8Array | Uint8ClampedArray, width: number, height: number, stride: number): Uint8Array {
  const rowBytes = Math.ceil(width / 8)
  const out = new Uint8Array(rowBytes * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (gray[y * stride + x] >= 128) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return out
}

// ---- working copy ---------------------------------------------------------------------------

export interface WorkingCopy {
  pdf: PDFDocument
  plainSize: number
  encrypted: boolean
}

/**
 * Saves the open document (with its unsaved changes) and reopens the bytes as a separate document.
 * Encrypted documents keep their encryption; those that need an open password need `password`.
 */
export function openWorkingCopy(s: Session, password?: string): WorkingCopy {
  const buf = s.pdf.saveToBuffer('garbage=yes,compress')
  const bytes = buf.asUint8Array().slice()
  buf.destroy()
  const doc = s.mupdf.Document.openDocument(bytes, 'application/pdf')
  if (doc.needsPassword()) {
    if (!password) {
      doc.destroy()
      throw new EngineError('This document needs its open password to be compressed', 'NEEDS_PASSWORD')
    }
    if (!doc.authenticatePassword(password)) {
      doc.destroy()
      throw new EngineError('The password is incorrect', 'WRONG_PASSWORD')
    }
  }
  const pdf = doc.asPDF()
  if (!pdf) {
    doc.destroy()
    throw new EngineError('The document could not be copied for optimization', 'OPTIMIZE_FAILED')
  }
  const encrypted = !!safe(() => {
    const e = pdf.getMetaData('encryption')
    return e && e !== 'None'
  }, false)
  return { pdf, plainSize: bytes.length, encrypted }
}

// ---- images ---------------------------------------------------------------------------------

interface ImageEntry {
  num: number
  ref: PDFObject
  image: MuPDF.Image
  /** Largest drawn size in inches along the image's own x and y axes. */
  wIn: number
  hIn: number
  drawn: boolean
}

function collectImages(pdf: PDFDocument): { entries: Map<number, ImageEntry>; smaskUsers: Map<number, number>; maskOnly: Set<number> } {
  const entries = new Map<number, ImageEntry>()
  const smaskUsers = new Map<number, number>()
  const maskOnly = new Set<number>()
  const count = pdf.countObjects()
  for (let i = 1; i < count; i++) {
    let ref: PDFObject
    try {
      ref = pdf.newIndirect(i)
      if (!ref.isStream()) continue
    } catch {
      continue
    }
    const dict = safe(() => ref.resolve(), null)
    if (!dict || readName(dict.get('Subtype')) !== 'Image') continue
    const sm = dict.get('SMask')
    if (!isNull(sm) && sm.isIndirect()) {
      const n = sm.asIndirect()
      smaskUsers.set(n, (smaskUsers.get(n) ?? 0) + 1)
      maskOnly.add(n)
    }
    const mk = dict.get('Mask')
    if (!isNull(mk) && mk.isIndirect()) maskOnly.add(mk.asIndirect())
    let image: MuPDF.Image
    try {
      image = pdf.loadImage(ref)
    } catch {
      continue
    }
    entries.set(i, { num: i, ref, image, wIn: 0, hIn: 0, drawn: false })
  }
  return { entries, smaskUsers, maskOnly }
}

/** Runs every page through a recording device to find how large each image is drawn. */
function measureImages(s: Session, pdf: PDFDocument, entries: Map<number, ImageEntry>, progress: (f: number) => void) {
  const m = s.mupdf
  const byPointer = new Map<number, ImageEntry>()
  for (const e of entries.values()) byPointer.set(e.image.pointer as unknown as number, e)
  const record = (image: MuPDF.Image, ctm: MuPDF.Matrix) => {
    const e = byPointer.get(image.pointer as unknown as number)
    image.destroy()
    if (!e) return
    const w = Math.hypot(ctm[0], ctm[1]) / 72
    const h = Math.hypot(ctm[2], ctm[3]) / 72
    e.drawn = true
    e.wIn = Math.max(e.wIn, w)
    e.hIn = Math.max(e.hIn, h)
  }
  const pages = pdf.countPages()
  for (let p = 0; p < pages; p++) {
    let page: MuPDF.PDFPage | null = null
    const dev = new m.Device({
      fillImage: (image: MuPDF.Image, ctm: MuPDF.Matrix) => record(image, ctm),
      fillImageMask: (image: MuPDF.Image, ctm: MuPDF.Matrix) => record(image, ctm),
      clipImageMask: (image: MuPDF.Image, ctm: MuPDF.Matrix) => record(image, ctm)
    })
    try {
      page = pdf.loadPage(p)
      page.run(dev, m.Matrix.identity)
      dev.close()
    } catch {
      // A broken page: its images keep their resolution.
    } finally {
      dev.destroy()
      page?.destroy()
    }
    progress((p + 1) / pages)
  }
}

type ImageKind = 'color' | 'gray' | 'mono'

/** Which settings apply to an image; null for images that are left alone (spot colours). */
function classify(image: MuPDF.Image): ImageKind | null {
  if (image.getImageMask()) return 'mono'
  const cs = image.getColorSpace()
  if (!cs) return null
  const type = cs.getType()
  // Spot colours (Separation/DeviceN) would lose their meaning for printing.
  if (type === 'Separation' || type === 'None') return null
  // Palette images are colour images whatever their number of components.
  if (type === 'Indexed') return 'color'
  if (cs.getNumberOfComponents() === 1) return image.getBitsPerComponent() === 1 ? 'mono' : 'gray'
  return 'color'
}

const LOSSY = new Set(['DCTDecode', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode'])

function hasMask(image: MuPDF.Image): boolean {
  const mask = image.getMask()
  mask?.destroy()
  return !!mask
}

/** Draws `image` scaled to w x h into an opaque pixmap on white. Masks are left out. */
function drawScaled(m: Mupdf, image: MuPDF.Image, w: number, h: number, cs: MuPDF.ColorSpace): MuPDF.Pixmap {
  let src = image
  let temp: MuPDF.Pixmap | null = null
  if (hasMask(image)) {
    // Decode the image data alone; drawing the original would apply its mask.
    temp = image.toPixmap()
    src = new m.Image(temp)
  }
  const pix = new m.Pixmap(cs, [0, 0, w, h], false)
  pix.clear(255)
  const dev = new m.DrawDevice(m.Matrix.identity, pix)
  try {
    dev.fillImage(src, [w, 0, 0, h, 0, 0], 1)
    dev.close()
  } finally {
    dev.destroy()
    if (temp) {
      src.destroy()
      temp.destroy()
    }
  }
  return pix
}

/** Draws a stencil mask scaled to w x h: painted pixels black on white. */
function drawStencil(m: Mupdf, image: MuPDF.Image, w: number, h: number): MuPDF.Pixmap {
  const pix = new m.Pixmap(m.ColorSpace.DeviceGray, [0, 0, w, h], false)
  pix.clear(255)
  const dev = new m.DrawDevice(m.Matrix.identity, pix)
  try {
    dev.fillImageMask(image, [w, 0, 0, h, 0, 0], m.ColorSpace.DeviceGray, [0], 1)
    dev.close()
  } finally {
    dev.destroy()
  }
  return pix
}

function pixelsOf(pix: MuPDF.Pixmap): { data: Uint8ClampedArray; w: number; h: number; n: number; stride: number } {
  return { data: pix.getPixels(), w: pix.getWidth(), h: pix.getHeight(), n: pix.getNumberOfComponents(), stride: pix.getStride() }
}

function tightRows(p: { data: Uint8ClampedArray; w: number; h: number; n: number; stride: number }): Uint8Array {
  const row = p.w * p.n
  if (p.stride === row) return new Uint8Array(p.data.buffer, p.data.byteOffset, row * p.h).slice()
  const out = new Uint8Array(row * p.h)
  for (let y = 0; y < p.h; y++) out.set(p.data.subarray(y * p.stride, y * p.stride + row), y * row)
  return out
}

interface Encoded {
  data: Uint8Array
  filter: 'DCTDecode' | 'FlateDecode'
  parms: { Predictor: number; Colors: number; BitsPerComponent: number; Columns: number } | null
}

async function encodePixmap(pix: MuPDF.Pixmap, quality: number, preferLossless: boolean): Promise<Encoded> {
  const p = pixelsOf(pix)
  const lossless = preferLossless || countColors(tightRows(p), p.n, 256) <= 256
  if (!lossless) return { data: pix.asJPEG(quality).slice(), filter: 'DCTDecode', parms: null }
  const predicted = pngPredict(p.data, p.w, p.h, p.n, p.stride)
  return {
    data: await deflate(predicted),
    filter: 'FlateDecode',
    parms: { Predictor: 15, Colors: p.n, BitsPerComponent: 8, Columns: p.w }
  }
}

function putParms(pdf: PDFDocument, dict: PDFObject, parms: Encoded['parms']) {
  if (!parms) {
    dict.delete('DecodeParms')
    return
  }
  const d = pdf.newDictionary()
  d.put('Predictor', parms.Predictor)
  d.put('Colors', parms.Colors)
  d.put('BitsPerComponent', parms.BitsPerComponent)
  d.put('Columns', parms.Columns)
  dict.put('DecodeParms', d)
}

function rawLength(ref: PDFObject): number {
  return safe(() => {
    const b = ref.readRawStream()
    const n = b.getLength()
    b.destroy()
    return n
  }, 0)
}

async function optimizeImages(
  s: Session,
  pdf: PDFDocument,
  opts: OptimizeOptions['images'],
  progress: (f: number, msg?: string) => void
): Promise<ImageReport> {
  const m = s.mupdf
  const report: ImageReport = { examined: 0, downsampled: 0, recompressed: 0, bytesBefore: 0, bytesAfter: 0 }
  const { entries, smaskUsers, maskOnly } = collectImages(pdf)
  try {
    measureImages(s, pdf, entries, (f) => progress(f * 0.3, 'Measuring images'))
    const todo = [...entries.values()].filter((e) => e.drawn && !maskOnly.has(e.num))
    let k = 0
    for (const e of todo) {
      k++
      progress(0.3 + (k / Math.max(1, todo.length)) * 0.7, `Optimizing image ${k} of ${todo.length}`)
      report.examined++
      try {
        const r = await optimizeImage(m, pdf, e, opts, smaskUsers)
        if (r) {
          if (r.downsampled) report.downsampled++
          else report.recompressed++
          report.bytesBefore += r.before
          report.bytesAfter += r.after
        }
      } catch (err) {
        // Leave an image we cannot decode or encode as it is.
        console.warn(`[protect-optimize] image ${e.num} skipped:`, err)
      }
    }
  } finally {
    for (const e of entries.values()) e.image.destroy()
  }
  return report
}

async function optimizeImage(
  m: Mupdf,
  pdf: PDFDocument,
  e: ImageEntry,
  opts: OptimizeOptions['images'],
  smaskUsers: Map<number, number>
): Promise<{ downsampled: boolean; before: number; after: number } | null> {
  const dict = e.ref.resolve()
  const image = e.image
  const W = image.getWidth()
  const H = image.getHeight()
  if (W < 8 || H < 8 || e.wIn <= 0 || e.hIn <= 0) return null
  const mask = dict.get('Mask')
  if (!isNull(mask) && mask.resolve().isArray()) return null // colour-key masking needs exact colours
  if (safe(() => dict.get('SMaskInData').asNumber(), 0) > 0) return null
  const kind = classify(image)
  if (!kind) return null
  // Decoding very large masked images whole would need too much memory.
  if (W * H > 60_000_000 && hasMask(image)) return null
  const set = kind === 'mono' ? opts.mono : kind === 'gray' ? opts.gray : opts.color
  const filters = filterNames(dict)
  const ppi = Math.max(W / e.wIn, H / e.hIn)
  let nw = W
  let nh = H
  if (set.downsample && ppi > set.abovePpi && set.targetPpi > 0) {
    nw = Math.min(W, Math.max(1, Math.round(e.wIn * set.targetPpi)))
    nh = Math.min(H, Math.max(1, Math.round(e.hIn * set.targetPpi)))
  }
  const downsampled = nw < W || nh < H
  const photo = kind !== 'mono' ? (set as OptimizeOptions['images']['color']) : null
  const lossyNow = filters.some((f) => LOSSY.has(f))
  const recompress = !downsampled && !!photo?.recompress && !lossyNow
  if (!downsampled && !recompress) return null

  // SMask: downsample it with its image when nothing else uses it.
  const smRef = dict.get('SMask')
  const smNum = !isNull(smRef) && smRef.isIndirect() ? smRef.asIndirect() : 0
  const smDict = smNum ? smRef.resolve() : null
  // A pre-multiplied (/Matte) soft mask must keep the size and colours of its image.
  if (smDict && !isNull(smDict.get('Matte'))) return null
  const smOk = !!smDict && (smaskUsers.get(smNum) ?? 0) === 1 && downsampled
  const before = rawLength(e.ref) + (smOk ? rawLength(smRef) : 0)

  if (kind === 'mono') {
    const isMask = image.getImageMask()
    const pix = isMask ? drawStencil(m, image, nw, nh) : drawScaled(m, image, nw, nh, m.ColorSpace.DeviceGray)
    let bits: Uint8Array
    try {
      const p = pixelsOf(pix)
      bits = packBits(p.data, p.w, p.h, p.stride)
    } finally {
      pix.destroy()
    }
    const data = await deflate(bits)
    if (data.length >= before) return null
    e.ref.writeRawStream(data)
    dict.put('Filter', pdf.newName('FlateDecode'))
    dict.delete('DecodeParms')
    dict.put('Width', nw)
    dict.put('Height', nh)
    dict.put('BitsPerComponent', 1)
    dict.delete('Decode')
    if (isMask) {
      // Painted pixels are 0, which is what the default /Decode [0 1] paints.
      dict.put('ImageMask', true)
      dict.delete('ColorSpace')
    } else dict.put('ColorSpace', pdf.newName('DeviceGray'))
    dict.delete('DL')
    return { downsampled, before, after: data.length }
  }

  const cs = kind === 'gray' ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB
  const pix = drawScaled(m, image, nw, nh, cs)
  let enc: Encoded
  try {
    // Images with a soft mask stay lossless: JPEG ringing would show as halos along transparent edges.
    enc = await encodePixmap(pix, photo!.quality, !!smDict)
  } finally {
    pix.destroy()
  }
  if (recompress && enc.filter !== 'DCTDecode') return null // lossless re-encoding is not worth it
  let smEnc: Encoded | null = null
  if (smOk) {
    const smImage = pdf.loadImage(smRef)
    try {
      const smPix = drawScaled(m, smImage, nw, nh, m.ColorSpace.DeviceGray)
      try {
        smEnc = await encodePixmap(smPix, 100, true)
      } finally {
        smPix.destroy()
      }
    } finally {
      smImage.destroy()
    }
  }
  const after = enc.data.length + (smEnc ? smEnc.data.length : 0)
  if (after >= before) return null
  e.ref.writeRawStream(enc.data)
  dict.put('Filter', pdf.newName(enc.filter))
  putParms(pdf, dict, enc.parms)
  dict.put('Width', nw)
  dict.put('Height', nh)
  dict.put('BitsPerComponent', 8)
  dict.put('ColorSpace', pdf.newName(kind === 'gray' ? 'DeviceGray' : 'DeviceRGB'))
  dict.delete('Decode')
  dict.delete('DL')
  if (smEnc && smDict) {
    smRef.writeRawStream(smEnc.data)
    smDict.put('Filter', pdf.newName(smEnc.filter))
    putParms(pdf, smDict, smEnc.parms)
    smDict.put('Width', nw)
    smDict.put('Height', nh)
    smDict.put('BitsPerComponent', 8)
    smDict.put('ColorSpace', pdf.newName('DeviceGray'))
    smDict.delete('Decode')
    smDict.delete('DL')
  }
  return { downsampled, before, after }
}

// ---- discarding -----------------------------------------------------------------------------

const COMMENT_TYPES = new Set([
  'Text',
  'FreeText',
  'Line',
  'Square',
  'Circle',
  'Polygon',
  'PolyLine',
  'Highlight',
  'Underline',
  'Squiggly',
  'StrikeOut',
  'Stamp',
  'Caret',
  'Ink',
  'Popup',
  'FileAttachment',
  'Sound',
  'Redact'
])

const FORM_ACTIONS = new Set(['SubmitForm', 'ResetForm', 'ImportData'])

function forEachAnnot(pdf: PDFDocument, fn: (annot: PDFObject, page: PDFObject) => void) {
  const n = pdf.countPages()
  for (let p = 0; p < n; p++) {
    const page = pdf.findPage(p)
    const annots = page.get('Annots')
    if (isNull(annots) || !annots.resolve().isArray()) continue
    const arr = annots.resolve()
    for (let i = 0; i < arr.length; i++) {
      const a = arr.get(i).resolve()
      if (a.isDictionary()) fn(a, page)
    }
  }
}

/** Does this action (or any action chained after it) have one of the given types? */
function actionHas(action: PDFObject, types: Set<string>, depth = 0): boolean {
  if (depth > 16 || isNull(action)) return false
  const a = action.resolve()
  if (a.isArray()) {
    for (let i = 0; i < a.length; i++) if (actionHas(a.get(i), types, depth + 1)) return true
    return false
  }
  if (!a.isDictionary()) return false
  const s = readName(a.get('S'))
  if (s && types.has(s)) return true
  return actionHas(a.get('Next'), types, depth + 1)
}

function stripActions(pdf: PDFDocument, types: Set<string>) {
  const root = catalog(pdf)
  const open = root.get('OpenAction')
  if (!isNull(open) && open.resolve().isDictionary() && actionHas(open, types)) root.delete('OpenAction')
  const dropAA = (obj: PDFObject) => {
    const aa = obj.get('AA')
    if (isNull(aa)) return
    const d = aa.resolve()
    if (!d.isDictionary()) return
    const keys: string[] = []
    d.forEach((v, k) => {
      if (actionHas(v, types)) keys.push(String(k))
    })
    for (const k of keys) d.delete(k)
    if (d.length === 0) obj.delete('AA')
  }
  dropAA(root)
  const n = pdf.countPages()
  for (let p = 0; p < n; p++) dropAA(pdf.findPage(p))
  forEachAnnot(pdf, (a) => {
    if (actionHas(a.get('A'), types)) a.delete('A')
    dropAA(a)
  })
  walkFields(pdf, (field) => dropAA(field.resolve()))
}

function removeJavaScript(pdf: PDFDocument) {
  const js = new Set(['JavaScript'])
  stripActions(pdf, js)
  const root = catalog(pdf)
  const names = root.get('Names')
  if (!isNull(names)) names.resolve().delete('JavaScript')
  const acro = root.get('AcroForm')
  if (!isNull(acro)) acro.resolve().delete('CO')
}

function removeComments(pdf: PDFDocument) {
  const n = pdf.countPages()
  for (let p = 0; p < n; p++) {
    const page = pdf.findPage(p)
    const annots = page.get('Annots')
    if (isNull(annots)) continue
    const arr = annots.resolve()
    if (!arr.isArray()) continue
    const keep = pdf.newArray()
    for (let i = 0; i < arr.length; i++) {
      const item = arr.get(i)
      const a = item.resolve()
      const type = readName(a.get('Subtype'))
      if (type && COMMENT_TYPES.has(type)) continue
      if (type === 'Widget' || type === 'Link') a.delete('Popup')
      keep.push(item)
    }
    if (keep.length) page.put('Annots', keep)
    else page.delete('Annots')
  }
}

function removeAttachments(pdf: PDFDocument) {
  const names = catalog(pdf).get('Names')
  if (!isNull(names)) names.resolve().delete('EmbeddedFiles')
  catalog(pdf).delete('AF')
  const n = pdf.countPages()
  for (let p = 0; p < n; p++) {
    const page = pdf.findPage(p)
    const annots = page.get('Annots')
    if (isNull(annots) || !annots.resolve().isArray()) continue
    const arr = annots.resolve()
    const keep = pdf.newArray()
    for (let i = 0; i < arr.length; i++) {
      const a = arr.get(i).resolve()
      const type = readName(a.get('Subtype'))
      if (type === 'FileAttachment') continue
      if (type === 'Popup') {
        const parent = a.get('Parent')
        if (!isNull(parent) && readName(parent.resolve().get('Subtype')) === 'FileAttachment') continue
      }
      keep.push(arr.get(i))
    }
    if (keep.length) page.put('Annots', keep)
    else page.delete('Annots')
  }
}

function forEachImageDict(pdf: PDFDocument, fn: (dict: PDFObject) => void) {
  const count = pdf.countObjects()
  for (let i = 1; i < count; i++) {
    try {
      const ref = pdf.newIndirect(i)
      if (!ref.isStream()) continue
      const d = ref.resolve()
      if (readName(d.get('Subtype')) === 'Image') fn(d)
    } catch {}
  }
}

function discard(pdf: PDFDocument, d: OptimizeOptions['discard']): string[] {
  const done: string[] = []
  const root = catalog(pdf)
  const pages = pdf.countPages()
  if (d.flattenFields) {
    pdf.bake(false, true)
    done.push('form fields flattened')
  }
  if (d.formActions) {
    stripActions(pdf, FORM_ACTIONS)
    done.push('form actions')
  }
  if (d.javascript) {
    removeJavaScript(pdf)
    done.push('JavaScript')
  }
  if (d.alternateImages) forEachImageDict(pdf, (img) => img.delete('Alternates'))
  if (d.thumbnails) for (let p = 0; p < pages; p++) pdf.findPage(p).delete('Thumb')
  if (d.bookmarks && !isNull(root.get('Outlines'))) {
    root.delete('Outlines')
    if (readName(root.get('PageMode')) === 'UseOutlines') root.put('PageMode', pdf.newName('UseNone'))
    done.push('bookmarks')
  }
  if (d.tags) {
    root.delete('StructTreeRoot')
    root.delete('MarkInfo')
    for (let p = 0; p < pages; p++) pdf.findPage(p).delete('StructParents')
    done.push('tags')
  }
  if (d.comments) {
    removeComments(pdf)
    done.push('comments')
  }
  if (d.attachments) {
    removeAttachments(pdf)
    done.push('attachments')
  }
  if (d.metadata) {
    root.delete('Metadata')
    pdf.getTrailer().delete('Info')
    done.push('metadata')
  }
  if (d.privateData) {
    root.delete('PieceInfo')
    for (let p = 0; p < pages; p++) pdf.findPage(p).delete('PieceInfo')
  }
  return done
}

// ---- stream clean-up ------------------------------------------------------------------------

const SIMPLE_CODECS = new Set(['ASCIIHexDecode', 'ASCII85Decode', 'LZWDecode', 'RunLengthDecode', 'AHx', 'A85', 'LZW', 'RL'])

/** Removes ASCII encodings and replaces LZW/RunLength with Flate (applied when saving). */
function recodeStreams(pdf: PDFDocument) {
  const count = pdf.countObjects()
  for (let i = 1; i < count; i++) {
    let ref: PDFObject
    try {
      ref = pdf.newIndirect(i)
      if (!ref.isStream()) continue
    } catch {
      continue
    }
    try {
      const dict = ref.resolve()
      const filters = filterNames(dict)
      if (!filters.length || !filters.some((f) => SIMPLE_CODECS.has(f))) continue
      const type = readName(dict.get('Type'))
      if (type === 'XRef' || type === 'ObjStm' || filters.includes('Crypt')) continue
      if (filters.every((f) => SIMPLE_CODECS.has(f))) {
        // Fully decodable here: store decoded, MuPDF compresses it with Flate when saving.
        const buf = ref.readStream()
        const data = buf.asUint8Array().slice()
        buf.destroy()
        ref.writeStream(data)
        dict.delete('Filter')
        dict.delete('DecodeParms')
        dict.delete('DL')
        continue
      }
      // Strip leading ASCII layers in front of an image codec (e.g. [/ASCII85Decode /DCTDecode]).
      let parms = decodeParmsList(dict, filters.length)
      const raw = ref.readRawStream()
      let data: Uint8Array = raw.asUint8Array().slice()
      raw.destroy()
      let list = filters
      let changed = false
      while (list.length > 1 && (list[0] === 'ASCII85Decode' || list[0] === 'A85' || list[0] === 'ASCIIHexDecode' || list[0] === 'AHx')) {
        data = list[0] === 'ASCII85Decode' || list[0] === 'A85' ? decodeAscii85(data) : decodeAsciiHex(data)
        list = list.slice(1)
        parms = parms.slice(1)
        changed = true
      }
      if (!changed) continue
      ref.writeRawStream(data)
      setFilters(pdf, dict, list, parms)
    } catch {
      // Leave streams we cannot decode untouched.
    }
  }
}

/** Decoded size of all embedded font programs. */
function fontProgramBytes(pdf: PDFDocument): number {
  let total = 0
  const count = pdf.countObjects()
  for (let i = 1; i < count; i++) {
    try {
      const ref = pdf.newIndirect(i)
      if (ref.isStream()) continue
      const d = ref.resolve()
      if (!d.isDictionary() || readName(d.get('Type')) !== 'FontDescriptor') continue
      for (const k of ['FontFile', 'FontFile2', 'FontFile3']) {
        const f = d.get(k)
        if (isNull(f) || !f.isIndirect()) continue
        const b = f.readStream()
        total += b.getLength()
        b.destroy()
      }
    } catch {}
  }
  return total
}

// ---- the whole pipeline ---------------------------------------------------------------------

export function saveOptionsFor(opts: OptimizeOptions): string {
  const parts = [opts.cleanup.removeUnused ? 'garbage=deduplicate' : 'garbage=yes']
  if (opts.cleanup.compressStreams) parts.push('compress', 'compress-images', 'compress-fonts')
  if (opts.cleanup.objectStreams) parts.push('objstms')
  if (opts.cleanup.optimizeContent) parts.push('clean')
  return parts.join(',')
}

export async function optimizeDocument(
  s: Session,
  opts: OptimizeOptions,
  password?: string
): Promise<{ bytes: Uint8Array; report: OptimizeReport }> {
  const progress = (f: number, msg?: string) => s.progress(Math.max(0, Math.min(1, f)), msg)
  progress(0, 'Preparing a copy')
  const signed = safe(() => countSignatures(s.pdf), 0) > 0
  const copy = openWorkingCopy(s, password)
  const pdf = copy.pdf
  try {
    const discarded = discard(pdf, opts.discard)
    if (opts.cleanup.compressStreams) recodeStreams(pdf)
    const images = await optimizeImages(s, pdf, opts.images, (f, msg) => progress(0.05 + f * 0.75, msg))
    let fontsSubset = false
    if (opts.fonts.subset) {
      progress(0.82, 'Subsetting fonts')
      const before = fontProgramBytes(pdf)
      if (before > 0) {
        try {
          pdf.subsetFonts()
          fontsSubset = fontProgramBytes(pdf) < before
        } catch (err) {
          console.warn('[protect-optimize] font subsetting failed', err)
        }
      }
    }
    progress(0.9, 'Saving')
    const buf = pdf.saveToBuffer(saveOptionsFor(opts))
    const bytes = buf.asUint8Array().slice()
    buf.destroy()
    verifyOutput(s.mupdf, bytes, password)
    progress(1, 'Done')
    return {
      bytes,
      report: {
        originalSize: copy.plainSize,
        resultSize: bytes.length,
        images,
        fontsSubset,
        discarded,
        keptEncryption: copy.encrypted,
        signaturesInvalidated: signed
      }
    }
  } finally {
    pdf.destroy()
  }
}

/** Makes sure the optimized file opens and has pages before anyone gets to save it. */
function verifyOutput(m: Mupdf, bytes: Uint8Array, password?: string) {
  let doc: MuPDF.Document | null = null
  try {
    doc = m.Document.openDocument(bytes, 'application/pdf')
    if (doc.needsPassword() && !doc.authenticatePassword(password ?? '')) throw new Error('cannot authenticate')
    if (doc.countPages() < 1) throw new Error('no pages')
    doc.loadPage(0).destroy()
  } catch (err) {
    throw new EngineError(`The optimized file did not pass checks (${(err as Error).message}); nothing was saved`, 'OPTIMIZE_FAILED')
  } finally {
    doc?.destroy()
  }
}

// ---- audit space usage ----------------------------------------------------------------------

/** Acrobat's "Audit space usage": bytes used by each kind of content (stream data, compressed). */
export function auditSpace(s: Session): SpaceAudit {
  const pdf = s.pdf
  const fontFiles = new Set<number>()
  const contents = new Set<number>()
  const thumbs = new Set<number>()
  const pages = pdf.countPages()
  const addRef = (set: Set<number>, o: PDFObject) => {
    if (!isNull(o) && o.isIndirect()) set.add(o.asIndirect())
  }
  for (let p = 0; p < pages; p++) {
    const page = pdf.findPage(p)
    const c = page.get('Contents')
    if (!isNull(c)) {
      const r = c.resolve()
      if (r.isArray()) for (let i = 0; i < r.length; i++) addRef(contents, r.get(i))
      else addRef(contents, c)
    }
    addRef(thumbs, page.get('Thumb'))
  }
  const count = pdf.countObjects()
  for (let i = 1; i < count; i++) {
    try {
      const ref = pdf.newIndirect(i)
      if (ref.isStream()) continue
      const d = ref.resolve()
      if (!d.isDictionary() || readName(d.get('Type')) !== 'FontDescriptor') continue
      for (const k of ['FontFile', 'FontFile2', 'FontFile3']) addRef(fontFiles, d.get(k))
    } catch {}
  }
  const cats: Record<string, SpaceCategory> = {}
  const add = (id: string, label: string, bytes: number) => {
    const c = (cats[id] ??= { id, label, bytes: 0, count: 0 })
    c.bytes += bytes
    c.count++
  }
  let streams = 0
  for (let i = 1; i < count; i++) {
    let ref: PDFObject
    try {
      ref = pdf.newIndirect(i)
      if (!ref.isStream()) continue
    } catch {
      continue
    }
    const len = rawLength(ref)
    streams += len
    const d = safe(() => ref.resolve(), null)
    const type = d ? readName(d.get('Type')) : null
    const sub = d ? readName(d.get('Subtype')) : null
    if (sub === 'Image') add('images', 'Images', len)
    else if (fontFiles.has(i)) add('fonts', 'Fonts', len)
    else if (contents.has(i)) add('content', 'Page content', len)
    else if (thumbs.has(i)) add('thumbnails', 'Thumbnails', len)
    else if (type === 'Metadata') add('metadata', 'Metadata', len)
    else if (type === 'EmbeddedFile') add('attachments', 'Attachments', len)
    else if (sub === 'Form') add('forms', 'Forms, stamps and appearances', len)
    else if (type === 'XRef' || type === 'ObjStm') add('structure', 'Document structure', len)
    else add('other', 'Other data', len)
  }
  const total = safe(() => {
    const b = pdf.saveToBuffer('garbage=yes,compress')
    const n = b.getLength()
    b.destroy()
    return n
  }, streams)
  const overhead = Math.max(0, total - streams)
  if (overhead) {
    const c = (cats.structure ??= { id: 'structure', label: 'Document structure', bytes: 0, count: 0 })
    c.bytes += overhead
  }
  const order = ['images', 'fonts', 'content', 'forms', 'thumbnails', 'attachments', 'metadata', 'structure', 'other']
  return {
    total,
    categories: order.map((id) => cats[id]).filter((c): c is SpaceCategory => !!c && c.bytes > 0)
  }
}
