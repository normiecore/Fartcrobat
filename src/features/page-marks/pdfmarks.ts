/**
 * Engine-side builder for page marks (headers & footers, watermarks, backgrounds, Bates numbers).
 *
 * Every mark is a separate content stream in the page's /Contents, wrapped in q/Q, whose stream
 * dictionary carries /FartcrobatMark (the mark type) and /FartcrobatSettings (JSON). The drawing
 * itself lives in a Form XObject (own resources: fonts, images, opacity) that the stream paints
 * inside /Artifact marked content, like Acrobat does. Marks on top of the page come after the
 * original content, which is wrapped in q ... Q so its graphics state cannot leak into them;
 * backgrounds and watermarks "behind the page" are prepended.
 */
import type * as MuPDF from 'mupdf'
import type { Matrix, Rect } from '@shared/geometry'
import { hexToRgb, invertMatrix, multiplyMatrix } from '@shared/geometry'
import { EngineError } from '@engine/define'
import type { PDFDocument, PDFObject, PDFPage, Session } from '@engine/session'
import { openSource } from '@engine/ops/pages'
import { isNull, num, readName, readNumber, readString } from '@engine/util/pdf'
import {
  expandTokens,
  formatBates,
  MARK_TYPES,
  normalizeSettings,
  resolvePageRange,
  storableSettings,
  winAnsiCode,
  type BackgroundSettings,
  type BatesSettings,
  type FontSpec,
  type HeaderFooterSettings,
  type MarkSettings,
  type MarkType,
  type Slot,
  type WatermarkSettings
} from './shared'

export const MARK_KEY = 'FartcrobatMark'
export const SETTINGS_KEY = 'FartcrobatSettings'
const XOBJECTS_KEY = 'FartcrobatXObjects'
const SOURCE_KEY = 'FartcrobatSource'
const SOURCE_SIZE_KEY = 'FartcrobatSourceSize'
const SHRINK_KEY = 'FartcrobatShrink'
const BEHIND_KEY = 'FartcrobatBehind'
const OCG_KEY = 'FartcrobatOCG'
const WRAP_KEY = 'FartcrobatWrap'

type Mupdf = Session['mupdf']

// ---- fonts ----------------------------------------------------------------------------------

const BASE14: Record<FontSpec['family'], [string, string, string, string]> = {
  Helvetica: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique'],
  Times: ['Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic'],
  Courier: ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique']
}

export function base14Name(f: FontSpec): string {
  const names = BASE14[f.family] ?? BASE14.Helvetica
  return names[(f.bold ? 1 : 0) + (f.italic ? 2 : 0)]
}

const fontCache = new Map<string, MuPDF.Font>()

function metricsFont(m: Mupdf, name: string): MuPDF.Font {
  let f = fontCache.get(name)
  if (!f) {
    f = new m.Font(name)
    fontCache.set(name, f)
  }
  return f
}

/** Width of a line of text in points. */
export function measure(m: Mupdf, font: FontSpec, text: string): number {
  const f = metricsFont(m, base14Name(font))
  let w = 0
  for (const ch of text) {
    let cp = ch.codePointAt(0)!
    if (winAnsiCode(cp) < 0) cp = 0x3f
    w += f.advanceGlyph(f.encodeCharacter(cp))
  }
  return w * font.size
}

/** WinAnsi hex string for a text-showing operator. Unsupported characters become '?'. */
function hexText(text: string): string {
  let out = '<'
  for (const ch of text) {
    const code = winAnsiCode(ch.codePointAt(0)!)
    out += (code < 0 ? 0x3f : code).toString(16).padStart(2, '0')
  }
  return out + '>'
}

function rgb(hex: string): string {
  return hexToRgb(hex)
    .map((v) => num(v))
    .join(' ')
}

const ASCENT = 0.75
const DESCENT = 0.25
const LEADING = 1.2

interface TextLineLayout {
  text: string
  x: number
  y: number
  width: number
}

/** Content operators drawing lines of text (and underlines) with font resource /F0. */
function textOperators(font: FontSpec, lines: TextLineLayout[]): string {
  const parts: string[] = []
  const color = rgb(font.color)
  parts.push(`${color} rg`)
  parts.push(`BT /F0 ${num(font.size)} Tf`)
  for (const l of lines) {
    if (!l.text) continue
    parts.push(`1 0 0 1 ${num(l.x)} ${num(l.y)} Tm ${hexText(l.text)} Tj`)
  }
  parts.push('ET')
  if (font.underline) {
    const thick = Math.max(0.5, font.size * 0.05)
    for (const l of lines) {
      if (!l.text || l.width <= 0) continue
      parts.push(`${num(l.x)} ${num(l.y - font.size * 0.12 - thick)} ${num(l.width)} ${num(thick)} re f`)
    }
  }
  return parts.join('\n')
}

// ---- matrices -------------------------------------------------------------------------------

/** Page geometry: size in the displayed orientation and the "view space" (y up) -> user matrix. */
export interface PageFrame {
  width: number
  height: number
  viewToUser: Matrix
  userToView: Matrix
}

export function pageFrame(page: PDFPage): PageFrame {
  const b = page.getBounds() as Rect
  const width = b[2] - b[0]
  const height = b[3] - b[1]
  const userToPage = page.getTransform() as Matrix
  const pageToUser = invertMatrix(userToPage)
  // view space: origin at the bottom-left of the visible page, y up, page /Rotate applied
  const viewToPage: Matrix = [1, 0, 0, -1, b[0], b[3]]
  const viewToUser = multiplyMatrix(viewToPage, pageToUser)
  return { width, height, viewToUser, userToView: invertMatrix(viewToUser) }
}

function cm(m: Matrix): string {
  return `${m.map(num).join(' ')} cm`
}

function rotation(deg: number): Matrix {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [c, s, -s, c, 0, 0]
}

// ---- small PDF helpers ----------------------------------------------------------------------

function rectArray(doc: PDFDocument, r: Rect): PDFObject {
  const a = doc.newArray()
  for (const v of r) a.push(v)
  return a
}

function matrixArray(doc: PDFDocument, m: Matrix): PDFObject {
  const a = doc.newArray()
  for (const v of m) a.push(v)
  return a
}

function readMatrix(obj: PDFObject | null | undefined): Matrix | null {
  if (!obj || isNull(obj)) return null
  const o = obj.resolve()
  if (!o.isArray() || o.length !== 6) return null
  const out: number[] = []
  for (let i = 0; i < 6; i++) out.push(readNumber(o.get(i), 0))
  return out as Matrix
}

function dictSize(obj: PDFObject): number {
  let n = 0
  obj.forEach(() => n++)
  return n
}

/** Deep copy of direct objects (indirect references are kept as references). */
function copyObject(doc: PDFDocument, obj: PDFObject): PDFObject {
  if (obj.isIndirect()) return obj
  if (obj.isDictionary()) {
    const d = doc.newDictionary()
    obj.forEach((v, k) => d.put(k as string, copyObject(doc, v)))
    return d
  }
  if (obj.isArray()) {
    const a = doc.newArray()
    obj.forEach((v) => a.push(copyObject(doc, v)))
    return a
  }
  return obj
}

function newForm(
  doc: PDFDocument,
  bbox: Rect,
  resources: PDFObject,
  content: string,
  extra: (d: PDFObject) => void = () => {}
): PDFObject {
  const d = doc.newDictionary()
  d.put('Type', doc.newName('XObject'))
  d.put('Subtype', doc.newName('Form'))
  d.put('BBox', rectArray(doc, bbox))
  d.put('Resources', resources)
  extra(d)
  return doc.addStream(content, d)
}

function opacityState(doc: PDFDocument, opacity: number): PDFObject {
  const gs = doc.newDictionary()
  gs.put('Type', doc.newName('ExtGState'))
  const a = Math.max(0, Math.min(1, opacity))
  gs.put('ca', a)
  gs.put('CA', a)
  return gs
}

// ---- reading page contents ------------------------------------------------------------------

export interface ContentEntry {
  ref: PDFObject
  kind: 'orig' | 'mark' | 'wrapBegin' | 'wrapEnd'
  type?: MarkType
  behind?: boolean
  xobjects?: string[]
  shrink?: Matrix | null
}

export function readEntries(pageObj: PDFObject): ContentEntry[] {
  const c = pageObj.get('Contents')
  const refs: PDFObject[] = []
  if (!isNull(c)) {
    if (c.isArray()) {
      for (let k = 0; k < c.length; k++) refs.push(c.get(k))
    } else refs.push(c)
  }
  return refs.map((ref) => {
    let isStream = false
    try {
      isStream = ref.isStream()
    } catch {}
    if (!isStream) return { ref, kind: 'orig' as const }
    const mark = readName(ref.get(MARK_KEY))
    if (mark && (MARK_TYPES as string[]).includes(mark)) {
      const names: string[] = []
      const xo = ref.get(XOBJECTS_KEY)
      if (!isNull(xo) && xo.isArray())
        for (let k = 0; k < xo.length; k++) names.push(readName(xo.get(k)) ?? '')
      let behind = false
      try {
        const b = ref.get(BEHIND_KEY)
        behind = !isNull(b) && b.asBoolean()
      } catch {}
      return {
        ref,
        kind: 'mark' as const,
        type: mark as MarkType,
        behind,
        xobjects: names.filter(Boolean),
        shrink: readMatrix(ref.get(SHRINK_KEY))
      }
    }
    const wrap = readName(ref.get(WRAP_KEY))
    if (wrap === 'Begin') return { ref, kind: 'wrapBegin' as const }
    if (wrap === 'End') return { ref, kind: 'wrapEnd' as const }
    return { ref, kind: 'orig' as const }
  })
}

/** Parsed settings stored on a mark stream. */
export function readMarkSettings(ref: PDFObject): MarkSettings | null {
  try {
    return normalizeSettings(JSON.parse(readString(ref.get(SETTINGS_KEY))))
  } catch {
    return null
  }
}

// ---- apply context --------------------------------------------------------------------------

/** A watermark/background file loaded by the UI (page-marks.loadSource). */
export type LoadedSource =
  | { kind: 'image'; image: MuPDF.Image; width: number; height: number; pageCount: 1 }
  | { kind: 'pdf'; doc: PDFDocument; pageCount: number }

export function loadedSources(s: Session): Map<string, LoadedSource> {
  let map = s.state.get('page-marks:sources') as Map<string, LoadedSource> | undefined
  if (!map) {
    map = new Map()
    s.state.set('page-marks:sources', map)
  }
  return map
}

const IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'jpe',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'jxr',
  'jp2',
  'jpx',
  'pnm',
  'pbm',
  'pgm',
  'ppm',
  'psd'
]

export function loadSourceFile(s: Session, data: Uint8Array, fileName: string): LoadedSource {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? '').toLowerCase()
  if (IMAGE_EXTENSIONS.includes(ext)) {
    try {
      const image = new s.mupdf.Image(data)
      const dpiX = image.getXResolution()
      const dpiY = image.getYResolution()
      const rx = dpiX >= 10 && dpiX <= 4800 ? dpiX : 72
      const ry = dpiY >= 10 && dpiY <= 4800 ? dpiY : 72
      return {
        kind: 'image',
        image,
        width: (image.getWidth() * 72) / rx,
        height: (image.getHeight() * 72) / ry,
        pageCount: 1
      }
    } catch {
      // fall through to the document importer
    }
  }
  try {
    const doc = openSource(s, data, fileName)
    const pageCount = doc.countPages()
    if (pageCount < 1) throw new EngineError(`${fileName} has no pages`, 'NO_PAGES')
    return { kind: 'pdf', doc, pageCount }
  } catch (err) {
    if (err instanceof EngineError) throw err
    throw new EngineError(
      `${fileName} could not be read as an image or PDF: ${(err as Error).message}`,
      'BAD_SOURCE'
    )
  }
}

/** Copies one page of another document into `doc` as a Form XObject drawn upright at [0 0 w h]. */
function pageAsForm(
  doc: PDFDocument,
  src: PDFDocument,
  pageIndex: number
): { ref: PDFObject; width: number; height: number } {
  const page = src.loadPage(pageIndex)
  try {
    const frame = pageFrame(page)
    const pageObj = src.findPage(pageIndex)
    const map = doc.newGraftMap()
    const resources = pageObj.getInheritable('Resources')
    const contents = pageObj.get('Contents')
    const chunks: Uint8Array[] = []
    const parts: PDFObject[] = []
    if (!isNull(contents)) {
      if (contents.isArray()) for (let k = 0; k < contents.length; k++) parts.push(contents.get(k))
      else parts.push(contents)
    }
    for (const p of parts) {
      try {
        const buf = p.readStream()
        chunks.push(buf.asUint8Array().slice())
        buf.destroy()
      } catch {}
    }
    const total = chunks.reduce((n, c) => n + c.length + 1, 0)
    const content = new Uint8Array(total)
    let at = 0
    for (const c of chunks) {
      content.set(c, at)
      content[at + c.length] = 0x0a
      at += c.length + 1
    }
    const mediaBox = pageObj.getInheritable('MediaBox')
    const cropRaw = pageObj.getInheritable('CropBox')
    const box = isNull(cropRaw) ? mediaBox : cropRaw
    const bboxArr = doc.newArray()
    const boxR = box.resolve()
    for (let k = 0; k < 4; k++) bboxArr.push(readNumber(boxR.get(k), 0))
    const d = doc.newDictionary()
    d.put('Type', doc.newName('XObject'))
    d.put('Subtype', doc.newName('Form'))
    d.put('BBox', bboxArr)
    // user space of the source page -> upright view space with the origin at its bottom-left
    d.put('Matrix', matrixArray(doc, frame.userToView))
    d.put('Resources', isNull(resources) ? doc.newDictionary() : map.graftObject(resources))
    const ref = doc.addStream(content, d)
    return { ref, width: frame.width, height: frame.height }
  } finally {
    page.destroy()
  }
}

interface SourceObject {
  ref: PDFObject
  kind: 'image' | 'form'
  width: number
  height: number
}

/** Finds the source XObject (image or imported page) used by existing marks of a type. */
export function findExistingSource(
  s: Session,
  type: MarkType,
  hintPages: number[] = []
): SourceObject | null {
  const doc = s.pdf
  const n = s.pageCount()
  const order = [...hintPages, ...Array.from({ length: n }, (_, i) => i)]
  const seen = new Set<number>()
  for (const i of order) {
    if (seen.has(i) || i < 0 || i >= n) continue
    seen.add(i)
    for (const e of readEntries(doc.findPage(i))) {
      if (e.kind !== 'mark' || e.type !== type) continue
      const src = e.ref.get(SOURCE_KEY)
      if (isNull(src)) continue
      const size = e.ref.get(SOURCE_SIZE_KEY)
      const hasSize = !isNull(size) && size.isArray() && size.length >= 2
      const subtype = readName(src.get('Subtype'))
      return {
        ref: src,
        kind: subtype === 'Image' ? 'image' : 'form',
        width: hasSize ? readNumber(size.get(0), 100) : 100,
        height: hasSize ? readNumber(size.get(1), 100) : 100
      }
    }
  }
  return null
}

interface ApplyContext {
  s: Session
  doc: PDFDocument
  settings: MarkSettings
  settingsRef: PDFObject
  fonts: Map<string, PDFObject>
  wrapBegin: PDFObject | null
  wrapEnd: PDFObject | null
  source: SourceObject | null
  shared: { ref: PDFObject; width: number; height: number } | null
  ocg: PDFObject | null
  preview: boolean
}

/**
 * A standard (base-14) font with WinAnsiEncoding: the same dictionary addSimpleFont(font, 'Latin')
 * writes for these fonts. It is built directly because MuPDF's addSimpleFont/addImage keep a
 * per-document resource cache that survives undo and rolled-back operations (previews), and would
 * then hand back references to objects that no longer exist.
 */
function fontRef(ctx: ApplyContext, f: FontSpec): PDFObject {
  const name = base14Name(f)
  let ref = ctx.fonts.get(name)
  if (!ref) {
    const doc = ctx.doc
    const d = doc.newDictionary()
    d.put('Type', doc.newName('Font'))
    d.put('Subtype', doc.newName('Type1'))
    d.put('BaseFont', doc.newName(name))
    d.put('Encoding', doc.newName('WinAnsiEncoding'))
    ref = doc.addObject(d)
    ctx.fonts.set(name, ref)
  }
  return ref
}

/** Adds an image XObject without MuPDF's image resource cache (see fontRef). */
function addImageObject(s: Session, doc: PDFDocument, image: MuPDF.Image): PDFObject {
  const tmp = new s.mupdf.PDFDocument()
  try {
    return doc.graftObject(tmp.addImage(image))
  } finally {
    tmp.destroy()
  }
}

function fontResources(ctx: ApplyContext, f: FontSpec, opacity?: number): PDFObject {
  const doc = ctx.doc
  const res = doc.newDictionary()
  const fonts = doc.newDictionary()
  fonts.put('F0', fontRef(ctx, f))
  res.put('Font', fonts)
  if (opacity !== undefined && opacity < 1) {
    const gs = doc.newDictionary()
    gs.put('GS0', opacityState(doc, opacity))
    res.put('ExtGState', gs)
  }
  return res
}

function wrapStream(ctx: ApplyContext, which: 'Begin' | 'End', shrink: Matrix | null = null): PDFObject {
  const doc = ctx.doc
  if (!shrink) {
    const cached = which === 'Begin' ? ctx.wrapBegin : ctx.wrapEnd
    if (cached) return cached
  }
  const d = doc.newDictionary()
  d.put(WRAP_KEY, doc.newName(which))
  const ref = doc.addStream(which === 'Begin' ? `q\n${shrink ? cm(shrink) + '\n' : ''}` : '\nQ\n', d)
  if (!shrink) {
    if (which === 'Begin') ctx.wrapBegin = ref
    else ctx.wrapEnd = ref
  }
  return ref
}

const UNDER_ORDER: Record<MarkType, number> = { Background: 0, Watermark: 1, HeaderFooter: 2, Bates: 3 }

/** Writes the page's /Contents from its original streams and the given marks. */
function writeContents(ctx: ApplyContext, pageObj: PDFObject, entries: ContentEntry[]) {
  const doc = ctx.doc
  const marks = entries.filter((e) => e.kind === 'mark')
  const orig = entries.filter((e) => e.kind === 'orig')
  const under = marks.filter((m) => m.behind).sort((a, b) => UNDER_ORDER[a.type!] - UNDER_ORDER[b.type!])
  const over = marks.filter((m) => !m.behind)
  const shrink = marks.find((m) => m.shrink)?.shrink ?? null
  const list: PDFObject[] = under.map((m) => m.ref)
  const wrap = orig.length > 0 && (over.length > 0 || !!shrink)
  if (wrap) list.push(wrapStream(ctx, 'Begin', shrink))
  for (const o of orig) list.push(o.ref)
  if (wrap) list.push(wrapStream(ctx, 'End'))
  for (const m of over) list.push(m.ref)
  if (!list.length) {
    pageObj.delete('Contents')
  } else if (list.length === 1) {
    pageObj.put('Contents', list[0])
  } else {
    const arr = doc.newArray()
    for (const r of list) arr.push(r)
    pageObj.put('Contents', arr)
  }
}

/** The page's own resource dictionary (an inherited one is copied onto the page first). */
function ownResources(doc: PDFDocument, pageObj: PDFObject): PDFObject {
  let res = pageObj.get('Resources')
  if (isNull(res)) {
    const inherited = pageObj.getInheritable('Resources')
    pageObj.put('Resources', isNull(inherited) ? doc.newDictionary() : copyObject(doc, inherited.resolve()))
    res = pageObj.get('Resources')
  }
  return res
}

function xobjectDict(doc: PDFDocument, res: PDFObject): PDFObject {
  let xo = res.get('XObject')
  if (isNull(xo)) {
    res.put('XObject', doc.newDictionary())
    xo = res.get('XObject')
  }
  return xo
}

function uniqueName(xo: PDFObject, ref: PDFObject): string {
  const base = `FcMk${ref.asIndirect()}`
  let name = base
  let k = 1
  while (!isNull(xo.get(name))) name = `${base}_${k++}`
  return name
}

/** Removes marks of `type` from one page. Returns true when something was removed. */
function removeFromPage(ctx: ApplyContext, pageIndex: number, type: MarkType): boolean {
  const doc = ctx.doc
  const pageObj = doc.findPage(pageIndex)
  const entries = readEntries(pageObj)
  const removed = entries.filter((e) => e.kind === 'mark' && e.type === type)
  if (!removed.length) return false
  const res = pageObj.get('Resources')
  if (!isNull(res)) {
    const xo = res.get('XObject')
    if (!isNull(xo) && xo.isDictionary()) {
      for (const r of removed) for (const name of r.xobjects ?? []) xo.delete(name)
      if (dictSize(xo) === 0) res.delete('XObject')
    }
  }
  writeContents(
    ctx,
    pageObj,
    entries.filter((e) => !removed.includes(e))
  )
  return true
}

interface NewMark {
  /** Operators to paint, in view space, using the named XObjects. */
  content: string
  xobjects: { name?: string; ref: PDFObject; placeholder: string }[]
  behind: boolean
  shrink: Matrix | null
}

function addToPage(ctx: ApplyContext, pageIndex: number, mark: NewMark) {
  const doc = ctx.doc
  const pageObj = doc.findPage(pageIndex)
  const res = ownResources(doc, pageObj)
  const xo = xobjectDict(doc, res)
  let content = mark.content
  const names: string[] = []
  for (const x of mark.xobjects) {
    const name = uniqueName(xo, x.ref)
    xo.put(name, x.ref)
    names.push(name)
    content = content.split(x.placeholder).join(`/${name}`)
  }
  const d = doc.newDictionary()
  d.put(MARK_KEY, doc.newName(ctx.settings.type))
  d.put(SETTINGS_KEY, ctx.settingsRef)
  const nameArr = doc.newArray()
  for (const n of names) nameArr.push(doc.newName(n))
  d.put(XOBJECTS_KEY, nameArr)
  if (mark.behind) d.put(BEHIND_KEY, true)
  if (mark.shrink) d.put(SHRINK_KEY, matrixArray(doc, mark.shrink))
  if (ctx.source) {
    d.put(SOURCE_KEY, ctx.source.ref)
    const size = doc.newArray()
    size.push(ctx.source.width)
    size.push(ctx.source.height)
    d.put(SOURCE_SIZE_KEY, size)
  }
  if (ctx.ocg) d.put(OCG_KEY, ctx.ocg)
  const ref = doc.addStream(`\n${content}\n`, d)
  const entries = readEntries(pageObj)
  entries.push({
    ref,
    kind: 'mark',
    type: ctx.settings.type,
    behind: mark.behind,
    xobjects: names,
    shrink: mark.shrink
  })
  writeContents(ctx, pageObj, entries)
}

// ---- optional content (show when printing / displaying) -------------------------------------

function nameArrayIncludes(arr: PDFObject, ref: PDFObject): boolean {
  for (let k = 0; k < arr.length; k++) {
    const v = arr.get(k)
    if (v.isIndirect() && v.asIndirect() === ref.asIndirect()) return true
  }
  return false
}

function removeFromArray(arr: PDFObject, nums: Set<number>) {
  if (isNull(arr) || !arr.isArray()) return
  for (let k = arr.length - 1; k >= 0; k--) {
    const v = arr.get(k)
    if (v.isIndirect() && nums.has(v.asIndirect())) arr.delete(k)
  }
}

function ensureArray(doc: PDFDocument, dict: PDFObject, key: string): PDFObject {
  let a = dict.get(key)
  if (isNull(a) || !a.isArray()) {
    dict.put(key, doc.newArray())
    a = dict.get(key)
  }
  return a
}

/** An optional content group whose usage hides the mark when printing and/or on screen. */
function ensureOcg(doc: PDFDocument, label: string, print: boolean, view: boolean): PDFObject {
  const root = doc.getTrailer().get('Root')
  let ocp = root.get('OCProperties')
  if (isNull(ocp)) {
    const d = doc.newDictionary()
    d.put('OCGs', doc.newArray())
    const config = doc.newDictionary()
    config.put('ON', doc.newArray())
    config.put('OFF', doc.newArray())
    config.put('Order', doc.newArray())
    d.put('D', config)
    root.put('OCProperties', d)
    ocp = root.get('OCProperties')
  }
  const ocgs = ensureArray(doc, ocp, 'OCGs')
  for (let k = 0; k < ocgs.length; k++) {
    const g = ocgs.get(k)
    if (isNull(g.get(OCG_KEY))) continue
    if (readString(g.get('Name')) !== label) continue
    let ps: string | null = null
    let vs: string | null = null
    try {
      ps = readName(g.get('Usage', 'Print', 'PrintState'))
      vs = readName(g.get('Usage', 'View', 'ViewState'))
    } catch {}
    if ((ps === 'ON') === print && (vs === 'ON') === view) return g
  }
  const g = doc.newDictionary()
  g.put('Type', doc.newName('OCG'))
  g.put('Name', doc.newString(label))
  g.put(OCG_KEY, true)
  const usage = doc.newDictionary()
  const pr = doc.newDictionary()
  pr.put('Subtype', doc.newName(label === 'Watermark' ? 'Watermark' : 'Artwork'))
  pr.put('PrintState', doc.newName(print ? 'ON' : 'OFF'))
  usage.put('Print', pr)
  const vw = doc.newDictionary()
  vw.put('ViewState', doc.newName(view ? 'ON' : 'OFF'))
  usage.put('View', vw)
  const ex = doc.newDictionary()
  ex.put('ExportState', doc.newName(print ? 'ON' : 'OFF'))
  usage.put('Export', ex)
  g.put('Usage', usage)
  const ref = doc.addObject(g)
  ocgs.push(ref)
  let config = ocp.get('D')
  if (isNull(config)) {
    ocp.put('D', doc.newDictionary())
    config = ocp.get('D')
  }
  // On by default; the usage dictionary (applied through /AS) decides per event.
  ensureArray(doc, config, 'ON').push(ref)
  ensureArray(doc, config, 'Order').push(ref)
  const as = ensureArray(doc, config, 'AS')
  for (const [event, category] of [
    ['View', 'View'],
    ['Print', 'Print'],
    ['Export', 'Export']
  ] as const) {
    let entry: PDFObject | null = null
    for (let k = 0; k < as.length; k++) {
      const e = as.get(k)
      if (readName(e.get('Event')) === event) entry = e
    }
    if (!entry) {
      const e = doc.newDictionary()
      e.put('Event', doc.newName(event))
      const cat = doc.newArray()
      cat.push(doc.newName(category))
      e.put('Category', cat)
      e.put('OCGs', doc.newArray())
      as.push(e)
      entry = as.get(as.length - 1)
    }
    const list = ensureArray(doc, entry, 'OCGs')
    if (!nameArrayIncludes(list, ref)) list.push(ref)
  }
  return ref
}

/** Drops our optional content groups that no mark uses any more. */
function pruneOcgs(s: Session) {
  const doc = s.pdf
  const root = doc.getTrailer().get('Root')
  const ocp = root.get('OCProperties')
  if (isNull(ocp)) return
  const ocgs = ocp.get('OCGs')
  if (isNull(ocgs) || !ocgs.isArray()) return
  const ours = new Set<number>()
  for (let k = 0; k < ocgs.length; k++) {
    const g = ocgs.get(k)
    if (g.isIndirect() && !isNull(g.get(OCG_KEY))) ours.add(g.asIndirect())
  }
  if (!ours.size) return
  const used = new Set<number>()
  const n = s.pageCount()
  for (let i = 0; i < n; i++) {
    for (const e of readEntries(doc.findPage(i))) {
      if (e.kind !== 'mark') continue
      const o = e.ref.get(OCG_KEY)
      if (!isNull(o) && o.isIndirect()) used.add(o.asIndirect())
    }
  }
  const unused = new Set([...ours].filter((x) => !used.has(x)))
  if (!unused.size) return
  removeFromArray(ocgs, unused)
  const config = ocp.get('D')
  if (!isNull(config)) {
    removeFromArray(config.get('ON'), unused)
    removeFromArray(config.get('OFF'), unused)
    removeFromArray(config.get('Order'), unused)
    const as = config.get('AS')
    if (!isNull(as) && as.isArray()) {
      for (let k = as.length - 1; k >= 0; k--) {
        const list = as.get(k).get('OCGs')
        removeFromArray(list, unused)
        if (isNull(list) || list.length === 0) as.delete(k)
      }
      if (as.length === 0) config.delete('AS')
    }
  }
  if (ocgs.length === 0) root.delete('OCProperties')
}

// ---- building marks -------------------------------------------------------------------------

const SLOT_ALIGN: Record<Slot, 'left' | 'center' | 'right'> = {
  headerLeft: 'left',
  headerCenter: 'center',
  headerRight: 'right',
  footerLeft: 'left',
  footerCenter: 'center',
  footerRight: 'right'
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}

/** Layout of a header or footer slot's lines in view space. */
function slotLines(
  m: Mupdf,
  font: FontSpec,
  slot: Slot,
  lines: string[],
  frame: PageFrame,
  margins: { top: number; bottom: number; left: number; right: number }
): TextLineLayout[] {
  const size = font.size
  const leading = size * LEADING
  const isHeader = slot.startsWith('header')
  const align = SLOT_ALIGN[slot]
  return lines.map((text, k) => {
    const width = measure(m, font, text)
    const x =
      align === 'left'
        ? margins.left
        : align === 'right'
          ? frame.width - margins.right - width
          : (frame.width - width) / 2
    const y = isHeader
      ? frame.height - margins.top - size * ASCENT - k * leading
      : margins.bottom + size * DESCENT + (lines.length - 1 - k) * leading
    return { text, x, y, width }
  })
}

function artifact(subtype: string): string {
  return `/Artifact <</Type /Pagination /Subtype /${subtype}>> BDC`
}

/** Page numbers for every page of the range: number shown and the "n" total. */
function numbering(pages: number[], start: number) {
  const first = pages[0] ?? 0
  const last = pages[pages.length - 1] ?? 0
  return {
    numberOf: (p: number) => start + (p - first),
    total: start + (last - first)
  }
}

function headerFooterMark(
  ctx: ApplyContext,
  settings: HeaderFooterSettings,
  pageIndex: number,
  number: number,
  total: number
): NewMark | null {
  const m = ctx.s.mupdf
  const page = ctx.s.page(pageIndex)
  const frame = pageFrame(page)
  const date = new Date(settings.date || Date.now())
  const tokenCtx = { page: number, total, date: Number.isNaN(date.getTime()) ? new Date() : date }
  const header: TextLineLayout[] = []
  const footer: TextLineLayout[] = []
  let headerBand = 0
  let footerBand = 0
  const leading = settings.font.size * LEADING
  for (const slot of Object.keys(SLOT_ALIGN) as Slot[]) {
    const raw = settings.text[slot] ?? ''
    if (!raw.trim()) continue
    const lines = splitLines(expandTokens(raw, tokenCtx))
    if (!lines.length) continue
    const laid = slotLines(m, settings.font, slot, lines, frame, settings.margins)
    if (slot.startsWith('header')) {
      header.push(...laid)
      headerBand = Math.max(headerBand, settings.margins.top + lines.length * leading)
    } else {
      footer.push(...laid)
      footerBand = Math.max(footerBand, settings.margins.bottom + lines.length * leading)
    }
  }
  if (!header.length && !footer.length) return null
  const bbox: Rect = [0, 0, frame.width, frame.height]
  const xobjects: NewMark['xobjects'] = []
  const parts: string[] = ['q', cm(frame.viewToUser)]
  if (header.length) {
    const ref = newForm(
      ctx.doc,
      bbox,
      fontResources(ctx, settings.font),
      textOperators(settings.font, header)
    )
    xobjects.push({ ref, placeholder: '@H@' })
    parts.push(artifact('Header'), '@H@ Do', 'EMC')
  }
  if (footer.length) {
    const ref = newForm(
      ctx.doc,
      bbox,
      fontResources(ctx, settings.font),
      textOperators(settings.font, footer)
    )
    xobjects.push({ ref, placeholder: '@F@' })
    parts.push(artifact('Footer'), '@F@ Do', 'EMC')
  }
  parts.push('Q')
  let shrink: Matrix | null = null
  if (settings.shrink) {
    const avail = frame.height - headerBand - footerBand
    if (avail < frame.height * 0.2) {
      throw new EngineError(
        'The header and footer are too tall to shrink the page content under them',
        'TOO_TALL'
      )
    }
    const k = Math.min(1, avail / frame.height)
    if (k < 0.9999) {
      const view: Matrix = [
        k,
        0,
        0,
        k,
        (frame.width - frame.width * k) / 2,
        footerBand + (avail - frame.height * k) / 2
      ]
      shrink = multiplyMatrix(multiplyMatrix(frame.userToView, view), frame.viewToUser)
    }
  }
  return { content: parts.join('\n'), xobjects, behind: false, shrink }
}

function batesMark(ctx: ApplyContext, settings: BatesSettings, pageIndex: number, number: number): NewMark {
  const page = ctx.s.page(pageIndex)
  const frame = pageFrame(page)
  const text = formatBates(settings, number)
  const laid = slotLines(ctx.s.mupdf, settings.font, settings.slot, [text], frame, settings.margins)
  const ref = newForm(
    ctx.doc,
    [0, 0, frame.width, frame.height],
    fontResources(ctx, settings.font),
    textOperators(settings.font, laid)
  )
  const subtype = settings.slot.startsWith('header') ? 'Header' : 'Footer'
  return {
    content: ['q', cm(frame.viewToUser), artifact(subtype), '@B@ Do', 'EMC', 'Q'].join('\n'),
    xobjects: [{ ref, placeholder: '@B@' }],
    behind: false,
    shrink: null
  }
}

/** The shared appearance (one Form XObject used on every page) of a watermark or background. */
function sharedAppearance(
  ctx: ApplyContext,
  settings: WatermarkSettings | BackgroundSettings
): { ref: PDFObject; width: number; height: number } {
  const doc = ctx.doc
  const extra = (d: PDFObject) => {
    if (ctx.ocg) d.put('OC', ctx.ocg)
  }
  const src = settings.source
  if (src.kind === 'color') {
    const res = doc.newDictionary()
    const parts: string[] = []
    if (settings.opacity < 1) {
      const gs = doc.newDictionary()
      gs.put('GS0', opacityState(doc, settings.opacity))
      res.put('ExtGState', gs)
      parts.push('/GS0 gs')
    }
    parts.push(`${rgb(src.color)} rg 0 0 1 1 re f`)
    return { ref: newForm(doc, [0, 0, 1, 1], res, parts.join('\n'), extra), width: 1, height: 1 }
  }
  if (src.kind === 'text') {
    const m = ctx.s.mupdf
    const font = src.font
    const lines = splitLines(src.text)
    if (!lines.length || !lines.some((l) => l.trim()))
      throw new EngineError('Type the watermark text first', 'NO_TEXT')
    const leading = font.size * LEADING
    const widths = lines.map((l) => measure(m, font, l))
    const w = Math.max(1, ...widths)
    const h = (lines.length - 1) * leading + font.size
    const laid = lines.map((text, k) => ({
      text,
      width: widths[k],
      x: src.align === 'left' ? 0 : src.align === 'right' ? w - widths[k] : (w - widths[k]) / 2,
      y: h - font.size * 0.8 - k * leading
    }))
    const res = fontResources(ctx, font, settings.opacity)
    const ops = (settings.opacity < 1 ? '/GS0 gs\n' : '') + textOperators(font, laid)
    const pad = font.size
    return { ref: newForm(doc, [-pad, -pad, w + pad, h + pad], res, ops, extra), width: w, height: h }
  }
  // file
  const source = ctx.source
  if (!source) throw new EngineError('Choose a file first', 'NO_SOURCE')
  const scale = Math.max(0.01, (src.scale || 100) / 100)
  const w = source.width * scale
  const h = source.height * scale
  const res = doc.newDictionary()
  const xo = doc.newDictionary()
  xo.put('Src', source.ref)
  res.put('XObject', xo)
  const parts: string[] = []
  if (settings.opacity < 1) {
    const gs = doc.newDictionary()
    gs.put('GS0', opacityState(doc, settings.opacity))
    res.put('ExtGState', gs)
    parts.push('/GS0 gs')
  }
  if (source.kind === 'image') parts.push(`q ${num(w)} 0 0 ${num(h)} 0 0 cm /Src Do Q`)
  else parts.push(`q ${num(scale)} 0 0 ${num(scale)} 0 0 cm /Src Do Q`)
  return { ref: newForm(doc, [0, 0, w, h], res, parts.join('\n'), extra), width: w, height: h }
}

/** Placement of a shared appearance on one page, in view space. */
export function placement(
  frame: PageFrame,
  size: { width: number; height: number },
  opts: { rotation: number; relativeScale: number | null; position: WatermarkSettings['position'] }
): Matrix {
  const { width: w, height: h } = size
  const rot = rotation(opts.rotation || 0)
  const bw = Math.abs(w * rot[0]) + Math.abs(h * rot[2])
  const bh = Math.abs(w * rot[1]) + Math.abs(h * rot[3])
  const f = opts.relativeScale
    ? (opts.relativeScale / 100) *
      Math.min(frame.width / Math.max(bw, 1e-6), frame.height / Math.max(bh, 1e-6))
    : 1
  const p = opts.position
  const cx =
    p.hAlign === 'left'
      ? p.hOffset + (f * bw) / 2
      : p.hAlign === 'right'
        ? frame.width - p.hOffset - (f * bw) / 2
        : frame.width / 2 + p.hOffset
  const cy =
    p.vAlign === 'top'
      ? frame.height - p.vOffset - (f * bh) / 2
      : p.vAlign === 'bottom'
        ? p.vOffset + (f * bh) / 2
        : frame.height / 2 - p.vOffset
  let mtx: Matrix = [1, 0, 0, 1, -w / 2, -h / 2]
  mtx = multiplyMatrix(mtx, [f, 0, 0, f, 0, 0])
  mtx = multiplyMatrix(mtx, rot)
  mtx = multiplyMatrix(mtx, [1, 0, 0, 1, cx, cy])
  return mtx
}

function appearanceMark(
  ctx: ApplyContext,
  settings: WatermarkSettings | BackgroundSettings,
  pageIndex: number
): NewMark {
  const frame = pageFrame(ctx.s.page(pageIndex))
  const shared = ctx.shared!
  const view: Matrix =
    settings.source.kind === 'color'
      ? [frame.width, 0, 0, frame.height, 0, 0]
      : placement(frame, shared, settings)
  const subtype = settings.type === 'Background' ? 'Background' : 'Watermark'
  return {
    content: ['q', artifact(subtype), cm(multiplyMatrix(view, frame.viewToUser)), '@A@ Do', 'EMC', 'Q'].join(
      '\n'
    ),
    xobjects: [{ ref: shared.ref, placeholder: '@A@' }],
    behind: settings.type === 'Background' ? true : settings.behind,
    shrink: null
  }
}

function sourceObject(
  ctx: ApplyContext,
  settings: WatermarkSettings | BackgroundSettings,
  hintPages: number[]
): SourceObject | null {
  const src = settings.source
  if (src.kind !== 'file') return null
  if (src.sourceId) {
    const loaded = loadedSources(ctx.s).get(src.sourceId)
    if (!loaded) throw new EngineError('The chosen file is no longer loaded. Choose it again.', 'NO_SOURCE')
    if (loaded.kind === 'image') {
      return {
        ref: addImageObject(ctx.s, ctx.doc, loaded.image),
        kind: 'image',
        width: loaded.width,
        height: loaded.height
      }
    }
    const pageIndex = Math.min(loaded.pageCount, Math.max(1, Math.round(src.page || 1))) - 1
    const form = pageAsForm(ctx.doc, loaded.doc, pageIndex)
    return { ref: form.ref, kind: 'form', width: form.width, height: form.height }
  }
  const existing = findExistingSource(ctx.s, settings.type, hintPages)
  if (!existing)
    throw new EngineError(
      `Choose a file for the ${settings.type === 'Watermark' ? 'watermark' : 'background'}`,
      'NO_SOURCE'
    )
  return existing
}

export interface ApplyOptions {
  /** 'add' keeps existing marks of the same type; 'replace' removes them first. */
  mode: 'add' | 'replace'
}

/**
 * Applies marks to the session document. With `previewPage`, only that page is processed (for
 * an exact preview inside an abandoned journal operation) and no optional content is created.
 * Returns the indices of the pages that changed.
 */
export function applyMarks(
  s: Session,
  input: MarkSettings,
  opts: ApplyOptions,
  previewPage?: number
): number[] {
  const settings = normalizeSettings(input)
  if (!settings) throw new EngineError('Invalid settings', 'BAD_SETTINGS')
  const doc = s.pdf
  const count = s.pageCount()
  const range = resolvePageRange(settings.range, count)
  if (!range.length) throw new EngineError('The page range does not include any pages', 'EMPTY_RANGE')
  const preview = previewPage !== undefined
  const targets = preview ? range.filter((p) => p === previewPage) : range
  const ctx: ApplyContext = {
    s,
    doc,
    settings,
    settingsRef: doc.addObject(doc.newString(JSON.stringify(storableSettings(settings)))),
    fonts: new Map(),
    wrapBegin: null,
    wrapEnd: null,
    source: null,
    shared: null,
    ocg: null,
    preview
  }
  const changed = new Set<number>()
  if (settings.type === 'Watermark' || settings.type === 'Background') {
    // Resolve the source before existing marks (which may hold it) are removed.
    ctx.source = sourceObject(ctx, settings, preview ? [previewPage!] : range)
  }
  if (opts.mode === 'replace') {
    const pages = preview ? [previewPage!] : Array.from({ length: count }, (_, i) => i)
    for (const i of pages) if (removeFromPage(ctx, i, settings.type)) changed.add(i)
  }
  if (settings.type === 'Watermark' || settings.type === 'Background') {
    if (!preview && (!settings.showOnPrint || !settings.showOnScreen)) {
      ctx.ocg = ensureOcg(
        doc,
        settings.type === 'Watermark' ? 'Watermark' : 'Background',
        settings.showOnPrint,
        settings.showOnScreen
      )
    }
    if (targets.length) ctx.shared = sharedAppearance(ctx, settings)
  }
  const numbers = numbering(range, settings.type === 'HeaderFooter' ? settings.startNumber : 0)
  const rangeIndex = new Map(range.map((p, k) => [p, k]))
  let added = 0
  targets.forEach((i, k) => {
    let mark: NewMark | null = null
    switch (settings.type) {
      case 'HeaderFooter':
        mark = headerFooterMark(ctx, settings, i, numbers.numberOf(i), numbers.total)
        break
      case 'Bates':
        mark = batesMark(ctx, settings, i, settings.start + (rangeIndex.get(i) ?? 0))
        break
      case 'Watermark':
      case 'Background':
        mark = appearanceMark(ctx, settings, i)
        break
    }
    if (mark) {
      addToPage(ctx, i, mark)
      changed.add(i)
      added++
    }
    if (!preview && targets.length > 20 && k % 10 === 9)
      s.progress((k + 1) / targets.length, `Page ${k + 1} of ${targets.length}`)
  })
  if (!preview && settings.type === 'HeaderFooter' && added === 0) {
    throw new EngineError('Type some header or footer text first', 'NO_TEXT')
  }
  if (!preview && opts.mode === 'replace') pruneOcgs(s)
  return [...changed].sort((a, b) => a - b)
}

/** Removes every mark of a type. Returns the pages that changed. */
export function removeMarks(s: Session, type: MarkType): number[] {
  const doc = s.pdf
  const settingsRef = doc.newNull()
  const ctx: ApplyContext = {
    s,
    doc,
    settings: { type } as MarkSettings,
    settingsRef,
    fonts: new Map(),
    wrapBegin: null,
    wrapEnd: null,
    source: null,
    shared: null,
    ocg: null,
    preview: false
  }
  const changed: number[] = []
  const n = s.pageCount()
  for (let i = 0; i < n; i++) if (removeFromPage(ctx, i, type)) changed.push(i)
  if (changed.length) pruneOcgs(s)
  return changed
}
