import { readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { pemToDer } from '../lib/der.mjs'
import { encryptPubSecInPlace } from '../lib/encrypt-inplace.mjs'
import { encryptPubSecSeeded } from '../lib/encrypt-seeded.mjs'
const here = new URL('..', import.meta.url).pathname
const groups = [{ certs: [pemToDer(readFileSync(`${here}/keys/r1.crt`, 'utf8'))] }]
const src = new mupdf.PDFDocument(readFileSync(`${here}/fixtures/gen2.pdf`))
console.log('source text:', JSON.stringify(src.loadPage(0).toStructuredText().asText().trim()))
for (const norm of ['garbage=yes', 'garbage=compact']) {
  const saved = Buffer.from(src.saveToBuffer(norm).asUint8Array()).toString('latin1')
  console.log(norm, 'full save keeps gen>0 refs:', /\d+ [1-9]\d* R/.test(saved), '| obj headers with gen>0:', (saved.match(/\n\d+ [1-9]\d* obj/g) || []).length)
}
for (const [name, fn] of [['A2', () => encryptPubSecSeeded(mupdf, src, groups)], ['B', () => encryptPubSecInPlace(mupdf, src, groups)]]) {
  const res = await fn()
  writeFileSync(`${here}/out/gen2.${name}.r1.pdf`, res.bytes)
  console.log(name, 'ok', res.bytes.length)
}
