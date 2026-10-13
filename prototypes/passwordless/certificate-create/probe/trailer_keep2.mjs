import { readFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
const doc = new mupdf.PDFDocument(readFileSync('/home/user/Fartcrobat/tests/fixtures/text.pdf'))
const enc = doc.newDictionary()
enc.put('Filter', doc.newName('Adobe.PubSec'))
const ref = doc.addObject(enc)
console.log('enc obj num', ref.asIndirect(), 'countObjects', doc.countObjects())
doc.getTrailer().put('Encrypt', ref)
const out = Buffer.from(doc.saveToBuffer('').asUint8Array()).toString('latin1')
const i = out.indexOf('Adobe.PubSec'); console.log(out.slice(out.lastIndexOf('obj', i) - 10, i + 40))
console.log(out.slice(out.indexOf('xref'), out.indexOf('xref') + 60))
