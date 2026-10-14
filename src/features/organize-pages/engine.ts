import type { Rect } from '@shared/geometry'
import type { CertificateLock } from '@shared/certkeys'
import type { LockInfo, PasswordAccess } from '@shared/types'
import { defineOps, EngineError, mutation, withTransfer } from '@engine/define'
import type { PDFDocument, PDFObject, Session } from '@engine/session'
import type { PubSecState } from '@engine/crypt'
import { openSourceWithAccess, type CertificateNeededError, type OpenedSource, type PasswordNeededError } from '@engine/ops/pages'
import { isNull, readName, readNumber, readString } from '@engine/util/pdf'
import {
  certificateProtectionOf,
  isEncrypted,
  outputSizer,
  protectionOfFile,
  saveWithProtection,
  sessionProtection,
  type Protection,
  type ProtectionSummary
} from '@engine/util/protection'
import { appendOutline, CONTENT_KEYS, copyPages, ObjectCopier, remapOutline, type OutlineEntry } from './copy'
import type { LabelRange, LabelStyle } from './labels'
import { splitBySize, type SplitPart } from './split'

/** A file to take pages from: its bytes, or a document opened earlier with openScratch(). */
export interface SourceRef {
  data?: Uint8Array
  key?: string
  fileName: string
  password?: string
  /** 0-based pages to use (default: all, in order). */
  pages?: number[]
  /** Bookmark title when combining (default: the file name without extension). */
  title?: string
}

/** The input of a combined file whose protection the result keeps (the first protected one). */
export interface CombineProtection {
  /** Index in the `sources` given to combine. */
  index: number
  fileName: string
  summary: ProtectionSummary
}

export type ProbeResult =
  | {
      ok: true
      pageCount: number
      title: string
      pages: { width: number; height: number }[]
      /** Set when a password opened the file. */
      access?: PasswordAccess
    }
  /** `lock` finds a password saved on this device for the file. */
  | { ok: false; needsPassword: true; needsCertificate?: false; wrongPassword: boolean; lock?: LockInfo | null }
  /** Certificate-encrypted: unlock it, give the key to doc.addCertificateKey, and probe again. */
  | { ok: false; needsPassword?: false; needsCertificate: true; certificate: CertificateLock }

const SCRATCH_PREFIX = 'organize-pages:'
const MAX_PROBE_SIZES = 2000

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : many
}

function stripExtension(name: string) {
  return name.replace(/\.[^./\\]+$/, '')
}

function uniqueSorted(indices: number[], count: number): number[] {
  return [...new Set(indices.filter((i) => Number.isInteger(i) && i >= 0 && i < count))].sort((a, b) => a - b)
}

function selectPages(doc: PDFDocument, pages: number[] | undefined): number[] {
  const n = doc.countPages()
  if (!pages) return [...Array(n).keys()]
  return pages.filter((p, i) => Number.isInteger(p) && p >= 0 && p < n && pages.indexOf(p) === i)
}

/**
 * The bytes and password each opened encrypted file came from, to give outputs its protection. For
 * a certificate-encrypted file (opened with a key the engine holds), its security instead: MuPDF
 * cannot read the protection of PubSec bytes, and holds the document through a temporary bridge.
 */
const origins = new WeakMap<PDFDocument, { data: Uint8Array; password: string | null; pubsec?: PubSecState }>()

function openFile(s: Session, data: Uint8Array, fileName: string, password?: string): OpenedSource {
  const opened = openSourceWithAccess(s, data, fileName, password)
  if (opened.pubsec) origins.set(opened.doc, { data, password: null, pubsec: opened.pubsec })
  else if (isEncrypted(opened.doc)) origins.set(opened.doc, { data, password: password ?? null })
  return opened
}

function openRef(s: Session, ref: SourceRef): { doc: PDFDocument; owned: boolean } {
  if (ref.key) {
    const doc = s.scratch.get(SCRATCH_PREFIX + ref.key)
    if (!doc) throw new EngineError(`${ref.fileName} is no longer open`, 'NO_SOURCE')
    return { doc, owned: false }
  }
  if (!ref.data) throw new EngineError(`No data for ${ref.fileName}`, 'NO_SOURCE')
  return { doc: openFile(s, ref.data, ref.fileName, ref.password).doc, owned: true }
}

/** The protection of a file opened by openRef, or null when it is not encrypted. */
function protectionOfRef(s: Session, doc: PDFDocument, fileName: string): Protection | null {
  const origin = origins.get(doc)
  // Certificate security, kept from the open (the decrypted route leaves MuPDF no encryption to see).
  if (origin?.pubsec) return certificateProtectionOf(origin.pubsec)
  if (!isEncrypted(doc)) return null
  if (!origin) throw new EngineError(`The protection of ${fileName} could not be read`, 'NO_SOURCE')
  return protectionOfFile(s.mupdf, origin.data, origin.password, s.certificateKeys)
}

function pageSizes(doc: PDFDocument, max = MAX_PROBE_SIZES) {
  const out: { width: number; height: number }[] = []
  const n = Math.min(doc.countPages(), max)
  for (let i = 0; i < n; i++) {
    const p = doc.loadPage(i)
    const b = p.getBounds()
    out.push({ width: b[2] - b[0], height: b[3] - b[1] })
    p.destroy()
  }
  return out
}

function probeDoc(doc: PDFDocument, fileName: string): Extract<ProbeResult, { ok: true }> {
  let title = ''
  try {
    title = doc.getMetaData('info:Title') ?? ''
  } catch {}
  return {
    ok: true,
    pageCount: doc.countPages(),
    title: title || stripExtension(fileName),
    pages: pageSizes(doc)
  }
}

function tryOpen(
  s: Session,
  data: Uint8Array,
  fileName: string,
  password?: string
): { doc: PDFDocument; access: PasswordAccess | null } | ProbeResult {
  try {
    return openFile(s, data, fileName, password)
  } catch (err) {
    const code = (err as EngineError).code
    if (code === 'NEEDS_PASSWORD')
      return { ok: false, needsPassword: true, wrongPassword: !!password, lock: (err as PasswordNeededError).lock ?? null }
    // No key this engine holds opens it: the renderer unlocks it, calls doc.addCertificateKey and probes again.
    if (code === 'NEEDS_CERTIFICATE') return { ok: false, needsCertificate: true, certificate: (err as CertificateNeededError).certificate }
    // CERTIFICATE_OPEN_FAILED: a key that belongs to the file found it unusable (damaged).
    throw new EngineError(
      `${fileName} could not be opened: ${(err as Error).message}`,
      code === 'CERTIFICATE_OPEN_FAILED' ? code : 'OPEN_FAILED'
    )
  }
}

function probed(opened: { doc: PDFDocument; access: PasswordAccess | null }, fileName: string): ProbeResult {
  const result = probeDoc(opened.doc, fileName)
  return opened.access ? { ...result, access: opened.access } : result
}

/** A new document holding `indices` of the session document, with comments, links, fields and bookmarks. */
function extractDoc(
  s: Session,
  indices: number[],
  opts: { bookmarks?: boolean; links?: boolean } = {}
): PDFDocument {
  const out = new s.mupdf.PDFDocument()
  try {
    const res = copyPages(out, s.pdf, indices, {
      links: opts.links !== false,
      loadSourcePage: (i) => s.page(i),
      releaseSourcePage: () => {}
    })
    if (opts.bookmarks !== false)
      appendOutline(
        out,
        remapOutline(s.pdf, out, (p) => res.pageMap.get(p) ?? null)
      )
    copyInfo(s.pdf, out)
    return out
  } catch (err) {
    out.destroy()
    throw err
  }
}

function copyInfo(src: PDFDocument, dst: PDFDocument) {
  for (const key of ['info:Author', 'info:Subject', 'info:Keywords']) {
    try {
      const v = src.getMetaData(key)
      if (v) dst.setMetaData(key, v)
    } catch {}
  }
}

function renderPng(
  s: Session,
  doc: PDFDocument,
  index: number,
  maxPx: number
): { png: Uint8Array; width: number; height: number } {
  const page = doc.loadPage(index)
  try {
    const b = page.getBounds() as Rect
    const w = Math.max(1, b[2] - b[0])
    const h = Math.max(1, b[3] - b[1])
    const scale = Math.min(4, maxPx / Math.max(w, h))
    const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], s.mupdf.ColorSpace.DeviceRGB, false, true)
    try {
      return { png: pix.asPNG().slice(), width: pix.getWidth(), height: pix.getHeight() }
    } finally {
      pix.destroy()
    }
  } finally {
    page.destroy()
  }
}

/** Copies a value for use elsewhere in the same document: direct dictionaries and arrays are cloned. */
function cloneDirect(doc: PDFDocument, v: PDFObject): PDFObject {
  if (v.isIndirect()) return v
  if (v.isDictionary()) {
    const d = doc.newDictionary()
    v.forEach((val, key) => {
      d.put(String(key), cloneDirect(doc, val))
    })
    return d
  }
  if (v.isArray()) {
    const a = doc.newArray()
    v.forEach((val) => {
      a.push(cloneDirect(doc, val))
    })
    return a
  }
  return v
}

// ---- page labels ----------------------------------------------------------------------------

function collectNumberTree(node: PDFObject, out: [number, PDFObject][], depth = 0) {
  if (depth > 32 || isNull(node)) return
  const n = node.resolve()
  const nums = n.get('Nums')
  if (!isNull(nums) && nums.isArray()) {
    for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums.get(i).asNumber(), nums.get(i + 1).resolve()])
  }
  const kids = n.get('Kids')
  if (!isNull(kids) && kids.isArray())
    for (let i = 0; i < kids.length; i++) collectNumberTree(kids.get(i), out, depth + 1)
}

function readLabelRanges(doc: PDFDocument): LabelRange[] {
  const tree = doc.getTrailer().get('Root').get('PageLabels')
  if (isNull(tree)) return []
  const entries: [number, PDFObject][] = []
  try {
    collectNumberTree(tree, entries)
  } catch {
    return []
  }
  const styles = new Set(['D', 'R', 'r', 'A', 'a'])
  return entries
    .map(([start, dict]) => {
      const s = readName(dict.get('S'))
      return {
        start: Math.round(start),
        style: (s && styles.has(s) ? s : '') as LabelStyle,
        prefix: readString(dict.get('P')),
        first: Math.max(1, Math.round(readNumber(dict.get('St'), 1)))
      }
    })
    .sort((a, b) => a.start - b.start)
}

// ---- combine --------------------------------------------------------------------------------

export interface CombineOptions {
  /** One top-level bookmark per file (default true). */
  bookmarks?: boolean
  /** Keep each file's own bookmarks under it (default true). */
  keepBookmarks?: boolean
}

function combineSources(
  s: Session,
  sources: SourceRef[],
  opts: CombineOptions
): { bytes: Uint8Array; protection: CombineProtection | null } {
  if (!sources.length) throw new EngineError('Add at least one file to combine', 'NO_FILES')
  const out = new s.mupdf.PDFDocument()
  try {
    const outline: OutlineEntry[] = []
    let kept: { protection: Protection; info: CombineProtection } | null = null
    for (let i = 0; i < sources.length; i++) {
      const ref = sources[i]
      s.progress(i / sources.length, `Adding ${ref.fileName} (${i + 1} of ${sources.length})`)
      const { doc, owned } = openRef(s, ref)
      try {
        const pages = selectPages(doc, ref.pages)
        if (!pages.length) continue
        if (!kept) {
          const protection = protectionOfRef(s, doc, ref.fileName)
          if (protection)
            kept = { protection, info: { index: i, fileName: ref.fileName, summary: protection.summary } }
        }
        const res = copyPages(out, doc, pages, { at: -1 })
        const children =
          opts.keepBookmarks !== false ? remapOutline(doc, out, (p) => res.pageMap.get(p) ?? null) : []
        if (opts.bookmarks !== false) {
          outline.push({
            title: ref.title || stripExtension(ref.fileName),
            uri: `#page=${res.indices[0] + 1}`,
            open: false,
            children
          })
        } else outline.push(...children)
      } finally {
        if (owned) doc.destroy()
      }
    }
    if (out.countPages() === 0) throw new EngineError('There are no pages to combine', 'NO_PAGES')
    s.progress(0.95, 'Adding bookmarks')
    appendOutline(out, outline)
    s.progress(0.97, 'Saving')
    const bytes = saveWithProtection(s.mupdf, out, kept?.protection ?? null)
    s.progress(1)
    return { bytes, protection: kept?.info ?? null }
  } finally {
    out.destroy()
  }
}

// ---- operations -----------------------------------------------------------------------------

export default defineOps('organize-pages', {
  /** Page count and sizes of a file, or whether it needs a password. Does not change anything. */
  probe(s, data: Uint8Array, fileName: string, password?: string): ProbeResult {
    const opened = tryOpen(s, data, fileName, password)
    if (!('doc' in opened)) return opened
    try {
      return probed(opened, fileName)
    } finally {
      opened.doc.destroy()
    }
  },

  /** Opens a file and keeps it for later calls (thumbnails, combine, insert) under `key`. */
  openScratch(s, key: string, data: Uint8Array, fileName: string, password?: string): ProbeResult {
    const opened = tryOpen(s, data, fileName, password)
    if (!('doc' in opened)) return opened
    const old = s.scratch.get(SCRATCH_PREFIX + key)
    if (old) {
      try {
        old.destroy()
      } catch {}
    }
    s.scratch.set(SCRATCH_PREFIX + key, opened.doc)
    return probed(opened, fileName)
  },

  closeScratch(s, key: string) {
    const doc = s.scratch.get(SCRATCH_PREFIX + key)
    if (!doc) return
    s.scratch.delete(SCRATCH_PREFIX + key)
    try {
      doc.destroy()
    } catch {}
  },

  /** PNG preview of a page of a scratch document (Combine Files). */
  scratchThumbnail(s, key: string, page: number, maxPx: number) {
    const doc = s.scratch.get(SCRATCH_PREFIX + key)
    if (!doc) throw new EngineError('That file is no longer open', 'NO_SOURCE')
    if (page < 0 || page >= doc.countPages())
      throw new EngineError(`Page ${page + 1} does not exist`, 'BAD_PAGE')
    const r = renderPng(s, doc, page, maxPx)
    return withTransfer(r, [r.png.buffer as ArrayBuffer])
  },

  /**
   * Combines files into one new PDF (Combine Files). Each file gets a top-level bookmark that holds
   * its own bookmarks. Comments, links and form fields are kept. Returns the PDF bytes, protected
   * like the first protected file (see combineWithProtection).
   */
  combine(s, sources: SourceRef[], opts: CombineOptions = {}) {
    const { bytes } = combineSources(s, sources, opts)
    return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
  },

  /**
   * Like combine, and says which file's protection the result has: when any file is encrypted, the
   * result gets the encryption, permissions and passwords of the first one that is (or its
   * certificate security: the same envelopes, so the same people open it with the same keys).
   */
  combineWithProtection(s, sources: SourceRef[], opts: CombineOptions = {}) {
    const result = combineSources(s, sources, opts)
    return withTransfer(result, [result.bytes.buffer as ArrayBuffer])
  },

  /**
   * New PDF bytes with the given pages, keeping comments, links, form fields and bookmarks. A
   * protected document gives a file with the same protection, unless `keepProtection` is false
   * (pages copied into another open document, which keeps its own security).
   */
  extract(s, indices: number[], opts: { keepProtection?: boolean } = {}) {
    const list = uniqueSorted(indices, s.pageCount())
    if (!list.length) throw new EngineError('No pages selected', 'NO_PAGES')
    const out = extractDoc(s, list)
    try {
      const protection = opts.keepProtection === false ? null : sessionProtection(s)
      const bytes = saveWithProtection(s.mupdf, out, protection)
      return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
    } finally {
      out.destroy()
    }
  },

  /** The protection Extract and Split give their files, or null when the document has none. */
  protection(s): ProtectionSummary | null {
    return sessionProtection(s)?.summary ?? null
  },

  /**
   * The password that opens extracted files (the one this document was opened with), or null when
   * they open without one (certificate security too: they open with the same keys). Only for
   * opening them in a new tab: never show it or pass it on.
   */
  openPassword(s): string | null {
    return sessionProtection(s)?.password ?? null
  },

  /** Plans a split into parts of at most `maxBytes` (measured by actually extracting the pages). */
  splitPlanBySize(s, maxBytes: number): SplitPart[] {
    const count = s.pageCount()
    // Parts keep the document's protection, which adds a little to their size.
    const sizer = outputSizer(s.mupdf, sessionProtection(s))
    const sizeOf = (a: number, b: number) => {
      const out = extractDoc(
        s,
        Array.from({ length: b - a + 1 }, (_, k) => a + k),
        { bookmarks: false, links: false }
      )
      try {
        return sizer.size(out)
      } finally {
        out.destroy()
      }
    }
    try {
      return splitBySize(count, Math.max(1024, maxBytes), sizeOf, (f) => s.progress(f, 'Measuring pages'))
    } finally {
      sizer.destroy()
    }
  },

  /** Inserts pages from one or more files at `at`, in one undoable step. Returns the new page indices. */
  insertFiles: mutation(
    'Insert Pages',
    (s, at: number, files: SourceRef[], opts: { bookmarks?: boolean } = {}): number[] => {
      if (!files.length) throw new EngineError('No files to insert', 'NO_FILES')
      s.invalidatePages()
      const count0 = s.pageCount()
      let pos = at < 0 || at > count0 ? count0 : at
      const inserted: number[] = []
      for (const ref of files) {
        const { doc, owned } = openRef(s, ref)
        try {
          const pages = selectPages(doc, ref.pages)
          if (!pages.length) continue
          const res = copyPages(s.pdf, doc, pages, { at: pos })
          if (opts.bookmarks !== false)
            appendOutline(
              s.pdf,
              remapOutline(doc, s.pdf, (p) => res.pageMap.get(p) ?? null)
            )
          inserted.push(...res.indices)
          pos += res.indices.length
        } finally {
          if (owned) doc.destroy()
        }
      }
      if (!inserted.length) throw new EngineError('There were no pages to insert', 'NO_PAGES')
      s.structureChanged()
      s.documentChanged()
      return inserted
    }
  ),

  /** Inserts copies of pages (with their comments, links and fields) at `at` (default: after the last one). */
  duplicate: mutation(
    (indices: number[]) => `Duplicate ${plural(indices.length, 'Page', 'Pages')}`,
    (s, indices: number[], at?: number): number[] => {
      const list = uniqueSorted(indices, s.pageCount())
      if (!list.length) throw new EngineError('No pages selected', 'NO_PAGES')
      s.invalidatePages()
      const where = at === undefined ? list[list.length - 1] + 1 : Math.max(0, Math.min(s.pageCount(), at))
      const tmp = new s.mupdf.PDFDocument()
      try {
        copyPages(tmp, s.pdf, list, { links: false })
        const res = copyPages(s.pdf, tmp, [...list.keys()], { at: where, links: false })
        // Links keep pointing at the pages they pointed at before.
        list.forEach((orig, k) => {
          const o = orig >= where ? orig + list.length : orig
          const from = s.pdf.loadPage(o)
          const to = s.pdf.loadPage(res.indices[k])
          try {
            for (const link of from.getLinks()) to.createLink(link.getBounds(), link.getURI())
          } finally {
            from.destroy()
            to.destroy()
          }
        })
        s.structureChanged()
        return res.indices
      } finally {
        tmp.destroy()
      }
    }
  ),

  /**
   * Replace Pages, as in Acrobat: pages start..end get the content of the source pages, while their
   * own links, bookmarks, form fields and comments stay; comments on the replacement pages are
   * added. When the counts differ, extra source pages are inserted or extra original pages removed.
   */
  replace: mutation(
    'Replace Pages',
    (
      s,
      start: number,
      end: number,
      source: SourceRef
    ): { replaced: number; inserted: number; removed: number } => {
      const count = s.pageCount()
      const lo = Math.max(0, Math.min(start, end))
      const hi = Math.min(count - 1, Math.max(start, end))
      if (lo > hi || lo >= count) throw new EngineError('Choose the pages to replace', 'BAD_RANGE')
      s.invalidatePages()
      const { doc, owned } = openRef(s, source)
      try {
        const pages = selectPages(doc, source.pages)
        if (!pages.length) throw new EngineError('Choose the replacement pages', 'NO_PAGES')
        const n = hi - lo + 1
        const swap = Math.min(n, pages.length)
        const copier = new ObjectCopier(s.pdf, doc)
        const base = s.pdf.countPages()
        for (let k = 0; k < swap; k++) copier.map.graftPage(-1, doc, pages[k])
        for (let k = 0; k < swap; k++) {
          const target = s.pdf.findPage(lo + k)
          const temp = s.pdf.findPage(base + k)
          for (const key of CONTENT_KEYS) {
            target.delete(key)
            const v = temp.get(key)
            if (!isNull(v)) target.put(key, cloneDirect(s.pdf, v))
          }
          copier.pages.set(doc.findPage(pages[k]).asIndirect(), target)
        }
        for (let k = 0; k < swap; k++)
          copier.copyAnnotations(pages[k], s.pdf.findPage(lo + k), { annotations: true, fields: false })
        copier.finish()
        for (let k = swap - 1; k >= 0; k--) s.pdf.deletePage(base + k)
        let inserted = 0
        let removed = 0
        if (pages.length > n) {
          inserted = copyPages(s.pdf, doc, pages.slice(n), { at: hi + 1 }).indices.length
        } else if (pages.length < n) {
          for (let i = hi; i >= lo + pages.length; i--) {
            s.pdf.deletePage(i)
            removed++
          }
        }
        s.structureChanged()
        return { replaced: swap, inserted, removed }
      } finally {
        if (owned) doc.destroy()
      }
    }
  ),

  /**
   * Marks a document created by a tool (Combine, Extract) as unsaved, so closing it asks to save.
   * Not an undoable change: there is nothing to undo.
   */
  markUnsaved(s) {
    s.markDirty()
  },

  /** The page label sections of the document (for Number Pages…). */
  labelRanges(s): LabelRange[] {
    return readLabelRanges(s.pdf)
  }
})
