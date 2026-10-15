// The Standard security handler, revision 6 (AES-256), written around a file key WE choose. A V5
// Standard dictionary only wraps the 32-byte file key in /UE and /OE under the passwords, so any
// key can be wrapped. The engine uses it to open certificate-encrypted (V5) files in MuPDF, which
// only knows the Standard handler (the bridge, see pubsecBridge.ts). ISO 32000-2, algorithms 2.B
// (password hash), 8 (/U, /UE), 9 (/O, /OE) and 10 (/Perms).
import { aesCbcEncryptNoPad, aesEcbEncrypt, concat, randomBytes, sha256, sha384, sha512, toHex, utf8 } from './primitives'

/** Algorithm 2.B. `udata` is the 48-byte /U for owner hashes, empty for user hashes. */
export function hashR6(password: Uint8Array, salt: Uint8Array, udata: Uint8Array = new Uint8Array(0)): Uint8Array {
  let k = sha256(concat([password, salt, udata]))
  for (let round = 0; ; round++) {
    const block = concat([password, k, udata])
    const k1 = new Uint8Array(block.length * 64)
    for (let i = 0; i < 64; i++) k1.set(block, i * block.length)
    const e = aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1)
    let sum = 0
    for (let i = 0; i < 16; i++) sum += e[i]
    const mod = sum % 3
    k = mod === 0 ? sha256(e) : mod === 1 ? sha384(e) : sha512(e)
    if (round >= 63 && e[e.length - 1] <= round - 31) break
  }
  return k.subarray(0, 32)
}

/** A random password nobody types (144 bits, base64url, ASCII so it needs no SASLprep). */
export function oneTimePassword(): string {
  return btoa(String.fromCharCode(...randomBytes(18)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

export interface StandardR6 {
  /** The /Encrypt dictionary as PDF source. */
  source: string
  /** Its /U and /O values (48 bytes each), to check that it never reaches an output. */
  U: Uint8Array
  O: Uint8Array
}

/**
 * A Standard V5/R6 /Encrypt dictionary that opens `fileKey` with `userPassword` (MuPDF then applies
 * /P) and with `ownerPassword` (full access). `permissions` is the signed 32-bit /P. Passwords must
 * be ASCII: use oneTimePassword().
 */
export function standardR6Dict(
  fileKey: Uint8Array,
  userPassword: string,
  ownerPassword: string,
  { permissions = -4, encryptMetadata = true }: { permissions?: number; encryptMetadata?: boolean } = {}
): StandardR6 {
  if (fileKey.length !== 32) throw new Error('A V5 file key has 32 bytes')
  const upw = utf8(userPassword).subarray(0, 127)
  const opw = utf8(ownerPassword).subarray(0, 127)
  const [uvs, uks, ovs, oks] = [8, 8, 8, 8].map(randomBytes)
  const zeroIv = new Uint8Array(16)
  const U = concat([hashR6(upw, uvs), uvs, uks])
  const UE = aesCbcEncryptNoPad(hashR6(upw, uks), zeroIv, fileKey)
  const O = concat([hashR6(opw, ovs, U), ovs, oks])
  const OE = aesCbcEncryptNoPad(hashR6(opw, oks, U), zeroIv, fileKey)
  const perms = new Uint8Array(16)
  new DataView(perms.buffer).setInt32(0, permissions | 0, true)
  perms.set([0xff, 0xff, 0xff, 0xff], 4)
  perms[8] = encryptMetadata ? 0x54 : 0x46 // 'T' or 'F'
  perms.set([0x61, 0x64, 0x62], 9) // 'adb'
  perms.set(randomBytes(4), 12)
  const Perms = aesEcbEncrypt(fileKey, perms)
  const source =
    `<</Filter/Standard/V 5/R 6/Length 256/CF<</StdCF<</AuthEvent/DocOpen/CFM/AESV3/Length 32>>>>` +
    `/StmF/StdCF/StrF/StdCF/O<${toHex(O)}>/U<${toHex(U)}>/OE<${toHex(OE)}>/UE<${toHex(UE)}>` +
    `/P ${permissions | 0}/Perms<${toHex(Perms)}>${encryptMetadata ? '' : '/EncryptMetadata false'}>>`
  return { source, U, O }
}
