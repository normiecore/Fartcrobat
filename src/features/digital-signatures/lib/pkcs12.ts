/**
 * PKCS#12 (.pfx/.p12) reading and writing with node-forge. Keys are returned as PKCS#8 DER so they
 * can be imported into WebCrypto (RSA and ECDSA).
 */
import forge from 'node-forge'
import { bytesEqual, contentOf, isContext, parseAsn1, readBigInt, readBitString } from './asn1'
import { privateKeyAlg, type KeyAlg } from './crypto'
import { couldHaveIssued, isSelfIssued, parseCertificate, type Certificate } from './x509'

export class WrongPasswordError extends Error {
  constructor() {
    super('The password is incorrect.')
    this.name = 'WrongPasswordError'
  }
}

export class DigitalIdError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DigitalIdError'
  }
}

export interface ParsedDigitalId {
  /** PKCS#8 PrivateKeyInfo, DER. */
  pkcs8: Uint8Array
  keyAlg: KeyAlg
  /** Signer certificate first, then its issuers. */
  chain: Uint8Array[]
  signer: Certificate
}

const toBinary = (b: Uint8Array) => forge.util.binary.raw.encode(b)
const fromBinary = (s: string) => new Uint8Array(forge.util.binary.raw.decode(s))
const asnToDer = (a: forge.asn1.Asn1) => fromBinary(forge.asn1.toDer(a).getBytes())

function hasNonAscii(s: string) {
  return /[^\x20-\x7e]/.test(s)
}

function decode(bytes: Uint8Array): forge.asn1.Asn1 {
  try {
    return (forge.asn1.fromDer as any)(toBinary(bytes), { strict: false, parseAllBytes: false })
  } catch {
    throw new DigitalIdError('This file is not a valid Digital ID (.pfx or .p12) file.')
  }
}

function isPasswordError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err)
  return /password|MAC could not be verified|Unable to decrypt|decrypt/i.test(msg)
}

/**
 * Opens the PFX structure. `utf8` re-encodes the password as UTF-8 bytes for the key decryption
 * (PBES2 uses the UTF-8 bytes of the password while the MAC uses UTF-16; forge feeds the same
 * string to both). The MAC is checked with the original password first in that case.
 */
function openPfx(bytes: Uint8Array, password: string, utf8 = false): any {
  const asn = decode(bytes)
  try {
    if (!utf8) return forge.pkcs12.pkcs12FromAsn1(asn, false, password)
    const kids = asn.value as forge.asn1.Asn1[]
    if (kids.length > 2) {
      // verify the MAC (throws on a wrong password) by parsing once with the original password
      try {
        forge.pkcs12.pkcs12FromAsn1(asn, false, password)
      } catch (err) {
        if (/MAC could not be verified/i.test(String((err as Error)?.message))) throw err
      }
    }
    const noMac = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SEQUENCE, true, kids.slice(0, 2))
    return forge.pkcs12.pkcs12FromAsn1(noMac, false, forge.util.encodeUtf8(password))
  } catch (err) {
    if (isPasswordError(err)) throw new WrongPasswordError()
    throw new DigitalIdError(`This Digital ID file could not be read: ${(err as Error).message}`)
  }
}

interface KeyEntry {
  pkcs8: Uint8Array
  localKeyId: string | null
}

interface CertEntry {
  der: Uint8Array
  cert: Certificate
  localKeyId: string | null
}

function localKeyIdOf(bag: any): string | null {
  const v = bag?.attributes?.localKeyId?.[0]
  return typeof v === 'string' ? v : null
}

/** Whether a PKCS#8 key belongs to the certificate's public key. */
export function keyMatchesCertificate(pkcs8: Uint8Array, cert: Certificate): boolean {
  try {
    const root = parseAsn1(pkcs8)
    const inner = parseAsn1(contentOf(root.children[2]))
    if (cert.publicKey.type === 'RSA' || cert.publicKey.type === 'RSA-PSS') {
      return readBigInt(inner.children[1]) === cert.publicKey.modulus
    }
    if (cert.publicKey.type === 'EC') {
      const pub = inner.children.find((c) => isContext(c, 1))
      if (!pub) return false
      return bytesEqual(readBitString(pub.children[0]).bytes, cert.publicKey.point ?? new Uint8Array())
    }
  } catch {}
  return false
}

/** Opens a .pfx/.p12 file. Throws WrongPasswordError when the password is wrong. */
/** Opens a .pfx/.p12 file. Throws WrongPasswordError when the password is wrong. */
export function parseDigitalId(bytes: Uint8Array, password: string): ParsedDigitalId {
  const attempts = hasNonAscii(password) ? [false, true] : [false]
  let lastError: unknown = null
  for (const utf8 of attempts) {
    try {
      const parsed = extract(openPfx(bytes, password, utf8))
      // With a mis-encoded password the key may decrypt to garbage; it then matches no certificate.
      if (parsed.matched || attempts.length === 1 || utf8) return parsed.id
      lastError = new WrongPasswordError()
    } catch (err) {
      lastError = err
    }
  }
  if (lastError instanceof DigitalIdError || lastError instanceof WrongPasswordError) throw lastError
  throw new WrongPasswordError()
}

function extract(pfx: any): { id: ParsedDigitalId; matched: boolean } {
  const keys: KeyEntry[] = []
  const certs: CertEntry[] = []
  for (const sc of pfx.safeContents as { safeBags: any[] }[]) {
    for (const bag of sc.safeBags) {
      if (bag.type === forge.pki.oids.pkcs8ShroudedKeyBag || bag.type === forge.pki.oids.keyBag) {
        const asn = bag.key ? forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(bag.key)) : bag.asn1
        if (asn) keys.push({ pkcs8: asnToDer(asn), localKeyId: localKeyIdOf(bag) })
      } else if (bag.type === forge.pki.oids.certBag) {
        const asn = bag.cert ? forge.pki.certificateToAsn1(bag.cert) : bag.asn1
        if (!asn) continue
        const der = asnToDer(asn)
        try {
          certs.push({ der, cert: parseCertificate(der), localKeyId: localKeyIdOf(bag) })
        } catch {}
      }
    }
  }
  if (!keys.length) throw new DigitalIdError('This file does not contain a private key, so it cannot be used to sign.')
  if (!certs.length) throw new DigitalIdError('This file does not contain a certificate.')
  // Pair the key with its certificate by public key (local key ids can be missing or wrong).
  let key = keys[0]
  let signer: CertEntry | undefined
  let matched = false
  for (const k of keys) {
    signer = certs.find((c) => keyMatchesCertificate(k.pkcs8, c.cert))
    if (signer) {
      key = k
      matched = true
      break
    }
  }
  if (!signer) {
    signer = certs.find((c) => keys.some((k) => k.localKeyId && c.localKeyId === k.localKeyId))
    if (signer) key = keys.find((k) => k.localKeyId === signer!.localKeyId) ?? key
  }
  if (!signer) {
    const issuers = new Set(certs.filter((c) => certs.some((o) => o !== c && couldHaveIssued(c.cert, o.cert))))
    signer = certs.find((c) => !issuers.has(c)) ?? certs[0]
  }
  let keyAlg: KeyAlg
  try {
    keyAlg = privateKeyAlg(key.pkcs8)
  } catch (err) {
    if (!matched) throw new WrongPasswordError()
    throw err
  }
  const chain: Uint8Array[] = [signer.der]
  let cur = signer.cert
  for (let i = 0; i < 8 && !isSelfIssued(cur); i++) {
    const next = certs.find((c) => c.cert !== cur && couldHaveIssued(c.cert, cur))
    if (!next || chain.some((d) => bytesEqual(d, next.der))) break
    chain.push(next.der)
    cur = next.cert
  }
  return { id: { pkcs8: key.pkcs8, keyAlg, chain, signer: signer.cert }, matched }
}

/** Reads only the certificate (for listing an ID); still needs the password for most files. */
export function readDigitalIdCertificate(bytes: Uint8Array, password: string): Certificate {
  return parseDigitalId(bytes, password).signer
}

const ITERATIONS = 10000

/**
 * Creates a password-protected PKCS#12 file: the key is encrypted with AES-256 (PBES2,
 * PBKDF2-HMAC-SHA256), integrity is protected with an HMAC-SHA256 MAC.
 */
export function createPkcs12(pkcs8: Uint8Array, certs: Uint8Array[], password: string, friendlyName?: string): Uint8Array {
  const { asn1, pki } = forge
  const create = asn1.create.bind(asn1)
  const U = asn1.Class.UNIVERSAL
  const T = asn1.Type
  const C = asn1.Class.CONTEXT_SPECIFIC
  const oidDer = (oid: string) => asn1.oidToDer(oid).getBytes()
  const md = forge.md.sha1.create()
  md.update(toBinary(certs[0]))
  const localKeyId = md.digest().getBytes()
  const attrs: forge.asn1.Asn1[] = [
    create(U, T.SEQUENCE, true, [
      create(U, T.OID, false, oidDer(pki.oids.localKeyId)),
      create(U, T.SET, true, [create(U, T.OCTETSTRING, false, localKeyId)])
    ])
  ]
  if (friendlyName) {
    attrs.push(
      create(U, T.SEQUENCE, true, [
        create(U, T.OID, false, oidDer(pki.oids.friendlyName)),
        create(U, T.SET, true, [create(U, T.BMPSTRING, false, friendlyName)])
      ])
    )
  }
  const bagAttrs = () => create(U, T.SET, true, attrs)
  const certBags = certs.map((der, i) =>
    create(U, T.SEQUENCE, true, [
      create(U, T.OID, false, oidDer(pki.oids.certBag)),
      create(C, 0, true, [
        create(U, T.SEQUENCE, true, [
          create(U, T.OID, false, oidDer(pki.oids.x509Certificate)),
          create(C, 0, true, [create(U, T.OCTETSTRING, false, toBinary(der))])
        ])
      ]),
      ...(i === 0 ? [bagAttrs()] : [])
    ])
  )
  const keyInfo = (asn1.fromDer as any)(toBinary(pkcs8), { strict: false })
  const encryptedKey = pki.encryptPrivateKeyInfo(keyInfo, forge.util.encodeUtf8(password), {
    algorithm: 'aes256',
    count: ITERATIONS,
    saltSize: 16,
    prfAlgorithm: 'sha256'
  } as any)
  const keyBag = create(U, T.SEQUENCE, true, [
    create(U, T.OID, false, oidDer(pki.oids.pkcs8ShroudedKeyBag)),
    create(C, 0, true, [encryptedKey]),
    bagAttrs()
  ])
  const dataContentInfo = (inner: forge.asn1.Asn1) =>
    create(U, T.SEQUENCE, true, [
      create(U, T.OID, false, oidDer(pki.oids.data)),
      create(C, 0, true, [create(U, T.OCTETSTRING, false, asn1.toDer(inner).getBytes())])
    ])
  const safe = create(U, T.SEQUENCE, true, [
    dataContentInfo(create(U, T.SEQUENCE, true, certBags)),
    dataContentInfo(create(U, T.SEQUENCE, true, [keyBag]))
  ])
  const safeDer = asn1.toDer(safe).getBytes()
  const macSalt = forge.random.getBytesSync(16)
  const macKey = forge.pkcs12.generateKey(password, forge.util.createBuffer(macSalt), 3, ITERATIONS, 32, forge.md.sha256.create())
  const hmac = forge.hmac.create()
  hmac.start(forge.md.sha256.create() as any, macKey.getBytes())
  hmac.update(safeDer)
  const macValue = hmac.digest().getBytes()
  const macData = create(U, T.SEQUENCE, true, [
    create(U, T.SEQUENCE, true, [
      create(U, T.SEQUENCE, true, [create(U, T.OID, false, oidDer(pki.oids.sha256)), create(U, T.NULL, false, '')]),
      create(U, T.OCTETSTRING, false, macValue)
    ]),
    create(U, T.OCTETSTRING, false, macSalt),
    create(U, T.INTEGER, false, asn1.integerToDer(ITERATIONS).getBytes())
  ])
  const pfx = create(U, T.SEQUENCE, true, [
    create(U, T.INTEGER, false, asn1.integerToDer(3).getBytes()),
    create(U, T.SEQUENCE, true, [
      create(U, T.OID, false, oidDer(pki.oids.data)),
      create(C, 0, true, [create(U, T.OCTETSTRING, false, safeDer)])
    ]),
    macData
  ])
  return asnToDer(pfx)
}
