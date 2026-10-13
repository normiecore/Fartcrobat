import { readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { pemToDer } from '../lib/der.mjs'
import { encryptPubSecInPlace } from '../lib/encrypt-inplace.mjs'
import { encryptPubSecSeeded } from '../lib/encrypt-seeded.mjs'
const here = new URL('..', import.meta.url).pathname
const groups = [{ certs: [pemToDer(readFileSync(`${here}/keys/r1.crt`, 'utf8'))] }]
for (const [n, fn] of [['A2', encryptPubSecSeeded], ['B', encryptPubSecInPlace]]) {
  const src = new mupdf.PDFDocument(readFileSync(`${here}/fixtures/indirect-string.pdf`))
  writeFileSync(`${here}/out/indirect.${n}.r1.pdf`, (await fn(mupdf, src, groups)).bytes)
}
