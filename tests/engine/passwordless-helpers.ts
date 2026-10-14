// Shared by the passwordless-*.test.ts files: the certificate-encrypted fixtures and keys made from
// expected.json (the seed each person's envelope holds), so no RSA is needed to open them.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { readPubSec } from '@engine/crypt'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import type textOps from '@engine/ops/text'
import type { CertificateKey } from '@shared/certkeys'
import type { DocInfo, OpenResult } from '@shared/types'
import { fixture, FIXTURES, type OpenedEngine } from './helpers'

export const DIR = 'passwordless'
export const PKI = resolve(FIXTURES, DIR, 'pki')

export interface ExpectedRecipient {
  envelope: number
  index: number | null
  cert: string | null
  damaged?: boolean
}

export interface ExpectedFile {
  file: string
  version: number
  cipher: 'RC4' | 'AESV2' | 'AESV3'
  keyBits: number
  xref: 'table' | 'stream'
  objectStreams: boolean
  revisions: number
  encryptDirect: boolean
  pdfMac: boolean
  signatures: number
  recipients: ExpectedRecipient[]
  opensWith: string[]
  permissions: Record<string, number>
  encryptMetadata: boolean
  seedHex: Record<string, string>
  fileKeyHex: string
  title: string
  expectedTitle: string
  pages: number
}

export const EXPECTED: ExpectedFile[] = JSON.parse(readFileSync(resolve(FIXTURES, DIR, 'expected.json'), 'utf8')).files

export function expected(file: string): ExpectedFile {
  const e = EXPECTED.find((x) => x.file === file)
  if (!e) throw new Error(`${file} is not in expected.json`)
  return e
}

export const pubsecFixture = (file: string): Uint8Array => fixture(`${DIR}/${file}`)

export const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16))

/** The key `person`'s private key would unwrap from `file` (envelope, seed, permissions). */
export function keyFor(file: string, person: string, bytes = pubsecFixture(file)): CertificateKey {
  const e = expected(file)
  const info = readPubSec(bytes)
  if (!info) throw new Error(`${file} is not certificate-encrypted`)
  const r = e.recipients.find((x) => x.cert === person)
  if (!r) throw new Error(`${person} is not a recipient of ${file}`)
  return { envelope: info.recipients[r.envelope], seed: hexBytes(e.seedHex[person]), permissions: e.permissions[person] }
}

export type Engine = OpenedEngine

/** A fresh engine with `bytes` opened through needsCertificate and unlockCertificate(key). */
export async function openWithKey(bytes: Uint8Array, key: CertificateKey, fileName = 'file.pdf'): Promise<Engine> {
  const engine = await createLocalEngine()
  const doc = engine.ops<typeof docOps>('doc')
  const first: OpenResult = await doc.open(bytes, { fileName })
  if (first.ok || !first.needsCertificate) throw new Error(`${fileName}: expected needsCertificate`)
  const res = await doc.unlockCertificate(key)
  if (!res.ok) throw new Error(`${fileName}: the key did not open it`)
  return Object.assign(engine, { info: res.info as DocInfo, doc })
}

export async function openFixtureAs(file: string, person: string): Promise<Engine> {
  const bytes = pubsecFixture(file)
  return openWithKey(bytes, keyFor(file, person, bytes), file)
}

export function pageText(e: Engine, page = 0): Promise<string> {
  return e.ops<typeof textOps>('text').plain(page)
}

export function includesBytes(hay: Uint8Array, text: string): boolean {
  return Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).includes(Buffer.from(text, 'latin1'))
}
