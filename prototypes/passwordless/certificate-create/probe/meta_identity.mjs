// Does MuPDF (write and read) leave a metadata stream marked /Filter/Crypt /Name/Identity alone?
import { readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
const src = new mupdf.PDFDocument(readFileSync('/home/user/Fartcrobat/tests/fixtures/redact/hidden-info.pdf'))
const meta = src.getTrailer().get('Root', 'Metadata')
console.log('source metadata dict', meta.resolve().toString())
const parms = src.newDictionary(); parms.put('Type', src.newName('CryptFilterDecodeParms')); parms.put('Name', src.newName('Identity'))
meta.put('Filter', src.newName('Crypt')); meta.put('DecodeParms', parms)
console.log('marked metadata dict', meta.resolve().toString())
const out = src.saveToBuffer('encrypt=aes-256,user-password=u,owner-password=o').asUint8Array().slice()
writeFileSync('out/probe-meta-identity-mupdf-std.pdf', out)
const t = Buffer.from(out).toString('latin1')
console.log('MuPDF writer left XMP plaintext:', t.includes('<?xpacket'))
const back = new mupdf.PDFDocument(out); back.authenticatePassword('u')
const b = back.getTrailer().get('Root', 'Metadata').readStream().asUint8Array()
console.log('MuPDF reads back', b.length, 'bytes, xpacket:', Buffer.from(b).toString('latin1').includes('<?xpacket'))
