/**
 * Probe: can the trailer /ID (and the /Encrypt parameters) be read while needsPassword() is
 * true, and how do they behave across the saves Fartcrobat makes?
 *
 *   node test/probe-id.ts
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFileId, readLockInfo } from '../src/lockInfo.ts'

const mupdf = await import('/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js')
const FIX = '/home/user/Fartcrobat/tests/fixtures'
const OUT = new URL('../out/', import.meta.url).pathname
mkdirSync(OUT, { recursive: true })

type Doc = InstanceType<typeof mupdf.PDFDocument>

function save(doc: Doc, opts: string): Uint8Array {
  const buf = doc.saveToBuffer(opts)
  try {
    return buf.asUint8Array().slice()
  } finally {
    buf.destroy()
  }
}

function idPair(doc: Doc): string {
  try {
    const id = doc.getTrailer().get('ID')
    if (!id.isArray()) return '(no /ID)'
    const h = (i: number) => {
      const b = id.get(i).asByteString()
      return Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('')
    }
    return `[${h(0)}, ${h(1)}]`
  } catch (e) {
    return `(error ${(e as Error).message})`
  }
}

const short = (s: string | null | undefined) => (s ? (s.length > 64 ? s.slice(0, 64) + '…' : s) : String(s))

function describe(label: string, bytes: Uint8Array, password?: string) {
  const doc = new mupdf.PDFDocument(bytes)
  const needs = doc.needsPassword()
  const lock = readLockInfo(doc)
  const idBefore = idPair(doc)
  let auth: number | null = null
  let idAfter = idBefore
  let lockAfter = lock
  if (needs && password !== undefined) {
    auth = doc.authenticatePassword(password)
    idAfter = idPair(doc)
    lockAfter = readLockInfo(doc)
  }
  const enc = (() => {
    try {
      return doc.getMetaData('encryption')
    } catch {
      return '?'
    }
  })()
  console.log(`\n== ${label}`)
  console.log(`  encryption=${enc} needsPassword=${needs}${auth !== null ? ` auth(${JSON.stringify(password)})=${auth}` : ''}`)
  console.log(`  /ID before auth: ${idBefore}`)
  if (auth !== null) console.log(`  /ID after auth:  ${idAfter}  same=${idBefore === idAfter}`)
  console.log(`  lock.handler=${lock?.handler} lock.id=${short(lock?.id)}`)
  console.log(`  lock.security=${short(lock?.security)}`)
  if (auth !== null) console.log(`  lock.security same after auth: ${lock?.security === lockAfter?.security}`)
  return { doc, lock, idPair: idBefore }
}

// ---- 1. the repo fixture -------------------------------------------------------------------
const fixture = new Uint8Array(readFileSync(join(FIX, 'encrypted.pdf')))
const f = describe('tests/fixtures/encrypted.pdf (password "secret")', fixture, 'secret')
console.log('  readFileId():', readFileId(f.doc))

// ---- 2. a file encrypted here (AES-256, user u1, owner o1) ---------------------------------
const plain = new mupdf.PDFDocument(new Uint8Array(readFileSync(join(FIX, 'text.pdf'))))
console.log('\ntext.pdf (unencrypted) /ID:', idPair(plain), ' readLockInfo:', readLockInfo(plain))
const aes = save(plain, 'garbage=yes,compress,encrypt=aes-256,user-password=u1,owner-password=o1,permissions=-3904')
writeFileSync(join(OUT, 'aes256.pdf'), aes)
const a = describe('aes256.pdf made by MuPDF from text.pdf', aes, 'u1')
console.log('  (text.pdf /ID[0] kept by the encrypting save?)', idPair(plain).slice(1, 33) === a.idPair.slice(1, 33))

// ---- 3. what each Fartcrobat save does to /ID and to the lock ----------------------------------
const base = new mupdf.PDFDocument(aes)
base.authenticatePassword('u1')
const baseLock = readLockInfo(base)!
const scenarios: [string, () => Uint8Array][] = [
  // Ctrl+S / Save As of an unsigned doc: saveToBuffer(saveOptionString({}))  -> 'garbage=yes,compress'
  ['Save / Save As (full: garbage=yes,compress)', () => save(base, 'garbage=yes,compress')],
  // Signed docs: incremental
  ['Save of a signed doc (incremental)', () => save(base, 'incremental')],
  // Optimize / compress: copy with garbage=deduplicate + compress-images...
  ['Compress (garbage=deduplicate,compress,compress-images)', () => save(base, 'garbage=deduplicate,compress,compress-images,compress-fonts')],
  // Protect with a new password (saveDocument runs on a copy: first garbage=yes, then encrypt=...)
  [
    'Protect again with a new password (copy + encrypt=aes-256 user=u2)',
    () => {
      const copy = new mupdf.PDFDocument(save(base, 'garbage=yes'))
      copy.authenticatePassword('u1')
      return save(copy, 'garbage=yes,compress,encrypt=aes-256,user-password=u2,owner-password=o2,permissions=-3904')
    }
  ],
  [
    'Protect again with the SAME password (copy + encrypt=aes-256 user=u1)',
    () => {
      const copy = new mupdf.PDFDocument(save(base, 'garbage=yes'))
      copy.authenticatePassword('u1')
      return save(copy, 'garbage=yes,compress,encrypt=aes-256,user-password=u1,owner-password=o1,permissions=-3904')
    }
  ],
  [
    'Remove security (copy + encrypt=none)',
    () => {
      const copy = new mupdf.PDFDocument(save(base, 'garbage=yes'))
      copy.authenticatePassword('u1')
      return save(copy, 'garbage=yes,compress,encrypt=none')
    }
  ],
  [
    'Extract pages (new PDFDocument + graftPage, saved plain like organize-pages does)',
    () => {
      const out = new mupdf.PDFDocument()
      out.graftPage(-1, base, 0)
      return save(out, 'garbage=compact,compress')
    }
  ],
  [
    'Extract pages keeping encryption (new PDFDocument + graftPage + encrypt=aes-256 user=u1)',
    () => {
      const out = new mupdf.PDFDocument()
      out.graftPage(-1, base, 0)
      return save(out, 'garbage=compact,compress,encrypt=aes-256,user-password=u1,owner-password=o1,permissions=-3904')
    }
  ]
]

const rows: string[] = []
for (const [label, make] of scenarios) {
  let bytes: Uint8Array
  try {
    bytes = make()
  } catch (e) {
    rows.push(`| ${label} | error: ${(e as Error).message} | | | |`)
    continue
  }
  const d = new mupdf.PDFDocument(bytes)
  const needs = d.needsPassword()
  const lock = readLockInfo(d)
  const ids = idPair(d)
  const id0Same = lock?.id ? lock.id === baseLock.id : readFileId(d) === baseLock.id
  const securitySame = lock ? lock.security === baseLock.security : false
  const u1 = needs ? d.authenticatePassword('u1') : null
  rows.push(
    `| ${label} | ${needs} | ID0 same: ${id0Same} (${ids === idPair(base) ? 'ID1 same too' : 'ID1 differs'}) | security same: ${securitySame} | old password u1 -> ${u1} |`
  )
}
console.log('\nbase /ID:', idPair(base))
console.log('\n| scenario | needsPassword | /ID[0] vs original | lock.security vs original | authenticatePassword("u1") |')
console.log('|---|---|---|---|---|')
for (const r of rows) console.log(r)

// ---- 4. RC4 / AES-128 (R3/R4): ID0 feeds the key, check security text includes it -----------
for (const method of ['rc4-128', 'aes-128']) {
  const b = save(plain, `garbage=yes,compress,encrypt=${method},user-password=u1,owner-password=o1,permissions=-3904`)
  const d = describe(`${method} made by MuPDF`, b, 'u1')
  // Same password, saved again with encrypt=: are O/U deterministic for R<=4?
  const again = save(plain, `garbage=yes,compress,encrypt=${method},user-password=u1,owner-password=o1,permissions=-3904`)
  const d2 = new mupdf.PDFDocument(again)
  console.log(`  ${method}: re-encrypt same password -> same lock.security: ${readLockInfo(d2)?.security === d.lock?.security}, same /ID: ${idPair(d2) === d.idPair}`)
}

// ---- 5. a file whose trailer has no /ID -------------------------------------------------------
{
  const noId = new mupdf.PDFDocument(aes)
  noId.authenticatePassword('o1')
  // remove /ID from the trailer, then save (MuPDF regenerates one when encrypting?)
  noId.getTrailer().delete('ID')
  const b = save(noId, 'garbage=yes,compress')
  const d = new mupdf.PDFDocument(b)
  console.log('\nsaved after deleting /ID (keeps encryption): /ID now', idPair(d), 'needsPassword', d.needsPassword(), 'u1->', d.authenticatePassword('u1'))
}
