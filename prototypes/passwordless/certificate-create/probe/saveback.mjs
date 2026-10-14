// Save-back of an opened certificate-encrypted file after an edit, both ways:
//   A-style: MuPDF saves with the bridged Standard dictionary (same K), then swap the PubSec one back
//   B-style: decrypting save on a copy, encrypt in place with the same K, serialise with the PubSec one
// The original envelopes are kept, so K (and every recipient's access) is unchanged.
import { readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { openPubSec } from '../lib/bridge.mjs'
import { pemToDer } from '../lib/der.mjs'
import { encryptObjectsInPlace, serialise } from '../lib/encrypt-inplace.mjs'
import { swapEncryptDict } from '../lib/encrypt-seeded.mjs'
import { pemKeyDecrypter } from '../lib/pubsec.mjs'
const here = new URL('..', import.meta.url).pathname
const key = (n) => [pemToDer(readFileSync(`${here}/keys/${n}.crt`, 'utf8')), pemKeyDecrypter(readFileSync(`${here}/keys/${n}.key`, 'utf8'))]
const input = new Uint8Array(readFileSync(`${here}/out/hiddeninfo.B.r1r2.pdf`))
const { doc, fileKey, dict } = await openPubSec(mupdf, input, ...key('r2'))
const pubsecDict = dict.text.replace(/^\d+ \d+ obj\s*/, '').replace(/\s*endobj$/, '')
const page = doc.loadPage(0)
const note = page.createAnnotation('Text')
note.setRect([100, 100, 120, 120])
note.setContents('Added by recipient two after opening')
note.update()
// A-style
let t = performance.now()
const a = swapEncryptDict(doc.saveToBuffer('garbage=compact').asUint8Array().slice(), pubsecDict)
console.log('A-style save-back', a.length, 'bytes', (performance.now() - t).toFixed(0), 'ms')
writeFileSync(`${here}/out/saveback.A.r1r2.pdf`, a)
// B-style
t = performance.now()
const plain = doc.saveToBuffer('garbage=compact,encrypt=none') // on the live doc only in this probe
const copy = new mupdf.PDFDocument(plain)
await encryptObjectsInPlace(copy, fileKey)
const b = serialise(copy, pubsecDict)
console.log('B-style save-back', b.length, 'bytes', (performance.now() - t).toFixed(0), 'ms')
writeFileSync(`${here}/out/saveback.B.r1r2.pdf`, b)
writeFileSync(`${here}/fixtures/saveback-expected.pdf`, plain.asUint8Array())
