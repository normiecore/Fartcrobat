/** Digital ID management in the UI: create, import, export, remove, and unlock for signing. */
import { basename, invoke, joinPath, readFile, saveBytesAs, stripExtension } from '@renderer/sdk'
import { fromBase64, toBase64 } from '../lib/asn1'
import { describePublicKey } from '../lib/crypto'
import { createSelfSignedId, digitalIdFileName, type NewDigitalIdOptions } from '../lib/digitalId'
import { parseDigitalId, type ParsedDigitalId } from '../lib/pkcs12'
import { displayName, dnGet, describeCertificate, isSelfIssued, type Certificate } from '../lib/x509'
import type { DigitalIdRecord, TrustedCertificate } from '../types'
import { loadIds, saveIds, setTrusted, useSigStore } from './store'

/** Folder for Digital IDs created or imported by Fartcrobat (created on demand by main). */
export async function idsFolder(): Promise<string> {
  return invoke('feature:digital-signatures:idsDir')
}

async function recordFor(cert: Certificate, path: string, managed: boolean): Promise<DigitalIdRecord> {
  const d = await describeCertificate(cert)
  return {
    id: d.sha256,
    path,
    name: displayName(cert.subject),
    email: d.email,
    organization: dnGet(cert.subject, 'O'),
    issuer: displayName(cert.issuer),
    notBefore: d.notBefore,
    notAfter: d.notAfter,
    keyType: describePublicKey(cert.publicKey),
    certificate: toBase64(cert.der),
    selfSigned: isSelfIssued(cert),
    createdByApp: managed,
    addedAt: Date.now()
  }
}

async function addRecord(rec: DigitalIdRecord): Promise<DigitalIdRecord> {
  const ids = useSigStore.getState().idsLoaded ? useSigStore.getState().ids : await loadIds()
  const existing = ids.find((x) => x.id === rec.id)
  const next = existing ? ids.map((x) => (x.id === rec.id ? { ...rec, addedAt: existing.addedAt } : x)) : [...ids, rec]
  await saveIds(next)
  return rec
}

/** Creates a self-signed Digital ID, saves it as a .p12 in the user data folder and lists it. */
export async function createDigitalId(o: NewDigitalIdOptions): Promise<DigitalIdRecord> {
  const created = await createSelfSignedId(o)
  const dir = await idsFolder()
  const path = joinPath(dir, digitalIdFileName(o.name))
  await invoke('file:write', path, created.p12)
  const parsed = parseDigitalId(created.p12, o.password)
  return addRecord(await recordFor(parsed.signer, path, true))
}

/**
 * Imports a .pfx/.p12 file: checks the password, then keeps a copy in the user data folder so the
 * ID keeps working if the original file is moved.
 */
export async function importDigitalId(sourcePath: string, password: string): Promise<DigitalIdRecord> {
  const bytes = await readFile(sourcePath)
  const parsed = parseDigitalId(bytes, password)
  const dir = await idsFolder()
  const stem = stripExtension(basename(sourcePath)).replace(/[^\w.-]+/g, '-').slice(0, 40) || 'digital-id'
  const ext = /\.pfx$/i.test(sourcePath) ? 'pfx' : 'p12'
  const path = joinPath(dir, `${stem}-${Date.now().toString(36)}.${ext}`)
  await invoke('file:write', path, bytes)
  return addRecord(await recordFor(parsed.signer, path, true))
}

/** Removes an ID from the list (and deletes Fartcrobat's copy of the file). */
export async function removeDigitalId(rec: DigitalIdRecord) {
  if (rec.createdByApp) await invoke('feature:digital-signatures:deleteId', rec.path)
  await saveIds(useSigStore.getState().ids.filter((x) => x.id !== rec.id))
}

/** Saves the public certificate (.cer, DER) so others can trust your signatures. */
export async function exportCertificate(der: Uint8Array, name: string): Promise<string | null> {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '').trim() || 'certificate'
  return saveBytesAs(der, `${safe}.cer`, [{ name: 'Certificate', extensions: ['cer'] }], 'Export Certificate')
}

export function recordCertificate(rec: DigitalIdRecord): Uint8Array {
  return fromBase64(rec.certificate)
}

/** Reads the ID file and unlocks it with the password (never stored). */
export async function unlockDigitalId(rec: DigitalIdRecord, password: string): Promise<ParsedDigitalId> {
  let bytes: Uint8Array
  try {
    bytes = await readFile(rec.path)
  } catch {
    throw new Error(`The Digital ID file could not be found at ${rec.path}. Remove this ID and import it again.`)
  }
  return parseDigitalId(bytes, password)
}

export function idStatus(rec: DigitalIdRecord, now = Date.now()): 'valid' | 'expired' | 'not-yet-valid' {
  if (Date.parse(rec.notAfter) < now) return 'expired'
  if (Date.parse(rec.notBefore) > now) return 'not-yet-valid'
  return 'valid'
}

// ---- trust -----------------------------------------------------------------------------------

export async function trustCertificate(t: Omit<TrustedCertificate, 'addedAt'>) {
  const list = useSigStore.getState().trusted.filter((x) => x.fingerprint !== t.fingerprint.toUpperCase())
  await setTrusted([...list, { ...t, fingerprint: t.fingerprint.toUpperCase(), addedAt: Date.now() }])
}

export async function untrustCertificate(fingerprint: string) {
  await setTrusted(useSigStore.getState().trusted.filter((x) => x.fingerprint !== fingerprint.toUpperCase()))
}
