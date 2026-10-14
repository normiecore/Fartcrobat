/**
 * Digital IDs (.p12/.pfx files from Preferences > Digital IDs) as keys for certificate-encrypted
 * PDFs, on every platform. Main process only: the private key, the Digital ID password and the
 * envelope's content key never leave this file; only the envelope's content (seed and permission
 * bytes) is returned.
 *
 * - Probing reads the certificates kept in the Digital ID records, so it needs no password, reads
 *   no .p12 file and never touches the keyring.
 * - Decrypting uses the password the person typed or, silently, the one saved on this device (the
 *   SavedPasswordStore, target { kind: 'digital-id', certificateSha256 }). A saved password that
 *   no longer works is forgotten.
 * - Key transport runs on node-forge (RSAES-PKCS1-v1_5 and RSAES-OAEP), because Node and Electron
 *   refuse PKCS#1 v1.5 private-key decryption. The content is decrypted with node:crypto for AES
 *   and node-forge for DES-EDE3 and RC2, which Electron's BoringSSL may lack.
 *
 * Nothing here logs, and error messages hold no paths or secrets.
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import forge from 'node-forge'
import type { CertKeyCandidate, CertKeyVia } from '@shared/certkeys'
import { bytesEqual, fromBase64 } from '@features/digital-signatures/lib/asn1'
import {
  contentCipher,
  ENVELOPE_OID,
  nameText,
  oaepParams,
  parseEnvelope,
  recipientMatches,
  type ContentCipher,
  type EnvelopeRecipient,
  type ParsedEnvelope
} from '@features/digital-signatures/lib/envelope'
import {
  DigitalIdError,
  parseDigitalId,
  WrongPasswordError,
  type ParsedDigitalId
} from '@features/digital-signatures/lib/pkcs12'
import { displayName, parseCertificate, type Certificate } from '@features/digital-signatures/lib/x509'
import { digitalIdKey } from '../passwords/keys'
import type { SavedPasswordStore } from '../passwords/store'
import {
  CertKeyError,
  type RecipientKeySource,
  type SourceDecryptOptions,
  type SourceDecryptResult
} from './source'

/** The main settings store key holding the Digital ID records (STORE_IDS in the feature's types). */
export const DIGITAL_ID_RECORDS_KEY = 'digital-signatures:ids'

export const DIGITAL_ID_PREFIX = 'digital-id:'

export interface DigitalIdSourceOptions {
  /** The Digital ID records (main settings store, 'digital-signatures:ids'); anything else is ignored. */
  records: () => unknown
  /** Saved passwords (src/main/passwords/). */
  passwords: () => SavedPasswordStore
  /**
   * Whether saved passwords may be used and saved now: the machine policy and the person's
   * "Remember passwords" preference. Must not touch the keyring (the store checks that itself
   * when it decrypts or saves).
   */
  remembering: () => boolean
  /** Reads a Digital ID file. */
  readFile?: (path: string) => Promise<Uint8Array>
  now?: () => number
}

export interface DigitalIdSource extends RecipientKeySource {
  readonly kind: 'digital-id'
  /** How many usable Digital IDs are listed. */
  count(): number
}

/**
 * The fields of a Digital ID record (DigitalIdRecord in src/features/digital-signatures/types.ts,
 * which the main process build does not include) that this source reads.
 */
interface IdRecord {
  /** SHA-256 fingerprint of the certificate, uppercase hex. */
  id: string
  /** The .p12/.pfx file. */
  path: string
  name?: string
  /** Base64 DER certificate. */
  certificate: string
}

interface DigitalId {
  rec: IdRecord
  cert: Certificate
  /** SHA-256 of the certificate, uppercase hex (the record id). */
  sha256: string
  label: string
}

interface Hit {
  envelope: number
  recipient: EnvelopeRecipient
  parsed: ParsedEnvelope
}

const bin = (b: Uint8Array) => forge.util.binary.raw.encode(b)
const unbin = (s: string) => new Uint8Array(forge.util.binary.raw.decode(s))

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex').toUpperCase()

function keyTypeOf(cert: Certificate): CertKeyCandidate['keyType'] {
  return cert.publicKey.type === 'RSA' ? 'rsa' : cert.publicKey.type === 'EC' ? 'ec' : 'other'
}

function textOf(cert: Certificate, which: 'subject' | 'issuer'): string {
  try {
    return nameText(cert[which].raw)
  } catch {
    return cert[which].text
  }
}

/** The first recipient naming `cert`, key transport preferred. Damaged envelopes are skipped. */
function findRecipient(envelopes: (ParsedEnvelope | null)[], cert: Certificate): Hit | null {
  let fallback: Hit | null = null
  for (let e = 0; e < envelopes.length; e++) {
    const parsed = envelopes[e]
    if (!parsed) continue
    for (const recipient of parsed.recipientInfos) {
      if (!recipientMatches(recipient.rid, cert)) continue
      if (recipient.kind === 'ktri') return { envelope: e, recipient, parsed }
      fallback ??= { envelope: e, recipient, parsed }
    }
  }
  return fallback
}

function parseAll(blobs: Uint8Array[]): (ParsedEnvelope | null)[] {
  return blobs.map((b) => {
    try {
      return parseEnvelope(b)
    } catch {
      return null
    }
  })
}

const unsupported = (what: string) => new CertKeyError('UNSUPPORTED', what)

/** The OAEP options node-forge takes, or null for an unknown hash. */
function forgeOaep(
  params: Uint8Array | null
): { md: forge.md.MessageDigest; mgf1: { md: forge.md.MessageDigest }; label?: string } | null {
  let p: ReturnType<typeof oaepParams>
  try {
    p = oaepParams(params)
  } catch {
    return null
  }
  if (!p) return null
  const md = (name: string) => {
    switch (name) {
      case 'sha1':
        return forge.md.sha1.create()
      case 'sha256':
        return forge.md.sha256.create()
      case 'sha384':
        return forge.md.sha384.create()
      default:
        return forge.md.sha512.create()
    }
  }
  return { md: md(p.hash), mgf1: { md: md(p.mgf1Hash) }, ...(p.label.length ? { label: bin(p.label) } : {}) }
}

/** Checks that the recipient can be opened here, before asking for a password. */
function checkAlgorithms(hit: Hit): {
  cipher: ContentCipher
  scheme: 'RSAES-PKCS1-V1_5' | 'RSA-OAEP'
  oaep: ReturnType<typeof forgeOaep>
} {
  if (hit.recipient.kind === 'kari')
    throw unsupported(
      'This document is encrypted for an elliptic curve (EC) certificate. Fartcrobat can only open documents encrypted for RSA certificates.'
    )
  if (hit.recipient.kind !== 'ktri')
    throw unsupported('This document uses a kind of certificate encryption that Fartcrobat does not support.')
  let cipher: ContentCipher | null = null
  try {
    cipher = contentCipher(hit.parsed.contentEncryption)
  } catch {
    cipher = null
  }
  if (!cipher)
    throw unsupported('This document is encrypted with an algorithm that Fartcrobat does not support.')
  const oid = hit.recipient.keyEncryption.oid
  if (oid === ENVELOPE_OID.rsaEncryption) return { cipher, scheme: 'RSAES-PKCS1-V1_5', oaep: null }
  if (oid === ENVELOPE_OID.rsaesOaep) {
    const oaep = forgeOaep(hit.recipient.keyEncryption.params)
    if (oaep) return { cipher, scheme: 'RSA-OAEP', oaep }
  }
  throw unsupported('This document is encrypted with an algorithm that Fartcrobat does not support.')
}

function decryptContent(c: ContentCipher, key: Uint8Array, data: Uint8Array): Uint8Array {
  const fail = () =>
    new CertKeyError('ERROR', 'This Digital ID could not open the document. The document may be damaged.')
  if (c.keyLength !== null && key.length !== c.keyLength) throw fail()
  try {
    if (c.name === 'aes-128-cbc' || c.name === 'aes-192-cbc' || c.name === 'aes-256-cbc') {
      const d = createDecipheriv(c.name, key, c.iv)
      return new Uint8Array(Buffer.concat([d.update(data), d.final()]))
    }
    if (c.name === 'des-ede3-cbc') {
      const d = forge.cipher.createDecipher('3DES-CBC', bin(key))
      d.start({ iv: bin(c.iv) })
      d.update(forge.util.createBuffer(bin(data)))
      if (!d.finish()) throw fail()
      return unbin(d.output.getBytes())
    }
    if (!key.length || key.length > 128) throw fail()
    const d = forge.rc2.createDecryptionCipher(bin(key), c.effectiveBits)
    d.start(bin(c.iv))
    d.update(forge.util.createBuffer(bin(data)))
    if (!d.finish()) throw fail()
    return unbin(d.output.getBytes())
  } catch (err) {
    if (err instanceof CertKeyError) throw err
    throw fail()
  }
}

export function createDigitalIdSource(o: DigitalIdSourceOptions): DigitalIdSource {
  const read = o.readFile ?? (async (path: string) => new Uint8Array(await readFile(path)))
  const now = o.now ?? Date.now
  // Parsed certificates by their base64, so probing does not parse every certificate every time.
  const cache = new Map<string, { cert: Certificate; sha256: string } | null>()

  function ids(): DigitalId[] {
    const raw = o.records()
    if (!Array.isArray(raw)) return []
    const out: DigitalId[] = []
    const seen = new Set<string>()
    for (const r of raw as Partial<IdRecord>[]) {
      if (
        !r ||
        typeof r !== 'object' ||
        typeof r.id !== 'string' ||
        typeof r.path !== 'string' ||
        typeof r.certificate !== 'string'
      )
        continue
      let parsed = cache.get(r.certificate)
      if (parsed === undefined) {
        try {
          const der = fromBase64(r.certificate)
          parsed = { cert: parseCertificate(der), sha256: sha256Hex(der) }
        } catch {
          parsed = null
        }
        if (cache.size > 200) cache.clear()
        cache.set(r.certificate, parsed)
      }
      // A record whose id is not its certificate's fingerprint is not trusted (its saved password
      // would be looked up under another key).
      if (!parsed || parsed.sha256 !== r.id.toUpperCase() || seen.has(parsed.sha256)) continue
      seen.add(parsed.sha256)
      const rec = r as IdRecord
      const label = (typeof rec.name === 'string' && rec.name.trim()) || displayName(parsed.cert.subject)
      out.push({ rec, cert: parsed.cert, sha256: parsed.sha256, label })
    }
    return out
  }

  const candidateId = (sha256: string) => DIGITAL_ID_PREFIX + sha256

  async function passwordSaved(id: DigitalId): Promise<boolean> {
    if (!o.remembering()) return false
    try {
      const info = await o.passwords().savedFor([digitalIdKey(id.sha256)])
      return !!info && !info.unreadable
    } catch {
      return false
    }
  }

  function viaOf(id: DigitalId, extra: Partial<CertKeyVia> = {}): CertKeyVia {
    return {
      source: 'digital-id',
      label: id.label,
      subject: textOf(id.cert, 'subject'),
      fingerprint: id.sha256,
      hardware: false,
      ...extra
    }
  }

  /** Opens the .p12 with the password; maps its failures. */
  function openId(id: DigitalId, bytes: Uint8Array, password: string): ParsedDigitalId {
    try {
      return parseDigitalId(bytes, password)
    } catch (err) {
      if (err instanceof WrongPasswordError) throw err
      if (err instanceof DigitalIdError)
        throw new CertKeyError(
          'ID_UNAVAILABLE',
          `The Digital ID “${id.label}” could not be read. Remove it in Preferences > Digital IDs and add it again.`
        )
      throw new CertKeyError('ERROR', `The Digital ID “${id.label}” could not be used.`)
    }
  }

  return {
    kind: 'digital-id',

    count: () => ids().length,

    async probe(blobs) {
      const envelopes = parseAll(blobs)
      if (!envelopes.some(Boolean)) return []
      const out: CertKeyCandidate[] = []
      for (const id of ids()) {
        const hit = findRecipient(envelopes, id.cert)
        if (!hit) continue
        const saved = await passwordSaved(id)
        out.push({
          id: candidateId(id.sha256),
          source: 'digital-id',
          label: id.label,
          subject: textOf(id.cert, 'subject'),
          issuer: textOf(id.cert, 'issuer'),
          fingerprint: id.sha256,
          envelope: hit.envelope,
          index: hit.recipient.index,
          needs: 'password',
          ...(saved ? { passwordSaved: true } : {}),
          hardware: false,
          keyType: keyTypeOf(id.cert),
          ...(id.cert.notAfter.getTime() < now() ? { expired: true } : {})
        })
      }
      return out
    },

    async decrypt(blobs, candidate, opts: SourceDecryptOptions): Promise<SourceDecryptResult> {
      const wanted = /^digital-id:([0-9a-fA-F]{64})$/.exec(candidate.id)?.[1].toUpperCase()
      const id = wanted ? ids().find((x) => x.sha256 === wanted) : undefined
      if (!id)
        throw new CertKeyError(
          'NO_MATCHING_CERT',
          'This Digital ID is no longer listed in Preferences > Digital IDs.'
        )
      const hit = findRecipient(parseAll(blobs), id.cert)
      if (!hit)
        throw new CertKeyError(
          'NO_MATCHING_CERT',
          `The document is not encrypted for the Digital ID “${id.label}”.`
        )
      if (keyTypeOf(id.cert) !== 'rsa')
        throw unsupported(
          'This document is encrypted for an elliptic curve (EC) certificate. Fartcrobat can only open documents encrypted for RSA certificates.'
        )
      const algs = checkAlgorithms(hit)

      let bytes: Uint8Array
      try {
        bytes = await read(id.rec.path)
      } catch {
        throw new CertKeyError(
          'ID_UNAVAILABLE',
          `The file of the Digital ID “${id.label}” could not be found. Remove it in Preferences > Digital IDs and add it again.`
        )
      }

      const key = digitalIdKey(id.sha256)
      const typed = typeof opts.password === 'string' ? opts.password : null
      let saved: { ref: string; password: string } | null = null
      if (typed === null) {
        if (o.remembering()) {
          const found = await o
            .passwords()
            .find([key])
            .catch(() => [])
          if (found.length) saved = { ref: found[0].ref, password: found[0].password }
        }
        if (!saved)
          throw new CertKeyError('PASSWORD_NEEDED', `Enter the password of the Digital ID “${id.label}”.`)
      }

      let p12: ParsedDigitalId
      try {
        p12 = openId(id, bytes, typed ?? saved!.password)
      } catch (err) {
        if (!(err instanceof WrongPasswordError)) throw err
        if (saved) {
          await o
            .passwords()
            .forgetKeys([key])
            .catch(() => 0)
          throw new CertKeyError(
            'PASSWORD_NEEDED',
            `The password saved for the Digital ID “${id.label}” no longer works, so it was forgotten. Enter the password.`,
            { savedStale: true }
          )
        }
        throw new CertKeyError('WRONG_PASSWORD', `The password of the Digital ID “${id.label}” is incorrect.`)
      }

      let content: Uint8Array
      try {
        if (!bytesEqual(p12.signer.der, id.cert.der))
          throw new CertKeyError(
            'NO_MATCHING_CERT',
            `The file of the Digital ID “${id.label}” now holds another certificate. Remove it in Preferences > Digital IDs and add it again.`
          )
        let contentKey: Uint8Array
        try {
          const priv = forge.pki.privateKeyFromAsn1(
            forge.asn1.fromDer(bin(p12.pkcs8))
          ) as forge.pki.rsa.PrivateKey
          contentKey = unbin(
            priv.decrypt(bin(hit.recipient.encryptedKey), algs.scheme, algs.oaep ?? undefined)
          )
        } catch {
          throw new CertKeyError(
            'ERROR',
            'This Digital ID could not open the document. The document may be damaged.'
          )
        }
        try {
          content = decryptContent(algs.cipher, contentKey, hit.parsed.encryptedContent)
        } finally {
          contentKey.fill(0)
        }
      } finally {
        p12.pkcs8.fill(0)
      }

      const extra: Partial<CertKeyVia> = {}
      if (saved) {
        extra.savedPassword = true
        await o
          .passwords()
          .used(saved.ref, [key])
          .catch(() => {})
      } else if (opts.remember && typed && o.remembering()) {
        const ref = await o
          .passwords()
          .remember({ kind: 'digital-id', keys: [key], label: id.label, password: typed })
          .catch(() => null)
        if (ref) extra.remembered = true
      }
      return { envelope: hit.envelope, content, via: viaOf(id, extra) }
    }
  }
}
