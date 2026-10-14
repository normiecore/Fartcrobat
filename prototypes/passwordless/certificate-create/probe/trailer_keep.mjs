import { readFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
const doc = new mupdf.PDFDocument(readFileSync('/home/user/Fartcrobat/tests/fixtures/text.pdf'))
const enc = doc.newDictionary()
enc.put('Filter', doc.newName('Adobe.PubSec'))
enc.put('Foo', doc.newByteString(new Uint8Array([1, 2, 3, 0xff])))
const ref = doc.addObject(enc)
doc.getTrailer().put('Encrypt', ref)
for (const opts of ['', 'garbage=yes', 'garbage=compact', 'regenerate-id=no']) {
  const out = Buffer.from(doc.saveToBuffer(opts).asUint8Array())
  const t = out.toString('latin1')
  const tr = t.slice(t.lastIndexOf('trailer'))
  console.log(JSON.stringify(opts), out.length, 'trailer:', tr.replace(/\s+/g, ' ').slice(0, 200), '| has Adobe.PubSec obj:', t.includes('Adobe.PubSec'))
}
console.log('trailer obj now', doc.getTrailer().toString())
