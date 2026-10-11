import type { Rect } from '@shared/geometry'
import { normalizeRect, transformRect } from '@shared/geometry'
import { defineOps, EngineError, mutation, withTransfer } from '../define'
import type { PDFDocument, Session } from '../session'
import { readNumber } from '../util/pdf'
import { convertToPdf, OPENABLE_FORMATS } from './doc'

function uniqueSorted(indices: number[], count: number): number[] {
  const set = new Set(indices.filter((i) => Number.isInteger(i) && i >= 0 && i < count))
  return [...set].sort((a, b) => a - b)
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many
}

/** Opens bytes (PDF or any format MuPDF reads) as a PDF document for grafting pages. */
export function openSource(s: Session, data: Uint8Array, fileName = 'file.pdf', password?: string): PDFDocument {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? 'pdf').toLowerCase()
  const src = s.mupdf.Document.openDocument(data, OPENABLE_FORMATS[ext] ? fileName : 'application/pdf')
  if (src.needsPassword() && !(password && src.authenticatePassword(password))) {
    throw new EngineError(`${fileName} is password protected`, 'NEEDS_PASSWORD')
  }
  const pdf = src.asPDF()
  if (pdf) return pdf
  const converted = convertToPdf(s, src)
  src.destroy()
  return converted
}

/** Copies pages from src into dst at `at` (-1 = end), sharing resources. */
export function graftPages(dst: PDFDocument, src: PDFDocument, pages: number[], at: number) {
  const map = dst.newGraftMap()
  let pos = at
  for (const p of pages) {
    map.graftPage(pos, src, p)
    if (pos >= 0) pos++
  }
}

/** A new PDF containing the given pages of the session document. */
export function extractToBytes(s: Session, indices: number[]): Uint8Array {
  const out = new s.mupdf.PDFDocument()
  try {
    graftPages(out, s.pdf, indices, -1)
    const buf = out.saveToBuffer('garbage=compact,compress')
    const bytes = buf.asUint8Array().slice()
    buf.destroy()
    return bytes
  } finally {
    out.destroy()
  }
}

export default defineOps('pages', {
  rotate: mutation(
    (indices: number[]) => `Rotate ${plural(indices.length, 'Page', 'Pages')}`,
    (s, indices: number[], degrees: number) => {
      const list = uniqueSorted(indices, s.pageCount())
      for (const i of list) {
        const obj = s.pdf.findPage(i)
        const cur = Math.round(readNumber(obj.getInheritable('Rotate'), 0))
        const next = (((cur + degrees) % 360) + 360) % 360
        obj.put('Rotate', next)
      }
      s.structureChanged()
    }
  ),

  delete: mutation(
    (indices: number[]) => `Delete ${plural(indices.length, 'Page', 'Pages')}`,
    (s, indices: number[]) => {
      const count = s.pageCount()
      const list = uniqueSorted(indices, count)
      if (list.length >= count) throw new EngineError('A document must keep at least one page', 'LAST_PAGE')
      for (let k = list.length - 1; k >= 0; k--) s.pdf.deletePage(list[k])
      s.structureChanged()
    }
  ),

  /** Moves the given pages so they start at `to` (index in the document before the move). */
  move: mutation(
    (indices: number[]) => `Move ${plural(indices.length, 'Page', 'Pages')}`,
    (s, indices: number[], to: number) => {
      const count = s.pageCount()
      const moving = uniqueSorted(indices, count)
      const rest: number[] = []
      for (let i = 0; i < count; i++) if (!moving.includes(i)) rest.push(i)
      const before = rest.filter((i) => i < to).length
      const order = [...rest.slice(0, before), ...moving, ...rest.slice(before)]
      if (order.every((v, i) => v === i)) return
      s.pdf.rearrangePages(order)
      s.structureChanged()
    }
  ),

  /** Puts the pages in an explicit order (a permutation of all page indices). */
  reorder: mutation('Reorder Pages', (s, order: number[]) => {
    const count = s.pageCount()
    if (order.length !== count || new Set(order).size !== count) throw new EngineError('Invalid page order', 'BAD_ORDER')
    s.pdf.rearrangePages(order)
    s.structureChanged()
  }),

  insertBlank: mutation(
    'Insert Pages',
    (s, at: number, opts: { width?: number; height?: number; count?: number } = {}) => {
      const count = s.pageCount()
      const ref = s.pageBounds(Math.min(Math.max(0, at - 1), count - 1))
      const w = opts.width ?? ref[2] - ref[0]
      const h = opts.height ?? ref[3] - ref[1]
      for (let k = 0; k < (opts.count ?? 1); k++) {
        const page = s.pdf.addPage([0, 0, w, h], 0, s.pdf.newDictionary(), '')
        s.pdf.insertPage(at < 0 || at >= count + k ? -1 : at + k, page)
      }
      s.structureChanged()
    }
  ),

  /** Inserts pages from another file (PDF, image, Office...). `pages` defaults to all. */
  insertFrom: mutation(
    'Insert Pages',
    (s, at: number, data: Uint8Array, opts: { fileName?: string; pages?: number[]; password?: string } = {}) => {
      const src = openSource(s, data, opts.fileName, opts.password)
      try {
        const n = src.countPages()
        const pages = opts.pages ? opts.pages.filter((p) => p >= 0 && p < n) : [...Array(n).keys()]
        const count = s.pageCount()
        graftPages(s.pdf, src, pages, at < 0 || at >= count ? -1 : at)
        s.structureChanged()
        return pages.length
      } finally {
        src.destroy()
      }
    }
  ),

  /** Copies pages within the document (duplicate). */
  duplicate: mutation('Duplicate Pages', (s, indices: number[], at?: number) => {
    const list = uniqueSorted(indices, s.pageCount())
    const bytes = extractToBytes(s, list)
    const src = new s.mupdf.PDFDocument(bytes)
    try {
      graftPages(s.pdf, src, [...Array(list.length).keys()], at ?? list[list.length - 1] + 1)
    } finally {
      src.destroy()
    }
    s.structureChanged()
  }),

  /** Replaces pages starting at `start` with pages from another file. */
  replace: mutation(
    'Replace Pages',
    (s, start: number, data: Uint8Array, opts: { fileName?: string; pages?: number[]; password?: string } = {}) => {
      const src = openSource(s, data, opts.fileName, opts.password)
      try {
        const n = src.countPages()
        const pages = opts.pages ? opts.pages.filter((p) => p >= 0 && p < n) : [...Array(n).keys()]
        const count = s.pageCount()
        const replaceCount = Math.min(pages.length, count - start)
        if (replaceCount <= 0) throw new EngineError('Nothing to replace', 'BAD_RANGE')
        graftPages(s.pdf, src, pages.slice(0, replaceCount), start)
        for (let k = 0; k < replaceCount; k++) s.pdf.deletePage(start + replaceCount)
        s.structureChanged()
        return replaceCount
      } finally {
        src.destroy()
      }
    }
  ),

  /** New PDF bytes containing the given pages (Extract, Split). */
  extract(s, indices: number[]) {
    const list = uniqueSorted(indices, s.pageCount())
    if (!list.length) throw new EngineError('No pages selected', 'NO_PAGES')
    const bytes = extractToBytes(s, list)
    return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
  },

  /** Sets a page box (CropBox by default) from a rectangle in page space. */
  setBox: mutation(
    'Crop Pages',
    (s, indices: number[], rect: Rect | null, box: 'CropBox' | 'TrimBox' | 'BleedBox' | 'ArtBox' | 'MediaBox' = 'CropBox') => {
      for (const i of uniqueSorted(indices, s.pageCount())) {
        const obj = s.pdf.findPage(i)
        if (rect === null) {
          obj.delete(box)
          continue
        }
        const user = normalizeRect(transformRect(rect, s.pageToUser(i)))
        const arr = s.pdf.newArray()
        for (const v of user) arr.push(v)
        obj.put(box, arr)
      }
      s.structureChanged()
    }
  ),

  /** Page labels (Organize > Page Labels). */
  setLabels: mutation(
    'Number Pages',
    (s, ranges: { start: number; style: 'D' | 'R' | 'r' | 'A' | 'a' | ''; prefix?: string; first?: number }[]) => {
      const doc = s.pdf
      const n = s.pageCount()
      for (let i = 0; i < n; i++) {
        try {
          doc.deletePageLabels(i)
        } catch {}
      }
      for (const r of ranges) {
        doc.setPageLabels(r.start, r.style || '\0', r.prefix ?? '', r.first ?? 1)
      }
      s.structureChanged()
    }
  ),

  /** Page size in points, for each page. */
  sizes(s): { width: number; height: number }[] {
    const out: { width: number; height: number }[] = []
    const n = s.pageCount()
    for (let i = 0; i < n; i++) {
      const b = s.pageBounds(i)
      out.push({ width: b[2] - b[0], height: b[3] - b[1] })
    }
    return out
  }
})
