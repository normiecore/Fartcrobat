import { EnvelopeBuildError, buildEnvelopedData } from '@features/digital-signatures/lib/envelopeBuild'
import { PUBSEC_PERMISSION, type CertificateKey, type CertificateLock } from '@shared/certkeys'
import type { DocInfo, DocMetadata, LockInfo, OpenResult, PageInfo, PasswordAccess, Permission, SaveOptions } from '@shared/types'
import {
  assertNoBridge,
  certificateEncryptionLabel,
  certificateLockOf,
  certificatePermissionBits,
  certificatePermissions,
  copyCertificateKey,
  keysOpen,
  openPubSec,
  openWithKeys,
  plainSaveOptions,
  plainSessionBytes,
  randomBytes,
  readPubSec,
  sessionReadPassword,
  writeKeyFor,
  writePubSecDocument,
  writeSessionPubSec,
  type PubSecInfo,
  type PubSecState
} from '../crypt'
import { defineOps, EngineError, mutation, withTransfer, type Transfer } from '../define'
import type { PDFDocument, Session } from '../session'
import { accessOf, readLockInfo } from '../util/lockInfo'
import {
  catalog,
  countSignatures,
  hasForm,
  hasXfa,
  pageBoxes,
  pageLabels,
  parsePdfDate,
  pdfDate,
  readString
} from '../util/pdf'

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
  return { ...documentFacts(s), pageCount: count, pages }
}

/** Everything in DocInfo except the per-page list: cheap enough to refresh after every change. */
export function documentFacts(s: Session): Omit<DocInfo, 'pages'> {
  const doc = s.pdf
  const pubsec = s.pubsec
  let permissions = {} as Record<Permission, boolean>
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
  if (pubsec) {
    // MuPDF sees the temporary bridge (or no encryption at all): report the file's own security,
    // and the permissions of the envelope that opened it.
    encryption = certificateEncryptionLabel(pubsec.source)
    permissions = certificatePermissions(pubsec.permissions).permissions
  }
  return {
    pageCount: doc.countPages(),
    metadata: readMetadata(doc),
    version,
    format: s.converted ? s.sourceFormat : `PDF ${version}`,
    converted: s.converted,
    encryption,
    security: pubsec ? 'certificate' : encryption ? 'password' : null,
    permissions,
    hasForm: safe(() => hasForm(doc), false),
    hasXfa: safe(() => hasXfa(doc), false),
    signatureCount: safe(() => countSignatures(doc), 0),
    layerCount: safe(() => doc.countLayers(), 0),
    attachmentCount: safe(() => Object.keys(doc.getEmbeddedFiles()).length, 0),
    wasRepaired: safe(() => doc.wasRepaired(), false),
    // Certificate-encrypted documents are always saved in full (see saveCertificateDocument).
    canSaveIncrementally: !pubsec && safe(() => doc.canBeSavedIncrementally(), false),
    // Read /Lang as written: MuPDF's getLanguage() drops region subtags ("en-US" -> "en").
    language: safe(() => readString(catalog(doc).get('Lang')) || doc.getLanguage() || null, null)
  }
}

/** Converts any document MuPDF can open (images, XPS, EPUB, Office...) into a PDF document. */
export function convertToPdf(s: Session, src: InstanceType<Session['mupdf']['Document']>): PDFDocument {
  const m = s.mupdf
  try {
    // Lays out reflowable formats (text, HTML, EPUB...) on Letter pages; fixed-layout formats
    // ignore it. (mupdf.js isReflowable() has no return value, so it cannot be used to decide.)
    src.layout(612, 792, 11)
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

/**
 * Session state key (`s.state`): SaveOptions that every later save of this session must use. A
 * feature sets it when an incremental save would leak removed content (e.g. after redaction).
 */
export const REQUIRED_SAVE_OPTIONS = 'core:requiredSaveOptions'

const GARBAGE_LEVELS: NonNullable<SaveOptions['garbage']>[] = ['none', 'collect', 'compact', 'deduplicate']

/**
 * Session state key: the last save of a certificate-encrypted document with its own seed and
 * envelopes, and the edit version it holds, until markSaved says it became the document's file.
 */
const CERTIFICATE_SAVE = 'core:certificateSave'

/** Merges the session's required save options (if any) over the caller's options. */
export function withRequiredSaveOptions(s: Session, opts: SaveOptions): SaveOptions {
  const req = s.state.get(REQUIRED_SAVE_OPTIONS) as SaveOptions | undefined
  if (!req) return opts
  if (req.mode === 'full' && opts.mode === 'incremental') {
    throw new EngineError(
      'This document must be saved in full (content was redacted or removed); an incremental save would keep the removed content in the file.',
      'FULL_SAVE_REQUIRED'
    )
  }
  const out: SaveOptions = { ...opts }
  if (req.mode) out.mode = req.mode
  if (req.garbage && GARBAGE_LEVELS.indexOf(req.garbage) > GARBAGE_LEVELS.indexOf(out.garbage ?? 'collect')) out.garbage = req.garbage
  if (req.clean) out.clean = true
  if (req.sanitize) out.sanitize = true
  return out
}

function takeBuffer(buf: InstanceType<Session['mupdf']['Buffer']>): Uint8Array {
  try {
    return buf.asUint8Array().slice()
  } finally {
    buf.destroy()
  }
}

/**
 * 'auto' saves append an incremental update when the document is signed (or was signed when it
 * was opened, so a cleared signature still keeps its signed revision in the file).
 */
function prefersIncremental(s: Session): boolean {
  const doc = s.pdf
  if (s.pubsec) return false
  if (!safe(() => doc.canBeSavedIncrementally(), false)) return false
  return s.signedOnOpen || safe(() => countSignatures(doc), 0) > 0
}

/** Appends the changes to the file as an incremental update (keeps signed revisions intact). */
function saveIncrementally(s: Session): Uint8Array {
  if (s.inOperation) {
    // The document is reopened below, which cannot happen in the middle of an undo step.
    throw new EngineError('Incremental saves cannot run inside an undoable operation', 'BAD_SAVE')
  }
  const bytes = takeBuffer(s.pdf.saveToBuffer('incremental'))
  // MuPDF builds every incremental save on the bytes the document was opened from. Reopen from
  // the bytes just produced, so the next incremental save appends to them with a valid /Prev.
  // This also checks the output: a damaged file throws here instead of reaching the disk.
  s.rebase(bytes)
  return bytes
}

/**
 * Serialises the document. Anything beyond a plain save (compaction, image/font recompression,
 * cleaning, security changes) runs on a copy, so the live document keeps its undo history and
 * its own security settings.
 */
export function saveDocument(s: Session, opts: SaveOptions = {}): Uint8Array {
  // Only the latest save can become the document's file (see adoptSavedCertificateFile).
  s.state.delete(CERTIFICATE_SAVE)
  if (opts.encryptCertificate) return saveWithNewCertificateSecurity(s, opts)
  if (s.pubsec) return saveCertificateDocument(s, s.pubsec, opts)
  opts = withRequiredSaveOptions(s, opts)
  const doc = s.pdf
  let mode = opts.mode ?? 'auto'
  const changesSecurity = !!opts.encrypt || !!opts.decrypt
  if (mode === 'auto') mode = !changesSecurity && prefersIncremental(s) ? 'incremental' : 'full'
  if (mode === 'incremental') {
    if (changesSecurity) throw new EngineError('Security changes need a full save', 'BAD_SAVE')
    return saveIncrementally(s)
  }
  const needsCopy =
    opts.garbage === 'compact' ||
    opts.garbage === 'deduplicate' ||
    !!opts.compressImages ||
    !!opts.compressFonts ||
    !!opts.clean ||
    !!opts.sanitize ||
    changesSecurity
  if (!needsCopy) return takeBuffer(doc.saveToBuffer(saveOptionString(opts, false)))
  // First pass: a plain save that keeps the current encryption and leaves the live document
  // untouched (saving with encrypt=none or a new encryption rewrites the live trailer).
  const copy = new s.mupdf.PDFDocument(takeBuffer(doc.saveToBuffer('garbage=yes')))
  try {
    if (copy.needsPassword() && !(s.password && copy.authenticatePassword(s.password))) {
      throw new EngineError('Cannot optimise an encrypted document whose password is not known', 'ENCRYPTED')
    }
    // Second pass: the requested options, including the final security, on the copy.
    return takeBuffer(copy.saveToBuffer(saveOptionString(opts, false)))
  } finally {
    copy.destroy()
  }
}

/**
 * SaveOptions.encryptCertificate: new certificate security (Protect > Encrypt with Certificate) for
 * any document, plain, password-protected or certificate-encrypted. A new 20-byte seed, one
 * envelope per group (buildEnvelopedData: AES-256-CBC content, RSA PKCS#1 v1.5 key transport,
 * issuerAndSerialNumber copied from each certificate), written as V5 AES-256 by the PubSec writer.
 * Replaces any other security. Always a full save; the live document is not changed.
 *
 * The engine keeps the new key (one per envelope) with full access, so reloading the saved bytes
 * opens them without asking and the person who applied the security keeps full access in this tab,
 * as in Acrobat, where new security applies from the next time the file is opened. Other engines
 * open the file with the key the person's own certificate unwraps, and its permissions.
 */
function saveWithNewCertificateSecurity(s: Session, opts: SaveOptions): Uint8Array {
  const spec = opts.encryptCertificate!
  if (opts.mode === 'incremental') throw new EngineError('Security changes need a full save', 'BAD_SAVE')
  if (opts.encrypt || opts.decrypt) throw new EngineError('Choose one kind of security to save with', 'BAD_SAVE')
  // As for Remove Security: only a recipient allowed to change the security may replace it.
  if (s.pubsec && s.pubsec.access !== 'owner') {
    throw new EngineError('Your certificate does not allow changing the security of this document', 'PERMISSION_DENIED')
  }
  const groups = (spec.groups ?? []).filter((g) => g.certificates?.length)
  if (!groups.length) throw new EngineError('Add at least one recipient', 'NO_RECIPIENTS')
  const seed = randomBytes(20)
  const envelopes: Uint8Array[] = []
  const permissions: number[] = []
  for (const g of groups) {
    const bits = certificatePermissionBits(g.permissions ?? {}, !!g.changeSecurity)
    try {
      envelopes.push(buildEnvelopedData(g.certificates, seed, bits))
    } catch (err) {
      if (err instanceof EnvelopeBuildError) throw new EngineError(err.message, err.code)
      throw err
    }
    permissions.push(bits)
  }
  const key = writeKeyFor(seed, envelopes, spec.encryptMetadata ?? true)
  opts = withRequiredSaveOptions(s, { ...opts, mode: 'full' })
  // compress, compress-images, compress-fonts, clean, sanitize and the garbage level, no security.
  const plainOptions = plainSaveOptions(
    saveOptionString({ ...opts, encrypt: undefined, decrypt: false, encryptCertificate: undefined }, false)
  )
  const bytes = writePubSecDocument(s.mupdf, s.pdf, key, { saveOptions: plainOptions, password: sessionReadPassword(s) })
  // No bridge of a certificate-encrypted session, and no Standard handler of a password-protected one.
  assertNoBridge(bytes, s.pubsec)
  envelopes.forEach((envelope, i) => {
    s.certificateKeys.add({ envelope, seed, permissions: (permissions[i] | PUBSEC_PERMISSION.changeSecurity) >>> 0 })
  })
  seed.fill(0)
  return bytes
}

/**
 * Saves a certificate-encrypted document, always in full ('auto' too, even when it is signed: the
 * person is warned that its signatures become invalid). Compaction, compression, cleaning and
 * sanitizing apply to the plain copy. The output keeps the original seed and envelopes (V4 files
 * are upgraded to V5, AES-256); `decrypt` writes a plain file and `encrypt` password security,
 * both only for a recipient allowed to change the security.
 */
function saveCertificateDocument(s: Session, state: PubSecState, opts: SaveOptions): Uint8Array {
  if (opts.mode === 'incremental') {
    throw new EngineError('Certificate-encrypted documents are always saved in full', 'CERTIFICATE_FULL_SAVE')
  }
  opts = withRequiredSaveOptions(s, { ...opts, mode: 'full' })
  if ((opts.encrypt || opts.decrypt) && state.access !== 'owner') {
    throw new EngineError('Your certificate does not allow changing the security of this document', 'PERMISSION_DENIED')
  }
  // compress, compress-images, compress-fonts, clean, sanitize and the garbage level, no security.
  const plainOptions = plainSaveOptions(saveOptionString({ ...opts, encrypt: undefined, decrypt: false }, false))
  if (opts.encrypt) {
    const copy = new s.mupdf.PDFDocument(plainSessionBytes(s, 'garbage=yes'))
    let bytes: Uint8Array
    try {
      bytes = takeBuffer(copy.saveToBuffer(saveOptionString({ ...opts, decrypt: false }, false)))
    } finally {
      copy.destroy()
    }
    assertNoBridge(bytes, state, 'password')
    return bytes
  }
  if (opts.decrypt) {
    const bytes = plainSessionBytes(s, plainOptions)
    assertNoBridge(bytes, state, 'plain')
    return bytes
  }
  const bytes = writeSessionPubSec(s, plainOptions)
  // A copy: the caller usually transfers `bytes` to the UI thread, which detaches them here.
  s.state.set(CERTIFICATE_SAVE, { bytes: bytes.slice(), version: s.editVersion() })
  return bytes
}

/**
 * After a certificate-encrypted document was written to its file (markSaved): the session describes
 * that file from now on, as reopening it would. Every such save is a full rewrite as V5 AES-256, so
 * signatures are validated against the new bytes (which they no longer cover) and the encryption is
 * reported as V5. Save a Copy and a failed write (no markSaved for that save) change nothing.
 */
function adoptSavedCertificateFile(s: Session, version?: number) {
  const saved = s.state.get(CERTIFICATE_SAVE) as { bytes: Uint8Array; version: number } | undefined
  s.state.delete(CERTIFICATE_SAVE)
  const state = s.pubsec
  if (!saved || !state || (version !== undefined && version !== saved.version)) return
  s.sourceBytes = saved.bytes
  state.source = { version: 5, cipher: 'AESV3', keyBits: 256 }
  state.encryptMetadata = state.writeKey.encryptMetadata
}

interface OpenOptions {
  password?: string
  /** Report the document as unsaved (it only exists in memory). */
  dirty?: boolean
  /** Replacing the open document: keep it open on failure, keep tab settings, reuse its password. */
  reload?: boolean
}

function openInto(s: Session, data: Uint8Array, fileName: string, opts: OpenOptions = {}): OpenResult {
  const m = s.mupdf
  const ext = extensionOf(fileName) || 'pdf'
  const magic = OPENABLE_FORMATS[ext] ? fileName : 'application/pdf'
  let src: InstanceType<typeof m.Document>
  try {
    src = m.Document.openDocument(data, magic)
  } catch (err) {
    // MuPDF only knows the Standard security handler and throws on /Adobe.PubSec files.
    const info = pubsecOf(data)
    if (info) return openCertificateInto(s, data, fileName, info, opts)
    throw new EngineError(`This file could not be opened: ${(err as Error).message}`, 'OPEN_FAILED')
  }
  let password: string | undefined
  let access: PasswordAccess | undefined
  if (src.needsPassword()) {
    const candidates = [opts.password, opts.reload ? s.password : null].filter((p): p is string => !!p)
    for (const p of candidates) {
      const a = accessOf(src.authenticatePassword(p))
      if (a) {
        password = p
        access = a
        break
      }
    }
    if (password === undefined) {
      // Read before authenticating, so the person's saved passwords can be looked up.
      const lock = lockOf(src)
      if (opts.reload) {
        // The open document stays as it is; the caller can ask for the password and retry.
        src.destroy()
        return { ok: false, needsPassword: true, wrongPassword: !!opts.password, lock }
      }
      dropPending(s, src)
      s.pending = src
      s.pendingBytes = data
      s.pendingDirty = !!opts.dirty
      s.fileName = fileName
      return { ok: false, needsPassword: true, wrongPassword: !!opts.password, lock }
    }
  }
  return finishOpen(s, src, fileName, data, { password, access, dirty: opts.dirty, keepSettings: opts.reload })
}

/** Forgets documents waiting for a password or a certificate key (except `keep`). */
function dropPending(s: Session, keep?: InstanceType<Session['mupdf']['Document']>) {
  if (s.pending && s.pending !== keep) {
    try {
      s.pending.destroy()
    } catch {}
  }
  s.pending = null
  s.pendingBytes = null
  s.pendingDirty = false
  s.pendingCertificate = null
}

/**
 * The public-key security of bytes MuPDF refused, or null when that is not why. A file with too
 * many recipients throws CERTIFICATE_UNSUPPORTED, so the person learns why it does not open.
 */
export function pubsecOf(data: Uint8Array): PubSecInfo | null {
  try {
    return readPubSec(data)
  } catch (err) {
    if (err instanceof EngineError && err.code === 'CERTIFICATE_UNSUPPORTED') throw err
    return null
  }
}

/**
 * Opens a certificate-encrypted file with a key the engine holds. Without one, the file waits for
 * doc.unlockCertificate (a reload leaves the open document as it is instead, as with passwords).
 */
function openCertificateInto(s: Session, data: Uint8Array, fileName: string, info: PubSecInfo, opts: OpenOptions): OpenResult {
  const opened = openWithKeys(s.mupdf, data, info, s.certificateKeys.find(info.recipients))
  if (opened) {
    return finishOpen(s, opened.doc, fileName, data, {
      pubsec: opened.state,
      access: opened.state.access,
      dirty: opts.dirty,
      keepSettings: opts.reload
    })
  }
  const certificate = certificateLockOf(info)
  if (opts.reload) return { ok: false, needsCertificate: true, certificate }
  dropPending(s)
  s.pendingCertificate = { bytes: data, info, dirty: !!opts.dirty }
  s.fileName = fileName
  return { ok: false, needsCertificate: true, certificate }
}

function lockOf(src: InstanceType<Session['mupdf']['Document']>): LockInfo | null {
  try {
    const pdf = src.asPDF()
    return pdf ? readLockInfo(pdf) : null
  } catch {
    return null
  }
}

function finishOpen(
  s: Session,
  src: InstanceType<Session['mupdf']['Document']>,
  fileName: string,
  bytes: Uint8Array | null,
  opts: { password?: string; access?: PasswordAccess; dirty?: boolean; keepSettings?: boolean; pubsec?: PubSecState } = {}
): OpenResult {
  s.pending = null
  s.pendingBytes = null
  s.pendingDirty = false
  s.pendingCertificate = null
  const pdf = src.asPDF()
  if (pdf) {
    s.setDocument(pdf, { fileName, sourceFormat: 'PDF', converted: false, dirty: opts.dirty, keepSettings: opts.keepSettings })
    // For a certificate-encrypted document: the file as given (signatures cover these bytes).
    s.sourceBytes = bytes
    s.password = opts.password ?? null
    s.pubsec = opts.pubsec ?? null
  } else {
    const ext = extensionOf(fileName)
    const converted = convertToPdf(s, src)
    src.destroy()
    s.setDocument(converted, {
      fileName,
      sourceFormat: OPENABLE_FORMATS[ext] ?? ext.toUpperCase(),
      converted: true,
      keepSettings: opts.keepSettings
    })
    s.sourceBytes = null
    s.password = null
  }
  const info = buildDocInfo(s)
  return opts.access ? { ok: true, info, access: opts.access } : { ok: true, info }
}

/** ISO date (as returned in DocMetadata) or PDF date -> PDF date string. */
function toPdfDate(value: string): string {
  if (!value || /^D:/.test(value)) return value
  const t = Date.parse(value)
  if (Number.isNaN(t)) throw new EngineError(`“${value}” is not a valid date`, 'BAD_DATE')
  return pdfDate(new Date(t))
}

export default defineOps('doc', {
  /** Opens a file. `dirty` reports it as unsaved until it is saved (new, combined, converted documents). */
  open(s, data: Uint8Array, opts: { fileName: string; password?: string; dirty?: boolean }): OpenResult {
    return openInto(s, data, opts.fileName, { password: opts.password, dirty: opts.dirty })
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

  /** Tries a password on the document waiting for one; `access` says what it opened it with. */
  authenticate(s, password: string, opts: { dirty?: boolean } = {}): OpenResult {
    const src = s.pending
    if (!src) throw new EngineError('No document is waiting for a password', 'NO_PENDING')
    const access = accessOf(src.authenticatePassword(password))
    if (!access) return { ok: false, needsPassword: true, wrongPassword: true, lock: lockOf(src) }
    return finishOpen(s, src, s.fileName, s.pendingBytes, { password, access, dirty: opts.dirty || s.pendingDirty })
  },

  /**
   * Whether a file needs a password, without opening it as the document (files read as inputs,
   * e.g. by Create). With `password`, also what that password gives (null: it is wrong).
   */
  checkFile(
    s,
    data: Uint8Array,
    fileName: string,
    password?: string
  ):
    | { needsPassword: false; needsCertificate?: false }
    | { needsPassword: true; lock: LockInfo | null; access: PasswordAccess | null }
    /** Certificate-encrypted and no key this engine holds (addCertificateKey) opens it. */
    | { needsPassword: false; needsCertificate: true; certificate: CertificateLock } {
    const ext = extensionOf(fileName) || 'pdf'
    let src: InstanceType<Session['mupdf']['Document']>
    try {
      src = s.mupdf.Document.openDocument(data, OPENABLE_FORMATS[ext] ? fileName : 'application/pdf')
    } catch (err) {
      const info = pubsecOf(data)
      if (info) {
        // A key this engine holds opens it (checked without opening the file).
        if (keysOpen(data, info, s.certificateKeys.find(info.recipients))) return { needsPassword: false }
        return { needsPassword: false, needsCertificate: true, certificate: certificateLockOf(info) }
      }
      throw new EngineError(`This file could not be opened: ${(err as Error).message}`, 'OPEN_FAILED')
    }
    try {
      if (!src.needsPassword()) return { needsPassword: false }
      const lock = lockOf(src)
      return { needsPassword: true, lock, access: password ? accessOf(src.authenticatePassword(password)) : null }
    } finally {
      src.destroy()
    }
  },

  /**
   * Opens the certificate-encrypted document waiting after `open` returned needsCertificate, with a
   * key the person's certificate unwrapped (certkeys:decrypt). The engine keeps the key (see
   * addCertificateKey). Returns needsCertificate again when the key does not belong to the file.
   */
  unlockCertificate(s, key: CertificateKey, opts: { dirty?: boolean } = {}): OpenResult {
    const pending = s.pendingCertificate
    if (!pending) throw new EngineError('No document is waiting for a certificate', 'NO_PENDING')
    const k = copyCertificateKey(key)
    let opened: ReturnType<typeof openPubSec>
    try {
      opened = openPubSec(s.mupdf, pending.bytes, pending.info, k)
    } catch (err) {
      if ((err as EngineError).code === 'CERTIFICATE_KEY_MISMATCH') {
        return { ok: false, needsCertificate: true, certificate: certificateLockOf(pending.info) }
      }
      throw err
    }
    s.certificateKeys.add(k)
    return finishOpen(s, opened.doc, s.fileName, pending.bytes, {
      pubsec: opened.state,
      access: opened.state.access,
      dirty: opts.dirty || pending.dirty
    })
  },

  /**
   * Keeps a key in this engine for the life of the worker: files whose /Recipients hold its
   * envelope then open without asking (reload, revert, files to insert, combine, compare or create
   * from, and new tabs made from a certificate-encrypted document).
   */
  addCertificateKey(s, key: CertificateKey): void {
    s.certificateKeys.add(key)
  },

  /**
   * The key that opened the open document (null when it is not certificate-encrypted), for the
   * renderer to give to new tabs made from it. After Encrypt with Certificate this is the new key,
   * which only the engine has seen. Secret: see CertificateKey.
   */
  certificateKey(s): CertificateKey | null {
    const k = s.doc ? s.pubsec?.key : null
    return k ? { envelope: k.envelope.slice(), seed: k.seed.slice(), permissions: k.permissions } : null
  },

  /** The open document's certificate security (public data), or null when it is not certificate-encrypted. */
  certificateLock(s): CertificateLock | null {
    const p = s.pubsec
    if (!p || !s.doc) return null
    return certificateLockOf({ recipients: p.recipients, version: p.source.version, cipher: p.source.cipher, keyLength: p.source.keyBits / 8 })
  },

  /**
   * The lock of the open document (null when it is not encrypted), to find its saved password.
   * Null for a certificate-encrypted document: no password opens it, and MuPDF's trailer holds the
   * temporary bridge, which never leaves the engine (see certificateLock).
   */
  lockInfo(s): LockInfo | null {
    if (s.pubsec) return null
    return readLockInfo(s.pdf)
  },

  /**
   * Replaces the open document with new bytes (after signing or optimising). Clears undo. The
   * password the document was opened with is tried automatically; when the new bytes need
   * another one the result asks for it and the open document is left unchanged. `dirty` reports
   * the new content as unsaved (it was not written to the document's file).
   */
  reload(s, data: Uint8Array, opts: { password?: string; dirty?: boolean } = {}): OpenResult {
    const name = s.fileName
    return openInto(s, data, name.toLowerCase().endsWith('.pdf') ? name : name + '.pdf', {
      password: opts.password,
      dirty: opts.dirty,
      reload: true
    })
  },

  info(s): DocInfo {
    return buildDocInfo(s)
  },

  /** DocInfo without the page list (metadata, security, form, signatures, attachments...). */
  facts(s): Omit<DocInfo, 'pages'> {
    return documentFacts(s)
  },

  save(s, opts: SaveOptions = {}) {
    const bytes = saveDocument(s, opts)
    return withTransfer(bytes, [bytes.buffer as ArrayBuffer])
  },

  /**
   * Like `save`, plus the edit version the bytes correspond to. Pass that version to `markSaved`
   * so that edits made while the file was being written keep the document dirty.
   */
  saveWithVersion(s, opts: SaveOptions = {}): Transfer<{ bytes: Uint8Array; version: number }> {
    const version = s.editVersion()
    const bytes = saveDocument(s, opts)
    return withTransfer({ bytes, version }, [bytes.buffer as ArrayBuffer])
  },

  /**
   * Call after the saved bytes were written to disk successfully. `version` (from
   * `saveWithVersion`) is the state the file holds; without it the current state is marked saved.
   */
  markSaved(s, fileName?: string, version?: number) {
    if (fileName) s.fileName = fileName
    s.converted = false
    adoptSavedCertificateFile(s, version)
    s.markSaved(version)
  },

  isDirty(s): boolean {
    return s.isDirty()
  },

  /** Reports the document as unsaved until the next markSaved (e.g. content not written to its file). */
  markDirty(s) {
    s.markDirty()
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

  /**
   * Changes document properties. Dates may be ISO strings (as `info().metadata` returns them) or
   * PDF dates; the modification date is set to now unless the patch sets it.
   */
  setMetadata: mutation('Change Document Properties', (s, patch: Partial<DocMetadata>) => {
    const doc = s.pdf
    for (const [k, v] of Object.entries(patch) as [keyof DocMetadata, string][]) {
      if (v === undefined || !(k in META_KEYS)) continue
      doc.setMetaData(META_KEYS[k], k === 'creationDate' || k === 'modDate' ? toPdfDate(v) : v)
    }
    if (patch.modDate === undefined) doc.setMetaData(META_KEYS.modDate, pdfDate())
    s.documentChanged()
  }),

  /** Sets the document language (/Lang), e.g. "en-US". An empty string removes it. */
  setLanguage: mutation('Change Document Language', (s, lang: string) => {
    // MuPDF's setLanguage() keeps only the primary subtag; write /Lang as given.
    const root = catalog(s.pdf)
    if (lang) root.put('Lang', s.pdf.newString(lang))
    else root.delete('Lang')
    s.documentChanged()
  }),

  close(s) {
    s.closeDocument()
    s.password = null
    // The engine's certificate keys stay (Session.certificateKeys): they end with the worker.
    s.pendingCertificate = null
  }
})

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}
