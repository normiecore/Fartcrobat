// Timing: median of N runs per approach and input (after one warm-up run), plus the fixed costs.
// Usage: node bench.mjs [runs]
import { readFileSync } from 'node:fs'
import * as mupdf from '/home/user/Fartcrobat/node_modules/mupdf/dist/mupdf.js'
import { randomBytes } from './lib/crypto.mjs'
import { pemToDer } from './lib/der.mjs'
import { encryptPubSecInPlace } from './lib/encrypt-inplace.mjs'
import { encryptPubSecSeeded, keyedSeedDocument, openSeed } from './lib/encrypt-seeded.mjs'
import { newPubSecKey } from './lib/pubsec.mjs'
import { oneTimePassword, standardR6Dict } from './lib/standard.mjs'

const here = new URL('.', import.meta.url).pathname
const N = Number(process.argv[2] ?? 5)
const groups = [{ certs: [pemToDer(readFileSync(`${here}/keys/r1.crt`, 'utf8')), pemToDer(readFileSync(`${here}/keys/r2.crt`, 'utf8'))] }]
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]

async function time(fn) {
  const t = performance.now()
  await fn()
  return performance.now() - t
}

const fixed = { newPubSecKey: [], standardR6Dict: [], openSeedInMuPDF: [] }
for (let i = 0; i < N + 1; i++) {
  const k = randomBytes(32)
  const pw = oneTimePassword()
  const a = await time(() => newPubSecKey(groups))
  const b = await time(() => standardR6Dict(k, pw))
  const seed = await keyedSeedDocument(k, pw)
  const c = await time(() => openSeed(mupdf, seed, pw).destroy())
  if (i) {
    fixed.newPubSecKey.push(a)
    fixed.standardR6Dict.push(b)
    fixed.openSeedInMuPDF.push(c)
  }
}
console.log('fixed costs (median ms):', Object.fromEntries(Object.entries(fixed).map(([k, v]) => [k, +median(v).toFixed(1)])))

for (const [name, file] of [
  ['big50 (50 pages, 7.1 MB, 50 images, 1 MB attachment)', `${here}/fixtures/big50.pdf`],
  ['long150 (150 pages, 125 KB text)', '/home/user/Fartcrobat/tests/fixtures/compare/long-old.pdf'],
  ['form (1 page, 14 KB)', '/home/user/Fartcrobat/tests/fixtures/form.pdf']
]) {
  const bytes = readFileSync(file)
  for (const [a, fn] of [
    ['A2', (src) => encryptPubSecSeeded(mupdf, src, groups)],
    ['B', (src) => encryptPubSecInPlace(mupdf, src, groups)]
  ]) {
    const totals = []
    const phases = {}
    for (let i = 0; i < N + 1; i++) {
      const src = new mupdf.PDFDocument(bytes)
      const t = performance.now()
      const res = await fn(src)
      const ms = performance.now() - t
      src.destroy()
      if (!i) continue
      totals.push(ms)
      for (const [k, v] of Object.entries(res.timings)) (phases[k] ??= []).push(v)
    }
    console.log(`${name.padEnd(56)} ${a.padEnd(3)} median ${median(totals).toFixed(0).padStart(4)} ms`, Object.fromEntries(Object.entries(phases).map(([k, v]) => [k, +median(v).toFixed(0)])))
  }
}
