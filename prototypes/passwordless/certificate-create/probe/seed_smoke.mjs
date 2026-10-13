import { readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { keyedSeedDocument, openSeed, encryptPubSecSeeded } from '../lib/encrypt-seeded.mjs'
import { randomBytes } from '../lib/crypto.mjs'
import { oneTimePassword } from '../lib/standard.mjs'
import { pemToDer } from '../lib/der.mjs'
mupdf.setLog?.({ warning: (m) => console.log('[mupdf warning]', m), error: (m) => console.log('[mupdf error]', m) })
const K = randomBytes(32), pw = oneTimePassword()
let t = performance.now()
const seed = await keyedSeedDocument(K, pw)
console.log('seed doc', seed.length, 'bytes in', (performance.now() - t).toFixed(1), 'ms')
writeFileSync('out/seed-smoke.pdf', seed)
const d = openSeed(mupdf, seed, pw)
console.log('opened; pages', d.countPages(), 'encryption', d.getMetaData('encryption'))
console.log('page text', JSON.stringify(d.loadPage(0).toStructuredText().asText()))
const src = new mupdf.PDFDocument(readFileSync('/home/user/Fartcrobat/tests/fixtures/text.pdf'))
const r1 = pemToDer(readFileSync('keys/r1.crt', 'utf8'))
const res = await encryptPubSecSeeded(mupdf, src, [{ certs: [r1] }])
writeFileSync('out/smoke-A.pdf', res.bytes)
console.log('A out', res.bytes.length, res.timings)
