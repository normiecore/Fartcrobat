// Writes each recipient envelope of a created file as DER, for openssl cms -decrypt, and checks
// the negative cases: a key that is not a recipient, and an EC certificate.
import { readFileSync, writeFileSync } from 'node:fs'
import { readPubSecDict } from '../lib/bridge.mjs'
import { certificateParts, pemToDer } from '../lib/der.mjs'
import { hex } from '../lib/crypto.mjs'
import { buildRecipientEnvelope, pemKeyDecrypter, unwrapSeed } from '../lib/pubsec.mjs'
const here = new URL('..', import.meta.url).pathname
for (const f of ['text.B.r1r2', 'text.A2.r1Xr2']) {
  const d = readPubSecDict(new Uint8Array(readFileSync(`${here}/out/${f}.pdf`)))
  d.recipients.forEach((r, i) => writeFileSync(`${here}/probe/cms/${f}.${i}.der`, r))
  console.log(f, 'envelopes', d.recipients.length, 'sizes', d.recipients.map((r) => r.length).join(','))
  const stranger = await unwrapSeed(d.recipients, pemToDer(readFileSync(`${here}/keys/stranger.crt`, 'utf8')), pemKeyDecrypter(readFileSync(`${here}/keys/stranger.key`, 'utf8')))
  console.log('  stranger key ->', stranger === null ? 'not a recipient (null), as expected' : 'UNEXPECTED')
}
try {
  await buildRecipientEnvelope([pemToDer(readFileSync(`${here}/keys/ec.crt`, 'utf8'))], new Uint8Array(20), 0xffffffff)
  console.log('EC certificate: UNEXPECTEDLY accepted')
} catch (e) {
  console.log('EC certificate ->', e.message)
}
const r2 = certificateParts(pemToDer(readFileSync(`${here}/keys/r2.crt`, 'utf8')))
console.log('r2 serial DER', hex(r2.serial), '(leading 00 kept)')
