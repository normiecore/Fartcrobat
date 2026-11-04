// Cryptographic primitives for PDF encryption, synchronous so that saveDocument stays synchronous:
// AES and the SHA-2 family from @noble/ciphers and @noble/hashes, MD5 and SHA-1 (needed by the
// older V2/V4 handlers), our own RC4, and byte helpers. Runs in the engine worker and in Node.
import { cbc, ecb } from '@noble/ciphers/aes.js'
import { md5 as nobleMd5, sha1 as nobleSha1 } from '@noble/hashes/legacy.js'
import { sha256 as nobleSha256, sha384 as nobleSha384, sha512 as nobleSha512 } from '@noble/hashes/sha2.js'

export const sha256 = (data: Uint8Array): Uint8Array => nobleSha256(data)
export const sha384 = (data: Uint8Array): Uint8Array => nobleSha384(data)
export const sha512 = (data: Uint8Array): Uint8Array => nobleSha512(data)
/** Only for the V2/V4 public-key file key (ISO 32000-2, 7.6.5.3). */
export const sha1 = (data: Uint8Array): Uint8Array => nobleSha1(data)
/** Only for V2/V4 per-object keys (ISO 32000-2, algorithm 1). */
export const md5 = (data: Uint8Array): Uint8Array => nobleMd5(data)

/** RC4 (the V2 crypt filter). Encrypting and decrypting are the same operation. */
export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255
    const t = s[i]
    s[i] = s[j]
    s[j] = t
  }
  const out = new Uint8Array(data.length)
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255
    j = (j + s[i]) & 255
    const t = s[i]
    s[i] = s[j]
    s[j] = t
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255]
  }
  return out
}

/** AES-CBC with PKCS#7 padding; the key length (16, 24 or 32 bytes) selects AES-128/192/256. */
export function aesCbcEncrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  return cbc(key, iv).encrypt(data)
}

/** AES-CBC decryption that checks and removes PKCS#7 padding (throws when it is wrong). */
export function aesCbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  return cbc(key, iv).decrypt(data)
}

/** AES-CBC without padding: whole blocks only. */
export function aesCbcEncryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16) throw new Error('AES without padding needs whole blocks')
  return cbc(key, iv, { disablePadding: true }).encrypt(data)
}

export function aesCbcDecryptNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16) throw new Error('AES without padding needs whole blocks')
  return cbc(key, iv, { disablePadding: true }).decrypt(data)
}

/** AES-ECB on whole blocks, no padding (the /Perms entry of the Standard handler). */
export function aesEcbEncrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length % 16) throw new Error('AES without padding needs whole blocks')
  return ecb(key, { disablePadding: true }).encrypt(data)
}

/** The length of `data` without its PKCS#7 padding, or -1 when the padding is not valid. */
export function pkcs7Length(data: Uint8Array): number {
  const n = data.length
  if (!n || n % 16) return -1
  const pad = data[n - 1]
  if (pad < 1 || pad > 16) return -1
  for (let i = n - pad; i < n; i++) if (data[i] !== pad) return -1
  return n - pad
}

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

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

export function fromHex(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/\s+/g, '')
  if (clean.length % 2 || /[^0-9a-f]/i.test(clean)) throw new Error('Not a hex string')
  const out = new Uint8Array(clean.length >> 1)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16)
  return out
}

/** Bytes of a string of characters 0-255 (PDF syntax is bytes; this is its usual JS form). */
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

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
