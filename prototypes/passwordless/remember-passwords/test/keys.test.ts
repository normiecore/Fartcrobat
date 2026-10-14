// Port target: tests/engine/core-saved-passwords-keys.test.ts
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { deriveKey, digitalIdKey, kindOf, pdfKeys } from '../src/keys.ts'
import { readFileId, readLockInfo } from '../src/lockInfo.ts'

const mupdf = await import('mupdf')
const FIX = '/home/user/Fartcrobat/tests/fixtures'

function save(doc: InstanceType<typeof mupdf.PDFDocument>, opts: string): Uint8Array {
  const buf = doc.saveToBuffer(opts)
  try {
    return buf.asUint8Array().slice()
  } finally {
    buf.destroy()
  }
}

describe('lock info (read before authentication)', () => {
  it('reads /ID[0] and the /Encrypt parameters of tests/fixtures/encrypted.pdf while needsPassword() is true', () => {
    const doc = new mupdf.PDFDocument(new Uint8Array(readFileSync(`${FIX}/encrypted.pdf`)))
    expect(doc.needsPassword()).toBe(true)
    const lock = readLockInfo(doc)!
    expect(lock.handler).toBe('Standard')
    expect(lock.id).toBe('663003633e66a2168176dd39b548fa6b')
    expect(lock.security).toMatch(/^Filter=Standard;V=2;R=3;P=-28;Length=128;O=[0-9a-f]{64};U=[0-9a-f]{64};ID0=663003633e66a2168176dd39b548fa6b$/)
    // Same values after authenticating: nothing read before was garbled by decryption.
    expect(doc.authenticatePassword('secret')).toBe(2)
    expect(readLockInfo(doc)).toEqual(lock)
  })

  it('reads an AES-256 (R6) lock before authentication, and returns null for unencrypted files', () => {
    const plain = new mupdf.PDFDocument(new Uint8Array(readFileSync(`${FIX}/text.pdf`)))
    expect(readLockInfo(plain)).toBeNull()
    const id = readFileId(plain)
    const doc = new mupdf.PDFDocument(save(plain, 'garbage=yes,encrypt=aes-256,user-password=u1,owner-password=o1,permissions=-3904'))
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
})
