// Files made from certificate-encrypted documents (Extract, Split, Combine, the Compare report,
// Optimize) keep their certificate security: V5 PubSec with the source's own envelopes, never the
// temporary bridge, and they open in another engine with the same key. Certificate-encrypted side
// inputs (insert, replace, combine, create) open with keys the engine holds, and ask for one
// otherwise. Signing them is refused, and Protect reports their security from the envelope.
import { describe, expect, it } from 'vitest'
import { assertNoBridge, readPubSec, type PubSecState } from '@engine/crypt'
import { createLocalEngine, type LocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type pageOps from '@engine/ops/pages'
import type compareOps from '@features/compare/engine'
import { inlineBackend, runComparison } from '@features/compare/pipeline'
import type { ReportInput } from '@features/compare/report'
import { DEFAULT_OPTIONS } from '@features/compare/types'
import type sigOps from '@features/digital-signatures/engine'
import type { SignRequest } from '@features/digital-signatures/types'
import type exportOps from '@features/export-create/engine'
import type organizeOps from '@features/organize-pages/engine'
import type protectOps from '@features/protect-optimize/engine'
import { presetOptions } from '@features/protect-optimize/shared'
import type { CertificateKey } from '@shared/certkeys'
import type { DocInfo, Permission } from '@shared/types'
import { fixture, openFixture, type OpenedEngine } from './helpers'
import { includesBytes, keyFor, openFixtureAs, pageText, pubsecFixture, type Engine } from './passwordless-helpers'

const PLAINTEXT = ['Hello secret world', 'Note text in an object stream', 'Page two text', 'Field value']
const ALL: Permission[] = ['print', 'print-hq', 'edit', 'annotate', 'form', 'assemble', 'copy', 'accessibility']

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const org = (e: LocalEngine) => e.ops<typeof organizeOps>('organize-pages')
const pages = (e: LocalEngine) => e.ops<typeof pageOps>('pages')
const cmp = (e: LocalEngine) => e.ops<typeof compareOps>('compare')
const protect = (e: LocalEngine) => e.ops<typeof protectOps>('protect-optimize')
const docOf = (e: LocalEngine) => e.ops<typeof docOps>('doc')

/**
 * The output is V5 AES-256 PubSec with `recipients` (the source's envelopes, in order), holds no
 * plaintext of the source, no Standard handler and nothing of the source session's bridge.
 */
function expectCertificateOutput(out: Uint8Array, recipients: Uint8Array[], label: string, state?: PubSecState | null) {
  const info = readPubSec(out)
  expect(info, `${label}: certificate-encrypted`).not.toBeNull()
  expect(info!.version, label).toBe(5)
  expect(info!.cipher, label).toBe('AESV3')
  expect(info!.keyLength, label).toBe(32)
  expect(info!.encryptMetadata, label).toBe(true)
  expect(info!.recipients.map(toHex), `${label}: same envelopes`).toEqual(recipients.map(toHex))
  for (const s of PLAINTEXT) expect(includesBytes(out, s), `${label}: "${s}" in clear`).toBe(false)
  expect(/\/Filter\s*\/Standard/.test(Buffer.from(out).toString('latin1')), `${label}: Standard handler`).toBe(false)
  if (state?.bridge) {
    const text = Buffer.from(out).toString('latin1')
    for (const v of [state.bridge.U, state.bridge.O]) {
      expect(includesBytes(out, Buffer.from(v).toString('latin1')), `${label}: bridge bytes`).toBe(false)
      expect(text.toLowerCase().includes(toHex(v)), `${label}: bridge hex`).toBe(false)
    }
    expect(text.includes(state.bridge.userPassword) || text.includes(state.bridge.ownerPassword), `${label}: bridge password`).toBe(false)
  }
  assertNoBridge(out, state ?? null)
}

/** Opens bytes in a fresh engine that was only given `key` (as a new tab made from the document). */
async function openGiven(bytes: Uint8Array, key: CertificateKey, name = 'out.pdf'): Promise<OpenedEngine> {
  const engine = await createLocalEngine()
  const doc = docOf(engine)
  await doc.addCertificateKey(key)
  const res = await doc.open(bytes, { fileName: name, dirty: true })
  if (!res.ok) throw new Error(`${name}: the key did not open it`)
  return Object.assign(engine, { info: res.info as DocInfo, doc })
}

/** Opening without a key asks for one. */
async function needsCertificate(bytes: Uint8Array): Promise<boolean> {
  const engine = await createLocalEngine()
  const res = await docOf(engine).open(bytes, { fileName: 'x.pdf' })
  return !res.ok && !!res.needsCertificate
}

async function texts(e: OpenedEngine): Promise<string[]> {
  const out: string[] = []
  for (let i = 0; i < e.info.pageCount; i++) out.push((await pageText(e as Engine, i)).trim().split('\n')[0])
  return out
}

const recipientsOf = (file: string) => readPubSec(pubsecFixture(file))!.recipients

describe('Extract and Split keep certificate security', () => {
  // v5-classic opens through the R6 bridge; v4-aes128 and v5-nometa through the decrypt pass (and
  // their outputs are upgraded to V5 AES-256 with the same envelopes).
  for (const file of ['v5-classic.pdf', 'v4-aes128.pdf', 'v5-nometa.pdf', 'v5-objstm.pdf']) {
    it(`pages.extract and organize-pages extract (${file})`, async () => {
      const e = await openFixtureAs(file, 'alice')
      const key = keyFor(file, 'alice')
      for (const [label, out] of [
        ['pages.extract', await pages(e).extract([1])],
        ['organize-pages extract', await org(e).extract([1])]
      ] as const) {
        expectCertificateOutput(out, recipientsOf(file), `${file} ${label}`, e.session.pubsec)
        expect(await needsCertificate(out)).toBe(true)
        const opened = await openGiven(out, key)
        expect(opened.info.pageCount).toBe(1)
        expect(opened.info.security).toBe('certificate')
        expect(opened.info.encryption).toBe('Adobe.PubSec V5 256-bit AES')
        expect(await texts(opened)).toEqual(['Page two text'])
      }
    })
  }

  it('reports the protection, with no password', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    expect(await org(e).protection()).toEqual({ method: '256-bit AES', needsPassword: false, restricted: false, certificate: true })
    expect(await org(e).openPassword()).toBeNull()
    // V4 sources: outputs are written as V5, AES-256.
    const v4 = await openFixtureAs('v4-rc4.pdf', 'alice')
    expect((await org(v4).protection())?.method).toBe('256-bit AES')
  })

  it('a restricted recipient: restricted, and the output keeps every envelope', async () => {
    const file = 'v5-two-envelopes.pdf'
    const e = await openFixtureAs(file, 'alice')
    expect(await org(e).protection()).toEqual({ method: '256-bit AES', needsPassword: false, restricted: true, certificate: true })
    const out = await pages(e).extract([0])
    expectCertificateOutput(out, recipientsOf(file), file, e.session.pubsec)
    // alice keeps her printing-only envelope, bob his full access.
    const asAlice = await openGiven(out, keyFor(file, 'alice'))
    expect(asAlice.info.permissions.print).toBe(true)
    expect(asAlice.info.permissions.edit).toBe(false)
    const asBob = await openGiven(out, keyFor(file, 'bob'))
    expect(asBob.info.permissions.edit).toBe(true)
  })

  it('pages copied into another document travel without protection (keepProtection false)', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    const out = await org(e).extract([0], { keepProtection: false })
    expect(readPubSec(out)).toBeNull()
    const plain = await createLocalEngine()
    const res = await docOf(plain).open(out, { fileName: 'plain.pdf' })
    expect(res.ok).toBe(true)
  })

  it('Split by pages and by size', async () => {
    const file = 'v5-classic.pdf'
    const e = await openFixtureAs(file, 'alice')
    const key = keyFor(file, 'alice')
    for (const [i, part] of [[0], [1]].entries()) {
      const out = await org(e).extract(part)
      expectCertificateOutput(out, recipientsOf(file), `part ${i + 1}`, e.session.pubsec)
      expect(await texts(await openGiven(out, key))).toEqual([i === 0 ? 'Hello secret world' : 'Page two text'])
    }
    // Sizes are measured as certificate-encrypted files: one page per part when a part may only
    // hold about one page.
    const one = (await org(e).extract([0])).length
    const plan = await org(e).splitPlanBySize(one + 64)
    expect(plan.length).toBe(2)
    for (const p of plan) {
      const out = await org(e).extract(Array.from({ length: p.end - p.start + 1 }, (_, k) => p.start + k))
      expectCertificateOutput(out, recipientsOf(file), 'split by size', e.session.pubsec)
      expect(out.length).toBeLessThanOrEqual(one + 64)
    }
    const whole = await org(e).splitPlanBySize(10_000_000)
    expect(whole).toEqual([expect.objectContaining({ start: 0, end: 1 })])
  })
})

describe('Combine and other side inputs', () => {
  const certFile = 'v5-classic.pdf'
  const certSource = () => ({ data: pubsecFixture(certFile), fileName: certFile })

  it('probe and openScratch ask for a key, then open with it', async () => {
    const e = await createLocalEngine()
    const probe = await org(e).probe(pubsecFixture(certFile), certFile)
    expect(probe.ok).toBe(false)
    if (probe.ok || !probe.needsCertificate) throw new Error('expected needsCertificate')
    expect(probe.certificate.version).toBe(5)
    expect(probe.certificate.recipients.map(toHex)).toEqual(recipientsOf(certFile).map(toHex))
    expect(await org(e).openScratch('a', pubsecFixture(certFile), certFile)).toMatchObject({ ok: false, needsCertificate: true })
    // The key of another file does not help.
    await docOf(e).addCertificateKey(keyFor('stranger-only.pdf', 'stranger'))
    expect(await org(e).probe(pubsecFixture(certFile), certFile)).toMatchObject({ ok: false, needsCertificate: true })
    await docOf(e).addCertificateKey(keyFor(certFile, 'alice'))
    expect(await org(e).probe(pubsecFixture(certFile), certFile)).toMatchObject({ ok: true, pageCount: 2, title: 'Secret title', access: 'owner' })
    expect(await org(e).openScratch('a', pubsecFixture(certFile), certFile)).toMatchObject({ ok: true, pageCount: 2 })
    const thumb = await org(e).scratchThumbnail('a', 0, 64)
    expect(thumb.png.length).toBeGreaterThan(100)
  })

  it('combine with a certificate-encrypted first input keeps its security', async () => {
    const e = await createLocalEngine()
    await expect(org(e).combineWithProtection([certSource(), { data: fixture('text.pdf'), fileName: 'text.pdf' }])).rejects.toMatchObject({
      code: 'NEEDS_CERTIFICATE',
      message: `${certFile} is encrypted with certificates`
    })
    const key = keyFor(certFile, 'alice')
    await docOf(e).addCertificateKey(key)
    const { bytes, protection } = await org(e).combineWithProtection([certSource(), { data: fixture('text.pdf'), fileName: 'text.pdf' }])
    expect(protection).toEqual({ index: 0, fileName: certFile, summary: { method: '256-bit AES', needsPassword: false, restricted: false, certificate: true } })
    expectCertificateOutput(bytes, recipientsOf(certFile), 'combine')
    const opened = await openGiven(bytes, key)
    expect(opened.info.pageCount).toBe(7)
    expect((await texts(opened))[0]).toBe('Hello secret world')
  })

  it('combine keeps the first protected input: certificate after a plain file, password before it', async () => {
    const e = await createLocalEngine()
    const key = keyFor(certFile, 'alice')
    await docOf(e).addCertificateKey(key)
    // A scratch document (Combine Files keeps the files it shows open).
    await org(e).openScratch('cert', pubsecFixture(certFile), certFile)
    const second = await org(e).combineWithProtection([
      { data: fixture('text.pdf'), fileName: 'text.pdf' },
      { key: 'cert', fileName: certFile }
    ])
    expect(second.protection?.index).toBe(1)
    expect(second.protection?.summary.certificate).toBe(true)
    expectCertificateOutput(second.bytes, recipientsOf(certFile), 'combine (second)')
    expect((await openGiven(second.bytes, key)).info.pageCount).toBe(7)

    const pw = await org(e).combineWithProtection([
      { data: fixture('encrypted.pdf'), fileName: 'encrypted.pdf', password: 'secret' },
      { key: 'cert', fileName: certFile }
    ])
    expect(pw.protection?.index).toBe(0)
    expect(pw.protection?.summary.certificate).toBeFalsy()
    expect(pw.protection?.summary.needsPassword).toBe(true)
    expect(readPubSec(pw.bytes)).toBeNull()
    const withPassword = await createLocalEngine()
    const res = await docOf(withPassword).open(pw.bytes, { fileName: 'pw.pdf', password: 'secret' })
    expect(res.ok).toBe(true)
  })

  it('a certificate-encrypted input in a restricted copy: its own permissions in the summary', async () => {
    const e = await createLocalEngine()
    await docOf(e).addCertificateKey(keyFor('v5-two-envelopes.pdf', 'alice'))
    const { protection } = await org(e).combineWithProtection([{ data: pubsecFixture('v5-two-envelopes.pdf'), fileName: 'two.pdf' }])
    expect(protection?.summary).toEqual({ method: '256-bit AES', needsPassword: false, restricted: true, certificate: true })
  })

  it('insertFiles and replace with a registered key; the document keeps its own security', async () => {
    const e = await openFixture('text.pdf')
    const files = [{ data: pubsecFixture('v4-aes128.pdf'), fileName: 'v4.pdf' }]
    await expect(org(e).insertFiles(0, files)).rejects.toMatchObject({ code: 'NEEDS_CERTIFICATE' })
    expect((await e.doc.info()).pageCount).toBe(5)
    await e.doc.addCertificateKey(keyFor('v4-aes128.pdf', 'alice'))
    expect(await org(e).insertFiles(0, files)).toEqual([0, 1])
    expect((await texts(Object.assign(e, { info: await e.doc.info() })))[0]).toBe('Hello secret world')
    const replaced = await org(e).replace(2, 2, { data: pubsecFixture('v4-aes128.pdf'), fileName: 'v4.pdf', pages: [1] })
    expect(replaced).toEqual({ replaced: 1, inserted: 0, removed: 0 })
    // The open document was plain and stays plain.
    const saved = await e.doc.save({})
    expect(readPubSec(saved)).toBeNull()
    expect(includesBytes(saved, '/Encrypt')).toBe(false)
  })

  it('the core insertFrom asks for a key too', async () => {
    const e = await openFixture('text.pdf')
    await expect(pages(e).insertFrom(-1, pubsecFixture(certFile), { fileName: certFile })).rejects.toMatchObject({ code: 'NEEDS_CERTIFICATE' })
    await e.doc.addCertificateKey(keyFor(certFile, 'alice'))
    expect(await pages(e).insertFrom(-1, pubsecFixture(certFile), { fileName: certFile })).toBe(2)
  })

  it('Create: a part without a key throws NEEDS_CERTIFICATE naming it', async () => {
    const e = await createLocalEngine()
    const build = e.ops<typeof exportOps>('export-create')
    const parts = [
      { kind: 'file' as const, name: 'text.pdf', data: fixture('text.pdf') },
      { kind: 'file' as const, name: 'Secret report.pdf', data: pubsecFixture(certFile) }
    ]
    await expect(build.build(parts)).rejects.toMatchObject({
      code: 'NEEDS_CERTIFICATE',
      message: 'Secret report.pdf is encrypted with certificates'
    })
    await docOf(e).addCertificateKey(keyFor(certFile, 'alice'))
    const out = await build.build(parts)
    const made = await createLocalEngine()
    const res = await docOf(made).open(out, { fileName: 'made.pdf' })
    expect(res.ok && res.info.pageCount).toBe(7)
  })
})

describe('Compare report', () => {
  it('keeps the certificate security of the compared document', async () => {
    const file = 'v5-classic.pdf'
    const ea = await openFixtureAs(file, 'alice')
    const eb = await openFixture('passwordless/source.pdf')
    const all = (n: number) => [...Array(n).keys()]
    const result = await runComparison(
      { ops: cmp(ea), pages: all(ea.info.pageCount) },
      { ops: cmp(eb), pages: all(eb.info.pageCount) },
      { ...DEFAULT_OPTIONS },
      inlineBackend
    )
    const input: ReportInput = {
      oldName: 'old.pdf',
      newName: 'new.pdf',
      oldPageCount: ea.info.pageCount,
      newPageCount: eb.info.pageCount,
      oldPages: result.oldPages,
      newPages: result.newPages,
      options: result.options,
      date: '14 Oct 2026',
      changes: result.changes,
      counts: result.counts,
      pageByPage: false,
      removedPdf: null,
      removedPages: []
    }
    const plain = await cmp(eb).report(input)
    expect(await cmp(ea).protection()).toEqual({ method: '256-bit AES', needsPassword: false, restricted: false, certificate: true })
    expect(await cmp(ea).openPassword()).toBeNull()
    const report = await cmp(ea).protectReport(plain)
    expectCertificateOutput(report, recipientsOf(file), 'compare report', ea.session.pubsec)
    const opened = await openGiven(report, keyFor(file, 'alice'))
    expect(opened.info.pageCount).toBeGreaterThan(0)
    expect(opened.info.security).toBe('certificate')
    // The plain document's own report stays plain.
    expect(await cmp(eb).protection()).toBeNull()
  })
})

describe('Optimize', () => {
  for (const file of ['v5-classic.pdf', 'v4-rc4.pdf', 'v5-incremental.pdf']) {
    it(`Compress keeps the certificate security (${file})`, async () => {
      const e = await openFixtureAs(file, 'alice')
      // The medium preset asks for object streams, which the PubSec writer leaves out.
      const options = presetOptions('medium')
      expect(options.cleanup.objectStreams).toBe(true)
      const { bytes, report } = await protect(e).optimize(options)
      expect(report.keptEncryption).toBe(true)
      expectCertificateOutput(bytes, recipientsOf(file), `optimize ${file}`, e.session.pubsec)
      expect(includesBytes(bytes, '/ObjStm')).toBe(false)
      const opened = await openGiven(bytes, keyFor(file, 'alice'))
      expect(opened.info.pageCount).toBe(2)
      expect(await texts(opened)).toEqual(['Hello secret world', 'Page two text'])
      expect(opened.info.metadata.title).toBe(file === 'v5-incremental.pdf' ? 'Updated secret title' : 'Secret title')
      // The open document is untouched.
      expect(await e.doc.isDirty()).toBe(false)
    })
  }

  it('unsaved changes are in the result', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    await e.doc.setMetadata({ title: 'Changed before compressing' })
    const { bytes } = await protect(e).optimize(presetOptions('high'))
    expect(includesBytes(bytes, 'Changed before compressing')).toBe(false)
    expect((await openGiven(bytes, keyFor('v5-classic.pdf', 'alice'))).info.metadata.title).toBe('Changed before compressing')
  })
})

describe('Protect: security of certificate-encrypted documents', () => {
  it('full access from the envelope', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    const st = await protect(e).security()
    const all = Object.fromEntries(ALL.map((p) => [p, true]))
    expect(st).toEqual({
      encrypted: true,
      method: '256-bit AES',
      needsOpenPassword: false,
      ownerAccess: true,
      permissions: all,
      filePermissions: all
    })
  })

  it('a recipient restricted to printing', async () => {
    const e = await openFixtureAs('v5-two-envelopes.pdf', 'alice')
    const st = await protect(e).security()
    expect(st.ownerAccess).toBe(false)
    expect(st.needsOpenPassword).toBe(false)
    const expected = Object.fromEntries(ALL.map((p) => [p, p === 'print' || p === 'print-hq']))
    expect(st.permissions).toEqual(expected)
    expect(st.filePermissions).toEqual(expected)
  })

  it('the method of older sources', async () => {
    expect((await protect(await openFixtureAs('v4-aes128.pdf', 'alice')).security()).method).toBe('128-bit AES')
    expect((await protect(await openFixtureAs('v4-rc4.pdf', 'alice')).security()).method).toBe('128-bit RC4')
    expect((await protect(await openFixtureAs('v5-nometa.pdf', 'alice')).security()).method).toBe('256-bit AES')
  })

  it('no password opens it, and the bridge is never tried', async () => {
    const e = await openFixtureAs('v5-two-envelopes.pdf', 'alice')
    const bridge = e.session.pubsec!.bridge!
    for (const pw of ['', 'anything', bridge.userPassword, bridge.ownerPassword]) {
      expect(await protect(e).checkPassword(pw, { apply: true })).toEqual({ level: 'none' })
    }
    // Still restricted: the owner password of the bridge was not applied.
    expect((await protect(e).security()).ownerAccess).toBe(false)
    expect((await e.doc.info()).permissions.edit).toBe(false)
  })
})

describe('Signing', () => {
  const message =
    'Signing certificate-encrypted documents is not supported yet. Remove the certificate security (Protect > Remove security) to sign, then encrypt again.'

  it('is refused before anything else happens', async () => {
    const e = await openFixtureAs('v5-classic.pdf', 'alice')
    const sig = e.ops<typeof sigOps>('digital-signatures')
    // An unusable key: refused for the encryption, not for the key.
    const req = {
      mode: 'sign',
      target: { kind: 'new', page: 0, rect: [72, 600, 300, 680] },
      key: { pkcs8: new Uint8Array(0), alg: { type: 'RSA', bits: 2048 } },
      chain: []
    } as unknown as SignRequest
    await expect(sig.sign(req)).rejects.toMatchObject({ code: 'CERTIFICATE_ENCRYPTED', message })
    expect(await sig.capability()).toMatchObject({ canSign: false, canCertify: false, reason: message })
    // Nothing changed.
    expect(await e.doc.isDirty()).toBe(false)
    expect((await e.doc.journal()).canUndo).toBe(false)
  })

  it('plain documents can still be signed (capability)', async () => {
    const e = await openFixture('passwordless/source.pdf')
    expect((await e.ops<typeof sigOps>('digital-signatures').capability()).canSign).toBe(true)
  })

  it('the existing signature of a certificate-encrypted file still validates', async () => {
    const e = await openFixtureAs('v5-signed.pdf', 'alice')
    const report = await e.ops<typeof sigOps>('digital-signatures').validate()
    expect(report.signatures).toHaveLength(1)
    expect(report.signatures[0].integrity).toBe(true)
    expect(report.signatures[0].signatureValid).toBe(true)
  })
})
