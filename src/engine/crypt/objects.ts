// What the decrypt pass (pubsecBridge.ts) and the encrypt pass (pubsecWrite.ts) both need to know
// about MuPDF objects: which strings and streams are exempt from encryption.
import type { PDFObject } from '../session'

export const isNamed = (o: PDFObject, name: string): boolean => o.isName() && o.asName() === name

/** The stream has its own /Crypt filter (ISO 32000-2, 7.4.10): the document's key does not apply. */
export function hasCryptFilter(dict: PDFObject): boolean {
  const f = dict.get('Filter')
  if (f.isName()) return f.asName() === 'Crypt'
  if (f.isArray()) for (let i = 0; i < f.length; i++) if (isNamed(f.get(i), 'Crypt')) return true
  return false
}

/** Signature and document timestamp dictionaries: their /Contents is never encrypted (7.6.2). */
export function isSignatureDict(d: PDFObject): boolean {
  if (isNamed(d.get('Type'), 'Sig') || isNamed(d.get('Type'), 'DocTimeStamp')) return true
  return !d.get('ByteRange').isNull() && !d.get('Contents').isNull() && !d.get('Filter').isNull()
}

/**
 * The direct strings of `obj` as [container, key, bytes], recursing into direct arrays and
 * dictionaries only (indirect objects are visited on their own). Empty strings are included.
 */
export function collectStrings(obj: PDFObject, out: [PDFObject, string | number, Uint8Array][] = []): [PDFObject, string | number, Uint8Array][] {
  const skipContents = obj.isDictionary() && isSignatureDict(obj)
  obj.forEach((v, key) => {
    if (v.isIndirect()) return
    if (v.isString()) {
      if (!(skipContents && key === 'Contents')) out.push([obj, key, v.asByteString()])
    } else if (v.isArray() || v.isDictionary()) {
      collectStrings(v, out)
    }
  })
  return out
}

/** The raw (still filtered) bytes of a stream, copied out of WASM memory. */
export function rawStream(ref: PDFObject): Uint8Array {
  const b = ref.readRawStream()
  try {
    return b.asUint8Array().slice()
  } finally {
    b.destroy()
  }
}
