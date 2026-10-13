// Smoke run: node test/smoke.ts <pwsh> <pdf dir>
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { decryptRecipients, listEncryptionCertificates, probeRecipients, WinStoreError } from '../src/winCertStore.ts'
import { readPubSec } from './pdfRecipients.ts'

const [pwsh, dir] = process.argv.slice(2)
const opts = { powershellPath: pwsh }

const t0 = Date.now()
const certs = await listEncryptionCertificates({ ...opts, includeOthers: true })
console.log(`list (${Date.now() - t0} ms):`)
for (const c of certs) console.log(`  ${c.store} ${c.thumbprint} key=${c.hasPrivateKey} ${c.encryptionUsage} ${c.subject}`)

for (const name of ['pubsec-me-enc.pdf', 'pubsec-multi.pdf', 'pubsec-two-envelopes.pdf', 'pubsec-oaep.pdf',
  'pubsec-expired.pdf', 'pubsec-ec.pdf', 'pubsec-colleague-only.pdf']) {
  const info = readPubSec(readFileSync(path.join(dir, name)))
  const t = Date.now()
  try {
    const p = await probeRecipients(info.recipients, opts)
    const d = await decryptRecipients(info.recipients, opts)
    console.log(`${name}: ${info.recipients.length} blob(s); probe ${p.candidates.map((c) => `${c.blob}/${c.index}`).join(',')}; ` +
      `decrypt blob ${d.blob}/${d.index} with ${d.subject}; kea ${d.keyEncryptionAlgorithm} cea ${d.contentEncryptionAlgorithm}; ` +
      `content ${d.content.length} bytes (${Date.now() - t} ms)`)
  } catch (e) {
    if (e instanceof WinStoreError) console.log(`${name}: ${e.code}: ${e.message} ${JSON.stringify(e.detail).slice(0, 400)}`)
    else throw e
  }
}
