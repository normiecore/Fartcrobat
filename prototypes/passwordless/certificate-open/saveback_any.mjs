// Open a third-party-layout PubSec file through the append bridge, add a note, save it back
// certificate-encrypted with the same file key and the original /Recipients (approach B).
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { readPubSec, unwrapSeed, fileKey, forgeDecrypter, bridgeV5 } from './bridge-append.mjs'
import { pemToDer } from '../create/lib/der.mjs'
import { encryptObjectsInPlace, serialise } from '../create/lib/encrypt-inplace.mjs'
import { pubsecEncryptDict } from '../create/lib/pubsec.mjs'
const [certPath, keyPath, input, output] = process.argv.slice(2)
const cert = pemToDer(readFileSync(certPath, 'utf8'))
const dec = forgeDecrypter(readFileSync(keyPath, 'utf8'))
const bytes = readFileSync(input)
const info = readPubSec(bytes)
const K = fileKey(info, unwrapSeed(info.recipients, cert, dec).seed)
const { bytes: bridged, password } = await bridgeV5(bytes, info, K)
const doc = new mupdf.PDFDocument(bridged)
doc.authenticatePassword(password)
const note = doc.loadPage(0).createAnnotation('Text')
note.setRect([100, 100, 120, 120]); note.setContents('Added after a bridged open'); note.update()
// The app's saveDocument: plain save on a copy, authenticate the copy, decrypting save.
const copy = new mupdf.PDFDocument(doc.saveToBuffer('garbage=yes').asUint8Array().slice())
copy.authenticatePassword(password)
const plain = new mupdf.PDFDocument(copy.saveToBuffer('garbage=compact,encrypt=none').asUint8Array().slice())
await encryptObjectsInPlace(plain, new Uint8Array(K))
const out = serialise(plain, pubsecEncryptDict(info.recipients, info.encryptMetadata))
writeFileSync(output, out)
// Reopen with the bridge.
const info2 = readPubSec(Buffer.from(out))
const K2 = fileKey(info2, unwrapSeed(info2.recipients, cert, dec).seed)
const re = await bridgeV5(Buffer.from(out), info2, K2)
const d2 = new mupdf.PDFDocument(re.bytes); d2.authenticatePassword(re.password)
const p = d2.loadPage(0)
console.log('same K:', Buffer.compare(K, K2) === 0, '| /Filter/Standard left in output:', Buffer.from(out).includes('/Filter/Standard'),
  '| plaintext note in output:', Buffer.from(out).includes('Added after a bridged open'),
  '| reopened annots:', JSON.stringify(p.getAnnotations().map((a) => a.getContents())), '| title:', d2.getMetaData('info:Title'))
