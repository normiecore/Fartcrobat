/**
 * Cryptographic primitives on top of WebCrypto (available in the renderer, the engine worker and
 * Node). RSA PKCS#1 v1.5 verification is done with BigInt so that any digest in the DigestInfo is
 * accepted (WebCrypto is strict about the encoding and lacks MD5/SHA-224).
 */
import {
  Asn1Error,
  bytesEqual,
  concatBytes,
  contentOf,
  der,
  expectUniversal,
  isContext,
  isUniversal,
  parseAsn1,
  readBigInt,
  readBitString,
  readOid,
  readSmallInt,
  TAG,
  type Asn1Node
} from './asn1'
import { CURVE_NAMES, DIGEST_BY_OID, OID, SIGNATURE_DIGEST, type DigestName } from './oids'

export type KeyAlg = { type: 'RSA'; bits: number } | { type: 'EC'; curve: 'P-256' | 'P-384' | 'P-521' }

export interface PublicKeyInfo {
  type: 'RSA' | 'RSA-PSS' | 'EC' | 'Ed25519' | 'unknown'
  /** DER of the SubjectPublicKeyInfo. */
  spki: Uint8Array
  bits: number
  curve?: 'P-256' | 'P-384' | 'P-521'
  modulus?: bigint
  exponent?: bigint
  /** Raw public key bytes (EC point, Ed25519 key). */
  point?: Uint8Array
  oid: string
}

export class CryptoUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoUnsupportedError'
  }
}

export function subtle(): SubtleCrypto {
  const c = (globalThis as any).crypto as Crypto | undefined
  if (!c?.subtle) throw new CryptoUnsupportedError('Secure cryptography (WebCrypto) is not available here')
  return c.subtle
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  ;(globalThis as any).crypto.getRandomValues(out)
  return out
}

function asBuffer(b: Uint8Array): ArrayBuffer {
  return (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer) as ArrayBuffer
}

/** Hash of data (or of several parts, concatenated). */
export async function digest(name: DigestName, data: Uint8Array | Uint8Array[]): Promise<Uint8Array> {
  if (name === 'MD5' || name === 'SHA-224') throw new CryptoUnsupportedError(`The ${name} digest is not supported`)
  const bytes = Array.isArray(data) ? concatBytes(data) : data
  return new Uint8Array(await subtle().digest(name, asBuffer(bytes)))
}

// ---- keys ------------------------------------------------------------------------------------

/** Reads a SubjectPublicKeyInfo. */
export function parsePublicKey(spki: Uint8Array): PublicKeyInfo {
  const root = parseAsn1(spki)
  const algId = expectUniversal(root.children[0], TAG.SEQUENCE, 'public key algorithm')
  const oid = readOid(algId.children[0])
  const key = readBitString(expectUniversal(root.children[1], TAG.BIT_STRING, 'public key')).bytes
  const raw = spki.subarray(root.start, root.end)
  if (oid === OID.rsaEncryption || oid === OID.rsaPSS) {
    const k = parseAsn1(key)
    const modulus = readBigInt(k.children[0])
    const exponent = readBigInt(k.children[1])
    return { type: oid === OID.rsaPSS ? 'RSA-PSS' : 'RSA', spki: raw, bits: bitLength(modulus), modulus, exponent, oid }
  }
  if (oid === OID.ecPublicKey) {
    const params = algId.children[1]
    const curveOid = params && isUniversal(params, TAG.OID) ? readOid(params) : ''
    const curve = CURVE_NAMES[curveOid]
    const bits = curve === 'P-256' ? 256 : curve === 'P-384' ? 384 : curve === 'P-521' ? 521 : 0
    return { type: 'EC', spki: raw, bits, curve, point: key, oid }
  }
  if (oid === OID.ed25519) return { type: 'Ed25519', spki: raw, bits: 256, point: key, oid }
  return { type: 'unknown', spki: raw, bits: 0, oid }
}

export function describePublicKey(k: PublicKeyInfo): string {
  switch (k.type) {
    case 'RSA':
      return `RSA ${k.bits}-bit`
    case 'RSA-PSS':
      return `RSA-PSS ${k.bits}-bit`
    case 'EC':
      return k.curve ? `ECDSA ${k.curve}` : 'ECDSA (unknown curve)'
    case 'Ed25519':
      return 'Ed25519'
    default:
      return `Unknown (${k.oid})`
  }
}

/** Reads the algorithm of a PKCS#8 PrivateKeyInfo. */
export function privateKeyAlg(pkcs8: Uint8Array): KeyAlg {
  const root = parseAsn1(pkcs8)
  const algId = expectUniversal(root.children[1], TAG.SEQUENCE, 'private key algorithm')
  const oid = readOid(algId.children[0])
  if (oid === OID.rsaEncryption) {
    const inner = parseAsn1(contentOf(expectUniversal(root.children[2], TAG.OCTET_STRING, 'private key')))
    return { type: 'RSA', bits: bitLength(readBigInt(inner.children[1])) }
  }
  if (oid === OID.ecPublicKey) {
    let curveOid = algId.children[1] && isUniversal(algId.children[1], TAG.OID) ? readOid(algId.children[1]) : ''
    if (!curveOid) {
      // Curve given inside the ECPrivateKey ([0] parameters).
      const inner = parseAsn1(contentOf(root.children[2]))
      const p = inner.children.find((c) => isContext(c, 0))
      if (p?.children[0]) curveOid = readOid(p.children[0])
    }
    const curve = CURVE_NAMES[curveOid]
    if (!curve) throw new CryptoUnsupportedError('This Digital ID uses an elliptic curve that is not supported')
    return { type: 'EC', curve }
  }
  throw new CryptoUnsupportedError('This Digital ID uses a key type that is not supported (only RSA and ECDSA keys can sign)')
}

export async function importPrivateKey(pkcs8: Uint8Array, alg: KeyAlg, hash: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256'): Promise<CryptoKey> {
  const algo = alg.type === 'RSA' ? { name: 'RSASSA-PKCS1-v1_5', hash } : { name: 'ECDSA', namedCurve: alg.curve }
  try {
    return await subtle().importKey('pkcs8', asBuffer(pkcs8), algo, false, ['sign'])
  } catch (err) {
    if (alg.type === 'EC') {
      // Some exporters omit the curve from the AlgorithmIdentifier; rebuild a canonical PKCS#8.
      return subtle().importKey('pkcs8', asBuffer(normalizeEcPkcs8(pkcs8, alg.curve)), algo, false, ['sign'])
    }
    throw err
  }
}

function normalizeEcPkcs8(pkcs8: Uint8Array, curve: string): Uint8Array {
  const curveOid = Object.entries(CURVE_NAMES).find(([, c]) => c === curve)![0]
  const root = parseAsn1(pkcs8)
  return der.sequence(
    der.integer(0),
    der.sequence(der.oid(OID.ecPublicKey), der.oid(curveOid)),
    der.octetString(contentOf(root.children[2]))
  )
}

/** Signs data; ECDSA signatures are returned DER-encoded (as CMS and X.509 expect). */
export async function signBytes(key: CryptoKey, alg: KeyAlg, data: Uint8Array, hash: 'SHA-256' | 'SHA-384' | 'SHA-512' = 'SHA-256'): Promise<Uint8Array> {
  if (alg.type === 'RSA') {
    return new Uint8Array(await subtle().sign({ name: 'RSASSA-PKCS1-v1_5' }, key, asBuffer(data)))
  }
  const raw = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash }, key, asBuffer(data)))
  return ecdsaRawToDer(raw)
}

export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const n = raw.length / 2
  return der.sequence(der.integer(raw.subarray(0, n)), der.integer(raw.subarray(n)))
}

export function ecdsaDerToRaw(sig: Uint8Array, size: number): Uint8Array {
  const node = parseAsn1(sig)
  if (!isUniversal(node, TAG.SEQUENCE) || node.children.length !== 2) throw new Asn1Error('Malformed ECDSA signature')
  const out = new Uint8Array(size * 2)
  node.children.forEach((c, i) => {
    let b = contentOf(c)
    while (b.length > size && b[0] === 0) b = b.subarray(1)
    if (b.length > size) throw new Asn1Error('ECDSA signature value too long')
    out.set(b, i * size + (size - b.length))
  })
  return out
}

// ---- verification --------------------------------------------------------------------------

function bitLength(n: bigint): number {
  return n <= 0n ? 0 : n.toString(2).length
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n
  let b = base % mod
  let e = exp
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod
    e >>= 1n
    if (e > 0n) b = (b * b) % mod
  }
  return result
}

function bytesToBigInt(b: Uint8Array): bigint {
  let v = 0n
  for (const x of b) v = (v << 8n) | BigInt(x)
  return v
}

function bigIntToBytes(v: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len)
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}

/**
 * RSA PKCS#1 v1.5 signature check. Returns the digest algorithm found in the DigestInfo when the
 * signature matches `expectedDigest`, or null.
 */
export function rsaPkcs1Verify(key: PublicKeyInfo, signature: Uint8Array, expectedDigest: Uint8Array): DigestName | null {
  if (!key.modulus || !key.exponent) return null
  const k = Math.ceil(key.bits / 8)
  if (signature.length > k) return null
  const s = bytesToBigInt(signature)
  if (s >= key.modulus) return null
  const em = bigIntToBytes(modPow(s, key.exponent, key.modulus), k)
  if (em[0] !== 0 || em[1] !== 1) return null
  let i = 2
  while (i < em.length && em[i] === 0xff) i++
  if (i < 10 || em[i] !== 0) return null
  const t = em.subarray(i + 1)
  try {
    const info = parseAsn1(t)
    if (info.end !== t.length) return null
    const algOid = readOid(info.children[0].children[0])
    const value = contentOf(expectUniversal(info.children[1], TAG.OCTET_STRING, 'digest'))
    const name = DIGEST_BY_OID[algOid]
    if (!name || !bytesEqual(value, expectedDigest)) return null
    return name
  } catch {
    // adbe.x509.rsa_sha1 style: the bare digest without DigestInfo
    return bytesEqual(t, expectedDigest) ? 'SHA-1' : null
  }
}

export interface SignatureAlgorithm {
  oid: string
  /** Raw parameters element (RSA-PSS). */
  params?: Asn1Node
}

/**
 * Verifies `signature` over `data` with the public key. `digestName` is the message digest used
 * (from the CMS digestAlgorithm or implied by the signature algorithm).
 */
export async function verifySignature(
  key: PublicKeyInfo,
  alg: SignatureAlgorithm,
  digestName: DigestName,
  signature: Uint8Array,
  data: Uint8Array
): Promise<boolean> {
  const implied = SIGNATURE_DIGEST[alg.oid]
  const hashName = implied ?? digestName
  if (key.type === 'RSA' && alg.oid !== OID.rsaPSS) {
    const d = await digest(hashName, data)
    return rsaPkcs1Verify(key, signature, d) !== null
  }
  if (alg.oid === OID.rsaPSS || key.type === 'RSA-PSS') {
    const pss = readPssParams(alg.params)
    const spki = key.type === 'RSA-PSS' ? rewrapAsRsa(key) : key.spki
    const pub = await subtle().importKey('spki', asBuffer(spki), { name: 'RSA-PSS', hash: pss.hash }, false, ['verify'])
    return subtle().verify({ name: 'RSA-PSS', saltLength: pss.saltLength }, pub, asBuffer(signature), asBuffer(data))
  }
  if (key.type === 'EC') {
    if (!key.curve) throw new CryptoUnsupportedError('Unsupported elliptic curve')
    if (hashName === 'MD5' || hashName === 'SHA-224') throw new CryptoUnsupportedError(`The ${hashName} digest is not supported`)
    const size = key.curve === 'P-256' ? 32 : key.curve === 'P-384' ? 48 : 66
    const pub = await subtle().importKey('spki', asBuffer(key.spki), { name: 'ECDSA', namedCurve: key.curve }, false, ['verify'])
    let raw: Uint8Array
    try {
      raw = ecdsaDerToRaw(signature, size)
    } catch {
      raw = signature
    }
    return subtle().verify({ name: 'ECDSA', hash: hashName }, pub, asBuffer(raw), asBuffer(data))
  }
  if (key.type === 'Ed25519') {
    try {
      const pub = await subtle().importKey('spki', asBuffer(key.spki), { name: 'Ed25519' }, false, ['verify'])
      return subtle().verify({ name: 'Ed25519' }, pub, asBuffer(signature), asBuffer(data))
    } catch (err) {
      throw new CryptoUnsupportedError(`Ed25519 signatures cannot be checked here (${(err as Error).message})`)
    }
  }
  throw new CryptoUnsupportedError(`Unsupported public key type (${key.oid})`)
}

function readPssParams(params: Asn1Node | undefined): { hash: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'; saltLength: number } {
  let hash: DigestName = 'SHA-1'
  let saltLength = 20
  if (params && isUniversal(params, TAG.SEQUENCE)) {
    for (const c of params.children) {
      if (isContext(c, 0)) hash = DIGEST_BY_OID[readOid(c.children[0].children[0])] ?? hash
      else if (isContext(c, 2)) saltLength = readSmallInt(c.children[0])
    }
  }
  if (hash === 'MD5' || hash === 'SHA-224') throw new CryptoUnsupportedError(`RSA-PSS with ${hash} is not supported`)
  return { hash, saltLength }
}

function rewrapAsRsa(key: PublicKeyInfo): Uint8Array {
  const root = parseAsn1(key.spki)
  const bits = readBitString(root.children[1]).bytes
  return der.sequence(der.sequence(der.oid(OID.rsaEncryption), der.null()), der.bitString(bits))
}

/** SHA-256 and SHA-1 fingerprints as uppercase hex. */
export async function fingerprints(certDer: Uint8Array): Promise<{ sha256: string; sha1: string }> {
  const [a, b] = await Promise.all([digest('SHA-256', certDer), digest('SHA-1', certDer)])
  const hex = (x: Uint8Array) => Array.from(x, (v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()
  return { sha256: hex(a), sha1: hex(b) }
}
