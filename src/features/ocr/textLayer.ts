/**
 * Writes and removes the invisible OCR text layer of a page (engine side).
 *
 * The layer is one content stream placed first in the page's /Contents, so it runs in the page's
 * initial graphics state and the original content needs no wrapping. It draws each word with text
 * render mode 3 (invisible) in the glyphless CID font, with a text matrix and horizontal scaling
 * fitted to the word's quad: text selection, search highlights and copy line up with the words in
 * the scanned image. The stream is tagged with /FartcrobatOCR so a later run replaces it.
 */
import type { Matrix, Point, Rect } from '@shared/geometry'
import { quadToRect, rectIntersection, transformPoint } from '@shared/geometry'
import type { PDFDocument, PDFObject, Session } from '@engine/session'
import { isNull, num, pdfDate, readName, readNumber, readString } from '@engine/util/pdf'
import {
  CidEncoder,
  cidsToHex,
  cidToGidMapFlate,
  GLYPH_ASCENT,
  GLYPH_DESCENT,
  GLYPH_WIDTH,
  GLYPHLESS_FONT_NAME,
  glyphLessFontProgram
} from './glyphless'
import type { OcrApplySummary, OcrLine, OcrPageResult, OcrWord } from './types'

/** Key on our content stream's dictionary. */
export const OCR_MARK_KEY = 'FartcrobatOCR'
const FONT_PREFIX = 'FcOCR'

export interface OcrLayerInfo {
  ref: PDFObject
  font: string | null
  chars: number
  words: number
  language: string
}

// ---- reading -----------------------------------------------------------------------------------

function contentRefs(pageObj: PDFObject): PDFObject[] {
  const c = pageObj.get('Contents')
  const refs: PDFObject[] = []
  if (isNull(c)) return refs
  if (c.isArray()) for (let k = 0; k < c.length; k++) refs.push(c.get(k))
  else refs.push(c)
  return refs
}

function isStream(o: PDFObject): boolean {
  try {
    return o.isStream()
  } catch {
    return false
  }
}

/** The OCR layers (normally zero or one) of a page. */
export function ocrLayers(pageObj: PDFObject): OcrLayerInfo[] {
  const out: OcrLayerInfo[] = []
  for (const ref of contentRefs(pageObj)) {
    if (!isStream(ref)) continue
    const mark = ref.get(OCR_MARK_KEY)
    if (isNull(mark)) continue
    const m = mark.resolve()
    out.push({
      ref,
      font: m.isDictionary() ? readName(m.get('Font')) : null,
      chars: m.isDictionary() ? readNumber(m.get('Chars'), 0) : 0,
      words: m.isDictionary() ? readNumber(m.get('Words'), 0) : 0,
      language: m.isDictionary() ? readString(m.get('Lang')) : ''
    })
  }
  return out
}

// ---- writing -----------------------------------------------------------------------------------

/** Font dictionary of the page itself (inherited or shared resources are copied onto the page). */
function ownFontDict(doc: PDFDocument, pageObj: PDFObject): PDFObject {
  const current = pageObj.get('Resources')
  const source = isNull(current) ? pageObj.getInheritable('Resources') : current
  const res = doc.newDictionary()
  if (!isNull(source)) source.resolve().forEach((v, k) => res.put(String(k), v))
  const fonts = doc.newDictionary()
  const oldFonts = res.get('Font')
  if (!isNull(oldFonts)) oldFonts.resolve().forEach((v, k) => fonts.put(String(k), v))
  res.put('Font', fonts)
  pageObj.put('Resources', res)
  return fonts
}

function writeContents(doc: PDFDocument, pageObj: PDFObject, list: PDFObject[]) {
  if (!list.length) pageObj.delete('Contents')
  else if (list.length === 1) pageObj.put('Contents', list[0])
  else {
    const arr = doc.newArray()
    for (const r of list) arr.push(r)
    pageObj.put('Contents', arr)
  }
}

/** Removes the OCR layers of a page (and their fonts). Returns how many were removed. */
export function removeOcrLayers(s: Session, pageIndex: number): number {
  const doc = s.pdf
  const pageObj = doc.findPage(pageIndex)
  const layers = ocrLayers(pageObj)
  if (!layers.length) return 0
  const drop = new Set(layers.map((l) => l.ref.asIndirect()))
  const keep = contentRefs(pageObj).filter((r) => !(r.isIndirect() && drop.has(r.asIndirect())))
  writeContents(doc, pageObj, keep)
  const fontNames = layers.map((l) => l.font).filter((f): f is string => !!f)
  if (fontNames.length) {
    // Our fonts only ever live in the page's own font dictionary (see ownFontDict).
    const res = pageObj.get('Resources')
    const fonts = isNull(res) ? null : res.get('Font')
    if (fonts && !isNull(fonts) && !res.isIndirect() && !fonts.isIndirect()) {
      for (const name of fontNames) fonts.delete(name)
    }
  }
  return layers.length
}

/** The Type0 font object of one OCR run (shared by every page written in that run). */
function createFont(doc: PDFDocument, encoder: CidEncoder): PDFObject {
  const program = glyphLessFontProgram()
  const fontFile = doc.addStream(program, { Length1: program.length })
  const cidToGid = doc.addRawStream(cidToGidMapFlate(), { Filter: doc.newName('FlateDecode') })
  const descriptor = doc.addObject({
    Type: doc.newName('FontDescriptor'),
    FontName: doc.newName(GLYPHLESS_FONT_NAME),
    Flags: 5,
    FontBBox: [0, GLYPH_DESCENT, GLYPH_WIDTH, GLYPH_ASCENT],
    ItalicAngle: 0,
    Ascent: GLYPH_ASCENT,
    Descent: GLYPH_DESCENT,
    CapHeight: GLYPH_ASCENT,
    StemV: 80,
    FontFile2: fontFile
  })
  const system = doc.newDictionary()
  system.put('Registry', doc.newString('Adobe'))
  system.put('Ordering', doc.newString('Identity'))
  system.put('Supplement', 0)
  const cidFont = doc.addObject({
    Type: doc.newName('Font'),
    Subtype: doc.newName('CIDFontType2'),
    BaseFont: doc.newName(GLYPHLESS_FONT_NAME),
    CIDSystemInfo: system,
    FontDescriptor: descriptor,
    DW: GLYPH_WIDTH,
    CIDToGIDMap: cidToGid
  })
  const toUnicode = doc.addStream(encoder.toUnicodeCMap(), {})
  return doc.addObject({
    Type: doc.newName('Font'),
    Subtype: doc.newName('Type0'),
    BaseFont: doc.newName(GLYPHLESS_FONT_NAME),
    Encoding: doc.newName('Identity-H'),
    DescendantFonts: [cidFont],
    ToUnicode: toUnicode
  })
}

function freeFontName(fonts: PDFObject): string {
  for (let i = 0; ; i++) {
    const name = i === 0 ? FONT_PREFIX : `${FONT_PREFIX}${i}`
    if (isNull(fonts.get(name))) return name
  }
}

const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]]
const len = (v: Point) => Math.hypot(v[0], v[1])
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1]

interface PlacedWord {
  cids: number[]
  /** Text matrix (user space): x axis along the baseline, y axis up the word, origin at ll. */
  tm: Matrix
  /** Font size and width of the word in user space. */
  size: number
  width: number
  ll: Point
  lr: Point
  dir: Point
}

function placeWord(word: OcrWord, toUser: Matrix, encoder: CidEncoder): PlacedWord | null {
  const q = word.quad
  if (!q || q.length !== 8 || q.some((v) => !Number.isFinite(v))) return null
  const cids = encoder.encode(word.text.trim())
  if (!cids.length) return null
  const ll = transformPoint([q[4], q[5]], toUser)
  const lr = transformPoint([q[6], q[7]], toUser)
  const ul = transformPoint([q[0], q[1]], toUser)
  const x = sub(lr, ll)
  const y = sub(ul, ll)
  const width = len(x)
  const size = len(y)
  if (width < 0.01 || size < 0.01) return null
  const dir: Point = [x[0] / width, x[1] / width]
  const up: Point = [y[0] / size, y[1] / size]
  return { cids, tm: [dir[0], dir[1], up[0], up[1], ll[0], ll[1]], size, width, ll, lr, dir }
}

/** Glyph advance at font size 1 and 100% horizontal scaling. */
const ADVANCE = GLYPH_WIDTH / 1000
/** Height of a glyph above the baseline, as a fraction of the font size. */
const HEIGHT = (GLYPH_ASCENT - GLYPH_DESCENT) / 1000

/** Content stream operators that draw the lines invisibly. Returns null when nothing is drawn. */
function buildStream(fontName: string, lines: OcrLine[], toUser: Matrix, encoder: CidEncoder) {
  const ops: string[] = ['q', 'BT', '3 Tr']
  let words = 0
  let chars = 0
  let currentSize = -1
  for (const line of lines) {
    const placed = (line.words ?? []).map((w) => placeWord(w, toUser, encoder)).filter((p): p is PlacedWord => !!p)
    for (let i = 0; i < placed.length; i++) {
      const w = placed[i]
      // Font size = word height (the glyphs span baseline..ascent), Tz stretches the advance
      // widths so the characters exactly cover the word.
      const size = w.size / HEIGHT
      if (Math.abs(size - currentSize) > 1e-4) {
        ops.push(`/${fontName} ${num(size)} Tf`)
        currentSize = size
      }
      ops.push(`${w.tm.map(num).join(' ')} Tm`)
      ops.push(`${num((100 * w.width) / (w.cids.length * ADVANCE * size))} Tz`)
      ops.push(`<${cidsToHex(w.cids)}> Tj`)
      words++
      chars += w.cids.length
      const next = placed[i + 1]
      if (!next) continue
      // A space fills the gap to the next word, so the words are extracted as one line with
      // single spaces between them (and no synthetic spaces from a viewer guessing).
      const gap = dot(sub(next.ll, w.lr), w.dir)
      const space = Math.max(gap, 0.1 * w.size)
      ops.push(`${num((100 * space) / (ADVANCE * size))} Tz`)
      ops.push('<0020> Tj')
    }
  }
  ops.push('ET', 'Q')
  return words ? { content: ops.join('\n') + '\n', words, chars } : null
}

/** Bounding boxes of the page's existing text lines (page space). */
function existingTextLines(s: Session, pageIndex: number): Rect[] {
  const rects: Rect[] = []
  const st = s.page(pageIndex).toStructuredText('preserve-whitespace')
  try {
    st.walk({
      beginLine(bbox) {
        rects.push(bbox as Rect)
      }
    })
  } finally {
    st.destroy()
  }
  return rects.filter((r) => r[2] > r[0] && r[3] > r[1])
}

function overlapsExisting(word: OcrWord, existing: Rect[]): boolean {
  if (!existing.length) return false
  const r = quadToRect(word.quad)
  const area = Math.max(1e-6, (r[2] - r[0]) * (r[3] - r[1]))
  let covered = 0
  for (const e of existing) {
    const i = rectIntersection(r, e)
    if (i) covered += (i[2] - i[0]) * (i[3] - i[1])
    if (covered >= area * 0.4) return true
  }
  return false
}

/** The font of one OCR run, shared by every page written in that run (created on first use). */
export class RunFont {
  readonly encoder = new CidEncoder()
  private ref: PDFObject | null = null

  constructor(private readonly doc: PDFDocument) {}

  get(): PDFObject {
    if (!this.ref) this.ref = createFont(this.doc, this.encoder)
    return this.ref
  }

  /** Rewrites the ToUnicode CMap once every page is written (it lists characters beyond the BMP). */
  finish() {
    if (!this.ref) return
    const tu = this.ref.get('ToUnicode')
    if (!isNull(tu)) tu.writeStream(this.encoder.toUnicodeCMap())
  }
}

/**
 * Replaces the OCR layer of one page with the given recognized lines. Returns how many words were
 * written and how many were left out because the page already had text there.
 */
export function writeOcrLayer(s: Session, result: OcrPageResult, font: RunFont, opts: { skipExistingText: boolean }): OcrApplySummary {
  const doc = s.pdf
  const pageIndex = result.page
  s.page(pageIndex) // validates the index
  const pageObj = doc.findPage(pageIndex)
  if (removeOcrLayers(s, pageIndex)) s.invalidatePage(pageIndex)
  s.touch(pageIndex)
  let lines = result.lines ?? []
  let skipped = 0
  if (opts.skipExistingText) {
    const existing = existingTextLines(s, pageIndex)
    if (existing.length) {
      lines = lines.map((l) => {
        const words = (l.words ?? []).filter((w) => !overlapsExisting(w, existing))
        skipped += (l.words?.length ?? 0) - words.length
        return { words }
      })
    }
  }
  if (!lines.some((l) => l.words?.length)) return { page: pageIndex, words: 0, skipped }
  const fonts = ownFontDict(doc, pageObj)
  const name = freeFontName(fonts)
  const built = buildStream(name, lines, s.pageToUser(pageIndex), font.encoder)
  if (!built) return { page: pageIndex, words: 0, skipped }
  fonts.put(name, font.get())
  const mark = doc.newDictionary()
  mark.put('Font', doc.newName(name))
  mark.put('Words', built.words)
  mark.put('Chars', built.chars)
  if (result.language) mark.put('Lang', doc.newString(result.language))
  if (result.dpi) mark.put('DPI', Math.round(result.dpi))
  mark.put('Created', doc.newString(pdfDate()))
  const stream = doc.addStream(built.content, { [OCR_MARK_KEY]: mark })
  writeContents(doc, pageObj, [stream, ...contentRefs(pageObj)])
  return { page: pageIndex, words: built.words, skipped }
}
