/**
 * Engine operations of Edit Text (namespace 'edit-text'):
 *
 *   analyze(page)                -> the editable paragraphs of a page
 *   preview(page, source, ...)   -> a page render with a paragraph left out (shown under the editor)
 *   commit(page, edit)           -> one undoable step: remove the original glyphs, write the new text
 */
import type * as MuPDF from 'mupdf'
import type { Matrix, Point, Quad, Rect } from '@shared/geometry'
import { hexToRgb, multiplyMatrix } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import type { Session } from '@engine/session'
import { viewMatrix, type RenderOptions, type RenderResult } from '@engine/ops/render'
import { num } from '@engine/util/pdf'
import { analyzeLines, type AnalyzedBlock } from './analyze'
import {
  extractContentText,
  forget,
  observeGlyphs,
  pageFontFiles,
  release,
  type ContentText,
  type ObservedGlyph
} from './extract'
import { layoutText, type LayoutRun, type ShapedGlyph } from './layout'
import {
  classifyFont,
  familyForClass,
  isOrigFont,
  isStandardFamily,
  normalizeRuns,
  runsText,
  standardFontName,
  stripSubset,
  type CommitResult,
  type Run,
  type StandardFamily,
  type TextBlockInfo,
  type TextEdit
} from './model'
import {
  appendContent,
  builtinFont,
  cjkLanguage,
  colorOps,
  FontBook,
  frameQuad,
  glyphHasInk,
  hex2,
  hex4,
  matrixString,
  mergeToUnicode,
  removeTextUnder,
  utf16Hex,
  winAnsiCode
} from './write'

const ITALIC_SKEW = Math.tan((12 * Math.PI) / 180)

// ---- analysis ---------------------------------------------------------------------------

interface PageAnalysis {
  content: ContentText
  blocks: AnalyzedBlock[]
}

function analyzePage(s: Session, pageIndex: number): PageAnalysis {
  const content = extractContentText(s, pageIndex)
  const files = pageFontFiles(s, pageIndex)
  const bounds = s.pageBounds(pageIndex)
  const blocks = analyzeLines(content.lines, {
    pageWidth: bounds[2] - bounds[0],
    pageHeight: bounds[3] - bounds[1],
    embedded: (name) => {
      const f = files.get(name)
      return !!f && f.embedded && !f.type3
    }
  })
  return { content, blocks }
}

// ---- preview (render without some text) ---------------------------------------------------

function insideQuad(p: Point, q: Quad): boolean {
  // polygon ul -> ur -> lr -> ll
  const pts: Point[] = [
    [q[0], q[1]],
    [q[2], q[3]],
    [q[6], q[7]],
    [q[4], q[5]]
  ]
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % 4]
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    if (Math.abs(cross) < 1e-9) continue
    const sg = cross > 0 ? 1 : -1
    if (sign === 0) sign = sg
    else if (sg !== sign) return false
  }
  return true
}

/** Decides whether a glyph is left out, from its origin and the centre of its box (page space). */
type HideGlyph = (origin: Point, center: Point) => boolean

function filterText(m: Session['mupdf'], text: MuPDF.Text, ctm: Matrix, hide: HideGlyph): MuPDF.Text | null {
  const out = new m.Text()
  let kept = 0
  let dropped = 0
  text.walk({
    showGlyph(font, trm, gid, uni, wmode) {
      const t = multiplyMatrix(trm as Matrix, ctm)
      let adv = 0.5
      try {
        if (gid >= 0) adv = font.advanceGlyph(gid, wmode)
      } catch {}
      const c: Point = [t[4] + t[0] * adv * 0.5 + t[2] * 0.3, t[5] + t[1] * adv * 0.5 + t[3] * 0.3]
      if (hide([t[4], t[5]], c)) {
        dropped++
        return
      }
      out.showGlyph(font, trm as Matrix, gid, uni, wmode)
      kept++
    }
  })
  if (!dropped) {
    out.destroy()
    return text
  }
  if (!kept) {
    out.destroy()
    return null
  }
  return out
}

const col = (c: number[]) => c as unknown as MuPDF.Color

/** A device that forwards everything to `target` but leaves out some glyphs. */
function filteringDevice(m: Session['mupdf'], target: MuPDF.Device, hide: HideGlyph): MuPDF.Device {
  const withText = (text: MuPDF.Text, ctm: Matrix, draw: (t: MuPDF.Text) => void) => {
    const f = filterText(m, text, ctm, hide)
    if (f) draw(f)
    if (f && f !== text) f.destroy()
    release(text)
  }
  return new m.Device({
    fillPath: (p, eo, ctm, cs, c, a) => (target.fillPath(p, eo, ctm, cs, col(c), a), release(p), release(cs)),
    strokePath: (p, st, ctm, cs, c, a) => (target.strokePath(p, st, ctm, cs, col(c), a), release(p), release(st), release(cs)),
    clipPath: (p, eo, ctm) => (target.clipPath(p, eo, ctm), release(p)),
    clipStrokePath: (p, st, ctm) => (target.clipStrokePath(p, st, ctm), release(p), release(st)),
    fillText: (t, ctm, cs, c, a) => {
      withText(t, ctm as Matrix, (f) => target.fillText(f, ctm, cs, col(c), a))
      release(cs)
    },
    strokeText: (t, st, ctm, cs, c, a) => {
      withText(t, ctm as Matrix, (f) => target.strokeText(f, st, ctm, cs, col(c), a))
      release(st)
      release(cs)
    },
    clipText: (t, ctm) => (target.clipText(t, ctm), release(t)),
    clipStrokeText: (t, st, ctm) => (target.clipStrokeText(t, st, ctm), release(t), release(st)),
    ignoreText: (t, ctm) => (target.ignoreText(t, ctm), release(t)),
    fillShade: (sh, ctm, a) => {
      target.fillShade(sh, ctm, a)
      forget(sh)
    },
    fillImage: (img, ctm, a) => (target.fillImage(img, ctm, a), release(img)),
    fillImageMask: (img, ctm, cs, c, a) => (target.fillImageMask(img, ctm, cs, col(c), a), release(img), release(cs)),
    clipImageMask: (img, ctm) => (target.clipImageMask(img, ctm), release(img)),
    popClip: () => target.popClip(),
    beginMask: (r, l, cs, c) => (target.beginMask(r, l, cs, col(c)), release(cs)),
    endMask: () => target.endMask(),
    beginGroup: (r, cs, i, k, b, a) => (target.beginGroup(r, cs, i, k, b, a), release(cs)),
    endGroup: () => target.endGroup(),
    beginTile: (area, view, xs, ys, ctm, id, docId) => target.beginTile(area, view, xs, ys, ctm, id, docId),
    endTile: () => target.endTile(),
    beginLayer: (name) => target.beginLayer(name),
    endLayer: () => target.endLayer()
  })
}

function renderWithout(s: Session, pageIndex: number, hide: HideGlyph, opts: RenderOptions) {
  const m = s.mupdf
  const page = s.page(pageIndex)
  const { ctm, bbox } = viewMatrix(s, pageIndex, opts.scale, opts.rotate ?? 0)
  let region: Rect = bbox
  if (opts.clip) {
    region = [
      Math.max(0, Math.floor(opts.clip[0])),
      Math.max(0, Math.floor(opts.clip[1])),
      Math.min(bbox[2], Math.ceil(opts.clip[2])),
      Math.min(bbox[3], Math.ceil(opts.clip[3]))
    ]
    if (region[2] <= region[0] || region[3] <= region[1]) region = [0, 0, 1, 1]
  }
  const w = region[2] - region[0]
  const h = region[3] - region[1]
  if (w * h > 40_000_000) throw new EngineError('Preview region too large', 'TOO_LARGE')
  const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, region, true)
  pix.clear(255)
  const draw = new m.DrawDevice(ctm, pix)
  const filter = filteringDevice(m, draw, hide)
  try {
    page.runPageContents(filter, m.Matrix.identity)
    filter.close()
    if (opts.annots !== false) page.runPageAnnots(draw, m.Matrix.identity)
    if (opts.widgets !== false) page.runPageWidgets(draw, m.Matrix.identity)
    draw.close()
  } finally {
    filter.destroy()
    draw.destroy()
  }
  if (opts.colorMode === 'dark') pix.invertLuminance()
  else if (opts.colorMode === 'high-contrast') {
    pix.invertLuminance()
    pix.gamma(0.6)
  }
  return { pix, region }
}

async function toResult(pixels: Uint8ClampedArray, region: Rect) {
  const width = region[2] - region[0]
  const height = region[3] - region[1]
  if (typeof createImageBitmap === 'function' && typeof ImageData === 'function') {
    const bitmap = await createImageBitmap(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, width, height))
    const result: RenderResult = { width, height, x: region[0], y: region[1], bitmap }
    return withTransfer(result, [bitmap])
  }
  const result: RenderResult = { width, height, x: region[0], y: region[1], pixels }
  return withTransfer(result, [pixels.buffer as ArrayBuffer])
}

// ---- fonts for writing ---------------------------------------------------------------------

interface OrigFont {
  name: string
  font: MuPDF.Font
  embedded: boolean
  bold: boolean
  italic: boolean
  cls: ReturnType<typeof classifyFont>
  /** unicode -> glyph id, as actually drawn on the page */
  verified: Map<number, number>
  /** The font's own cmap agrees with what the page draws, so it can encode other characters. */
  trusted: boolean
}

interface Slot {
  key: string
  create: () => MuPDF.PDFObject
  synthBold: boolean
  synthItalic: boolean
}

class Writer {
  readonly book: FontBook
  readonly slots = new Map<string, Slot>()
  /** Glyph -> text for Type0 fonts made from embedded fonts (font key -> gid -> text). */
  readonly toUnicode = new Map<string, Map<number, string>>()
  readonly fallbackFonts = new Set<string>()
  readonly unsupported = new Set<string>()
  private failedKeys = new Set<string>()

  constructor(
    readonly s: Session,
    readonly pageIndex: number,
    readonly orig: Map<string, OrigFont>
  ) {
    this.book = new FontBook(s, pageIndex)
  }

  /** Makes sure a font object exists; false when MuPDF cannot embed it. */
  ensure(key: string, create: () => MuPDF.PDFObject): boolean {
    if (this.failedKeys.has(key)) return false
    try {
      this.book.resource(key, create)
      return true
    } catch (err) {
      console.warn(`[edit-text] could not add font ${key}`, err)
      this.failedKeys.add(key)
      return false
    }
  }

  slot(key: string, create: () => MuPDF.PDFObject, synthBold = false, synthItalic = false): string {
    const id = `${key}|${synthBold ? 'b' : ''}${synthItalic ? 'i' : ''}`
    if (!this.slots.has(id)) this.slots.set(id, { key, create, synthBold, synthItalic })
    return id
  }

  origGid(o: OrigFont, ch: string): number {
    const cp = ch.codePointAt(0)!
    const v = o.verified.get(cp)
    if (v !== undefined) return v
    if (!o.trusted) return 0
    let gid = 0
    try {
      gid = o.font.encodeCharacter(cp)
    } catch {
      return 0
    }
    if (gid <= 0) return 0
    if (!/\s/.test(ch) && !glyphHasInk(this.s, o.font, gid)) return 0
    return gid
  }

  /** A shaping function for one run, choosing the original font when it can draw the run. */
  shaper(run: Run): (ch: string) => ShapedGlyph {
    const size = run.size
    let family: StandardFamily = isStandardFamily(run.font) ? run.font : 'Helvetica'
    if (isOrigFont(run.font)) {
      const o = this.orig.get(run.font.slice(5))
      if (o) {
        family = familyForClass(o.cls)
        const styleOk = !(o.bold && !run.bold) && !(o.italic && !run.italic)
        const chars = Array.from(run.text).filter((c) => c !== '\n' && !/\s/.test(c))
        const glyphsOk = o.embedded && chars.every((c) => this.origGid(o, c) > 0)
        const key = 'orig:' + o.name
        if (styleOk && glyphsOk && this.ensure(key, () => this.s.pdf.addFont(o.font))) {
          const slot = this.slot(key, () => this.s.pdf.addFont(o.font), run.bold && !o.bold, run.italic && !o.italic)
          const spaceGid = this.origGid(o, ' ')
          const spaceAdv = spaceGid > 0 ? safeAdv(o.font, spaceGid) : 0.278
          const map = this.toUnicode.get(key) ?? new Map<number, string>()
          this.toUnicode.set(key, map)
          return (ch) => {
            if (/\s/.test(ch)) {
              if (ch === ' ' && spaceGid > 0) {
                map.set(spaceGid, ' ')
                return { ch, adv: spaceAdv * size, code: hex4(spaceGid), slot, space: true }
              }
              return { ch, adv: spaceAdv * size, code: '', slot, space: true }
            }
            const gid = this.origGid(o, ch)
            map.set(gid, ch)
            return { ch, adv: safeAdv(o.font, gid) * size, code: hex4(gid), slot, space: false }
          }
        }
        if (o.embedded && !glyphsOk) this.fallbackFonts.add(stripSubset(o.name))
      }
    }
    return this.standardShaper(standardFontName(family, run.bold, run.italic), size)
  }

  standardShaper(name: string, size: number): (ch: string) => ShapedGlyph {
    const s = this.s
    const font = builtinFont(s, name)
    const simpleKey = 'b14:' + name
    const simple = this.slot(simpleKey, () => s.pdf.addSimpleFont(font))
    return (ch) => {
      let cp = ch.codePointAt(0)!
      if (cp < 0x20 || ch === '\t') {
        ch = ' '
        cp = 0x20
      }
      const space = /\s/.test(ch)
      const code = winAnsiCode(cp)
      if (code >= 0) {
        const gid = font.encodeCharacter(cp)
        return { ch, adv: safeAdv(font, gid) * size, code: hex2(code), slot: simple, space }
      }
      const gid = font.encodeCharacter(cp)
      if (gid > 0) {
        const key = 'b14cid:' + name
        if (this.ensure(key, () => s.pdf.addFont(font))) {
          return { ch, adv: safeAdv(font, gid) * size, code: hex4(gid), slot: this.slot(key, () => s.pdf.addFont(font)), space }
        }
      }
      const lang = cjkLanguage(cp)
      if (lang) {
        const cjk = builtinFont(s, lang)
        if (cjk.encodeCharacter(cp) > 0) {
          const key = 'cjk:' + lang
          if (this.ensure(key, () => s.pdf.addCJKFont(cjk, lang))) {
            return { ch, adv: size, code: utf16Hex(ch), slot: this.slot(key, () => s.pdf.addCJKFont(cjk, lang)), space }
          }
        }
      }
      this.unsupported.add(ch)
      return { ch: '?', adv: safeAdv(font, font.encodeCharacter(0x3f)) * size, code: hex2(0x3f), slot: simple, space: false }
    }
  }

  resourceName(slotId: string): string {
    const slot = this.slots.get(slotId)!
    return this.book.resource(slot.key, slot.create)
  }

  finish() {
    for (const [key, map] of this.toUnicode) {
      const ref = this.book.object(key)
      if (ref) mergeToUnicode(this.s, ref, map)
    }
  }
}

function safeAdv(font: MuPDF.Font, gid: number): number {
  try {
    const a = font.advanceGlyph(gid, 0)
    return Number.isFinite(a) ? a : 0.5
  } catch {
    return 0.5
  }
}

function buildOrigFonts(s: Session, pageIndex: number, names: Set<string>, content: ContentText | null, glyphs: ObservedGlyph[]) {
  const out = new Map<string, OrigFont>()
  if (!names.size) return out
  const files = pageFontFiles(s, pageIndex)
  for (const name of names) {
    const font = content?.fonts.get(name) ?? glyphs.find((g) => g.fontName === name)?.font
    if (!font) continue
    const verified = new Map<number, number>()
    for (const g of glyphs) {
      if (g.fontName !== name || g.gid <= 0 || g.uni <= 0 || g.lig) continue
      if (!verified.has(g.uni)) verified.set(g.uni, g.gid)
    }
    let trusted = verified.size > 0
    for (const [u, g] of verified) {
      let enc = -1
      try {
        enc = font.encodeCharacter(u)
      } catch {}
      if (enc !== g) {
        trusted = false
        break
      }
    }
    const f = files.get(name)
    const plain = stripSubset(name)
    out.set(name, {
      name,
      font,
      embedded: !!f && f.embedded && !f.type3,
      bold: safeFlag(() => font.isBold()) || /bold|black|heavy|semibold|demi/i.test(plain),
      italic: safeFlag(() => font.isItalic()) || /italic|oblique/i.test(plain),
      cls: classifyFont(name, { serif: safeFlag(() => font.isSerif()), mono: safeFlag(() => font.isMono()) }),
      verified,
      trusted
    })
  }
  return out
}

function safeFlag(fn: () => boolean) {
  try {
    return fn()
  } catch {
    return false
  }
}

// ---- removal of the original text --------------------------------------------------------

function originIndex(chars: { ox: number; oy: number }[]) {
  const grid = new Map<string, { ox: number; oy: number }[]>()
  for (const c of chars) {
    const k = `${Math.round(c.ox)}:${Math.round(c.oy)}`
    const arr = grid.get(k) ?? []
    arr.push(c)
    grid.set(k, arr)
  }
  return (x: number, y: number, tol = 0.05) => {
    const gx = Math.round(x)
    const gy = Math.round(y)
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const c of grid.get(`${gx + dx}:${gy + dy}`) ?? []) if (Math.abs(c.ox - x) <= tol && Math.abs(c.oy - y) <= tol) return true
    return false
  }
}

/**
 * Matches glyphs drawn before and after a removal. Positions are compared with a tolerance:
 * rewriting a content stream can change the last digits of glyph positions.
 */
class GlyphPool {
  private grid = new Map<string, ObservedGlyph[]>()

  constructor(glyphs: ObservedGlyph[]) {
    for (const g of glyphs) {
      const k = `${Math.round(g.m[4])}:${Math.round(g.m[5])}`
      const arr = this.grid.get(k)
      if (arr) arr.push(g)
      else this.grid.set(k, [g])
    }
  }

  /** Removes and returns a glyph like `g` (same font and glyph, same place), if there is one. */
  take(g: ObservedGlyph, tol = 0.05): boolean {
    const gx = Math.round(g.m[4])
    const gy = Math.round(g.m[5])
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = this.grid.get(`${gx + dx}:${gy + dy}`)
        if (!arr) continue
        const i = arr.findIndex(
          (o) =>
            o.gid === g.gid &&
            o.fontName === g.fontName &&
            Math.abs(o.m[4] - g.m[4]) <= tol &&
            Math.abs(o.m[5] - g.m[5]) <= tol
        )
        if (i >= 0) {
          arr.splice(i, 1)
          return true
        }
      }
    }
    return false
  }
}

/** Thin bands through the middle of each line: they touch every glyph of the line, not its neighbours. */
function removalBands(block: AnalyzedBlock): Quad[] {
  const out: Quad[] = []
  for (const line of block.lines) {
    const len = Math.hypot(line.dir[0], line.dir[1]) || 1
    const d: Point = [line.dir[0] / len, line.dir[1] / len]
    const n: Point = [-d[1], d[0]]
    const ink = line.chars.filter((c) => !/\s/.test(c.c))
    if (!ink.length) continue
    let u0 = Infinity
    let u1 = -Infinity
    const vs: number[] = []
    let size = 0
    for (const c of ink) {
      const q = c.quad
      for (let k = 0; k < 8; k += 2) {
        const u = q[k] * d[0] + q[k + 1] * d[1]
        u0 = Math.min(u0, u)
        u1 = Math.max(u1, u)
      }
      vs.push(c.ox * n[0] + c.oy * n[1])
      size = Math.max(size, c.size)
    }
    vs.sort((a, b) => a - b)
    const v = vs[vs.length >> 1]
    const inset = Math.min(0.15, (u1 - u0) / 4)
    out.push(frameQuad(d, u0 + inset, u1 - inset, v - 0.62 * size, v - 0.03 * size))
  }
  return out
}

/** Quads around single leftover glyphs (marks above or below the band). */
function glyphQuads(block: AnalyzedBlock, leftovers: ObservedGlyph[]): Quad[] {
  const out: Quad[] = []
  for (const g of leftovers) {
    const ch = block.chars.find((c) => Math.abs(c.ox - g.m[4]) <= 0.05 && Math.abs(c.oy - g.m[5]) <= 0.05)
    if (!ch) continue
    const q = ch.quad
    // shrink horizontally by 15% on each side
    const sx = (q[2] - q[0]) * 0.15
    const sy = (q[3] - q[1]) * 0.15
    out.push([q[0] + sx, q[1] + sy, q[2] - sx, q[3] - sy, q[4] + sx, q[5] + sy, q[6] - sx, q[7] - sy])
  }
  return out
}

interface Removal {
  /** Glyphs of other text that were removed as collateral and must be drawn again. */
  lost: ObservedGlyph[]
}

function removeBlock(s: Session, pageIndex: number, block: AnalyzedBlock, before: ObservedGlyph[]): Removal {
  const isBlockGlyph = originIndex(block.chars)
  removeTextUnder(s, pageIndex, removalBands(block))
  let after = observeGlyphs(s, pageIndex)
  const leftovers = after.filter((g) => g.kind !== 'other' && isBlockGlyph(g.m[4], g.m[5]))
  if (leftovers.length) {
    removeTextUnder(s, pageIndex, glyphQuads(block, leftovers))
    after = observeGlyphs(s, pageIndex)
  }
  const remaining = new GlyphPool(after)
  const lost: ObservedGlyph[] = []
  for (const g of before) {
    if (remaining.take(g)) continue
    if (g.kind === 'other' || isBlockGlyph(g.m[4], g.m[5])) continue
    lost.push(g)
  }
  return { lost }
}

// ---- writing ------------------------------------------------------------------------------

function restoreGlyphs(w: Writer, lost: ObservedGlyph[], toUser: Matrix): { content: string; restored: number } {
  const parts: string[] = []
  let restored = 0
  for (const g of lost) {
    const key = 'orig:' + g.fontName
    if (!w.ensure(key, () => w.s.pdf.addFont(g.font))) continue
    const slot = w.slot(key, () => w.s.pdf.addFont(g.font))
    const name = w.resourceName(slot)
    const map = w.toUnicode.get(key) ?? new Map<number, string>()
    w.toUnicode.set(key, map)
    if (g.uni > 0 && !map.has(g.gid)) map.set(g.gid, String.fromCodePoint(g.uni))
    const m = multiplyMatrix(g.m, toUser)
    parts.push(
      `BT ${g.kind === 'invisible' ? '3 Tr ' : ''}${colorOps(g.rgb)} /${name} 1 Tf ${matrixString(m)} Tm <${hex4(g.gid)}> Tj ET`
    )
    restored++
  }
  return { content: parts.join('\n'), restored }
}

function writeText(w: Writer, edit: TextEdit, runs: Run[], toUser: Matrix): { content: string; bbox: Rect | null } {
  const layoutRuns: LayoutRun[] = runs.map((r) => ({ style: r, text: r.text, shape: w.shaper(r) }))
  const len = Math.hypot(edit.frame.dir[0], edit.frame.dir[1]) || 1
  const d: Point = [edit.frame.dir[0] / len, edit.frame.dir[1] / len]
  const n: Point = [-d[1], d[0]]
  const O = edit.frame.origin
  const result = layoutText(layoutRuns, {
    wrap: edit.wrap,
    width: edit.frame.width,
    align: edit.align,
    lineSpacing: edit.lineSpacing,
    ascent: edit.ascent
  })
  const P = (u: number, v: number): Point => [O[0] + u * d[0] + v * n[0], O[1] + u * d[1] + v * n[1]]
  const out: string[] = ['BT']
  const under: string[] = []
  for (const line of result.lines) {
    let k = 0
    const gl = line.glyphs
    while (k < gl.length) {
      const first = gl[k]
      const run = runs[first.run]
      const slotId = first.g.slot
      // a segment: same font slot, run style and size
      let e = k + 1
      while (e < gl.length && gl[e].g.slot === slotId && gl[e].run === first.run) e++
      const slot = w.slots.get(slotId)!
      const name = w.resourceName(slotId)
      const size = run.size
      const rgb = hexToRgb(run.color)
      const skew = slot.synthItalic ? ITALIC_SKEW : 0
      const p = P(first.u, line.v)
      const tPage: Matrix = [d[0], d[1], skew * d[0] - n[0], skew * d[1] - n[1], p[0], p[1]]
      const tm = multiplyMatrix(tPage, toUser)
      const tj: string[] = []
      let hex = ''
      const flushHex = () => {
        if (hex) tj.push(`<${hex}>`)
        hex = ''
      }
      for (let i = k; i < e; i++) {
        const g = gl[i]
        if (g.g.code) hex += g.g.code
        const gap = (g.g.code ? 0 : g.g.adv) + g.extra
        if (gap > 0.0001) {
          flushHex()
          tj.push(num((-gap * 1000) / size))
        }
      }
      flushHex()
      if (tj.length) {
        const render = slot.synthBold ? `2 Tr ${num(Math.max(0.2, size * 0.03))} w ${colorOps(rgb, true)}` : '0 Tr'
        out.push(`/${name} ${num(size)} Tf ${render} ${colorOps(rgb)} ${matrixString(tm)} Tm [${tj.join(' ')}] TJ`)
      }
      k = e
    }
    // underlines
    let i = 0
    while (i < gl.length) {
      if (!runs[gl[i].run].underline || gl[i].g.space) {
        i++
        continue
      }
      let j = i
      let lastInk = i
      let size = 0
      while (j < gl.length && runs[gl[j].run].underline) {
        if (!gl[j].g.space) lastInk = j
        size = Math.max(size, runs[gl[j].run].size)
        j++
      }
      const startRun = runs[gl[i].run]
      const u0 = gl[i].u
      const u1 = gl[lastInk].u + gl[lastInk].g.adv
      const v0 = line.v + 0.1 * size
      const v1 = v0 + Math.max(0.4, 0.055 * size)
      const pts = [P(u0, v0), P(u1, v0), P(u1, v1), P(u0, v1)].map((pt) => {
        const x = pt[0] * toUser[0] + pt[1] * toUser[2] + toUser[4]
        const y = pt[0] * toUser[1] + pt[1] * toUser[3] + toUser[5]
        return `${num(x)} ${num(y)}`
      })
      under.push(`${colorOps(hexToRgb(startRun.color))} ${pts[0]} m ${pts[1]} l ${pts[2]} l ${pts[3]} l h f`)
      i = j
    }
  }
  out.push('ET')
  if (out.length === 2 && !under.length) return { content: '', bbox: null }
  const q = frameQuad(d, result.left, result.right, 0, result.height)
  const corners = q.map((v, i) => v + (i % 2 === 0 ? O[0] : O[1]))
  const xs = [corners[0], corners[2], corners[4], corners[6]]
  const ys = [corners[1], corners[3], corners[5], corners[7]]
  return {
    content: [...out, ...under].join('\n'),
    bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
  }
}

function validate(edit: TextEdit) {
  const finite = (...v: number[]) => v.every((x) => Number.isFinite(x))
  const f = edit.frame
  if (!f || !finite(f.origin[0], f.origin[1], f.dir[0], f.dir[1], f.width, edit.lineSpacing, edit.ascent))
    throw new EngineError('Invalid text box', 'BAD_EDIT')
  if (Math.hypot(f.dir[0], f.dir[1]) < 1e-6) throw new EngineError('Invalid text direction', 'BAD_EDIT')
  for (const r of edit.runs) {
    if (!finite(r.size) || r.size <= 0 || r.size > 2000) throw new EngineError('Font size must be between 0 and 2000 points', 'BAD_EDIT')
  }
}

export default defineOps('edit-text', {
  /** Editable paragraphs of a page. */
  analyze(s, pageIndex: number): TextBlockInfo[] {
    return analyzePage(s, pageIndex).blocks.map((b) => b.info)
  },

  /**
   * Renders part of a page without the glyphs of a paragraph (exactly those a commit removes, so
   * a watermark or other text crossing it stays visible). When the paragraph cannot be found any
   * more, glyphs whose centre lies inside `quads` are left out instead.
   */
  async preview(s, pageIndex: number, source: { start: number; end: number; check: string } | null, quads: Quad[], opts: RenderOptions) {
    let hide: HideGlyph = (_o, c) => quads.some((q) => insideQuad(c, q))
    if (source) {
      const block = analyzePage(s, pageIndex).blocks.find(
        (b) => b.info.start === source.start && b.info.end === source.end && b.info.text === source.check
      )
      if (block) {
        const isBlockGlyph = originIndex(block.chars)
        hide = (o) => isBlockGlyph(o[0], o[1])
      }
    }
    const { pix, region } = renderWithout(s, pageIndex, hide, opts)
    try {
      return await toResult(new Uint8ClampedArray(pix.getPixels()), region)
    } finally {
      pix.destroy()
    }
  },

  /** Plain text of the page content (what can be edited), for checks and tests. */
  text(s, pageIndex: number): string {
    return extractContentText(s, pageIndex).text
  },

  commit: mutation(
    (_page: number, edit: TextEdit) =>
      !edit.source ? 'Add Text' : runsText(edit.runs).trim() ? 'Edit Text' : 'Delete Text',
    (s, pageIndex: number, edit: TextEdit): CommitResult => {
      validate(edit)
      const runs = normalizeRuns(edit.runs.map((r) => ({ ...r, text: r.text.replace(/\r\n?/g, '\n') })))
      let analysis: PageAnalysis | null = null
      let block: AnalyzedBlock | null = null
      if (edit.source) {
        analysis = analyzePage(s, pageIndex)
        const src = edit.source
        block = analysis.blocks.find((b) => b.info.start === src.start && b.info.end === src.end) ?? null
        if (!block || block.info.text !== src.check)
          throw new EngineError('The text on this page has changed. Click the text again to edit it.', 'STALE_BLOCK')
      }
      const origNames = new Set(runs.filter((r) => isOrigFont(r.font) && r.text.trim()).map((r) => r.font.slice(5)))
      const before = block || origNames.size ? observeGlyphs(s, pageIndex) : []
      const orig = buildOrigFonts(s, pageIndex, origNames, analysis?.content ?? null, before)

      let lost: ObservedGlyph[] = []
      if (block) lost = removeBlock(s, pageIndex, block, before).lost

      const w = new Writer(s, pageIndex, orig)
      const toUser = s.pageToUser(pageIndex)
      const restore = restoreGlyphs(w, lost, toUser)
      const text = runsText(runs).trim() ? writeText(w, edit, runs, toUser) : { content: '', bbox: null }
      const content = [restore.content, text.content].filter(Boolean).join('\n')
      if (content) appendContent(s, pageIndex, content + '\n')
      w.finish()
      s.invalidatePages()
      s.touch(pageIndex)
      return {
        bbox: text.bbox,
        fallbackFonts: [...w.fallbackFonts],
        unsupported: [...w.unsupported],
        restoredGlyphs: restore.restored
      }
    }
  )
})
