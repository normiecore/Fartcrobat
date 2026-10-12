/**
 * Builds the "Compare report" PDF in the engine: a summary (laid out from HTML by MuPDF) followed
 * by copies of the new document's changed pages, with a comment on every change (highlight for new
 * text, strikeout where text was deleted, boxes around changed images), like Acrobat's report.
 */
import type { Rect } from '@shared/geometry'
import type { PDFDocument, PDFPage, Session } from '@engine/session'
import { applySpec, FLAG_NO_ROTATE, FLAG_NO_ZOOM, FLAG_PRINT, type AnnotSpec } from '@engine/ops/annots'
import { describeChange } from './core'
import { CATEGORY_LABELS, categoryOf, type Change, type ChangeCategory, type CompareOptions } from './types'

export interface ReportInput {
  oldName: string
  newName: string
  oldPageCount: number
  newPageCount: number
  /** Pages that were compared (page ranges). */
  oldPages: number[]
  newPages: number[]
  options: CompareOptions
  /** Already formatted for the user's locale. */
  date: string
  changes: Change[]
  counts: Record<ChangeCategory, number>
  pageByPage: boolean
  /** Copies of the removed old pages (see compare.copyPages), in the order of `removedPages`. */
  removedPdf: Uint8Array | null
  removedPages: number[]
}

type RGB = [number, number, number]

/** Report colours; the same hues as the highlights in the results view. */
export const REPORT_COLORS: Record<ChangeCategory, RGB> = {
  replaced: [0.96, 0.62, 0.04],
  inserted: [0.13, 0.63, 0.42],
  deleted: [0.9, 0.28, 0.3],
  formatting: [0.55, 0.36, 0.96],
  image: [0.18, 0.5, 0.92],
  page: [0.39, 0.45, 0.55]
}

const AUTHOR = 'Fartcrobat Compare'

function hex(c: RGB) {
  return '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
}

function esc(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function rangeLabel(pages: number[], count: number): string {
  if (pages.length === count) return `${count} page${count === 1 ? '' : 's'}`
  const parts: string[] = []
  let i = 0
  while (i < pages.length) {
    let j = i
    while (j + 1 < pages.length && pages[j + 1] === pages[j] + 1) j++
    parts.push(i === j ? `${pages[i] + 1}` : `${pages[i] + 1}–${pages[j] + 1}`)
    i = j + 1
  }
  return `${count} page${count === 1 ? '' : 's'}, compared pages ${parts.join(', ')}`
}

interface ReportPage {
  src: 'new' | 'old'
  page: number
  changes: Change[]
}

/** Which pages follow the summary, in document order. */
function reportPages(input: ReportInput): ReportPage[] {
  const out: ReportPage[] = []
  const byKey = new Map<string, ReportPage>()
  const removedAvailable = new Set(input.removedPdf ? input.removedPages : [])
  for (const c of input.changes) {
    let src: 'new' | 'old'
    let page: number
    if (c.type === 'pageRemoved') {
      if (!removedAvailable.has(c.old!.page)) continue
      src = 'old'
      page = c.old!.page
    } else if (c.new) {
      src = 'new'
      page = c.new.page
    } else continue
    const key = `${src}:${page}`
    let rp = byKey.get(key)
    if (!rp) {
      rp = { src, page, changes: [] }
      byKey.set(key, rp)
      out.push(rp)
    }
    rp.changes.push(c)
  }
  return out
}

const MAX_LISTED = 1500

function summaryHtml(input: ReportInput, pages: ReportPage[], firstReportPage: number): string {
  const o = input.options
  const pageOf = new Map<Change, number>()
  pages.forEach((rp, k) => rp.changes.forEach((c) => pageOf.set(c, firstReportPage + k)))
  const settings = [
    o.mode === 'text' ? 'Text only' : 'Text and images',
    o.ignoreWhitespace ? 'Whitespace ignored' : 'Whitespace compared',
    o.ignoreCase ? 'Case ignored' : 'Case-sensitive',
    o.formatting ? 'Formatting compared' : 'Formatting not compared'
  ].join(' · ')
  const total = input.changes.length
  const cats = (Object.keys(CATEGORY_LABELS) as ChangeCategory[]).filter((k) => input.counts[k] > 0)
  const countRows = cats
    .map(
      (k) =>
        `<tr><td class="sw-cell"><span class="sw" style="background-color:${hex(REPORT_COLORS[k])}">&#160;&#160;&#160;&#160;</span></td><td class="cat">${CATEGORY_LABELS[k]}</td><td class="num">${input.counts[k]}</td></tr>`
    )
    .join('')
  const listed = input.changes.slice(0, MAX_LISTED)
  const changeRows = listed
    .map((c) => {
      const color = hex(REPORT_COLORS[categoryOf(c.type)])
      let text = esc(describeChange(c, 140))
      if (c.type === 'formatting' && c.detail) text += ` <span class="detail">— ${esc(c.detail)}</span>`
      const oldCell = c.old && !c.old.anchor ? String(c.old.page + 1) : '—'
      const target = pageOf.get(c)
      const newPage = c.new && !c.new.anchor ? String(c.new.page + 1) : '—'
      const goCell = target ? `<a href="#page=${target}">Page ${target}</a>` : ''
      return `<tr><td class="n">${c.id}</td><td><span class="sw" style="background-color:${color}">&#160;&#160;</span>&#160; ${text}</td><td class="p">${oldCell}</td><td class="p">${newPage}</td><td class="go">${goCell}</td></tr>`
    })
    .join('')
  const more =
    total > MAX_LISTED ? `<p class="muted">…and ${total - MAX_LISTED} more changes, marked on the following pages.</p>` : ''
  return `<html><head><style>
@page { margin: 50pt 54pt 54pt 54pt }
body { font-family: sans-serif; font-size: 9.5pt; color: #222222 }
h1 { font-size: 22pt; margin: 0 0 2pt 0; color: #1473e6 }
h2 { font-size: 12.5pt; margin: 16pt 0 6pt 0; padding-bottom: 3pt; border-bottom: 0.75pt solid #cccccc }
p { margin: 3pt 0 }
.muted { color: #6e6e6e }
table { border-collapse: collapse }
table.files td { padding: 2pt 10pt 2pt 0; vertical-align: top }
table.files td.k { color: #6e6e6e; width: 60pt }
table.counts td { padding: 2pt 6pt 2pt 0 }
table.counts td.cat { width: 110pt }
table.counts td.num { font-weight: bold; text-align: right; width: 30pt }
table.list { width: 100% }
table.list th { text-align: left; background-color: #eeeeee; padding: 3pt 5pt; font-size: 8.5pt; color: #444444 }
table.list td { border-bottom: 0.5pt solid #dddddd; padding: 3pt 5pt; vertical-align: top }
td.n { width: 22pt; color: #6e6e6e }
td.p { width: 34pt; color: #444444 }
td.go { width: 44pt }
.detail { color: #6e6e6e }
.none { font-size: 12pt; color: #268e6c; margin-top: 10pt }
</style></head><body>
<h1>Compare report</h1>
<p class="muted">Created with Fartcrobat on ${esc(input.date)}</p>
<h2>Documents</h2>
<table class="files">
<tr><td class="k">Old file</td><td><b>${esc(input.oldName)}</b> — ${esc(rangeLabel(input.oldPages, input.oldPageCount))}</td></tr>
<tr><td class="k">New file</td><td><b>${esc(input.newName)}</b> — ${esc(rangeLabel(input.newPages, input.newPageCount))}</td></tr>
<tr><td class="k">Settings</td><td>${esc(settings)}</td></tr>
</table>
${input.pageByPage ? '<p class="muted">The documents are very different, so they were compared page by page.</p>' : ''}
<h2>Summary</h2>
${
  total === 0
    ? '<p class="none">No differences were found.</p>'
    : `<p>${total} change${total === 1 ? '' : 's'} found.${pages.length ? ` The changed pages of the new document follow this summary, with a comment on every change.` : ''}</p><table class="counts">${countRows}</table>`
}
${
  total === 0
    ? ''
    : `<h2>Changes</h2><table class="list"><tr><th>#</th><th>Change</th><th>Old page</th><th>New page</th><th>In report</th></tr>${changeRows}</table>${more}`
}
</body></html>`
}

/** Lays out HTML into PDF pages; returns the bytes and the links of each page. */
function htmlToPdf(s: Session, html: string) {
  const m = s.mupdf
  const src = m.Document.openDocument(new TextEncoder().encode(html), 'text/html')
  try {
    src.layout(612, 792, 9.5)
    const n = src.countPages()
    const buf = new m.Buffer()
    const writer = new m.DocumentWriter(buf, 'pdf', '')
    const links: { rect: Rect; uri: string }[][] = []
    for (let i = 0; i < n; i++) {
      const page = src.loadPage(i)
      links.push(page.getLinks().map((l) => ({ rect: l.getBounds() as Rect, uri: l.getURI() })))
      const dev = writer.beginPage(page.getBounds())
      page.run(dev, m.Matrix.identity)
      writer.endPage()
      page.destroy()
    }
    writer.close()
    const bytes = buf.asUint8Array().slice()
    buf.destroy()
    return { bytes, pageCount: n, links }
  } finally {
    src.destroy()
  }
}

const rectToQuad = (r: Rect): [number, number, number, number, number, number, number, number] => [
  r[0],
  r[1],
  r[2],
  r[1],
  r[0],
  r[3],
  r[2],
  r[3]
]

function popupFor(r: Rect, bounds: Rect): Rect {
  const w = 200
  const h = 90
  let x = r[2] + 12
  if (x + w > bounds[2] - 4) x = Math.max(bounds[0] + 4, r[0] - w - 12)
  const y = Math.min(Math.max(bounds[1] + 4, r[1]), bounds[3] - h - 4)
  return [x, y, x + w, y + h]
}

/**
 * Adds one comment to a report page with the core annotation code (`applySpec`, as used by
 * annots.create), tagged as compare data. Only properties stored on the annotation itself are
 * passed to applySpec; the FartcrobatData tag is written here because applySpec would create it in
 * the session's document instead of the report.
 */
function addComment(
  s: Session,
  out: PDFDocument,
  page: PDFPage,
  type: 'Highlight' | 'StrikeOut' | 'Underline' | 'Square' | 'Text',
  spec: AnnotSpec,
  change: Change,
  near: Rect
) {
  const annot = page.createAnnotation(type)
  try {
    annot.setCreationDate(new Date())
  } catch {}
  applySpec(s, annot, {
    author: AUTHOR,
    flags: FLAG_PRINT | (type === 'Text' ? FLAG_NO_ZOOM | FLAG_NO_ROTATE : 0),
    ...spec
  })
  const obj = annot.getObject()
  obj.put('FartcrobatData', out.newDictionary())
  const data = obj.get('FartcrobatData')
  data.put('fartcrobat', out.newString('compare'))
  data.put('change', out.newString(change.type))
  try {
    annot.setPopup(popupFor(near, page.getBounds() as Rect))
  } catch {}
  annot.update()
}

function union(rects: Rect[]): Rect {
  return rects.reduce((a, r) => [Math.min(a[0], r[0]), Math.min(a[1], r[1]), Math.max(a[2], r[2]), Math.max(a[3], r[3])])
}

function annotate(s: Session, out: PDFDocument, page: PDFPage, rp: ReportPage) {
  const bounds = page.getBounds() as Rect
  const inset = (d: number): Rect => [bounds[0] + d, bounds[1] + d, bounds[2] - d, bounds[3] - d]
  const corner: Rect = [bounds[0] + 10, bounds[1] + 10, bounds[0] + 30, bounds[1] + 30]
  for (const c of rp.changes) {
    const color = hex(REPORT_COLORS[categoryOf(c.type)])
    const text = describeChange(c, 400)
    const markup = (type: 'Highlight' | 'StrikeOut' | 'Underline', rects: Rect[], contents: string, subject: string) => {
      const usable = rects.filter((r) => r[2] > r[0] && r[3] > r[1])
      if (usable.length) addComment(s, out, page, type, { color, quads: usable.map(rectToQuad), contents, subject }, c, union(usable))
    }
    const box = (rect: Rect, boxColor: string, contents: string, subject: string, borderWidth = 1.5) =>
      addComment(s, out, page, 'Square', { rect, color: boxColor, borderWidth, contents, subject }, c, rect)
    const note = (noteColor: string, contents: string, subject: string) =>
      addComment(s, out, page, 'Text', { rect: corner, color: noteColor, icon: 'Comment', contents, subject }, c, corner)
    switch (c.type) {
      case 'replaced':
        markup('Highlight', c.new!.rects, text, 'Replaced text')
        break
      case 'inserted':
        markup('Highlight', c.new!.rects, text, 'Inserted text')
        break
      case 'deleted': {
        // The deleted words are not on the new page: strike out the place where they were.
        const marks = c.new!.rects.map((r): Rect => {
          const x = (r[0] + r[2]) / 2
          return [x - 5, r[1], x + 5, r[3]]
        })
        markup('StrikeOut', marks, text, 'Deleted text')
        break
      }
      case 'formatting':
        markup('Underline', c.new!.rects, `${text}. ${c.detail}.`, 'Formatting changed')
        break
      case 'image':
        for (const r of c.new!.rects) box([r[0] - 2, r[1] - 2, r[2] + 2, r[3] + 2], color, c.detail || text, c.detail || 'Image changed')
        break
      case 'pageAdded': {
        const msg = `Page ${c.new!.page + 1} was added in the new document.`
        box(inset(3), hex(REPORT_COLORS.inserted), msg, 'Page added', 3)
        note(hex(REPORT_COLORS.inserted), msg, 'Page added')
        break
      }
      case 'pageRemoved':
        box(inset(3), hex(REPORT_COLORS.deleted), `Page ${c.old!.page + 1} of the old document was removed.`, 'Page removed', 3)
        note(hex(REPORT_COLORS.deleted), `Page ${c.old!.page + 1} of the old document was removed. This is a copy of the old page.`, 'Page removed')
        break
      case 'pageMoved':
        note(color, `${text}.`, 'Page moved')
        break
    }
  }
}

function setOutline(doc: PDFDocument, entries: { title: string; page: number }[]) {
  const it = doc.outlineIterator()
  for (const e of entries) {
    it.insert({
      title: e.title,
      uri: doc.formatLinkURI({ type: 'Fit', chapter: 0, page: e.page, x: 0, y: 0, width: 0, height: 0, zoom: 0 }),
      open: false
    })
  }
}

export function buildReport(s: Session, input: ReportInput): Uint8Array {
  const m = s.mupdf
  const pages = reportPages(input)
  // Lay out the summary once to learn how many pages it takes, then again with the real links.
  let summaryPages = htmlToPdf(s, summaryHtml(input, pages, 2)).pageCount
  let summary = htmlToPdf(s, summaryHtml(input, pages, summaryPages + 1))
  if (summary.pageCount !== summaryPages) {
    summaryPages = summary.pageCount
    summary = htmlToPdf(s, summaryHtml(input, pages, summaryPages + 1))
  }
  const out = new m.PDFDocument(summary.bytes)
  let removedDoc: PDFDocument | null = null
  try {
    const newMap = out.newGraftMap()
    let oldMap: ReturnType<PDFDocument['newGraftMap']> | null = null
    if (input.removedPdf && pages.some((p) => p.src === 'old')) {
      removedDoc = new m.PDFDocument(input.removedPdf)
      oldMap = out.newGraftMap()
    }
    for (const rp of pages) {
      if (rp.src === 'new') newMap.graftPage(-1, s.pdf, rp.page)
      else oldMap!.graftPage(-1, removedDoc!, input.removedPages.indexOf(rp.page))
    }
    // Links from the change list to the pages (their targets must exist first).
    summary.links.forEach((links, i) => {
      if (!links.length) return
      const page = out.loadPage(i)
      for (const l of links) page.createLink(l.rect, l.uri)
    })
    const outline: { title: string; page: number }[] = [{ title: 'Summary', page: 0 }]
    pages.forEach((rp, k) => {
      const index = summary.pageCount + k
      const page = out.loadPage(index)
      annotate(s, out, page, rp)
      const n = rp.changes.length
      outline.push({
        title:
          rp.src === 'old'
            ? `Old page ${rp.page + 1} (removed)`
            : `New page ${rp.page + 1} — ${n} change${n === 1 ? '' : 's'}`,
        page: index
      })
    })
    setOutline(out, outline)
    out.setMetaData('info:Title', `Compare report: ${input.oldName} and ${input.newName}`)
    out.setMetaData('info:Creator', 'Fartcrobat')
    out.setMetaData('info:Subject', `Differences between ${input.oldName} and ${input.newName}`)
    const buf = out.saveToBuffer('garbage=compact,compress')
    const bytes = buf.asUint8Array().slice()
    buf.destroy()
    return bytes
  } finally {
    removedDoc?.destroy()
    out.destroy()
  }
}
