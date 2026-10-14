// The Standard security handler, revision 6 (AES-256, ISO 32000-2 7.6.4.3/4), written for a file
// key WE choose. MuPDF only ever generates random file keys, but a V5 Standard dictionary simply
// wraps the 32-byte file key in /UE and /OE under the password, so any key can be wrapped:
//   algorithm 2.B  password hash (SHA-256/384/512 + AES-128 rounds)
//   algorithm 8    /U and /UE
//   algorithm 9    /O and /OE
//   algorithm 10   /Perms
import { aesCbcEncryptNoPad, aesEcbEncrypt, concat, hex, randomBytes, sha } from './crypto.mjs'

const utf8 = (s) => new TextEncoder().encode(s)

/** Algorithm 2.B. `udata` is the 48-byte /U for owner hashes, empty for user hashes. */
export async function hashR6(password, salt, udata = new Uint8Array(0)) {
  let k = await sha(256, password, salt, udata)
  for (let round = 0; ; round++) {
    const block = concat([password, k, udata])
    const k1 = new Uint8Array(block.length * 64)
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length)
    const e = await aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1)
    let mod = 0
    for (let i = 0; i < 16; i++) mod += e[i]
    k = await sha([256, 384, 512][mod % 3], e)
    if (round >= 63 && e[e.length - 1] <= round - 31) break
  }
  return k.subarray(0, 32)
}

/**
 * Builds a Standard V5/R6 /Encrypt dictionary (PDF source text) that unlocks `fileKey` with
 * `password` (used as both user and owner password). Only for a password nobody types: it is
 * not SASLprep'd, so keep it ASCII.
 */
export async function standardR6Dict(fileKey, password, { permissions = -4, encryptMetadata = true } = {}) {
  const pw = utf8(password).subarray(0, 127)
  const [uvs, uks, ovs, oks] = [8, 8, 8, 8].map(randomBytes)
  const zeroIv = new Uint8Array(16)
  const U = concat([await hashR6(pw, uvs), uvs, uks])
  const UE = await aesCbcEncryptNoPad(await hashR6(pw, uks), zeroIv, fileKey)
  const O = concat([await hashR6(pw, ovs, U), ovs, oks])
  const OE = await aesCbcEncryptNoPad(await hashR6(pw, oks, U), zeroIv, fileKey)
  const perms = new Uint8Array(16)
  new DataView(perms.buffer).setInt32(0, permissions | 0, true)
  perms.set([0xff, 0xff, 0xff, 0xff], 4)
  perms[8] = encryptMetadata ? 0x54 : 0x46 // 'T' / 'F'
  perms.set([0x61, 0x64, 0x62], 9) // 'adb'
  perms.set(randomBytes(4), 12)
  const Perms = await aesEcbEncrypt(fileKey, perms)
  return (
    `<</Filter/Standard/V 5/R 6/Length 256/CF<</StdCF<</AuthEvent/DocOpen/CFM/AESV3/Length 32>>>>` +
    `/StmF/StdCF/StrF/StdCF/O<${hex(O)}>/U<${hex(U)}>/OE<${hex(OE)}>/UE<${hex(UE)}>` +
    `/P ${permissions | 0}/Perms<${hex(Perms)}>${encryptMetadata ? '' : '/EncryptMetadata false'}>>`
  )
}

/** A random password nobody types: 24 base64url characters (144 bits). */
export function oneTimePassword() {
  return btoa(String.fromCharCode(...randomBytes(18))).replace(/\+/g, '-').replace(/\//g, '_')
}
