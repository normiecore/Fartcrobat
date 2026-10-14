// Standard security handler revision 6 (AES-256) for a file key we choose: wraps `fileKey` in
// /UE and /OE under a one-time password so MuPDF can open a certificate-encrypted file (the bridge)
// or hold a key of ours (approach A). Algorithms 2.B, 8, 9 and 10 of ISO 32000-2.
// Proposed home: src/engine/crypt/standardR6.ts
import { aesCbcEncryptNoPad, aesEcbEncrypt, concat, randomBytes, sha, toHex, type ShaBits } from './pdfCrypto'

/** Algorithm 2.B. `udata` is the 48-byte /U for owner hashes, empty for user hashes. */
export async function hashR6(password: Uint8Array, salt: Uint8Array, udata: Uint8Array = new Uint8Array(0)): Promise<Uint8Array> {
  let k = await sha(256, concat([password, salt, udata]))
  for (let round = 0; ; round++) {
    const block = concat([password, k, udata])
    const k1 = new Uint8Array(block.length * 64)
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length)
    const e = await aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1)
    let sum = 0
    for (let i = 0; i < 16; i++) sum += e[i]
    k = await sha(([256, 384, 512] as ShaBits[])[sum % 3], e)
    if (round >= 63 && e[e.length - 1] <= round - 31) break
  }
  return k.subarray(0, 32)
}

/** A random password nobody types (144 bits, base64url). */
export function oneTimePassword(): string {
  return btoa(String.fromCharCode(...randomBytes(18))).replace(/\+/g, '-').replace(/\//g, '_')
}

/**
 * /Encrypt dictionary (PDF source) of a Standard V5/R6 handler that opens `fileKey` with
 * `password` (user and owner). The password is not SASLprep'd: use oneTimePassword().
 */
export async function standardR6Dict(
  fileKey: Uint8Array,
  password: string,
  { permissions = -4, encryptMetadata = true }: { permissions?: number; encryptMetadata?: boolean } = {}
): Promise<string> {
  const pw = new TextEncoder().encode(password).subarray(0, 127)
  const [uvs, uks, ovs, oks] = [8, 8, 8, 8].map(randomBytes)
  const zeroIv = new Uint8Array(16)
  const U = concat([await hashR6(pw, uvs), uvs, uks])
  const UE = await aesCbcEncryptNoPad(await hashR6(pw, uks), zeroIv, fileKey)
  const O = concat([await hashR6(pw, ovs, U), ovs, oks])
  const OE = await aesCbcEncryptNoPad(await hashR6(pw, oks, U), zeroIv, fileKey)
  const perms = new Uint8Array(16)
  new DataView(perms.buffer).setInt32(0, permissions | 0, true)
  perms.set([0xff, 0xff, 0xff, 0xff], 4)
  perms[8] = encryptMetadata ? 0x54 : 0x46
  perms.set([0x61, 0x64, 0x62], 9)
  perms.set(randomBytes(4), 12)
  const Perms = await aesEcbEncrypt(fileKey, perms)
  return (
    `<</Filter/Standard/V 5/R 6/Length 256/CF<</StdCF<</AuthEvent/DocOpen/CFM/AESV3/Length 32>>>>` +
    `/StmF/StdCF/StrF/StdCF/O<${toHex(O)}>/U<${toHex(U)}>/OE<${toHex(OE)}>/UE<${toHex(UE)}>` +
    `/P ${permissions | 0}/Perms<${toHex(Perms)}>${encryptMetadata ? '' : '/EncryptMetadata false'}>>`
  )
}
