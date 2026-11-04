// Certificate encryption: Digital IDs (.p12) as keys, in the main process. Probing with the
// records' certificates only, decrypting with a typed or saved password, and every envelope kind
// in the fixtures (the seed and permissions must equal expected.json).
import { createCipheriv, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import forge from 'node-forge'
import { describe, expect, it } from 'vitest'
import { CLASS_UNIVERSAL, der, TAG, tlv } from '@features/digital-signatures/lib/asn1'
import { ENVELOPE_OID } from '@features/digital-signatures/lib/envelope'
import { parseCertificate } from '@features/digital-signatures/lib/x509'
import { createDigitalIdSource } from '@main/certkeys/digitalIdSource'
import { CertKeyError, type SourceDecryptOptions } from '@main/certkeys/source'
import { digitalIdKey } from '@main/passwords/keys'
import { SavedPasswordStore } from '@main/passwords/store'
import type { CertKeyCandidate } from '@shared/certkeys'
import type { SavedPasswordsUnavailable } from '@shared/passwords'
import {
  certDer,
  expected,
  expectedFile,
  hex,
  idRecord,
  PASSWORDS,
  PKI,
  recipientsOf,
  splitContent
} from './certkeys-fixtures'
import { fakeCipher, memoryFs } from './saved-passwords-fakes'

function setup(o: { ids?: string[]; records?: unknown[]; unavailable?: SavedPasswordsUnavailable } = {}) {
  const cipher = fakeCipher({ unavailable: o.unavailable ?? null })
  const store = new SavedPasswordStore({ file: '/u/saved-passwords.json', cipher, fs: memoryFs() })
  const state = { remembering: true, reads: [] as string[], now: Date.parse('2026-10-14T12:00:00Z') }
  const records = o.records ?? (o.ids ?? ['alice', 'bob', 'stranger', 'ec']).map((n) => idRecord(n))
  const source = createDigitalIdSource({
    records: () => records,
    passwords: () => store,
    remembering: () => state.remembering,
    readFile: async (path) => {
      state.reads.push(path)
      return new Uint8Array(await readFile(path))
    },
    now: () => state.now
  })
  /** Probes, then decrypts with the candidate of `name`. */
  async function open(file: string | Uint8Array[], name: string, opts: Partial<SourceDecryptOptions> = {}) {
    const blobs = typeof file === 'string' ? recipientsOf(file) : file
    const candidate = (await source.probe(blobs)).find((c) => c.id === `digital-id:${idRecord(name).id}`)
    if (!candidate) throw new Error(`${name} is not a candidate`)
    return source.decrypt(blobs, candidate, { actor: 'person', ...opts })
  }
  return { source, store, cipher, state, open }
}

async function failure(p: Promise<unknown>): Promise<CertKeyError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(CertKeyError)
    return err as CertKeyError
  }
  throw new Error('expected a CertKeyError')
}

const aliceKey = digitalIdKey(idRecord('alice').id)

describe('DigitalIdSource.probe', () => {
  it('finds the Digital IDs a file is encrypted for, from their certificates alone', async () => {
    const { source, state } = setup()
    const alice = idRecord('alice')
    expect(source.count()).toBe(4)
    const candidates = await source.probe(recipientsOf('v5-classic.pdf'))
    expect(candidates).toEqual<CertKeyCandidate[]>([
      {
        id: `digital-id:${alice.id}`,
        source: 'digital-id',
        label: 'Alice Test',
        subject: 'CN=Alice Test, OU=TEST KEYS ONLY - never use for anything real, O=Fartcrobat Test Keys',
        issuer:
          'CN=Fartcrobat Test CA, OU=TEST KEYS ONLY - never use for anything real, O=Fartcrobat Test Keys',
        fingerprint: alice.id,
        envelope: 0,
        index: 0,
        needs: 'password',
        hardware: false,
        keyType: 'rsa'
      }
    ])
    expect(state.reads).toEqual([]) // no .p12 was read
    // Both recipients, in the envelope and RecipientInfo they match.
    const two = await source.probe(recipientsOf('v5-two-envelopes.pdf'))
    expect(two.map((c) => [c.label, c.envelope, c.index])).toEqual([
      ['Alice Test', 1, 0],
      ['Bob Tëst', 0, 0]
    ])
    expect(
      (await source.probe(recipientsOf('v5-damaged-first.pdf'))).map((c) => [c.label, c.envelope])
    ).toEqual([['Alice Test', 1]])
    expect((await source.probe(recipientsOf('v5-ski.pdf'))).map((c) => c.label)).toEqual(['Alice Test'])
  })

  it('a stranger finds nothing; the EC Digital ID is listed with keyType ec', async () => {
    const { source } = setup({ ids: ['stranger'] })
    expect(await source.probe(recipientsOf('v5-classic.pdf'))).toEqual([])
    const alice = setup({ ids: ['alice'] })
    expect(await alice.source.probe(recipientsOf('stranger-only.pdf'))).toEqual([])
    expect(await alice.source.probe([])).toEqual([])
    const ec = await setup().source.probe(recipientsOf('v5-ec.pdf'))
    expect(ec).toEqual([expect.objectContaining({ label: 'EC Test', keyType: 'ec', needs: 'password' })])
  })

  it('marks expired certificates, and ignores records that are not what they say', async () => {
    const { source, state } = setup({ ids: ['alice'] })
    state.now = Date.parse('2050-01-01T00:00:00Z')
    expect(await source.probe(recipientsOf('v5-classic.pdf'))).toEqual([
      expect.objectContaining({ expired: true })
    ])
    const forged = { ...idRecord('alice'), id: idRecord('bob').id }
    const odd = setup({
      records: [forged, null, 'x', { id: 1 }, { ...idRecord('bob'), certificate: 'not base64 DER' }]
    })
    expect(odd.source.count()).toBe(0)
    expect(await odd.source.probe(recipientsOf('v5-classic.pdf'))).toEqual([])
    expect(setup({ records: 'nothing' as never }).source.count()).toBe(0)
  })
})

describe('DigitalIdSource.decrypt', () => {
  it('needs a password when none is typed or saved; a wrong one is WRONG_PASSWORD', async () => {
    const { open } = setup()
    const needed = await failure(open('v5-classic.pdf', 'alice'))
    expect(needed.code).toBe('PASSWORD_NEEDED')
    expect(needed.message).toBe('Enter the password of the Digital ID “Alice Test”.')
    expect(needed.extra.savedStale).toBeUndefined()
    const wrong = await failure(open('v5-classic.pdf', 'alice', { password: 'nope' }))
    expect(wrong.code).toBe('WRONG_PASSWORD')
    expect(wrong.message).not.toMatch(/nope|p12|\//)
  })

  it('remembers a typed password that worked, then opens silently with it', async () => {
    const { open, source, store } = setup()
    const want = expectedFile('v5-classic.pdf')
    const first = await open('v5-classic.pdf', 'alice', { password: 'alice-pass', remember: true })
    expect(splitContent(first.content)).toEqual({
      seed: want.seedHex.alice,
      permissions: want.permissions.alice
    })
    expect(first.envelope).toBe(0)
    expect(first.via).toEqual({
      source: 'digital-id',
      label: 'Alice Test',
      subject: expect.stringContaining('CN=Alice Test'),
      fingerprint: idRecord('alice').id,
      hardware: false,
      remembered: true
    })
    expect(await store.savedFor([aliceKey])).toMatchObject({ kind: 'digital-id', label: 'Alice Test' })
    expect((await source.probe(recipientsOf('v5-classic.pdf')))[0].passwordSaved).toBe(true)
    // Any other file for alice now opens without asking.
    const silent = await open('v5-objstm.pdf', 'alice')
    expect(silent.via).toMatchObject({ savedPassword: true })
    expect(silent.via.remembered).toBeUndefined()
    expect(splitContent(silent.content).seed).toBe(expectedFile('v5-objstm.pdf').seedHex.alice)
  })

  it('without remember, or with remembering off or no keyring, nothing is saved or used', async () => {
    const plain = setup()
    const opened = await plain.open('v5-classic.pdf', 'alice', { password: 'alice-pass' })
    expect(opened.via.remembered).toBeUndefined()
    expect(await plain.store.savedFor([aliceKey])).toBeNull()

    const off = setup()
    off.state.remembering = false
    expect(
      (await off.open('v5-classic.pdf', 'alice', { password: 'alice-pass', remember: true })).via.remembered
    ).toBeUndefined()
    expect(await off.store.savedFor([aliceKey])).toBeNull()
    // A password saved earlier is neither offered nor used while remembering is off.
    await off.store.remember({
      kind: 'digital-id',
      keys: [aliceKey],
      label: 'Alice Test',
      password: 'alice-pass'
    })
    expect((await off.source.probe(recipientsOf('v5-classic.pdf')))[0].passwordSaved).toBeUndefined()
    expect((await failure(off.open('v5-classic.pdf', 'alice'))).code).toBe('PASSWORD_NEEDED')
    expect(off.cipher.state.decrypts).toBe(0)

    const noKeyring = setup({ unavailable: 'no-keyring' })
    expect(
      (await noKeyring.open('v5-classic.pdf', 'alice', { password: 'alice-pass', remember: true })).via
        .remembered
    ).toBeUndefined()
    expect(await noKeyring.store.count()).toBe(0)
  })

  it('a saved password that no longer works is forgotten: PASSWORD_NEEDED with savedStale', async () => {
    const { open, source, store } = setup()
    await store.remember({ kind: 'digital-id', keys: [aliceKey], label: 'Alice Test', password: 'old-pass' })
    expect((await source.probe(recipientsOf('v5-classic.pdf')))[0].passwordSaved).toBe(true)
    const stale = await failure(open('v5-classic.pdf', 'alice'))
    expect(stale.code).toBe('PASSWORD_NEEDED')
    expect(stale.extra).toEqual({ savedStale: true })
    expect(stale.message).not.toContain('old-pass')
    expect(await store.savedFor([aliceKey])).toBeNull()
    // The typed password then works (and replaces it when asked).
    expect(
      (await open('v5-classic.pdf', 'alice', { password: 'alice-pass', remember: true })).via.remembered
    ).toBe(true)
  })

  describe('every fixture opens with each of its RSA recipients, with the expected seed and permissions', () => {
    for (const file of expected.files) {
      for (const name of file.opensWith.filter((n) => n !== 'ec')) {
        it(`${file.file} as ${name}`, async () => {
          const { open } = setup()
          const out = await open(file.file, name, { password: PASSWORDS[name] })
          expect(splitContent(out.content)).toEqual({
            seed: file.seedHex[name],
            permissions: file.permissions[name]
          })
          const mine = file.recipients.find((r) => r.cert === name)!
          expect(out.envelope).toBe(mine.envelope)
        })
      }
    }
  })

  it('EC: UNSUPPORTED, without reading the Digital ID file or asking for its password', async () => {
    const { open, state } = setup()
    const err = await failure(open('v5-ec.pdf', 'ec'))
    expect(err.code).toBe('UNSUPPORTED')
    expect(err.message).toMatch(/elliptic curve/)
    expect(state.reads).toEqual([])
  })

  it('a missing Digital ID file is ID_UNAVAILABLE; a file holding another ID is NO_MATCHING_CERT', async () => {
    const missing = setup({ records: [idRecord('alice', join(PKI, 'gone', 'alice.p12'))] })
    for (const password of [undefined, 'alice-pass']) {
      const err = await failure(missing.open('v5-classic.pdf', 'alice', password ? { password } : {}))
      expect(err.code).toBe('ID_UNAVAILABLE')
      expect(err.message).not.toContain(PKI)
    }
    const swapped = setup({ records: [idRecord('alice', join(PKI, 'bob.p12'))] })
    expect((await failure(swapped.open('v5-classic.pdf', 'alice', { password: 'bob-pass' }))).code).toBe(
      'NO_MATCHING_CERT'
    )
    const notIt = await failure(
      setup({ ids: ['alice'] }).source.decrypt(
        recipientsOf('v5-classic.pdf'),
        { id: `digital-id:${idRecord('bob').id}` } as CertKeyCandidate,
        { actor: 'person' }
      )
    )
    expect(notIt.code).toBe('NO_MATCHING_CERT')
    const notFor = await failure(
      setup({ ids: ['alice'] }).source.decrypt(
        recipientsOf('stranger-only.pdf'),
        { id: `digital-id:${idRecord('alice').id}` } as CertKeyCandidate,
        { actor: 'person' }
      )
    )
    expect(notFor.code).toBe('NO_MATCHING_CERT')
  })

  describe('envelopes made here: RC2, AES-192 and OAEP with default (SHA-1) parameters', () => {
    const bin = (b: Uint8Array) => forge.util.binary.raw.encode(b)
    const unbin = (s: string) => new Uint8Array(forge.util.binary.raw.decode(s))
    const content = new Uint8Array([...randomBytes(20), 0xff, 0xff, 0xf8, 0xc5])

    function envelope(cipher: 'rc2' | 'aes192', oaep: boolean): Uint8Array {
      const cert = parseCertificate(certDer('alice'))
      const pub = forge.pki.publicKeyFromAsn1(
        forge.asn1.fromDer(bin(cert.publicKey.spki))
      ) as forge.pki.rsa.PublicKey
      let key: Uint8Array
      let alg: Uint8Array
      let encrypted: Uint8Array
      if (cipher === 'rc2') {
        key = randomBytes(16)
        const iv = randomBytes(8)
        const c = forge.rc2.createEncryptionCipher(bin(key), 128)
        c.start(bin(iv))
        c.update(forge.util.createBuffer(bin(content)))
        c.finish()
        encrypted = unbin(c.output.getBytes())
        alg = der.sequence(der.oid(ENVELOPE_OID.rc2Cbc), der.sequence(der.integer(58), der.octetString(iv)))
      } else {
        key = randomBytes(24)
        const iv = randomBytes(16)
        const c = createCipheriv('aes-192-cbc', key, iv)
        encrypted = new Uint8Array(Buffer.concat([c.update(content), c.final()]))
        alg = der.sequence(der.oid(ENVELOPE_OID.aes192Cbc), der.octetString(iv))
      }
      const wrapped = unbin(pub.encrypt(bin(key), oaep ? 'RSA-OAEP' : 'RSAES-PKCS1-V1_5'))
      const keyAlg = oaep
        ? der.sequence(der.oid(ENVELOPE_OID.rsaesOaep), der.sequence())
        : der.sequence(der.oid(ENVELOPE_OID.rsaEncryption), der.null())
      const ri = der.sequence(
        der.integer(0),
        der.sequence(cert.issuer.raw, tlv(CLASS_UNIVERSAL, false, TAG.INTEGER, cert.serial)),
        keyAlg,
        der.octetString(wrapped)
      )
      const ed = der.sequence(
        der.integer(0),
        der.set(ri),
        der.sequence(der.oid('1.2.840.113549.1.7.1'), alg, der.implicitPrimitive(0, encrypted))
      )
      return der.sequence(der.oid(ENVELOPE_OID.envelopedData), der.explicit(0, ed))
    }

    for (const [cipher, oaep] of [
      ['rc2', false],
      ['aes192', false],
      ['aes192', true]
    ] as const) {
      it(`${cipher}${oaep ? ' with OAEP' : ''}`, async () => {
        const out = await setup({ ids: ['alice'] }).open([envelope(cipher, oaep)], 'alice', {
          password: 'alice-pass'
        })
        expect(hex(out.content)).toBe(hex(content))
      })
    }

    it('an unknown content cipher is UNSUPPORTED before any password is needed', async () => {
      const blob = envelope('aes192', false)
      const text = hex(blob).replace(
        hex(der.oid(ENVELOPE_OID.aes192Cbc)),
        hex(der.oid('2.16.840.1.101.3.4.1.46'))
      ) // AES-256-GCM
      const { open, state } = setup({ ids: ['alice'] })
      const err = await failure(open([new Uint8Array(Buffer.from(text, 'hex'))], 'alice'))
      expect(err.code).toBe('UNSUPPORTED')
      expect(state.reads).toEqual([])
    })
  })
})
