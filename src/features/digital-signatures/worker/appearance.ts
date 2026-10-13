/**
 * Visible signature appearance (Acrobat style): the signer's name in large type or their
 * handwritten signature image on the left, the signature details on the right.
 */
import type { Mupdf, PDFDocument, PDFObject } from '@engine/session'
import { num, pdfLiteral } from '@engine/util/pdf'
import type { AppearanceContent, RasterText } from '../types'

const WIN_ANSI_EXTRA: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88,
  0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93,
  0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
  0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f
}

function winAnsiCode(cp: number): number | null {
  if (cp >= 0x20 && cp <= 0x7e) return cp
  if (cp >= 0xa0 && cp <= 0xff) return cp
  return WIN_ANSI_EXTRA[cp] ?? null
}

/** "2026.10.11 14:22:05 +02'00'" like Acrobat. */
export function formatSignatureDate(time: number): string {
  const d = new Date(time)
  const pad = (v: number) => String(v).padStart(2, '0')
  const tz = -d.getTimezoneOffset()
  const sign = tz >= 0 ? '+' : '-'
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${sign}${pad(Math.floor(Math.abs(tz) / 60))}'${pad(Math.abs(tz) % 60)}'`
}

/** The text lines on the right-hand side. */
export function detailLines(c: AppearanceContent): string[] {
  const o = c.options
  const L = o.showLabels
  const lines: string[] = []
  if (o.showName && c.name) lines.push(L ? `Digitally signed by ${c.name}` : c.name)
  if (o.showDistinguishedName && c.distinguishedName) lines.push(L ? `DN: ${c.distinguishedName}` : c.distinguishedName)
  if (o.showReason && c.reason?.trim()) lines.push(L ? `Reason: ${c.reason.trim()}` : c.reason.trim())
  if (o.showLocation && c.location?.trim()) lines.push(L ? `Location: ${c.location.trim()}` : c.location.trim())
  if (o.showDate) lines.push(L ? `Date: ${formatSignatureDate(c.time)}` : formatSignatureDate(c.time))
  return lines
}

interface TextFont {
  key: string
  ref: PDFObject
  width: (s: string, size: number) => number
  encode: (s: string) => string
  /** The font has a glyph for every character of the text. */
  covers: (s: string) => boolean
  /** The font program is embedded (subset it before saving). */
  embedded: boolean
}

type MupdfFont = InstanceType<Mupdf['Font']>

/**
 * Fonts tried for the appearance text: Helvetica (Latin, Greek, Cyrillic) and MuPDF's CJK font
 * (Droid Sans Fallback: Chinese, Japanese, Korean, plus Latin, Greek and Cyrillic).
 */
const CANDIDATE_FONTS = ['Helvetica', 'zh-Hans'] as const
const fontCache = new WeakMap<object, Map<string, MupdfFont>>()

function loadFont(m: Mupdf, name: string): MupdfFont {
  let byName = fontCache.get(m)
  if (!byName) {
    byName = new Map()
    fontCache.set(m, byName)
  }
  let f = byName.get(name)
  if (!f) {
    f = new m.Font(name)
    byName.set(name, f)
  }
  return f
}

const isWinAnsi = (t: string) => [...t].every((ch) => winAnsiCode(ch.codePointAt(0)!) !== null)

function glyphsCover(font: MupdfFont, t: string): boolean {
  for (const ch of t) {
    const cp = ch.codePointAt(0)!
    if (cp < 0x20 || cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) continue
    if (font.encodeCharacter(cp) <= 0) return false
  }
  return true
}

interface FontChoice {
  font: MupdfFont
  /** Plain Helvetica with WinAnsiEncoding (nothing embedded). */
  winAnsi: boolean
  covers: (t: string) => boolean
}

/**
 * Picks one font for all the appearance text. Text no available font can draw (Arabic, Hebrew,
 * Indic scripts...) is left to `rasterText`: the UI draws it with the system fonts.
 */
export function chooseFont(m: Mupdf, texts: string[]): FontChoice {
  const helv = loadFont(m, 'Helvetica')
  // Words, so a line mixing scripts still uses a font for the parts it can draw.
  const nonEmpty = texts.flatMap((t) => t.split(/\s+/)).filter(Boolean)
  const winAnsi: FontChoice = { font: helv, winAnsi: true, covers: isWinAnsi }
  if (nonEmpty.every(isWinAnsi)) return winAnsi
  const fonts = CANDIDATE_FONTS.map((n) => {
    try {
      return loadFont(m, n)
    } catch {
      return null
    }
  }).filter((f): f is MupdfFont => !!f)
  const coverable = nonEmpty.filter((t) => fonts.some((f) => glyphsCover(f, t)))
  if (coverable.every(isWinAnsi)) return winAnsi
  let best = fonts.find((f) => coverable.every((t) => glyphsCover(f, t)))
  if (!best) {
    let bestCount = -1
    for (const f of fonts) {
      const n = coverable.filter((t) => glyphsCover(f, t)).length
      if (n > bestCount) {
        bestCount = n
        best = f
      }
    }
  }
  const font = best ?? helv
  return { font, winAnsi: false, covers: (t) => glyphsCover(font, t) }
}

/** Every text the appearance shows (the large name and the detail lines). */
export function appearanceTexts(c: AppearanceContent): string[] {
  const name = c.options.graphic === 'name' ? c.name.trim() : ''
  return [name, ...detailLines(c)].filter((t) => t.trim())
}

export interface TextRun {
  text: string
  covered: boolean
}

/**
 * Splits a text into words; consecutive words the font cannot draw form one run, kept together
 * so right-to-left text keeps its order when the UI draws it.
 */
export function textRuns(text: string, covers: (t: string) => boolean): TextRun[] {
  const out: TextRun[] = []
  for (const word of text.split(/\s+/)) {
    if (!word) continue
    const covered = covers(word)
    const last = out[out.length - 1]
    if (!covered && last && !last.covered) last.text += ` ${word}`
    else out.push({ text: word, covered })
  }
  return out
}

/**
 * Runs of appearance text that need `rasterText` because no font in MuPDF can draw them
 * (Arabic, Hebrew, Indic scripts...).
 */
export function textsNeedingRaster(m: Mupdf, c: AppearanceContent): string[] {
  const texts = appearanceTexts(c)
  const choice = chooseFont(m, texts)
  const runs = texts.flatMap((t) => textRuns(t, choice.covers)).filter((r) => !r.covered)
  return [...new Set(runs.map((r) => r.text))]
}

function makeFont(m: Mupdf, pdf: PDFDocument, texts: string[]): TextFont {
  const choice = chooseFont(m, texts)
  const font = choice.font
  const advCache = new Map<number, number>()
  const adv = (cp: number) => {
    let v = advCache.get(cp)
    if (v === undefined) {
      const gid = font.encodeCharacter(cp)
      v = gid > 0 ? font.advanceGlyph(gid) : 0.5
      advCache.set(cp, v)
    }
    return v
  }
  const width = (s: string, size: number) => {
    let w = 0
    for (const ch of s) w += adv(ch.codePointAt(0)!)
    return w * size
  }
  if (choice.winAnsi) {
    const dict = pdf.newDictionary()
    dict.put('Type', pdf.newName('Font'))
    dict.put('Subtype', pdf.newName('Type1'))
    dict.put('BaseFont', pdf.newName('Helvetica'))
    dict.put('Encoding', pdf.newName('WinAnsiEncoding'))
    const ref = pdf.addObject(dict)
    const encode = (s: string) => {
      let out = ''
      for (const ch of s) out += String.fromCharCode(winAnsiCode(ch.codePointAt(0)!) ?? 0x3f)
      return pdfLiteral(out)
    }
    return { key: 'Helv', ref, width, encode, covers: choice.covers, embedded: false }
  }
  // Characters outside WinAnsi: embed the font (Identity-H, glyph ids), subset before saving.
  const ref = pdf.addFont(font)
  const encode = (s: string) => {
    let hex = ''
    for (const ch of s) hex += font.encodeCharacter(ch.codePointAt(0)!).toString(16).padStart(4, '0')
    return `<${hex}>`
  }
  return { key: 'FcSig', ref, width, encode, covers: choice.covers, embedded: true }
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface BuiltAppearance {
  /** Content stream bytes (string characters are bytes: WinAnsi codes or hex glyph ids). */
  stream: Uint8Array
  resources: PDFObject
  /** A font program was embedded (it should be subset). */
  embeddedFont: boolean
}

interface RasterRun {
  key: string
  r: RasterText
}

/** A piece of a line: a word drawn with the font, or a run of text drawn as an image. */
interface Seg {
  text: string
  raster: RasterRun | null
}

/** Usable raster text (size limits keep a damaged or hostile value from doing harm). */
function validRaster(r: RasterText | undefined): r is RasterText {
  return (
    !!r &&
    r.png instanceof Uint8Array &&
    r.png.length > 8 &&
    r.png.length < 8_000_000 &&
    r.fontPx > 0 &&
    r.width > 0 &&
    r.height > 0 &&
    r.ascentPx > 0 &&
    r.ascentPx <= r.height
  )
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/**
 * Builds the appearance content stream (in a W x H box, origin bottom-left) and its resources
 * inside `pdf`.
 */
export function buildAppearance(m: Mupdf, pdf: PDFDocument, c: AppearanceContent, W: number, H: number): BuiltAppearance {
  const o = c.options
  const lines = detailLines(c)
  const graphicName = o.graphic === 'name' ? c.name.trim() : ''
  let image: { ref: PDFObject; w: number; h: number } | null = null
  if (o.graphic === 'image' && o.image?.length) {
    try {
      const img = new m.Image(o.image)
      image = { ref: pdf.addImage(img), w: img.getWidth(), h: img.getHeight() }
    } catch {
      image = null
    }
  }
  const hasGraphic = !!graphicName || !!image
  const font = makeFont(m, pdf, [graphicName, ...lines])
  const resources = pdf.newDictionary()
  const fonts = pdf.newDictionary()
  fonts.put(font.key, font.ref)
  resources.put('Font', fonts)
  const xo = pdf.newDictionary()
  if (image) xo.put('FcImg', image.ref)
  // Runs of text the fonts cannot draw, as images drawn by the UI with the system fonts.
  const raster = new Map<string, RasterRun>()
  for (const t of [graphicName, ...lines]) {
    for (const run of textRuns(t, font.covers)) {
      if (run.covered || raster.has(run.text)) continue
      const r = c.rasterText?.[run.text]
      if (!validRaster(r)) continue
      try {
        const key = `FcTxt${raster.size + 1}`
        xo.put(key, pdf.addImage(new m.Image(r.png)))
        raster.set(run.text, { key, r })
      } catch {
        // Not an image: the run is drawn with the font (missing glyphs show as gaps).
      }
    }
  }
  if (image || raster.size) resources.put('XObject', xo)

  const segsOf = (text: string): Seg[] => textRuns(text, font.covers).map((r) => ({ text: r.text, raster: r.covered ? null : (raster.get(r.text) ?? null) }))
  const space = (size: number) => font.width(' ', size)
  const segWidth = (sg: Seg, size: number) => (sg.raster ? (size * sg.raster.r.width) / sg.raster.r.fontPx : font.width(sg.text, size))
  const rowWidth = (row: Seg[], size: number) => row.reduce((w, sg, i) => w + segWidth(sg, size) + (i ? space(size) : 0), 0)
  /** Greedy wrapping: a word wider than the line is broken into pieces, a raster run never. */
  const wrapSegs = (segs: Seg[], maxW: number, size: number): Seg[][] => {
    const rows: Seg[][] = []
    let cur: Seg[] = []
    let curW = 0
    for (const sg of segs) {
      const w = segWidth(sg, size)
      if (cur.length && curW + space(size) + w <= maxW) {
        cur.push(sg)
        curW += space(size) + w
        continue
      }
      if (cur.length) rows.push(cur)
      cur = []
      curW = 0
      if (w <= maxW || sg.raster) {
        cur = [sg]
        curW = w
        continue
      }
      let piece = ''
      for (const ch of sg.text) {
        if (piece && font.width(piece + ch, size) > maxW) {
          rows.push([{ text: piece, raster: null }])
          piece = ch
        } else piece += ch
      }
      cur = [{ text: piece, raster: null }]
      curW = font.width(piece, size)
    }
    if (cur.length) rows.push(cur)
    return rows
  }
  /** Draws a row with its baseline at (x, y); neighbouring words share one text object. */
  const drawRow = (row: Seg[], size: number, x: number, y: number) => {
    let cx = x
    let words: string[] = []
    let wordsX = x
    const flush = () => {
      if (words.length) ops.push(`BT /${font.key} ${num(size)} Tf ${num(wordsX)} ${num(y)} Td ${font.encode(words.join(' '))} Tj ET`)
      words = []
    }
    row.forEach((sg, i) => {
      if (i) cx += space(size)
      if (sg.raster) {
        flush()
        const k = size / sg.raster.r.fontPx
        const w = sg.raster.r.width * k
        const h = sg.raster.r.height * k
        const bottom = y - (sg.raster.r.height - sg.raster.r.ascentPx) * k
        ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(cx)} ${num(bottom)} cm /${sg.raster.key} Do Q`)
        cx += w
      } else {
        if (!words.length) wordsX = cx
        words.push(sg.text)
        cx += font.width(sg.text, size)
      }
    })
    flush()
  }

  const ops: string[] = []
  const pad = Math.max(1, Math.min(4, Math.min(W, H) * 0.05))
  const inner: Box = { x: pad, y: pad, w: Math.max(1, W - 2 * pad), h: Math.max(1, H - 2 * pad) }
  let graphicBox: Box | null = null
  let textBox: Box | null = null
  if (hasGraphic && lines.length) {
    const gap = Math.min(6, inner.w * 0.03)
    if (inner.w >= inner.h * 1.6) {
      const gw = (inner.w - gap) * 0.48
      graphicBox = { x: inner.x, y: inner.y, w: gw, h: inner.h }
      textBox = { x: inner.x + gw + gap, y: inner.y, w: inner.w - gw - gap, h: inner.h }
    } else {
      const gh = (inner.h - gap) * 0.45
      graphicBox = { x: inner.x, y: inner.y + inner.h - gh, w: inner.w, h: gh }
      textBox = { x: inner.x, y: inner.y, w: inner.w, h: inner.h - gh - gap }
    }
  } else if (hasGraphic) graphicBox = inner
  else if (lines.length) textBox = inner

  if (graphicBox && image) {
    const sc = Math.min(graphicBox.w / image.w, graphicBox.h / image.h)
    const w = image.w * sc
    const h = image.h * sc
    const x = graphicBox.x + (graphicBox.w - w) / 2
    const y = graphicBox.y + (graphicBox.h - h) / 2
    ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(y)} cm /FcImg Do Q`)
  } else if (graphicBox && graphicName) {
    // One line, or two when that allows a much larger size.
    const segs = segsOf(graphicName)
    const one = Math.min(graphicBox.h * 0.72, (graphicBox.w * 0.96) / Math.max(0.01, rowWidth(segs, 1)))
    let rows = [segs]
    let size = one
    if (segs.length > 1) {
      let best = 1
      let bestDiff = Infinity
      for (let k = 1; k < segs.length; k++) {
        const diff = Math.abs(rowWidth(segs.slice(0, k), 1) - rowWidth(segs.slice(k), 1))
        if (diff < bestDiff) {
          bestDiff = diff
          best = k
        }
      }
      const two = [segs.slice(0, best), segs.slice(best)]
      const twoSize = Math.min((graphicBox.h * 0.8) / 2 / 1.05, (graphicBox.w * 0.96) / Math.max(...two.map((r) => rowWidth(r, 1))))
      if (twoSize > one * 1.35) {
        rows = two
        size = twoSize
      }
    }
    const lineH = size * 1.05
    const blockH = lineH * rows.length
    let baseline = graphicBox.y + (graphicBox.h + blockH) / 2 - size * 0.8
    for (const row of rows) {
      drawRow(row, size, graphicBox.x + (graphicBox.w - rowWidth(row, size)) / 2, baseline)
      baseline -= lineH
    }
  }
  if (textBox && lines.length) {
    const leading = 1.18
    const lineSegs = lines.map(segsOf)
    let size = Math.min(14, textBox.h / (lines.length * leading))
    let rows: Seg[][] = []
    for (; size > 2.5; size -= 0.25) {
      rows = lineSegs.flatMap((l) => wrapSegs(l, textBox.w, size))
      if (rows.length * size * leading <= textBox.h) break
    }
    size = Math.max(2.5, size)
    rows = lineSegs.flatMap((l) => wrapSegs(l, textBox.w, size))
    const blockH = rows.length * size * leading
    let baseline = textBox.y + (textBox.h + blockH) / 2 - size * 0.95
    for (const row of rows) {
      // A raster run wider than the box shrinks to fit.
      const rowSize = Math.min(size, (size * textBox.w) / Math.max(0.01, rowWidth(row, size)))
      drawRow(row, rowSize, textBox.x, baseline)
      baseline -= size * leading
    }
  }
  const stream = latin1Bytes(`q 0 g\n${ops.join('\n')}\nQ\n`)
  return { stream, resources, embeddedFont: font.embedded }
}

/** Form XObject /Matrix that keeps the appearance upright on a page with /Rotate. */
export function rotationMatrix(rotate: number): number[] {
  switch (((rotate % 360) + 360) % 360) {
    case 90:
      return [0, 1, -1, 0, 0, 0]
    case 180:
      return [-1, 0, 0, -1, 0, 0]
    case 270:
      return [0, -1, 1, 0, 0, 0]
    default:
      return [1, 0, 0, 1, 0, 0]
  }
}

/** Creates the appearance form XObject for a W x H (visual) box. */
export function addAppearanceXObject(m: Mupdf, pdf: PDFDocument, c: AppearanceContent | null, W: number, H: number, rotate: number): PDFObject {
  const dict = pdf.newDictionary()
  dict.put('Type', pdf.newName('XObject'))
  dict.put('Subtype', pdf.newName('Form'))
  const bbox = pdf.newArray()
  for (const v of [0, 0, W, H]) bbox.push(pdf.newReal(v))
  dict.put('BBox', bbox)
  const matrix = pdf.newArray()
  for (const v of rotationMatrix(rotate)) matrix.push(pdf.newInteger(v))
  dict.put('Matrix', matrix)
  if (!c || W <= 0 || H <= 0) {
    dict.put('Resources', pdf.newDictionary())
    return pdf.addStream('', dict)
  }
  // Built in a scratch document so an embedded font can be subset (only the glyphs used are
  // kept) before the resources are copied into the document.
  const tmp = new m.PDFDocument()
  try {
    const built = buildAppearance(m, tmp, c, W, H)
    if (built.embeddedFont) {
      tmp.insertPage(-1, tmp.addPage([0, 0, W, H], 0, built.resources, built.stream))
      tmp.subsetFonts()
    }
    dict.put('Resources', pdf.graftObject(built.resources))
    return pdf.addStream(built.stream, dict)
  } finally {
    tmp.destroy()
  }
}

/** Renders the appearance alone to a transparent PNG (live preview in the sign dialog). */
export function renderAppearancePng(m: Mupdf, c: AppearanceContent, W: number, H: number, scale: number): Uint8Array {
  const tmp = new m.PDFDocument()
  try {
    const built = buildAppearance(m, tmp, c, W, H)
    const pageObj = tmp.addPage([0, 0, W, H], 0, built.resources, built.stream)
    tmp.insertPage(-1, pageObj)
    const page = tmp.loadPage(0)
    const pix = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, true, false)
    const png = pix.asPNG().slice()
    pix.destroy()
    page.destroy()
    return png
  } finally {
    tmp.destroy()
  }
}
