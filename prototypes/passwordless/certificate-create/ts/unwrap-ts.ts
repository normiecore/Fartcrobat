// Checks the TS unwrapSeed (app ASN.1 parser) against files written by the TS port.
import { readFileSync } from 'node:fs'
import forge from 'node-forge'
import { fromHex } from './pdfCrypto'
import { pubsecFileKey, unwrapSeed } from './pubsec'
const here = process.argv[2]
const certDer = (n: string) => {
  const b64 = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END/.exec(readFileSync(`${here}/keys/${n}.crt`, 'utf8'))![1]
  return Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0))
}
const decrypter = (n: string) => {
  const key = forge.pki.privateKeyFromPem(readFileSync(`${here}/keys/${n}.key`, 'utf8')) as forge.pki.rsa.PrivateKey
  return async (w: Uint8Array) => Uint8Array.from(key.decrypt(String.fromCharCode(...w), 'RSAES-PKCS1-V1_5'), (c) => c.charCodeAt(0))
}
const text = readFileSync(`${here}/out/text.TS.r1Xr2.pdf`).toString('latin1')
const recipients = [...(/\/Recipients\[([^\]]*)\]/.exec(text)![1]).matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => fromHex(m[1]))
for (const n of ['r1', 'r2', 'stranger']) {
  const r = await unwrapSeed(recipients, certDer(n), decrypter(n))
  console.log(n, r ? `seed ${Buffer.from(r.seed).toString('hex').slice(0, 12)}... permissions 0x${r.permissions?.toString(16)} fileKey ${Buffer.from(await pubsecFileKey(r.seed, recipients)).toString('hex').slice(0, 12)}...` : 'not a recipient')
}
