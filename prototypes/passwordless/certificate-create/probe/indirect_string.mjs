// An indirect string object (Info /Title -> 7 0 R) and a string inside an indirect array.
import { readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
const doc = new mupdf.PDFDocument(readFileSync('/home/user/Fartcrobat/tests/fixtures/text.pdf'))
const title = doc.addObject(doc.newString('Indirect title string'))
doc.getTrailer().get('Info').put('Title', title)
const arr = doc.newArray(); arr.push(doc.newString('string inside an indirect array')); arr.push(42)
doc.getTrailer().get('Root').put('FcTest', doc.addObject(arr))
writeFileSync(new URL('../fixtures/indirect-string.pdf', import.meta.url), doc.saveToBuffer('').asUint8Array())
