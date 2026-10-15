/**
 * Certificate encryption (PDF public-key security, /Filter /Adobe.PubSec) in the engine.
 * See docs/features/passwordless.md. Everything here is synchronous.
 *
 * Opening (ops/doc.ts and ops/pages.ts do this):
 * - readPubSec(bytes) -> PubSecInfo | null: the handler of a file MuPDF refused to open.
 * - certificateLockOf(info): what the renderer is told (public data).
 * - s.certificateKeys (CertificateKeyRegistry): every key the engine was given, by envelope.
 * - openWithKeys(m, bytes, info, keys) / openPubSec(m, bytes, info, key) -> { doc, state }: the
 *   document (bridged or decrypted, see pubsecBridge.ts) and its PubSecState. keysOpen() checks
 *   without opening. A file opened as an input (pages.ts openSourceWithAccess) returns its state as
 *   `pubsec`.
 *
 * The open document: Session.pubsec (PubSecState) is set for certificate-encrypted documents.
 * - state.writeKey: the original seed and envelopes; every output of the document is written with
 *   it (always V5, AES-256), so outputs open with the same keys.
 * - state.access / state.permissions: certificatePermissions(state.permissions) maps the envelope's
 *   bits to Record<Permission, boolean> ('owner' = full access); certificatePermissionBits() is the
 *   inverse, for the permission bytes of new envelopes (CertificateGroup).
 * - Never call saveToBuffer() on a certificate-encrypted document (or on a source opened with a
 *   key) and write the result anywhere: the bytes hold the temporary bridge, or plaintext.
 *
 * Writing (for the engine outputs builder):
 * - openPlainSessionCopy(s) / plainSessionBytes(s, options): a decrypted working copy of the
 *   session's document with its unsaved changes, for any session (plain, password, certificate).
 * - writePubSecDocument(m, doc, writeKey, { saveOptions, password }): any document (plain, or
 *   encrypted with `password`) as a certificate-encrypted file. For pages built into a new
 *   PDFDocument: writePubSecDocument(m, out, s.pubsec.writeKey).
 * - writeSessionPubSec(s, saveOptions): the session's document saved back (what Save does).
 * - writeKeyFor(seed, envelopes, encryptMetadata): the write key of new certificate security
 *   (SaveOptions.encryptCertificate); register the new key with s.certificateKeys.add({ envelope,
 *   seed, permissions }) for each envelope so reloading the output opens without asking.
 * - assertNoBridge(bytes, state, kind): run it on every output of a certificate-encrypted session
 *   ('pubsec', 'plain' for Remove Security, 'password' for password security).
 * - assertCertificateOutput(bytes, state): outputs that keep the session's protection (Extract,
 *   Split, Combine...) must be certificate-encrypted with its envelopes. protection.ts writes them
 *   (sessionProtection(s) is certificate protection for such a session), and pages.extract
 *   double-checks what protectBytes returns with assertCertificateOutput.
 * - sessionReadPassword(s): the password MuPDF needs to read the session's document.
 */
export {
  certificatePermissionBits,
  certificatePermissions,
  CertificateKeyRegistry,
  copyCertificateKey,
  type CertificatePermissions
} from './keys'
export { aesCbcEncrypt, aesCbcDecrypt, bytesEqual, concat, randomBytes, sha256, toHex } from './primitives'
export {
  appendUpdate,
  bridgeV5,
  decryptAll,
  fileKey,
  keysOpen,
  neutralise,
  openPubSec,
  openWithKeys,
  pubsecFileKey,
  verifyFileKey,
  writeKeyFor,
  type PubSecState,
  type PubSecWriteKey
} from './pubsecBridge'
export { certificateLockOf, readPubSec, type PubSecCipher, type PubSecInfo } from './pubsecRead'
export {
  assertCertificateOutput,
  assertNoBridge,
  decryptedSave,
  encryptObjectsInPlace,
  openPlainSessionCopy,
  plainSaveOptions,
  plainSessionBytes,
  pubsecEncryptDict,
  serialiseEncrypted,
  sessionReadPassword,
  writePubSecDocument,
  writeSessionPubSec,
  type OutputKind
} from './pubsecWrite'
export { hashR6, oneTimePassword, standardR6Dict } from './standardR6'

/** The encryption label of a certificate-encrypted document (DocInfo.encryption). */
export function certificateEncryptionLabel(source: { version: number; cipher: string; keyBits: number }): string {
  return `Adobe.PubSec V${source.version} ${source.keyBits}-bit ${source.cipher === 'RC4' ? 'RC4' : 'AES'}`
}
