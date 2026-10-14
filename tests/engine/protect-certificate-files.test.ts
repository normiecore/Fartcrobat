// Protect > Encrypt with Certificate: reading recipients' certificates from .cer, .crt, .pem, .p7b
// and .p12 files (src/features/protect-optimize/certificateFiles.ts), with the test PKI in
// tests/fixtures/passwordless/pki (see its README).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CertificateFileError,
  certificateInfo,
  detectCertificateFile,
  isExpired,
  isNotYetValid,
  readCertificateFile,
  type CertificateInfo
} from '@features/protect-optimize/certificateFiles'
import { EC_REASON, recipientRefusal, recipientWarnings } from '@features/protect-optimize/certificates'

const PKI = join(__dirname, '../fixtures/passwordless/pki')
const pki = (name: string) => new Uint8Array(readFileSync(join(PKI, name)))
const text = (s: string) => new TextEncoder().encode(s)
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').toUpperCase()
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex').toUpperCase()
const expected = JSON.parse(readFileSync(join(PKI, '../expected.json'), 'utf8')) as {
  files: { file: string; recipients: { cert: string; issuer: string | null; serialHex: string | null; ski: string | null }[] }[]
}
const recipientOf = (cert: string) => expected.files.flatMap((f) => f.recipients).find((r) => r.cert === cert && r.serialHex)!

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
  } catch (err) {
    return err instanceof CertificateFileError ? err.code : `other: ${(err as Error).message}`
  }
  return null
}

const names = (certs: CertificateInfo[]) => certs.map((c) => c.name)
const ALICE_SHA256 = sha256(pki('alice.cer'))

describe('protect-optimize: certificate files', () => {
  it('reads a DER .cer with its fingerprints, names, serial, dates and key', () => {
    const der = pki('alice.cer')
    const [alice, ...rest] = readCertificateFile(der)
    expect(rest).toHaveLength(0)
    expect(alice.der).toEqual(der)
    expect(alice.sha256).toBe(sha256(der))
    expect(alice.sha1).toBe(sha1(der))
    expect(alice.name).toBe('Alice Test')
    expect(alice.email).toBe('alice@example.test')
    expect(alice.organization).toBe('Fartcrobat Test Keys')
    expect(alice.subject).toBe('CN=Alice Test, OU=TEST KEYS ONLY - never use for anything real, O=Fartcrobat Test Keys')
    expect(alice.issuerName).toBe('Fartcrobat Test CA')
    expect(alice.serial).toBe(recipientOf('alice').serialHex)
    expect(alice.notBefore.toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(alice.notAfter.toISOString()).toBe('2045-01-01T00:00:00.000Z')
    expect(alice.keyType).toBe('rsa')
    expect(alice.keyDescription).toBe('RSA 2048-bit')
    expect(alice.keyEncipherment).toBe(true)
    expect(alice.isCA).toBe(false)
    expect(detectCertificateFile(der)).toBe('certificate')
  })

  it('reads a PEM .crt as the same certificate', () => {
    const pem = pki('alice.crt')
    expect(detectCertificateFile(pem)).toBe('pem')
    const certs = readCertificateFile(pem)
    expect(certs.map((c) => c.sha256)).toEqual([ALICE_SHA256])
    expect(certs[0].der).toEqual(pki('alice.cer'))
  })

  it('reads every certificate of a PEM bundle once, in order, and ignores keys and other blocks', () => {
    const decoder = new TextDecoder()
    const bundle = [
      'Recipients for the quarterly report',
      decoder.decode(pki('bob.crt')),
      decoder.decode(pki('alice.key')),
      decoder.decode(pki('alice.crt')),
      decoder.decode(pki('ec.crt')),
      // The same certificate twice is listed once.
      decoder.decode(pki('bob.crt'))
    ].join('\n')
    const certs = readCertificateFile(text(bundle))
    expect(names(certs)).toEqual(['Bob Tëst', 'Alice Test', 'EC Test'])
    expect(certs[2].keyType).toBe('ec')
    // Nothing of the private key is kept.
    expect(certs.every((c) => c.der[0] === 0x30 && sha256(c.der) === c.sha256)).toBe(true)
  })

  it('reads the certificates of a certs-only .p7b, DER and PEM', () => {
    const p7b = pki('colleagues.p7b')
    expect(detectCertificateFile(p7b)).toBe('pkcs7')
    const certs = readCertificateFile(p7b)
    expect(names(certs).sort()).toEqual(['Bob Tëst', 'Stranger Test'])
    expect(certs.find((c) => c.name === 'Bob Tëst')!.der).toEqual(pki('bob.cer'))
    expect(certs.find((c) => c.name === 'Stranger Test')!.der).toEqual(pki('stranger.cer'))

    const base64 = Buffer.from(p7b).toString('base64').replace(/.{64}/g, '$&\n')
    const pem = text(`-----BEGIN PKCS7-----\n${base64}\n-----END PKCS7-----\n`)
    expect(readCertificateFile(pem).map((c) => c.sha256)).toEqual(certs.map((c) => c.sha256))

    // The Windows store set's collection: a colleague and a certificate without a key.
    const store = readCertificateFile(pki('winstore/colleagues.p7b'))
    expect(store.map((c) => c.sha256).sort()).toEqual([sha256(pki('winstore/colleague.cer')), sha256(pki('winstore/me-nokey.cer'))].sort())
  })

  it('reads the certificate of a .p12 with its password, and asks again for a wrong one', () => {
    const p12 = pki('alice.p12')
    expect(detectCertificateFile(p12)).toBe('pkcs12')
    expect(codeOf(() => readCertificateFile(p12))).toBe('NEEDS_PASSWORD')
    expect(codeOf(() => readCertificateFile(p12, { password: 'not-alice-pass' }))).toBe('WRONG_PASSWORD')
    expect(codeOf(() => readCertificateFile(p12, { password: '' }))).toBe('WRONG_PASSWORD')
    const certs = readCertificateFile(p12, { password: 'alice-pass' })
    // Only the public certificate: the same one as alice.cer.
    expect(certs).toHaveLength(1)
    expect(certs[0].sha256).toBe(ALICE_SHA256)
    expect(Object.keys(certs[0])).not.toContain('pkcs8')

    const bob = readCertificateFile(pki('bob.p12'), { password: 'bob-pass' })
    expect(bob.map((c) => c.der)).toEqual([pki('bob.cer')])
  })

  it('detects elliptic-curve certificates, which cannot be recipients yet', () => {
    const [ec] = readCertificateFile(pki('ec.cer'))
    expect(ec.keyType).toBe('ec')
    expect(ec.keyDescription).toBe('ECDSA P-256')
    expect(recipientRefusal(ec)).toBe(EC_REASON)
    expect(recipientRefusal(certificateInfo(pki('alice.cer')))).toBeNull()
    // Also inside a .p12, and in the Windows store set.
    expect(readCertificateFile(pki('ec.p12'), { password: 'ec-pass' })[0].keyType).toBe('ec')
    expect(readCertificateFile(pki('winstore/me-ec.cer'))[0].keyType).toBe('ec')
  })

  it('decodes bob’s non-ASCII issuer and strips the leading 00 of his serial', () => {
    const [bob] = readCertificateFile(pki('bob.cer'))
    expect(bob.name).toBe('Bob Tëst')
    expect(bob.issuerName).toBe('Fartcrobat Tëst CA Ünïcode ✓')
    expect(bob.issuer).toBe('CN=Fartcrobat Tëst CA Ünïcode ✓, OU=TEST KEYS ONLY - never use for anything real, O=Fartcrobat Test Keys')
    const serialHex = recipientOf('bob').serialHex!
    expect(serialHex.startsWith('00')).toBe(true)
    expect(bob.serial).toBe(serialHex.slice(2))
    // The PEM and the .p12 give the same.
    expect(readCertificateFile(pki('bob.crt'))[0].issuerName).toBe(bob.issuerName)
    expect(readCertificateFile(pki('bob.p12'), { password: 'bob-pass' })[0].serial).toBe(bob.serial)
  })

  it('tells expired and not yet valid certificates with a fixed clock', () => {
    const [expired] = readCertificateFile(pki('winstore/me-expired.cer'))
    const [alice] = readCertificateFile(pki('alice.cer'))
    const now = Date.parse('2026-10-14T12:00:00Z')
    expect(isExpired(expired, now)).toBe(true)
    expect(isExpired(expired, Date.parse('2020-06-01T00:00:00Z'))).toBe(false)
    expect(isNotYetValid(expired, Date.parse('2019-12-31T00:00:00Z'))).toBe(true)
    expect(isExpired(alice, now)).toBe(false)
    expect(isExpired(alice, Date.parse('2045-01-02T00:00:00Z'))).toBe(true)
    // Expired certificates can be added, with a warning.
    expect(recipientRefusal(expired)).toBeNull()
    expect(recipientWarnings(expired, now)).toEqual(['This certificate expired on 2021-01-01. The file can still be encrypted for it.'])
    expect(recipientWarnings(alice, now)).toEqual([])
  })

  it('notes certificates whose key usage is not meant for encryption, and certificate authorities', () => {
    const [sign] = readCertificateFile(pki('winstore/me-sign.cer'))
    expect(sign.keyEncipherment).toBe(false)
    expect(recipientWarnings(sign, Date.parse('2026-10-14T00:00:00Z'))).toEqual([
      'This certificate is not meant for encryption. Some apps may not open the file with it.'
    ])
    // No key usage extension at all: nothing restricts it.
    expect(readCertificateFile(pki('winstore/me-noku.cer'))[0].keyEncipherment).toBe(true)
    expect(readCertificateFile(pki('winstore/me-noku.cer'))[0].name).toBe('Store Test Me (no key usage) éè 🔑')
    expect(readCertificateFile(pki('ca.cer'))[0].isCA).toBe(true)
    expect(readCertificateFile(pki('ca-unicode.cer'))[0].isCA).toBe(true)
  })

  it('refuses files that hold no certificate', () => {
    expect(codeOf(() => readCertificateFile(new Uint8Array([1, 2, 3, 4])))).toBe('UNREADABLE')
    expect(codeOf(() => readCertificateFile(new Uint8Array()))).toBe('UNREADABLE')
    expect(codeOf(() => readCertificateFile(new Uint8Array(readFileSync(join(PKI, '../source.pdf')))))).toBe('UNREADABLE')
    // PEM with only a private key.
    expect(codeOf(() => readCertificateFile(pki('alice.key')))).toBe('NO_CERTIFICATES')
    // A broken certificate inside a PEM block.
    expect(codeOf(() => readCertificateFile(text('-----BEGIN CERTIFICATE-----\nMIIBAAA=\n-----END CERTIFICATE-----\n')))).toBe('NO_CERTIFICATES')
    expect(detectCertificateFile(new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x05]))).toBeNull()
  })
})
