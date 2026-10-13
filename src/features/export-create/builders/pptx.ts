/**
 * Export to Microsoft PowerPoint (.pptx): one slide per page. 'editable': the page without its
 * text as the slide picture, with editable text boxes on top where the text was; 'image': the page
 * as a picture only.
 */
import PptxGenJS from 'pptxgenjs'
import { linedRuns, type Align, type DocLayout, type LLine, type LPage, type LParagraph, type LRun } from '../layout'
import type { PowerPointOptions } from '../shared'
import { toBase64 } from './encoding'

export interface SlidePicture {
  data: Uint8Array
  mime: string
}

const hex = (c: number) => c.toString(16).padStart(6, '0').toUpperCase()
const ALIGN: Record<Align, 'left' | 'center' | 'right' | 'justify'> = { left: 'left', center: 'center', right: 'right', justify: 'left' }

function dataUrl(p: SlidePicture): string {
  return `${p.mime};base64,${toBase64(p.data)}`
}

type TextRun = { text: string; options: Record<string, unknown> }

function textRuns(runs: LRun[], scale: number): TextRun[] {
  const out: TextRun[] = []
  for (const r of runs) {
    const pieces = r.text.split('\n')
    pieces.forEach((piece, i) => {
      const options: Record<string, unknown> = {
        fontFace: r.family,
        fontSize: Math.max(1, Math.round(r.size * scale * 2) / 2),
        color: hex(r.color),
        bold: r.bold,
        italic: r.italic,
        ...(r.underline ? { underline: { style: 'sng' } } : {}),
        ...(r.strike ? { strike: 'sngStrike' } : {}),
        ...(r.link ? { hyperlink: { url: r.link } } : {}),
        ...(i < pieces.length - 1 ? { breakLine: true } : {})
      }
      out.push({ text: piece.replace(/\t/g, '    '), options })
    })
  }
  return out
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

function addTextBox(slide: PptxGenJS.Slide, runs: LRun[], box: Box, opts: { align: Align; lineStep: number; lines: number; scale: number }) {
  if (!runs.some((r) => r.text.trim())) return
  slide.addText(textRuns(runs, opts.scale) as PptxGenJS.TextProps[], {
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    margin: 0,
    valign: 'top',
    align: ALIGN[opts.align],
    fit: 'none',
    wrap: false,
    isTextBox: true,
    paraSpaceBefore: 0,
    paraSpaceAfter: 0,
    ...(opts.lines > 1 && opts.lineStep > 0 ? { lineSpacing: Math.round(opts.lineStep * opts.scale * 10) / 10 } : {})
  })
}

function paragraphRuns(p: LParagraph): LRun[] {
  const runs = linedRuns(p.lines)
  if (p.list && runs.length) runs.unshift({ ...runs[0], text: p.list.marker + ' ', link: undefined })
  return runs
}

function linesBox(lines: LLine[]) {
  return {
    x0: Math.min(...lines.map((l) => l.x0)),
    y0: Math.min(...lines.map((l) => l.y0)),
    x1: Math.max(...lines.map((l) => l.x1)),
    y1: Math.max(...lines.map((l) => l.y1))
  }
}

export async function buildPptx(
  layout: DocLayout,
  opts: PowerPointOptions,
  meta: { title: string },
  pictures: (SlidePicture | null)[]
): Promise<Uint8Array> {
  const pptx = new PptxGenJS()
  const first = layout.pages[0]
  const sw = (first?.width ?? 792) / 72
  const sh = (first?.height ?? 612) / 72
  pptx.defineLayout({ name: 'PDF', width: sw, height: sh })
  pptx.layout = 'PDF'
  pptx.title = meta.title
  pptx.company = ''
  pptx.author = 'Fartcrobat'
  layout.pages.forEach((page: LPage, k) => {
    const slide = pptx.addSlide()
    // Pages of another size are scaled to fit the slides and centred.
    const scale = Math.min(sw / (page.width / 72), sh / (page.height / 72))
    const ox = (sw - (page.width / 72) * scale) / 2
    const oy = (sh - (page.height / 72) * scale) / 2
    const at = (x0: number, y0: number, x1: number, y1: number, slack = 0): Box => ({
      x: ox + ((x0 - slack / 2) / 72) * scale,
      y: oy + (y0 / 72) * scale,
      w: ((x1 - x0 + slack) / 72) * scale,
      h: ((y1 - y0) / 72) * scale
    })
    const pic = pictures[k]
    if (pic) slide.addImage({ data: dataUrl(pic), ...at(0, 0, page.width, page.height) })
    if (opts.mode === 'image') return
    for (const el of page.elements) {
      if (el.kind === 'paragraph') {
        const width = el.x1 - el.x0
        // Room for fonts slightly wider than the PDF's.
        const slack = Math.max(4, width * 0.06)
        const shift = el.align === 'right' ? -slack / 2 : el.align === 'center' ? 0 : slack / 2
        addTextBox(slide, paragraphRuns(el), at(el.x0 + shift, el.y0, el.x1 + shift, el.y1, slack), {
          align: el.align,
          lineStep: el.lineStep,
          lines: el.lines.length,
          scale
        })
      } else if (el.kind === 'table') {
        for (const c of el.cells) {
          if (!c.lines.length) continue
          const b = linesBox(c.lines)
          const slack = Math.max(4, (b.x1 - b.x0) * 0.06)
          const shift = c.align === 'right' ? -slack / 2 : c.align === 'center' ? 0 : slack / 2
          const steps = c.lines.slice(1).map((l, i) => l.baseline - c.lines[i].baseline)
          addTextBox(slide, linedRuns(c.lines), at(b.x0 + shift, b.y0, b.x1 + shift, b.y1, slack), {
            align: c.align,
            lineStep: steps.length ? steps.reduce((a, s) => a + s, 0) / steps.length : 0,
            lines: c.lines.length,
            scale
          })
        }
      }
    }
  })
  if (!layout.pages.length) pptx.addSlide()
  const out = await pptx.write({ outputType: 'uint8array' })
  return out as Uint8Array
}
