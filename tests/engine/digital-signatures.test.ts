import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalEngine } from '@engine/local'
import { collectOpModules } from '@engine/registry'
import type annotOps from '@engine/ops/annots'
import type docOps from '@engine/ops/doc'
import type formOps from '@engine/ops/forms'
import type pageOps from '@engine/ops/pages'
import type sigOps from '@features/digital-signatures/engine'
import { createSelfSignedId, validateNewId } from '@features/digital-signatures/lib/digitalId'
import { parseDigitalId, WrongPasswordError, type ParsedDigitalId } from '@features/digital-signatures/lib/pkcs12'
import * as mupdf from 'mupdf'
import { derLength } from '@features/digital-signatures/lib/cms'
import { certificateToPem } from '@features/digital-signatures/lib/digitalId'
import { readRevisions } from '@features/digital-signatures/lib/pdfbytes'
import { parseCertificate } from '@features/digital-signatures/lib/x509'
import { signatureStatus } from '@features/digital-signatures/status'
import type { AppearanceContent, SignRequest, ValidationReport } from '@features/digital-signatures/types'
import { fixture, openFixture } from './helpers'

const TMP = mkdtempSync(join(tmpdir(), 'fc-digsig-'))
afterAll(() => rmSync(TMP, { recursive: true, force: true }))
const PASSWORD = 'correct horse'

/** Whether `cmd args` runs and exits cleanly (a python3 whose module is missing exits with 1). */
function hasTool(cmd: string, args: string[] = ['-v']): boolean {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore' })
    return r.status === 0 && !r.error
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
    // Valid for five years (compared as a duration: notBefore is backdated a minute, so the
    // calendar years differ by 6 when the test runs in the first minute of a year).
    const years = (cert.notAfter.getTime() - cert.notBefore.getTime()) / (365.25 * 24 * 3600 * 1000)
    expect(years).toBeCloseTo(5, 1)
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
    expect(a.laterUpdates).toBe('signing')
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

  it('revalidates an edited document from the cached checks of its file', async () => {
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const e2 = await openBytes(bytes)
    const first = await e2.sig.validate()
    // An unsaved edit (rotating a page) moves the field; the file checks stay the same.
    await e2.ops<typeof pageOps>('pages').rotate([0], 90)
    const second = await e2.sig.validate()
    const [a, b] = [first.signatures[0], second.signatures[0]]
    expect(b.integrity && b.signatureValid).toBe(true)
    expect(b.certificates).toEqual(a.certificates)
    expect(b.problems).toEqual([])
    expect(b.rect).not.toEqual(a.rect)
    // Results are copies: changing one report does not leak into the next.
    b.problems.push('x')
    expect((await e2.sig.validate()).signatures[0].problems).toEqual([])
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
    // Allowed or not, anything but a later signature caps the status at a warning.
    expect(r.laterUpdates).toBe('other')
    const st = signatureStatus(r, new Set())
    expect(st.level).toBe('warning')
    expect(st.title).toBe('The document was changed after it was signed.')
    expect(st.details.join(' ')).toMatch(/View Signed Version/)
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
    // Filling in is allowed by the certifier, so it is not invalid; but the document changed.
    expect(signatureStatus(r1, new Set()).level).toBe('warning')

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
    const padded = new Uint8Array(Buffer.from(hex, 'hex'))
    const cms = Buffer.from(padded.subarray(0, derLength(padded)))
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

describe('more documents', () => {
  it('signs a file that uses object and cross-reference streams, and lists later changes', async () => {
    const src = new mupdf.PDFDocument(fixture('text.pdf'))
    const buf = src.saveToBuffer('garbage,compress,objstms')
    const compact = buf.asUint8Array().slice()
    buf.destroy()
    src.destroy()
    expect(Buffer.from(compact).toString('latin1')).toContain('/ObjStm')
    const e = await openBytes(compact, 'objstm.pdf')
    const { bytes } = await e.sig.sign(request(rsaId))
    const r = (await validateBytes(bytes)).signatures[0]
    expect(r.integrity && r.signatureValid && r.coversWholeFile).toBe(true)
    const e2 = await openBytes(bytes)
    await e2.ops<typeof annotOps>('annots').create(0, { type: 'Square', rect: [40, 40, 90, 90] })
    const later = await e2.doc.save({})
    const r2 = (await validateBytes(later)).signatures[0]
    expect(r2.integrity).toBe(true)
    expect(r2.changesUnknown).toBe(false)
    expect(r2.changes.find((c) => c.category === 'annotation')?.description).toMatch(/^Page 1: 1 comment added/)
    const file = join(TMP, 'objstm-signed.pdf')
    writeFileSync(file, later)
    if (hasTool('pdfsig', ['-v'])) {
      expect(spawnSync('pdfsig', [file]).stdout.toString()).toContain('Signature Validation: Signature is Valid.')
    }
  })

  it('signs the empty signature field of the fixture, keeping its name and position', async () => {
    const e = await openFixture('digital-signatures/unsigned-field.pdf')
    const sig = e.ops<typeof sigOps>('digital-signatures')
    const [field] = await sig.fields()
    expect(field).toMatchObject({ name: 'Approver', page: 0, signed: false, invisible: false })
    expect(field.rect.map(Math.round)).toEqual([340, 640, 560, 700])
    const { bytes, fieldName } = await sig.sign(request(ecId, { target: { kind: 'field', name: 'Approver' } }))
    expect(fieldName).toBe('Approver')
    const report = await validateBytes(bytes)
    expect(report.unsigned).toHaveLength(0)
    expect(report.signatures[0]).toMatchObject({ fieldName: 'Approver', integrity: true, signatureValid: true, signedVersion: 1 })
    expect(report.signatures[0].rect.map(Math.round)).toEqual([340, 640, 560, 700])
  })

  it('draws the saved handwritten signature image in the appearance', async () => {
    // A 4x2 opaque dark-blue PNG made by MuPDF.
    const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, 40, 20], false)
    pix.clear(30)
    const png = pix.asPNG().slice()
    pix.destroy()
    const e = await openFixture('text.pdf')
    const sig = e.ops<typeof sigOps>('digital-signatures')
    const content = appearance('Jane Doe')
    content.options = { ...content.options, graphic: 'image', image: png }
    const preview = await sig.previewAppearance(content, 240, 80, 1)
    const img = new mupdf.Image(preview)
    const pm = img.toPixmap()
    // Left half has the dark image, right half black text on transparent background.
    const px = pm.getPixels()
    const n = pm.getNumberOfComponents()
    const at = (x: number, y: number) => Array.from(px.subarray(y * pm.getStride() + x * n, y * pm.getStride() + x * n + n))
    expect(at(55, 40)[0]).toBeLessThan(60)
    expect(at(55, 40)[2]).toBeLessThan(60)
    const { bytes } = await sig.sign(request(rsaId, { appearance: content }))
    expect(Buffer.from(bytes).toString('latin1')).toContain('/FcImg')
    expect((await validateBytes(bytes)).signatures[0].integrity).toBe(true)
  })

  it.skipIf(!hasTool('openssl', ['version']))('validates a CMS signature made by OpenSSL', async () => {
    // Our placeholder and byte range, but the CMS comes from `openssl cms -sign` (other attribute set).
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const text = Buffer.from(bytes).toString('latin1')
    const br = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text)!.slice(1).map(Number)
    const data = Buffer.concat([Buffer.from(bytes.subarray(br[0], br[0] + br[1])), Buffer.from(bytes.subarray(br[2], br[2] + br[3]))])
    const dir = mkdtempSync(join(TMP, 'ossl-'))
    writeFileSync(join(dir, 'data.bin'), data)
    writeFileSync(join(dir, 'cert.pem'), certificateToPem(rsaId.chain[0]))
    const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(rsaId.pkcs8).toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
    writeFileSync(join(dir, 'key.pem'), keyPem)
    execFileSync('openssl', [
      'cms', '-sign', '-binary', '-in', join(dir, 'data.bin'), '-signer', join(dir, 'cert.pem'), '-inkey', join(dir, 'key.pem'),
      '-md', 'sha256', '-outform', 'DER', '-out', join(dir, 'sig.der')
    ], { stdio: 'ignore' })
    const cms = new Uint8Array(readFileSync(join(dir, 'sig.der')))
    const out = bytes.slice()
    const hex = Buffer.from(cms).toString('hex').toUpperCase()
    expect(hex.length).toBeLessThan(br[2] - br[1] - 2)
    out.set(Buffer.from(hex.padEnd(br[2] - br[1] - 2, '0'), 'latin1'), br[1] + 1)
    const r = (await validateBytes(out)).signatures[0]
    expect(r.problems).toEqual([])
    expect(r.integrity).toBe(true)
    expect(r.signatureValid).toBe(true)
    expect(r.signerName).toBe('Jane Doe')
    // And a wrong signature value is caught.
    const broken = out.slice()
    const last = br[1] + 1 + hex.length - 4
    broken[last] = broken[last] === 0x30 ? 0x31 : 0x30
    const rb = (await validateBytes(broken)).signatures[0]
    expect(rb.signatureValid).toBe(false)
    expect(signatureStatus(rb, new Set()).level).toBe('invalid')
  })
})

describe.skipIf(!hasTool('openssl', ['version']))('Digital ID files made by other software', () => {
  const dir = mkdtempSync(join(TMP, 'p12-'))
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' })
  beforeAll(() => {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-keyout', 'key.pem', '-out', 'cert.pem', '-days', '30', '-nodes', '-subj', '/CN=Olga Openssl/O=Interop Ltd/C=DE'])
    run(['pkcs12', '-export', '-inkey', 'key.pem', '-in', 'cert.pem', '-out', 'modern.p12', '-passout', 'pass:pw123456', '-name', 'Olga'])
    try {
      run(['pkcs12', '-export', '-legacy', '-inkey', 'key.pem', '-in', 'cert.pem', '-out', 'legacy.p12', '-passout', 'pass:pw123456'])
    } catch {
      // OpenSSL without the legacy provider: skip that variant.
    }
    run(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', 'ec.pem'])
    run(['req', '-x509', '-key', 'ec.pem', '-out', 'eccert.pem', '-days', '30', '-subj', '/CN=Eve EC'])
    run(['pkcs12', '-export', '-inkey', 'ec.pem', '-in', 'eccert.pem', '-out', 'ec.p12', '-passout', 'pass:pw123456'])
  })

  for (const [file, name] of [
    ['modern.p12', 'Olga Openssl'],
    ['legacy.p12', 'Olga Openssl'],
    ['ec.p12', 'Eve EC']
  ] as const) {
    it(`opens ${file} and signs with it`, async () => {
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(readFileSync(join(dir, file)))
      } catch {
        return // variant not available on this machine
      }
      expect(() => parseDigitalId(bytes, 'wrong-password')).toThrow(WrongPasswordError)
      const id = parseDigitalId(bytes, 'pw123456')
      expect(id.signer.subject.attrs.find((a) => a.short === 'CN')?.value).toBe(name)
      const e = await openFixture('text.pdf')
      const signed = await e.ops<typeof sigOps>('digital-signatures').sign(request(id))
      const r = (await validateBytes(signed.bytes)).signatures[0]
      expect(r.integrity && r.signatureValid).toBe(true)
      expect(r.signerName).toBe(name)
    })
  }
})

describe('names in other scripts', () => {
  const pageText = (bytes: Uint8Array) => {
    const doc = new mupdf.PDFDocument(bytes)
    try {
      return doc.loadPage(0).toDisplayList(true).toStructuredText('preserve-whitespace').asText()
    } finally {
      doc.destroy()
    }
  }

  for (const [label, name] of [
    ['Chinese', '王小明'],
    ['Japanese', '山田 はなこ'],
    ['Korean', '김민준'],
    ['Cyrillic', 'Анна Иванова']
  ] as const) {
    it(`draws a ${label} signer name with a small embedded font subset`, async () => {
      const e = await openFixture('text.pdf')
      const sig = e.ops<typeof sigOps>('digital-signatures')
      const content = appearance(name)
      expect(await sig.textsNeedingRaster(content)).toEqual([])
      const before = fixture('text.pdf').length
      const { bytes } = await sig.sign(request(rsaId, { appearance: content }))
      // Only the glyphs used are embedded (a whole CJK font would add megabytes).
      expect(bytes.length - before).toBeLessThan(80_000)
      const shown = pageText(bytes)
      for (const word of name.split(' ')) expect(shown).toContain(word)
      const r = (await validateBytes(bytes)).signatures[0]
      expect(r.integrity && r.signatureValid).toBe(true)
    })
  }

  it('draws text no font covers (Arabic) from the images the UI provides', async () => {
    const e = await openFixture('text.pdf')
    const sig = e.ops<typeof sigOps>('digital-signatures')
    const name = 'محمد علي'
    const content = appearance(name)
    content.location = 'القاهرة, Egypt'
    const missing = await sig.textsNeedingRaster(content)
    // Only the runs no font can draw; the label and the Latin words stay text.
    expect(missing).toEqual([name, 'القاهرة,'])
    // Stand-ins for the UI's canvas drawings: solid dark bars of the right proportions.
    const bar = (w: number) => {
      const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, 120], true)
      pix.clear(0)
      for (let y = 20; y < 100; y++) for (let x = 4; x < w - 4; x++) pix.getPixels().set([20, 20, 20, 255], (y * w + x) * 4)
      const png = pix.asPNG().slice()
      pix.destroy()
      return { png, width: w, height: 120, fontPx: 96, ascentPx: 90 }
    }
    content.rasterText = { [missing[0]]: bar(300), [missing[1]]: bar(240) }
    const preview = await sig.previewAppearance(content, 240, 80, 1)
    const pm = new mupdf.Image(preview).toPixmap()
    const px = pm.getPixels()
    const alphaAt = (x: number, y: number) => px[y * pm.getStride() + x * pm.getNumberOfComponents() + 3]
    // The large name on the left is the dark bar.
    expect(alphaAt(55, 40)).toBeGreaterThan(200)
    const { bytes } = await sig.sign(request(rsaId, { appearance: content }))
    const text = Buffer.from(bytes).toString('latin1')
    expect(text).toContain('/FcTxt1')
    expect(text).toContain('/FcTxt2')
    expect(text).not.toContain('/FcTxt3')
    const doc = new mupdf.PDFDocument(bytes)
    const shown = doc.loadPage(0).toDisplayList(true).toStructuredText('preserve-whitespace').asText()
    doc.destroy()
    expect(shown).toContain('Digitally signed by')
    expect(shown).toContain('Egypt')
    expect((await validateBytes(bytes)).signatures[0].integrity).toBe(true)
  })
})

describe('rotated pages', () => {
  for (const degrees of [90, 180, 270]) {
    it(`signs a box drawn on a page rotated by ${degrees}°: same place, upright text`, async () => {
      const e = await openFixture('text.pdf')
      await e.ops<typeof pageOps>('pages').rotate([0], degrees)
      const rotated = await openBytes(await e.doc.save({ mode: 'full' }))
      const page = rotated.info.pages[0]
      // A box near the bottom right of the page as the user sees it.
      const rect: [number, number, number, number] = [page.width - 260, page.height - 110, page.width - 40, page.height - 40]
      const { bytes } = await rotated.sig.sign(request(rsaId, { target: { kind: 'new', page: 0, rect } }))
      const r = (await validateBytes(bytes)).signatures[0]
      expect(r.integrity && r.signatureValid).toBe(true)
      r.rect.forEach((v, i) => expect(v).toBeCloseTo(rect[i], 1))
      // The appearance text reads left to right on screen, inside the box.
      const doc = new mupdf.PDFDocument(bytes)
      // A display list with annotations and widgets (page.toStructuredText leaves them out).
      const st = JSON.parse(doc.loadPage(0).toDisplayList(true).toStructuredText('preserve-whitespace').asJSON()) as {
        blocks: { lines?: { text: string; x: number; y: number; bbox: { x: number; y: number; w: number; h: number } }[] }[]
      }
      const line = st.blocks.flatMap((b) => b.lines ?? []).find((l) => l.text.includes('Digitally signed by'))
      expect(line).toBeDefined()
      // Horizontal: much wider than tall, baseline origin at the left edge.
      expect(line!.bbox.w).toBeGreaterThan(line!.bbox.h * 4)
      expect(Math.abs(line!.x - line!.bbox.x)).toBeLessThan(1)
      expect(line!.bbox.x).toBeGreaterThan(rect[0] - 1)
      expect(line!.bbox.y).toBeGreaterThan(rect[1] - 1)
      expect(line!.bbox.x + line!.bbox.w).toBeLessThan(rect[2] + 1)
      expect(line!.bbox.y + line!.bbox.h).toBeLessThan(rect[3] + 1)
      doc.destroy()
    })
  }
})

describe('together with other features', () => {
  const hasNamespace = (ns: string) => collectOpModules().some((m) => m.namespace === ns)

  it.skipIf(!hasNamespace('prepare-form'))('signs a signature field just added with Prepare a form (not saved yet)', async () => {
    const e = await openFixture('text.pdf')
    const pf = e.ops<any>('prepare-form')
    const made = await pf.create({ type: 'signature', page: 1, rect: [300, 640, 520, 700] })
    expect(await e.doc.isDirty()).toBe(true)
    const sig = e.ops<typeof sigOps>('digital-signatures')
    const [field] = await sig.fields()
    expect(field).toMatchObject({ name: made.name, page: 1, signed: false })
    const { bytes, fieldName } = await sig.sign(request(rsaId, { target: { kind: 'field', name: made.name } }))
    expect(fieldName).toBe(made.name)
    // Signing leaves the open document (and its unsaved field) as it was.
    expect(await e.doc.isDirty()).toBe(true)
    expect((await sig.fields())[0].signed).toBe(false)
    const report = await validateBytes(bytes)
    expect(report.unsigned).toHaveLength(0)
    expect(report.signatures[0]).toMatchObject({ fieldName: made.name, page: 1, integrity: true, signatureValid: true, coversWholeFile: true })
    expect(report.signatures[0].rect.map(Math.round)).toEqual([300, 640, 520, 700])
    // Prepare a form still sees the field, now signed.
    const e2 = await openBytes(bytes)
    const listed = await e2.ops<any>('prepare-form').listAll()
    expect(listed.fields.find((f: { name: string }) => f.name === made.name)?.type).toBe('signature')
  })

  it('reports deleted pages after an approval signature as a change that needs attention', async () => {
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const e2 = await openBytes(bytes)
    await e2.ops<typeof pageOps>('pages').delete([4])
    const later = await e2.doc.save({})
    // The signed revision is still in the file, byte for byte.
    expect(Buffer.from(later.subarray(0, bytes.length)).equals(Buffer.from(bytes))).toBe(true)
    const r = (await validateBytes(later)).signatures[0]
    expect(r.integrity && r.signatureValid).toBe(true)
    expect(r.changes.some((c) => c.category === 'pages' && !c.allowed)).toBe(true)
    expect(signatureStatus(r, new Set()).level).toBe('warning')
  })
})

describe('updates after signing', () => {
  /** Text MuPDF shows on page 1 (what a reader of the file sees). */
  function pageText(bytes: Uint8Array): string {
    const doc = new mupdf.PDFDocument(bytes)
    try {
      const page = doc.loadPage(0)
      const text = page.toStructuredText('').asText()
      page.destroy()
      return text
    } finally {
      doc.destroy()
    }
  }

  const VALID = ['valid', 'unknown-identity']

  it('validates the crafted base document as signed and intact', async () => {
    const r = (await validateBytes(fixture('digital-signatures/update-base.pdf'))).signatures[0]
    expect(r.integrity && r.signatureValid && r.coversWholeFile).toBe(true)
    expect(r.problems).toEqual([])
    expect(signatureStatus(r, new Set()).level).toBe('unknown-identity')
  })

  it('follows /Prev to an update that has no startxref of its own', async () => {
    const bytes = fixture('digital-signatures/update-hidden-prev.pdf')
    expect(pageText(bytes)).toContain('999 EUR')
    const revs = await readRevisions(bytes)
    expect(revs.chain).toHaveLength(3)
    const r = (await validateBytes(bytes)).signatures[0]
    expect(r.integrity).toBe(true)
    expect(r.changes.some((c) => c.category === 'content' && c.page === 0 && !c.allowed)).toBe(true)
    expect(VALID).not.toContain(signatureStatus(r, new Set()).level)
  })

  it('reads cross-reference streams with a chain of filters', async () => {
    const bytes = fixture('digital-signatures/update-xref-filters.pdf')
    expect(pageText(bytes)).toContain('999 EUR')
    const revs = await readRevisions(bytes)
    expect(revs.chain[0].entries?.get(7)).toBe('n')
    const r = (await validateBytes(bytes)).signatures[0]
    expect(r.changesUnknown).toBe(false)
    expect(r.changes.some((c) => c.category === 'content' && !c.allowed)).toBe(true)
    expect(VALID).not.toContain(signatureStatus(r, new Set()).level)
  })

  it('reports a replaced form XObject as a change of the page content', async () => {
    const bytes = fixture('digital-signatures/update-xobject.pdf')
    expect(pageText(bytes)).toContain('999 EUR')
    const r = (await validateBytes(bytes)).signatures[0]
    expect(r.changes).toEqual([{ category: 'content', page: 0, allowed: false, description: 'Page 1: the page content was changed' }])
    expect(signatureStatus(r, new Set()).level).toBe('warning')
  })

  it('keeps the certification rules when an update removes /Perms', async () => {
    const report = await validateBytes(fixture('digital-signatures/update-perms-removed.pdf'))
    const r = report.signatures[0]
    expect(report.certified).toBe(1)
    expect(r.kind).toBe('certification')
    expect(r.changes.some((c) => c.category === 'form' && !c.allowed)).toBe(true)
    expect(r.changes.some((c) => c.category === 'other' && /Perms/.test(c.description) && !c.allowed)).toBe(true)
    expect(signatureStatus(r, new Set()).level).toBe('invalid')
  })

  it('keeps the field lock of the signed revision when an update removes it', async () => {
    const r = (await validateBytes(fixture('digital-signatures/update-lock-removed.pdf'))).signatures[0]
    expect(r.lock).toMatchObject({ action: 'All' })
    expect(r.changes.some((c) => c.category === 'form' && c.description.includes('Amount') && !c.allowed)).toBe(true)
    expect(signatureStatus(r, new Set()).level).toBe('invalid')
  })

  it('treats bytes no cross-reference section accounts for as unknown changes', async () => {
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const extra = new TextEncoder().encode('\n99 0 obj\n<< /Hidden true >>\nendobj\n')
    const tampered = new Uint8Array(bytes.length + extra.length)
    tampered.set(bytes)
    tampered.set(extra, bytes.length)
    const r = (await validateBytes(tampered)).signatures[0]
    expect(r.coversWholeFile).toBe(false)
    expect(r.changesUnknown).toBe(true)
    const st = signatureStatus(r, new Set())
    expect(st.level).toBe('warning')
    expect(st.details.join(' ')).toMatch(/cannot be checked/)
  })

  it('treats a file MuPDF had to repair as having unknown changes', async () => {
    const e = await openFixture('text.pdf')
    const { bytes } = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
    const e2 = await openBytes(bytes)
    await e2.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'later note' })
    const later = await e2.doc.save({})
    // Point the last startxref somewhere else: MuPDF repairs the file and reads every object it finds.
    const text = Buffer.from(later).toString('latin1')
    const sx = text.lastIndexOf('startxref')
    const broken = Buffer.from(text.slice(0, sx) + text.slice(sx).replace(/startxref\s+\d+/, 'startxref\n12'), 'latin1')
    const r = (await validateBytes(new Uint8Array(broken))).signatures[0]
    expect(r.changesUnknown).toBe(true)
    expect(signatureStatus(r, new Set()).level).toBe('warning')
  })

  it('fails closed on unknown changes when the signature restricts changes', () => {
    const base = { changes: [], changesUnknown: true, permission: null, lock: null, problems: [], warnings: [], certificates: [], chainVerified: [] }
    const r = {
      ...base,
      kind: 'approval',
      integrity: true,
      signatureValid: true,
      coversWholeFile: false,
      unknownReason: null,
      timestamp: null,
      signingTime: null,
      certExpiredNow: false,
      certValidAtSigning: true
    } as unknown as Parameters<typeof signatureStatus>[0]
    expect(signatureStatus(r, new Set()).level).toBe('warning')
    expect(signatureStatus({ ...r, lock: { action: 'All', fields: [], permission: null } }, new Set()).level).toBe('invalid')
    expect(signatureStatus({ ...r, kind: 'certification', permission: 2 }, new Set()).level).toBe('invalid')
  })

  describe('judges each change by what the object is in the signed revision', () => {
    /** The changes of the only signature, its status level, and whether the page shows the new amount. */
    async function check(name: string) {
      const bytes = fixture(`digital-signatures/${name}`)
      const report = await validateBytes(bytes)
      const r = report.signatures[0]
      return { r, report, level: signatureStatus(r, new Set()).level, shows999: pageText(bytes).includes('999 EUR') }
    }

    it('reports a replaced form XObject as content even when the page also lists it as a comment', async () => {
      const { r, level, shows999 } = await check('update-annots-xobject.pdf')
      expect(shows999).toBe(true)
      expect(r.changes.some((c) => c.category === 'content' && c.page === 0 && !c.allowed)).toBe(true)
      expect(VALID).not.toContain(level)
    })

    it('reports a replaced form XObject as content even when a new comment names it as its popup', async () => {
      const { r, level, shows999 } = await check('update-popup-p3.pdf')
      expect(shows999).toBe(true)
      expect(r.kind).toBe('certification')
      expect(r.changes.some((c) => c.category === 'content' && !c.allowed)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('reports a replaced form XObject as content even when the form lists it as a field', async () => {
      const { r, level, shows999 } = await check('update-fields-p2.pdf')
      expect(shows999).toBe(true)
      expect(r.changes.some((c) => c.category === 'content' && !c.allowed)).toBe(true)
      expect(r.changes.some((c) => c.category === 'form')).toBe(false)
      expect(level).toBe('invalid')
    })

    it('does not take a changed action for validation data because /DSS lists it', async () => {
      const { r, level } = await check('update-dss-p1.pdf')
      expect(r.changes.some((c) => c.category === 'other' && !c.allowed)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('reports NeedAppearances and DA changes under a certification', async () => {
      const p1 = await check('update-needappearances-p1.pdf')
      expect(p1.r.changes).toContainEqual(expect.objectContaining({ category: 'other', allowed: false, description: 'The form settings were changed' }))
      expect(p1.level).toBe('invalid')
      const p2 = await check('update-da-p2.pdf')
      expect(p2.r.changes).toContainEqual(expect.objectContaining({ category: 'other', allowed: false, description: 'The form settings were changed' }))
      expect(p2.level).toBe('invalid')
    })

    it('treats an update entry that points to another object of the signed revision as unknown changes', async () => {
      const bytes = fixture('digital-signatures/update-xref-mismatch.pdf')
      const r = (await validateBytes(bytes)).signatures[0]
      expect(r.changesUnknown).toBe(true)
      expect(VALID).not.toContain(signatureStatus(r, new Set()).level)
    })

    it('treats a repair that only reading the changed objects sets off as unknown changes', async () => {
      const bytes = fixture('digital-signatures/update-signed-mismatch.pdf')
      // Opening the file alone does not need a repair.
      const doc = new mupdf.PDFDocument(bytes)
      expect(doc.wasRepaired()).toBe(false)
      doc.destroy()
      const r = (await validateBytes(bytes)).signatures[0]
      expect(r.changesUnknown).toBe(true)
      expect(r.changes).toEqual([])
      expect(VALID).not.toContain(signatureStatus(r, new Set()).level)
    })

    it('fails closed when the signed revision cannot be opened', async () => {
      const bytes = fixture('digital-signatures/update-encrypt-dropped.pdf')
      const r = (await validateBytes(bytes)).signatures[0]
      expect(r.integrity).toBe(true)
      // The signed revision needs a password; the update dropped it along with the field lock.
      const signedPart = new mupdf.PDFDocument(bytes.slice(0, r.revisionEnd))
      expect(signedPart.needsPassword()).toBe(true)
      signedPart.destroy()
      expect(r.changesUnknown).toBe(true)
      expect(r.restrictionsUnknown).toBe(true)
      const st = signatureStatus(r, new Set())
      expect(st.level).toBe('invalid')
      expect(st.details.join(' ')).toMatch(/cannot be checked against what the signer allowed/)
    })
  })

  describe('judges each change against the signed revision, not the current one', () => {
    async function check(name: string) {
      const bytes = fixture(`digital-signatures/${name}`)
      const report = await validateBytes(bytes)
      const r = report.signatures[0]
      return { bytes, r, level: signatureStatus(r, new Set()).level }
    }
    const blocked = (r: ValidationReport['signatures'][number], category: string, text: RegExp) =>
      r.changes.some((c) => c.category === category && text.test(c.description) && !c.allowed)

    it('reports objects an update takes from a rewritten object stream', async () => {
      const { bytes, r, level } = await check('update-objstm.pdf')
      // The signed revision draws the amount; the update rewrites only the object stream.
      expect(pageText(bytes.slice(0, r.revisionEnd))).toContain('Amount due: 100 EUR')
      expect(pageText(bytes)).not.toContain('Amount due')
      expect(r.integrity).toBe(true)
      expect(r.changesUnknown).toBe(false)
      expect(r.changes).toEqual([{ category: 'content', page: 0, allowed: false, description: 'Page 1: the page content was changed' }])
      expect(level).toBe('warning')
      // The signed revision on its own is intact and unchanged.
      const own = (await validateBytes(bytes.slice(0, r.revisionEnd))).signatures[0]
      expect(own.coversWholeFile).toBe(true)
      expect(VALID).toContain(signatureStatus(own, new Set()).level)
    })

    it('reports a field value changed inside a rewritten object stream under a certification', async () => {
      const { r, level } = await check('update-objstm-p1-field.pdf')
      expect(r.kind).toBe('certification')
      expect(blocked(r, 'form', /Amount/)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('keeps the field lock when an update moves the signature value to a new parent field', async () => {
      const { r, level } = await check('update-lock-reparent.pdf')
      expect(r.lock).toMatchObject({ action: 'All' })
      expect(r.restrictionsUnknown).toBe(false)
      expect(blocked(r, 'form', /Amount/)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('keeps the field lock when an update puts a copy of the signature widget on the page', async () => {
      const { r, level } = await check('update-lock-copy.pdf')
      expect(r.lock).toMatchObject({ action: 'All' })
      expect(blocked(r, 'form', /Amount/)).toBe(true)
      expect(blocked(r, 'signature', /removed/)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('judges a locked field appearance as the field even when the form resources list it', async () => {
      const { r, level } = await check('update-dr-locked-ap.pdf')
      expect(r.lock).toMatchObject({ action: 'All' })
      expect(blocked(r, 'form', /Amount/)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('does not let a signature field that was already signed change', async () => {
      const { r, level } = await check('update-sig-widget-p2.pdf')
      expect(r.permission).toBe(2)
      expect(blocked(r, 'signature', /changed after it was signed/)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('does not let filling in move a field under a certification', async () => {
      const { r, level } = await check('update-field-moved-p2.pdf')
      expect(blocked(r, 'form', /Amount.*moved/)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('reports a removed comment even when a field on the same page was filled in', async () => {
      const { r, level } = await check('update-comment-removed-p2.pdf')
      expect(r.changes).toContainEqual({ category: 'annotation', page: 0, allowed: false, description: 'Page 1: 1 comment removed (FreeText)' })
      expect(r.changes).toContainEqual(expect.objectContaining({ category: 'form', allowed: true }))
      expect(level).toBe('invalid')
    })
  })

  describe('only later signatures keep a signature valid', () => {
    async function check(name: string) {
      const bytes = fixture(`digital-signatures/${name}`)
      const report = await validateBytes(bytes)
      return { bytes, report, r: report.signatures[0], level: signatureStatus(report.signatures[0], new Set()).level }
    }
    const blocked = (r: ValidationReport['signatures'][number], category: string, text: RegExp) =>
      r.changes.some((c) => c.category === category && text.test(c.description) && !c.allowed)

    it('caps the status when an update changes an object MuPDF reads without a reference (an object stream /First)', async () => {
      const { bytes, r, level } = await check('update-objstm-first.pdf')
      expect(pageText(bytes.slice(0, r.revisionEnd))).toContain('Amount due: 100 EUR')
      expect(pageText(bytes)).toContain('Amount due: 999 EUR')
      expect(r.integrity).toBe(true)
      expect(r.laterUpdates).toBe('other')
      expect(r.changes).toEqual([{ category: 'other', allowed: false, description: 'Other parts of the document were changed' }])
      expect(level).toBe('warning')
      expect(signatureStatus(r, new Set()).title).toBe('The document was changed after it was signed.')
      // A certification that allows no changes is invalid after any change at all.
      const p1 = await check('update-objstm-first-p1.pdf')
      expect(pageText(p1.bytes)).toContain('Amount due: 999 EUR')
      expect(p1.r.kind).toBe('certification')
      expect(p1.level).toBe('invalid')
    })

    it('judges a font shared by several fields as part of each of them', async () => {
      const locked = await check('update-shared-font-lock.pdf')
      expect(locked.r.lock).toMatchObject({ action: 'Include', fields: ['Amount'] })
      expect(blocked(locked.r, 'form', /Amount/)).toBe(true)
      expect(locked.level).toBe('invalid')
      const sig = await check('update-shared-font-sig-p2.pdf')
      expect(blocked(sig.r, 'signature', /Signature1.*changed after it was signed/)).toBe(true)
      expect(sig.level).toBe('invalid')
    })

    it('keeps a field locked when an update renames it', async () => {
      const { r, level } = await check('update-lock-rename.pdf')
      expect(blocked(r, 'form', /Total/)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('locks every field but the listed ones for /Action /Exclude', async () => {
      const { r, level } = await check('update-lock-exclude.pdf')
      expect(r.lock).toMatchObject({ action: 'Exclude', fields: ['Notes'] })
      expect(blocked(r, 'form', /Amount/)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('locks the fields under a locked parent field', async () => {
      const { r, level } = await check('update-lock-parent.pdf')
      expect(blocked(r, 'form', /Invoice\.Amount/)).toBe(true)
      expect(level).toBe('invalid')
    })

    it('judges a widget written directly in /Annots as a field, not a comment', async () => {
      const { bytes, r, level } = await check('update-direct-widget.pdf')
      expect(pageText(bytes)).not.toContain('100')
      expect(blocked(r, 'form', /Amount/)).toBe(true)
      expect(r.changes.some((c) => c.category === 'annotation')).toBe(false)
      expect(level).toBe('invalid')
    })

    it('keeps a signature valid when a crafted later signature only adds its own field', async () => {
      const { report, r, level } = await check('update-later-signature.pdf')
      expect(report.signatures.map((x) => [x.fieldName, x.integrity, x.signatureValid])).toEqual([
        ['Signature1', true, true],
        ['Signature2', true, true]
      ])
      expect(r.laterUpdates).toBe('signing')
      expect(r.changes).toEqual([expect.objectContaining({ category: 'signature', allowed: true, description: 'Signature field “Signature2” was added and signed' })])
      expect(level).toBe('unknown-identity')
    })

    it('does not let a later signature define an object the signed revision already refers to', async () => {
      const { bytes, report, r, level } = await check('update-later-signature-dangling.pdf')
      expect(pageText(bytes.slice(0, r.revisionEnd))).not.toContain('999 EUR')
      expect(pageText(bytes)).toContain('999 EUR')
      expect(report.signatures[1].coversWholeFile).toBe(true)
      expect(r.laterUpdates).toBe('other')
      expect(level).toBe('warning')
    })

    it('keeps signatures valid through later signatures made by the app', async () => {
      // A new field, then the existing empty field.
      const e = await openFixture('digital-signatures/unsigned-field.pdf')
      const first = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
      const second = await (await openBytes(first.bytes)).sig.sign(request(ecId, { target: { kind: 'field', name: 'Approver' } }))
      const third = await (await openBytes(second.bytes)).sig.sign(request(rsaId, { target: { kind: 'invisible' }, lock: true }))
      const report = await validateBytes(third.bytes)
      expect(report.signatures.map((x) => [x.fieldName, x.laterUpdates])).toEqual([
        ['Signature1', 'signing'],
        ['Approver', 'signing'],
        ['Signature2', 'none']
      ])
      expect(report.signatures.map((x) => signatureStatus(x, new Set()).level)).toEqual(['unknown-identity', 'unknown-identity', 'unknown-identity'])

      // Under a certification that allows signing, signing its empty field is allowed.
      const c = await openFixture('digital-signatures/unsigned-field.pdf')
      const certified = await c.ops<typeof sigOps>('digital-signatures').sign(request(rsaId, { mode: 'certify', permission: 2, target: { kind: 'invisible' } }))
      const signed = await (await openBytes(certified.bytes)).sig.sign(request(ecId, { target: { kind: 'field', name: 'Approver' } }))
      const cr = (await validateBytes(signed.bytes)).signatures[0]
      expect(cr.kind).toBe('certification')
      expect(cr.changes.every((x) => x.allowed)).toBe(true)
      expect(cr.laterUpdates).toBe('signing')
      expect(signatureStatus(cr, new Set()).level).toBe('unknown-identity')

      // Object streams and encryption.
      const src = new mupdf.PDFDocument(fixture('text.pdf'))
      const buf = src.saveToBuffer('garbage,compress,objstms')
      const compact = buf.asUint8Array().slice()
      buf.destroy()
      src.destroy()
      const o1 = await (await openBytes(compact)).sig.sign(request(rsaId))
      const o2 = await (await openBytes(o1.bytes)).sig.sign(request(ecId, { target: { kind: 'new', page: 1, rect: [300, 650, 540, 720] } }))
      expect((await validateBytes(o2.bytes)).signatures[0].laterUpdates).toBe('signing')
      const enc = await openFixture('encrypted.pdf', 'secret')
      const n1 = await enc.ops<typeof sigOps>('digital-signatures').sign(request(rsaId))
      const n2 = await (await openBytes(n1.bytes, 'enc.pdf', 'secret')).sig.sign(request(ecId, { target: { kind: 'invisible' } }))
      expect((await validateBytes(n2.bytes, 'secret')).signatures[0].laterUpdates).toBe('signing')
    })

    it('caps the status when anything else comes before a later signature', async () => {
      const e = await openFixture('form.pdf')
      const first = await e.ops<typeof sigOps>('digital-signatures').sign(request(rsaId, { target: { kind: 'invisible' } }))
      const e2 = await openBytes(first.bytes)
      const forms = e2.ops<typeof formOps>('forms')
      await forms.setValue((await forms.listAll()).find((f) => f.name === 'fullName')!.id, 'Ada Lovelace')
      const filled = await e2.doc.save({})
      const second = await (await openBytes(filled)).sig.sign(request(ecId, { target: { kind: 'invisible' } }))
      const [a, b] = (await validateBytes(second.bytes)).signatures
      expect(a.changes.every((c) => c.allowed)).toBe(true)
      expect(a.laterUpdates).toBe('other')
      expect(signatureStatus(a, new Set()).level).toBe('warning')
      expect(b.laterUpdates).toBe('none')
      expect(signatureStatus(b, new Set()).level).toBe('unknown-identity')
    })

    it('fails closed on reports that do not say what came later, and on any change after a signature that allows none', () => {
      const r = {
        changes: [],
        changesUnknown: false,
        permission: null,
        lock: null,
        problems: [],
        warnings: [],
        certificates: [],
        chainVerified: [],
        kind: 'approval',
        integrity: true,
        signatureValid: true,
        coversWholeFile: false,
        revisionEnd: 1000,
        unknownReason: null,
        timestamp: null,
        signingTime: null,
        certExpiredNow: false,
        certValidAtSigning: true
      } as unknown as Parameters<typeof signatureStatus>[0]
      expect(signatureStatus(r, new Set()).level).toBe('warning')
      expect(signatureStatus({ ...r, laterUpdates: 'signing' }, new Set()).level).toBe('unknown-identity')
      expect(signatureStatus({ ...r, laterUpdates: 'signing', kind: 'certification', permission: 1 }, new Set()).level).toBe('invalid')
      expect(signatureStatus({ ...r, laterUpdates: 'signing', permissionInForce: 1 }, new Set()).level).toBe('invalid')
      expect(signatureStatus({ ...r, laterUpdates: 'signing', lock: { action: 'All', fields: [], permission: 1 } }, new Set()).level).toBe('invalid')
      expect(signatureStatus({ ...r, coversWholeFile: true, laterUpdates: 'none', kind: 'certification', permission: 1 }, new Set()).level).toBe('unknown-identity')
    })
  })
})
