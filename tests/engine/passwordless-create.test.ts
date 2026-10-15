// Creating certificate-encrypted files (SaveOptions.encryptCertificate): a new seed, one envelope
// per permission group, RSA PKCS#1 v1.5 key transport and issuerAndSerialNumber copied byte for
// byte from each certificate. Each recipient opens the result by unwrapping their envelope with
// their own private key (node-forge here, as an independent implementation), and pyHanko agrees
// when it is installed.
import { spawnSync } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import forge from 'node-forge'
import { afterAll, describe, expect, it } from 'vitest'
import { assertNoBridge, readPubSec, writeKeyFor, writePubSecDocument } from '@engine/crypt'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type annotOps from '@engine/ops/annots'
import { contentOf, isUniversal, parseAsn1, rawOf, readOid, readSmallInt, TAG, type Asn1Node } from '@features/digital-signatures/lib/asn1'
import { buildEnvelopedData, rsaPkcs1v15Encrypt } from '@features/digital-signatures/lib/envelopeBuild'
import { parseCertificate } from '@features/digital-signatures/lib/x509'
import { PUBSEC_PERMISSION, type CertificateKey } from '@shared/certkeys'
import type { CertificateGroup, Permission, SaveOptions } from '@shared/types'
import { openFixture, type OpenedEngine } from './helpers'
import { expected, includesBytes, keyFor, openFixtureAs, openWithKey, pageText, PKI, pubsecFixture } from './passwordless-helpers'
import { hasPyHanko } from './pyhanko'

const TMP = mkdtempSync(join(tmpdir(), 'fc-pubsec-create-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))

type Person = 'alice' | 'bob' | 'stranger'

const certDer = (name: string): Uint8Array => new Uint8Array(readFileSync(join(PKI, `${name}.cer`)))
const privateKey = (name: Person) => forge.pki.privateKeyFromPem(readFileSync(join(PKI, `${name}.key`), 'utf8')) as forge.pki.rsa.PrivateKey
const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex').toUpperCase()
const bin = (b: Uint8Array) => forge.util.binary.raw.encode(b)
const unbin = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0))

const OID_ENVELOPED_DATA = '1.2.840.113549.1.7.3'
const OID_DATA = '1.2.840.113549.1.7.1'
const OID_RSA = '1.2.840.113549.1.1.1'
const OID_AES256_CBC = '2.16.840.1.101.3.4.1.42'

const PLAINTEXT = ['Hello secret world', 'Note text in an object stream', 'Page two text', 'Field value', 'xmp-marker-123', 'Secret title']
const ALL: Permission[] = ['print', 'print-hq', 'edit', 'annotate', 'form', 'assemble', 'copy', 'accessibility']
const PRINT_ONLY: Partial<Record<Permission, boolean>> = { edit: false, copy: false, annotate: false, form: false, accessibility: false, assemble: false }

interface Unwrapped {
  envelope: number
  seed: Uint8Array
  permissions: number
  /** The RecipientInfo that matched (for structure checks). */
  recipientInfo: Asn1Node
  envelopedData: Asn1Node
}

/**
 * What `person`'s private key unwraps from `recipients`: finds their RecipientInfo by issuer and
 * serial (exact DER bytes from their certificate), decrypts the content key with node-forge and the
 * content with Node's AES. Null when they are not a recipient.
 */
function unwrap(recipients: Uint8Array[], person: Person): Unwrapped | null {
  const cert = parseCertificate(certDer(person))
  for (let i = 0; i < recipients.length; i++) {
    const ci = parseAsn1(recipients[i])
    expect(readOid(ci.children[0])).toBe(OID_ENVELOPED_DATA)
    const ed = ci.children[1].children[0]
    const [, infos, eci] = ed.children
    for (const ri of infos.children) {
      const rid = ri.children[1]
      if (!isUniversal(rid, TAG.SEQUENCE)) continue
      if (toHex(rawOf(rid.children[0])) !== toHex(cert.issuer.raw) || toHex(contentOf(rid.children[1])) !== toHex(cert.serial)) continue
      const contentKey = unbin(privateKey(person).decrypt(bin(contentOf(ri.children[3])), 'RSAES-PKCS1-V1_5'))
      const alg = eci.children[1]
      expect(readOid(alg.children[0])).toBe(OID_AES256_CBC)
      const iv = contentOf(alg.children[1])
      const decipher = createDecipheriv('aes-256-cbc', contentKey, iv)
      const content = new Uint8Array(Buffer.concat([decipher.update(contentOf(eci.children[2])), decipher.final()]))
      expect(content.length).toBe(24)
      return {
        envelope: i,
        seed: content.slice(0, 20),
        permissions: new DataView(content.buffer, content.byteOffset + 20, 4).getUint32(0, false),
        recipientInfo: ri,
        envelopedData: ed
      }
    }
  }
  return null
}

function keyOf(recipients: Uint8Array[], person: Person): CertificateKey {
  const u = unwrap(recipients, person)
  if (!u) throw new Error(`${person} is not a recipient`)
  return { envelope: recipients[u.envelope], seed: u.seed, permissions: u.permissions }
}

const group = (people: string[], permissions: Partial<Record<Permission, boolean>> = {}, changeSecurity = false): CertificateGroup => ({
  certificates: people.map(certDer),
  permissions,
  changeSecurity
})

async function encrypt(e: OpenedEngine, groups: CertificateGroup[], extra: Partial<SaveOptions> = {}): Promise<Uint8Array> {
  return e.doc.save({ mode: 'full', encryptCertificate: { groups }, ...extra })
}

/** V5 AES-256 PubSec with `n` envelopes, no Standard handler and no plaintext of the source. */
function expectSealed(out: Uint8Array, n: number, label: string, encryptMetadata = true) {
  const info = readPubSec(out)
  expect(info, label).not.toBeNull()
  expect(info!.version).toBe(5)
  expect(info!.cipher).toBe('AESV3')
  expect(info!.keyLength).toBe(32)
  expect(info!.subFilter).toBe('adbe.pkcs7.s5')
  expect(info!.encryptMetadata).toBe(encryptMetadata)
  expect(info!.recipients.length, label).toBe(n)
  for (const s of PLAINTEXT) {
    if (s === 'xmp-marker-123' && !encryptMetadata) continue
    expect(includesBytes(out, s), `${label}: "${s}" in clear`).toBe(false)
  }
  expect(/\/Filter\s*\/Standard/.test(Buffer.from(out).toString('latin1')), `${label}: Standard handler`).toBe(false)
  return info!
}

async function openAs(bytes: Uint8Array, person: Person) {
  const info = readPubSec(bytes)!
  return openWithKey(bytes, keyOf(info.recipients, person))
}

describe('the envelope', () => {
  it('RSA PKCS#1 v1.5: node-forge decrypts it, and the padding is random and non-zero', () => {
    const cert = parseCertificate(certDer('alice'))
    const message = Uint8Array.from({ length: 32 }, (_, i) => i + 1)
    const a = rsaPkcs1v15Encrypt(cert.publicKey.modulus!, cert.publicKey.exponent!, message)
    const b = rsaPkcs1v15Encrypt(cert.publicKey.modulus!, cert.publicKey.exponent!, message)
    expect(a.length).toBe(256)
    expect(toHex(a)).not.toBe(toHex(b))
    for (const c of [a, b]) expect(toHex(unbin(privateKey('alice').decrypt(bin(c), 'RSAES-PKCS1-V1_5')))).toBe(toHex(message))
    // A padding source that hands out zeros is never used as such.
    let calls = 0
    const zeros = (n: number) => (calls++ < 2 ? new Uint8Array(n) : Uint8Array.from({ length: n }, () => 7))
    const c = rsaPkcs1v15Encrypt(cert.publicKey.modulus!, cert.publicKey.exponent!, message, zeros)
    expect(toHex(unbin(privateKey('alice').decrypt(bin(c), 'RSAES-PKCS1-V1_5')))).toBe(toHex(message))
  })

  it('issuer and serial bytes are copied exactly (UTF-8 issuer, serial with a leading 00)', () => {
    const seed = Uint8Array.from({ length: 20 }, (_, i) => i)
    const env = buildEnvelopedData([certDer('bob'), certDer('alice')], seed, 0xfffff0c5)
    const ci = parseAsn1(env)
    expect(readOid(ci.children[0])).toBe(OID_ENVELOPED_DATA)
    const ed = ci.children[1].children[0]
    expect(readSmallInt(ed.children[0])).toBe(0)
    const infos = ed.children[1].children
    expect(infos).toHaveLength(2)
    const bob = parseCertificate(certDer('bob'))
    const bobInfo = infos.find((ri) => toHex(rawOf(ri.children[1].children[0])) === toHex(bob.issuer.raw))!
    expect(bobInfo, 'bob by his issuer bytes').toBeDefined()
    expect(readSmallInt(bobInfo.children[0])).toBe(0)
    const serial = contentOf(bobInfo.children[1].children[1])
    expect(toHex(serial)).toBe(toHex(bob.serial))
    const e = expected('v5-two-envelopes.pdf').recipients.find((r) => r.cert === 'bob') as unknown as { serialHex: string }
    expect(toHex(serial)).toBe(e.serialHex.toUpperCase())
    expect(toHex(serial).startsWith('00')).toBe(true)
    // The issuer is the UTF8String name as encoded in bob's certificate.
    expect(Buffer.from(bob.issuer.raw).toString('utf8')).toContain('Fartcrobat Tëst CA Ünïcode ✓')
    expect(toHex(rawOf(bobInfo.children[1].children[0]))).toBe(toHex(bob.issuer.raw))
    // rsaEncryption with NULL parameters, a 256-byte key for a 2048-bit RSA key.
    expect(readOid(bobInfo.children[2].children[0])).toBe(OID_RSA)
    expect(bobInfo.children[2].children[1].tag).toBe(TAG.NULL)
    expect(contentOf(bobInfo.children[3]).length).toBe(256)
    // Content: id-data, AES-256-CBC with a 16-byte IV, [0] IMPLICIT encrypted content.
    const eci = ed.children[2]
    expect(readOid(eci.children[0])).toBe(OID_DATA)
    expect(contentOf(eci.children[1].children[1]).length).toBe(16)
    expect(contentOf(eci.children[2]).length).toBe(32)
    // Both recipients unwrap the same seed and permissions.
    for (const person of ['alice', 'bob'] as const) {
      const u = unwrap([env], person)!
      expect(toHex(u.seed)).toBe(toHex(seed))
      expect(u.permissions).toBe(0xfffff0c5)
    }
    expect(unwrap([env], 'stranger')).toBeNull()
  })

  it('EC and unreadable certificates are refused, naming the certificate', () => {
    const seed = new Uint8Array(20)
    expect(() => buildEnvelopedData([certDer('alice'), certDer('ec')], seed, 0)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_KEY', message: expect.stringContaining('“EC Test”') })
    )
    expect(() => buildEnvelopedData([new Uint8Array([1, 2, 3])], seed, 0)).toThrow(expect.objectContaining({ code: 'BAD_CERTIFICATE' }))
    expect(() => buildEnvelopedData([], seed, 0)).toThrow(expect.objectContaining({ code: 'NO_RECIPIENTS' }))
  })
})

describe('Encrypt with Certificate', () => {
  it('one group: every permission, metadata encrypted, reopens with the unwrapped key', async () => {
    const e = await openFixture('passwordless/source.pdf')
    const out = await encrypt(e, [group(['alice'])])
    const info = expectSealed(out, 1, 'one group')
    const u = unwrap(info.recipients, 'alice')!
    // Everything except changing the security; reserved bits and bit 13 ("tolerate a missing
    // PDF MAC") set, because no MAC is written (pyHanko would otherwise insist on one).
    expect(u.permissions).toBe(0xfffffffd)
    expect(u.permissions & 0x1000).toBe(0x1000)
    expect(unwrap(info.recipients, 'bob')).toBeNull()
    const again = await openAs(out, 'alice')
    expect(await pageText(again)).toContain('Hello secret world')
    expect(again.info.metadata.title).toBe('Secret title')
    expect(again.info.pageCount).toBe(2)
    expect(again.info.permissions).toEqual(Object.fromEntries(ALL.map((p) => [p, true])))
    expect(again.info.wasRepaired).toBe(false)
    const notes = (await again.ops<typeof annotOps>('annots').list(0)).filter((a) => a.type === 'Text').map((a) => a.contents)
    expect(notes).toEqual(['Note text in an object stream'])
    // The live document is unchanged and still plain.
    expect((await e.doc.info()).security).toBeNull()
  })

  it('two groups with different permissions; each recipient opens with their own', async () => {
    const e = await openFixture('passwordless/source.pdf')
    const out = await encrypt(e, [group(['alice'], PRINT_ONLY), group(['bob', 'stranger'], {}, true)])
    const info = expectSealed(out, 2, 'two groups')
    const alice = unwrap(info.recipients, 'alice')!
    const bob = unwrap(info.recipients, 'bob')!
    const stranger = unwrap(info.recipients, 'stranger')!
    expect(alice.envelope).toBe(0)
    expect(bob.envelope).toBe(1)
    expect(stranger.envelope).toBe(1)
    // One seed for every envelope (the file key covers all of them).
    expect(toHex(alice.seed)).toBe(toHex(bob.seed))
    // Printing only, as pyHanko and Acrobat write it (the fixture's alice envelope has the same value).
    expect(alice.permissions).toBe(expected('v5-two-envelopes.pdf').permissions.alice)
    expect(alice.permissions).toBe(0xfffff8c5)
    expect(bob.permissions).toBe(0xffffffff)
    expect(bob.permissions & PUBSEC_PERMISSION.changeSecurity).toBe(PUBSEC_PERMISSION.changeSecurity)

    const asAlice = await openAs(out, 'alice')
    expect(asAlice.info.permissions).toEqual(Object.fromEntries(ALL.map((p) => [p, p === 'print' || p === 'print-hq'])))
    const asBob = await openAs(out, 'bob')
    expect(asBob.info.permissions).toEqual(Object.fromEntries(ALL.map((p) => [p, true])))
    const asStranger = await openAs(out, 'stranger')
    expect(await pageText(asStranger)).toContain('Hello secret world')
  })

  it('EncryptMetadata false leaves the XMP in clear', async () => {
    const e = await openFixture('passwordless/source.pdf')
    const out = await e.doc.save({ mode: 'full', encryptCertificate: { groups: [group(['alice'])], encryptMetadata: false } })
    expectSealed(out, 1, 'no metadata', false)
    expect(includesBytes(out, 'xmp-marker-123')).toBe(true)
    const again = await openAs(out, 'alice')
    expect(again.info.metadata.title).toBe('Secret title')
  })

  it('every save makes a new seed and new envelopes', async () => {
    const e = await openFixture('passwordless/source.pdf')
    const a = readPubSec(await encrypt(e, [group(['alice'])]))!
    const b = readPubSec(await encrypt(e, [group(['alice'])]))!
    expect(toHex(a.recipients[0])).not.toBe(toHex(b.recipients[0]))
    expect(toHex(unwrap(a.recipients, 'alice')!.seed)).not.toBe(toHex(unwrap(b.recipients, 'alice')!.seed))
  })

  it('EC certificates are refused with UNSUPPORTED_KEY naming the certificate', async () => {
    const e = await openFixture('passwordless/source.pdf')
    await expect(encrypt(e, [group(['alice']), group(['ec'])])).rejects.toMatchObject({
      code: 'UNSUPPORTED_KEY',
      message: expect.stringContaining('“EC Test”')
    })
    await expect(encrypt(e, [])).rejects.toMatchObject({ code: 'NO_RECIPIENTS' })
    await expect(encrypt(e, [{ certificates: [], permissions: {} }])).rejects.toMatchObject({ code: 'NO_RECIPIENTS' })
    await expect(e.doc.save({ mode: 'incremental', encryptCertificate: { groups: [group(['alice'])] } })).rejects.toMatchObject({ code: 'BAD_SAVE' })
  })

  it('from a password-protected document', async () => {
    const e = await openFixture('encrypted.pdf', 'secret')
    const out = await encrypt(e, [group(['alice'])])
    const info = readPubSec(out)!
    expect(info.version).toBe(5)
    expect(/\/Filter\s*\/Standard/.test(Buffer.from(out).toString('latin1'))).toBe(false)
    const plainText = await pageText(e)
    const again = await openAs(out, 'alice')
    expect(await pageText(again)).toBe(plainText)
    expect(again.info.security).toBe('certificate')
  })

  it('from a certificate-encrypted document: new seed and envelopes, no bridge', async () => {
    const file = 'v5-classic.pdf'
    const e = await openFixtureAs(file, 'alice')
    const state = e.session.pubsec!
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'Added before re-encrypting' })
    const out = await encrypt(e, [group(['bob'])])
    const info = expectSealed(out, 1, 're-encrypted')
    assertNoBridge(out, state)
    expect(includesBytes(out, 'Added before re-encrypting')).toBe(false)
    const original = readPubSec(pubsecFixture(file))!
    expect(toHex(info.recipients[0])).not.toBe(toHex(original.recipients[0]))
    expect(unwrap(info.recipients, 'alice')).toBeNull()
    const u = unwrap(info.recipients, 'bob')!
    expect(toHex(u.seed)).not.toBe(expected(file).seedHex.alice.toUpperCase())
    // The old key does not open it, bob's does.
    const fresh = await createLocalEngine()
    await fresh.ops<typeof docOps>('doc').addCertificateKey(keyFor(file, 'alice'))
    expect(await fresh.ops<typeof docOps>('doc').open(out, { fileName: 'x.pdf' })).toMatchObject({ ok: false, needsCertificate: true })
    const asBob = await openAs(out, 'bob')
    const notes = (await asBob.ops<typeof annotOps>('annots').list(0)).filter((a) => a.type === 'Text').map((a) => a.contents)
    expect(notes).toEqual(['Note text in an object stream', 'Added before re-encrypting'])
  })

  it('a recipient who may not change the security cannot replace it', async () => {
    const e = await openFixtureAs('v5-two-envelopes.pdf', 'alice')
    await expect(encrypt(e, [group(['alice'])])).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
  })

  it('the tab reloads from the saved bytes without asking, with full access', async () => {
    const e = await openFixture('passwordless/source.pdf')
    // The person encrypts for a colleague only, restricted, and keeps working in the tab.
    const out = await encrypt(e, [group(['bob'], PRINT_ONLY)])
    expect(await e.doc.checkFile(out, 'out.pdf')).toEqual({ needsPassword: false })
    const res = await e.doc.reload(out)
    expect(res).toMatchObject({ ok: true, access: 'owner' })
    if (!res.ok) throw new Error('reload asked for a key')
    expect(res.info.security).toBe('certificate')
    expect(res.info.encryption).toBe('Adobe.PubSec V5 256-bit AES')
    expect(res.info.permissions.edit).toBe(true)
    expect(await e.doc.certificateLock()).toMatchObject({ version: 5, cipher: 'AESV3', keyBits: 256 })
    // Saving back keeps the new envelopes; bob still gets printing only.
    await e.doc.setMetadata({ title: 'Saved after encrypting' })
    const saved = await e.doc.save({})
    expect(readPubSec(saved)!.recipients.map(toHex)).toEqual(readPubSec(out)!.recipients.map(toHex))
    const asBob = await openAs(saved, 'bob')
    expect(asBob.info.metadata.title).toBe('Saved after encrypting')
    expect(asBob.info.permissions.edit).toBe(false)
    // Another engine does not know the key.
    const other = await createLocalEngine()
    expect(await other.ops<typeof docOps>('doc').open(out, { fileName: 'x.pdf' })).toMatchObject({ ok: false, needsCertificate: true })
  })
})

const PYHANKO_CHECK = `
import json, sys
from pyhanko.pdf_utils.crypt import SimpleEnvelopeKeyDecrypter
from pyhanko.pdf_utils.crypt.api import AuthStatus
from pyhanko.pdf_utils.reader import PdfFileReader
path, pki = sys.argv[1], sys.argv[2]
out = {}
for name in sys.argv[3:]:
    with open(path, 'rb') as f:
        r = PdfFileReader(f)
        res = r.decrypt_pubkey(SimpleEnvelopeKeyDecrypter.load(f'{pki}/{name}.key', f'{pki}/{name}.crt'))
        entry = {'status': res.status.name, 'mac': res.mac_status.name}
        if res.status != AuthStatus.FAILED:
            entry['permissions'] = res.permission_flags.as_uint32()
            entry['title'] = str(r.trailer['/Info']['/Title'])
            entry['pages'] = int(r.root['/Pages']['/Count'])
            entry['v'] = int(r.security_handler.version.as_pdf_object())
        out[name] = entry
print(json.dumps(out))
`

describe.skipIf(!hasPyHanko())('pyHanko opens what Fartcrobat creates', () => {
  it('two groups, per-group permissions', async () => {
    const e = await openFixture('passwordless/source.pdf')
    const out = await encrypt(e, [group(['alice'], PRINT_ONLY), group(['bob'], {}, true)])
    const path = join(TMP, 'two-groups.pdf')
    writeFileSync(path, out)
    const script = join(TMP, 'check.py')
    writeFileSync(script, PYHANKO_CHECK)
    const r = spawnSync('python3', ['-I', script, path, PKI, 'alice', 'bob', 'stranger'], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const res = JSON.parse(r.stdout) as Record<string, { status: string; mac: string; permissions?: number; title?: string; pages?: number; v?: number }>
    expect(res.alice).toMatchObject({ status: 'USER', permissions: 0xfffff8c5, title: 'Secret title', pages: 2, v: 5 })
    expect(res.bob).toMatchObject({ status: 'USER', permissions: 0xffffffff, title: 'Secret title', pages: 2 })
    // No MAC is written, and the "tolerate a missing MAC" bit tells pyHanko not to require one.
    expect(res.alice.mac).toBe('NOT_APPLICABLE')
    expect(res.bob.mac).toBe('NOT_APPLICABLE')
    expect(res.stranger.status).toBe('FAILED')
  })

  it('why bit 13 is set: without a PDF MAC, pyHanko refuses a file whose envelope clears it', async () => {
    const e = await openFixture('passwordless/source.pdf')
    const seed = Uint8Array.from({ length: 20 }, (_, i) => 100 + i)
    const envelope = buildEnvelopedData([certDer('alice')], seed, 0xfffffffd & ~0x1000)
    const out = writePubSecDocument(e.session.mupdf, e.session.pdf, writeKeyFor(seed, [envelope]))
    const path = join(TMP, 'mac-required.pdf')
    writeFileSync(path, out)
    const script = join(TMP, 'check.py')
    writeFileSync(script, PYHANKO_CHECK)
    const r = spawnSync('python3', ['-I', script, path, PKI, 'alice'], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout).alice).toMatchObject({ status: 'FAILED', mac: 'FAILED' })
  })

  it('re-encrypted from a certificate-encrypted V4 document', async () => {
    const e = await openFixtureAs('v4-aes128.pdf', 'alice')
    const out = await encrypt(e, [group(['alice', 'bob'])])
    const path = join(TMP, 'from-v4.pdf')
    writeFileSync(path, out)
    const script = join(TMP, 'check.py')
    writeFileSync(script, PYHANKO_CHECK)
    const r = spawnSync('python3', ['-I', script, path, PKI, 'alice', 'bob'], { encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    const res = JSON.parse(r.stdout) as Record<string, { status: string; permissions?: number; title?: string }>
    for (const name of ['alice', 'bob']) expect(res[name]).toMatchObject({ status: 'USER', permissions: 0xfffffffd, title: 'Secret title' })
  })
})
