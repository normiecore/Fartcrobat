// Test-only: open a V5 PubSec PDF in mupdf.js given the decrypted recipient content (seed + permissions),
// using the rewrap from the earlier bridge spike (security/pubsec_bridge.mjs): compute the file key, then
// append an incremental update that redefines /Encrypt as a Standard R5 handler around the same key.
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mupdf } from './deps.ts'
import type { PubSecInfo } from './pdfRecipients.ts'

export function fileKeyV5(seed: Uint8Array, info: PubSecInfo): Buffer {
  const h = createHash('sha256').update(seed)
  for (const r of info.recipients) h.update(r)
  if (!info.encryptMetadata) h.update(Buffer.from([0xff, 0xff, 0xff, 0xff]))
  return h.digest()
}

export function openWithFileKey(pdfBytes: Uint8Array, info: PubSecInfo, fileKey: Buffer): { pages: number; text: string } {
  const pdf = Buffer.from(pdfBytes)
  const text = pdf.toString('latin1')
  const pw = Buffer.from(randomBytes(12).toString('base64url'))
  const sha = (...parts: Buffer[]): Buffer => createHash('sha256').update(Buffer.concat(parts)).digest()
  const aesNoIv = (k: Buffer, data: Buffer): Buffer => {
    const c = createCipheriv('aes-256-cbc', k, Buffer.alloc(16))
    c.setAutoPadding(false)
    return Buffer.concat([c.update(data), c.final()])
  }
  const [uvs, uks, ovs, oks] = [8, 8, 8, 8].map((n) => randomBytes(n))
  const U = Buffer.concat([sha(pw, uvs), uvs, uks])
  const UE = aesNoIv(sha(pw, uks), fileKey)
  const O = Buffer.concat([sha(pw, ovs, U), ovs, oks])
  const OE = aesNoIv(sha(pw, oks, U), fileKey)
  const P = -4
  const permsBlock = Buffer.concat([Buffer.alloc(4), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from(info.encryptMetadata ? 'T' : 'F'), Buffer.from('adb'), randomBytes(4)])
  permsBlock.writeInt32LE(P, 0)
  const ecb = createCipheriv('aes-256-ecb', fileKey, null)
  ecb.setAutoPadding(false)
  const Perms = Buffer.concat([ecb.update(permsBlock), ecb.final()])
  const hex = (b: Buffer): string => `<${b.toString('hex')}>`
  const dict =
    `<</Filter/Standard/V 5/R 5/Length 256/CF<</StdCF<</AuthEvent/DocOpen/CFM/AESV3/Length 32>>>>/StmF/StdCF/StrF/StdCF` +
    `/O${hex(O)}/U${hex(U)}/OE${hex(OE)}/UE${hex(UE)}/P ${P}/Perms${hex(Perms)}${info.encryptMetadata ? '' : '/EncryptMetadata false'}>>`
  const prevXref = Number([...text.matchAll(/startxref\s+(\d+)/g)].pop()![1])
  const lastTrailer = text.slice(text.lastIndexOf('trailer'))
  const size = Number(/\/Size\s+(\d+)/.exec(lastTrailer)![1])
  const root = /\/Root\s+(\d+\s+\d+\s+R)/.exec(lastTrailer)![1]
  const id = /\/ID\s*(\[[^\]]*\])/.exec(lastTrailer)?.[1] ?? ''
  const body = `\n${info.encNum} 0 obj\n${dict}\nendobj\n`
  const objOffset = pdf.length + 1
  const xrefOffset = pdf.length + Buffer.byteLength(body, 'latin1')
  const xref = `xref\n${info.encNum} 1\n${String(objOffset).padStart(10, '0')} 00000 n \ntrailer\n<</Size ${size}/Root ${root}/Encrypt ${info.encNum} 0 R/ID ${id}/Prev ${prevXref}>>\nstartxref\n${xrefOffset}\n%%EOF\n`
  const out = Buffer.concat([pdf, Buffer.from(body + xref, 'latin1')])
  mupdf.setLog({ warning: () => {}, error: () => {} } as never)
  const doc = mupdf.Document.openDocument(new Uint8Array(out), 'application/pdf')
  if (!doc.needsPassword() || !doc.authenticatePassword(pw.toString())) throw new Error('rewrapped file did not authenticate')
  const page = doc.loadPage(0)
  return { pages: doc.countPages(), text: page.toStructuredText().asText() }
}
