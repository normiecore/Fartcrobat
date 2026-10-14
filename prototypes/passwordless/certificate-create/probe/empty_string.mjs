import { readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
const doc = new mupdf.PDFDocument(readFileSync('/home/user/Fartcrobat/tests/fixtures/text.pdf'))
const out = doc.saveToBuffer('encrypt=aes-256,user-password=u,owner-password=o').asUint8Array()
writeFileSync('out/mupdf-std-aes256.pdf', out)
const t = Buffer.from(out).toString('latin1'); console.log(/Keywords\s*(\S{0,12})/.exec(t)[0])
