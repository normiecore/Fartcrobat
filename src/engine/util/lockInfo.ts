/**
 * Facts about a PDF's security handler that can be read before the password is known, used to find
 * a password saved on this device. No hashing here: the main process derives the lookup keys.
 */
import type { LockInfo, PasswordAccess } from '@shared/types'
import type { PDFDocument, PDFObject } from '../session'

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

// asByteString, not asString: asString decodes text and mangles a binary /ID.
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

/** First element of the trailer /ID as hex (strings in /ID are never encrypted). */
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

/** Lock facts of an encrypted PDF; null when it has no /Encrypt dictionary. */
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
  // Revisions 2 to 4 mix /ID[0] into the file key and the /U check value.
  if (handler === 'Standard' && r <= 4) parts.push(`ID0=${id ?? ''}`)
  if (handler !== 'Standard') {
    // Public-key handlers: the recipient list identifies the lock (no password is involved).
    const recipients = recipientsOf(enc)
    if (recipients.length) parts.push(`Recipients=${recipients.map(hex).join('+')}`)
  }
  return { handler, id, security: parts.join(';') }
}

/** The access an authenticatePassword() result gives (2: user password, 4: owner password). */
export function accessOf(auth: number): PasswordAccess | null {
  return auth & 4 ? 'owner' : auth & 2 ? 'user' : null
}
