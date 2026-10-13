/**
 * Export to plain text: the text of each page line by line as in the PDF ('lines'), or joined into
 * paragraphs ('paragraphs'). Pages are separated by a form feed or a blank line.
 */
import { flowRuns, linedRuns, plainText, type DocLayout, type LTable } from '../layout'

function tableText(t: LTable): string[] {
  const rows: string[] = []
  for (let r = 0; r < t.rows; r++) {
    const cells = t.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col)
    const out: string[] = []
    for (const c of cells) {
      out[c.col] = plainText(flowRuns(c.lines)).replace(/\s+/g, ' ').trim()
    }
    rows.push(Array.from({ length: t.cols }, (_, i) => out[i] ?? '').join('\t').replace(/\t+$/, ''))
  }
  return rows
}

/** Paragraph text of a laid-out document. */
export function layoutText(layout: DocLayout): string[] {
  return layout.pages.map((page) => {
    const blocks: string[] = []
    for (const el of page.elements) {
      if (el.kind === 'paragraph') {
        const runs = el.preformatted ? linedRuns(el.lines) : flowRuns(el.lines)
        const text = plainText(runs).trim()
        if (!text) continue
        const marker = el.list ? (el.list.format === 'bullet' ? '•' : el.list.marker) + ' ' : ''
        const indent = el.list ? '  '.repeat(el.list.depth) : ''
        blocks.push(indent + marker + text)
      } else if (el.kind === 'table') blocks.push(tableText(el).join('\n'))
    }
    return blocks.join('\n\n')
  })
}

/** Joins page texts into one file. */
export function joinPages(pages: string[], opts: { pageBreaks: boolean; eol: '\n' | '\r\n' }): string {
  const clean = pages.map((p) => p.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, ''))
  const text = clean.join(opts.pageBreaks ? '\n\f' : '\n\n\n') + '\n'
  return opts.eol === '\r\n' ? text.replace(/\n/g, '\r\n') : text
}
