// Open bridge for V2/V4 (RC4 or AES-128) /Adobe.PubSec files. MuPDF's Standard handler derives
// the R2-R4 file key from the password, so a chosen key cannot be wrapped as with R6. Instead:
// append an update whose trailer has no /Encrypt (MuPDF then opens the file as unencrypted, with
// strings and streams still holding ciphertext) and decrypt every string and stream ourselves
// through MuPDF's own parser. Object streams are decrypted first, before anything inside them
// is loaded.
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto'
import { appendUpdate } from './bridge-append.mjs'
import { parseValue, latin } from './pdflex.mjs'

function rc4(key, data) {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i)
  for (let i = 0, j = 0; i < 256; i++) { j = (j + s[i] + key[i % key.length]) & 255; [s[i], s[j]] = [s[j], s[i]] }
  const out = new Uint8Array(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255; j = (j + s[i]) & 255; [s[i], s[j]] = [s[j], s[i]]
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}
function objectKey(K, num, gen, aes) {
  const h = createHash('md5').update(K).update(Buffer.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]))
  if (aes) h.update('sAlT')
  return h.digest().subarray(0, Math.min(K.length + 5, 16))
}
function decryptBytes(K, num, gen, aes, data) {
  const key = objectKey(K, num, gen, aes)
  if (!aes) return rc4(key, data)
  if (data.length < 32 || data.length % 16) return data.length === 0 ? data : (() => { throw new Error(`bad AES data in ${num} ${gen}`) })()
  const d = createDecipheriv('aes-128-cbc', key, data.subarray(0, 16))
  return Buffer.concat([d.update(data.subarray(16)), d.final()])
}

/** Top-level object headers and the object streams among them, from the raw bytes. */
function topLevelObjects(bytes) {
  const text = latin(bytes)
  const found = new Map()
  for (const m of text.matchAll(/(?:^|[\s>\]])(\d+)\s+(\d+)\s+obj\b/g)) {
    const num = Number(m[1]), gen = Number(m[2])
    let dict = null
    try { const [v] = parseValue(bytes, m.index + m[0].length); if (v instanceof Map) dict = v } catch {}
    found.set(num, { gen, objstm: dict?.get('Type')?.name === 'ObjStm', xref: dict?.get('Type')?.name === 'XRef' })
  }
  return found
}

export function neutralise(bytes, info) {
  return appendUpdate(bytes, info, [], { Encrypt: undefined })
}

export function decryptAll(mupdf, doc, bytes, info, K) {
  const aes = info.cfm === 'AESV2'
  const top = topLevelObjects(bytes)
  const skip = new Set(info.encryptRef ? [info.encryptRef[0]] : [])
  const inObjStm = new Set()
  const stats = { objstm: 0, streams: 0, strings: 0 }
  // 1. Object streams first.
  for (const [num, t] of top) {
    if (!t.objstm) continue
    const ref = doc.newIndirect(num, t.gen)
    ref.writeRawStream(decryptBytes(K, num, t.gen, aes, ref.readRawStream().asUint8Array().slice()))
    const decoded = ref.readStream().asUint8Array().slice()
    const n = ref.resolve().get('N').asNumber()
    let i = 0
    for (let k = 0; k < n; k++) { const [a, j] = parseValue(decoded, i); const [, j2] = parseValue(decoded, j); inObjStm.add(a); i = j2 }
    stats.objstm++
  }
  // 2. Strings and streams of every other top-level object.
  const walk = (obj, num, gen, parentKey, parent) => {
    if (obj.isIndirect()) return
    if (obj.isString()) {
      parent.put(parentKey, doc.newByteString(decryptBytes(K, num, gen, aes, obj.asByteString())))
      stats.strings++
    } else if (obj.isArray()) {
      for (let i = 0; i < obj.length; i++) walk(obj.get(i), num, gen, i, obj)
    } else if (obj.isDictionary()) {
      const isSig = obj.get('Type').isName() && ['Sig', 'DocTimeStamp'].includes(obj.get('Type').asName())
      obj.forEach((v, k) => { if (!(isSig && k === 'Contents')) walk(v, num, gen, k, obj) })
    }
  }
  for (const [num, t] of top) {
    if (skip.has(num) || inObjStm.has(num) || t.objstm || t.xref) continue
    const ref = doc.newIndirect(num, t.gen)
    const obj = ref.resolve()
    if (ref.isStream()) {
      const isMeta = obj.get('Type').isName() && obj.get('Type').asName() === 'Metadata'
      if (!(isMeta && !info.encryptMetadata)) {
        ref.writeRawStream(decryptBytes(K, num, t.gen, aes, ref.readRawStream().asUint8Array().slice()))
        stats.streams++
      }
    }
    walk(obj, num, t.gen, null, null)
  }
  return stats
}
