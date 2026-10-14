// Does saveToBuffer('garbage=compact') change the live document (object numbers, trailer)?
import { readFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
for (const [file, pw] of [['/home/user/Fartcrobat/tests/fixtures/forms-fill/all-fields.pdf'], ['/home/user/Fartcrobat/tests/fixtures/encrypted.pdf', 'secret']]) {
  const doc = new mupdf.PDFDocument(readFileSync(file))
  if (pw) console.log('auth', doc.authenticatePassword(pw))
  doc.enableJournal()
  // an edit, like a live session doc has
  doc.beginOperation('edit'); doc.getTrailer().get('Root').put('Lang', doc.newString('en')); doc.endOperation()
  const before = { n: doc.countObjects(), p0: doc.findPage(0).asIndirect(), enc: doc.getTrailer().get('Encrypt').isNull() ? 'none' : 'yes' }
  const out = doc.saveToBuffer(pw ? 'garbage=compact,encrypt=none' : 'garbage=compact')
  const after = { n: doc.countObjects(), p0: doc.findPage(0).asIndirect(), enc: doc.getTrailer().get('Encrypt').isNull() ? 'none' : 'yes', canUndo: doc.canUndo() }
  console.log(file.split('/').pop(), 'before', JSON.stringify(before), 'after', JSON.stringify(after), 'saved', out.getLength?.() ?? out.asUint8Array().length)
}
