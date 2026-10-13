// Opens a certificate-encrypted file through the bridge (recipient key -> seed -> K -> Standard R6
// dictionary -> MuPDF) and compares what MuPDF sees with the plain source: page count, rendered
// pages, text, annotations, form fields, outline, attachments, metadata.
// Usage: node mupdf_check.mjs <plain.pdf> <encrypted.pdf> <cert.pem> <key.pem>
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { openPubSec } from '../lib/bridge.mjs'
import { pemToDer } from '../lib/der.mjs'
import { pemKeyDecrypter } from '../lib/pubsec.mjs'

const h = (b) => createHash('sha256').update(b).digest('hex').slice(0, 12)

export function describe(doc) {
  const out = { pages: doc.countPages(), render: [], text: [], annots: [], widgets: [] }
  for (let i = 0; i < out.pages; i++) {
    const page = doc.loadPage(i)
    const pix = page.toPixmap(mupdf.Matrix.scale(0.5, 0.5), mupdf.ColorSpace.DeviceRGB, false, true)
    out.render.push(h(pix.getPixels()))
    out.text.push(h(page.toStructuredText().asText()))
    for (const a of page.getAnnotations()) out.annots.push(`p${i + 1}:${a.getType()}:${a.getContents?.() ?? ''}`)
    for (const w of page.getWidgets()) out.widgets.push(`${w.getName()}=${w.getValue()}`)
  }
  const ol = []
  const walk = (items, depth) => {
    for (const it of items ?? []) {
      ol.push(`${'  '.repeat(depth)}${it.title} -> ${it.page ?? it.uri}`)
      walk(it.down, depth + 1)
    }
  }
  walk(doc.loadOutline(), 0)
  out.outline = ol
  const files = doc.getEmbeddedFiles()
  out.attachments = Object.keys(files).map((name) => `${name}:${h(doc.getEmbeddedFileContents(files[name])?.asUint8Array() ?? new Uint8Array())}`)
  out.title = doc.getMetaData('info:Title')
  const meta = doc.getTrailer().get('Root', 'Metadata')
  out.xmp = meta.isNull() ? null : (() => {
    const b = meta.readStream().asUint8Array()
    return `${b.length} bytes, xpacket=${Buffer.from(b).toString('latin1').includes('<?xpacket')} ${h(b)}`
  })()
  out.lang = doc.getLanguage()
  out.layers = doc.countLayers()
  return out
}

const [plainPath, encPath, certPath, keyPath] = process.argv.slice(2)
mupdf.setLog?.({ warning: () => {}, error: (m) => console.log('[mupdf error]', m) })
const plain = new mupdf.PDFDocument(readFileSync(plainPath))
const { doc, permissions, dict } = await openPubSec(
  mupdf,
  new Uint8Array(readFileSync(encPath)),
  pemToDer(readFileSync(certPath, 'utf8')),
  pemKeyDecrypter(readFileSync(keyPath, 'utf8'))
)
console.log(`bridge: ${dict.recipients.length} envelope(s), permissions 0x${permissions?.toString(16)}, MuPDF says "${doc.getMetaData('encryption')}"`)
const a = describe(plain)
const b = describe(doc)
let same = true
for (const k of Object.keys(a)) {
  const eq = JSON.stringify(a[k]) === JSON.stringify(b[k])
  same &&= eq
  const v = Array.isArray(b[k]) ? (b[k].length > 6 ? [...b[k].slice(0, 6), `... ${b[k].length} items`] : b[k]) : b[k]
  console.log(`  ${k}: ${eq ? 'same' : 'DIFFERENT'} ${JSON.stringify(v)}`)
  if (!eq) console.log(`     plain: ${JSON.stringify(a[k]).slice(0, 300)}`)
}
console.log('RESULT:', same ? 'MUPDF VIEW IDENTICAL' : 'MUPDF VIEW DIFFERS')
