// Approach A, "keyed seed document": let MuPDF do all the encryption.
//
// 1. Make the PubSec key material (seed, recipient envelopes, file key K).
// 2. Hand-write a tiny PDF encrypted with a Standard V5/R6 handler that wraps K under a one-time
//    password, open it in MuPDF and authenticate: MuPDF now holds K as the document key.
// 3. Copy the real document into it.
// 4. Save keeping encryption: MuPDF encrypts every string and stream with K.
// 5. Replace the Standard /Encrypt dictionary by the PubSec one (same K, so everything still
//    decrypts) and fix up the cross-reference table.
//
// Step 5 is exactly what "save a PubSec file back" needs too (the open path bridges PubSec to a
// Standard R6 dictionary around the same K), so A shares its last step with the save-back path.
import { copyPages, removePageFields } from './app-graft.bundle.mjs'
import { concat, hex, latin1, pdfAesEncrypt, randomBytes, toLatin1 } from './crypto.mjs'
import { indexOfBytes, parseClassicXref, replaceObject, trailerValue, writePdf } from './pdfbytes.mjs'
import { newPubSecKey } from './pubsec.mjs'
import { oneTimePassword, standardR6Dict } from './standard.mjs'

const KEY_CHECK = 'Fartcrobat key check'

/**
 * A one-page PDF encrypted (Standard V5/R6) with `fileKey`, opened by `password`. Its Info
 * /Producer and its page content are encrypted with K, so a successful read proves MuPDF really
 * decrypts with K.
 */
export async function keyedSeedDocument(fileKey, password, { encryptMetadata = true, version = '1.7' } = {}) {
  const encrypt = await standardR6Dict(fileKey, password, { encryptMetadata })
  const content = await pdfAesEncrypt(fileKey, latin1('% seed page\n'))
  const producer = await pdfAesEncrypt(fileKey, latin1(KEY_CHECK))
  const id = hex(randomBytes(16))
  return writePdf({
    version,
    objects: [
      undefined,
      { body: '<</Type/Catalog/Pages 2 0 R>>' },
      { body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      { body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>' },
      { dict: `<</Length ${content.length}>>`, stream: content },
      { body: `<</Producer<${hex(producer)}>>>` },
      { body: encrypt }
    ],
    trailer: `<</Size 7/Root 1 0 R/Info 5 0 R/Encrypt 6 0 R/ID[<${id}><${id}>]>>`
  })
}

/** Opens the seed document in MuPDF and checks that MuPDF decrypts with our key. */
export function openSeed(mupdf, seedBytes, password) {
  const doc = new mupdf.PDFDocument(seedBytes)
  if (!doc.needsPassword()) throw new Error('seed document is not encrypted')
  if (!doc.authenticatePassword(password)) throw new Error('MuPDF did not accept the one-time password')
  const producer = doc.getMetaData('info:Producer')
  if (producer !== KEY_CHECK) throw new Error(`MuPDF decrypted the key check as ${JSON.stringify(producer)}`)
  return doc
}

// ---- copying the document in ------------------------------------------------------------------

/** A2: graft the whole catalog (and /Info): every object reachable from them, as is. */
export function copyWholeDocument(dst, src) {
  const map = dst.newGraftMap()
  const st = src.getTrailer()
  const root = map.graftObject(st.get('Root'))
  const info = st.get('Info').isNull() ? null : map.graftObject(st.get('Info'))
  // Fetch the trailer only now: the first new object makes MuPDF start a new xref section with
  // a copy of the trailer, and changes to a trailer fetched before that are lost on save.
  const dt = dst.getTrailer()
  dt.put('Root', root)
  if (info) dt.put('Info', info)
  else dt.delete('Info')
}

const CATALOG_KEYS = [
  'Outlines',
  'Names',
  'Dests',
  'StructTreeRoot',
  'MarkInfo',
  'Metadata',
  'PageLabels',
  'ViewerPreferences',
  'Lang',
  'OCProperties',
  'PageMode',
  'PageLayout',
  'OpenAction',
  'URI',
  'AF',
  'Collection',
  'Extensions'
]

/**
 * A1 (as the task describes it): copy the pages with the app's copyPages (annotations, links,
 * form fields), then the listed catalog entries with page references remapped to the copies,
 * then remove the seed page.
 */
export function copyByPages(dst, src) {
  const n = src.countPages()
  const pages = copyPages(dst, src, [...Array(n).keys()], -1)
  const pageMap = new Map()
  for (let i = 0; i < n; i++) pageMap.set(src.findPage(i).asIndirect(), pages[i])
  const map = dst.newGraftMap()
  const memo = new Map()
  const dcat = dst.getTrailer().get('Root')
  const scat = src.getTrailer().get('Root')
  for (const key of CATALOG_KEYS) {
    const v = scat.get(key)
    if (!v.isNull()) dcat.put(key, remapCopy(dst, map, pageMap, memo, v))
  }
  // Form-level entries copyPages does not take over (it merges DA, Q, DR, NeedAppearances).
  const sacro = scat.get('AcroForm')
  if (!sacro.isNull()) {
    const dacro = dcat.get('AcroForm')
    sacro.resolve().forEach((v, key) => {
      if (['Fields', 'DA', 'Q', 'DR', 'NeedAppearances'].includes(String(key))) return
      if (!dacro.isNull() && dacro.get(String(key)).isNull()) dacro.put(String(key), remapCopy(dst, map, pageMap, memo, v))
    })
  }
  const info = src.getTrailer().get('Info')
  const copied = info.isNull() ? null : map.graftObject(info)
  // the trailer is fetched after grafting, see copyWholeDocument; drop the seed's own /Info
  if (copied) dst.getTrailer().put('Info', copied)
  else dst.getTrailer().delete('Info')
  removePageFields(dst, dst.findPage(0))
  dst.deletePage(0)
}

/** Deep copy that maps references to source pages onto their copies (other pages become null). */
function remapCopy(dst, map, pageMap, memo, v) {
  if (v.isIndirect()) {
    const n = v.asIndirect()
    if (pageMap.has(n)) return pageMap.get(n)
    if (memo.has(n)) return memo.get(n)
    const r = v.resolve()
    if (v.isStream()) {
      const g = map.graftObject(v)
      memo.set(n, g)
      return g
    }
    if (r.isDictionary()) {
      const type = r.get('Type')
      if (type.isName() && (type.asName() === 'Page' || type.asName() === 'Pages')) return dst.newNull()
    }
    if (!r.isArray() && !r.isDictionary()) {
      const g = map.graftObject(v)
      memo.set(n, g)
      return g
    }
    const out = dst.addObject(r.isArray() ? dst.newArray() : dst.newDictionary())
    memo.set(n, out)
    fill(dst, map, pageMap, memo, r, out)
    return out
  }
  if (v.isArray() || v.isDictionary()) {
    const out = v.isArray() ? dst.newArray() : dst.newDictionary()
    fill(dst, map, pageMap, memo, v, out)
    return out
  }
  return map.graftObject(v)
}

function fill(dst, map, pageMap, memo, from, out) {
  if (from.isArray()) from.forEach((item) => out.push(remapCopy(dst, map, pageMap, memo, item)))
  else from.forEach((item, key) => out.put(String(key), remapCopy(dst, map, pageMap, memo, item)))
}

// ---- the whole operation ----------------------------------------------------------------------

/**
 * Encrypts `src` (an open, unencrypted MuPDF PDFDocument) to the recipient groups and returns
 * the bytes of the certificate-encrypted file.
 */
export async function encryptPubSecSeeded(mupdf, src, groups, opts = {}) {
  const { encryptMetadata = true, copy = 'catalog', saveOptions = 'garbage=compact,compress' } = opts
  const t0 = performance.now()
  const key = await newPubSecKey(groups, { encryptMetadata })
  const password = oneTimePassword()
  const version = src.getVersion() >= 20 ? '2.0' : '1.7'
  const seedBytes = await keyedSeedDocument(key.fileKey, password, { encryptMetadata, version })
  const t1 = performance.now()
  const doc = openSeed(mupdf, seedBytes, password)
  try {
    if (copy === 'catalog') copyWholeDocument(doc, src)
    else copyByPages(doc, src)
    const t2 = performance.now()
    const saved = doc.saveToBuffer(saveOptions)
    const bytes = saved.asUint8Array().slice()
    saved.destroy()
    const t3 = performance.now()
    const out = swapEncryptDict(bytes, key.encryptDict)
    const t4 = performance.now()
    return { bytes: out, key, timings: { keys: t1 - t0, copy: t2 - t1, save: t3 - t2, swap: t4 - t3 } }
  } finally {
    doc.destroy()
  }
}

/** Replaces the file's /Encrypt dictionary (MuPDF's Standard one) with `encryptDict`. */
export function swapEncryptDict(bytes, encryptDict) {
  const xref = parseClassicXref(bytes)
  const ref = trailerValue(xref.trailer, 'Encrypt')
  const num = Number(/^(\d+)\s+\d+\s+R$/.exec(ref ?? '')?.[1])
  if (!num) throw new Error('saved file has no /Encrypt reference')
  const out = replaceObject(bytes, num, encryptDict)
  // MuPDF writes the dictionary tight ("/Filter/Standard"); no copy of it may be left behind.
  if (indexOfBytes(out, latin1('/Filter/Standard')) >= 0) throw new Error('a Standard /Encrypt dictionary is still in the file')
  return out
}

export { concat }
