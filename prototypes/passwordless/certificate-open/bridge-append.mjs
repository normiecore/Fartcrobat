// Open bridge for /Adobe.PubSec files from any producer, without rewriting the file: append one
// incremental-update section that redefines the encryption dictionary as a Standard V5/R6 one
// wrapping the same file key under a one-time password. MuPDF then opens it with that password.
import { createDecipheriv, createHash } from 'node:crypto'
import forge from '/home/user/Fartcrobat/node_modules/node-forge/lib/index.js'
import { readTlv, children, readOid, certificateParts } from '../create/lib/der.mjs'
import { standardR6Dict, oneTimePassword } from '../create/lib/standard.mjs'
import { lastTrailer, findObject, isRef, isName, isStr, serialise, latin } from './pdflex.mjs'

const CIPHERS = {
  '2.16.840.1.101.3.4.1.2': 'aes-128-cbc',
  '2.16.840.1.101.3.4.1.22': 'aes-192-cbc',
  '2.16.840.1.101.3.4.1.42': 'aes-256-cbc',
  '1.2.840.113549.3.7': 'des-ede3-cbc'
}
const hex = (u) => Buffer.from(u).toString('hex')
const get = (d, k) => (d instanceof Map ? d.get(k) : undefined)

export function readPubSec(bytes) {
  const t = lastTrailer(bytes)
  const e = t.dict.get('Encrypt')
  if (!e) return null
  const dict = isRef(e) ? findObject(bytes, e.ref[0], e.ref[1]) : e
  const filter = get(dict, 'Filter')?.name
  const V = get(dict, 'V') ?? 0
  let recipients = get(dict, 'Recipients')
  let cfm = null
  let em = get(dict, 'EncryptMetadata')
  if (V >= 4) {
    const stmf = get(dict, 'StmF')?.name ?? 'Identity'
    const cf = get(get(dict, 'CF'), stmf)
    recipients = get(cf, 'Recipients') ?? recipients
    cfm = get(cf, 'CFM')?.name
    em = get(cf, 'EncryptMetadata') ?? em
  }
  recipients = (Array.isArray(recipients) ? recipients : [recipients]).filter(isStr).map((s) => s.str)
  const length = V >= 5 ? 256 : get(dict, 'Length') ?? get(get(get(dict, 'CF'), get(dict, 'StmF')?.name), 'Length') ?? 40
  return { trailer: t, encryptRef: isRef(e) ? e.ref : null, filter, subFilter: get(dict, 'SubFilter')?.name, V, cfm, length, recipients, encryptMetadata: em !== false }
}

/** Decrypts the 24-byte seed+permissions with a key that matches by issuer and serial. */
export function unwrapSeed(recipients, certDer, rsaDecrypt) {
  const me = certificateParts(certDer)
  for (const blob of recipients) {
    let ed
    try { ed = children(children(children(readTlv(blob))[1])[0]) } catch { continue }
    const eci = children(ed[2])
    for (const ri of children(ed[1])) {
      const f = children(ri)
      if (ri.tag !== 0x30 || f[1].tag !== 0x30) continue
      const [issuer, serial] = children(f[1])
      if (hex(issuer.raw) !== hex(me.issuer) || hex(serial.raw) !== hex(me.serial)) continue
      const cek = rsaDecrypt(f[3].content)
      const alg = children(eci[1])
      const name = CIPHERS[readOid(alg[0])]
      if (!name) throw new Error('unsupported envelope cipher ' + readOid(alg[0]))
      const d = createDecipheriv(name, cek, alg[1].content)
      const content = Buffer.concat([d.update(eci[2].content), d.final()])
      return { seed: content.subarray(0, 20), permissions: content.length >= 24 ? content.readUInt32BE(20) : null, cipher: name }
    }
  }
  return null
}

export function fileKey(info, seed) {
  const parts = [seed, ...info.recipients]
  if (!info.encryptMetadata) parts.push(Buffer.from([0xff, 0xff, 0xff, 0xff]))
  if (info.V >= 5) return createHash('sha256').update(Buffer.concat(parts)).digest()
  return createHash('sha1').update(Buffer.concat(parts)).digest().subarray(0, info.length / 8)
}

export const forgeDecrypter = (keyPem) => {
  const k = forge.pki.privateKeyFromPem(keyPem)
  return (w) => Buffer.from(k.decrypt(Buffer.from(w).toString('latin1'), 'RSAES-PKCS1-V1_5'), 'latin1')
}

/** Appends an update section. `objects` is [[num, gen, sourceText]]; `trailerEdits` sets keys. */
export function appendUpdate(bytes, info, objects, trailerEdits) {
  const enc = new TextEncoder()
  const base = bytes[bytes.length - 1] === 10 ? bytes : Buffer.concat([bytes, Buffer.from('\n')])
  let body = ''
  const offs = []
  for (const [num, gen, src] of objects) {
    offs.push([num, gen, base.length + enc.encode(body).length])
    body += `${num} ${gen} obj\n${src}\nendobj\n`
  }
  const xrefAt = base.length + enc.encode(body).length
  let xref = 'xref\n0 1\n0000000000 65535 f\r\n'
  for (const [num, gen, off] of offs) xref += `${num} 1\n${String(off).padStart(10, '0')} ${String(gen).padStart(5, '0')} n\r\n`
  const t = new Map()
  for (const k of ['Size', 'Root', 'Info', 'ID', 'Encrypt']) if (info.trailer.dict.has(k)) t.set(k, info.trailer.dict.get(k))
  for (const [k, v] of Object.entries(trailerEdits)) v === undefined ? t.delete(k) : t.set(k, v)
  t.set('Prev', info.trailer.offset)
  const tail = `${xref}trailer\n${serialise(t).replace(/\/Encrypt __RAW__/, '')}\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.concat([base, Buffer.from(body + tail, 'latin1')])
}

/** V5: rewrap K as Standard R6 under a one-time password. */
export async function bridgeV5(bytes, info, K) {
  const password = oneTimePassword()
  const std = await standardR6Dict(new Uint8Array(K), password, { encryptMetadata: info.encryptMetadata })
  if (info.encryptRef) return { bytes: appendUpdate(bytes, info, [[info.encryptRef[0], info.encryptRef[1], std]], {}), password }
  // Direct /Encrypt in the trailer: put the new dictionary in a fresh object.
  const num = info.trailer.dict.get('Size')
  const out = appendUpdate(bytes, info, [[num, 0, std]], { Size: num + 1, Encrypt: { ref: [num, 0] } })
  return { bytes: out, password }
}
