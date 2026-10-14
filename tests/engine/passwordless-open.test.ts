// Opening certificate-encrypted (/Adobe.PubSec) files in the engine, with the seeds the fixtures'
// envelopes hold (expected.json), over every fixture in tests/fixtures/passwordless/.
import { describe, expect, it } from 'vitest'
import { certificatePermissionBits, certificatePermissions, fileKey, readPubSec } from '@engine/crypt'
import { createLocalEngine } from '@engine/local'
import type annotOps from '@engine/ops/annots'
import type docOps from '@engine/ops/doc'
import type pageOps from '@engine/ops/pages'
import { CertificateNeededError, openSourceWithAccess } from '@engine/ops/pages'
import { openFixture } from './helpers'
import {
  EXPECTED,
  expected,
  hexBytes,
  keyFor,
  openFixtureAs,
  openWithKey,
  pageText,
  pubsecFixture,
  type Engine
} from './passwordless-helpers'

const SOURCE_TITLE = 'Secret title'
const NOTE = 'Note text in an object stream'

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')

async function notes(e: Engine): Promise<string[]> {
  return (await e.ops<typeof annotOps>('annots').list(0)).filter((a) => a.type === 'Text').map((a) => a.contents)
}

describe('reading the encryption dictionary', () => {
  for (const e of EXPECTED) {
    it(`${e.file}: handler facts and the file key`, () => {
      const bytes = pubsecFixture(e.file)
      const info = readPubSec(bytes)!
      expect(info).not.toBeNull()
      expect(info.version).toBe(e.version)
      expect(info.cipher).toBe(e.cipher)
      expect(info.keyLength * 8).toBe(e.keyBits)
      expect(info.subFilter).toBe('adbe.pkcs7.s5')
      expect(info.encryptMetadata).toBe(e.encryptMetadata)
      expect(info.encryptRef === null).toBe(e.encryptDirect)
      expect(info.recipients.length).toBe(Math.max(...e.recipients.map((r) => r.envelope)) + 1)
      expect(info.xref.damaged).toBe(false)
      const seed = hexBytes(Object.values(e.seedHex)[0])
      expect(toHex(fileKey(info, seed))).toBe(e.fileKeyHex)
    })
  }

  it('plain and password-protected files are not certificate-encrypted', async () => {
    expect(readPubSec(pubsecFixture('source.pdf'))).toBeNull()
    const { fixture } = await import('./helpers')
    expect(readPubSec(fixture('encrypted.pdf'))).toBeNull()
    expect(readPubSec(new TextEncoder().encode('not a pdf'))).toBeNull()
  })
})

describe('opening every fixture with each recipient', () => {
  const plainText = (async () => {
    const plain = await openFixture('text.pdf')
    return plain.ops<typeof import('@engine/ops/text').default>('text').plain(0)
  })()
  for (const e of EXPECTED) {
    for (const person of e.opensWith) {
      it(`${e.file} as ${person}`, async () => {
        const eng = await openFixtureAs(e.file, person)
        const info = eng.info
        expect(info.pageCount).toBe(e.pages)
        expect(info.wasRepaired).toBe(false)
        expect(info.metadata.title).toBe(e.expectedTitle)
        expect(info.security).toBe('certificate')
        expect(info.encryption).toBe(`Adobe.PubSec V${e.version} ${e.keyBits}-bit ${e.cipher === 'RC4' ? 'RC4' : 'AES'}`)
        expect(info.canSaveIncrementally).toBe(false)
        const perms = certificatePermissions(e.permissions[person])
        expect(info.permissions).toEqual(perms.permissions)
        if (e.title === SOURCE_TITLE) {
          expect(await pageText(eng)).toContain('Hello secret world')
          expect(await pageText(eng, 1)).toContain('Page two text')
          expect(await notes(eng)).toEqual([NOTE])
        } else {
          expect(await pageText(eng)).toBe(await plainText)
        }
        const lock = await eng.doc.certificateLock()
        expect(lock).toMatchObject({ version: e.version, cipher: e.cipher, keyBits: e.keyBits })
        expect(lock!.recipients.map(toHex)).toEqual(readPubSec(pubsecFixture(e.file))!.recipients.map(toHex))
      })
    }
  }
})

describe('permissions and access', () => {
  it('v5-two-envelopes: alice may only print, bob has full access', async () => {
    const res = await Promise.all(
      ['alice', 'bob'].map(async (person) => {
        const engine = await createLocalEngine()
        const doc = engine.ops<typeof docOps>('doc')
        const bytes = pubsecFixture('v5-two-envelopes.pdf')
        await doc.open(bytes, { fileName: 'v5-two-envelopes.pdf' })
        return doc.unlockCertificate(keyFor('v5-two-envelopes.pdf', person, bytes))
      })
    )
    const [alice, bob] = res
    if (!alice.ok || !bob.ok) throw new Error('did not open')
    expect(alice.access).toBe('user')
    expect(alice.info.permissions).toEqual({
      print: true,
      'print-hq': true,
      edit: false,
      copy: false,
      annotate: false,
      form: false,
      accessibility: false,
      assemble: false
    })
    expect(bob.access).toBe('owner')
    expect(Object.values(bob.info.permissions).every(Boolean)).toBe(true)
  })

  it('maps permission bits like ISO 32000-2 table 24', () => {
    expect(certificatePermissions(null).access).toBe('owner')
    expect(certificatePermissions(0xffffffff).standardP).toBe(-4)
    const printOnly = certificatePermissions(0xfffff8c5)
    expect(printOnly.access).toBe('user')
    // /P for the bridge: print (3) and high-quality print (12), reserved bits set, 1 and 2 clear.
    expect(printOnly.standardP >>> 0).toBe(0xfffff8c4)
    // Without bit 2 but with everything else: a user, with every everyday permission.
    const noSecurity = certificatePermissions(0xfffffffd)
    expect(noSecurity.access).toBe('user')
    expect(Object.values(noSecurity.permissions).every(Boolean)).toBe(true)
  })

  it('permission bits for new envelopes are the inverse (and match pyHanko’s print-only value)', () => {
    expect(certificatePermissionBits({})).toBe(0xffffffff - 2)
    expect(certificatePermissionBits({}, true)).toBe(0xffffffff)
    const printOnly = { edit: false, copy: false, annotate: false, form: false, accessibility: false, assemble: false }
    expect(certificatePermissionBits(printOnly)).toBe(expected('v5-two-envelopes.pdf').permissions.alice)
    expect(certificatePermissionBits({ print: false })).toBe(0xffffffff - 2 - 4 - 0x800)
    for (const allow of [printOnly, { copy: false }, { print: false, 'print-hq': true }]) {
      const back = certificatePermissions(certificatePermissionBits(allow))
      expect(back.access).toBe('user')
      for (const [p, v] of Object.entries(allow)) expect(back.permissions[p as keyof typeof back.permissions]).toBe(v)
    }
  })

  it('v5-mac (pyHanko clears the "tolerate missing MAC" bit) still has full access', async () => {
    const res = await openFixtureAs('v5-mac.pdf', 'alice')
    expect(Object.values(res.info.permissions).every(Boolean)).toBe(true)
  })
})

describe('keys', () => {
  it('a key for another file, or with a wrong seed, asks for a certificate again', async () => {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    const bytes = pubsecFixture('v5-classic.pdf')
    const first = await doc.open(bytes, { fileName: 'v5-classic.pdf' })
    expect(first).toMatchObject({ ok: false, needsCertificate: true })
    if (first.ok || !first.needsCertificate) return
    expect(first.certificate).toMatchObject({ version: 5, cipher: 'AESV3', keyBits: 256 })
    // stranger's envelope is not among the recipients
    const foreign = keyFor('stranger-only.pdf', 'stranger')
    expect(await doc.unlockCertificate(foreign)).toMatchObject({ ok: false, needsCertificate: true })
    // the right envelope with another file's seed
    const right = keyFor('v5-classic.pdf', 'alice', bytes)
    const wrongSeed = { ...right, seed: hexBytes(expected('v5-objstm.pdf').seedHex.alice) }
    expect(await doc.unlockCertificate(wrongSeed)).toMatchObject({ ok: false, needsCertificate: true })
    // neither was kept: the right key still opens it, and it is then kept
    const ok = await doc.unlockCertificate(right)
    expect(ok.ok).toBe(true)
    expect(engine.session.certificateKeys.size).toBe(1)
  })

  it('wrong seeds are refused for every cipher (AES-256, AES-128, RC4)', async () => {
    for (const file of ['v5-objstm.pdf', 'v4-aes128.pdf', 'v4-aes128-objstm.pdf', 'v4-rc4.pdf', 'v5-nometa.pdf']) {
      const engine = await createLocalEngine()
      const doc = engine.ops<typeof docOps>('doc')
      const bytes = pubsecFixture(file)
      await doc.open(bytes, { fileName: file })
      const key = keyFor(file, 'alice', bytes)
      const bad = { ...key, seed: key.seed.map((b, i) => (i === 0 ? b ^ 1 : b)) }
      expect(await doc.unlockCertificate(bad), file).toMatchObject({ ok: false, needsCertificate: true })
    }
  })

  it('stranger-only.pdf stays locked with alice’s keys', async () => {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    await doc.addCertificateKey(keyFor('v5-classic.pdf', 'alice'))
    await doc.addCertificateKey(keyFor('v5-two-recipients.pdf', 'alice'))
    const res = await doc.open(pubsecFixture('stranger-only.pdf'), { fileName: 'stranger-only.pdf' })
    expect(res).toMatchObject({ ok: false, needsCertificate: true })
    const check = await doc.checkFile(pubsecFixture('stranger-only.pdf'), 'stranger-only.pdf')
    expect(check).toMatchObject({ needsPassword: false, needsCertificate: true })
  })

  it('a registered key opens files with the same envelope without asking, and survives close', async () => {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    const bytes = pubsecFixture('v5-objstm.pdf')
    // v5-incremental.pdf is v5-objstm.pdf plus an update: same envelope, same seed
    await doc.addCertificateKey(keyFor('v5-objstm.pdf', 'alice', bytes))
    expect((await doc.checkFile(bytes, 'v5-objstm.pdf')).needsPassword).toBe(false)
    expect(await doc.checkFile(bytes, 'v5-objstm.pdf')).not.toHaveProperty('needsCertificate', true)
    const res = await doc.open(pubsecFixture('v5-incremental.pdf'), { fileName: 'v5-incremental.pdf' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.access).toBe('owner')
      expect(res.info.metadata.title).toBe('Updated secret title')
    }
    await doc.close()
    expect(await doc.certificateLock()).toBeNull()
    const again = await doc.open(bytes, { fileName: 'v5-objstm.pdf' })
    expect(again.ok).toBe(true)
  })

  it('reload of a file no key opens leaves the open document as it is', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    const res = await e.doc.reload(pubsecFixture('stranger-only.pdf'))
    expect(res).toMatchObject({ ok: false, needsCertificate: true })
    expect(await pageText(e)).toContain('Hello secret world')
    expect((await e.doc.info()).security).toBe('certificate')
    expect(() => e.session.pendingCertificate).not.toThrow()
    expect(e.session.pendingCertificate).toBeNull()
  })

  it('unlockCertificate without a waiting document fails', async () => {
    const engine = await createLocalEngine()
    const doc = engine.ops<typeof docOps>('doc')
    await expect(doc.unlockCertificate(keyFor('v5-classic.pdf', 'alice'))).rejects.toMatchObject({ code: 'NO_PENDING' })
    await expect(doc.addCertificateKey({ envelope: new Uint8Array(4), seed: new Uint8Array(3), permissions: null })).rejects.toMatchObject({
      code: 'BAD_CERTIFICATE_KEY'
    })
  })

  it('opening a password-protected file afterwards still asks for its password', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    const { fixture } = await import('./helpers')
    const res = await e.doc.open(fixture('encrypted.pdf'), { fileName: 'encrypted.pdf' })
    expect(res).toMatchObject({ ok: false, needsPassword: true })
    expect(e.session.pendingCertificate).toBeNull()
    const ok = await e.doc.authenticate('secret')
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.info.security).toBe('password')
    expect(e.session.pubsec).toBeNull()
  })
})

describe('special files', () => {
  it('v5-damaged-first opens with alice’s seed (envelope 1)', async () => {
    const e = await openFixtureAs('v5-damaged-first.pdf', 'alice')
    expect(await pageText(e)).toContain('Hello secret world')
    expect(e.session.pubsec?.route).toBe('bridge')
  })

  it('V4 (AES-128, RC4) and V5 without encrypted metadata take the decrypt pass', async () => {
    for (const file of ['v4-aes128.pdf', 'v4-aes128-objstm.pdf', 'v4-rc4.pdf', 'v5-nometa.pdf']) {
      const e = await openFixtureAs(file, 'alice')
      expect(e.session.pubsec?.route, file).toBe('decrypted')
      expect(await notes(e), file).toEqual([NOTE])
      expect(e.info.metadata.title, file).toBe(SOURCE_TITLE)
    }
  })

  it('v5-nometa keeps its clear XMP readable', async () => {
    const e = await openFixtureAs('v5-nometa.pdf', 'alice')
    const doc = e.session.pdf
    const meta = doc.getTrailer().get('Root').get('Metadata')
    expect(meta.isStream()).toBe(true)
    expect(new TextDecoder().decode(meta.readStream().asUint8Array())).toContain('xmp-marker-123')
  })

  it('XMP of a V5 file with encrypted metadata is decrypted by the bridge', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    const meta = e.session.pdf.getTrailer().get('Root').get('Metadata')
    expect(new TextDecoder().decode(meta.readStream().asUint8Array())).toContain('xmp-marker-123')
  })

  it('the form field value is decrypted', async () => {
    for (const file of ['v5-classic.pdf', 'v4-rc4.pdf', 'v5-objstm.pdf']) {
      const e = await openFixtureAs(file, 'alice')
      const fields = e.session.pdf.getTrailer().get('Root').get('AcroForm').get('Fields')
      const values: string[] = []
      fields.forEach((f) => values.push(f.get('V').asString()))
      expect(values, file).toContain('Field value')
    }
  })

  it('v5-mac, v5-signed and v5-direct-encrypt open', async () => {
    for (const file of ['v5-mac.pdf', 'v5-signed.pdf', 'v5-direct-encrypt.pdf']) {
      const e = await openFixtureAs(file, 'alice')
      expect(e.info.wasRepaired, file).toBe(false)
      expect(await pageText(e), file).toContain('Hello secret world')
    }
    const signed = await openFixtureAs('v5-signed.pdf', 'alice')
    expect(signed.info.signatureCount).toBe(1)
    // The signature covers the file as it is: the engine keeps those bytes.
    expect(signed.session.sourceBytes?.length).toBe(pubsecFixture('v5-signed.pdf').length)
  })

  it('files to insert open with a registered key; without one they need a certificate', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    const pages = e.ops<typeof pageOps>('pages')
    const other = pubsecFixture('v5-two-envelopes.pdf')
    await expect(pages.insertFrom(-1, other, { fileName: 'v5-two-envelopes.pdf' })).rejects.toMatchObject({ code: 'NEEDS_CERTIFICATE' })
    let needed: unknown = null
    try {
      openSourceWithAccess(e.session, other, 'v5-two-envelopes.pdf')
    } catch (err) {
      needed = err
    }
    expect(needed).toBeInstanceOf(CertificateNeededError)
    expect((needed as CertificateNeededError).certificate).toMatchObject({ version: 5, keyBits: 256 })
    await e.doc.addCertificateKey(keyFor('v5-two-envelopes.pdf', 'alice', other))
    const opened = openSourceWithAccess(e.session, other, 'v5-two-envelopes.pdf')
    expect(opened.access).toBe('user')
    expect(opened.pubsec?.permissions).toBe(0xfffff8c5)
    expect(opened.pubsec?.writeKey.recipients.length).toBe(2)
    opened.doc.destroy()
    expect(await pages.insertFrom(-1, other, { fileName: 'v5-two-envelopes.pdf' })).toBe(2)
    expect((await e.doc.info()).pageCount).toBe(4)
    expect(await pageText(e, 2)).toContain('Hello secret world')
  })

  it('an engine with a key opens the file as a new document through the same envelope', async () => {
    const bytes = pubsecFixture('text-v5.pdf')
    const e = await openWithKey(bytes, keyFor('text-v5.pdf', 'bob', bytes), 'text-v5.pdf')
    expect(e.info.pageCount).toBe(5)
  })
})
