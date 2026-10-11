import type { DocInfo, DocMetadata, OpenResult, PageInfo, Permission, SaveOptions } from '@shared/types'
import { defineOps, EngineError, mutation, withTransfer } from '../define'
import type { PDFDocument, Session } from '../session'
import { countSignatures, hasForm, hasXfa, pageBoxes, pageLabels, parsePdfDate } from '../util/pdf'

const PERMISSIONS: Permission[] = ['print', 'copy', 'edit', 'annotate', 'form', 'accessibility', 'assemble', 'print-hq']

const META_KEYS: Record<keyof DocMetadata, string> = {
  title: 'info:Title',
  author: 'info:Author',
  subject: 'info:Subject',
  keywords: 'info:Keywords',
  creator: 'info:Creator',
  producer: 'info:Producer',
  creationDate: 'info:CreationDate',
  modDate: 'info:ModDate'
}

/** File extensions MuPDF can open, mapped to a display name for the original format. */
export const OPENABLE_FORMATS: Record<string, string> = {
  pdf: 'PDF',
  xps: 'XPS',
  oxps: 'XPS',
  epub: 'EPUB',
  mobi: 'MOBI',
  fb2: 'FictionBook',
  cbz: 'Comic Book',
  svg: 'SVG',
  png: 'PNG',
  jpg: 'JPEG',
  jpeg: 'JPEG',
  gif: 'GIF',
  bmp: 'BMP',
  tif: 'TIFF',
  tiff: 'TIFF',
  jxr: 'JPEG XR',
  pnm: 'PNM',
  pbm: 'PBM',
  pgm: 'PGM',
  ppm: 'PPM',
  webp: 'WebP',
  psd: 'PSD',
  txt: 'Text',
  html: 'HTML',
  htm: 'HTML',
  xhtml: 'XHTML',
  docx: 'Word',
  xlsx: 'Excel',
  pptx: 'PowerPoint',
  hwpx: 'Hangul'
}

function extensionOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name)
  return m ? m[1].toLowerCase() : ''
}

function readMetadata(doc: PDFDocument): DocMetadata {
  const out = {} as DocMetadata
  for (const [k, key] of Object.entries(META_KEYS) as [keyof DocMetadata, string][]) {
    let v = ''
    try {
      v = doc.getMetaData(key) ?? ''
    } catch {}
    out[k] = k === 'creationDate' || k === 'modDate' ? parsePdfDate(v) || v : v
  }
  return out
}

export function buildDocInfo(s: Session): DocInfo {
  const doc = s.pdf
  const count = doc.countPages()
  const labels = pageLabels(doc, count)
  const pages: PageInfo[] = []
  for (let i = 0; i < count; i++) {
    const b = pageBoxes(doc, i)
    pages.push({
      index: i,
      id: doc.findPage(i).asIndirect(),
      width: b.width,
      height: b.height,
      rotation: b.rotation,
      label: labels[i],
      mediaBox: b.mediaBox,
      cropBox: b.cropBox
    })
  }
  const permissions = {} as Record<Permission, boolean>
  for (const p of PERMISSIONS) {
    try {
      permissions[p] = doc.hasPermission(p)
    } catch {
      permissions[p] = true
    }
  }
  const versionNum = safe(() => doc.getVersion(), 17)
  const version = (versionNum / 10).toFixed(1)
  let encryption: string | null = safe(() => doc.getMetaData('encryption') ?? null, null)
  if (encryption === 'None' || encryption === '') encryption = null
  return {
    pageCount: count,
    pages,
    metadata: readMetadata(doc),
    version,
    format: s.converted ? s.sourceFormat : `PDF ${version}`,
    converted: s.converted,
    encryption,
    permissions,
    hasForm: safe(() => hasForm(doc), false),
    hasXfa: safe(() => hasXfa(doc), false),
    signatureCount: safe(() => countSignatures(doc), 0),
    layerCount: safe(() => doc.countLayers(), 0),
    attachmentCount: safe(() => Object.keys(doc.getEmbeddedFiles()).length, 0),
    wasRepaired: safe(() => doc.wasRepaired(), false),
    canSaveIncrementally: safe(() => doc.canBeSavedIncrementally(), false),
    language: safe(() => doc.getLanguage(), null)
  }
}

/** Converts any document MuPDF can open (images, XPS, EPUB, Office...) into a PDF document. */
export function convertToPdf(s: Session, src: InstanceType<Session['mupdf']['Document']>): PDFDocument {
  const m = s.mupdf
  try {
    if ((src as any).isReflowable()) src.layout(612, 792, 11)
  } catch {}
  const buf = new m.Buffer()
  const writer = new m.DocumentWriter(buf, 'pdf', '')
  const n = src.countPages()
  for (let i = 0; i < n; i++) {
    const page = src.loadPage(i)
    const bounds = page.getBounds()
    const dev = writer.beginPage(bounds)
    page.run(dev, m.Matrix.identity)
    writer.endPage()
    page.destroy()
    s.progress((i + 1) / n, `Converting page ${i + 1} of ${n}`)
  }
  writer.close()
  const pdf = new m.PDFDocument(buf.asUint8Array().slice())
  buf.destroy()
  return pdf
}

/** Translates SaveOptions into a MuPDF write-options string. */
export function saveOptionString(opts: SaveOptions, incremental: boolean): string {
  const parts: string[] = []
  if (incremental) {
    parts.push('incremental')
    return parts.join(',')
  }
  const garbage = opts.garbage ?? 'collect'
  if (garbage === 'collect') parts.push('garbage=yes')
  else if (garbage === 'compact') parts.push('garbage=compact')
  else if (garbage === 'deduplicate') parts.push('garbage=deduplicate')
  if (opts.compress !== false) parts.push('compress')
  if (opts.compressImages) parts.push('compress-images')
  if (opts.compressFonts) parts.push('compress-fonts')
  if (opts.clean) parts.push('clean')
  if (opts.sanitize) parts.push('sanitize')
  if (opts.decrypt) parts.push('encrypt=none')
  if (opts.encrypt) {
    const e = opts.encrypt
    for (const pw of [e.userPassword, e.ownerPassword]) {
      if (pw.includes(',')) throw new EngineError('Passwords cannot contain commas', 'BAD_PASSWORD')
    }
    parts.push(`encrypt=${e.method}`)
    if (e.userPassword) parts.push(`user-password=${e.userPassword}`)
    parts.push(`owner-password=${e.ownerPassword || e.userPassword}`)
    parts.push(`permissions=${permissionBits(e.permissions)}`)
  }
  return parts.join(',')
}

/** PDF permission flags (ISO 32000-1, table 22) as a signed 32-bit integer. */
export function permissionBits(p: Partial<Record<Permission, boolean>>): number {
  let bits = 0xfffff0c0 | 0 // reserved bits set
  const allow = (flag: number, on: boolean | undefined) => {
    if (on !== false) bits |= flag
  }
  allow(1 << 2, p.print)
  allow(1 << 3, p.edit)
  allow(1 << 4, p.copy)
  allow(1 << 5, p.annotate)
  allow(1 << 8, p.form)
  allow(1 << 9, p.accessibility)
  allow(1 << 10, p.assemble)
  allow(1 << 11, p['print-hq'] ?? p.print)
  return bits | 0
}

/** Two-stage save so that compaction never touches the live document (it would break undo). */
export function saveDocument(s: Session, opts: SaveOptions = {}): Uint8Array {
  const doc = s.pdf
  const sigs = safe(() => countSignatures(doc), 0)
  let mode = opts.mode ?? 'auto'
  const changesSecurity = !!opts.encrypt || !!opts.decrypt
  if (mode === 'auto') {
    mode = sigs > 0 && !changesSecurity && safe(() => doc.canBeSavedIncrementally(), false) ? 'incremental' : 'full'
  }
  if (mode === 'incremental') {
    if (changesSecurity) throw new EngineError('Security changes need a full save', 'BAD_SAVE')
    const buf = doc.saveToBuffer('incremental')
    const out = buf.asUint8Array().slice()
    buf.destroy()
    return out
  }
  const needsSecondPass =
    opts.garbage === 'compact' ||
    opts.garbage === 'deduplicate' ||
    !!opts.compressImages ||
    !!opts.compressFonts ||
    !!opts.clean ||
    !!opts.sanitize
  if (!needsSecondPass) {
    const buf = doc.saveToBuffer(saveOptionString(opts, false))
    const out = buf.asUint8Array().slice()
    buf.destroy()
    return out
  }
  // First pass: a plain save that leaves the live document (and its undo history) untouched.
  const first = doc.saveToBuffer('garbage=yes')
  const firstBytes = first.asUint8Array().slice()
  first.destroy()
  const copy = new s.mupdf.PDFDocument(firstBytes)
  try {
    if (copy.needsPassword()) {
      // The copy inherits the original encryption; the caller must pass encrypt/decrypt options.
      throw new EngineError('Cannot optimise an encrypted document without removing security first', 'ENCRYPTED')
    }
    const buf = copy.saveToBuffer(saveOptionString(opts, false))
    const out = buf.asUint8Array().slice()
    buf.destroy()
    return out
  } finally {
    copy.destroy()
  }
}

function openInto(s: Session, data: Uint8Array, fileName: string, password?: string): OpenResult {
  const m = s.mupdf
  const ext = extensionOf(fileName) || 'pdf'
  const magic = OPENABLE_FORMATS[ext] ? fileName : 'application/pdf'
  let src: InstanceType<typeof m.Document>
  try {
    src = m.Document.openDocument(data, magic)
  } catch (err) {
    throw new EngineError(`This file could not be opened: ${(err as Error).message}`, 'OPEN_FAILED')
  }
  if (src.needsPassword()) {
    if (!password || !src.authenticatePassword(password)) {
      s.pending = src
      s.pendingBytes = data
      s.fileName = fileName
      return { ok: false, needsPassword: true, wrongPassword: !!password }
    }
  }
  return finishOpen(s, src, fileName, data)
}

function finishOpen(
  s: Session,
  src: InstanceType<Session['mupdf']['Document']>,
  fileName: string,
  bytes: Uint8Array | null
): OpenResult {
  s.pending = null
  const pdf = src.asPDF()
  if (pdf) {
    s.setDocument(pdf, { fileName, sourceFormat: 'PDF', converted: false })
    s.sourceBytes = bytes
  } else {
    const ext = extensionOf(fileName)
    const converted = convertToPdf(s, src)
    src.destroy()
    s.setDocument(converted, { fileName, sourceFormat: OPENABLE_FORMATS[ext] ?? ext.toUpperCase(), converted: true })
    s.sourceBytes = null
  }
  return { ok: true, info: buildDocInfo(s) }
}

export default defineOps('doc', {
  open(s, data: Uint8Array, opts: { fileName: string; password?: string }): OpenResult {
    return openInto(s, data, opts.fileName, opts.password)
  },

  /** Creates a new document with blank pages (File > Create > Blank Page). */
  createBlank(s, opts: { width?: number; height?: number; pages?: number; fileName?: string } = {}): OpenResult {
    const m = s.mupdf
    const doc = new m.PDFDocument()
    const w = opts.width ?? 612
    const h = opts.height ?? 792
    for (let i = 0; i < (opts.pages ?? 1); i++) {
      const page = doc.addPage([0, 0, w, h], 0, doc.newDictionary(), '')
      doc.insertPage(-1, page)
    }
    s.setDocument(doc, { fileName: opts.fileName ?? 'Untitled.pdf', sourceFormat: 'PDF', converted: true })
    return { ok: true, info: buildDocInfo(s) }
  },

  authenticate(s, password: string): OpenResult {
    const src = s.pending
    if (!src) throw new EngineError('No document is waiting for a password', 'NO_PENDING')
    if (!src.authenticatePassword(password)) return { ok: false, needsPassword: true, wrongPassword: true }
    const bytes = s.pendingBytes
    s.pendingBytes = null
    return finishOpen(s, src, s.fileName, bytes)
  },

  /** Replaces the open document with new bytes (after signing or optimising). Clears undo. */
  reload(s, data: Uint8Array, opts: { password?: string } = {}): OpenResult {
    const name = s.fileName
    return openInto(s, data, name.toLowerCase().endsWith('.pdf') ? name : name + '.pdf', opts.password)
  },

  info(s): DocInfo {
    return buildDocInfo(s)
  },

  save(s, opts: SaveOptions = {}) {
    const bytes = saveDocument(s, opts)
    return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
  },

  /** Call after the saved bytes were written to disk successfully. */
  markSaved(s, fileName?: string) {
    if (fileName) s.fileName = fileName
    s.converted = false
    s.markSaved()
  },

  isDirty(s): boolean {
    return s.isDirty()
  },

  undo(s) {
    s.undo()
  },

  redo(s) {
    s.redo()
  },

  journal(s) {
    return s.journal()
  },

  setMetadata: mutation('Change Document Properties', (s, patch: Partial<DocMetadata>) => {
    const doc = s.pdf
    for (const [k, v] of Object.entries(patch) as [keyof DocMetadata, string][]) {
      if (v === undefined) continue
      doc.setMetaData(META_KEYS[k], v)
    }
    s.documentChanged()
  }),

  setLanguage: mutation('Change Document Language', (s, lang: string) => {
    s.pdf.setLanguage(lang)
    s.documentChanged()
  }),

  close(s) {
    s.closeDocument()
  }
})

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
