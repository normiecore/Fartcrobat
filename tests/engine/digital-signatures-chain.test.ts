import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type sigOps from '@features/digital-signatures/engine'
import { verifyTimestampToken } from '@features/digital-signatures/lib/cms'
import { der } from '@features/digital-signatures/lib/asn1'
import { digest, parsePublicKey, rsaPkcs1Verify } from '@features/digital-signatures/lib/crypto'
import { OID } from '@features/digital-signatures/lib/oids'
import { buildChain, describeCertificate, parseCertificate, type CertDetails, type Certificate } from '@features/digital-signatures/lib/x509'
import {
  chainTrustedIndex,
  displayedSigningTime,
  overallStatus,
  signatureStatus,
  signingTimeNote,
  timestampAuthorityInvalid,
  timestampTrusted
} from '@features/digital-signatures/status'
import { signaturesOut } from '@features/agent-access/tools/contextShape'
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
  'self-leaf',
  'ee-noku',
  'nobc'
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

  it('does not trust a certificate issued by an end entity without a key usage extension', async () => {
    // ee-noku is CA:FALSE and has no keyUsage: only basicConstraints rules it out as an issuer.
    const { certificates, verified } = await chainOf('leaf-of-ee-noku')
    expect(certificates.map((c) => c.subjectName)).toEqual(['leaf-of-ee-noku', 'ee-noku', 'root'])
    expect(verified).toEqual([false, true, true])
    expect(await trustedAt('leaf-of-ee-noku', ['root'])).toBe(-1)
    expect(await trustedAt('leaf-of-ee-noku', ['ee-noku'])).toBe(-1)
  })

  it('does not trust a certificate issued by a certificate without basic constraints', async () => {
    // nobc has keyCertSign but no basicConstraints extension, so it is not a CA (RFC 5280 4.2.1.9).
    const { certificates, verified } = await chainOf('leaf-of-nobc')
    expect(certificates.map((c) => c.subjectName)).toEqual(['leaf-of-nobc', 'nobc', 'root'])
    expect(verified).toEqual([false, true, true])
    expect(await trustedAt('leaf-of-nobc', ['root'])).toBe(-1)
    expect(await trustedAt('leaf-of-nobc', ['nobc'])).toBe(-1)
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
      timestamp: {
        time: '2024-05-02T09:00:00.000Z',
        authority: 'Some TSA',
        valid,
        authorityOk: true,
        certificates: [tsa, tsaRoot],
        chainVerified: [true, true]
      },
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

describe('RFC 3161 timestamp tokens', () => {
  // Tokens over chain/ts-data.bin made by make_chain.py: ts-good by `openssl ts -reply` with tsa
  // (critical EKU timeStamping), the others with the same TSTInfo signed by tsa-wrong-eku (EKU
  // emailProtection) and tsa-expired (valid 2020-2021). All chain to tsa-root.
  const file = (name: string) => new Uint8Array(readFileSync(join(DIR, name)))
  const DATA = file('ts-data.bin')
  const sha = async (name: string) => (await describeCertificate(cert(name))).sha256

  async function reportFor(token: string, data = DATA): Promise<SignatureReport> {
    const t = await verifyTimestampToken(file(token), data)
    return {
      kind: 'approval',
      signingTime: '2024-05-01T12:00:00.000Z',
      timestamp: {
        time: t.time.toISOString(),
        authority: t.authority,
        valid: t.valid,
        authorityOk: t.authorityOk,
        certificates: await Promise.all(t.chain.map((l) => describeCertificate(l.cert))),
        chainVerified: t.chain.map((l) => l.verified)
      },
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

  it('verifies a token from a proper authority and trusts it through its root', async () => {
    const t = await verifyTimestampToken(file('ts-good.tst'), DATA)
    expect(t.valid).toBe(true)
    expect(t.authorityOk).toBe(true)
    expect(t.chain.map((l) => l.cert.subject.text)).toEqual([cert('tsa').subject.text, cert('tsa-root').subject.text])
    expect(t.chain.map((l) => l.verified)).toEqual([true, true])
    const r = await reportFor('ts-good.tst')
    expect(timestampTrusted(r, new Set())).toBe(false)
    expect(displayedSigningTime(r, new Set())).toBe(r.signingTime)
    expect(timestampTrusted(r, new Set([await sha('tsa-root')]))).toBe(true)
    expect(timestampTrusted(r, new Set([await sha('tsa')]))).toBe(true)
    expect(displayedSigningTime(r, new Set([await sha('tsa-root')]))).toBe(r.timestamp!.time)
    // Another root does not vouch for this authority.
    expect(timestampTrusted(r, new Set([await sha('root')]))).toBe(false)
  })

  it('does not verify a token over other data', async () => {
    const r = await reportFor('ts-good.tst', new TextEncoder().encode('other data'))
    expect(r.timestamp!.valid).toBe(false)
    expect(timestampTrusted(r, new Set([await sha('tsa-root')]))).toBe(false)
  })

  it('does not trust a token signed by a certificate without the time-stamping key usage', async () => {
    const r = await reportFor('ts-wrong-eku.tst')
    expect(timestampTrusted(r, new Set([await sha('tsa-root')]))).toBe(false)
    const t = await verifyTimestampToken(file('ts-wrong-eku.tst'), DATA)
    expect(t.valid).toBe(true)
    expect(t.authorityOk).toBe(false)
    expect(t.chain.map((l) => l.verified)).toEqual([true, true])
    expect(timestampTrusted(r, new Set([await sha('tsa-wrong-eku')]))).toBe(false)
    expect(displayedSigningTime(r, new Set([await sha('tsa-root')]))).toBe(r.signingTime)
    expect(signatureStatus(r, new Set([await sha('tsa-root')])).details.join(' ')).toMatch(/not a time-stamping certificate/)
  })

  it('does not trust a token signed by an authority certificate that was not valid at the timestamp time', async () => {
    const r = await reportFor('ts-expired.tst')
    expect(timestampTrusted(r, new Set([await sha('tsa-root')]))).toBe(false)
    const t = await verifyTimestampToken(file('ts-expired.tst'), DATA)
    expect(t.valid).toBe(true)
    expect(t.authorityOk).toBe(false)
    expect(timestampTrusted(r, new Set([await sha('tsa-expired')]))).toBe(false)
  })

  it('reports the embedded timestamp of a signed PDF with its authority chain', async () => {
    // ../signed-timestamp.pdf: signed by leaf, with a timestamp from tsa over the signature value.
    const engine = await createLocalEngine()
    const res = await engine.ops<typeof docOps>('doc').open(file('../signed-timestamp.pdf'), { fileName: 'signed-timestamp.pdf' })
    expect(res.ok).toBe(true)
    const report = await engine.ops<typeof sigOps>('digital-signatures').validate()
    const r = report.signatures[0]
    expect(r.integrity).toBe(true)
    expect(r.certificates.map((c) => c.subjectName)).toEqual(['leaf', 'inter', 'root'])
    expect(r.timestamp).toMatchObject({ valid: true, authorityOk: true, chainVerified: [true, true] })
    expect(r.timestamp!.certificates.map((c) => c.subjectName)).toEqual(['tsa', 'tsa-root'])
    expect(timestampTrusted(r, new Set([await sha('root')]))).toBe(false)
    expect(timestampTrusted(r, new Set([await sha('tsa-root')]))).toBe(true)
    expect(signatureStatus(r, new Set([await sha('root')])).details.join(' ')).toMatch(/time-stamping authority is unknown/)
  })
})

describe('document timestamps', () => {
  // ../doctimestamp-*.pdf from make_chain.py: a /DocTimeStamp (ETSI.RFC3161) over the file, its
  // token signed by tsa (good), tsa-wrong-eku (EKU emailProtection) or leaf (no EKU at all).
  const sha = async (name: string) => (await describeCertificate(cert(name))).sha256

  async function validate(name: string) {
    const engine = await createLocalEngine()
    const res = await engine.ops<typeof docOps>('doc').open(new Uint8Array(readFileSync(join(DIR, '..', name))), { fileName: name })
    expect(res.ok).toBe(true)
    const report = await engine.ops<typeof sigOps>('digital-signatures').validate()
    expect(report.signatures).toHaveLength(1)
    return { report, r: report.signatures[0] }
  }

  it('trusts a document timestamp from a time-stamping authority under a trusted root', async () => {
    const { report, r } = await validate('doctimestamp-good.pdf')
    expect(r.kind).toBe('timestamp')
    expect(r.integrity).toBe(true)
    expect(r.timestamp).toMatchObject({ valid: true, authorityOk: true })
    expect(r.certificates.map((c) => c.subjectName)).toEqual(['tsa', 'tsa-root'])
    const trusted = new Set([await sha('tsa-root')])
    const st = signatureStatus(r, trusted)
    expect(st.level).toBe('valid')
    expect(st.title).toBe('Document timestamp is valid.')
    expect(st.timestampTrusted).toBe(true)
    expect(signingTimeNote(r, trusted)).toBe('')
    expect(overallStatus(report, trusted)!.level).toBe('valid')
    // Untrusted authority: valid, but the authority (and so the time) is unknown.
    expect(signatureStatus(r, new Set()).level).toBe('unknown-identity')
    expect(signingTimeNote(r, new Set())).toMatch(/not trusted/)
  })

  for (const [file, signer, chain] of [
    ['doctimestamp-wrong-eku.pdf', 'tsa-wrong-eku', ['tsa-wrong-eku', 'tsa-root']],
    ['doctimestamp-leaf.pdf', 'leaf', ['leaf', 'inter', 'root']]
  ] as const) {
    it(`does not show a document timestamp signed by ${signer} (not a time-stamping certificate) as valid`, async () => {
      const { report, r } = await validate(file)
      expect(r.kind).toBe('timestamp')
      expect(r.integrity).toBe(true)
      expect(r.signatureValid).toBe(true)
      expect(r.timestamp).toMatchObject({ valid: true, authorityOk: false })
      expect(r.certificates.map((c) => c.subjectName)).toEqual(chain)
      expect(r.chainVerified.every(Boolean)).toBe(true)
      // Even when the certificate's root, or the certificate itself, is trusted.
      for (const name of [chain[chain.length - 1], signer]) {
        const trusted = new Set([await sha(name)])
        const st = signatureStatus(r, trusted)
        expect(st.level).toBe('warning')
        expect(st.title).toBe('Document timestamp is valid, but there are problems.')
        expect(st.identityKnown).toBe(false)
        expect(st.trustedIndex).toBe(-1)
        expect(st.timestampTrusted).toBe(false)
        const text = st.details.join(' ')
        expect(text).not.toMatch(/authority is trusted/)
        expect(text).toMatch(/not a time-stamping certificate/)
        expect(signingTimeNote(r, trusted)).toBe('(not from a valid time-stamping certificate)')
        expect(overallStatus(report, trusted)!.level).toBe('warning')
      }
    })
  }

  it('ignores a timestamp nested in a document timestamp token', async () => {
    // ../doctimestamp-leaf-nested.pdf: the token is signed by leaf (no time-stamping EKU) and its
    // SignerInfo carries a timeStampToken from tsa (under tsa-root). The authority is the token's
    // own signer, so the nested token must not stand in for it.
    const { report, r } = await validate('doctimestamp-leaf-nested.pdf')
    expect(r.kind).toBe('timestamp')
    expect(r.subFilter).toBe('ETSI.RFC3161')
    expect(r.integrity).toBe(true)
    expect(r.signatureValid).toBe(true)
    expect(r.timestamp).toMatchObject({ valid: true, authorityOk: false, certificates: [], chainVerified: [] })
    expect(r.timestamp!.authority).not.toBe('tsa')
    expect(r.certificates.map((c) => c.subjectName)).toEqual(['leaf', 'inter', 'root'])
    for (const names of [['root'], ['leaf'], ['tsa-root'], ['root', 'leaf', 'tsa', 'tsa-root']]) {
      const trusted = new Set(await Promise.all(names.map(sha)))
      const st = signatureStatus(r, trusted)
      expect(st.level).toBe('warning')
      expect(st.identityKnown).toBe(false)
      expect(st.timestampTrusted).toBe(false)
      const text = st.details.join(' ')
      expect(text).not.toMatch(/authority is trusted|embedded timestamp/)
      expect(text).toMatch(/not a time-stamping certificate/)
      expect(signingTimeNote(r, trusted)).toBe('(not from a valid time-stamping certificate)')
      expect(overallStatus(report, trusted)!.level).toBe('warning')
      const out = signaturesOut(report, trusted).signatures[0]
      expect(out).toMatchObject({
        status: 'warning',
        identityTrusted: false,
        signingTimeNote: '(not from a valid time-stamping certificate)',
        timestamp: { trusted: false }
      })
    }
  })

  it("does not take a document timestamp's authority from another chain than its own", async () => {
    // Defensive: whatever the validator puts in r.timestamp, a document timestamp's authority is
    // the signature's own signer, so a timestamp with its own chain is not that authority.
    const { r } = await validate('doctimestamp-leaf.pdf')
    const { r: other } = await validate('signed-timestamp.pdf')
    const forged: SignatureReport = { ...r, timestamp: { ...other.timestamp! } }
    expect(forged.timestamp).toMatchObject({ valid: true, authorityOk: true })
    for (const names of [['root'], ['leaf'], ['tsa-root'], ['root', 'tsa-root']]) {
      const trusted = new Set(await Promise.all(names.map(sha)))
      expect(timestampTrusted(forged, trusted)).toBe(false)
      expect(timestampAuthorityInvalid(forged)).toBe(true)
      const st = signatureStatus(forged, trusted)
      expect(st.level).toBe('warning')
      expect(st.identityKnown).toBe(false)
      expect(st.details.join(' ')).not.toMatch(/authority is trusted|embedded timestamp/)
      expect(signingTimeNote(forged, trusted)).toBe('(not from a valid time-stamping certificate)')
    }
  })
})

describe('malformed document timestamps', () => {
  // ../doctimestamp-pkcs7*.pdf and ../sig-rfc3161.pdf from make_chain.py.
  const sha = async (name: string) => (await describeCertificate(cert(name))).sha256

  async function validate(name: string) {
    const engine = await createLocalEngine()
    const res = await engine.ops<typeof docOps>('doc').open(new Uint8Array(readFileSync(join(DIR, '..', name))), { fileName: name })
    expect(res.ok).toBe(true)
    const report = await engine.ops<typeof sigOps>('digital-signatures').validate()
    expect(report.signatures).toHaveLength(1)
    return { report, r: report.signatures[0] }
  }

  const claimed = new Date('2025-06-01T00:00:00Z').toISOString()

  for (const file of ['doctimestamp-pkcs7.pdf', 'doctimestamp-pkcs7-token.pdf']) {
    it(`reports a /DocTimeStamp that is not an RFC 3161 token as invalid (${file})`, async () => {
      const { report, r } = await validate(file)
      expect(r.kind).toBe('timestamp')
      expect(r.subFilter).toBe('adbe.pkcs7.detached')
      expect(r.problems.join(' ')).toMatch(/not an RFC 3161 timestamp/)
      // Not checked further: no authority, no embedded token to take a time from.
      expect(r.timestamp).toBeNull()
      expect(r.certificates).toEqual([])
      expect(r.signingTime).toBe(claimed)
      // Whatever is trusted: the signer's root, the signer, the embedded token's authority.
      for (const names of [[], ['root'], ['leaf'], ['tsa-root'], ['root', 'leaf', 'tsa', 'tsa-root']]) {
        const trusted = new Set(await Promise.all(names.map(sha)))
        const st = signatureStatus(r, trusted)
        expect(st.level).toBe('invalid')
        expect(st.title).toBe('Document timestamp is invalid.')
        expect(st.identityKnown).toBe(false)
        expect(st.timestampTrusted).toBe(false)
        expect(st.details.join(' ')).not.toMatch(/is trusted|embedded timestamp/)
        expect(signingTimeNote(r, trusted)).toBe('(could not be verified)')
        expect(displayedSigningTime(r, trusted)).toBe(claimed)
        expect(overallStatus(report, trusted)!.level).toBe('invalid')
        const out = signaturesOut(report, trusted).signatures[0]
        expect(out).toMatchObject({ kind: 'timestamp', status: 'invalid', identityTrusted: false, signingTime: claimed, signingTimeNote: '(could not be verified)' })
        expect(out).not.toHaveProperty('timestamp')
      }
    })
  }

  it('reports a /Sig whose value is an RFC 3161 token as invalid', async () => {
    const { report, r } = await validate('sig-rfc3161.pdf')
    expect(r.kind).toBe('approval')
    expect(r.subFilter).toBe('ETSI.RFC3161')
    expect(r.problems.join(' ')).toMatch(/not a document timestamp/)
    expect(r.timestamp).toBeNull()
    expect(r.signingTime).toBe(claimed)
    for (const names of [[], ['tsa'], ['tsa-root']]) {
      const trusted = new Set(await Promise.all(names.map(sha)))
      const st = signatureStatus(r, trusted)
      expect(st.level).toBe('invalid')
      expect(st.identityKnown).toBe(false)
      expect(st.timestampTrusted).toBe(false)
      expect(st.details.join(' ')).not.toMatch(/identity is valid|embedded timestamp/)
      expect(overallStatus(report, trusted)!.level).toBe('invalid')
      expect(signaturesOut(report, trusted).signatures[0]).toMatchObject({ status: 'invalid', identityTrusted: false })
    }
  })

  it('keys the document timestamp checks on the RFC 3161 format, not on the dictionary type alone', () => {
    // A report shaped like a /DocTimeStamp in CMS format with a verified embedded token, as if the
    // validator had checked it: the outer chain is not a time-stamping authority's, and the
    // embedded token's authority does not make the document timestamp trusted.
    const leaf = { sha256: 'LEAF', isCA: false } as CertDetails
    const root = { sha256: 'ROOT', isCA: true } as CertDetails
    const tsa = { sha256: 'TSA', isCA: false } as CertDetails
    const r = {
      kind: 'timestamp',
      subFilter: 'adbe.pkcs7.detached',
      signingTime: '2025-06-01T00:00:00.000Z',
      timestamp: { time: '2025-06-01T00:00:00.000Z', authority: 'tsa', valid: true, authorityOk: true, certificates: [tsa], chainVerified: [true] },
      certificates: [leaf, root],
      chainVerified: [true, true],
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
    for (const trusted of [new Set(['ROOT']), new Set(['LEAF']), new Set(['TSA']), new Set(['ROOT', 'TSA'])]) {
      expect(timestampTrusted(r, trusted)).toBe(false)
      expect(timestampAuthorityInvalid(r)).toBe(false)
      expect(signingTimeNote(r, trusted)).toBe('(could not be verified)')
      const st = signatureStatus(r, trusted)
      expect(st.level).toBe('invalid')
      expect(st.identityKnown).toBe(false)
      expect(st.details.join(' ')).not.toMatch(/is trusted/)
    }
    // The same token as an approval signature's value is malformed too.
    const sig = { ...r, kind: 'approval', subFilter: 'ETSI.RFC3161', timestamp: { ...r.timestamp!, certificates: [], chainVerified: [] } } as SignatureReport
    expect(timestampTrusted(sig, new Set(['ROOT']))).toBe(false)
    expect(signatureStatus(sig, new Set(['ROOT'])).level).toBe('invalid')
  })
})

describe('timestamps that claim to certify the document', () => {
  // ../doctimestamp-docmdp.pdf, ../doctimestamp-docmdp-only.pdf, ../doctimestamp-perms.pdf and
  // ../sig-rfc3161-docmdp.pdf from make_chain.py.
  const sha = async (name: string) => (await describeCertificate(cert(name))).sha256

  async function validate(name: string) {
    const engine = await createLocalEngine()
    const res = await engine.ops<typeof docOps>('doc').open(new Uint8Array(readFileSync(join(DIR, '..', name))), { fileName: name })
    expect(res.ok).toBe(true)
    const report = await engine.ops<typeof sigOps>('digital-signatures').validate()
    expect(report.signatures).toHaveLength(1)
    return { report, r: report.signatures[0] }
  }

  it('reports a document timestamp with a DocMDP reference as a problem, not as a certification', async () => {
    const { report, r } = await validate('doctimestamp-docmdp.pdf')
    expect(r.kind).toBe('timestamp')
    expect(r.permission).toBeNull()
    expect(r.integrity).toBe(true)
    expect(r.timestamp).toMatchObject({ valid: true, authorityOk: true })
    expect(r.problems.join(' ')).toMatch(/certification \(DocMDP\) reference/)
    expect(report.certified).toBeNull()
    expect(report.certifiedBy).toBeNull()
    // A timestamp certifies nothing, so its P 1 locks nothing either, whether or not /Perms names it
    // (doctimestamp-docmdp-only.pdf below).
    expect(report.locked).toBe(false)
    for (const names of [[], ['tsa'], ['tsa-root']]) {
      const trusted = new Set(await Promise.all(names.map(sha)))
      const st = signatureStatus(r, trusted)
      expect(st.level).toBe('invalid')
      expect(st.title).toBe('Document timestamp is invalid.')
      expect(st.details.join(' ')).not.toMatch(/document is certified/)
      expect(overallStatus(report, trusted)!.level).toBe('invalid')
      const out = signaturesOut(report, trusted)
      expect(out.signatures[0]).toMatchObject({ kind: 'timestamp', status: 'invalid' })
      expect(out).not.toHaveProperty('certified')
    }
  })

  it('reports a /Sig in the RFC 3161 format with a DocMDP reference as a problem, not as a certification', async () => {
    const { report, r } = await validate('sig-rfc3161-docmdp.pdf')
    expect(r.kind).toBe('approval')
    expect(r.permission).toBeNull()
    expect(r.problems.join(' ')).toMatch(/not a document timestamp/)
    expect(r.problems.join(' ')).toMatch(/certification \(DocMDP\) reference/)
    expect(report.certified).toBeNull()
    expect(report.certifiedBy).toBeNull()
    for (const names of [[], ['tsa'], ['tsa-root']]) {
      const trusted = new Set(await Promise.all(names.map(sha)))
      const st = signatureStatus(r, trusted)
      expect(st.level).toBe('invalid')
      expect(st.identityKnown).toBe(false)
      expect(st.details.join(' ')).not.toMatch(/document is certified|identity is valid/)
    }
  })

  it('does not take /Perms /DocMDP naming a document timestamp as a certification', async () => {
    const { report, r } = await validate('doctimestamp-perms.pdf')
    expect(r.kind).toBe('timestamp')
    expect(r.permission).toBeNull()
    expect(r.problems).toEqual([])
    expect(r.warnings.join(' ')).toMatch(/names this timestamp as its certification/)
    expect(report.certified).toBeNull()
    expect(report.certifiedBy).toBeNull()
    // /Perms names no permission without a reference: nothing to lock.
    expect(report.locked).toBe(false)
    const trusted = new Set([await sha('tsa-root')])
    const st = signatureStatus(r, trusted)
    expect(st.level).toBe('warning')
    expect(st.details.join(' ')).not.toMatch(/document is certified/)
  })

  it('does not lock the document for a timestamp DocMDP reference that /Perms does not name', async () => {
    const { report, r } = await validate('doctimestamp-docmdp-only.pdf')
    expect(r.kind).toBe('timestamp')
    expect(r.problems.join(' ')).toMatch(/certification \(DocMDP\) reference/)
    expect(report.certified).toBeNull()
    expect(report.locked).toBe(false)
  })
})

describe('certification claims no signature makes', () => {
  // ../doctimestamp-perms-direct.pdf and ../sig-perms-*.pdf from make_chain.py: the catalog's
  // /Perms /DocMDP claims a certification, but no signature dictionary carries a DocMDP reference.
  const sha = async (name: string) => (await describeCertificate(cert(name))).sha256

  async function validate(name: string) {
    const engine = await createLocalEngine()
    const res = await engine.ops<typeof docOps>('doc').open(new Uint8Array(readFileSync(join(DIR, '..', name))), { fileName: name })
    expect(res.ok).toBe(true)
    const report = await engine.ops<typeof sigOps>('digital-signatures').validate()
    expect(report.signatures).toHaveLength(1)
    return { report, r: report.signatures[0] }
  }

  for (const [file, kind, root, warning] of [
    ['doctimestamp-perms-direct.pdf', 'timestamp', 'tsa-root', /claims to be certified, but no signature in it certifies it/],
    ['sig-perms-direct.pdf', 'approval', 'root', /claims to be certified, but no signature in it certifies it/],
    ['sig-perms-other.pdf', 'approval', 'root', /claims to be certified, but no signature in it certifies it/],
    ['sig-perms-named.pdf', 'approval', 'root', /names this signature as its certification, but the signature carries no certification/]
  ] as const) {
    it(`does not report ${file} as certified`, async () => {
      const { report, r } = await validate(file)
      expect(r.kind).toBe(kind)
      expect(r.permission).toBeNull()
      expect(r.integrity).toBe(true)
      expect(r.problems).toEqual([])
      expect(r.warnings.join(' ')).toMatch(warning)
      expect(report.certified).toBeNull()
      expect(report.certifiedBy).toBeNull()
      expect(report.locked).toBe(false)
      const trusted = new Set([await sha(root)])
      const st = signatureStatus(r, trusted)
      expect(st.level).toBe('warning')
      expect(st.details.join(' ')).not.toMatch(/document is certified/)
      const overall = overallStatus(report, trusted)!
      expect(overall.level).toBe('warning')
      expect(overall.message).not.toMatch(/Certified/)
      const out = signaturesOut(report, trusted)
      expect(out).not.toHaveProperty('certified')
      expect(out.signatures[0]).toMatchObject({ kind })
    })
  }
})

describe('RFC 3161 token content type', () => {
  it('does not accept a document timestamp token whose content is not marked as TSTInfo', async () => {
    // ../doctimestamp-econtent.pdf: a genuine TSTInfo from tsa, signed by tsa, but encapsulated as
    // id-data instead of id-ct-TSTInfo.
    const name = 'doctimestamp-econtent.pdf'
    const engine = await createLocalEngine()
    const res = await engine.ops<typeof docOps>('doc').open(new Uint8Array(readFileSync(join(DIR, '..', name))), { fileName: name })
    expect(res.ok).toBe(true)
    const report = await engine.ops<typeof sigOps>('digital-signatures').validate()
    const r = report.signatures[0]
    expect(r.kind).toBe('timestamp')
    expect(r.problems.join(' ')).toMatch(/does not hold timestamp information/)
    expect(r.timestamp).toBeNull()
    expect(r.integrity).not.toBe(true)
    const trusted = new Set([(await describeCertificate(cert('tsa-root'))).sha256])
    expect(signatureStatus(r, trusted).level).toBe('invalid')
    expect(timestampTrusted(r, trusted)).toBe(false)
  })
})
