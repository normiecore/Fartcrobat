// Saving certificate-encrypted documents: always in full, with the original seed and envelopes
// (V4 files upgraded to V5, AES-256), never with the temporary bridge or any plaintext; Remove
// Security and password security from them; reload and revert with a key the engine holds.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mupdf from 'mupdf'
import { afterAll, describe, expect, it } from 'vitest'
import { assertNoBridge, readPubSec, writeKeyFor, writePubSecDocument, type PubSecState } from '@engine/crypt'
import { createLocalEngine } from '@engine/local'
import type annotOps from '@engine/ops/annots'
import type docOps from '@engine/ops/doc'
import type { CertificateKey } from '@shared/certkeys'
import { fixture } from './helpers'
import {
  EXPECTED,
  expected,
  hexBytes,
  includesBytes,
  keyFor,
  openFixtureAs,
  openWithKey,
  pageText,
  PKI,
  pubsecFixture,
  type Engine
} from './passwordless-helpers'
import { hasPyHanko } from './pyhanko'

const NOTE = 'Note text in an object stream'
const PLAINTEXT = ['Hello secret world', NOTE, 'Secret title', 'Field value', 'xmp-marker-123', 'Page two text']

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')

async function addNote(e: Engine, text: string) {
  await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: text })
}

async function notes(e: Engine): Promise<string[]> {
  return (await e.ops<typeof annotOps>('annots').list(0)).filter((a) => a.type === 'Text').map((a) => a.contents)
}

/** No plaintext, no Standard handler, the original envelopes, V5 AES-256. */
function expectSealed(out: Uint8Array, original: Uint8Array, label: string) {
  for (const s of PLAINTEXT) expect(includesBytes(out, s), `${label}: "${s}" in clear`).toBe(false)
  expect(/\/Filter\s*\/Standard/.test(Buffer.from(out).toString('latin1')), `${label}: Standard handler`).toBe(false)
  const info = readPubSec(out)!
  expect(info, label).not.toBeNull()
  expect(info.version).toBe(5)
  expect(info.cipher).toBe('AESV3')
  expect(info.encryptMetadata).toBe(true)
  expect(info.recipients.map(toHex)).toEqual(readPubSec(original)!.recipients.map(toHex))
}

describe('saving back', () => {
  it('edit, save, reopen with the same key', async () => {
    const original = pubsecFixture('v5-classic.pdf')
    const key = keyFor('v5-classic.pdf', 'alice', original)
    const e = await openWithKey(original, key, 'v5-classic.pdf')
    await addNote(e, 'Added after a certificate open')
    const out = await e.doc.save({})
    expectSealed(out, original, 'v5-classic')
    expect(includesBytes(out, 'Added after a certificate open')).toBe(false)
    const again = await openWithKey(out, key)
    expect(await pageText(again)).toContain('Hello secret world')
    expect(await notes(again)).toEqual([NOTE, 'Added after a certificate open'])
    expect(again.info.metadata.title).toBe('Secret title')
    expect(again.info.wasRepaired).toBe(false)
    // The live document keeps its history.
    expect((await e.doc.journal()).canUndo).toBe(true)
    await e.doc.undo()
    expect(await notes(e)).toEqual([NOTE])
  })

  it('reopens as the other recipient of the same envelope', async () => {
    const original = pubsecFixture('v5-two-recipients.pdf')
    const e = await openWithKey(original, keyFor('v5-two-recipients.pdf', 'alice', original))
    await addNote(e, 'For bob')
    const out = await e.doc.save({})
    const bob = await openWithKey(out, keyFor('v5-two-recipients.pdf', 'bob', original))
    expect(await notes(bob)).toEqual([NOTE, 'For bob'])
  })

  it('keeps each envelope’s permissions (two envelopes)', async () => {
    const original = pubsecFixture('v5-two-envelopes.pdf')
    const e = await openWithKey(original, keyFor('v5-two-envelopes.pdf', 'alice', original))
    const out = await e.doc.save({})
    expectSealed(out, original, 'v5-two-envelopes')
    const alice = await openWithKey(out, keyFor('v5-two-envelopes.pdf', 'alice', original))
    expect(alice.info.permissions.edit).toBe(false)
    expect(alice.info.permissions.print).toBe(true)
    const bob = await openWithKey(out, keyFor('v5-two-envelopes.pdf', 'bob', original))
    expect(bob.info.permissions.edit).toBe(true)
  })

  it('V4 files are upgraded to V5 AES-256 with the same seed and envelopes', async () => {
    for (const file of ['v4-aes128.pdf', 'v4-aes128-objstm.pdf', 'v4-rc4.pdf']) {
      const original = pubsecFixture(file)
      const key = keyFor(file, 'alice', original)
      const e = await openWithKey(original, key, file)
      const out = await e.doc.save({})
      expectSealed(out, original, file)
      const again = await openWithKey(out, key)
      expect(again.info.encryption, file).toBe('Adobe.PubSec V5 256-bit AES')
      expect(again.session.pubsec?.seed && toHex(again.session.pubsec.seed)).toBe(expected(file).seedHex.alice)
      expect(await notes(again), file).toEqual([NOTE])
      expect(again.info.metadata.title).toBe('Secret title')
    }
  })

  it('no output of any fixture holds plaintext or a Standard handler', async () => {
    for (const e of EXPECTED.filter((x) => x.title === 'Secret title')) {
      const person = e.opensWith[0]
      const original = pubsecFixture(e.file)
      const eng = await openWithKey(original, keyFor(e.file, person, original), e.file)
      for (const [label, opts] of [
        ['default', {}],
        ['compact, no compression', { garbage: 'compact', compress: false }],
        ['deduplicate and clean', { garbage: 'deduplicate', clean: true, sanitize: true }]
      ] as const) {
        const out = await eng.doc.save(opts)
        expectSealed(out, original, `${e.file} ${label}`)
        const again = await openWithKey(out, keyFor(e.file, person, original))
        expect(await pageText(again), `${e.file} ${label}`).toContain('Hello secret world')
        expect(again.info.metadata.title, `${e.file} ${label}`).toBe(e.expectedTitle)
      }
    }
  })

  it('V5 files without encrypted metadata are written with encrypted metadata, XMP included', async () => {
    const original = pubsecFixture('v5-nometa.pdf')
    expect(includesBytes(original, 'xmp-marker-123')).toBe(true)
    const key = keyFor('v5-nometa.pdf', 'alice', original)
    const e = await openWithKey(original, key)
    const out = await e.doc.save({})
    expectSealed(out, original, 'v5-nometa')
    const again = await openWithKey(out, key)
    expect(again.session.pubsec?.route).toBe('bridge')
    const meta = again.session.pdf.getTrailer().get('Root').get('Metadata')
    expect(new TextDecoder().decode(meta.readStream().asUint8Array())).toContain('xmp-marker-123')
  })

  it('incremental saves are refused; auto saves a signed document in full', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    await expect(e.doc.save({ mode: 'incremental' })).rejects.toMatchObject({ code: 'CERTIFICATE_FULL_SAVE' })
    const original = pubsecFixture('v5-signed.pdf')
    const signed = await openWithKey(original, keyFor('v5-signed.pdf', 'alice', original))
    expect(signed.info.signatureCount).toBe(1)
    const out = await signed.doc.save({ mode: 'auto' })
    expectSealed(out, original, 'v5-signed')
    const text = Buffer.from(out).toString('latin1')
    expect(text.match(/%%EOF/g)?.length).toBe(1)
    expect(Buffer.from(out.subarray(0, 64)).equals(Buffer.from(original.subarray(0, 64)))).toBe(false)
    const again = await openWithKey(out, keyFor('v5-signed.pdf', 'alice', original))
    expect(again.info.signatureCount).toBe(1)
  })

  it('Save As keeps the encryption', async () => {
    const original = pubsecFixture('v5-objstm.pdf')
    const key = keyFor('v5-objstm.pdf', 'alice', original)
    const e = await openWithKey(original, key, 'v5-objstm.pdf')
    await addNote(e, 'Saved as')
    const { bytes, version } = await e.doc.saveWithVersion({})
    await e.doc.markSaved('copy.pdf', version)
    expect(await e.doc.isDirty()).toBe(false)
    expect((await e.doc.info()).security).toBe('certificate')
    const second = await e.doc.save({})
    for (const out of [bytes, second]) {
      expectSealed(out, original, 'save as')
      expect(await notes(await openWithKey(out, key))).toEqual([NOTE, 'Saved as'])
    }
  })

  it('pages inserted from another certificate-encrypted file are saved with the document’s own security', async () => {
    const original = pubsecFixture('v4-aes128.pdf')
    const key = keyFor('v4-aes128.pdf', 'alice', original)
    const e = await openWithKey(original, key, 'v4-aes128.pdf')
    const other = pubsecFixture('text-v5.pdf')
    await e.doc.addCertificateKey(keyFor('text-v5.pdf', 'bob', other))
    await e.ops<typeof import('@engine/ops/pages').default>('pages').insertFrom(-1, other, { fileName: 'text-v5.pdf' })
    const out = await e.doc.save({})
    expectSealed(out, original, 'inserted')
    const again = await openWithKey(out, key)
    expect(again.info.pageCount).toBe(7)
    expect(await pageText(again, 2)).toBe(await pageText(await openWithKey(other, keyFor('text-v5.pdf', 'bob', other)), 0))
  })

  it('new certificate security needs recipients (passwordless-create.test.ts tests the rest)', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    await expect(e.doc.save({ encryptCertificate: { groups: [] } })).rejects.toMatchObject({ code: 'NO_RECIPIENTS' })
  })
})

describe('changing the security', () => {
  it('Remove Security writes a plain file that opens without keys', async () => {
    const e = await openFixtureAs('v4-rc4.pdf', 'alice')
    const out = await e.doc.save({ decrypt: true })
    expect(readPubSec(out)).toBeNull()
    const plain = await createLocalEngine()
    const res = await plain.ops<typeof docOps>('doc').open(out, { fileName: 'plain.pdf' })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.info.security).toBeNull()
    expect(res.info.metadata.title).toBe('Secret title')
    expect(includesBytes(out, 'xmp-marker-123')).toBe(true)
    // The open document keeps its certificate security.
    expect((await e.doc.info()).security).toBe('certificate')
    expectSealed(await e.doc.save({}), pubsecFixture('v4-rc4.pdf'), 'after remove security')
  })

  it('password security replaces certificate security', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    const out = await e.doc.save({
      encrypt: { method: 'aes-256', userPassword: 'new', ownerPassword: 'own', permissions: {} }
    })
    expect(readPubSec(out)).toBeNull()
    for (const s of PLAINTEXT) expect(includesBytes(out, s), s).toBe(false)
    const other = await createLocalEngine()
    const doc = other.ops<typeof docOps>('doc')
    expect(await doc.open(out, { fileName: 'p.pdf' })).toMatchObject({ ok: false, needsPassword: true })
    const res = await doc.authenticate('new')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.info.security).toBe('password')
    expect(await other.ops<typeof import('@engine/ops/text').default>('text').plain(0)).toContain('Hello secret world')
  })

  it('a recipient who may not change the security cannot remove or replace it', async () => {
    const e = await openFixtureAs('v5-two-envelopes.pdf', 'alice')
    await expect(e.doc.save({ decrypt: true })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    await expect(
      e.doc.save({ encrypt: { method: 'aes-128', userPassword: 'x', ownerPassword: 'y', permissions: {} } })
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
    expect((await e.doc.save({})).length).toBeGreaterThan(0)
  })
})

describe('reload and revert', () => {
  it('reload and revert with a key the engine holds open without asking', async () => {
    const original = pubsecFixture('v5-incremental.pdf')
    const e = await openWithKey(original, keyFor('v5-incremental.pdf', 'alice', original), 'v5-incremental.pdf')
    await e.doc.setMetadata({ title: 'Changed' })
    const saved = await e.doc.save({})
    const reloaded = await e.doc.reload(saved, {})
    expect(reloaded.ok).toBe(true)
    if (reloaded.ok) {
      expect(reloaded.access).toBe('owner')
      expect(reloaded.info.metadata.title).toBe('Changed')
      expect(reloaded.info.security).toBe('certificate')
    }
    const reverted = await e.doc.reload(original, {})
    expect(reverted.ok).toBe(true)
    if (reverted.ok) expect(reverted.info.metadata.title).toBe('Updated secret title')
    expect(e.session.fileName).toBe('v5-incremental.pdf')
  })

  it('a plain document reloaded over a certificate-encrypted one is plain', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    const res = await e.doc.reload(pubsecFixture('source.pdf'), {})
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.info.security).toBeNull()
    expect(e.session.pubsec).toBeNull()
    expect(await e.doc.certificateLock()).toBeNull()
  })
})

describe('nothing of the bridge or the plaintext leaves the engine', () => {
  it('lockInfo is null and certificateLock has only public data', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    expect(e.session.pubsec?.route).toBe('bridge')
    expect(await e.doc.lockInfo()).toBeNull()
    const lock = await e.doc.certificateLock()
    expect(Object.keys(lock!).sort()).toEqual(['cipher', 'keyBits', 'recipients', 'version'])
    const info = JSON.stringify(await e.doc.info())
    const bridge = e.session.pubsec!.bridge!
    for (const v of [toHex(bridge.U), toHex(bridge.O), bridge.userPassword, bridge.ownerPassword]) expect(info).not.toContain(v)
    expect(info).not.toContain('Standard')
  })

  it('Extract gives certificate-encrypted pages or nothing (bridge and decrypted sessions)', async () => {
    for (const file of ['v5-classic.pdf', 'v4-rc4.pdf']) {
      const original = pubsecFixture(file)
      const e = await openWithKey(original, keyFor(file, 'alice', original), file)
      const pages = e.ops<typeof import('@engine/ops/pages').default>('pages')
      const out = await pages.extract([0]).then(
        (b) => b,
        (err: Error) => err
      )
      if (out instanceof Uint8Array) {
        expectSealed(out, original, `extract ${file}`)
        assertNoBridge(out, e.session.pubsec)
      } else {
        expect(out, file).toBeInstanceOf(Error)
      }
    }
  })
})

describe('assertNoBridge', () => {
  const fakeState = (U: Uint8Array): PubSecState =>
    ({ bridge: { userPassword: 'user-one-time', ownerPassword: 'owner-one-time', U, O: new Uint8Array(48).fill(7) } }) as PubSecState

  it('refuses output that carries the bridge', () => {
    const U = new Uint8Array(48).map((_, i) => i + 1)
    const state = fakeState(U)
    const enc = new TextEncoder()
    expect(() => assertNoBridge(enc.encode('%PDF-1.7 /Filter/Adobe.PubSec'), state)).not.toThrow()
    expect(() => assertNoBridge(enc.encode('%PDF-1.7 /Filter /Standard /V 5'), state)).toThrow(/password security/)
    expect(() => assertNoBridge(enc.encode(`<${toHex(U)}>`), state)).toThrow(/temporary/)
    expect(() => assertNoBridge(enc.encode(`<${toHex(U).toUpperCase()}>`), state)).toThrow(/temporary/)
    expect(() => assertNoBridge(Buffer.concat([Buffer.from('('), Buffer.from(U), Buffer.from(')')]), state)).toThrow(/temporary/)
    expect(() => assertNoBridge(enc.encode('x user-one-time x'), state)).toThrow(/temporary password/)
    expect(() => assertNoBridge(enc.encode('/Filter/Standard'), state, 'password')).not.toThrow()
    expect(() => assertNoBridge(enc.encode('trailer <</Encrypt 3 0 R>> startxref 0 %%EOF'), state, 'plain')).toThrow()
  })
})

// ---- cross-check with pyHanko --------------------------------------------------------------

const PY_READ = `
import sys, json
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.pdf_utils.crypt import SimpleEnvelopeKeyDecrypter
from pyhanko.pdf_utils import generic
path, key, cert = sys.argv[1:4]
r = PdfFileReader(open(path, 'rb'))
res = r.decrypt_pubkey(SimpleEnvelopeKeyDecrypter.load(key, cert))
pages = []
def walk(node):
    if node.get('/Type') == '/Page':
        pages.append(node)
        return
    for k in node['/Kids']:
        walk(k.get_object())
walk(r.root['/Pages'])
def text(p):
    c = p['/Contents']
    if isinstance(c, generic.ArrayObject):
        return b''.join(x.get_object().data for x in c)
    return c.get_object().data
annots = pages[0]['/Annots'] if '/Annots' in pages[0] else []
notes = [str(a.get_object()['/Contents']) for a in annots if a.get_object()['/Subtype'] == '/Text']
print(json.dumps({'status': res.status.name, 'version': int(r.encrypt_dict['/V']), 'pages': [text(p).decode('latin1') for p in pages],
                  'title': str(r.trailer_view['/Info']['/Title']), 'notes': notes}))
`

describe.skipIf(!hasPyHanko())('pyHanko opens saved files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fartcrobat-pubsec-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  for (const file of ['v5-classic.pdf', 'v5-objstm.pdf', 'v4-rc4.pdf', 'v4-aes128-objstm.pdf', 'v5-nometa.pdf', 'v5-two-envelopes.pdf']) {
    it(file, async () => {
      const original = pubsecFixture(file)
      const e = await openWithKey(original, keyFor(file, 'alice', original), file)
      await addNote(e, 'Checked by pyHanko')
      const out = await e.doc.save({})
      const path = join(dir, file)
      writeFileSync(path, out)
      const run = spawnSync('python3', ['-I', '-c', PY_READ, path, join(PKI, 'alice.key'), join(PKI, 'alice.crt')], { encoding: 'utf8' })
      expect(run.status, run.stderr).toBe(0)
      const got = JSON.parse(run.stdout)
      expect(got.status).toBe('USER')
      expect(got.version).toBe(5)
      expect(got.pages.length).toBe(2)
      expect(got.pages[0]).toContain('Hello secret world')
      expect(got.pages[1]).toContain('Page two text')
      expect(got.title).toBe('Secret title')
      expect(got.notes).toEqual([NOTE, 'Checked by pyHanko'])
      // MuPDF reads the same text.
      expect(await pageText(await openWithKey(out, keyFor(file, 'alice', original)))).toContain('Hello secret world')
    })
  }
})

// ---- timings (reported, not asserted) ------------------------------------------------------

/** A ~5 MB PDF: pages of text.pdf, each with an uncompressible 100 KB image. */
function syntheticPdf(targetBytes: number): Uint8Array {
  const text = new mupdf.PDFDocument(fixture('text.pdf'))
  const doc = new mupdf.PDFDocument()
  const side = 184 // 184 x 184 RGB = ~100 KB
  let total = 0
  for (let page = 0; total < targetBytes; page++) {
    doc.graftPage(-1, text, page % text.countPages())
    const pixels = new Uint8Array(side * side * 3)
    for (let i = 0; i < pixels.length; i += 65536) crypto.getRandomValues(pixels.subarray(i, i + 65536))
    const dict = doc.newDictionary()
    dict.put('Type', doc.newName('XObject'))
    dict.put('Subtype', doc.newName('Image'))
    dict.put('Width', side)
    dict.put('Height', side)
    dict.put('ColorSpace', doc.newName('DeviceRGB'))
    dict.put('BitsPerComponent', 8)
    const image = doc.addRawStream(pixels, dict)
    const pageObj = doc.findPage(page)
    const resources = pageObj.getInheritable('Resources')
    const xobjects = resources.get('XObject').isNull() ? resources.put('XObject', doc.newDictionary()) : resources.get('XObject')
    xobjects.put('ImSynthetic', image)
    const contents = doc.addStream('q 100 0 0 100 400 600 cm /ImSynthetic Do Q', doc.newDictionary())
    const existing = pageObj.get('Contents')
    const arr = doc.newArray()
    if (existing.isArray()) existing.forEach((c) => arr.push(c))
    else arr.push(existing)
    arr.push(contents)
    pageObj.put('Contents', arr)
    total += pixels.length
  }
  const buf = doc.saveToBuffer('garbage=compact')
  const out = buf.asUint8Array().slice()
  buf.destroy()
  doc.destroy()
  text.destroy()
  return out
}

describe('timings', () => {
  const ms = (t: number) => `${Math.round(performance.now() - t)} ms`

  async function measure(label: string, bytes: Uint8Array, key: CertificateKey) {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    let t = performance.now()
    await doc.open(bytes, { fileName: 'timed.pdf' })
    const res = await doc.unlockCertificate(key)
    const open = ms(t)
    expect(res.ok).toBe(true)
    const route = engine.session.pubsec?.route
    t = performance.now()
    const out = await doc.save({})
    const save = ms(t)
    t = performance.now()
    await doc.reload(out, {})
    const reload = ms(t)
    console.log(
      `[passwordless timing] ${label}: ${(bytes.length / 1e6).toFixed(2)} MB, route ${route}: ` +
        `open ${open}, save ${save} (${(out.length / 1e6).toFixed(2)} MB), reload ${reload}`
    )
  }

  it('largest fixture and a 5 MB document', async () => {
    const signed = pubsecFixture('v5-signed.pdf')
    await measure('v5-signed.pdf', signed, keyFor('v5-signed.pdf', 'alice', signed))
    const rc4 = pubsecFixture('v4-rc4.pdf')
    await measure('v4-rc4.pdf', rc4, keyFor('v4-rc4.pdf', 'alice', rc4))

    let t = performance.now()
    const plainBytes = syntheticPdf(5_000_000)
    const plain = new mupdf.PDFDocument(plainBytes)
    const pages = plain.countPages()
    // Encrypted for alice's v5-classic envelope with its seed, so alice's key opens it.
    const classic = pubsecFixture('v5-classic.pdf')
    const key = keyFor('v5-classic.pdf', 'alice', classic)
    const recipients = readPubSec(classic)!.recipients
    const bridged = writePubSecDocument(mupdf, plain, writeKeyFor(key.seed, recipients))
    const written = ms(t)
    const decrypted = writePubSecDocument(mupdf, plain, writeKeyFor(key.seed, recipients, false))
    plain.destroy()
    console.log(`[passwordless timing] synthetic: ${pages} pages, plain ${(plainBytes.length / 1e6).toFixed(2)} MB, built and encrypted in ${written}`)
    await measure('5 MB synthetic, V5', bridged, key)
    await measure('5 MB synthetic, V5 without encrypted metadata', decrypted, key)

    t = performance.now()
    const p = await createLocalEngine()
    await p.ops<typeof docOps>('doc').open(plainBytes, { fileName: 'plain.pdf' })
    const plainOpen = ms(t)
    t = performance.now()
    await p.ops<typeof docOps>('doc').save({})
    console.log(`[passwordless timing] 5 MB synthetic, plain: open ${plainOpen}, save ${ms(t)}`)
    expect(hexBytes('00').length).toBe(1)
  })
})
