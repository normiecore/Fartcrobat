// Crypto primitives for PDF encryption, on WebCrypto only (globalThis.crypto), so the same code runs
// in Node 22, an Electron renderer and a Web Worker (the app's MuPDF engine worker).
// WebCrypto has no "no padding" switch for AES-CBC; where the PDF algorithms need unpadded output
// (whole blocks only), we encrypt with PKCS#7 padding and drop the final padding block: in CBC the
// first n blocks of ciphertext do not depend on what follows them.

const subtle = () => {
  const s = globalThis.crypto?.subtle
  if (!s) throw new Error('WebCrypto is not available')
  return s
}

export function randomBytes(n) {
  const out = new Uint8Array(n)
  globalThis.crypto.getRandomValues(out)
  return out
}

export function concat(parts) {
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

export async function sha(bits, ...parts) {
  const name = { 256: 'SHA-256', 384: 'SHA-384', 512: 'SHA-512' }[bits]
  return new Uint8Array(await subtle().digest(name, parts.length === 1 ? parts[0] : concat(parts)))
}

async function aesKey(key) {
  return subtle().importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt'])
}

/** AES-CBC with PKCS#7 padding (key length picks AES-128/192/256). */
export async function aesCbcEncrypt(key, iv, data) {
  return new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv }, await aesKey(key), data))
}

export async function aesCbcDecrypt(key, iv, data) {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-CBC', iv }, await aesKey(key), data))
}

/** AES-CBC without padding: `data` must be a whole number of 16-byte blocks. */
export async function aesCbcEncryptNoPad(key, iv, data) {
  if (data.length % 16) throw new Error('AES without padding needs whole blocks')
  const padded = await aesCbcEncrypt(key, iv, data)
  return padded.subarray(0, data.length)
}

/** AES-ECB on whole blocks (= CBC with a zero IV, block by block). */
export async function aesEcbEncrypt(key, data) {
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i += 16) {
    out.set(await aesCbcEncryptNoPad(key, new Uint8Array(16), data.subarray(i, i + 16)), i)
  }
  return out
}

/**
 * PDF AESV2/AESV3 string and stream encryption (ISO 32000-2 7.6.3): a random 16-byte IV followed by
 * AES-CBC ciphertext with PKCS#7 padding. With V5 the per-object key is the file key itself.
 */
export async function pdfAesEncrypt(fileKey, data) {
  const iv = randomBytes(16)
  return concat([iv, await aesCbcEncrypt(fileKey, iv, data)])
}

export async function pdfAesDecrypt(fileKey, data) {
  return aesCbcDecrypt(fileKey, data.subarray(0, 16), data.subarray(16))
}

/**
 * A reusable encryptor for many strings and streams: imports the key once. WebCrypto calls are
 * async, so the caller awaits each one (they are fast; the cost is per call, not per byte).
 */
export async function pdfAesEncryptor(fileKey) {
  const key = await aesKey(fileKey)
  return async (data) => {
    const iv = randomBytes(16)
    const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-CBC', iv }, key, data))
    return concat([iv, ct])
  }
}

export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
export const fromHex = (s) => new Uint8Array(s.replace(/\s+/g, '').match(/../g)?.map((h) => parseInt(h, 16)) ?? [])
export const latin1 = (s) => {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}
export const toLatin1 = (b) => {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000))
  return s
}
