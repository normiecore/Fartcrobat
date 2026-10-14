/**
 * Keeps a protected document's security on files made from it (Extract, Split, Combine, Compare
 * report). The new file gets the source's encryption dictionary and file ID, so it has the same
 * method, permission flags, open password and permissions password, and nobody needs to know
 * either password: the session only has to be able to open the source, which it already did.
 */
import { EngineError } from '../define'
import type { Mupdf, PDFDocument, Session } from '../session'
import { isNull } from './pdf'

/** What the person is told about a protected output. Never holds a password. */
export interface ProtectionSummary {
  /** "256-bit AES", "128-bit AES", "128-bit RC4"... */
  method: string
  /** Opening the file needs a password. */
  needsPassword: boolean
  /** The file restricts printing, changing, copying, commenting, forms or pages. */
  restricted: boolean
  /**
   * Certificate security: the file opens with the same certificates as its source (same envelopes),
   * not with a password. `needsPassword` is then false.
   */
  certificate?: boolean
}

/**
 * The security of a protected document, ready to put on new files: a small PDF with no pages that
 * has the same encryption dictionary and file ID, and the password it was opened with (null when
 * none is needed).
 */
export interface Protection {
  template: Uint8Array
  password: string | null
  summary: ProtectionSummary
}

/** Options of saved outputs (as Extract and Combine always used). */
export const OUTPUT_SAVE_OPTIONS = 'garbage=compact,compress'

const SESSION_KEY = 'protection:template'

function takeBuffer(buf: InstanceType<Mupdf['Buffer']>): Uint8Array {
  try {
    return buf.asUint8Array().slice()
  } finally {
    buf.destroy()
  }
}

export function isEncrypted(doc: PDFDocument): boolean {
  try {
    const e = doc.getMetaData('encryption')
    return !!e && e !== 'None'
  } catch {
    return false
  }
}

/** "Standard V5 R6 256-bit AES" -> "256-bit AES". */
export function methodLabel(raw: string): string {
  const m = /(\d+)-bit\s+(AES|RC4)/i.exec(raw)
  return m ? `${m[1]}-bit ${m[2].toUpperCase()}` : raw.replace(/^Standard\s+/i, '')
}

/** True when the /P flags of the encryption dictionary deny any of the everyday permissions. */
function restrictsAnything(doc: PDFDocument): boolean {
  try {
    const enc = doc.getTrailer().get('Encrypt').resolve()
    const p = enc.get('P')
    if (isNull(p)) return false
    const bits = p.asNumber() | 0
    // print 3, modify 4, copy 5, annotate 6; from revision 3 also fill forms 9 and assemble 11
    // (ISO 32000-1, table 22).
    const flags =
      (isNull(enc.get('R')) ? 2 : enc.get('R').asNumber()) >= 3 ? [3, 4, 5, 6, 9, 11] : [3, 4, 5, 6]
    return flags.some((bit) => (bits & (1 << (bit - 1))) === 0)
  } catch {
    return false
  }
}

/**
 * The protection of a PDF file opened from `bytes` with `password`, or null when it is not
 * encrypted. Throws when the password does not open it.
 */
export function protectionOfFile(m: Mupdf, bytes: Uint8Array, password: string | null): Protection | null {
  const doc = new m.PDFDocument(bytes)
  try {
    if (!isEncrypted(doc)) return null
    const needsPassword = doc.needsPassword()
    if (needsPassword && !(password !== null && doc.authenticatePassword(password))) {
      throw new EngineError(
        'The protected file could not be opened again: its password is not known',
        'ENCRYPTED'
      )
    }
    const summary: ProtectionSummary = {
      method: methodLabel(doc.getMetaData('encryption') ?? ''),
      needsPassword,
      restricted: restrictsAnything(doc)
    }
    // Everything but the trailer's /Encrypt and /ID becomes garbage, so the template is tiny and
    // cheap to open for every output.
    const root = doc.addObject(doc.newDictionary())
    root.put('Type', doc.newName('Catalog'))
    const pages = doc.addObject(doc.newDictionary())
    pages.put('Type', doc.newName('Pages'))
    pages.put('Kids', doc.newArray())
    pages.put('Count', 0)
    root.put('Pages', pages)
    // Fetched after adding objects: MuPDF may move the trailer into a new xref section.
    const trailer = doc.getTrailer()
    trailer.put('Root', root)
    trailer.delete('Info')
    const template = takeBuffer(doc.saveToBuffer(OUTPUT_SAVE_OPTIONS))
    return { template, password: needsPassword ? password : null, summary }
  } finally {
    doc.destroy()
  }
}

/** The protection of the session's document, or null when it is not encrypted. */
export function sessionProtection(s: Session): Protection | null {
  if (!isEncrypted(s.pdf)) return null
  // Security only changes by reopening the document, which clears s.state.
  const cached = s.state.get(SESSION_KEY) as
    { source: Uint8Array | null; password: string | null; value: Protection } | undefined
  if (cached && cached.source === s.sourceBytes && cached.password === s.password) return cached.value
  // A plain save keeps the current encryption; only needed when there are no source bytes.
  const source = s.sourceBytes ?? takeBuffer(s.pdf.saveToBuffer('garbage=yes'))
  const value = protectionOfFile(s.mupdf, source, s.password)
  if (!value) return null
  s.state.set(SESSION_KEY, { source: s.sourceBytes, password: s.password, value })
  return value
}

/**
 * Opens the template, authenticated. MuPDF tries the empty password while opening, and each try
 * costs a key derivation (slow for 256-bit AES), so the password is only tried when one is needed.
 */
function openTemplate(m: Mupdf, protection: Protection): PDFDocument {
  const doc = new m.PDFDocument(protection.template)
  if (protection.summary.needsPassword && !doc.authenticatePassword(protection.password ?? '')) {
    doc.destroy()
    throw new EngineError(
      'The protected file could not be opened again: its password is not known',
      'ENCRYPTED'
    )
  }
  return doc
}

/** Saves the content of `doc` (everything its catalog and info dictionary reach) with the security of `out`. */
function saveInto(out: PDFDocument, doc: PDFDocument, options: string): InstanceType<Mupdf['Buffer']> {
  const map = out.newGraftMap()
  const src = doc.getTrailer()
  const root = map.graftObject(src.get('Root'))
  const info = isNull(src.get('Info')) ? null : map.graftObject(src.get('Info'))
  // Fetched after grafting, for the same reason as in protectionOfFile.
  const trailer = out.getTrailer()
  trailer.put('Root', root.isIndirect() ? root : out.addObject(root))
  if (info) trailer.put('Info', info.isIndirect() ? info : out.addObject(info))
  else trailer.delete('Info')
  return out.saveToBuffer(options)
}

/**
 * Saves `doc` as a new file. With `protection`, the file gets that security: the content of `doc`
 * goes into a copy of the template, whose encryption MuPDF keeps when saving. `doc` is unchanged.
 */
export function saveWithProtection(
  m: Mupdf,
  doc: PDFDocument,
  protection: Protection | null,
  options = OUTPUT_SAVE_OPTIONS
): Uint8Array {
  if (!protection) return takeBuffer(doc.saveToBuffer(options))
  const out = openTemplate(m, protection)
  let bytes: Uint8Array
  try {
    bytes = takeBuffer(saveInto(out, doc, options))
  } finally {
    out.destroy()
  }
  verify(m, bytes, protection, doc.countPages())
  return bytes
}

/** Re-saves PDF bytes with `protection` (unchanged when null). */
export function protectBytes(m: Mupdf, bytes: Uint8Array, protection: Protection | null): Uint8Array {
  if (!protection) return bytes
  const doc = new m.PDFDocument(bytes)
  try {
    return saveWithProtection(m, doc, protection)
  } finally {
    doc.destroy()
  }
}

/**
 * Measures the size documents would have when saved with `protection` (Split by file size makes
 * many measurements): the template is opened once and reused. Call `destroy` when done.
 */
export function outputSizer(
  m: Mupdf,
  protection: Protection | null
): { size(doc: PDFDocument): number; destroy(): void } {
  let out: PDFDocument | null = null
  return {
    size(doc) {
      let buf: InstanceType<Mupdf['Buffer']>
      if (!protection) buf = doc.saveToBuffer(OUTPUT_SAVE_OPTIONS)
      else {
        out ??= openTemplate(m, protection)
        // Saving with garbage collection also drops the previous measurement from `out`.
        buf = saveInto(out, doc, OUTPUT_SAVE_OPTIONS)
      }
      try {
        return buf.getLength()
      } finally {
        buf.destroy()
      }
    },
    destroy() {
      out?.destroy()
      out = null
    }
  }
}

/** A protected output that does not open like its source must never reach the disk or a tab. */
function verify(m: Mupdf, bytes: Uint8Array, protection: Protection, pageCount: number) {
  let doc: PDFDocument | null = null
  try {
    // The encryption dictionary is copied as it is, so it opens with the same passwords as the
    // source; check that it does, and that the content is there.
    doc = new m.PDFDocument(bytes)
    if (!isEncrypted(doc)) throw new Error('not encrypted')
    if (protection.summary.needsPassword && !doc.authenticatePassword(protection.password ?? ''))
      throw new Error('cannot authenticate')
    if (doc.countPages() !== pageCount) throw new Error('pages missing')
  } catch (err) {
    throw new EngineError(
      `Could not keep the password protection on the new file (${(err as Error).message})`,
      'PROTECT_FAILED'
    )
  } finally {
    doc?.destroy()
  }
}
