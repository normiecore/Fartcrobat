// Saved passwords: the lock read before authentication, the lookup keys, and what the engine
// reports when it opens a protected file.
import { describe, expect, it } from 'vitest'
import * as mupdf from 'mupdf'
import { createLocalEngine } from '@engine/local'
import type docOps from '@engine/ops/doc'
import { readFileId, readLockInfo } from '@engine/util/lockInfo'
import type organizeOps from '@features/organize-pages/engine'
import { deriveKey, digitalIdKey, kindOf, pdfKeys, targetKeys } from '@main/passwords/keys'
import { fixture } from './helpers'

function save(doc: mupdf.PDFDocument, opts: string): Uint8Array {
  const buf = doc.saveToBuffer(opts)
  try {
    return buf.asUint8Array().slice()
  } finally {
    buf.destroy()
  }
}

/** text.pdf protected with AES-256, open password "u1", permissions password "o1". */
function aes256(): Uint8Array {
  const plain = new mupdf.PDFDocument(fixture('text.pdf'))
  try {
    return save(plain, 'garbage=yes,encrypt=aes-256,user-password=u1,owner-password=o1,permissions=-3904')
  } finally {
    plain.destroy()
  }
}

describe('lock info (read before authentication)', () => {
  it('reads /ID[0] and the /Encrypt parameters of encrypted.pdf while needsPassword() is true', () => {
    const doc = new mupdf.PDFDocument(fixture('encrypted.pdf'))
    expect(doc.needsPassword()).toBe(true)
    const lock = readLockInfo(doc)!
    expect(lock.handler).toBe('Standard')
    expect(lock.id).toBe('663003633e66a2168176dd39b548fa6b')
    expect(lock.security).toMatch(
      /^Filter=Standard;V=2;R=3;P=-28;Length=128;O=[0-9a-f]{64};U=[0-9a-f]{64};ID0=663003633e66a2168176dd39b548fa6b$/
    )
    // Same values after authenticating: nothing read before was garbled by decryption.
    expect(doc.authenticatePassword('secret')).toBe(2)
    expect(readLockInfo(doc)).toEqual(lock)
  })

  it('reads an AES-256 (R6) lock before authentication, and returns null for unencrypted files', () => {
    const plain = new mupdf.PDFDocument(fixture('text.pdf'))
    expect(readLockInfo(plain)).toBeNull()
    const id = readFileId(plain)
    const doc = new mupdf.PDFDocument(aes256())
    expect(doc.needsPassword()).toBe(true)
    const lock = readLockInfo(doc)!
    expect(lock.id).toBe(id)
    expect(lock.security).toMatch(/V=5;R=6;.*O=[0-9a-f]{96};U=[0-9a-f]{96};OE=[0-9a-f]{64};UE=[0-9a-f]{64};Perms=[0-9a-f]{32}$/)
    expect(lock.security).not.toContain('ID0=') // R6 does not use /ID in key derivation
  })
})

describe('lookup keys', () => {
  const lock = { handler: 'Standard', id: 'ABCDEF', security: 'Filter=Standard;V=5;R=6' }

  it('derives lock, id and path keys, strongest first, hashed (no /ID or path in clear)', () => {
    const keys = pdfKeys({ lock, pathKey: 'c:\\docs\\a.pdf' })
    expect(keys.map(kindOf)).toEqual(['lock', 'id', 'path'])
    for (const k of keys) expect(k).toMatch(/^[a-z-]+:[0-9a-f]{64}$/)
    expect(keys.join()).not.toMatch(/abcdef|docs/i)
  })

  it('is stable, case-insensitive for /ID hex, and separates kinds', () => {
    expect(pdfKeys({ lock })).toEqual(pdfKeys({ lock: { ...lock, id: 'abcdef' } }))
    expect(deriveKey('id', 'x')).not.toBe(deriveKey('path', 'x').replace(/^path:/, 'id:'))
    expect(digitalIdKey('AB12')).toBe(digitalIdKey('ab12'))
    expect(kindOf(digitalIdKey('ab12'))).toBe('digital-id')
  })

  it('skips what is missing (no /ID, in-memory document)', () => {
    expect(pdfKeys({ lock: { ...lock, id: null } }).map(kindOf)).toEqual(['lock'])
    expect(pdfKeys({ lock: null, pathKey: '/a.pdf' }).map(kindOf)).toEqual(['path'])
    expect(pdfKeys({})).toEqual([])
  })

  it('normalises paths the way the platform compares them', () => {
    const at = (path: string, platform: string) => targetKeys({ kind: 'pdf', lock: null, path }, platform)
    expect(at('C:\\Docs\\.\\A.pdf', 'win32')).toEqual(at('c:/docs/a.pdf', 'win32'))
    expect(at('/home/me//a.pdf', 'linux')).toEqual(at('/home/me/a.pdf', 'linux'))
    expect(at('/home/me/A.pdf', 'linux')).not.toEqual(at('/home/me/a.pdf', 'linux'))
    expect(targetKeys({ kind: 'digital-id', certificateSha256: 'AB'.repeat(32) }, 'linux')).toEqual([digitalIdKey('ab'.repeat(32))])
  })
})

describe('the engine reports locks and access', () => {
  it('doc.open returns the lock with needsPassword; authenticate returns the access the password gives', async () => {
    const bytes = aes256()
    const expected = readLockInfo(new mupdf.PDFDocument(bytes))
    for (const [password, access] of [
      ['u1', 'user'],
      ['o1', 'owner']
    ] as const) {
      const e = await createLocalEngine()
      const doc = e.ops<typeof docOps>('doc')
      const first = await doc.open(bytes, { fileName: 'a.pdf' })
      expect(first).toEqual({ ok: false, needsPassword: true, wrongPassword: false, lock: expected })
      const wrong = await doc.authenticate('nope')
      expect(wrong).toEqual({ ok: false, needsPassword: true, wrongPassword: true, lock: expected })
      const ok = await doc.authenticate(password)
      expect(ok.ok && ok.access).toBe(access)
      // The open document's lock is the one reported before the password was known.
      expect(await doc.lockInfo()).toEqual(expected)
    }
  })

  it('open with a password and reload report access; reload reports the lock of bytes that need another password', async () => {
    const e = await createLocalEngine()
    const doc = e.ops<typeof docOps>('doc')
    const opened = await doc.open(fixture('encrypted.pdf'), { fileName: 'encrypted.pdf', password: 'secret' })
    expect(opened.ok && opened.access).toBe('user')
    const again = await doc.reload(fixture('encrypted.pdf'), {})
    expect(again.ok && again.access).toBe('user') // reopened with the password it was opened with
    const other = aes256()
    const locked = await doc.reload(other, {})
    expect(locked).toEqual({ ok: false, needsPassword: true, wrongPassword: false, lock: readLockInfo(new mupdf.PDFDocument(other)) })
    const plain = await createLocalEngine()
    const plainDoc = plain.ops<typeof docOps>('doc')
    const res = await plainDoc.open(fixture('text.pdf'), { fileName: 'text.pdf' })
    expect(res.ok && res.access).toBeUndefined()
    expect(await plainDoc.lockInfo()).toBeNull()
  })

  it('checkFile tries a password on input bytes without opening them as the document', async () => {
    const e = await createLocalEngine()
    const doc = e.ops<typeof docOps>('doc')
    const bytes = aes256()
    const lock = readLockInfo(new mupdf.PDFDocument(bytes))
    expect(await doc.checkFile(fixture('text.pdf'), 'text.pdf')).toEqual({ needsPassword: false })
    expect(await doc.checkFile(bytes, 'a.pdf')).toEqual({ needsPassword: true, lock, access: null })
    expect(await doc.checkFile(bytes, 'a.pdf', 'nope')).toEqual({ needsPassword: true, lock, access: null })
    expect(await doc.checkFile(bytes, 'a.pdf', 'u1')).toEqual({ needsPassword: true, lock, access: 'user' })
    expect(await doc.checkFile(bytes, 'a.pdf', 'o1')).toEqual({ needsPassword: true, lock, access: 'owner' })
    expect(e.session.doc).toBeNull()
  })

  it('organize-pages probe reports the lock, then the access', async () => {
    const e = await createLocalEngine()
    const o = e.ops<typeof organizeOps>('organize-pages')
    const bytes = aes256()
    const lock = readLockInfo(new mupdf.PDFDocument(bytes))
    expect(await o.probe(bytes, 'a.pdf')).toEqual({ ok: false, needsPassword: true, wrongPassword: false, lock })
    expect(await o.probe(bytes, 'a.pdf', 'o1')).toMatchObject({ ok: true, pageCount: 5, access: 'owner' })
    const plain = await o.probe(fixture('text.pdf'), 'text.pdf')
    expect(plain.ok && 'access' in plain).toBe(false)
  })
})
