// Reading side, to check created files with MuPDF: unwrap the seed with the recipient key,
// compute K, and swap the PubSec /Encrypt dictionary for a Standard R6 one around the same K and a
// one-time password; MuPDF then opens the file with that password. (The open path proper, for
// files from any producer, is a separate spike; this one handles the single-xref files that
// MuPDF and our serialiser write.)
import { fromHex, toLatin1 } from './crypto.mjs'
import { objectSpan, parseClassicXref, replaceObject, trailerValue } from './pdfbytes.mjs'
import { pubsecFileKey, unwrapSeed } from './pubsec.mjs'
import { oneTimePassword, standardR6Dict } from './standard.mjs'

export function readPubSecDict(bytes) {
  const xref = parseClassicXref(bytes)
  const num = Number(/^(\d+)/.exec(trailerValue(xref.trailer, 'Encrypt') ?? '')?.[1])
  const text = objectSpan(bytes, xref, num).text
  const recipients = [...(/\/Recipients\s*\[([^\]]*)\]/.exec(text)?.[1] ?? '').matchAll(/<([0-9A-Fa-f\s]+)>/g)].map((m) => fromHex(m[1]))
  return {
    num,
    text,
    filter: /\/Filter\s*\/([\w.]+)/.exec(text)?.[1],
    subFilter: /\/SubFilter\s*\/([\w.]+)/.exec(text)?.[1],
    recipients,
    encryptMetadata: !/\/EncryptMetadata\s+false/.test(text)
  }
}

/** Returns { doc, fileKey, permissions } or throws when the key is not a recipient. */
export async function openPubSec(mupdf, bytes, certDer, decryptKey) {
  const d = readPubSecDict(bytes)
  if (d.filter !== 'Adobe.PubSec') throw new Error(`not a certificate-encrypted file (${d.filter})`)
  const unwrapped = await unwrapSeed(d.recipients, certDer, decryptKey)
  if (!unwrapped) throw new Error('this certificate is not a recipient of the file')
  const fileKey = await pubsecFileKey(unwrapped.seed, d.recipients, d.encryptMetadata)
  const password = oneTimePassword()
  const std = await standardR6Dict(fileKey, password, { encryptMetadata: d.encryptMetadata })
  const bridged = replaceObject(bytes, d.num, std)
  const doc = new mupdf.PDFDocument(bridged)
  if (!doc.needsPassword() || !doc.authenticatePassword(password)) throw new Error('MuPDF refused the bridged file')
  return { doc, fileKey, permissions: unwrapped.permissions, dict: d }
}

export { toLatin1 }
