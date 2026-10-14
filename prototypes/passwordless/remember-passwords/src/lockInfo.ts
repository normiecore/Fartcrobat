/**
 * Facts about a PDF's security handler that can be read BEFORE the password is known, used to
 * find a password saved on this device. Runs in the engine worker (MuPDF); no hashing here: the
 * main process derives the lookup keys (keys.ts) with node:crypto.
 *
 * Port target: src/engine/util/lockInfo.ts (engine) + `lock` on the needsPassword OpenResult.
 */
import type * as MuPDF from 'mupdf'

type PDFDocument = MuPDF.PDFDocument
type PDFObject = MuPDF.PDFObject

export interface LockInfo {
  /** /Filter of the /Encrypt dictionary ('Standard', 'Adobe.PubSec'...). */
  handler: string
  /** Hex of the first element of the trailer /ID (the file's permanent identifier); null when missing or empty. */
  id: string | null
  /**
   * Canonical text of everything the password check depends on: handler, V, R, P, Length and the
   * O, U, OE, UE and Perms strings (plus /ID[0] for R <= 4, which feeds the key derivation). Two
   * files with the same `security` accept exactly the same passwords. Changes whenever the
   * password (or, for AES-256, the random salts) changes.
   */
  security: string
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

function bytesOf(o: PDFObject | null | undefined): Uint8Array | null {
  try {
    if (!o || !o.isString()) return null
    return o.asByteString()
  } catch {
    return null
  }
}

function numOf(o: PDFObject | null | undefined): number | null {
  try {
    return o && o.isNumber() ? o.asNumber() : null
  } catch {
    return null
  }
}

function nameOf(o: PDFObject | null | undefined): string | null {
  try {
    return o && o.isName() ? o.asName() : null
  } catch {
    return null
  }
}

/** First element of the trailer /ID as hex, readable without the password (strings in /ID are never encrypted). */
export function readFileId(doc: PDFDocument): string | null {
  try {
    const id = doc.getTrailer().get('ID')
    if (!id || !id.isArray() || id.length < 1) return null
    const first = bytesOf(id.get(0))
    return first && first.length ? hex(first) : null
  } catch {
    return null
  }
}

/** Lock facts of an encrypted PDF; null when the document has no /Encrypt dictionary. */
export function readLockInfo(doc: PDFDocument): LockInfo | null {
  let enc: PDFObject
  try {
    enc = doc.getTrailer().get('Encrypt').resolve()
    if (!enc.isDictionary()) return null
  } catch {
    return null
  }
  const handler = nameOf(enc.get('Filter')) ?? 'Standard'
  const id = readFileId(doc)
  const parts: string[] = [`Filter=${handler}`]
  const sub = nameOf(enc.get('SubFilter'))
  if (sub) parts.push(`SubFilter=${sub}`)
  for (const k of ['V', 'R', 'P', 'Length']) {
    const n = numOf(enc.get(k))
    if (n !== null) parts.push(`${k}=${n | 0}`)
  }
  for (const k of ['O', 'U', 'OE', 'UE', 'Perms']) {
    const b = bytesOf(enc.get(k))
    if (b) parts.push(`${k}=${hex(b)}`)
  }
  const r = numOf(enc.get('R')) ?? 0
  // Revisions 2-4 mix /ID[0] into the file key and the /U check value.
  if (handler === 'Standard' && r <= 4) parts.push(`ID0=${id ?? ''}`)
  if (handler !== 'Standard') {
    // Public-key handlers: the recipient list identifies the lock (no password is involved).
    const recips = recipientsOf(enc)
    if (recips.length) parts.push(`Recipients=${recips.map(hex).join('+')}`)
  }
  return { handler, id, security: parts.join(';') }
}

function recipientsOf(enc: PDFObject): Uint8Array[] {
  const out: Uint8Array[] = []
  const take = (arr: PDFObject | null | undefined) => {
    try {
      if (!arr || !arr.isArray()) return
      for (let i = 0; i < arr.length; i++) {
        const b = bytesOf(arr.get(i))
        if (b) out.push(b)
      }
    } catch {}
  }
  take(enc.get('Recipients'))
  try {
    const cf = enc.get('CF')
    if (cf && cf.isDictionary()) cf.forEach((v) => take(v.resolve().get('Recipients')))
  } catch {}
  return out
}
