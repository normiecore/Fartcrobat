// Creates certificate-encrypted versions of the test inputs with each approach.
// Usage: node run.mjs [filter]   -> out/<name>.<approach>.<recipients>.pdf, timings on stdout
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { pemToDer } from './lib/der.mjs'
import { encryptPubSecInPlace } from './lib/encrypt-inplace.mjs'
import { encryptPubSecSeeded } from './lib/encrypt-seeded.mjs'
import { ALL_PERMISSIONS, permissionBits } from './lib/pubsec.mjs'

const FIX = '/home/user/Fartcrobat/tests/fixtures'
const here = new URL('.', import.meta.url).pathname
mkdirSync(`${here}/out`, { recursive: true })
const warnings = []
mupdf.setLog?.({ warning: (m) => warnings.push(m), error: (m) => warnings.push(`error: ${m}`) })

const cert = (n) => pemToDer(readFileSync(`${here}/keys/${n}.crt`, 'utf8'))
const RECIPIENTS = {
  r1: [{ certs: [cert('r1')] }],
  // two certificates in one envelope (same permissions)
  r1r2: [{ certs: [cert('r1'), cert('r2')] }],
  // one envelope per certificate, r2 may only print (Acrobat's layout for differing permissions)
  r1Xr2: [
    { certs: [cert('r1')], permissions: ALL_PERMISSIONS },
    { certs: [cert('r2')], permissions: permissionBits({ changeSecurity: false, modify: false, copy: false, annotate: false, fillForms: false, assemble: false }) }
  ]
}

const INPUTS = {
  text: `${FIX}/text.pdf`,
  form: `${FIX}/form.pdf`,
  attachments: `${FIX}/navigation/attachments.pdf`,
  hiddeninfo: `${FIX}/redact/hidden-info.pdf`,
  tagged: `${FIX}/edit-text/office-report.pdf`,
  signed: `${FIX}/forms-fill/signed.pdf`,
  layers: `${FIX}/navigation/layers.pdf`,
  allfields: `${FIX}/forms-fill/all-fields.pdf`,
  objstm: `${here}/fixtures/objstm.pdf`,
  big50: `${here}/fixtures/big50.pdf`,
  long150: `${FIX}/compare/long-old.pdf`,
  sigtext: `${here}/fixtures/signed-text.pdf`
}

const APPROACHES = {
  A1: (src, groups, o) => encryptPubSecSeeded(mupdf, src, groups, { ...o, copy: 'pages' }),
  A2: (src, groups, o) => encryptPubSecSeeded(mupdf, src, groups, { ...o, copy: 'catalog' }),
  B: (src, groups, o) => encryptPubSecInPlace(mupdf, src, groups, o)
}

const JOBS = []
for (const name of Object.keys(INPUTS)) for (const a of Object.keys(APPROACHES)) JOBS.push({ name, a, r: 'r1' })
for (const name of ['text', 'hiddeninfo']) for (const a of ['A2', 'B']) for (const r of ['r1r2', 'r1Xr2']) JOBS.push({ name, a, r })
for (const a of ['A2', 'B']) JOBS.push({ name: 'hiddeninfo', a, r: 'r1', em: false })

const filter = process.argv[2]
for (const job of JOBS) {
  const tag = `${job.name}.${job.a}.${job.r}${job.em === false ? '.nometa' : ''}`
  if (filter && !tag.includes(filter)) continue
  const src = new mupdf.PDFDocument(readFileSync(INPUTS[job.name]))
  warnings.length = 0
  const t0 = performance.now()
  try {
    const res = await APPROACHES[job.a](src, RECIPIENTS[job.r], { encryptMetadata: job.em !== false })
    const ms = performance.now() - t0
    writeFileSync(`${here}/out/${tag}.pdf`, res.bytes)
    const t = Object.entries(res.timings).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(', ')
    console.log(`${tag.padEnd(28)} ${String(res.bytes.length).padStart(9)} bytes  ${ms.toFixed(0).padStart(5)} ms  (${t})${res.stats ? ' ' + JSON.stringify(res.stats) : ''}${warnings.length ? ` warnings: ${[...new Set(warnings)].join(' | ')}` : ''}`)
  } catch (e) {
    console.log(`${tag.padEnd(28)} FAILED: ${e.message}`)
  } finally {
    src.destroy()
  }
}
