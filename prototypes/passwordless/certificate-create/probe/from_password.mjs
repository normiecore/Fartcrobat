// Converting a password-protected document (open and authenticated) to certificate security.
import { readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { pemToDer } from '../lib/der.mjs'
import { encryptPubSecInPlace } from '../lib/encrypt-inplace.mjs'
import { encryptPubSecSeeded } from '../lib/encrypt-seeded.mjs'
const here = new URL('..', import.meta.url).pathname
const groups = [{ certs: [pemToDer(readFileSync(`${here}/keys/r1.crt`, 'utf8'))] }]
for (const [name, fn] of [['A2', (src) => encryptPubSecSeeded(mupdf, src, groups)], ['B', (src) => encryptPubSecInPlace(mupdf, src, groups, { password: 'secret' })]]) {
  const src = new mupdf.PDFDocument(readFileSync('/home/user/Fartcrobat/tests/fixtures/encrypted.pdf'))
  console.log(name, 'source needsPassword', src.needsPassword(), 'auth', src.authenticatePassword('secret'))
  const res = await fn(src)
  writeFileSync(`${here}/out/frompw.${name}.r1.pdf`, res.bytes)
  console.log(name, 'wrote', res.bytes.length, 'bytes; live source still encrypted:', !src.getTrailer().get('Encrypt').isNull())
}
