import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { readFileSync } from 'node:fs'
for (const f of process.argv.slice(2)) {
  const name = f.split('/').pop()
  try {
    const d = mupdf.Document.openDocument(readFileSync(f), 'application/pdf')
    const pdf = d.asPDF()
    let enc = '?', id = '?'
    try { const t = pdf.getTrailer(); enc = t.get('Encrypt').get('Filter').toString(); id = t.get('ID').get(0).asByteString().length } catch (e) { enc = 'ERR ' + e.message }
    console.log(name, 'opened needsPassword=' + d.needsPassword(), 'Filter=' + enc, 'id0len=' + id, 'pages=' + (()=>{try{return d.countPages()}catch(e){return 'ERR '+e.message}})())
  } catch (e) { console.log(name, 'THROWS:', e.message) }
}
