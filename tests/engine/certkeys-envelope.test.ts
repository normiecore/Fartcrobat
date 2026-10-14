// Certificate encryption: reading the /Recipients envelopes (CMS EnvelopedData) of every fixture,
// describing their recipients, and matching recipients to certificates.
import { sha1 } from '@noble/hashes/legacy.js'
import { describe, expect, it } from 'vitest'
import { der, parseAsn1, readBitString, toHex } from '@features/digital-signatures/lib/asn1'
import {
  contentCipher,
  ENVELOPE_OID,
  EnvelopeError,
  nameText,
  oaepParams,
  parseEnvelope,
  recipientMatches,
  stripLeadingZeros,
  summarizeRecipients,
  type RecipientId
} from '@features/digital-signatures/lib/envelope'
import { parseCertificate, type Certificate } from '@features/digital-signatures/lib/x509'
import { certDer, expected, expectedFile, recipientsOf } from './certkeys-fixtures'

const KEY_TYPE: Record<string, string> = {
  [ENVELOPE_OID.rsaEncryption]: 'rsa',
  [ENVELOPE_OID.rsaesOaep]: 'rsa-oaep'
}

/** cryptography's rfc4514_string() has no space after the commas. */
const rfc4514 = (text: string) => text.replace(/, /g, ',')

describe('parseEnvelope and summarizeRecipients over every fixture', () => {
  for (const file of expected.files) {
    it(file.file, () => {
      const blobs = recipientsOf(file.file)
      expect(blobs.length).toBe(Math.max(...file.recipients.map((r) => r.envelope)) + 1)
      const summary = summarizeRecipients(blobs)
      const valid = file.recipients.filter((r) => !r.damaged)
      expect(summary).toHaveLength(valid.length)
      valid.forEach((want, i) => {
        const got = summary[i]
        expect(got.envelope).toBe(want.envelope)
        expect(got.index).toBe(want.index)
        expect(got.idType).toBe(want.idType)
        expect(got.keyType).toBe(want.idType === 'keyAgreement' ? 'ec' : KEY_TYPE[want.keyEncryption!])
        if (want.idType === 'subjectKeyIdentifier') {
          expect(got.ski).toBe(want.ski)
          expect(got.issuer).toBeUndefined()
          expect(got.serial).toBeUndefined()
        } else {
          expect(rfc4514(got.issuer!)).toBe(want.issuer)
          // Uppercase hex without the DER INTEGER's leading zero byte.
          expect(got.serial).toBe(want.serialHex!.replace(/^(00)+(?=[0-9A-F]{2})/, ''))
        }
        const env = parseEnvelope(blobs[want.envelope])
        expect(env.contentEncryption.oid).toBe(want.contentCipher)
        const ri = env.recipientInfos.find((r) => r.index === want.index)!
        expect(ri.kind).toBe(want.idType === 'keyAgreement' ? 'kari' : 'ktri')
        expect(ri.keyEncryption.oid).toBe(want.keyEncryption)
        expect(ri.encryptedKey.length).toBeGreaterThan(0)
        expect(env.encryptedContent.length % 8).toBe(0)
      })
      for (const bad of file.recipients.filter((r) => r.damaged)) {
        expect(() => parseEnvelope(blobs[bad.envelope])).toThrow(EnvelopeError)
      }
    })
  }

  it('bob: the UTF-8 issuer as text, and the serial without its leading 00', () => {
    const [bob, alice] = summarizeRecipients(recipientsOf('v5-two-recipients.pdf'))
    expect(bob).toEqual({
      envelope: 0,
      index: 0,
      idType: 'issuerAndSerialNumber',
      issuer:
        'CN=Fartcrobat Tëst CA Ünïcode ✓, OU=TEST KEYS ONLY - never use for anything real, O=Fartcrobat Test Keys',
      serial: 'C702FE1F51EB78F7042245CFFD210279',
      keyType: 'rsa'
    })
    expect(alice).toMatchObject({
      index: 1,
      serial: '2BF5739A719BB028F20B38EB7F084141',
      issuer: expect.stringContaining('CN=Fartcrobat Test CA,')
    })
    // The raw recipient identifier keeps the INTEGER's content bytes as stored.
    const rid = parseEnvelope(recipientsOf('v5-two-recipients.pdf')[0]).recipientInfos[0].rid as {
      serial: Uint8Array
    }
    expect(toHex(rid.serial)).toBe(expectedFile('v5-two-recipients.pdf').recipients[0].serialHex)
  })

  it('two envelopes, a damaged first envelope (skipped) and key agreement (EC)', () => {
    expect(
      summarizeRecipients(recipientsOf('v5-two-envelopes.pdf')).map((r) => [r.envelope, r.index])
    ).toEqual([
      [0, 0],
      [1, 0]
    ])
    expect(summarizeRecipients(recipientsOf('v5-damaged-first.pdf'))).toEqual([
      expect.objectContaining({ envelope: 1, index: 0, keyType: 'rsa' })
    ])
    expect(summarizeRecipients(recipientsOf('v5-ec.pdf'))).toEqual([
      expect.objectContaining({
        idType: 'keyAgreement',
        keyType: 'ec',
        serial: '234DEFAA00C3049BC5B66D47EE37F5B6'
      })
    ])
    expect(summarizeRecipients([new Uint8Array([0x30, 0x03, 0x02, 0x01]), new Uint8Array()])).toEqual([])
  })

  it('throws on anything that is not a well-formed enveloped-data content info', () => {
    const good = recipientsOf('v5-classic.pdf')[0]
    expect(() => parseEnvelope(good.subarray(0, good.length - 10))).toThrow(EnvelopeError)
    expect(() => parseEnvelope(new Uint8Array())).toThrow(EnvelopeError)
    // signedData instead of envelopedData
    expect(() =>
      parseEnvelope(der.sequence(der.oid('1.2.840.113549.1.7.2'), der.explicit(0, der.sequence())))
    ).toThrow('Not an enveloped-data')
    // no recipient infos, no encrypted content
    expect(() =>
      parseEnvelope(
        der.sequence(der.oid(ENVELOPE_OID.envelopedData), der.explicit(0, der.sequence(der.integer(0))))
      )
    ).toThrow(EnvelopeError)
  })
})

describe('content ciphers and OAEP parameters', () => {
  it('AES-256, AES-128 and DES-EDE3 content from the fixtures', () => {
    const aes256 = contentCipher(parseEnvelope(recipientsOf('v5-classic.pdf')[0]).contentEncryption)
    expect(aes256).toMatchObject({ name: 'aes-256-cbc', keyLength: 32 })
    expect(aes256!.iv).toHaveLength(16)
    expect(
      contentCipher(parseEnvelope(recipientsOf('v5-env-aes128.pdf')[0]).contentEncryption)
    ).toMatchObject({ name: 'aes-128-cbc', keyLength: 16 })
    const des = contentCipher(parseEnvelope(recipientsOf('v5-env-3des.pdf')[0]).contentEncryption)
    expect(des).toMatchObject({ name: 'des-ede3-cbc', keyLength: 24 })
    expect(des!.iv).toHaveLength(8)
  })

  it('AES-192, RC2 (both parameter forms) and unknown algorithms', () => {
    const iv8 = new Uint8Array(8).fill(7)
    expect(
      contentCipher({ oid: ENVELOPE_OID.aes192Cbc, params: der.octetString(new Uint8Array(16)) })
    ).toMatchObject({ name: 'aes-192-cbc', keyLength: 24 })
    expect(
      contentCipher({ oid: ENVELOPE_OID.rc2Cbc, params: der.sequence(der.integer(58), der.octetString(iv8)) })
    ).toMatchObject({
      name: 'rc2-cbc',
      keyLength: null,
      effectiveBits: 128,
      iv: iv8
    })
    expect(
      contentCipher({
        oid: ENVELOPE_OID.rc2Cbc,
        params: der.sequence(der.integer(160), der.octetString(iv8))
      })
    ).toMatchObject({ effectiveBits: 40 })
    expect(contentCipher({ oid: ENVELOPE_OID.rc2Cbc, params: der.octetString(iv8) })).toMatchObject({
      effectiveBits: 32
    })
    expect(
      contentCipher({ oid: ENVELOPE_OID.rc2Cbc, params: der.sequence(der.integer(7), der.octetString(iv8)) })
    ).toBeNull()
    expect(contentCipher({ oid: '1.2.840.113549.3.4', params: null })).toBeNull() // RC4
    expect(() => contentCipher({ oid: ENVELOPE_OID.aes256Cbc, params: der.octetString(iv8) })).toThrow(
      'bad IV'
    )
    expect(() => contentCipher({ oid: ENVELOPE_OID.aes256Cbc, params: null })).toThrow('no IV')
  })

  it('OAEP: the fixture uses SHA-256 with MGF1-SHA-256; absent parameters mean SHA-1', () => {
    const ri = parseEnvelope(recipientsOf('v5-oaep.pdf')[0]).recipientInfos[0]
    expect(ri.keyEncryption.oid).toBe(ENVELOPE_OID.rsaesOaep)
    expect(oaepParams(ri.keyEncryption.params)).toEqual({
      hash: 'sha256',
      mgf1Hash: 'sha256',
      label: new Uint8Array()
    })
    expect(oaepParams(null)).toEqual({ hash: 'sha1', mgf1Hash: 'sha1', label: new Uint8Array() })
    expect(oaepParams(der.sequence())).toEqual({ hash: 'sha1', mgf1Hash: 'sha1', label: new Uint8Array() })
    const md5 = der.sequence(der.explicit(0, der.sequence(der.oid('1.2.840.113549.2.5'), der.null())))
    expect(oaepParams(md5)).toBeNull()
    const labelled = der.sequence(
      der.explicit(2, der.sequence(der.oid(ENVELOPE_OID.pSpecified), der.octetString(Uint8Array.of(1, 2, 3))))
    )
    expect(oaepParams(labelled)!.label).toEqual(Uint8Array.of(1, 2, 3))
  })
})

describe('recipientMatches', () => {
  // SHA-1 comes from the caller (node:crypto in the main process).
  const matches = (rid: RecipientId | null, cert: Certificate) => recipientMatches(rid, cert, sha1)
  const alice = parseCertificate(certDer('alice'))
  const bob = parseCertificate(certDer('bob'))
  const stranger = parseCertificate(certDer('stranger'))

  it('issuerAndSerialNumber: issuer DER and serial, ignoring leading zero bytes (bob)', () => {
    const [bobRid, aliceRid] = parseEnvelope(recipientsOf('v5-two-recipients.pdf')[0]).recipientInfos.map(
      (r) => r.rid
    )
    expect(toHex((bobRid as { serial: Uint8Array }).serial).startsWith('00')).toBe(true)
    expect(toHex(bob.serial).startsWith('00')).toBe(true)
    expect(matches(bobRid, bob)).toBe(true)
    expect(matches(aliceRid, alice)).toBe(true)
    expect(matches(bobRid, alice)).toBe(false)
    expect(matches(aliceRid, stranger)).toBe(false) // same issuer, other serial
    // The same serial written without the leading zero still matches.
    const stripped = {
      issuer: (bobRid as { issuer: Uint8Array }).issuer,
      serial: stripLeadingZeros((bobRid as { serial: Uint8Array }).serial)
    }
    expect(matches(stripped, bob)).toBe(true)
    // An issuer that differs only in bytes (another string type) does not.
    const issuer = (aliceRid as { issuer: Uint8Array }).issuer.slice()
    issuer[issuer.length - 1] ^= 1
    expect(matches({ issuer, serial: alice.serial }, alice)).toBe(false)
    expect(matches(null, alice)).toBe(false)
  })

  it('subjectKeyIdentifier: the extension, the SHA-1 of the key bits, or the SHA-1 of the whole key info', () => {
    const rid = parseEnvelope(recipientsOf('v5-ski.pdf')[0]).recipientInfos[0].rid!
    expect(toHex((rid as { ski: Uint8Array }).ski)).toBe('D7445486090C462D17C8AAFE207ECC1141FD9F4E')
    expect(matches(rid, alice)).toBe(true)
    expect(matches(rid, bob)).toBe(false)
    // alice's key in a certificate without the SKI extension (as Windows names keys then).
    const noSki = { ...alice, subjectKeyId: null }
    expect(matches(rid, noSki)).toBe(true)
    const spkiHash = sha1(noSki.publicKey.spki)
    expect(matches({ ski: spkiHash }, noSki)).toBe(true)
    expect(
      matches({ ski: sha1(readBitString(parseAsn1(bob.publicKey.spki).children[1]).bytes) }, noSki)
    ).toBe(false)
    expect(matches({ ski: new Uint8Array() }, alice)).toBe(false)
  })
})

describe('nameText', () => {
  it('most specific first, with RFC 4514 escaping', () => {
    const rdn = (oid: string, v: Uint8Array) => der.set(der.sequence(der.oid(oid), v))
    const name = der.sequence(
      rdn('2.5.4.6', der.printable('US')),
      rdn('2.5.4.10', der.utf8('Acme, Inc.')),
      rdn('2.5.4.3', der.utf8('#1 "Signer"'))
    )
    expect(nameText(name)).toBe('CN=\\#1 \\"Signer\\", O=Acme\\, Inc., C=US')
  })
})
