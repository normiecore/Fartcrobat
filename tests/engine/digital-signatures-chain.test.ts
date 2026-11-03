import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { der } from '@features/digital-signatures/lib/asn1'
import { digest, parsePublicKey, rsaPkcs1Verify } from '@features/digital-signatures/lib/crypto'
import { OID } from '@features/digital-signatures/lib/oids'
import { buildChain, describeCertificate, parseCertificate, type CertDetails, type Certificate } from '@features/digital-signatures/lib/x509'
import { chainTrustedIndex, displayedSigningTime, signatureStatus, timestampTrusted } from '@features/digital-signatures/status'
import type { SignatureReport } from '@features/digital-signatures/types'

// Certificates from tests/fixtures/digital-signatures/make_chain.py (valid 2025-2045 unless noted).
const DIR = join(__dirname, '..', 'fixtures', 'digital-signatures', 'chain')
const cert = (name: string): Certificate => parseCertificate(new Uint8Array(readFileSync(join(DIR, `${name}.cer`))))
const POOL_NAMES = [
  'root',
  'inter',
  'ee-issuer',
  'root-pl0',
  'inter-pl0',
  'inter-expired',
  'inter-nokcs',
  'self-leaf'
]
const WHEN = new Date('2026-06-01T00:00:00Z')

async function chainOf(signer: string, when = WHEN) {
  const pool = POOL_NAMES.map(cert)
  const { chain, complete } = await buildChain(cert(signer), pool, when)
  const certificates = await Promise.all(chain.map((l) => describeCertificate(l.cert)))
  return { certificates, verified: chain.map((l) => l.verified), complete }
}

async function trustedAt(signer: string, trustedNames: string[], when = WHEN): Promise<number> {
  const { certificates, verified } = await chainOf(signer, when)
  const trusted = new Set(await Promise.all(trustedNames.map(async (n) => (await describeCertificate(cert(n))).sha256)))
  return chainTrustedIndex(certificates, verified, trusted)
}

describe('certificate chains', () => {
  it('trusts a proper CA chain through a trusted root', async () => {
    const { certificates, verified, complete } = await chainOf('leaf')
    expect(certificates.map((c) => c.subjectName)).toEqual(['leaf', 'inter', 'root'])
    expect(verified).toEqual([true, true, true])
    expect(complete).toBe(true)
    expect(await trustedAt('leaf', ['root'])).toBe(2)
    expect(await trustedAt('leaf', ['inter'])).toBe(1)
    expect(await trustedAt('leaf-direct-pl0', ['root-pl0'])).toBe(1)
  })

  it('does not trust a certificate issued by an end entity', async () => {
    const { certificates, verified } = await chainOf('leaf-of-ee')
    expect(certificates.map((c) => c.subjectName)).toEqual(['leaf-of-ee', 'ee-issuer', 'root'])
    expect(verified[0]).toBe(false)
    expect(await trustedAt('leaf-of-ee', ['root'])).toBe(-1)
    // Trusting the end entity itself does not extend to what it "issued"...
    expect(await trustedAt('leaf-of-ee', ['ee-issuer'])).toBe(-1)
    // ...but its own signatures are trusted.
    expect(await trustedAt('ee-issuer', ['ee-issuer'])).toBe(0)
  })

  it('does not trust a chain that exceeds a path length constraint', async () => {
    const { verified } = await chainOf('leaf-pl0')
    expect(verified).toEqual([true, false, true])
    expect(await trustedAt('leaf-pl0', ['root-pl0'])).toBe(-1)
  })

  it('does not trust a chain through an intermediate that was not valid at the signing time', async () => {
    const { verified } = await chainOf('leaf-expired')
    expect(verified[0]).toBe(false)
    expect(await trustedAt('leaf-expired', ['root'])).toBe(-1)
  })

  it('does not trust a chain through a CA whose key usage excludes certificate signing', async () => {
    expect(await trustedAt('leaf-nokcs', ['root'])).toBe(-1)
  })

  it('does not let a trusted leaf certificate vouch for another leaf', async () => {
    const { certificates, verified } = await chainOf('leaf-of-self')
    expect(certificates.map((c) => c.subjectName)).toEqual(['leaf-of-self', 'self-leaf'])
    expect(verified).toEqual([false, true])
    expect(await trustedAt('leaf-of-self', ['self-leaf'])).toBe(-1)
    expect(await trustedAt('self-leaf', ['self-leaf'])).toBe(0)
  })

  it('does not count a trusted non-CA certificate above the signer even if the link were verified', () => {
    const certs = [{ sha256: 'A', isCA: false }, { sha256: 'B', isCA: false }] as CertDetails[]
    expect(chainTrustedIndex(certs, [true, true], new Set(['B']))).toBe(-1)
    expect(chainTrustedIndex(certs, [true, true], new Set(['A']))).toBe(0)
    const caCerts = [{ sha256: 'A', isCA: false }, { sha256: 'B', isCA: true }] as CertDetails[]
    expect(chainTrustedIndex(caCerts, [true, true], new Set(['B']))).toBe(1)
    expect(chainTrustedIndex(caCerts, [false, true], new Set(['B']))).toBe(-1)
  })
})

describe('RSA PKCS#1 v1.5 verification', () => {
  async function rsaKey() {
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    )
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey)
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
    const big = (b64: string) => BigInt('0x' + Buffer.from(b64, 'base64url').toString('hex'))
    return { pub: parsePublicKey(spki), n: big(jwk.n!), d: big(jwk.d!) }
  }
  function modPow(b: bigint, e: bigint, m: bigint) {
    let r = 1n
    b %= m
    while (e > 0n) {
      if (e & 1n) r = (r * b) % m
      e >>= 1n
      b = (b * b) % m
    }
    return r
  }
  /** Raw RSA private operation on an encoded block: what a signer (or forger) produces. */
  function signBlock(key: { n: bigint; d: bigint }, em: Uint8Array): Uint8Array {
    const s = modPow(BigInt('0x' + Buffer.from(em).toString('hex')), key.d, key.n)
    return new Uint8Array(Buffer.from(s.toString(16).padStart(512, '0'), 'hex'))
  }
  function block(t: Uint8Array, k = 256): Uint8Array {
    const em = new Uint8Array(k)
    em[1] = 1
    em.fill(0xff, 2, k - t.length - 1)
    em.set(t, k - t.length)
    return em
  }
  const cat = (...parts: Uint8Array[]) => new Uint8Array(Buffer.concat(parts))

  it('accepts the exact encoding with NULL or absent parameters', async () => {
    const key = await rsaKey()
    const h = await digest('SHA-256', new TextEncoder().encode('hello'))
    const withNull = der.sequence(der.sequence(der.oid(OID.sha256), der.null()), der.octetString(h))
    const absent = der.sequence(der.sequence(der.oid(OID.sha256)), der.octetString(h))
    expect(rsaPkcs1Verify(key.pub, signBlock(key, block(withNull)), h, 'SHA-256')).toBe('SHA-256')
    expect(rsaPkcs1Verify(key.pub, signBlock(key, block(absent)), h, 'SHA-256')).toBe('SHA-256')
    // A WebCrypto signature is the standard encoding.
    const pair = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    )
    const data = new TextEncoder().encode('hello')
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, data))
    const pub = parsePublicKey(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)))
    expect(rsaPkcs1Verify(pub, sig, h, 'SHA-256')).toBe('SHA-256')
    expect(rsaPkcs1Verify(pub, sig, h, 'SHA-384')).toBeNull()
  })

  it('rejects DigestInfo with trailing or nested extra data', async () => {
    const key = await rsaKey()
    const h = await digest('SHA-256', new TextEncoder().encode('hello'))
    const good = der.sequence(der.sequence(der.oid(OID.sha256), der.null()), der.octetString(h))
    const junk = new Uint8Array(16).fill(0x41)
    const forms = [
      // bytes after the DigestInfo
      cat(good, junk),
      // an extra element inside the DigestInfo
      der.sequence(der.sequence(der.oid(OID.sha256), der.null()), der.octetString(h), der.octetString(junk)),
      // garbage algorithm parameters
      der.sequence(der.sequence(der.oid(OID.sha256), der.octetString(junk)), der.octetString(h)),
      // the bare digest without DigestInfo
      h,
      // another digest algorithm's identifier
      der.sequence(der.sequence(der.oid(OID.sha512), der.null()), der.octetString(h))
    ]
    for (const t of forms) expect(rsaPkcs1Verify(key.pub, signBlock(key, block(t)), h, 'SHA-256')).toBeNull()
    // Too little padding.
    const short = cat(Uint8Array.of(0, 1, 0xff, 0), new Uint8Array(256 - 4 - good.length), good)
    expect(rsaPkcs1Verify(key.pub, signBlock(key, short), h, 'SHA-256')).toBeNull()
  })
})

describe('embedded timestamps', () => {
  const tsa = { sha256: 'TSA', isCA: false } as CertDetails
  const tsaRoot = { sha256: 'TSAROOT', isCA: true } as CertDetails
  function report(valid: boolean): SignatureReport {
    return {
      kind: 'approval',
      signingTime: '2024-05-01T12:00:00.000Z',
      timestamp: { time: '2024-05-02T09:00:00.000Z', authority: 'Some TSA', valid, certificates: [tsa, tsaRoot], chainVerified: [true, true] },
      certificates: [],
      chainVerified: [],
      problems: [],
      warnings: [],
      changes: [],
      integrity: true,
      signatureValid: true,
      coversWholeFile: true,
      permission: null,
      lock: null,
      unknownReason: null
    } as unknown as SignatureReport
  }

  it('only relies on the timestamp time when the authority is trusted', () => {
    const r = report(true)
    expect(timestampTrusted(r, new Set())).toBe(false)
    expect(displayedSigningTime(r, new Set())).toBe(r.signingTime)
    const st = signatureStatus(r, new Set())
    expect(st.timestampTrusted).toBe(false)
    expect(st.details.join(' ')).toMatch(/time-stamping authority is unknown/)
    expect(timestampTrusted(r, new Set(['TSAROOT']))).toBe(true)
    expect(displayedSigningTime(r, new Set(['TSAROOT']))).toBe(r.timestamp!.time)
    expect(signatureStatus(r, new Set(['TSAROOT'])).details.join(' ')).not.toMatch(/authority is unknown/)
  })

  it('does not trust a timestamp whose chain is broken or whose token did not verify', () => {
    const r = report(true)
    r.timestamp!.chainVerified = [false, true]
    expect(timestampTrusted(r, new Set(['TSAROOT']))).toBe(false)
    expect(timestampTrusted(report(false), new Set(['TSAROOT']))).toBe(false)
  })
})
