/**
 * The streams of a page's /Contents, telling the page's own content apart from page marks
 * (headers & footers, watermarks, backgrounds, Bates numbers) made by "Add header, watermark or
 * background".
 *
 * Those marks are separate content streams marked with their own keys, so they can be updated
 * and removed later. Editing text must leave them alone: the removal of edited glyphs only runs
 * over the page's own streams, new text is written next to the page's own content (inside the
 * marks' "wrap", which may scale the content down to make room for a header), and text drawn by
 * a mark is offered as the mark it is instead of as editable text.
 *
 * Pages without such marks are handled exactly as before; nothing here depends on the marks
 * feature being installed.
 */
import type { Matrix, Point } from '@shared/geometry'
import { invertMatrix, multiplyMatrix } from '@shared/geometry'
import type { PDFObject, Session } from '@engine/session'
import { isNull, readName } from '@engine/util/pdf'
import { observePageGlyphs } from './extract'
import type { MarkType } from './model'

/** Keys of the page-marks content streams (see the page-marks feature). */
const MARK_KEY = 'FartcrobatMark'
const WRAP_KEY = 'FartcrobatWrap'
const XOBJECTS_KEY = 'FartcrobatXObjects'
const BEHIND_KEY = 'FartcrobatBehind'

const MARK_TYPES: MarkType[] = ['HeaderFooter', 'Watermark', 'Background', 'Bates']

export interface ContentEntry {
  ref: PDFObject
  kind: 'own' | 'mark' | 'wrapBegin' | 'wrapEnd'
  type?: MarkType
  behind?: boolean
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export function contentEntries(pageObj: PDFObject): ContentEntry[] {
  const c = pageObj.get('Contents')
  const refs: PDFObject[] = []
  if (!isNull(c)) {
    if (c.isArray()) for (let k = 0; k < c.length; k++) refs.push(c.get(k))
    else refs.push(c)
  }
  return refs.map((ref) => {
    let stream = false
    try {
      stream = ref.isStream()
    } catch {}
    if (!stream) return { ref, kind: 'own' }
    const mark = readName(ref.get(MARK_KEY))
    if (mark && (MARK_TYPES as string[]).includes(mark)) {
      let behind = false
      try {
        const b = ref.get(BEHIND_KEY)
        behind = !isNull(b) && b.isBoolean() && b.asBoolean()
      } catch {}
      return { ref, kind: 'mark', type: mark as MarkType, behind }
    }
    const wrap = readName(ref.get(WRAP_KEY))
    if (wrap === 'Begin') return { ref, kind: 'wrapBegin' }
    if (wrap === 'End') return { ref, kind: 'wrapEnd' }
    return { ref, kind: 'own' }
  })
}

/** True when the page has page marks or their wrap streams. */
export function hasMarkStreams(entries: ContentEntry[]): boolean {
  return entries.some((e) => e.kind !== 'own')
}

const CM =
  /(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s+cm/g

/** The transformation a wrap stream sets up ("q a b c d e f cm"). */
function wrapTransform(ref: PDFObject): Matrix {
  let m = IDENTITY
  try {
    const text = ref.readStream().asString()
    for (const g of text.matchAll(CM)) {
      const cm = g.slice(1, 7).map(Number) as unknown as Matrix
      if (cm.every((v) => Number.isFinite(v))) m = multiplyMatrix(cm, m)
    }
  } catch {}
  return m
}

/**
 * Transformation (in PDF user space) that the page's own content is drawn with: the "cm" of the
 * wrap streams around the entry at `index` (identity when it is not wrapped).
 */
export function transformAt(entries: ContentEntry[], index: number): Matrix {
  const stack: Matrix[] = []
  for (let k = 0; k < Math.min(index, entries.length); k++) {
    const e = entries[k]
    if (e.kind === 'wrapBegin') stack.push(wrapTransform(e.ref))
    else if (e.kind === 'wrapEnd') stack.pop()
  }
  // inner transformations apply first
  let m = IDENTITY
  for (let k = stack.length - 1; k >= 0; k--) m = multiplyMatrix(m, stack[k])
  return m
}

function isIdentity(m: Matrix): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9)
}

function setContents(s: Session, pageObj: PDFObject, refs: PDFObject[]) {
  if (!refs.length) {
    pageObj.delete('Contents')
    return
  }
  const arr = s.pdf.newArray()
  for (const r of refs) arr.push(r)
  pageObj.put('Contents', arr)
}

/** Where new content goes, and the matrix that maps page space to the space it is written in. */
export interface InsertPlan {
  entries: ContentEntry[]
  /** Index of the first and last entry of the page's own content (-1 when there is none). */
  first: number
  last: number
  /** Page space -> the space new content is written in (PDF user space, minus any wrap). */
  toContent: Matrix
}

export function insertPlan(s: Session, pageIndex: number): InsertPlan {
  const pageObj = s.pdf.findPage(pageIndex)
  const entries = contentEntries(pageObj)
  const toUser = s.pageToUser(pageIndex)
  const first = entries.findIndex((e) => e.kind === 'own')
  let last = -1
  for (let k = entries.length - 1; k >= 0; k--)
    if (entries[k].kind === 'own') {
      last = k
      break
    }
  if (first < 0 || !hasMarkStreams(entries)) return { entries, first, last, toContent: toUser }
  const wrap = transformAt(entries, first)
  return {
    entries,
    first,
    last,
    toContent: isIdentity(wrap) ? toUser : multiplyMatrix(toUser, invertMatrix(wrap))
  }
}

/**
 * Wraps the page's own content in q/Q and appends `content` after it, so the graphics state of
 * the original content cannot leak into the new text. On pages with page marks the new streams
 * go around the page's own content (marks drawn on top stay on top).
 */
export function appendContent(s: Session, pageIndex: number, content: string, plan: InsertPlan) {
  const doc = s.pdf
  const pageObj = doc.findPage(pageIndex)
  const open = doc.addStream('q\n', doc.newDictionary())
  const close = doc.addStream('Q\n' + content, doc.newDictionary())
  const { entries, first, last } = plan
  const refs: PDFObject[] = []
  if (first < 0) {
    // no content of its own (a blank page, or only marks): new text goes before the marks drawn
    // on top of the page, after those drawn behind it
    let at = entries.findIndex((e) => e.kind === 'mark' && !e.behind)
    if (at < 0) at = entries.length
    entries.forEach((e, k) => {
      if (k === at) refs.push(open, close)
      refs.push(e.ref)
    })
    if (at === entries.length) refs.push(open, close)
  } else {
    entries.forEach((e, k) => {
      if (k === first) refs.push(open)
      refs.push(e.ref)
      if (k === last) refs.push(close)
    })
  }
  setContents(s, pageObj, refs)
}

/**
 * Runs `fn` (which rewrites the page content, e.g. applying a redaction) with only the page's
 * own content streams in /Contents, then puts the marks back where they were. `fn` receives the
 * matrix that maps page space as shown to page space as the own content sees it (identity when
 * the content is not wrapped). Returns false when the page has no content of its own.
 */
export function withOwnContent(s: Session, pageIndex: number, fn: (unwrap: Matrix) => void): boolean {
  const pageObj = s.pdf.findPage(pageIndex)
  const entries = contentEntries(pageObj)
  if (!hasMarkStreams(entries)) {
    fn(IDENTITY)
    return true
  }
  const first = entries.findIndex((e) => e.kind === 'own')
  if (first < 0) return false
  const wrap = transformAt(entries, first)
  const unwrap = isIdentity(wrap)
    ? IDENTITY
    : multiplyMatrix(multiplyMatrix(s.pageToUser(pageIndex), invertMatrix(wrap)), s.userToPage(pageIndex))
  const resources = snapshotResources(pageObj)
  setContents(
    s,
    pageObj,
    entries.filter((e) => e.kind === 'own').map((e) => e.ref)
  )
  try {
    fn(unwrap)
  } finally {
    const now = s.pdf.findPage(pageIndex)
    // rewriting the content keeps only the resources it uses: put back those of the marks
    restoreResources(s, now, resources)
    const c = now.get('Contents')
    const own: PDFObject[] = []
    if (!isNull(c)) {
      if (c.isArray()) for (let k = 0; k < c.length; k++) own.push(c.get(k))
      else own.push(c)
    }
    const refs: PDFObject[] = []
    entries.forEach((e, k) => {
      if (e.kind !== 'own') refs.push(e.ref)
      else if (k === first) refs.push(...own)
    })
    setContents(s, now, refs)
  }
  return true
}

/** Resource name -> object, per resource category (Font, XObject, ExtGState...). */
type ResourceSnapshot = Map<string, Map<string, PDFObject>>

function snapshotResources(pageObj: PDFObject): ResourceSnapshot {
  const out: ResourceSnapshot = new Map()
  const res = pageObj.getInheritable('Resources')
  if (isNull(res) || !res.isDictionary()) return out
  res.forEach((dict, cat) => {
    try {
      const d = dict.resolve()
      if (!d.isDictionary()) return
      const names = new Map<string, PDFObject>()
      d.forEach((v, k) => names.set(String(k), v))
      out.set(String(cat), names)
    } catch {}
  })
  return out
}

function restoreResources(s: Session, pageObj: PDFObject, snap: ResourceSnapshot) {
  if (!snap.size) return
  let res = pageObj.get('Resources')
  if (isNull(res) || !res.isDictionary()) {
    pageObj.put('Resources', s.pdf.newDictionary())
    res = pageObj.get('Resources')
  }
  for (const [cat, names] of snap) {
    let dict = res.get(cat)
    if (isNull(dict) || !dict.isDictionary()) {
      res.put(cat, s.pdf.newDictionary())
      dict = res.get(cat)
    }
    for (const [name, obj] of names) {
      const cur = dict.get(name)
      if (isNull(cur)) dict.put(name, obj)
    }
  }
}

// ---- glyphs drawn by marks ------------------------------------------------------------------

export interface MarkGlyph {
  type: MarkType
  origin: Point
}

const COPY_KEYS = ['ExtGState', 'Properties', 'ColorSpace', 'Pattern', 'Shading', 'Font']

/**
 * Origins (page space) of the glyphs drawn by the page's marks. The mark streams are run on a
 * copy of the page in a scratch document, so the document itself is never touched.
 */
export function markGlyphs(s: Session, pageIndex: number): MarkGlyph[] {
  const pageObj = s.pdf.findPage(pageIndex)
  const marks = contentEntries(pageObj).filter((e) => e.kind === 'mark')
  if (!marks.length) return []
  const m = s.mupdf
  const scratch = new m.PDFDocument()
  const out: MarkGlyph[] = []
  try {
    const graft = scratch.newGraftMap()
    const res = scratch.newDictionary()
    const pageRes = pageObj.getInheritable('Resources')
    if (!isNull(pageRes) && pageRes.isDictionary()) {
      for (const key of COPY_KEYS) {
        const v = pageRes.get(key)
        if (!isNull(v)) res.put(key, graft.graftObject(v))
      }
      // only the XObjects the marks draw (the page's own images can be large)
      const xo = pageRes.get('XObject')
      if (!isNull(xo) && xo.isDictionary()) {
        const names = new Set<string>()
        let all = false
        for (const mk of marks) {
          const list = mk.ref.get(XOBJECTS_KEY)
          if (isNull(list) || !list.isArray()) all = true
          else for (let k = 0; k < list.length; k++) names.add(readName(list.get(k)) ?? '')
        }
        const dict = scratch.newDictionary()
        xo.forEach((v, k) => {
          if (all || names.has(String(k))) dict.put(String(k), graft.graftObject(v))
        })
        res.put('XObject', dict)
      }
    }
    const types = [...new Set(marks.map((mk) => mk.type!))]
    for (const type of types) {
      const contents = scratch.newArray()
      for (const mk of marks) if (mk.type === type) contents.push(graft.graftObject(mk.ref))
      const page = scratch.addPage([0, 0, 612, 792], 0, res, '')
      for (const key of ['MediaBox', 'CropBox', 'Rotate', 'UserUnit']) {
        const v = pageObj.getInheritable(key)
        if (!isNull(v)) page.put(key, graft.graftObject(v))
      }
      page.put('Contents', contents)
      scratch.insertPage(-1, page)
    }
    types.forEach((type, k) => {
      const page = scratch.loadPage(k)
      try {
        for (const g of observePageGlyphs(m, page)) out.push({ type, origin: [g.m[4], g.m[5]] })
      } finally {
        page.destroy()
      }
    })
  } catch (err) {
    console.warn('[edit-text] could not read the page marks', err)
  } finally {
    scratch.destroy()
  }
  return out
}

/** Looks up which mark drew a glyph at a page-space origin. */
export function markIndex(glyphs: MarkGlyph[]): ((x: number, y: number) => MarkType | null) | null {
  if (!glyphs.length) return null
  const grid = new Map<string, MarkGlyph[]>()
  for (const g of glyphs) {
    const k = `${Math.round(g.origin[0])}:${Math.round(g.origin[1])}`
    const arr = grid.get(k)
    if (arr) arr.push(g)
    else grid.set(k, [g])
  }
  return (x, y) => {
    const gx = Math.round(x)
    const gy = Math.round(y)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const g of grid.get(`${gx + dx}:${gy + dy}`) ?? [])
          if (Math.abs(g.origin[0] - x) <= 0.05 && Math.abs(g.origin[1] - y) <= 0.05) return g.type
    return null
  }
}
