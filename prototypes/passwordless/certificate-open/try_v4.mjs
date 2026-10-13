import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { readPubSec, unwrapSeed, fileKey, forgeDecrypter } from './bridge-append.mjs'
import { neutralise, decryptAll } from './bridge-v4.mjs'
import { pemToDer } from '../create/lib/der.mjs'
import { encryptObjectsInPlace, serialise } from '../create/lib/encrypt-inplace.mjs'
import { pubsecEncryptDict } from '../create/lib/pubsec.mjs'
const [certPath, keyPath, ...files] = process.argv.slice(2)
const cert = pemToDer(readFileSync(certPath, 'utf8'))
const dec = forgeDecrypter(readFileSync(keyPath, 'utf8'))
for (const f of files) {
  const bytes = readFileSync(f)
  const t0 = performance.now()
  const info = readPubSec(bytes)
  const K = fileKey(info, unwrapSeed(info.recipients, cert, dec).seed)
  const doc = new mupdf.PDFDocument(neutralise(bytes, info))
  const stats = decryptAll(mupdf, doc, bytes, info, K)
  const p = doc.loadPage(0)
  const text = p.toStructuredText().asText().trim()
  console.log(f.split('/').pop(), `V${info.V} ${info.cfm}`, JSON.stringify(stats), 'needsPassword=' + doc.needsPassword(), 'text=' + JSON.stringify(text),
    'annots=' + JSON.stringify(p.getAnnotations().map((a) => a.getContents())), 'title=' + JSON.stringify(doc.getMetaData('info:Title')), 'repaired=' + doc.wasRepaired(), (performance.now() - t0).toFixed(0) + 'ms')
  // Save back as V5 with the same seed and envelopes: K5 = SHA-256(seed || recipients).
  const K5 = fileKey({ ...info, V: 5 }, unwrapSeed(info.recipients, cert, dec).seed)
  const plain = new mupdf.PDFDocument(doc.saveToBuffer('garbage=compact').asUint8Array().slice())
  await encryptObjectsInPlace(plain, new Uint8Array(K5))
  const out = f.replace(/\.pdf$/, '.savedV5.pdf').replace('/out/', '/out/saved/')
  writeFileSync(out, serialise(plain, pubsecEncryptDict(info.recipients, info.encryptMetadata)))
}
