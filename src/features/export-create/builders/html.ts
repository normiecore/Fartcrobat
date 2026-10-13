/**
 * Export to HTML: one standalone web page with the pictures built in (data URLs). 'page' keeps
 * every page exactly as laid out in the PDF (MuPDF's positioned HTML over a picture of the page's
 * graphics); 'flowing' writes a reflowable page with headings, paragraphs, lists and tables.
 */
import { cssFontStack } from '../fonts'
import { flowRuns, linedRuns, type DocLayout, type LCell, type LElement, type LParagraph, type LRun, type LTable } from '../layout'
import { escapeHtml, toBase64 } from './encoding'

const hex = (c: number) => '#' + c.toString(16).padStart(6, '0')

function head(title: string, css: string, lang?: string | null): string {
  return `<!DOCTYPE html>
<html${lang ? ` lang="${escapeHtml(lang)}"` : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Fartcrobat">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
</head>
<body>
`
}

// ---- exact page layout --------------------------------------------------------------------

const PAGE_CSS = `body { margin: 0; padding: 16px 0; background: #e3e3e3; }
.page { position: relative; margin: 0 auto 16px; background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25); overflow: hidden; }
.page p { position: absolute; white-space: pre; margin: 0; }
.page img { position: absolute; }
.page img.background { left: 0; top: 0; width: 100%; height: 100%; }
@media print {
  body { padding: 0; background: none; }
  .page { margin: 0; box-shadow: none; break-after: page; }
}`

export interface HtmlPage {
  /** MuPDF's HTML for the page (a positioned <div>). */
  html: string
  /** Picture of the page's graphics, placed behind the text. */
  background?: { data: Uint8Array; mime: string }
}

export function buildPageHtml(pages: HtmlPage[], meta: { title: string; lang?: string | null }): string {
  const body = pages
    .map((p) => {
      if (!p.background) return p.html
      const img = `<img class="background" alt="" src="data:${p.background.mime};base64,${toBase64(p.background.data)}">`
      // The picture goes first so the text stays on top of it.
      return p.html.replace(/^(<div[^>]*>)/, `$1\n${img}`)
    })
    .join('\n')
  return head(meta.title, PAGE_CSS, meta.lang) + body + '\n</body>\n</html>\n'
}

// ---- flowing ------------------------------------------------------------------------------

const FLOW_CSS = `body { margin: 0 auto; padding: 2em 1.5em; max-width: 50em; line-height: 1.35; color: #222; background: #fff; }
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; margin: 0.5em 0; }
td { padding: 2px 6px; vertical-align: top; }
table.ruled td { border: 1px solid #888; }
p, li { margin: 0.25em 0; }
pre { margin: 0.25em 0; white-space: pre-wrap; }
.page-break { break-before: page; height: 0; border: 0; margin: 1.5em 0; border-top: 1px dashed #ccc; }
@media print { .page-break { border: 0; margin: 0; } }`

function runHtml(r: LRun, bodyFamily: string, bodySize: number): string {
  let html = escapeHtml(r.text).replace(/\t/g, '&emsp;').replace(/\n/g, '<br>')
  const style: string[] = []
  if (r.family !== bodyFamily) style.push(`font-family: ${escapeHtml(cssFontStack(r.family, r.mono ? 4 : 0).replace(/"/g, "'"))}`)
  if (Math.abs(r.size - bodySize) > 0.25) style.push(`font-size: ${r.size}pt`)
  if (r.color !== 0) style.push(`color: ${hex(r.color)}`)
  if (style.length) html = `<span style="${style.join('; ')}">${html}</span>`
  if (r.bold) html = `<strong>${html}</strong>`
  if (r.italic) html = `<em>${html}</em>`
  if (r.underline) html = `<u>${html}</u>`
  if (r.strike) html = `<s>${html}</s>`
  if (r.link) html = `<a href="${escapeHtml(r.link)}">${html}</a>`
  return html
}

function runsHtml(runs: LRun[], ctx: Ctx, stripBold = false): string {
  return runs.map((r) => runHtml(stripBold ? { ...r, bold: false } : r, ctx.family, ctx.size)).join('')
}

interface Ctx {
  family: string
  size: number
}

function paragraphHtml(p: LParagraph, ctx: Ctx): string {
  const style: string[] = []
  if (p.align !== 'left') style.push(`text-align: ${p.align}`)
  if (p.indent > 1 && !p.list) style.push(`margin-left: ${Math.round(p.indent)}pt`)
  if (p.firstLine > 1 && !p.list) style.push(`text-indent: ${Math.round(p.firstLine)}pt`)
  if (p.spaceBefore > 6) style.push(`margin-top: ${Math.round(p.spaceBefore)}pt`)
  const attr = style.length ? ` style="${style.join('; ')}"` : ''
  if (p.preformatted) return `<pre${attr}>${runsHtml(linedRuns(p.lines), ctx)}</pre>`
  const runs = flowRuns(p.lines)
  if (p.role === 'heading') {
    const level = Math.min(6, Math.max(1, p.level))
    // Headings are bold already.
    return `<h${level}${attr}>${runsHtml(runs, ctx, true)}</h${level}>`
  }
  return `<p${attr}>${runsHtml(runs, ctx)}</p>`
}

function cellHtml(c: LCell, ctx: Ctx): string {
  const attrs: string[] = []
  if (c.colSpan > 1) attrs.push(`colspan="${c.colSpan}"`)
  if (c.rowSpan > 1) attrs.push(`rowspan="${c.rowSpan}"`)
  const style: string[] = []
  if (c.align !== 'left') style.push(`text-align: ${c.align}`)
  if (c.fill !== undefined) style.push(`background: ${hex(c.fill)}`)
  if (style.length) attrs.push(`style="${style.join('; ')}"`)
  return `<td${attrs.length ? ' ' + attrs.join(' ') : ''}>${runsHtml(flowRuns(c.lines), ctx)}</td>`
}

function tableHtml(t: LTable, ctx: Ctx): string {
  const rows: string[] = []
  for (let r = 0; r < t.rows; r++) {
    const cells = t.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col)
    rows.push(`<tr>${cells.map((c) => cellHtml(c, ctx)).join('')}</tr>`)
  }
  const cols = t.colWidths.map((w) => `<col style="width: ${Math.round(w)}pt">`).join('')
  return `<table${t.ruled ? ' class="ruled"' : ''}><colgroup>${cols}</colgroup>\n${rows.join('\n')}\n</table>`
}

const LIST_STYLE: Record<string, string> = {
  decimal: 'decimal',
  lowerLetter: 'lower-alpha',
  upperLetter: 'upper-alpha',
  lowerRoman: 'lower-roman',
  upperRoman: 'upper-roman'
}

/** Writes list items as nested <ul>/<ol> by their depth. */
function listHtml(items: LParagraph[], ctx: Ctx): string {
  let html = ''
  const open: { tag: string; depth: number }[] = []
  for (const it of items) {
    const list = it.list!
    const depth = list.depth
    const tag = list.format === 'bullet' ? 'ul' : 'ol'
    while (open.length && (open[open.length - 1].depth > depth || (open[open.length - 1].depth === depth && open[open.length - 1].tag !== tag))) {
      html += `</li></${open.pop()!.tag}>`
    }
    if (!open.length || open[open.length - 1].depth < depth) {
      const style = tag === 'ol' && list.format !== 'decimal' ? ` style="list-style-type: ${LIST_STYLE[list.format]}"` : ''
      const start = tag === 'ol' && list.value > 1 ? ` start="${list.value}"` : ''
      html += `<${tag}${style}${start}>`
      open.push({ tag, depth })
    } else html += '</li>'
    html += `<li>${runsHtml(flowRuns(it.lines), ctx)}`
  }
  while (open.length) html += `</li></${open.pop()!.tag}>`
  return html
}

function imageHtml(el: Extract<LElement, { kind: 'image' }>): string {
  if (!el.image.data.length) return ''
  const w = Math.round(el.x1 - el.x0)
  const style = el.align === 'center' ? ' style="display: block; margin: 0.5em auto"' : el.align === 'right' ? ' style="display: block; margin: 0.5em 0 0.5em auto"' : ''
  return `<p><img src="data:${el.image.mime};base64,${toBase64(el.image.data)}" width="${Math.round((w * 96) / 72)}" alt=""${style}></p>`
}

export function buildFlowingHtml(layout: DocLayout, meta: { title: string; lang?: string | null; images: boolean }): string {
  const families = new Map<string, number>()
  for (const p of layout.pages)
    for (const el of p.elements)
      if (el.kind === 'paragraph') for (const l of el.lines) for (const r of l.runs) families.set(r.family, (families.get(r.family) ?? 0) + r.text.length)
  let family = 'Arial'
  let best = -1
  for (const [k, v] of families) if (v > best) [family, best] = [k, v]
  const ctx: Ctx = { family, size: layout.bodySize }
  const css = `${FLOW_CSS}\nbody { font-family: ${cssFontStack(family, 0)}; font-size: ${layout.bodySize}pt; }`
  const parts: string[] = []
  layout.pages.forEach((page, k) => {
    if (k > 0) parts.push('<hr class="page-break">')
    let list: LParagraph[] = []
    const flushList = () => {
      if (list.length) parts.push(listHtml(list, ctx))
      list = []
    }
    for (const el of page.elements) {
      if (el.kind === 'paragraph' && el.list) {
        list.push(el)
        continue
      }
      flushList()
      if (el.kind === 'paragraph') parts.push(paragraphHtml(el, ctx))
      else if (el.kind === 'table') parts.push(tableHtml(el, ctx))
      else if (meta.images) parts.push(imageHtml(el))
    }
    flushList()
  })
  return head(meta.title, css, meta.lang) + parts.filter(Boolean).join('\n') + '\n</body>\n</html>\n'
}
