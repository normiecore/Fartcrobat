/**
 * Export to Microsoft Word (.docx). 'flowing' rebuilds editable paragraphs, headings, lists and
 * tables that reflow ("Retain Flowing Text"); 'page' places every paragraph, table and picture
 * where it is on the PDF page ("Retain Page Layout").
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  FrameAnchorType,
  FrameWrap,
  HeadingLevel,
  HeightRule,
  HorizontalPositionRelativeFrom,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Packer,
  PageOrientation,
  Paragraph,
  SectionType,
  ShadingType,
  Tab,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  TextWrappingType,
  VerticalAlign,
  VerticalPositionRelativeFrom,
  WidthType,
  type ISectionOptions
} from 'docx'
import {
  flowRuns,
  linedRuns,
  type Align,
  type DocLayout,
  type LCell,
  type LImage,
  type LPage,
  type LParagraph,
  type LRun,
  type LTable,
  type ListFormat
} from '../layout'
import type { WordOptions } from '../shared'

const tw = (pt: number) => Math.round(pt * 20)
const px = (pt: number) => Math.max(1, Math.round((pt * 96) / 72))
const emu = (pt: number) => Math.round(pt * 12700)
const hex = (c: number) => c.toString(16).padStart(6, '0').toUpperCase()

type Child = Paragraph | Table

const ALIGN: Record<Align, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4]

const LEVEL_FORMAT: Record<ListFormat, (typeof LevelFormat)[keyof typeof LevelFormat]> = {
  bullet: LevelFormat.BULLET,
  decimal: LevelFormat.DECIMAL,
  lowerLetter: LevelFormat.LOWER_LETTER,
  upperLetter: LevelFormat.UPPER_LETTER,
  lowerRoman: LevelFormat.LOWER_ROMAN,
  upperRoman: LevelFormat.UPPER_ROMAN
}

const BULLET_GLYPHS = ['•', '◦', '▪']

/** Word numbering definitions, one per kind of list marker ("1.", "a)", "•"...). */
class Numbering {
  private configs = new Map<string, { reference: string; format: ListFormat; template: string; start: number; bullet: string }>()
  private instance = 0
  private lastKey: string | null = null

  reference(p: LParagraph): { reference: string; level: number; instance: number } {
    const list = p.list!
    const template = list.format === 'bullet' ? list.marker : list.marker.replace(/[0-9]+|[ivxlcdm]+|[a-z]/i, '%1')
    const continues = this.lastKey !== null && list.value > 1
    const start = list.format === 'bullet' ? 1 : continues ? 1 : list.value
    const key = `${list.format}|${template}|${start}`
    if (!this.configs.has(key)) {
      this.configs.set(key, {
        reference: `fc-list-${this.configs.size + 1}`,
        format: list.format,
        template,
        start,
        bullet: list.format === 'bullet' ? (/[•●▪■◦○►▸‣✓✔➢➤]/.test(list.marker) ? list.marker : '•') : ''
      })
    }
    // A new list starts with item 1 (or after other content); following items continue it.
    if (!(continues && this.lastKey?.startsWith(`${list.format}|${template}|`))) this.instance++
    this.lastKey = key
    return { reference: this.configs.get(key)!.reference, level: Math.min(8, list.depth), instance: this.instance }
  }

  /** Content that is not a list item ends the current list. */
  breakList() {
    this.lastKey = null
  }

  config() {
    return [...this.configs.values()].map((c) => ({
      reference: c.reference,
      levels: Array.from({ length: 9 }, (_, level) => ({
        level,
        format: LEVEL_FORMAT[c.format],
        text: c.format === 'bullet' ? (level === 0 ? c.bullet : BULLET_GLYPHS[level % 3]) : c.template.replace('%1', `%${level + 1}`),
        start: c.start,
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: tw(18 * (level + 1)), hanging: tw(18) } } }
      }))
    }))
  }
}

function textRuns(run: LRun, opts: { breakFirst?: boolean } = {}): TextRun[] {
  const base = {
    bold: run.bold,
    italics: run.italic,
    ...(run.underline ? { underline: {} } : {}),
    ...(run.strike ? { strike: true } : {}),
    color: hex(run.color),
    size: Math.max(2, Math.round(run.size * 2)),
    font: run.family
  }
  const out: TextRun[] = []
  run.text.split('\n').forEach((piece, i) => {
    const parts = piece.split('\t')
    const children: (string | Tab)[] = []
    parts.forEach((p, k) => {
      if (k > 0) children.push(new Tab())
      if (p) children.push(p)
    })
    const brk = i > 0 || (i === 0 && opts.breakFirst)
    if (!children.length && !brk) return
    out.push(new TextRun({ ...base, children, ...(brk ? { break: 1 } : {}) }))
  })
  return out
}

function runChildren(runs: LRun[]): (TextRun | ExternalHyperlink)[] {
  const out: (TextRun | ExternalHyperlink)[] = []
  for (const r of runs) {
    const trs = textRuns(r)
    if (r.link) out.push(new ExternalHyperlink({ link: r.link, children: trs }))
    else out.push(...trs)
  }
  return out
}

function lineSpacing(p: LParagraph) {
  if (p.lines.length < 2 || p.lineStep <= 0) return {}
  // Keep the PDF's line spacing, but never squeeze lines together.
  return { line: tw(Math.max(p.lineStep, p.size * 1.05)), lineRule: LineRuleType.AT_LEAST }
}

function paragraphOptions(p: LParagraph, numbering: Numbering, opts: WordOptions) {
  const keepLines = p.preformatted
  const runs = keepLines ? linedRuns(p.lines) : flowRuns(p.lines)
  const indent: { left?: number; hanging?: number; firstLine?: number } = {}
  if (p.indent > 0.5) indent.left = tw(p.indent)
  if (p.firstLine < -0.5) indent.hanging = tw(-p.firstLine)
  else if (p.firstLine > 0.5) indent.firstLine = tw(p.firstLine)
  const heading = opts.structure && p.role === 'heading' ? HEADINGS[Math.min(3, p.level - 1)] : undefined
  const listRef = opts.structure && p.list ? numbering.reference(p) : null
  if (!listRef) numbering.breakList()
  return {
    children: runChildren(runs),
    alignment: ALIGN[p.align],
    ...(heading ? { heading } : {}),
    ...(listRef ? { numbering: listRef } : {}),
    indent: listRef ? { left: tw(Math.max(p.indent, 12)), hanging: tw(Math.max(12, -p.firstLine)) } : indent,
    spacing: { before: tw(p.spaceBefore), after: 0, ...lineSpacing(p) },
    ...(heading ? { keepNext: true } : {})
  }
}

function imageType(img: LImage): 'png' | 'jpg' {
  return img.image.mime === 'image/jpeg' ? 'jpg' : 'png'
}

function inlineImage(img: LImage, maxWidth: number, pageBreak = false, leftMargin = 0): Paragraph {
  let w = img.x1 - img.x0
  let h = img.y1 - img.y0
  if (w > maxWidth) {
    h = (h * maxWidth) / w
    w = maxWidth
  }
  return new Paragraph({
    ...(pageBreak ? { pageBreakBefore: true } : {}),
    alignment: ALIGN[img.align],
    ...(img.align === 'left' && img.x0 - leftMargin > 6 && img.x1 - leftMargin <= maxWidth ? { indent: { left: tw(img.x0 - leftMargin) } } : {}),
    spacing: { before: tw(img.spaceBefore), after: 0 },
    children: [new ImageRun({ type: imageType(img), data: img.image.data, transformation: { width: px(w), height: px(h) } })]
  })
}

const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: 'auto' }
const LINE = { style: BorderStyle.SINGLE, size: 4, color: '000000' }

function cellParagraph(cell: LCell): Paragraph {
  return new Paragraph({ alignment: ALIGN[cell.align], children: runChildren(flowRuns(cell.lines)) })
}

function buildTable(t: LTable, margins: LPage['margins']): Table {
  const widths = t.colWidths.map((w) => Math.max(tw(8), tw(w)))
  // Positions covered by a merged cell from a row above.
  const covered = new Set<string>()
  for (const c of t.cells) {
    for (let r = c.row + 1; r < c.row + c.rowSpan; r++) for (let k = c.col; k < c.col + c.colSpan; k++) covered.add(`${r}:${k}`)
  }
  let cells = t.cells
  const rowsWithCells = new Set(cells.map((c) => c.row))
  if (rowsWithCells.size < t.rows) {
    // A row made only of merged cells cannot be written: unmerge vertically.
    cells = cells.map((c) => ({ ...c, rowSpan: 1 }))
    covered.clear()
    for (let r = 0; r < t.rows; r++) {
      for (let k = 0; k < t.cols; k++) {
        const owner = cells.some((c) => c.row === r && k >= c.col && k < c.col + c.colSpan)
        if (!owner) cells.push({ row: r, col: k, rowSpan: 1, colSpan: 1, lines: [], align: 'left' })
      }
    }
  }
  const rows: TableRow[] = []
  for (let r = 0; r < t.rows; r++) {
    const own = cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col)
    rows.push(
      new TableRow({
        height: { value: tw(Math.max(6, t.rowHeights[r] ?? 12)), rule: HeightRule.ATLEAST },
        children: own.map(
          (c) =>
            new TableCell({
              children: [cellParagraph(c)],
              ...(c.colSpan > 1 ? { columnSpan: c.colSpan } : {}),
              ...(c.rowSpan > 1 ? { rowSpan: c.rowSpan } : {}),
              width: { size: widths.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0), type: WidthType.DXA },
              verticalAlign: VerticalAlign.CENTER,
              margins: { left: 80, right: 80, top: 20, bottom: 20 },
              ...(c.fill !== undefined ? { shading: { fill: hex(c.fill), type: ShadingType.CLEAR, color: 'auto' } } : {})
            })
        )
      })
    )
  }
  const border = t.ruled ? LINE : NO_BORDER
  return new Table({
    rows,
    columnWidths: widths,
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    layout: TableLayoutType.FIXED,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    indent: { size: Math.max(0, tw(t.x0 - margins.left)), type: WidthType.DXA }
  })
}

function sectionPage(page: LPage, margins: LPage['margins']) {
  const landscape = page.width > page.height
  return {
    size: {
      width: tw(Math.min(page.width, page.height)),
      height: tw(Math.max(page.width, page.height)),
      orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT
    },
    margin: { top: tw(margins.top), right: tw(margins.right), bottom: tw(margins.bottom), left: tw(margins.left), header: 0, footer: 0 }
  }
}

function flowingSections(layout: DocLayout, opts: WordOptions, numbering: Numbering): ISectionOptions[] {
  const sections: ISectionOptions[] = []
  let current: { page: LPage; children: Child[] } | null = null
  const close = () => {
    if (!current) return
    const children = current.children.length ? current.children : [new Paragraph({ children: [] })]
    sections.push({ properties: { page: sectionPage(current.page, current.page.margins), type: SectionType.NEXT_PAGE }, children })
  }
  for (const page of layout.pages) {
    let pageBreak = false
    const sameSize = current && Math.abs(current.page.width - page.width) < 1 && Math.abs(current.page.height - page.height) < 1
    if (!current || !sameSize) {
      close()
      current = { page, children: [] }
    } else pageBreak = true
    const children = current.children
    const contentWidth = current.page.width - current.page.margins.left - current.page.margins.right
    for (const el of page.elements) {
      if (el.kind === 'image' && !opts.images) continue
      const brk = pageBreak ? { pageBreakBefore: true } : {}
      pageBreak = false
      if (el.kind === 'paragraph') {
        children.push(new Paragraph({ ...paragraphOptions(el, numbering, opts), ...brk }))
      } else if (el.kind === 'table') {
        numbering.breakList()
        if (opts.tables) {
          children.push(new Paragraph({ ...brk, spacing: { before: tw(el.spaceBefore), after: 0 }, children: [] }))
          children.push(buildTable(el, current.page.margins))
        } else children.push(...tableAsText(el, !!brk.pageBreakBefore))
      } else {
        numbering.breakList()
        children.push(inlineImage(el, contentWidth, !!brk.pageBreakBefore, current.page.margins.left))
      }
    }
    // An empty page stays a page.
    if (pageBreak) children.push(new Paragraph({ pageBreakBefore: true, children: [] }))
  }
  close()
  return sections
}

/** Paragraphs for the rows of a table, separated by tabs (when tables are turned off). */
function tableAsText(t: LTable, pageBreak: boolean): Paragraph[] {
  const out: Paragraph[] = []
  for (let r = 0; r < t.rows; r++) {
    const cells = t.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col)
    const runs: LRun[] = []
    cells.forEach((c, i) => {
      const cr = flowRuns(c.lines)
      if (i > 0) runs.push({ ...(cr[0] ?? runs[runs.length - 1] ?? DEFAULT_RUN), text: '\t' })
      runs.push(...cr)
    })
    out.push(
      new Paragraph({
        ...(r === 0 && pageBreak ? { pageBreakBefore: true } : {}),
        spacing: { before: r === 0 ? tw(t.spaceBefore) : 0, after: 0 },
        children: runChildren(runs)
      })
    )
  }
  return out
}

const DEFAULT_RUN: LRun = { text: '', family: 'Arial', size: 11, color: 0, bold: false, italic: false, underline: false, strike: false, mono: false }

function cellAsParagraph(c: LCell, x0: number, y0: number, x1: number, y1: number): LParagraph {
  const size = c.lines[0]?.size ?? 10
  return {
    kind: 'paragraph',
    lines: c.lines,
    role: 'body',
    level: 0,
    align: c.align === 'justify' ? 'left' : c.align,
    indent: 0,
    firstLine: 0,
    lineStep: c.lines.length > 1 ? (c.lines[c.lines.length - 1].baseline - c.lines[0].baseline) / (c.lines.length - 1) : 0,
    size,
    bold: false,
    preformatted: false,
    headingCandidate: false,
    x0,
    y0,
    x1,
    y1,
    order: 0,
    spaceBefore: 0
  }
}

/** A paragraph in a frame at its place on the page, keeping its line breaks. */
function framedParagraph(el: LParagraph, opts: WordOptions): Paragraph {
  const runs = linedRuns(el.lines)
  const hang = el.list ? Math.max(6, -el.firstLine) : 0
  if (el.list && runs.length) runs.unshift({ ...runs[0], text: el.list.marker + '\t', link: undefined, underline: false })
  const width = el.x1 - el.x0
  // Fonts in Word are rarely the exact ones of the PDF: leave room so lines do not wrap.
  const slack = Math.max(6, width * 0.08)
  const x = el.align === 'right' ? el.x0 - slack : el.align === 'center' ? el.x0 - slack / 2 : el.x0
  return new Paragraph({
    children: runChildren(runs),
    alignment: el.align === 'justify' ? AlignmentType.LEFT : ALIGN[el.align],
    ...(opts.structure && el.role === 'heading' ? { heading: HEADINGS[Math.min(3, el.level - 1)] } : {}),
    spacing: { before: 0, after: 0, ...(el.lines.length > 1 && el.lineStep > 0 ? { line: tw(el.lineStep), lineRule: LineRuleType.EXACT } : {}) },
    indent: hang ? { left: tw(hang), hanging: tw(hang) } : {},
    frame: {
      type: 'absolute',
      position: { x: tw(Math.max(0, x)), y: tw(Math.max(0, el.y0)) },
      width: tw(width + slack),
      anchor: { horizontal: FrameAnchorType.PAGE, vertical: FrameAnchorType.PAGE },
      wrap: FrameWrap.AROUND
    }
  })
}

function floatingImage(data: Uint8Array, mime: string, x: number, y: number, w: number, h: number): Paragraph {
  return new Paragraph({
    children: [
      new ImageRun({
        type: mime === 'image/jpeg' ? 'jpg' : 'png',
        data,
        transformation: { width: px(w), height: px(h) },
        floating: {
          horizontalPosition: { relative: HorizontalPositionRelativeFrom.PAGE, offset: emu(x) },
          verticalPosition: { relative: VerticalPositionRelativeFrom.PAGE, offset: emu(y) },
          wrap: { type: TextWrappingType.NONE },
          behindDocument: true,
          allowOverlap: true
        }
      })
    ]
  })
}

/**
 * One page of "Retain Page Layout": the page's graphics (pictures, artwork, table borders and
 * shading) as one picture behind the text, and every paragraph and table cell in a frame at its
 * place on the page.
 */
function pageLayoutSection(page: LPage, opts: WordOptions, numbering: Numbering): ISectionOptions {
  const children: Child[] = []
  const bg = opts.images ? page.background : undefined
  for (const el of page.elements) {
    if (el.kind === 'paragraph') {
      children.push(framedParagraph(el, opts))
      numbering.breakList()
    } else if (el.kind === 'table') {
      for (const c of el.cells) {
        if (!c.lines.length) continue
        const x0 = Math.min(...c.lines.map((l) => l.x0))
        const x1 = Math.max(...c.lines.map((l) => l.x1))
        const y0 = Math.min(...c.lines.map((l) => l.y0))
        const y1 = Math.max(...c.lines.map((l) => l.y1))
        children.push(framedParagraph(cellAsParagraph(c, x0, y0, x1, y1), opts))
      }
    } else if (opts.images && !bg && el.image.data.length) {
      children.push(floatingImage(el.image.data, el.image.mime, el.x0, el.y0, el.x1 - el.x0, el.y1 - el.y0))
    }
  }
  // Framed paragraphs are anchored to the next ordinary paragraph: end the page with one (it also
  // holds the picture behind the page), or the frames would move to the next page.
  children.push(bg ? floatingImage(bg.data, bg.mime, 0, 0, page.width, page.height) : new Paragraph({ children: [] }))
  return {
    properties: { page: sectionPage(page, { left: 0, right: 0, top: 0, bottom: 0 }), type: SectionType.NEXT_PAGE },
    children
  }
}

function bodyFont(layout: DocLayout): string {
  const count = new Map<string, number>()
  for (const p of layout.pages)
    for (const el of p.elements)
      if (el.kind === 'paragraph') for (const l of el.lines) for (const r of l.runs) count.set(r.family, (count.get(r.family) ?? 0) + r.text.length)
  let best = 'Arial'
  let n = -1
  for (const [k, v] of count) if (v > n) [best, n] = [k, v]
  return best
}

export async function buildDocx(layout: DocLayout, opts: WordOptions, meta: { title: string; author?: string }): Promise<Uint8Array> {
  const numbering = new Numbering()
  const sections = opts.layout === 'page' ? layout.pages.map((p) => pageLayoutSection(p, opts, numbering)) : flowingSections(layout, opts, numbering)
  const font = bodyFont(layout)
  const doc = new Document({
    creator: 'Fartcrobat',
    title: meta.title,
    ...(meta.author ? { lastModifiedBy: meta.author } : {}),
    styles: {
      default: {
        document: { run: { font, size: Math.round(layout.bodySize * 2) }, paragraph: { spacing: { after: 0 } } }
      }
    },
    numbering: { config: numbering.config() },
    sections
  })
  return Packer.pack(doc, 'uint8array')
}
