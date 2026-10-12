import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createLocalEngine } from '@engine/local'
import type annotOps from '@engine/ops/annots'
import type docOps from '@engine/ops/doc'
import type formOps from '@engine/ops/forms'
import type sigOps from '@features/digital-signatures/engine'
import { createSelfSignedId, validateNewId } from '@features/digital-signatures/lib/digitalId'
import { parseDigitalId, WrongPasswordError, type ParsedDigitalId } from '@features/digital-signatures/lib/pkcs12'
import { readRevisions } from '@features/digital-signatures/lib/pdfbytes'
import { parseCertificate } from '@features/digital-signatures/lib/x509'
import { signatureStatus } from '@features/digital-signatures/status'
import type { AppearanceContent, SignRequest, ValidationReport } from '@features/digital-signatures/types'
import { fixture, openFixture } from './helpers'

const TMP = mkdtempSync(join(tmpdir(), 'fc-digsig-'))
const PASSWORD = 'correct horse'

function hasTool(cmd: string, args: string[] = ['-v']): boolean {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore' })
    return r.status !== null && !r.error
  } catch {
    return false
  }
}

const appearance = (name: string): AppearanceContent => ({
  name,
  reason: 'I am the author of this document',
  location: 'Testville',
  time: Date.UTC(2026, 9, 11, 12, 0, 0),
  options: {
    graphic: 'name',
    showName: true,
    showDate: true,
    showReason: true,
    showLocation: true,
    showLabels: true,
    showDistinguishedName: false
  }
})

function request(id: ParsedDigitalId, extra: Partial<SignRequest> = {}): SignRequest {
  const name = id.signer.subject.attrs.find((a) => a.short === 'CN')!.value
  return {
    mode: 'sign',
    target: { kind: 'new', page: 0, rect: [72, 600, 300, 680] },
    key: { pkcs8: id.pkcs8, alg: id.keyAlg },
    chain: id.chain,
    appearance: appearance(name),
    reason: 'I am the author of this document',
    location: 'Testville',
    contactInfo: 'jane@example.com',
    ...extra
  }
}

async function openBytes(bytes: Uint8Array, name = 'signed.pdf', password?: string) {
  const engine = await createLocalEngine()
  const doc = engine.ops<typeof docOps>('doc')
  const res = await doc.open(bytes, { fileName: name, password })
  if (!res.ok) throw new Error('needs password')
  return Object.assign(engine, { info: res.info, doc, sig: engine.ops<typeof sigOps>('digital-signatures') })
}

async function validateBytes(bytes: Uint8Array, password?: string): Promise<ValidationReport> {
  const e = await openBytes(bytes, 'signed.pdf', password)
  return e.sig.validate()
}

let rsaId: ParsedDigitalId
let ecId: ParsedDigitalId
let rsaP12: Uint8Array

beforeAll(async () => {
  const rsa = await createSelfSignedId({
    name: 'Jane Doe',
    organization: 'Fartcrobat Tests',
    email: 'jane@example.com',
    country: 'US',
    keyType: 'RSA',
    years: 5,
    password: PASSWORD
  })
  rsaP12 = rsa.p12
  rsaId = parseDigitalId(rsa.p12, PASSWORD)
  const ec = await createSelfSignedId({ name: 'Émile Zoë', keyType: 'EC', years: 1, password: 'pässwörd-ü' })
  ecId = parseDigitalId(ec.p12, 'pässwörd-ü')
})

describe('Digital IDs', () => {
  it('creates self-signed RSA and ECDSA IDs that round-trip through PKCS#12', () => {
    expect(rsaId.keyAlg).toEqual({ type: 'RSA', bits: 2048 })
    expect(rsaId.chain).toHaveLength(1)
    const cert = parseCertificate(rsaId.chain[0])
    expect(cert.subject.text).toBe('E=jane@example.com, CN=Jane Doe, O=Fartcrobat Tests, C=US')
    expect(cert.keyUsage).toContain('Non-repudiation')
    expect(cert.notAfter.getFullYear() - cert.notBefore.getFullYear()).toBe(5)
    expect(ecId.keyAlg).toEqual({ type: 'EC', curve: 'P-256' })
    expect(parseCertificate(ecId.chain[0]).subject.text).toBe('CN=Émile Zoë')
  })

  it('rejects a wrong password and validates the create form', () => {
    expect(() => parseDigitalId(rsaP12, 'nope')).toThrow(WrongPasswordError)
    expect(validateNewId({ name: '', password: 'secret1' })).toMatch(/name/)
    expect(validateNewId({ name: 'A', password: '123' })).toMatch(/6 characters/)
    expect(validateNewId({ name: 'A', password: '123456', confirm: '1234567' })).toMatch(/match/)
    expect(validateNewId({ name: 'A', country: 'USA', password: '123456' })).toMatch(/country/)
    expect(validateNewId({ name: 'A', password: '123456', confirm: '123456' })).toBeNull()
  })

  it.skipIf(!hasTool('openssl', ['version']))('produces .p12 files OpenSSL can read', () => {
    const p = join(TMP, 'id.p12')
    writeFileSync(p, rsaP12)
    const out = execFileSync('openssl', ['pkcs12', '-in', p, '-passin', `pass:${PASSWORD}`, '-nodes', '-info'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    expect(out).toContain('BEGIN CERTIFICATE')
    expect(out).toContain('PRIVATE KEY')
  })
})

describe('signing and validation', () => {
  it('signs text.pdf and validates it as intact, with unknown identity', async () => {
    const e = await openFixture('text.pdf')
    const sig = e.ops<typeof sigOps>('digital-signatures')
    const { bytes, fieldName } = await sig.sign(request(rsaId))
    expect(fieldName).toBe('Signature1')
    // The open document is untouched: not dirty, no field, nothing to undo.
    expect(await e.doc.isDirty()).toBe(false)
    expect((await sig.fields()).length).toBe(0)
    expect((await e.doc.journal()).canUndo).toBe(false)
    const after = await openBytes(await e.doc.save({ mode: 'full' }))
    expect(await after.sig.fields()).toEqual([])

    const report = await validateBytes(bytes)
    expect(report.signatures).toHaveLength(1)
    const r = report.signatures[0]
    expect(r.integrity).toBe(true)
    expect(r.signatureValid).toBe(true)
    expect(r.coversWholeFile).toBe(true)
    expect(r.problems).toEqual([])
    expect(r.signerName).toBe('Jane Doe')
    expect(r.reason).toBe('I am the author of this document')
    expect(r.location).toBe('Testville')
    expect(r.subFilter).toBe('ETSI.CAdES.detached')
    expect(r.digestAlgorithm).toBe('SHA-256')
    expect(r.page).toBe(0)
    expect(r.rect[0]).toBeCloseTo(72, 1)
    expect(r.rect[1]).toBeCloseTo(600, 1)
    expect(r.certificates[0].selfSigned).toBe(true)
    expect(r.revision).toBe(2)
    expect(r.revisionCount).toBe(2)
    const status = signatureStatus(r, new Set())
    expect(status.level).toBe('unknown-identity')
    expect(status.title).toBe("Signature is valid, but the signer's identity is unknown.")
    const trusted = signatureStatus(r, new Set([r.certificates[0].sha256]))
    expect(trusted.level).toBe('valid')
  })

  it('detects a tampered byte inside the signed range', async () => {
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const tampered = bytes.slice()
    // Change a character of the page text stream region (well inside the first range).
    const pos = 2000
    tampered[pos] = tampered[pos] === 0x41 ? 0x42 : 0x41
    const report = await validateBytes(tampered)
    const r = report.signatures[0]
    expect(r.integrity).toBe(false)
    expect(signatureStatus(r, new Set()).level).toBe('invalid')
  })

  it('signs twice: both signatures stay valid and the later one is reported as a permitted change', async () => {
    const e = await openFixture('text.pdf')
    const first = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const e2 = await openBytes(first.bytes)
    const second = await e2.sig.sign(request(ecId, { target: { kind: 'new', page: 1, rect: [300, 650, 540, 720] }, subFilter: 'adbe.pkcs7.detached' }))
    expect(second.fieldName).toBe('Signature2')
    const report = await validateBytes(second.bytes)
    expect(report.signatures.map((s) => s.fieldName)).toEqual(['Signature1', 'Signature2'])
    const [a, b] = report.signatures
    expect(a.integrity && a.signatureValid).toBe(true)
    expect(b.integrity && b.signatureValid).toBe(true)
    expect(a.coversWholeFile).toBe(false)
    expect(b.coversWholeFile).toBe(true)
    expect(a.changes.map((c) => c.description)).toContain('Signature field “Signature2” was added and signed')
    expect(a.changes.every((c) => c.allowed)).toBe(true)
    expect(signatureStatus(a, new Set()).level).toBe('unknown-identity')
    expect(b.signerName).toBe('Émile Zoë')
    expect(b.signatureAlgorithm).toBe('ECDSA with SHA-256')
    expect(report.revisionCount).toBe(3)

    // "View signed version": the first revision on its own validates as covering the whole file.
    const e3 = await openBytes(second.bytes)
    const rev = await e3.sig.revisionBytes(a.revisionEnd)
    expect(rev.length).toBe(first.bytes.length)
    const revReport = await validateBytes(rev)
    expect(revReport.signatures).toHaveLength(1)
    expect(revReport.signatures[0].coversWholeFile).toBe(true)

    writeFileSync(join(TMP, 'twice.pdf'), second.bytes)
  })

  it('reports comments added after signing', async () => {
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const e2 = await openBytes(bytes)
    await e2.ops<typeof annotOps>('annots').create(2, { type: 'Text', rect: [100, 100, 120, 120], contents: 'later note' })
    const updated = await e2.doc.save({})
    const report = await validateBytes(updated)
    const r = report.signatures[0]
    expect(r.integrity).toBe(true)
    expect(r.coversWholeFile).toBe(false)
    const comment = r.changes.find((c) => c.category === 'annotation')
    expect(comment?.description).toMatch(/^Page 3: 1 comment added/)
    expect(comment?.allowed).toBe(true)
    const st = signatureStatus(r, new Set())
    expect(st.level).toBe('unknown-identity')
  })

  it('certifies a form: filling in is allowed, comments are not (P=2)', async () => {
    const e = await openFixture('form.pdf')
    const sig = e.ops<typeof sigOps>('digital-signatures')
    const cap = await sig.capability()
    expect(cap.canCertify).toBe(true)
    const { bytes } = await sig.sign(request(rsaId, { mode: 'certify', permission: 2, target: { kind: 'invisible' } }))
    const e2 = await openBytes(bytes, 'certified.pdf')
    const cap2 = await e2.sig.capability()
    expect(cap2.certified).toBe(2)
    expect(cap2.canCertify).toBe(false)
    const report0 = await e2.sig.validate()
    expect(report0.certified).toBe(2)
    expect(report0.signatures[0].kind).toBe('certification')
    expect(report0.signatures[0].invisible).toBe(true)

    const forms = e2.ops<typeof formOps>('forms')
    const fields = await forms.listAll()
    await forms.setValue(fields.find((f) => f.name === 'fullName')!.id, 'Ada Lovelace')
    const filled = await e2.doc.save({})
    const r1 = (await validateBytes(filled)).signatures[0]
    expect(r1.changes.length).toBeGreaterThan(0)
    expect(r1.changes.find((c) => c.category === 'form')?.description).toBe('Form field “fullName” was filled in or changed')
    expect(r1.changes.every((c) => c.allowed)).toBe(true)
    expect(signatureStatus(r1, new Set()).level).toBe('unknown-identity')

    const e3 = await openBytes(filled)
    await e3.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [50, 50, 70, 70], contents: 'not allowed' })
    const commented = await e3.doc.save({})
    const r2 = (await validateBytes(commented)).signatures[0]
    expect(r2.changes.some((c) => c.category === 'annotation' && !c.allowed)).toBe(true)
    expect(signatureStatus(r2, new Set()).level).toBe('invalid')
  })

  it('signs an existing unsigned signature field and an encrypted document', async () => {
    // Make a field by signing, clearing (undoable) and saving.
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const e2 = await openBytes(bytes)
    await e2.sig.clearSignature('Signature1')
    expect((await e2.sig.fields())[0].signed).toBe(false)
    await e2.doc.undo()
    expect((await e2.sig.fields())[0].signed).toBe(true)
    await e2.doc.redo()
    const cleared = await e2.doc.save({ mode: 'full' })
    const e3 = await openBytes(cleared)
    expect((await e3.sig.fields()).map((f) => [f.name, f.signed])).toEqual([['Signature1', false]])
    const signedField = await e3.sig.sign(request(rsaId, { target: { kind: 'field', name: 'Signature1' } }))
    const r = (await validateBytes(signedField.bytes)).signatures
    expect(r).toHaveLength(1)
    expect(r[0].fieldName).toBe('Signature1')
    expect(r[0].integrity && r[0].signatureValid).toBe(true)

    const enc = await openFixture('encrypted.pdf', 'secret')
    const encSigned = await enc.ops<typeof sigOps>('digital-signatures').sign(request(ecId))
    const encReport = await validateBytes(encSigned.bytes, 'secret')
    expect(encReport.signatures[0].integrity).toBe(true)
    expect(encReport.signatures[0].signatureValid).toBe(true)
    expect(encReport.signatures[0].reason).toBe('I am the author of this document')
  })

  it('locks the document after signing', async () => {
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId, { lock: true }))
    const e2 = await openBytes(bytes)
    const cap = await e2.sig.capability()
    expect(cap.locked).toBe(true)
    expect(cap.canSign).toBe(false)
    await expect(e2.sig.clearSignature('Signature1')).rejects.toThrow(/locked/)
    const report = await e2.sig.validate()
    expect(report.locked).toBe(true)
    expect(report.signatures[0].lock?.permission).toBe(1)
  })

  it('renders an appearance preview and includes unsigned fields in the report', async () => {
    const e = await openFixture('text.pdf')
    const sig = e.ops<typeof sigOps>('digital-signatures')
    const png = await sig.previewAppearance(appearance('Jane Doe'), 240, 80, 2)
    expect(Array.from(png.slice(1, 4))).toEqual([0x50, 0x4e, 0x47])
    const report = await sig.validate()
    expect(report.signatures).toHaveLength(0)
    expect(report.unsigned).toHaveLength(0)
  })

  it('reads revisions of a twice-signed file', async () => {
    const e = await openFixture('text.pdf')
    const first = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const revs = await readRevisions(first.bytes)
    expect(revs.sections).toHaveLength(2)
    expect(revs.sections[1].entries?.size).toBeGreaterThan(2)
    const orig = await readRevisions(fixture('text.pdf'))
    expect(orig.sections).toHaveLength(1)
  })
})

describe('interoperability', () => {
  let file = ''
  beforeAll(async () => {
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    file = join(TMP, 'signed.pdf')
    writeFileSync(file, bytes)
  })

  it.skipIf(!hasTool('python3', ['-c', 'import pypdf']))('pypdf sees the /Sig field and a byte range covering the file', () => {
    const script = `
import sys, pypdf
r = pypdf.PdfReader(sys.argv[1])
size = len(open(sys.argv[1], 'rb').read())
fields = r.get_fields()
sig = fields['Signature1']
assert sig['/FT'] == '/Sig', sig
v = sig['/V'].get_object()
br = [int(x) for x in v['/ByteRange']]
assert br[0] == 0 and br[2] + br[3] == size, (br, size)
assert len(r.pages) == 5
print('ok', v['/SubFilter'])
`
    const out = execFileSync('python3', ['-c', script, file]).toString()
    expect(out).toContain('ok /ETSI.CAdES.detached')
  })

  it.skipIf(!hasTool('openssl', ['version']))('OpenSSL verifies the CMS signature over the signed byte ranges', async () => {
    const { readFileSync } = await import('node:fs')
    const bytes = new Uint8Array(readFileSync(file))
    const text = Buffer.from(bytes).toString('latin1')
    const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text)!
    const br = m.slice(1).map(Number)
    const data = Buffer.concat([Buffer.from(bytes.subarray(br[0], br[0] + br[1])), Buffer.from(bytes.subarray(br[2], br[2] + br[3]))])
    const hex = Buffer.from(bytes.subarray(br[1] + 1, br[2] - 1)).toString('latin1')
    const cms = Buffer.from(hex.replace(/(00)+$/, ''), 'hex')
    writeFileSync(join(TMP, 'content.bin'), data)
    writeFileSync(join(TMP, 'sig.der'), cms)
    const res = spawnSync('openssl', ['cms', '-verify', '-binary', '-noverify', '-inform', 'DER', '-in', join(TMP, 'sig.der'), '-content', join(TMP, 'content.bin'), '-out', '/dev/null'])
    expect(res.stderr.toString()).toContain('Verification successful')
  })

  it.skipIf(!hasTool('pdfsig', ['-v']))('poppler pdfsig reports the signatures as valid', () => {
    const res = spawnSync('pdfsig', [join(TMP, 'twice.pdf')])
    const out = res.stdout.toString()
    expect(out).toContain('Signature #1')
    expect(out).toContain('Signature #2')
    expect(out.match(/Signature Validation: Signature is Valid\./g)?.length).toBe(2)
  })
})
