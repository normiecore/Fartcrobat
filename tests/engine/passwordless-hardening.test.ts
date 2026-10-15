// Certificate encryption against hostile or unusual files: the small PDF reader (pdfLex.ts) must
// finish quickly and in bounded memory on anything a file controls, since it runs on every file
// MuPDF refuses to open. Hostile inputs run in a worker with a deadline and a heap limit, so a
// regression fails the test instead of hanging the run. Also: the RC4 key check with binary
// streams, a direct /Info dictionary (encrypted, never in clear), and what a tab reports after
// it saves (signatures and the encryption of the file it wrote).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { buildSync } from 'esbuild'
import { zlibSync } from 'fflate'
import * as mupdf from 'mupdf'
import { describe, expect, it } from 'vitest'
import { appendUpdate, concat, encryptObjectsInPlace, fileKey, pubsecEncryptDict, readPubSec, serialiseEncrypted, verifyFileKey, writeKeyFor, writePubSecDocument } from '@engine/crypt'
import { PdfString } from '@engine/crypt/pdfLex'
import { latin1, md5, randomBytes, rc4, toHex, toLatin1 } from '@engine/crypt/primitives'
import { createLocalEngine } from '@engine/local'
import type annotOps from '@engine/ops/annots'
import type docOps from '@engine/ops/doc'
import type sigOps from '@features/digital-signatures/engine'
import type protectOps from '@features/protect-optimize/engine'
import type { CertificateKey } from '@shared/certkeys'
import type { OpenResult } from '@shared/types'
import { expected, hexBytes, includesBytes, keyFor, openFixtureAs, openWithKey, PKI, pubsecFixture, type Engine } from './passwordless-helpers'

const ROOT = resolve(__dirname, '../..')

// ---- running the reader in a worker -----------------------------------------------------------

let bundled: string | null = null

/** pdfLex.ts and readPubSec as one CommonJS script (built once per file). */
function readerBundle(): string {
  bundled ??= buildSync({
    stdin: {
      contents: "export * from './src/engine/crypt/pdfLex'\nexport { readPubSec } from './src/engine/crypt/pubsecRead'\n",
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    alias: { '@shared': resolve(ROOT, 'src/shared') },
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'error'
  }).outputFiles[0].text
  return bundled
}

const WORKER_OPS = `
const ops = {
  readXref(b) {
    const x = lib.readXref(b)
    return { damaged: x.damaged, entries: x.entries.size, root: x.trailer.has('Root') }
  },
  scanXref(b) {
    const x = lib.scanXref(b)
    return { entries: x.entries.size, trailers: x.trailers.length }
  },
  readPubSec(b) {
    try {
      const i = lib.readPubSec(b)
      return i && { recipients: i.recipients.length, damaged: i.xref.damaged, version: i.version }
    } catch (err) {
      return { error: err.message }
    }
  },
  decodeStream(b, [dict, max]) {
    try {
      return { length: lib.decodeStream(b, lib.parseValue(Buffer.from(dict, 'latin1'), 0)[0], max).length }
    } catch (err) {
      return { error: err.message }
    }
  }
}
const { parentPort, workerData } = require('node:worker_threads')
const t0 = performance.now()
const result = ops[workerData.op](workerData.bytes, workerData.arg)
parentPort.postMessage({ result, elapsed: performance.now() - t0 })
`

type Op = 'readXref' | 'scanXref' | 'readPubSec' | 'decodeStream'

/**
 * Runs one reader call on `bytes` in a worker with a 256 MB heap. Rejects when it has not finished
 * after `deadline` ms (the worker is stopped) or runs out of memory; `elapsed` is the call alone.
 */
function inWorker(op: Op, bytes: Uint8Array, arg?: [string, number?], deadline = 8000): Promise<{ result: any; elapsed: number }> {
  const source = `const m = { exports: {} };\n(function (module, exports, require) {\n${readerBundle()}\n})(m, m.exports, require);\nconst lib = m.exports;\n${WORKER_OPS}`
  const worker = new Worker(source, { eval: true, workerData: { op, bytes, arg }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
  return new Promise((done, fail) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      fail(new Error(`${op} did not finish within ${deadline} ms`))
    }, deadline)
    worker.once('message', (m) => {
      clearTimeout(timer)
      void worker.terminate()
      done(m)
    })
    worker.once('error', (err) => {
      clearTimeout(timer)
      fail(err)
    })
  })
}

// ---- building files ---------------------------------------------------------------------------

/** Builds a file from pieces, remembering where each object starts. */
class Builder {
  private parts: Uint8Array[] = []
  pos = 0
  readonly offsets = new Map<number, number>()
  add(piece: string | Uint8Array): this {
    const b = typeof piece === 'string' ? latin1(piece) : piece
    this.parts.push(b)
    this.pos += b.length
    return this
  }
  obj(num: number, body: string): this {
    this.offsets.set(num, this.pos)
    return this.add(`${num} 0 obj\n${body}\nendobj\n`)
  }
  /** `dict` is a dictionary's source; /Length is added before its final >>. */
  stream(num: number, dict: string, data: Uint8Array): this {
    this.offsets.set(num, this.pos)
    const d = dict.trimEnd()
    return this.add(`${num} 0 obj\n${d.slice(0, -2)} /Length ${data.length} >>\nstream\n`).add(data).add('\nendstream\nendobj\n')
  }
  bytes(): Uint8Array {
    return Buffer.concat(this.parts)
  }
}

/** A certificate encryption dictionary (the envelope is not real; nothing here decrypts). */
const PUBSEC_ENCRYPT =
  '<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 5 /Length 256 /CF << /DefaultCryptFilter << /CFM /AESV3 ' +
  '/Recipients [<3082010a0201>] >> >> /StmF /DefaultCryptFilter /StrF /DefaultCryptFilter >>'

/**
 * A one-page certificate-encrypted file whose only cross-reference section is the xref stream 5
 * with `dict` (added to /Type /XRef /Size 6 /Root /Encrypt) and `data`, or with rows for objects
 * 0 to 5 (W [1 2 1]) passed through `encode` when `data` is a function.
 */
function xrefStreamFile(dict: string, data: Uint8Array | ((rows: Uint8Array) => Uint8Array)): Uint8Array {
  const b = new Builder()
    .add('%PDF-1.7\n')
    .obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
    .obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
    .obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>')
    .obj(4, PUBSEC_ENCRYPT)
  const at = b.pos
  let bytes: Uint8Array
  if (typeof data === 'function') {
    const rows: number[] = [0, 0, 0, 255]
    for (const n of [1, 2, 3, 4]) rows.push(1, (b.offsets.get(n)! >> 8) & 255, b.offsets.get(n)! & 255, 0)
    rows.push(1, (at >> 8) & 255, at & 255, 0)
    bytes = data(Uint8Array.from(rows))
  } else bytes = data
  b.stream(5, `<< /Type /XRef /Size 6 /Root 1 0 R /Encrypt 4 0 R ${dict} >>`, bytes)
  b.add(`startxref\n${at}\n%%EOF\n`)
  return b.bytes()
}

/** TIFF predictor 2 on rows of `columns` bytes (one 8-bit colour): each byte minus the one before. */
function tiffEncode(rows: Uint8Array, columns: number): Uint8Array {
  const out = rows.slice()
  for (let i = rows.length - 1; i >= 0; i--) if (i % columns) out[i] = (rows[i] - rows[i - 1]) & 255
  return out
}

// ---- predictors -------------------------------------------------------------------------------

describe('predictor parameters', () => {
  it('a sound TIFF predictor still reads (the control file)', async () => {
    const bytes = xrefStreamFile('/W [1 2 1] /Filter /FlateDecode /DecodeParms << /Predictor 2 /Columns 4 >>', (rows) => zlibSync(tiffEncode(rows, 4)))
    const { result } = await inWorker('readXref', bytes)
    expect(result).toEqual({ damaged: false, entries: 6, root: true })
    expect((await inWorker('readPubSec', bytes)).result).toEqual({ recipients: 1, damaged: false, version: 5 })
  })

  it('the engine answers for such a file: open and the input check ask for a certificate', async () => {
    const bytes = xrefStreamFile('/W [1 2 1] /Filter /FlateDecode /DecodeParms << /Predictor 2 /Columns 0 >>', (rows) => zlibSync(rows))
    // In the worker first: a reader that hangs again fails there instead of hanging this run.
    expect((await inWorker('readPubSec', bytes)).result).toMatchObject({ recipients: 1 })
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    const t0 = performance.now()
    expect(await doc.open(bytes, { fileName: 'hostile.pdf' })).toMatchObject({ ok: false, needsCertificate: true })
    expect(await doc.checkFile(bytes, 'hostile.pdf')).toMatchObject({ needsCertificate: true })
    expect(performance.now() - t0).toBeLessThan(2000)
  })

  // /Columns 0, /Colors 0 or a negative value made the TIFF predictor loop step by 0 bytes.
  for (const parms of [
    '/Predictor 2 /Columns 0',
    '/Predictor 2 /Colors 0 /Columns 4',
    '/Predictor 2 /Columns -1',
    '/Predictor 2 /Colors -2 /Columns 4',
    '/Predictor 2 /Columns 1.5',
    '/Predictor 2 /Columns 99999999999',
    '/Predictor 12 /Columns 0',
    '/Predictor 12 /Columns -4',
    '/Predictor 12 /Colors 33 /Columns 4',
    '/Predictor 12 /BitsPerComponent 3 /Columns 4'
  ]) {
    it(`refuses ${parms} at once and falls back to scanning`, async () => {
      const bytes = xrefStreamFile(`/W [1 2 1] /Filter /FlateDecode /DecodeParms << ${parms} >>`, (rows) => zlibSync(rows))
      const decoded = await inWorker('decodeStream', zlibSync(new Uint8Array(4096).fill(7)), [`<< /Filter /FlateDecode /DecodeParms << ${parms} >> >>`])
      expect(decoded.result.error).toMatch(/predictor/i)
      expect(decoded.elapsed).toBeLessThan(1000)
      const read = await inWorker('readPubSec', bytes)
      expect(read.result).toEqual({ recipients: 1, damaged: true, version: 5 })
      expect(read.elapsed).toBeLessThan(1000)
    })
  }
})

// ---- xref streams -----------------------------------------------------------------------------

describe('cross-reference streams', () => {
  const zeros = (n: number) => new Uint8Array(n)
  // With /W [0 0 0] nothing ever ran out of data, so the loop made 4 billion entries (12 s, 1.5 GB).
  const hostile: [string, string, () => Uint8Array][] = [
    ['entries of no bytes and a huge /Index', '/W [0 0 0] /Index [0 4000000000]', () => zeros(0)],
    ['entries of no bytes', '/W [0 0 0]', () => zeros(0)],
    ['a huge /Index count', '/W [1 2 1] /Index [0 4000000000]', () => zeros(24)],
    ['/Index past the highest object number', '/W [1 2 1] /Index [8388604 6]', () => zeros(24)],
    ['a negative /Index start', '/W [1 2 1] /Index [-3 6]', () => zeros(24)],
    ['a negative /Index count', '/W [1 2 1] /Index [0 -6]', () => zeros(24)],
    ['a fractional /Index count', '/W [1 2 1] /Index [0 5.5]', () => zeros(24)],
    ['more /Index entries than /Size', '/W [1 2 1] /Index [0 6 0 6]', () => zeros(48)],
    ['a fractional /W', '/W [1 1.5 1]', () => zeros(24)],
    ['a /W entry over 8 bytes', '/W [1 9 1]', () => zeros(66)],
    // 20 MB of zeros in 20 KB: inflating stops once the output passes what 6 entries need.
    ['data that inflates far beyond its entries', '/W [0 0 1] /Index [0 4000000000] /Filter /FlateDecode', () => zlibSync(zeros(20 << 20))],
    ['a zip bomb', '/W [1 2 1] /Filter /FlateDecode', () => zlibSync(zeros(20 << 20))]
  ]
  for (const [what, dict, data] of hostile) {
    it(`refuses ${what} at once and falls back to scanning`, async () => {
      const bytes = xrefStreamFile(dict, data())
      const read = await inWorker('readXref', bytes)
      expect(read.result).toMatchObject({ damaged: true, root: true })
      expect(read.result.entries).toBeLessThan(10)
      expect(read.elapsed).toBeLessThan(1000)
      const info = await inWorker('readPubSec', bytes)
      expect(info.result).toEqual({ recipients: 1, damaged: true, version: 5 })
      expect(info.elapsed).toBeLessThan(1000)
    })
  }

  it('sound xref streams still read: two subsections and a PNG predictor', async () => {
    const png = (rows: Uint8Array) => {
      const out: number[] = []
      for (let r = 0; r < rows.length / 4; r++) out.push(0, ...rows.subarray(r * 4, r * 4 + 4))
      return zlibSync(Uint8Array.from(out))
    }
    const bytes = xrefStreamFile('/W [1 2 1] /Index [0 4 4 2] /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 4 >>', png)
    expect((await inWorker('readXref', bytes)).result).toEqual({ damaged: false, entries: 6, root: true })
  })

  it('decoding stops past the limit (64 MB unless told otherwise)', async () => {
    const flate = '<< /Filter /FlateDecode >>'
    const bomb = zlibSync(zeros(80 << 20))
    expect((await inWorker('decodeStream', bomb, [flate])).result.error).toMatch(/too long/)
    expect((await inWorker('decodeStream', bomb, [flate, 80 << 20])).result).toEqual({ length: 80 << 20 })
    const capped = await inWorker('decodeStream', bomb, [flate, 1 << 20])
    expect(capped.result.error).toMatch(/too long/)
    expect(capped.elapsed).toBeLessThan(1000)
    // Without a zlib header (the second try) the limit holds too.
    expect((await inWorker('decodeStream', Uint8Array.of(0, 0, ...bomb.subarray(2)), [flate, 1 << 20])).result.error).toMatch(/too long/)
  })

  it('a chain of sections that reads far more than the file is given up', async () => {
    // 40 xref streams chained by /Prev, each listing 300,000 free entries in 300 bytes: one is
    // allowed (a sound file of this size could have that many), the second is too many.
    const b = new Builder()
      .add('%PDF-1.7\n')
      .obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
      .obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
      .obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>')
      .obj(4, PUBSEC_ENCRYPT)
    const data = zlibSync(zeros(300_000))
    let prev = -1
    for (let k = 0; k < 40; k++) {
      const at = b.pos
      b.stream(10 + k, `<< /Type /XRef /Size 300000 /W [1 0 0] /Root 1 0 R /Encrypt 4 0 R /Filter /FlateDecode${prev >= 0 ? ` /Prev ${prev}` : ''} >>`, data)
      prev = at
    }
    b.add(`startxref\n${prev}\n%%EOF\n`)
    const read = await inWorker('readXref', b.bytes())
    expect(read.result).toMatchObject({ damaged: true, root: true })
    expect(read.elapsed).toBeLessThan(1000)
  })
})

// ---- damaged files ----------------------------------------------------------------------------

describe('scanning damaged files takes linear time', () => {
  const pdf = (body: string) => latin1(`%PDF-1.7\n${body}`)
  const x = 'x'.repeat(90)

  const damaged: [string, string][] = [
    // Each start inside the run made the header pattern rescan the rest of it.
    ['a long run of digits', '7'.repeat(400_000)],
    ['digits and spaces', '12 '.repeat(150_000)],
    // Each header (or trailer) was parsed to the end of the file.
    ['headers followed by unterminated strings', `1 0 obj (${x}\n`.repeat(8000)],
    ['headers followed by unterminated dictionaries', `1 0 obj << /A (${x}\n`.repeat(8000)],
    ['trailers followed by unterminated strings', `trailer << /Root 1 0 R /X (${x}\n`.repeat(8000)],
    ['headers in one long comment', '1 0 obj %'.repeat(60_000)]
  ]
  for (const [what, body] of damaged) {
    it(what, async () => {
      const bytes = pdf(body)
      const scan = await inWorker('scanXref', bytes)
      expect(scan.elapsed).toBeLessThan(1000)
      const read = await inWorker('readPubSec', bytes)
      expect(read.result).toBeNull()
      expect(read.elapsed).toBeLessThan(1000)
    })
  }

  it('a hundred thousand trailers: only the newest are read', async () => {
    const bytes = pdf(`1 0 obj << /Type /Catalog >> endobj\n4 0 obj ${PUBSEC_ENCRYPT} endobj\n${'trailer<</Root 1 0 R/Encrypt 4 0 R/Size 5>>\n'.repeat(100_000)}`)
    const read = await inWorker('readPubSec', bytes)
    expect(read.result).toEqual({ recipients: 1, damaged: true, version: 5 })
    expect(read.elapsed).toBeLessThan(1000)
    expect((await inWorker('scanXref', bytes)).result).toEqual({ entries: 2, trailers: 256 })
  })

  it('still finds the headers, the xref stream dictionary and the trailer', async () => {
    const bytes = pdf(
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
        '2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n' +
        '3 0 obj (unterminated\n' +
        '4 0 obj\n<< /Type /XRef /Size 5 /Root 1 0 R >>\nstream\nxx\nendstream\nendobj\n' +
        'x12 0 obj\n' +
        'trailer\n<< /Size 5 /Root 1 0 R >>\n'
    )
    // Objects 1 to 4 ("x12 0 obj" is not a header: one starts after a delimiter or white space).
    expect((await inWorker('scanXref', bytes)).result).toEqual({ entries: 4, trailers: 2 })
  })
})

// ---- /Recipients -------------------------------------------------------------------------------

describe('/Recipients over the limits', () => {
  /**
   * A one-page certificate-encrypted file with a classic xref table and `recipients` (PDF strings),
   * and object 5 when given.
   */
  function withRecipients(recipients: string, object5?: string): Uint8Array {
    const b = new Builder()
      .add('%PDF-1.7\n')
      .obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
      .obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
      .obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>')
      .obj(4, PUBSEC_ENCRYPT.replace('[<3082010a0201>]', `[${recipients}]`))
    if (object5 !== undefined) b.obj(5, object5)
    const nums = object5 === undefined ? [1, 2, 3, 4] : [1, 2, 3, 4, 5]
    const at = b.pos
    let xref = `xref\n0 ${nums.length + 1}\n0000000000 65535 f \n`
    for (const n of nums) xref += `${String(b.offsets.get(n)).padStart(10, '0')} 00000 n \n`
    return b.add(`${xref}trailer\n<< /Size ${nums.length + 1} /Root 1 0 R /Encrypt 4 0 R >>\nstartxref\n${at}\n%%EOF\n`).bytes()
  }

  async function opened(bytes: Uint8Array) {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    return { doc, open: doc.open(bytes, { fileName: 'many.pdf' }), check: doc.checkFile(bytes, 'many.pdf') }
  }

  it('a hundred envelopes still open (they ask for a certificate)', async () => {
    const bytes = withRecipients('<3082010a0201> '.repeat(100))
    expect((await inWorker('readPubSec', bytes)).result).toEqual({ recipients: 100, damaged: false, version: 5 })
    const { open, check } = await opened(bytes)
    expect(await open).toMatchObject({ ok: false, needsCertificate: true })
    expect(await check).toMatchObject({ needsCertificate: true })
  })

  // The main process refuses such certkeys:* requests, so the engine says why instead of asking.
  for (const [what, recipients] of [
    ['101 envelopes', '<3082010a0201> '.repeat(101)],
    ['an envelope over 1 MB', `<${'30'.repeat(1024 * 1024 + 1)}>`],
    ['over 4 MB in all', `<${'30'.repeat(1024 * 1024)}> `.repeat(5)]
  ]) {
    it(`${what}: the file does not open, and the message says why`, async () => {
      const { doc, open, check } = await opened(withRecipients(recipients))
      const refused = { code: 'CERTIFICATE_UNSUPPORTED', message: expect.stringMatching(/more recipients than Fartcrobat can read/) }
      await expect(open).rejects.toMatchObject(refused)
      await expect(check).rejects.toMatchObject(refused)
      // Nothing is left waiting for a certificate.
      await expect(doc.unlockCertificate(keyFor('v5-classic.pdf', 'alice', pubsecFixture('v5-classic.pdf')))).rejects.toMatchObject({
        code: 'NO_PENDING'
      })
    })
  }

  // Every reference re-reads the object it points at: 5000 references to a 20,000-element array
  // took over a minute before the work was bounded.
  for (const refs of [99, 5000]) {
    it(`${refs} references to one large object are refused at once`, async () => {
      const bytes = withRecipients(`<3082010a0201> ${'5 0 R '.repeat(refs)}`, `[${'0 '.repeat(20000)}]`)
      const read = await inWorker('readPubSec', bytes)
      expect(read.result).toEqual({ error: expect.stringMatching(/more recipients than Fartcrobat can read/) })
      expect(read.elapsed).toBeLessThan(1000)
    })
  }

  it('a few references to a string object still read', async () => {
    const bytes = withRecipients('5 0 R 5 0 R', '<3082010a0201>')
    expect((await inWorker('readPubSec', bytes)).result).toEqual({ recipients: 2, damaged: false, version: 5 })
  })
})

describe('the key check reads a bounded amount', () => {
  // Each `(xxxx` opens a string that never ends: reading it goes to the end of the file. Before
  // they counted, 6000 of them took about 10 s to unlock.
  const FILE = 'v5-classic.pdf'
  function withUnterminated(count: number): Uint8Array {
    const bytes = pubsecFixture(FILE)
    const info = readPubSec(bytes)!
    return appendUpdate(bytes, info, Array.from({ length: count }, (_, k) => ({ num: info.trailer.size + k, gen: 0, source: '(xxxx' })))
  }

  it('objects that do not parse count against the budget', async () => {
    const bytes = withUnterminated(6000)
    const info = readPubSec(bytes)!
    const K = fileKey(info, keyFor(FILE, 'alice', bytes).seed)
    let t0 = performance.now()
    verifyFileKey(bytes, info, K)
    expect(performance.now() - t0).toBeLessThan(1000)
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    await doc.open(bytes, { fileName: FILE })
    t0 = performance.now()
    const res = await doc.unlockCertificate(keyFor(FILE, 'alice', bytes)).catch((err: { code?: string }) => ({ ok: false, code: err.code }))
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(res).toMatchObject({ ok: true })
  })

  it('streams whose /Length refers to an object that does not parse count what that costs', () => {
    // Exempt streams (xref streams are never checked) parse fine, but each /Length lookup read
    // object `bad` to the end of the file.
    const bytes = pubsecFixture(FILE)
    const info = readPubSec(bytes)!
    const bad = info.trailer.size
    const objects = [{ num: bad, gen: 0, source: '(xxxx' }]
    for (let k = 1; k <= 4000; k++)
      objects.push({ num: bad + k, gen: 0, source: `<< /Type /XRef /Length ${bad} 0 R >>\nstream\nxx\nendstream` })
    const hostile = appendUpdate(bytes, info, objects)
    const hostileInfo = readPubSec(hostile)!
    const t0 = performance.now()
    verifyFileKey(hostile, hostileInfo, fileKey(hostileInfo, keyFor(FILE, 'alice', hostile).seed))
    expect(performance.now() - t0).toBeLessThan(1000)
  })

  it('a V4 file made of such objects is refused before the decrypt pass reads them all', async () => {
    // MuPDF reads every object in the decrypt pass, each to the end of the file: about 8 s for these.
    const V4 = 'v4-rc4.pdf'
    const bytes = pubsecFixture(V4)
    const info = readPubSec(bytes)!
    const hostile = appendUpdate(bytes, info, Array.from({ length: 4000 }, (_, k) => ({ num: info.trailer.size + k, gen: 0, source: '(xxxx' })))
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    await doc.open(hostile, { fileName: V4 })
    const t0 = performance.now()
    await expect(doc.unlockCertificate(keyFor(V4, 'alice', hostile))).rejects.toMatchObject({
      code: 'CERTIFICATE_OPEN_FAILED',
      message: expect.stringMatching(/it is damaged/)
    })
    expect(performance.now() - t0).toBeLessThan(2000)
    // The same file with a few such objects still opens.
    const few = appendUpdate(bytes, info, Array.from({ length: 3 }, (_, k) => ({ num: info.trailer.size + k, gen: 0, source: '(xxxx' })))
    const e = await openWithKey(few, keyFor(V4, 'alice', few))
    expect(e.info.pageCount).toBe(expected(V4).pages)
  })

  it('in-use entries at offset 0 (MuPDF reads them as free) cost nothing: the file opens and a wrong seed is refused', async () => {
    // Some writers list new objects at offset 0. Charged as a read to the end of the file, 12 of
    // them refused a 1 MB V4 file and 3 made the key check accept any seed.
    const V4 = 'v4-rc4.pdf'
    const base = concat([pubsecFixture(V4), latin1(`%${'x'.repeat(1 << 20)}\n`)])
    const info = readPubSec(base)!
    const nums = Array.from({ length: 16 }, (_, k) => info.trailer.size + k)
    const appended = appendUpdate(base, info, nums.map((num) => ({ num, gen: 0, source: 'null' })))
    const tail = toLatin1(appended.subarray(base.length)).replace(/\d{10} 00000 n\r\n/g, '0000000000 00000 n\r\n')
    const bytes = concat([base, latin1(tail)])
    const zeroInfo = readPubSec(bytes)!
    expect(nums.every((n) => zeroInfo.xref.entries.get(n)?.type === 1 && (zeroInfo.xref.entries.get(n) as { offset: number }).offset === 0)).toBe(true)
    const seed = keyFor(V4, 'alice', bytes).seed
    expect(verifyFileKey(bytes, zeroInfo, fileKey(zeroInfo, seed))).toBe(true)
    expect(verifyFileKey(bytes, zeroInfo, fileKey(zeroInfo, seed.map((x, i) => (i === 0 ? x ^ 1 : x))))).toBe(false)
    const e = await openWithKey(bytes, keyFor(V4, 'alice', bytes))
    expect(e.info.pageCount).toBe(expected(V4).pages)
  })

  it('a sound file still checks the key: a wrong seed is refused', () => {
    const bytes = withUnterminated(10)
    const info = readPubSec(bytes)!
    const seed = keyFor(FILE, 'alice', bytes).seed
    expect(verifyFileKey(bytes, info, fileKey(info, seed))).toBe(true)
    expect(verifyFileKey(bytes, info, fileKey(info, seed.map((x, i) => (i === 0 ? x ^ 1 : x))))).toBe(false)
  })
})

// ---- the RC4 key check --------------------------------------------------------------------------

describe('the RC4 key check', () => {
  const FILE = 'v4-rc4.pdf'
  const K = () => hexBytes(expected(FILE).fileKeyHex)

  /** The RC4 key of one object (ISO 32000-2, algorithm 1). */
  const objectKey = (k: Uint8Array, num: number, gen: number) =>
    md5(concat([k, Uint8Array.of(num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255)])).slice(0, Math.min(k.length + 5, 16))

  /** Binary image samples: bytes above 127, never text. */
  const samples = (seed: number) => Uint8Array.from({ length: 300 }, (_, i) => 128 + ((i * 37 + seed * 101) % 128))

  /** v4-rc4.pdf with an update that adds unfiltered images, encrypted with the right keys. */
  function withRawImages(count: number): { bytes: Uint8Array; nums: number[] } {
    const bytes = pubsecFixture(FILE)
    const info = readPubSec(bytes)!
    const nums = Array.from({ length: count }, (_, k) => info.trailer.size + k)
    const objects = nums.map((num, k) => {
      const data = toLatin1(rc4(objectKey(K(), num, 0), samples(k)))
      const dict = `<< /Type /XObject /Subtype /Image /Width 10 /Height 10 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${data.length} >>`
      return { num, gen: 0, source: `${dict}\nstream\n${data}\nendstream` }
    })
    return { bytes: appendUpdate(bytes, info, objects), nums }
  }

  it('unfiltered binary streams do not outvote the right key (they are newest, so they come first)', async () => {
    const { bytes, nums } = withRawImages(5)
    const info = readPubSec(bytes)!
    expect([...info.xref.entries.keys()].filter((n) => n > 0).slice(0, 5)).toEqual(nums)
    expect(verifyFileKey(bytes, info, K())).toBe(true)
    const e = await openWithKey(bytes, keyFor(FILE, 'alice', bytes))
    expect(e.info.pageCount).toBe(expected(FILE).pages)
    // The images were decrypted with the rest.
    expect(new Uint8Array(e.session.pdf.newIndirect(nums[2]).readRawStream().asUint8Array())).toEqual(samples(2))
  })

  it('a wrong key is still refused', () => {
    for (const bytes of [pubsecFixture(FILE), withRawImages(5).bytes]) {
      const info = readPubSec(bytes)!
      for (let flip = 0; flip < 16; flip++) {
        const wrong = K().map((x, i) => (i === flip ? x ^ 0x5a : x))
        expect(verifyFileKey(bytes, info, wrong)).toBe(false)
      }
    }
  })
})

// ---- a direct /Info dictionary ------------------------------------------------------------------

describe('a direct /Info dictionary in the trailer', () => {
  /** A plain one-page file whose trailer holds /Info as a dictionary (not conforming, but it occurs). */
  function directInfoFile(title: string): Uint8Array {
    const content = 'BT /F1 24 Tf 20 100 Td (PageSecret) Tj ET'
    const b = new Builder()
      .add('%PDF-1.7\n')
      .obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
      .obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
      .obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>')
      .stream(4, '<< >>', latin1(content))
      .obj(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
    const at = b.pos
    let table = 'xref\n0 6\n0000000000 65535 f\r\n'
    for (let n = 1; n < 6; n++) table += `${String(b.offsets.get(n)).padStart(10, '0')} 00000 n\r\n`
    b.add(`${table}trailer\n<< /Size 6 /Root 1 0 R /Info << /Title (${title}) /Author (AuthorSecret) >> >>\nstartxref\n${at}\n%%EOF\n`)
    return b.bytes()
  }

  /** `text` is nowhere in `bytes`, neither as written nor as a hex string. */
  function expectNotInClear(bytes: Uint8Array, text: string, label: string) {
    expect(includesBytes(bytes, text), `${label}: "${text}"`).toBe(false)
    const hex = toHex(latin1(text))
    const all = Buffer.from(bytes).toString('latin1').toLowerCase()
    expect(all.includes(hex), `${label}: "${text}" in hex`).toBe(false)
  }

  const fakeEnvelope = () => latin1('not a real envelope: the key below is given to the engine directly')

  it('MuPDF keeps it direct through a full save (why the writer has to move it)', () => {
    const doc = new mupdf.PDFDocument(directInfoFile('DirectInfoSecret'))
    try {
      const saved = new mupdf.PDFDocument(doc.saveToBuffer('garbage=compact').asUint8Array().slice())
      expect(saved.getTrailer().get('Info').isIndirect()).toBe(false)
      expect(saved.getMetaData('info:Title')).toBe('DirectInfoSecret')
      saved.destroy()
    } finally {
      doc.destroy()
    }
  })

  it('the writer encrypts it like any other object, and it opens again', async () => {
    const seed = randomBytes(20)
    const envelope = fakeEnvelope()
    const doc = new mupdf.PDFDocument(directInfoFile('DirectInfoSecret'))
    let out: Uint8Array
    try {
      out = writePubSecDocument(mupdf, doc, writeKeyFor(seed, [envelope]))
    } finally {
      doc.destroy()
    }
    for (const s of ['DirectInfoSecret', 'AuthorSecret', 'PageSecret']) expectNotInClear(out, s, 'written')
    const e = await openWithKey(out, { envelope, seed, permissions: null })
    expect(e.info.metadata).toMatchObject({ title: 'DirectInfoSecret', author: 'AuthorSecret' })
  })

  it('serialising refuses a trailer that still holds a dictionary', () => {
    const doc = new mupdf.PDFDocument(directInfoFile('DirectInfoSecret'))
    try {
      const recipients = [fakeEnvelope()]
      const key = writeKeyFor(randomBytes(20), recipients)
      encryptObjectsInPlace(doc, key.fileKey)
      expect(() => serialiseEncrypted(doc, pubsecEncryptDict(recipients))).toThrow(/clear/)
    } finally {
      doc.destroy()
    }
  })

  it('Encrypt with Certificate (the engine save)', async () => {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    expect(await doc.open(directInfoFile('DirectInfoSecret'), { fileName: 'direct.pdf' })).toMatchObject({ ok: true })
    const cert = new Uint8Array(readFileSync(resolve(PKI, 'alice.cer')))
    const out = await doc.save({ mode: 'full', encryptCertificate: { groups: [{ certificates: [cert], permissions: {} }] } })
    expect(readPubSec(out)?.version).toBe(5)
    for (const s of ['DirectInfoSecret', 'AuthorSecret', 'PageSecret']) expectNotInClear(out, s, 'Encrypt with Certificate')
    // The engine keeps the new key: the output opens again without asking, with its title.
    const res: OpenResult = await doc.reload(out, {})
    expect(res).toMatchObject({ ok: true })
    if (res.ok) expect(res.info.metadata.title).toBe('DirectInfoSecret')
  })

  it('saving back a certificate-encrypted document whose newest trailer holds one', async () => {
    const seed = randomBytes(20)
    const envelope = fakeEnvelope()
    const key: CertificateKey = { envelope, seed, permissions: null }
    const doc = new mupdf.PDFDocument(directInfoFile('FirstTitle'))
    let first: Uint8Array
    try {
      first = writePubSecDocument(mupdf, doc, writeKeyFor(seed, [envelope]))
    } finally {
      doc.destroy()
    }
    // An update (as another writer might append) whose trailer has /Info as a dictionary in clear.
    const direct = new Map([['Title', new PdfString(latin1('SavedBackSecret'))]])
    const updated = appendUpdate(first, readPubSec(first)!, [], { Info: direct })
    expect(includesBytes(updated, toHex(latin1('SavedBackSecret')))).toBe(true)
    const e = await openWithKey(updated, key)
    expect(e.info.metadata.title).toBe('SavedBackSecret')
    const saved = await e.doc.save({})
    expect(readPubSec(saved)?.version).toBe(5)
    expectNotInClear(saved, 'SavedBackSecret', 'saved back')
    const again = await openWithKey(saved, key)
    expect(again.info.metadata.title).toBe('SavedBackSecret')
  })
})

// ---- what a tab reports after it saves -----------------------------------------------------------

describe('after a certificate-encrypted document is saved to its file', () => {
  const sig = (e: Engine) => e.ops<typeof sigOps>('digital-signatures')
  const comment = (e: Engine) => e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'note' })
  const facts = async (e: Engine) => {
    const lock = await e.doc.certificateLock()
    const security = await e.ops<typeof protectOps>('protect-optimize').security()
    return { encryption: (await e.doc.facts()).encryption, lock: lock && { version: lock.version, cipher: lock.cipher, keyBits: lock.keyBits }, method: security.method }
  }

  it('signatures are validated against the file just written, which they no longer cover', async () => {
    const e = await openFixtureAs('v5-signed.pdf', 'alice')
    const before = await sig(e).validate()
    expect(before.signatures.map((r) => [r.integrity, r.signatureValid, r.coversWholeFile])).toEqual([[true, true, true]])
    await comment(e)
    // Save a Copy: the tab's file has not changed.
    await e.doc.save({})
    expect((await sig(e).validate()).signatures[0].integrity).toBe(true)
    // Save: the file is rewritten in full.
    const { bytes, version } = await e.doc.saveWithVersion({})
    await e.doc.markSaved('v5-signed.pdf', version)
    const live = await sig(e).validate()
    // As a fresh engine reports the saved file.
    const fresh = await sig(await openWithKey(bytes, keyFor('v5-signed.pdf', 'alice'))).validate()
    expect(fresh.signatures[0].integrity).toBe(false)
    expect(live.signatures.map((r) => [r.integrity, r.signatureValid, r.problems])).toEqual(fresh.signatures.map((r) => [r.integrity, r.signatureValid, r.problems]))
  })

  it('a V4 file is described as the V5 AES-256 file it became', async () => {
    const e = await openFixtureAs('v4-rc4.pdf', 'alice')
    const v4 = { encryption: 'Adobe.PubSec V4 128-bit RC4', lock: { version: 4, cipher: 'RC4', keyBits: 128 }, method: '128-bit RC4' }
    expect(await facts(e)).toEqual(v4)
    // Save a Copy, and a save whose file was not written: nothing changes.
    await e.doc.save({})
    await e.doc.saveWithVersion({})
    expect(await facts(e)).toEqual(v4)
    // Saved, then changed before markSaved: the file holds the saved version, which is V5.
    const { bytes, version } = await e.doc.saveWithVersion({})
    await comment(e)
    await e.doc.markSaved('v4-rc4.pdf', version)
    expect(readPubSec(bytes)).toMatchObject({ version: 5, cipher: 'AESV3' })
    expect(await facts(e)).toEqual({ encryption: 'Adobe.PubSec V5 256-bit AES', lock: { version: 5, cipher: 'AESV3', keyBits: 256 }, method: '256-bit AES' })
    expect(await e.doc.isDirty()).toBe(true)
    // It keeps working: the next save still opens with the same key.
    const next = await e.doc.save({})
    const again = await openWithKey(next, keyFor('v4-rc4.pdf', 'alice'))
    expect(again.info.encryption).toBe('Adobe.PubSec V5 256-bit AES')
  })

  it('a save whose version is not the one marked saved is not adopted', async () => {
    const e = await openFixtureAs('v4-rc4.pdf', 'alice')
    const { version } = await e.doc.saveWithVersion({})
    await comment(e)
    // Another save at a later version replaced it; marking the earlier version adopts nothing.
    await e.doc.saveWithVersion({})
    await e.doc.markSaved('v4-rc4.pdf', version)
    expect((await e.doc.facts()).encryption).toBe('Adobe.PubSec V4 128-bit RC4')
    // Nor after a save with other security (Remove Security reloads the tab from what it wrote).
    const again = await e.doc.saveWithVersion({})
    expect(await e.doc.save({ mode: 'full', decrypt: true })).toBeInstanceOf(Uint8Array)
    await e.doc.markSaved('v4-rc4.pdf', again.version)
    expect((await e.doc.facts()).encryption).toBe('Adobe.PubSec V4 128-bit RC4')
  })
})
