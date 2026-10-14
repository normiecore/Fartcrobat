// Approach B, "encrypt in place": encrypt every string and stream of a working copy ourselves
// (AES-256-CBC, random IV, file key K), then serialise the file ourselves with the PubSec
// /Encrypt dictionary. MuPDF is used to normalise the copy and to read/write objects; it never
// sees the key.
//
// Why our own serialiser: saveToBuffer() of a document MuPDF did not open as encrypted writes a
// trailer /Encrypt we add as "/Encrypt 0 0 R" (a broken reference), and any compress/objstms
// option would recompress or pack already-encrypted data. Writing objects with toString() and
// readRawStream() keeps every byte we produced.
import { hex, pdfAesEncryptor, randomBytes, toLatin1 } from './crypto.mjs'
import { writePdf } from './pdfbytes.mjs'
import { newPubSecKey } from './pubsec.mjs'

const isName = (o, n) => o.isName() && o.asName() === n

/** The raw (still filtered) bytes of a stream, copied out of WASM memory. */
function rawStream(ref) {
  const b = ref.readRawStream()
  const out = b.asUint8Array().slice()
  b.destroy()
  return out
}

function filterHasCrypt(dict) {
  const f = dict.get('Filter')
  if (f.isName()) return f.asName() === 'Crypt'
  if (f.isArray()) {
    for (let i = 0; i < f.length; i++) if (isName(f.get(i), 'Crypt')) return true
  }
  return false
}

/** Signature and document timestamp dictionaries: their /Contents is never encrypted. */
function isSignatureDict(d) {
  const type = d.get('Type')
  if (isName(type, 'Sig') || isName(type, 'DocTimeStamp')) return true
  return !d.get('ByteRange').isNull() && !d.get('Contents').isNull() && !d.get('Filter').isNull()
}

/**
 * Collects the direct strings of `obj` (recursing into direct arrays and dictionaries only;
 * indirect objects are visited by the main loop) as [container, key, bytes].
 */
function collectStrings(obj, out) {
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

export async function encryptObjectsInPlace(doc, fileKey, { encryptMetadata = true } = {}) {
  const enc = await pdfAesEncryptor(fileKey)
  const stats = { strings: 0, streams: 0, skippedStreams: 0, objects: 0 }
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
    // isStream() must be asked of the reference: a resolved stream is just its dictionary.
    if (ref.isStream()) {
      const type = obj.get('Type')
      if (isName(type, 'XRef') || isName(type, 'ObjStm')) throw new Error('normalise the document first (object streams left)')
      const plainMetadata = !encryptMetadata && isName(type, 'Metadata')
      if (plainMetadata || filterHasCrypt(obj)) stats.skippedStreams++
      else {
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

/** Writes every object of `doc` as is (raw stream bytes), plus `encryptDict` as the last object. */
export function serialise(doc, encryptDict) {
  const n = doc.countObjects()
  const objects = [undefined]
  for (let i = 1; i < n; i++) {
    const ref = doc.newIndirect(i)
    const obj = ref.resolve()
    if (obj.isNull()) {
      objects.push(undefined)
      continue
    }
    if (ref.isStream()) {
      const raw = rawStream(ref)
      obj.put('Length', raw.length)
      objects.push({ dict: obj.toString(true, true), stream: raw })
    } else {
      objects.push({ body: obj.toString(true, true) })
    }
  }
  objects.push({ body: encryptDict })
  const trailer = doc.getTrailer()
  const root = trailer.get('Root').toString()
  const info = trailer.get('Info')
  const oldId = trailer.get('ID')
  const id0 = oldId.isArray() && oldId.length === 2 ? hex(oldId.get(0).asByteString()) : hex(randomBytes(16))
  const v = doc.getVersion()
  return writePdf({
    version: v >= 20 ? '2.0' : '1.7',
    objects,
    trailer:
      `<</Size ${objects.length}/Root ${root}${info.isNull() ? '' : `/Info ${info.toString()}`}` +
      `/Encrypt ${objects.length - 1} 0 R/ID[<${id0}><${hex(randomBytes(16))}>]>>`
  })
}

/**
 * Encrypts `src` (an open, unencrypted MuPDF PDFDocument; it is not modified) to the recipient
 * groups and returns the bytes of the certificate-encrypted file.
 */
export async function encryptPubSecInPlace(mupdf, src, groups, opts = {}) {
  const { encryptMetadata = true, normalise = 'garbage=compact' } = opts
  const t0 = performance.now()
  const key = await newPubSecKey(groups, { encryptMetadata })
  const t1 = performance.now()
  // A working copy from a full save: dense object numbers, generation 0, no object streams,
  // no xref streams, no earlier revisions (which would otherwise keep plaintext in the file).
  // A password-encrypted source is decrypted on a first copy: "encrypt=none" on the live
  // document would rewrite its trailer.
  let buf
  if (src.getTrailer().get('Encrypt').isNull()) {
    buf = src.saveToBuffer(normalise)
  } else {
    const first = src.saveToBuffer('garbage=yes')
    const copy = new mupdf.PDFDocument(first)
    first.destroy()
    try {
      if (copy.needsPassword() && !(opts.password && copy.authenticatePassword(opts.password))) {
        throw new Error('the password of the source document is needed')
      }
      buf = copy.saveToBuffer(`${normalise},encrypt=none`)
    } finally {
      copy.destroy()
    }
  }
  const doc = new mupdf.PDFDocument(buf)
  buf.destroy()
  try {
    const t2 = performance.now()
    const stats = await encryptObjectsInPlace(doc, key.fileKey, { encryptMetadata })
    const t3 = performance.now()
    const bytes = serialise(doc, key.encryptDict)
    const t4 = performance.now()
    return { bytes, key, stats, timings: { keys: t1 - t0, normalise: t2 - t1, encrypt: t3 - t2, serialise: t4 - t3 } }
  } finally {
    doc.destroy()
  }
}

export { toLatin1 }
