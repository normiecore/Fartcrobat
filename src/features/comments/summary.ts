/**
 * Comment > Summarize Comments: builds a new PDF that lists every comment (Acrobat's four
 * layouts: comments only, document and comments on separate pages, document and comments on
 * single pages with or without connector lines). Engine side, drawn with MuPDF.
 */
import type { Matrix, Rect } from '@shared/geometry'
import { hexToRgb, multiplyMatrix, scaleMatrix, transformPoint, translateMatrix } from '@shared/geometry'
import { EngineError } from '@engine/define'
import { annotInfo, type AnnotInfo } from '@engine/ops/annots'
import { extractPageText } from '@engine/ops/text'
import type { Session } from '@engine/session'
import { pageLabels } from '@engine/util/pdf'
import { buildThreads, dateValue, TEXT_MARKUP, textUnderQuads, threadLabel, type Thread } from './shared'

export type SummaryLayout = 'comments-only' | 'separate' | 'single'
export type SummarySort = 'page' | 'author' | 'date' | 'type'

export interface SummaryOptions {
  layout: SummaryLayout
  /** Single-page layout: draw connector lines from each comment to its entry. */
  connectors?: boolean
  sort?: SummarySort
  fontSize?: 'small' | 'medium' | 'large'
  /** Only these comments (root ids); null/undefined = all. */
  ids?: number[] | null
  /** Document layouts: also include pages without comments. */
  includeEmptyPages?: boolean
  /** Document name shown in the title. */
  title?: string
}

type RGB = [number, number, number]

interface Entry {
  n: number
  page: number
  label: string
  author: string
  date: string
  color: RGB
  anchor: [number, number]
  quote: string
  contents: string
  status: string
  replies: { author: string; date: string; text: string }[]
}

type FontKey = 'r' | 'b' | 'i'

type Op =
  | { k: 'text'; x: number; y: number; s: string; f: FontKey; size: number; c: RGB }
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; c: RGB; w: number }
  | { k: 'marker'; x: number; y: number; n: number; c: RGB; r: number }
  | { k: 'rect'; r: Rect; c: RGB; w: number }

interface OutPage {
  w: number
  h: number
  ops: Op[]
  source?: { index: number; ctm: Matrix; clip: Rect; markers: { n: number; x: number; y: number; c: RGB; to?: [number, number] }[] }
}

const GRAY: RGB = [0.42, 0.42, 0.42]
const DARK: RGB = [0.12, 0.12, 0.12]
const RULE: RGB = [0.8, 0.8, 0.8]
const DEFAULT_COLOR: RGB = [1, 0.6, 0]

function fmtDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ')
  }
}

class Fonts {
  readonly fonts: Record<FontKey, InstanceType<Session['mupdf']['Font']>>
  private widths = new Map<string, number>()

  constructor(m: Session['mupdf']) {
    this.fonts = { r: new m.Font('Helvetica'), b: new m.Font('Helvetica-Bold'), i: new m.Font('Helvetica-Oblique') }
  }

  /** Replaces characters the font cannot draw (e.g. CJK) with '?'. */
  clean(s: string): string {
    let out = ''
    for (const ch of s.replace(/\t/g, '    ')) {
      const cp = ch.codePointAt(0)!
      if (cp < 32) continue
      out += cp === 32 || this.fonts.r.encodeCharacter(cp) > 0 ? ch : '?'
    }
    return out
  }

  width(s: string, f: FontKey, size: number): number {
    let w = 0
    const font = this.fonts[f]
    for (const ch of s) {
      const key = f + ch
      let adv = this.widths.get(key)
      if (adv === undefined) {
        adv = font.advanceGlyph(font.encodeCharacter(ch.codePointAt(0)!))
        this.widths.set(key, adv)
      }
      w += adv
    }
    return w * size
  }

  /** Word-wraps text into lines no wider than maxWidth. */
  wrap(text: string, f: FontKey, size: number, maxWidth: number): string[] {
    const out: string[] = []
    for (const para of this.clean(text.replace(/\r\n?/g, '\n')).split('\n')) {
      // keep the newline structure but not runs of blank lines
      if (!para.trim()) {
        if (out.length && out[out.length - 1] !== '') out.push('')
        continue
      }
      let line = ''
      for (const word of para.split(/ +/)) {
        const candidate = line ? line + ' ' + word : word
        if (this.width(candidate, f, size) <= maxWidth) {
          line = candidate
          continue
        }
        if (line) out.push(line)
        line = ''
        // a single word wider than the column: break it
        let w = word
        while (this.width(w, f, size) > maxWidth && w.length > 1) {
          let cut = w.length - 1
          while (cut > 1 && this.width(w.slice(0, cut), f, size) > maxWidth) cut--
          out.push(w.slice(0, cut))
          w = w.slice(cut)
        }
        line = w
      }
      if (line) out.push(line)
    }
    while (out.length && out[out.length - 1] === '') out.pop()
    return out
  }
}

/** One line of an entry: its height and how to draw it at a baseline position. */
interface Row {
  h: number
  draw: (x: number, y: number) => Op[]
  /** First row of an entry (where connector lines end). */
  head?: Entry
}

function luminance(c: RGB): number {
  return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

function entryRows(e: Entry, fonts: Fonts, size: number, width: number): Row[] {
  const lh = size * 1.32
  const r = size * 0.78
  const textX = r * 2 + 6
  const inner = width - textX
  const rows: Row[] = []
  const label = fonts.clean(e.label)
  const meta = fonts.clean([e.author, e.date].filter(Boolean).join('  ·  '))
  const lw = fonts.width(label, 'b', size)
  const sameLine = lw + 12 + fonts.width(meta, 'r', size * 0.92) <= inner
  rows.push({
    h: lh + 2,
    head: e,
    draw: (x, y) => [
      { k: 'marker', x: x + r, y: y - size * 0.32, n: e.n, c: e.color, r },
      { k: 'text', x: x + textX, y, s: label, f: 'b', size, c: DARK },
      ...(sameLine ? [{ k: 'text' as const, x: x + textX + lw + 12, y, s: meta, f: 'r' as FontKey, size: size * 0.92, c: GRAY }] : [])
    ]
  })
  if (!sameLine && meta) {
    for (const l of fonts.wrap(meta, 'r', size * 0.92, inner)) {
      rows.push({ h: lh, draw: (x, y) => [{ k: 'text', x: x + textX, y, s: l, f: 'r', size: size * 0.92, c: GRAY }] })
    }
  }
  if (e.status) {
    rows.push({ h: lh, draw: (x, y) => [{ k: 'text', x: x + textX, y, s: fonts.clean(e.status), f: 'i', size: size * 0.92, c: GRAY }] })
  }
  if (e.quote) {
    for (const l of fonts.wrap(`“${e.quote}”`, 'i', size, inner)) {
      rows.push({ h: lh, draw: (x, y) => [{ k: 'text', x: x + textX, y, s: l, f: 'i', size, c: [0.3, 0.3, 0.3] }] })
    }
  }
  if (e.contents) {
    for (const l of fonts.wrap(e.contents, 'r', size, inner)) {
      rows.push({ h: l ? lh : lh * 0.6, draw: (x, y) => (l ? [{ k: 'text', x: x + textX, y, s: l, f: 'r', size, c: DARK }] : []) })
    }
  }
  for (const rep of e.replies) {
    const indent = textX + 14
    const head = fonts.clean(`Reply from ${rep.author || 'Unknown'}${rep.date ? '  ·  ' + rep.date : ''}`)
    rows.push({
      h: lh + 2,
      draw: (x, y) => [
        { k: 'line', x1: x + textX + 4, y1: y - size, x2: x + textX + 4, y2: y + 2, c: RULE, w: 1.5 },
        { k: 'text', x: x + indent, y, s: head, f: 'b', size: size * 0.92, c: GRAY }
      ]
    })
    for (const l of fonts.wrap(rep.text, 'r', size, width - indent)) {
      rows.push({
        h: l ? lh : lh * 0.6,
        draw: (x, y) => [
          { k: 'line', x1: x + textX + 4, y1: y - size, x2: x + textX + 4, y2: y + 2, c: RULE, w: 1.5 },
          ...(l ? [{ k: 'text' as const, x: x + indent, y, s: l, f: 'r' as FontKey, size, c: DARK }] : [])
        ]
      })
    }
  }
  // spacing after the entry
  rows.push({ h: size * 0.9, draw: () => [] })
  return rows
}

/** Places rows into columns, starting new pages as needed. */
class Flow {
  y = 0
  page!: OutPage
  x = 0
  width = 0
  bottom = 0

  constructor(private readonly newPage: () => { page: OutPage; x: number; top: number; width: number; bottom: number }) {
    this.next()
  }

  next() {
    const p = this.newPage()
    this.page = p.page
    this.x = p.x
    this.y = p.top
    this.width = p.width
    this.bottom = p.bottom
  }

  /** Adds rows; `keep` rows at the start must stay together. */
  add(rows: Row[], keep = 1, onHead?: (e: Entry, y: number, page: OutPage) => void) {
    const first = rows.slice(0, keep).reduce((a, r) => a + r.h, 0)
    if (this.y + first > this.bottom) this.next()
    for (const r of rows) {
      if (this.y + r.h > this.bottom) this.next()
      this.y += r.h
      this.page.ops.push(...r.draw(this.x, this.y - r.h * 0.25))
      if (r.head && onHead) onHead(r.head, this.y - r.h * 0.25, this.page)
    }
  }

  gap(h: number) {
    this.y += h
  }

  heading(text: string, fonts: Fonts, size: number) {
    const h = size * 2.2
    if (this.y + h + size * 4 > this.bottom) this.next()
    this.y += h
    const y = this.y - size * 0.6
    this.page.ops.push({ k: 'text', x: this.x, y, s: fonts.clean(text), f: 'b', size: size * 1.15, c: DARK })
    this.page.ops.push({ k: 'line', x1: this.x, y1: y + size * 0.45, x2: this.x + this.width, y2: y + size * 0.45, c: RULE, w: 0.75 })
    this.y += size * 0.5
  }
}

function sortThreads(threads: Thread<AnnotInfo>[], sort: SummarySort, label: (t: Thread<AnnotInfo>) => string) {
  const byPos = (a: Thread<AnnotInfo>, b: Thread<AnnotInfo>) =>
    a.root.page - b.root.page || a.root.rect[1] - b.root.rect[1] || a.root.rect[0] - b.root.rect[0]
  return [...threads].sort((a, b) => {
    switch (sort) {
      case 'author':
        return (a.root.author || '').localeCompare(b.root.author || '') || byPos(a, b)
      case 'date':
        return dateValue(a.root) - dateValue(b.root) || byPos(a, b)
      case 'type':
        return label(a).localeCompare(label(b)) || byPos(a, b)
      default:
        return byPos(a, b)
    }
  })
}

function colorOf(a: AnnotInfo): RGB {
  const hex = a.color ?? a.interiorColor ?? a.textColor
  return hex && hex !== 'transparent' ? hexToRgb(hex) : DEFAULT_COLOR
}

export function buildSummary(s: Session, opts: SummaryOptions): Uint8Array {
  const m = s.mupdf
  const pageCount = s.pageCount()
  const labels = pageLabels(s.pdf, pageCount)
  const size = opts.fontSize === 'small' ? 8 : opts.fontSize === 'large' ? 11 : 9.5
  const sort = opts.sort ?? 'page'
  const docLayout = opts.layout !== 'comments-only'
  const only = opts.ids ? new Set(opts.ids) : null

  // ---- gather -------------------------------------------------------------------------------
  const all: AnnotInfo[] = []
  for (let p = 0; p < pageCount; p++) {
    s.page(p)
      .getAnnotations()
      .forEach((a, k) => {
        const t = a.getType()
        if (t === 'Popup' || t === 'Link' || t === 'Widget') return
        all.push(annotInfo(s, a, p, k))
      })
  }
  const threads = buildThreads(all).filter((t) => !only || only.has(t.root.id))
  if (!threads.length) throw new EngineError('There are no comments to summarize', 'NO_COMMENTS')
  const texts = new Map<number, ReturnType<typeof extractPageText>>()
  const quoteOf = (a: AnnotInfo) => {
    if (!TEXT_MARKUP.has(a.type) || !a.quads.length) return ''
    let t = texts.get(a.page)
    if (!t) {
      t = extractPageText(s, a.page)
      texts.set(a.page, t)
    }
    return textUnderQuads(t, a.quads)
  }
  const ordered = sortThreads(threads, sort, threadLabel)
  // document layouts always go page by page
  if (docLayout) ordered.sort((a, b) => a.root.page - b.root.page)
  const entries: Entry[] = ordered.map((t, i) => {
    s.progress((i / ordered.length) * 0.4, 'Collecting comments…')
    return {
      n: i + 1,
      page: t.root.page,
      label: threadLabel(t),
      author: t.root.author,
      date: fmtDate(t.root.modified || t.root.created),
      color: colorOf(t.root),
      anchor: [t.root.rect[0], t.root.rect[1]],
      quote: quoteOf(t.root),
      contents: t.root.contents.trim(),
      status: [t.status ? `Status: ${t.status}${t.statusBy ? ` (set by ${t.statusBy})` : ''}` : '', t.marked ? 'Marked with a checkmark' : '']
        .filter(Boolean)
        .join(' · '),
      replies: t.replies.map((r) => ({ author: r.author, date: fmtDate(r.created || r.modified), text: r.contents }))
    }
  })

  // ---- layout -------------------------------------------------------------------------------
  const fonts = new Fonts(m)
  const pages: OutPage[] = []
  const first = s.pageBounds(0)
  const pw = Math.min(first[2] - first[0], first[3] - first[1])
  const ph = Math.max(first[2] - first[0], first[3] - first[1])
  const portrait: [number, number] = pw > 200 && pw < 1600 && ph < 2400 ? [pw, ph] : [612, 792]
  const title = `Summary of Comments on ${opts.title || 'this document'}`
  const pageHeading = (p: number) => (labels[p] && labels[p] !== String(p + 1) ? `Page ${labels[p]} (${p + 1})` : `Page ${p + 1}`)

  if (opts.layout === 'comments-only') {
    const margin = 48
    const flow = new Flow(() => {
      const page: OutPage = { w: portrait[0], h: portrait[1], ops: [] }
      pages.push(page)
      return { page, x: margin, top: margin, width: portrait[0] - margin * 2, bottom: portrait[1] - margin }
    })
    for (const l of fonts.wrap(title, 'b', size + 6, flow.width)) {
      flow.gap((size + 6) * 1.3)
      flow.page.ops.push({ k: 'text', x: flow.x, y: flow.y, s: l, f: 'b', size: size + 6, c: DARK })
    }
    flow.gap(size)
    let group = ''
    for (const e of entries) {
      const g =
        sort === 'author' ? `Author: ${e.author || 'Unknown'}` : sort === 'type' ? e.label : sort === 'date' ? '' : pageHeading(e.page)
      if (g && g !== group) {
        group = g
        flow.heading(g, fonts, size)
      }
      const rows = entryRows(sort === 'page' ? e : { ...e, label: `${e.label}  (${pageHeading(e.page)})` }, fonts, size, flow.width)
      flow.add(rows, 2)
    }
  } else {
    const byPage = new Map<number, Entry[]>()
    for (const e of entries) byPage.set(e.page, [...(byPage.get(e.page) ?? []), e])
    for (let p = 0; p < pageCount; p++) {
      const list = byPage.get(p) ?? []
      if (!list.length && !opts.includeEmptyPages) continue
      s.progress(0.4 + (p / pageCount) * 0.5, `Summarizing page ${p + 1} of ${pageCount}`)
      const b = s.pageBounds(p)
      const sw = b[2] - b[0]
      const sh = b[3] - b[1]
      if (opts.layout === 'separate') {
        const scale = Math.min(1, 1600 / Math.max(sw, sh))
        const w = sw * scale
        const h = sh * scale
        const ctm = multiplyMatrix(translateMatrix(-b[0], -b[1]), scaleMatrix(scale))
        pages.push({
          w,
          h,
          ops: [],
          source: { index: p, ctm, clip: [0, 0, w, h], markers: list.map((e) => markerAt(e, ctm, w, h)) }
        })
        if (!list.length) continue
        const lw = Math.min(w, h) < 300 ? portrait[0] : w
        const lh = Math.min(w, h) < 300 ? portrait[1] : Math.max(h, 400)
        const margin = 48
        const flow = new Flow(() => {
          const page: OutPage = { w: lw, h: lh, ops: [] }
          pages.push(page)
          return { page, x: margin, top: margin, width: lw - margin * 2, bottom: lh - margin }
        })
        flow.heading(`${pageHeading(p)} — ${list.length} ${list.length === 1 ? 'comment' : 'comments'}`, fonts, size)
        for (const e of list) flow.add(entryRows(e, fonts, size, flow.width), 2)
      } else {
        const scale = Math.min(1, 1000 / sh, 900 / sw)
        const w = sw * scale
        const h = Math.max(sh * scale, 420)
        const colW = Math.max(260, Math.min(420, w * 0.7))
        const W = w + colW
        const ctm = multiplyMatrix(translateMatrix(-b[0], -b[1]), scaleMatrix(scale))
        const colX = w + 20
        const flow = new Flow(() => {
          const page: OutPage = { w: W, h, ops: [], source: { index: p, ctm, clip: [0, 0, w, sh * scale], markers: [] } }
          pages.push(page)
          return { page, x: colX, top: 28, width: colW - 36, bottom: h - 28 }
        })
        flow.heading(pageHeading(p), fonts, size)
        if (!list.length) {
          flow.add([{ h: size * 1.4, draw: (x, y) => [{ k: 'text', x, y, s: 'No comments on this page.', f: 'i', size, c: GRAY }] }])
        }
        for (const e of list) {
          flow.add(entryRows(e, fonts, size, flow.width), 2, (entry, y, page) => {
            const mk = markerAt(entry, ctm, w, sh * scale)
            if (opts.connectors) mk.to = [colX - 4, y - size * 0.32]
            page.source?.markers.push(mk)
          })
        }
      }
    }
  }

  // ---- draw ---------------------------------------------------------------------------------
  const buf = new m.Buffer()
  const writer = new m.DocumentWriter(buf, 'pdf', 'compress')
  const rgb = m.ColorSpace.DeviceRGB
  const stroke = (w: number) => new m.StrokeState({ lineCap: 'Round', lineJoin: 'Round', lineWidth: w, miterLimit: 10 })
  const drawText = (dev: InstanceType<typeof m.Device>, x: number, y: number, str: string, f: FontKey, sz: number, c: RGB) => {
    if (!str) return
    const t = new m.Text()
    t.showString(fonts.fonts[f], [sz, 0, 0, -sz, x, y], str)
    dev.fillText(t, m.Matrix.identity, rgb, c, 1)
    t.destroy()
  }
  const drawMarker = (dev: InstanceType<typeof m.Device>, x: number, y: number, n: number, c: RGB, r: number) => {
    const k = 0.5523 * r
    const path = new m.Path()
    path.moveTo(x + r, y)
    path.curveTo(x + r, y + k, x + k, y + r, x, y + r)
    path.curveTo(x - k, y + r, x - r, y + k, x - r, y)
    path.curveTo(x - r, y - k, x - k, y - r, x, y - r)
    path.curveTo(x + k, y - r, x + r, y - k, x + r, y)
    path.closePath()
    dev.fillPath(path, false, m.Matrix.identity, rgb, c, 1)
    const ss = stroke(0.6)
    dev.strokePath(path, ss, m.Matrix.identity, rgb, [0.25, 0.25, 0.25], 0.6)
    path.destroy()
    const label = String(n)
    const sz = r * (label.length > 2 ? 0.85 : 1.1)
    const tw = fonts.width(label, 'b', sz)
    drawText(dev, x - tw / 2, y + sz * 0.36, label, 'b', sz, luminance(c) > 0.62 ? [0.1, 0.1, 0.1] : [1, 1, 1])
  }
  const drawLine = (dev: InstanceType<typeof m.Device>, x1: number, y1: number, x2: number, y2: number, c: RGB, w: number) => {
    const path = new m.Path()
    path.moveTo(x1, y1)
    path.lineTo(x2, y2)
    dev.strokePath(path, stroke(w), m.Matrix.identity, rgb, c, 1)
    path.destroy()
  }
  const total = pages.length
  pages.forEach((pg, i) => {
    s.progress(0.9 + (i / total) * 0.1, `Writing page ${i + 1} of ${total}`)
    const dev = writer.beginPage([0, 0, pg.w, pg.h])
    if (pg.source) {
      const src = pg.source
      const clip = new m.Path()
      clip.rect(src.clip[0], src.clip[1], src.clip[2], src.clip[3])
      dev.clipPath(clip, false, m.Matrix.identity)
      s.page(src.index).run(dev, src.ctm)
      dev.popClip()
      if (pg.w > src.clip[2] + 1) {
        const border = new m.Path()
        border.rect(src.clip[0], src.clip[1], src.clip[2], src.clip[3])
        dev.strokePath(border, stroke(0.75), m.Matrix.identity, rgb, RULE, 1)
        border.destroy()
      }
      clip.destroy()
      for (const mk of src.markers) if (mk.to) drawLine(dev, mk.x, mk.y, mk.to[0], mk.to[1], mk.c, 0.6)
      for (const mk of src.markers) drawMarker(dev, mk.x, mk.y, mk.n, mk.c, 7)
    }
    for (const op of pg.ops) {
      if (op.k === 'text') drawText(dev, op.x, op.y, op.s, op.f, op.size, op.c)
      else if (op.k === 'line') drawLine(dev, op.x1, op.y1, op.x2, op.y2, op.c, op.w)
      else if (op.k === 'marker') drawMarker(dev, op.x, op.y, op.n, op.c, op.r)
      else if (op.k === 'rect') {
        const path = new m.Path()
        path.rect(op.r[0], op.r[1], op.r[2], op.r[3])
        dev.strokePath(path, stroke(op.w), m.Matrix.identity, rgb, op.c, 1)
        path.destroy()
      }
    }
    const footer = `Page ${i + 1} of ${total}`
    drawText(dev, pg.w / 2 - fonts.width(footer, 'r', 8) / 2, pg.h - 16, footer, 'r', 8, GRAY)
    writer.endPage()
  })
  writer.close()
  const raw = buf.asUint8Array().slice()
  buf.destroy()
  // Give the summary a title so it shows nicely in the tab and in other readers.
  const out = new m.PDFDocument(raw)
  try {
    out.setMetaData('info:Title', title)
    out.setMetaData('info:Creator', 'Fartcrobat')
    const saved = out.saveToBuffer('compress,garbage=yes')
    const bytes = saved.asUint8Array().slice()
    saved.destroy()
    return bytes
  } finally {
    out.destroy()
  }
}

function markerAt(e: Entry, ctm: Matrix, w: number, h: number) {
  const [x, y] = transformPoint(e.anchor, ctm)
  const r = 7
  return { n: e.n, x: Math.max(r + 1, Math.min(w - r - 1, x)), y: Math.max(r + 1, Math.min(h - r - 1, y - 2)), c: e.color } as {
    n: number
    x: number
    y: number
    c: RGB
    to?: [number, number]
  }
}
