// Writing certificate-encrypted files (approach B, "encrypt in place"): take a plain working copy
// of the document, encrypt every string and stream with the file key ourselves, and serialise it
// with the PubSec /Encrypt dictionary. Used both to create a certificate-encrypted file and to save
// one back after editing (same envelopes, same file key).
// Proposed home: src/features/protect-optimize/pubsecWrite.ts, called from saveDocument
// (src/engine/ops/doc.ts) when the session has PubSec security or the save asks for it.
import type * as MuPDF from 'mupdf'
import { pdfAesEncryptor, randomBytes, toHex } from './pdfCrypto'
import { writePdf, type WrittenObject } from './pdfWriter'
import { pubsecEncryptDict, type PubSecKey } from './pubsec'

type Mupdf = typeof MuPDF
type PDFDocument = MuPDF.PDFDocument
type PDFObject = MuPDF.PDFObject

const isName = (o: PDFObject, n: string) => o.isName() && o.asName() === n

function hasCryptFilter(dict: PDFObject): boolean {
  const f = dict.get('Filter')
  if (f.isName()) return f.asName() === 'Crypt'
  if (f.isArray()) for (let i = 0; i < f.length; i++) if (isName(f.get(i), 'Crypt')) return true
  return false
}

/** Signature and document timestamp dictionaries: their /Contents stays unencrypted. */
function isSignatureDict(d: PDFObject): boolean {
  if (isName(d.get('Type'), 'Sig') || isName(d.get('Type'), 'DocTimeStamp')) return true
  return !d.get('ByteRange').isNull() && !d.get('Contents').isNull() && !d.get('Filter').isNull()
}

/** Direct strings of `obj` (indirect objects are visited by the caller's loop). */
function collectStrings(obj: PDFObject, out: [PDFObject, string | number, Uint8Array][]) {
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

function rawStream(ref: PDFObject): Uint8Array {
  const b = ref.readRawStream()
  const out = b.asUint8Array().slice() // copy out of WASM memory before anything else allocates
  b.destroy()
  return out
}

export interface EncryptStats {
  objects: number
  strings: number
  streams: number
  skippedStreams: number
}

/**
 * Encrypts, in `doc` itself, every string and stream (raw, still-filtered bytes) with `fileKey`.
 * Exempt: signature /Contents, streams with their own /Crypt filter, and the XMP metadata stream
 * when `encryptMetadata` is false. `doc` must come from a plain full save with garbage=compact
 * (no object streams, no xref streams, generation numbers 0).
 */
export async function encryptObjectsInPlace(doc: PDFDocument, fileKey: Uint8Array, encryptMetadata = true): Promise<EncryptStats> {
  const enc = await pdfAesEncryptor(fileKey)
  const stats: EncryptStats = { objects: 0, strings: 0, streams: 0, skippedStreams: 0 }
  const n = doc.countObjects()
  for (let i = 1; i < n; i++) {
    const ref = doc.newIndirect(i)
    const obj = ref.resolve()
    if (obj.isNull()) continue
    stats.objects++
    if (obj.isString()) {
      ref.writeObject(doc.newByteString(await enc(obj.asByteString())))
      stats.strings++
      continue
    }
    // isStream() has to be asked of the reference: a resolved stream is just its dictionary.
    if (ref.isStream()) {
      const type = obj.get('Type')
      if (isName(type, 'XRef') || isName(type, 'ObjStm')) throw new Error('Object streams must be removed before encrypting')
      if ((!encryptMetadata && isName(type, 'Metadata')) || hasCryptFilter(obj)) {
        stats.skippedStreams++
      } else {
        ref.writeRawStream(await enc(rawStream(ref)))
        stats.streams++
      }
    }
    if (obj.isArray() || obj.isDictionary()) {
      for (const [container, key, bytes] of collectStrings(obj, [])) {
        container.put(key, doc.newByteString(await enc(bytes)))
        stats.strings++
      }
    }
  }
  return stats
}

/**
 * Writes `doc` object by object (raw stream bytes as they are, no recompression) and appends
 * `encryptDict` as the /Encrypt object. MuPDF's own save cannot be used here: for a document it
 * did not open as encrypted it writes an /Encrypt we add as "0 0 R", and its compression options
 * would recompress already-encrypted data.
 */
export function serialiseEncrypted(doc: PDFDocument, encryptDict: string): Uint8Array {
  const n = doc.countObjects()
  const objects: WrittenObject[] = [undefined]
  for (let i = 1; i < n; i++) {
    const ref = doc.newIndirect(i)
    const obj = ref.resolve()
    if (obj.isNull()) objects.push(undefined)
    else if (ref.isStream()) {
      const raw = rawStream(ref)
      obj.put('Length', raw.length)
      objects.push({ dict: obj.toString(true, true), stream: raw })
    } else objects.push({ body: obj.toString(true, true) })
  }
  objects.push({ body: encryptDict })
  const t = doc.getTrailer()
  const info = t.get('Info')
  const id = t.get('ID')
  const id0 = id.isArray() && id.length === 2 ? toHex(id.get(0).asByteString()) : toHex(randomBytes(16))
  const trailer =
    `<</Size ${objects.length}/Root ${t.get('Root').toString()}${info.isNull() ? '' : `/Info ${info.toString()}`}` +
    `/Encrypt ${objects.length - 1} 0 R/ID[<${id0}><${toHex(randomBytes(16))}>]>>`
  return writePdf(doc.getVersion() >= 20 ? '2.0' : '1.7', objects, trailer)
}

export interface PubSecWriteOptions {
  /** Password of `src` when it is (password) encrypted. */
  password?: string
  /** Save options for the plain pass, e.g. "compress,compress-images"; garbage=compact is added. */
  saveOptions?: string
}

/**
 * Returns the bytes of `src` encrypted with `key` (new: newPubSecKey; save-back: the key and
 * envelopes the file was opened with). `src` is not modified.
 */
export async function writePubSecDocument(mupdf: Mupdf, src: PDFDocument, key: PubSecKey, opts: PubSecWriteOptions = {}): Promise<Uint8Array> {
  const plainOptions = ['garbage=compact', opts.saveOptions].filter(Boolean).join(',')
  if (/objstms|linearize|incremental|encrypt=/.test(plainOptions)) throw new Error('Unsupported save option for certificate security')
  let plain: MuPDF.Buffer
  if (src.getTrailer().get('Encrypt').isNull()) {
    plain = src.saveToBuffer(plainOptions)
  } else {
    // "encrypt=none" on the live document would rewrite its trailer: decrypt on a copy.
    const first = src.saveToBuffer('garbage=yes')
    const copy = new mupdf.PDFDocument(first)
    first.destroy()
    try {
      if (copy.needsPassword() && !(opts.password && copy.authenticatePassword(opts.password))) {
        throw new Error('The document password is needed to change its security')
      }
      plain = copy.saveToBuffer(`${plainOptions},encrypt=none`)
    } finally {
      copy.destroy()
    }
  }
  const doc = new mupdf.PDFDocument(plain)
  plain.destroy()
  try {
    await encryptObjectsInPlace(doc, key.fileKey, key.encryptMetadata)
    return serialiseEncrypted(doc, pubsecEncryptDict(key.recipients, key.encryptMetadata))
  } finally {
    doc.destroy()
  }
}
