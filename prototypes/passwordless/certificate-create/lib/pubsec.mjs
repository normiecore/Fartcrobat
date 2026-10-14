// The public-key security handler (/Filter /Adobe.PubSec, /SubFilter /adbe.pkcs7.s5, /V 5, AESV3):
// recipient envelopes, the file key, and the /Encrypt dictionary. ISO 32000-2 7.6.5.
//
//   seed        20 random bytes, the only secret
//   recipients  one CMS EnvelopedData (DER ContentInfo) per permission set; its content is
//               seed(20) || permissions(4, big-endian), encrypted with AES-256-CBC under a random
//               content key that is RSA-encrypted (PKCS#1 v1.5) to every certificate in the set
//   file key    SHA-256(seed || recipients[0] || recipients[1] ... || [FF FF FF FF if !EncryptMetadata])
//
// node-forge is only used for RSA (WebCrypto has RSA-OAEP but not RSAES-PKCS1-v1_5, which is what
// Acrobat and the Windows certificate store expect for key transport).
import { createRequire } from 'node:module'
import { aesCbcDecrypt, aesCbcEncrypt, concat, hex, randomBytes, sha, toLatin1 } from './crypto.mjs'
import { OID, certificateParts, children, der, readOid, readTlv } from './der.mjs'

const require = createRequire('/home/user/Fartcrobat/package.json')
const forge = require('node-forge') // the app imports it: import forge from 'node-forge'

/** Public-key handler permission bits (ISO 32000-2 table 24). Bit 1 is always set (Acrobat). */
export const PUBSEC_PERMS = {
  changeSecurity: 1 << 1,
  print: 1 << 2,
  modify: 1 << 3,
  copy: 1 << 4,
  annotate: 1 << 5,
  fillForms: 1 << 8,
  accessibility: 1 << 9,
  assemble: 1 << 10,
  printHighRes: 1 << 11,
  tolerateMissingMac: 1 << 12
}
export const ALL_PERMISSIONS = 0xffffffff

export function permissionBits(allow = {}) {
  let bits = 0xffffe0c1
  for (const [name, bit] of Object.entries(PUBSEC_PERMS)) if (allow[name] !== false) bits |= bit
  return bits >>> 0
}

/**
 * One CMS EnvelopedData (as a DER ContentInfo) holding seed||permissions for `certs`
 * (DER X.509, RSA keys). Recipients are identified by issuerAndSerialNumber, copied from the
 * certificate bytes.
 */
export async function buildRecipientEnvelope(certs, seed, permissions) {
  if (seed.length !== 20) throw new Error('seed must be 20 bytes')
  const perms = new Uint8Array(4)
  new DataView(perms.buffer).setUint32(0, permissions >>> 0, false)
  const contentKey = randomBytes(32)
  const iv = randomBytes(16)
  const encryptedContent = await aesCbcEncrypt(contentKey, iv, concat([seed, perms]))

  const infos = certs.map((certDer) => {
    const c = certificateParts(certDer)
    if (c.keyOid !== OID.rsaEncryption) {
      throw new Error('Only RSA certificates can be used for certificate encryption')
    }
    const pub = forge.pki.publicKeyFromAsn1(forge.asn1.fromDer(toLatin1(c.spki)))
    const encryptedKey = Uint8Array.from(pub.encrypt(toLatin1(contentKey), 'RSAES-PKCS1-V1_5'), (ch) => ch.charCodeAt(0))
    return der.seq(
      der.int(0), // KeyTransRecipientInfo v0: issuerAndSerialNumber
      der.seq(c.issuer, c.serial),
      der.seq(der.oid(OID.rsaEncryption), der.null()),
      der.octets(encryptedKey)
    )
  })

  const envelopedData = der.seq(
    der.int(0),
    der.setOf(...infos),
    der.seq(
      der.oid(OID.data),
      der.seq(der.oid(OID.aes256Cbc), der.octets(iv)),
      der.implicit(0, encryptedContent)
    )
  )
  return der.seq(der.oid(OID.envelopedData), der.explicit(0, envelopedData))
}

export async function pubsecFileKey(seed, recipients, encryptMetadata = true) {
  const parts = [seed, ...recipients]
  if (!encryptMetadata) parts.push(Uint8Array.of(0xff, 0xff, 0xff, 0xff))
  return sha(256, concat(parts))
}

/**
 * Everything needed to write a certificate-encrypted file. `groups` lists recipient sets with
 * their permissions; each becomes one envelope (Acrobat does the same: one PKCS#7 object per
 * permission set). One seed is shared by all of them.
 */
export async function newPubSecKey(groups, { encryptMetadata = true } = {}) {
  const seed = randomBytes(20)
  const recipients = []
  for (const g of groups) recipients.push(await buildRecipientEnvelope(g.certs, seed, g.permissions ?? ALL_PERMISSIONS))
  const fileKey = await pubsecFileKey(seed, recipients, encryptMetadata)
  return { seed, recipients, fileKey, encryptMetadata, encryptDict: pubsecEncryptDict(recipients, encryptMetadata) }
}

/** The /Encrypt dictionary, as PDF source text (all strings in it are left unencrypted). */
export function pubsecEncryptDict(recipients, encryptMetadata = true) {
  const em = encryptMetadata ? 'true' : 'false'
  const recips = recipients.map((r) => `<${hex(r)}>`).join('')
  return (
    `<</Filter/Adobe.PubSec/SubFilter/adbe.pkcs7.s5/V 5/Length 256` +
    `/CF<</DefaultCryptFilter<</Type/CryptFilter/CFM/AESV3/AuthEvent/DocOpen/Length 256` +
    `/Recipients[${recips}]/EncryptMetadata ${em}>>>>` +
    `/StmF/DefaultCryptFilter/StrF/DefaultCryptFilter/EncryptMetadata ${em}>>`
  )
}

// ---- reading (for the bridge and for tests) ---------------------------------------------------

/**
 * Finds the envelope addressed to `certDer` and decrypts its seed with `decryptKey`, a function
 * that RSA-decrypts (PKCS#1 v1.5) the wrapped content key. In the app that function is the
 * Windows certificate store / smart card (CNG NCryptDecrypt) or a .p12 key.
 */
export async function unwrapSeed(recipients, certDer, decryptKey) {
  const me = certificateParts(certDer)
  for (const blob of recipients) {
    const ci = readTlv(blob)
    const [ctype, wrapped] = children(ci)
    if (readOid(ctype) !== OID.envelopedData) continue
    const ed = children(children(wrapped)[0])
    const recipientInfos = children(ed[1])
    const eci = children(ed[2])
    for (const ri of recipientInfos) {
      const f = children(ri)
      if (f[1].tag !== 0x30) continue // subjectKeyIdentifier form: not handled in this spike
      const [issuer, serial] = children(f[1])
      if (hex(issuer.raw) !== hex(me.issuer) || hex(serial.raw) !== hex(me.serial)) continue
      const contentKey = await decryptKey(f[3].content)
      const alg = children(eci[1])
      if (readOid(alg[0]) !== OID.aes256Cbc) throw new Error(`unsupported envelope cipher ${readOid(alg[0])}`)
      const iv = alg[1].content
      const content = await aesCbcDecrypt(contentKey, iv, eci[2].content)
      const seed = content.subarray(0, 20)
      const permissions = content.length >= 24 ? new DataView(content.buffer, content.byteOffset + 20, 4).getUint32(0, false) : null
      return { seed, permissions }
    }
  }
  return null
}

/** RSA PKCS#1 v1.5 decryption with a PEM private key (stands in for the certificate store). */
export function pemKeyDecrypter(keyPem) {
  const key = forge.pki.privateKeyFromPem(keyPem)
  return async (wrapped) => Uint8Array.from(key.decrypt(toLatin1(wrapped), 'RSAES-PKCS1-V1_5'), (c) => c.charCodeAt(0))
}
