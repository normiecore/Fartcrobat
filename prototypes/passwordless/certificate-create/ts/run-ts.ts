// Drives the TypeScript port (bundled with esbuild) on the same inputs as run.mjs approach B.
import { readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from 'mupdf'
import { newPubSecKey, pubsecPermissionBits } from './pubsec'
import { writePubSecDocument } from './pubsecWrite'

const here = process.argv[2]
const pem = (n: string) => {
  const b64 = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(readFileSync(`${here}/keys/${n}.crt`, 'utf8'))![1]
  return Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0))
}
const inputs: Record<string, string> = {
  text: '/home/user/Fartcrobat/tests/fixtures/text.pdf',
  hiddeninfo: '/home/user/Fartcrobat/tests/fixtures/redact/hidden-info.pdf',
  allfields: '/home/user/Fartcrobat/tests/fixtures/forms-fill/all-fields.pdf',
  big50: `${here}/fixtures/big50.pdf`,
  sigtext: `${here}/fixtures/signed-text.pdf`
}
for (const [name, file] of Object.entries(inputs)) {
  const src = new mupdf.PDFDocument(readFileSync(file))
  const key = await newPubSecKey([
    { certs: [pem('r1')] },
    { certs: [pem('r2')], permissions: pubsecPermissionBits({ modify: false, copy: false, changeSecurity: false }) }
  ])
  const t = performance.now()
  const bytes = await writePubSecDocument(mupdf, src, key)
  writeFileSync(`${here}/out/${name}.TS.r1Xr2.pdf`, bytes)
  console.log(`${name}.TS.r1Xr2 ${bytes.length} bytes ${(performance.now() - t).toFixed(0)} ms`)
  src.destroy()
}
