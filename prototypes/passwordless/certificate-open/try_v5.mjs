import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { readFileSync } from 'node:fs'
import { readPubSec, unwrapSeed, fileKey, forgeDecrypter, bridgeV5 } from './bridge-append.mjs'
import { pemToDer } from '../create/lib/der.mjs'
const [certPath, keyPem, ...files] = process.argv.slice(2)
const cert = pemToDer(readFileSync(certPath, 'utf8'))
const dec = forgeDecrypter(readFileSync(keyPem, 'utf8'))
for (const f of files) {
  const name = f.split('/').slice(-2).join('/')
  const bytes = readFileSync(f)
  try {
    const t0 = performance.now()
    const info = readPubSec(bytes)
    const u = unwrapSeed(info.recipients, cert, dec)
    if (!u) { console.log(name, `V${info.V} ${info.cfm} xref=${info.trailer.kind}: NOT A RECIPIENT`); continue }
    const K = fileKey(info, u.seed)
    if (info.V < 5) { console.log(name, `V${info.V} ${info.cfm} len=${info.length} xref=${info.trailer.kind} envelope=${u.cipher}: unwrapped, K=${K.length} bytes; R6 bridge not applicable`); continue }
    const { bytes: bridged, password } = await bridgeV5(bytes, info, K)
    const doc = mupdf.Document.openDocument(bridged, 'application/pdf')
    const auth = doc.authenticatePassword(password)
    const pdf = doc.asPDF()
    const page = doc.loadPage(0)
    const text = page.toStructuredText().asText().trim().split('\n')[0]
    const annots = page.getAnnotations?.().map((a) => a.getContents()).join('|') ?? ''
    const title = doc.getMetaData('info:Title')
    const ms = (performance.now() - t0).toFixed(0)
    console.log(name, `V${info.V} xref=${info.trailer.kind} envelope=${u.cipher} perms=0x${(u.permissions >>> 0).toString(16)} auth=${auth} pages=${doc.countPages()} text=${JSON.stringify(text)} annots=${JSON.stringify(annots)} title=${JSON.stringify(title)} repaired=${pdf.wasRepaired()} ${ms}ms`)
  } catch (e) { console.log(name, 'FAILED', e.message) }
}
