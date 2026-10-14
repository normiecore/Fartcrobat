// PDF encryption primitives on WebCrypto, usable in the engine worker, the renderer and Node.
// Proposed home: src/engine/crypt/pdfCrypto.ts

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

export function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export type ShaBits = 256 | 384 | 512

export async function sha(bits: ShaBits, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const name = bits === 256 ? 'SHA-256' : bits === 384 ? 'SHA-384' : 'SHA-512'
  return new Uint8Array(await crypto.subtle.digest(name, data as Uint8Array<ArrayBuffer>))
}

function importAes(key: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', key as Uint8Array<ArrayBuffer>, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
}

/** AES-CBC with PKCS#7 padding; the key length selects AES-128/192/256. */
export async function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await importAes(key)
  return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv as Uint8Array<ArrayBuffer> }, k, data as Uint8Array<ArrayBuffer>))
}

export async function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const k = await importAes(key)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as Uint8Array<ArrayBuffer> }, k, data as Uint8Array<ArrayBuffer>))
}

/**
 * AES-CBC without padding (whole blocks only). WebCrypto always pads; in CBC the first n
 * ciphertext blocks do not depend on later input, so the padding block is simply dropped.
 */
export async function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (data.length % 16) throw new Error('AES without padding needs whole blocks')
  return (await aesCbcEncrypt(key, iv, data)).subarray(0, data.length)
}

/** AES-ECB on whole blocks (CBC with a zero IV, one block at a time). */
export async function aesEcbEncrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i += 16) out.set(await aesCbcEncryptNoPad(key, new Uint8Array(16), data.subarray(i, i + 16)), i)
  return out
}

export type PdfEncryptor = (data: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>

/**
 * String and stream encryption for AESV3 (ISO 32000-2 7.6.3): random 16-byte IV, then AES-256-CBC
 * with PKCS#7 padding. With V5 every object uses the file key itself. The key is imported once.
 */
export async function pdfAesEncryptor(fileKey: Uint8Array): Promise<PdfEncryptor> {
  const key = await importAes(fileKey)
  return async (data) => {
    const iv = randomBytes(16)
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, data as Uint8Array<ArrayBuffer>))
    return concat([iv, ct])
  }
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export function fromHex(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/\s+/g, '')
  const out = new Uint8Array(clean.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}

export function latin1(s: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

export function toLatin1(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return s
}
