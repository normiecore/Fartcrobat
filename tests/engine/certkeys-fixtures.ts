/** Shared helpers for the certkeys-* tests: the certificate-encrypted fixtures and their Digital IDs. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fromHex, toBase64 } from '@features/digital-signatures/lib/asn1'

export const PUBSEC_DIR = join(__dirname, '../fixtures/passwordless')
export const PKI = join(PUBSEC_DIR, 'pki')

export interface ExpectedRecipient {
  envelope: number
  index: number | null
  idType: 'issuerAndSerialNumber' | 'subjectKeyIdentifier' | 'keyAgreement' | null
  issuer: string | null
  serialHex: string | null
  ski: string | null
  cert: string | null
  keyEncryption?: string
  contentCipher?: string
  oaepHash?: string
  damaged?: boolean
}

export interface ExpectedFile {
  file: string
  version: number
  cipher: string
  recipients: ExpectedRecipient[]
  opensWith: string[]
  permissions: Record<string, number>
  seedHex: Record<string, string>
}

export const expected: { files: ExpectedFile[] } = JSON.parse(
  readFileSync(join(PUBSEC_DIR, 'expected.json'), 'utf8')
)

export function expectedFile(file: string): ExpectedFile {
  const f = expected.files.find((x) => x.file === file)
  if (!f) throw new Error(`No expected entry for ${file}`)
  return f
}

/**
 * The /Recipients hex strings of a fixture, in file order. Every fixture writes them as hex
 * strings in a dictionary outside any object stream, so a plain scan is enough for tests.
 */
export function recipientsOf(file: string): Uint8Array[] {
  const text = readFileSync(join(PUBSEC_DIR, file)).toString('latin1')
  const m = /\/Recipients\s*\[([^\]]*)\]/.exec(text)
  if (!m) throw new Error(`${file} has no /Recipients`)
  return [...m[1].matchAll(/<([0-9A-Fa-f\s]*)>/g)].map((x) => fromHex(x[1]))
}

export function certDer(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(PKI, `${name}.cer`)))
}

export const PASSWORDS: Record<string, string> = {
  alice: 'alice-pass',
  bob: 'bob-pass',
  stranger: 'stranger-pass',
  ec: 'ec-pass'
}

export const NAMES: Record<string, string> = {
  alice: 'Alice Test',
  bob: 'Bob Tëst',
  stranger: 'Stranger Test',
  ec: 'EC Test'
}

/** A Digital ID record as Preferences > Digital IDs stores it (only the fields the source reads matter). */
export function idRecord(name: string, path = join(PKI, `${name}.p12`)) {
  const der = certDer(name)
  return {
    id: createHash('sha256').update(der).digest('hex').toUpperCase(),
    path,
    name: NAMES[name] ?? name,
    email: '',
    organization: 'Fartcrobat Test Keys',
    issuer: 'Fartcrobat Test CA',
    notBefore: '2025-01-01T00:00:00.000Z',
    notAfter: '2045-01-01T00:00:00.000Z',
    keyType: name === 'ec' ? 'ECDSA P-256' : 'RSA 2048-bit',
    certificate: toBase64(der),
    selfSigned: false,
    createdByApp: false,
    addedAt: 0
  }
}

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

/** The seed and permission bytes of an envelope's content. */
export function splitContent(content: Uint8Array) {
  return {
    seed: hex(content.subarray(0, 20)),
    permissions:
      content.length >= 24
        ? new DataView(content.buffer, content.byteOffset + 20, 4).getUint32(0, false)
        : null
  }
}
