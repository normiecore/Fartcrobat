import type { Rect } from '@shared/geometry'
import { normalizeRect, transformRect } from '@shared/geometry'
import type { LockInfo, PasswordAccess } from '@shared/types'
import { defineOps, EngineError, mutation, withTransfer } from '../define'
import type { PDFDocument, PDFObject, Session } from '../session'
import { copyPages, removePageFields } from '../util/graft'
import { accessOf, readLockInfo } from '../util/lockInfo'
import { catalog, isNull, pageRotation, readNumber } from '../util/pdf'
import { protectBytes, sessionProtection } from '../util/protection'
import { convertToPdf, OPENABLE_FORMATS } from './doc'

function uniqueSorted(indices: number[], count: number): number[] {
  const set = new Set(indices.filter((i) => Number.isInteger(i) && i >= 0 && i < count))
  return [...set].sort((a, b) => a - b)
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many
}

/** NEEDS_PASSWORD from openSource. It carries the file's lock, to find a password saved for it. */
export class PasswordNeededError extends EngineError {
  constructor(
    fileName: string,
    readonly lock: LockInfo | null
  ) {
    super(`${fileName} is password protected`, 'NEEDS_PASSWORD')
  }
}

/**
 * Opens bytes (PDF or any format MuPDF reads) as a PDF document for grafting pages, and says what
 * `password` gave (null when none was needed).
 */
export function openSourceWithAccess(
  s: Session,
  data: Uint8Array,
  fileName = 'file.pdf',
  password?: string
): { doc: PDFDocument; access: PasswordAccess | null } {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? 'pdf').toLowerCase()
  const src = s.mupdf.Document.openDocument(data, OPENABLE_FORMATS[ext] ? fileName : 'application/pdf')
  let access: PasswordAccess | null = null
  if (src.needsPassword()) {
    access = password ? accessOf(src.authenticatePassword(password)) : null
    if (!access) {
      let lock: LockInfo | null = null
      try {
        const pdf = src.asPDF()
        lock = pdf ? readLockInfo(pdf) : null
      } catch {}
      src.destroy()
      throw new PasswordNeededError(fileName, lock)
    }
  }
  const pdf = src.asPDF()
  if (pdf) return { doc: pdf, access }
  const converted = convertToPdf(s, src)
  src.destroy()
  return { doc: converted, access }
}

/** Opens bytes (PDF or any format MuPDF reads) as a PDF document for grafting pages. */
export function openSource(s: Session, data: Uint8Array, fileName = 'file.pdf', password?: string): PDFDocument {
  return openSourceWithAccess(s, data, fileName, password).doc
}

/**
 * Copies pages from src into dst at `at` (-1 = end), sharing resources, with their annotations,
 * links and form fields (see copyPages in util/graft). src and dst may be the same document.
 */
export function graftPages(dst: PDFDocument, src: PDFDocument, pages: number[], at: number) {
  copyPages(dst, src, pages, at)
}

/** Deletes a page and detaches its form fields from /AcroForm. */
export function deletePage(doc: PDFDocument, index: number) {
  removePageFields(doc, doc.findPage(index))
  doc.deletePage(index)
}

const INHERITED_PAGE_KEYS = ['Resources', 'MediaBox', 'CropBox', 'Rotate']

/** Copies direct arrays and dictionaries (indirect references are shared). */
function cloneDirect(doc: PDFDocument, v: PDFObject): PDFObject {
  if (v.isIndirect()) return v
  if (v.isArray()) {
    const a = doc.newArray()
    v.forEach((item) => a.push(cloneDirect(doc, item)))
    return a
  }
  if (v.isDictionary()) {
    const d = doc.newDictionary()
    v.forEach((item, key) => d.put(String(key), cloneDirect(doc, item)))
    return d
  }
  return v
}

/**
 * Puts the pages in `order` (a permutation of all page indices) by rewriting the page tree as one
 * flat /Kids array under the root /Pages node. Nothing else in the document changes: MuPDF's
 * rearrangePages() rebuilds the catalog and drops the form, attachments, page labels, /Lang,
 * metadata, the structure tree and more. Values the pages inherited from intermediate /Pages
 * nodes are copied onto the pages first.
 */
export function permutePages(doc: PDFDocument, order: number[]) {
  const root = catalog(doc).get('Pages')
  const rootNum = root.isIndirect() ? root.asIndirect() : -1
  const refs = order.map((i) => doc.findPage(i))
  for (const ref of refs) {
    for (const key of INHERITED_PAGE_KEYS) {
      if (!isNull(ref.get(key))) continue
      let node = ref.get('Parent')
      for (let depth = 0; !isNull(node) && depth < 64; depth++) {
        if (node.isIndirect() && node.asIndirect() === rootNum) break // still inherited after the move
        const v = node.get(key)
        if (!isNull(v)) {
          ref.put(key, cloneDirect(doc, v))
          break
        }
        node = node.get('Parent')
      }
    }
  }
  const kids = doc.newArray()
  for (const ref of refs) {
    kids.push(ref)
    ref.put('Parent', root)
  }
  root.put('Kids', kids)
  root.put('Count', refs.length)
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
        const cur = pageRotation(readNumber(obj.getInheritable('Rotate'), 0))
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
      for (let k = list.length - 1; k >= 0; k--) deletePage(s.pdf, list[k])
      s.structureChanged()
      s.documentChanged()
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
      permutePages(s.pdf, order)
      s.structureChanged()
    }
  ),

  /** Puts the pages in an explicit order (a permutation of all page indices). */
  reorder: mutation('Reorder Pages', (s, order: number[]) => {
    const count = s.pageCount()
    if (
      order.length !== count ||
      new Set(order).size !== count ||
      !order.every((i) => Number.isInteger(i) && i >= 0 && i < count)
    ) {
      throw new EngineError('Invalid page order', 'BAD_ORDER')
    }
    permutePages(s.pdf, order)
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
        s.documentChanged()
        return pages.length
      } finally {
        src.destroy()
      }
    }
  ),

  /** Copies pages within the document (duplicate). */
  duplicate: mutation('Duplicate Pages', (s, indices: number[], at?: number) => {
    const count = s.pageCount()
    const list = uniqueSorted(indices, count)
    if (!list.length) throw new EngineError('No pages selected', 'NO_PAGES')
    const pos = at ?? list[list.length - 1] + 1
    graftPages(s.pdf, s.pdf, list, pos < 0 || pos >= count ? -1 : pos)
    s.structureChanged()
    s.documentChanged()
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
        for (let k = 0; k < replaceCount; k++) deletePage(s.pdf, start + replaceCount)
        s.structureChanged()
        s.documentChanged()
        return replaceCount
      } finally {
        src.destroy()
      }
    }
  ),

  /** New PDF bytes containing the given pages (Extract, Split), protected like the document. */
  extract(s, indices: number[]) {
    const list = uniqueSorted(indices, s.pageCount())
    if (!list.length) throw new EngineError('No pages selected', 'NO_PAGES')
    const bytes = protectBytes(s.mupdf, extractToBytes(s, list), sessionProtection(s))
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
