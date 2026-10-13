/**
 * Export to Microsoft Excel (.xlsx): tables keep their rows and columns (merged cells, bold,
 * shading, alignment), numbers become real numbers, other text goes down column A. One worksheet
 * per page, or all pages in one sheet.
 */
import ExcelJS from 'exceljs'
import { flowRuns, plainText, type DocLayout, type LCell, type LLine, type LPage, type LRun } from '../layout'
import { parseNumber } from '../numbers'
import type { ExcelOptions } from '../shared'

const argb = (c: number) => 'FF' + c.toString(16).padStart(6, '0').toUpperCase()

interface Writer {
  ws: ExcelJS.Worksheet
  row: number
  widths: number[]
}

function setValue(cell: ExcelJS.Cell, text: string, runs: LRun[], opts: ExcelOptions) {
  const num = opts.numbers ? parseNumber(text) : null
  if (num) {
    cell.value = num.value
    cell.numFmt = num.numFmt
  } else cell.value = text
  const ink = runs.filter((r) => r.text.trim())
  if (ink.length) {
    const r = ink[0]
    const font: Partial<ExcelJS.Font> = {}
    if (ink.every((x) => x.bold)) font.bold = true
    if (ink.every((x) => x.italic)) font.italic = true
    if (ink.every((x) => x.underline)) font.underline = true
    if (r.color !== 0 && ink.every((x) => x.color === r.color)) font.color = { argb: argb(r.color) }
    if (Object.keys(font).length) cell.font = font
  }
}

function measure(w: Writer, col: number, text: string, span = 1) {
  const longest = Math.max(...text.split('\n').map((l) => l.length))
  const need = Math.min(60, Math.max(6, longest * 1.15 + 2)) / span
  w.widths[col] = Math.max(w.widths[col] ?? 8, need)
}

function writeLine(w: Writer, line: LLine, opts: ExcelOptions) {
  // Text separated by wide gaps goes into separate cells.
  const cells: LRun[][] = [[]]
  for (const r of line.runs) {
    const parts = r.text.split('\t')
    parts.forEach((p, i) => {
      if (i > 0) cells.push([])
      if (p) cells[cells.length - 1].push({ ...r, text: p })
    })
  }
  cells.forEach((runs, i) => {
    const text = plainText(runs).trim()
    if (!text) return
    setValue(w.ws.getCell(w.row, i + 1), text, runs, opts)
    if (i > 0) measure(w, i + 1, text)
  })
  w.row++
}

function cellText(c: LCell): { text: string; runs: LRun[] } {
  const runs = flowRuns(c.lines)
  return { text: plainText(runs).replace(/\t/g, ' ').trim(), runs }
}

function writePage(w: Writer, page: LPage, opts: ExcelOptions) {
  for (const el of page.elements) {
    if (el.kind === 'paragraph') {
      if (el.lines.some((l) => l.runs.some((r) => r.text.includes('\t'))) || el.preformatted) {
        for (const l of el.lines) writeLine(w, l, opts)
      } else {
        const runs = flowRuns(el.lines)
        const marker = el.list ? (el.list.format === 'bullet' ? '• ' : el.list.marker + ' ') : ''
        const text = marker + plainText(runs).trim()
        if (!text) continue
        setValue(w.ws.getCell(w.row, 1), text, runs, { ...opts, numbers: opts.numbers && !marker })
        if (el.role === 'heading') w.ws.getCell(w.row, 1).font = { ...(w.ws.getCell(w.row, 1).font ?? {}), bold: true, size: Math.min(20, Math.max(11, el.size)) }
        w.row++
      }
    } else if (el.kind === 'table') {
      if (w.row > 1) w.row++
      const top = w.row
      for (const c of el.cells) {
        const r = top + c.row
        const col = 1 + c.col
        const cell = w.ws.getCell(r, col)
        const { text, runs } = cellText(c)
        if (text) setValue(cell, text, runs, opts)
        if (c.rowSpan > 1 || c.colSpan > 1) {
          try {
            w.ws.mergeCells(r, col, r + c.rowSpan - 1, col + c.colSpan - 1)
          } catch {}
        }
        cell.alignment = {
          horizontal: c.align === 'justify' ? 'left' : c.align,
          vertical: 'middle',
          wrapText: text.length > 40
        }
        if (c.fill !== undefined) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(c.fill) } }
        if (el.ruled) {
          const thin = { style: 'thin' as const }
          cell.border = { top: thin, left: thin, bottom: thin, right: thin }
        }
        if (text) measure(w, col, text, c.colSpan)
      }
      w.row = top + el.rows + 1
    }
  }
}

export async function buildXlsx(layout: DocLayout, opts: ExcelOptions, meta: { title: string }): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Fartcrobat'
  wb.title = meta.title
  wb.created = new Date()
  const writers: Writer[] = []
  let shared: Writer | null = null
  for (const page of layout.pages) {
    let w: Writer
    if (opts.combine) {
      if (!shared) {
        shared = { ws: wb.addWorksheet('Sheet1'), row: 1, widths: [] }
        writers.push(shared)
      } else shared.row++
      w = shared
    } else {
      w = { ws: wb.addWorksheet(`Page ${page.index + 1}`), row: 1, widths: [] }
      writers.push(w)
    }
    writePage(w, page, opts)
  }
  if (!writers.length) writers.push({ ws: wb.addWorksheet('Sheet1'), row: 1, widths: [] })
  for (const w of writers) {
    w.widths.forEach((width, col) => {
      if (col >= 2 && width) w.ws.getColumn(col).width = Math.round(width)
    })
    // Column A holds paragraphs as well: keep it readable without making it huge.
    w.ws.getColumn(1).width = Math.max(12, Math.min(50, Math.round(w.widths[1] ?? 12)))
  }
  const buf = await wb.xlsx.writeBuffer()
  return new Uint8Array(buf as ArrayBuffer)
}
