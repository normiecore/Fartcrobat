// Saved passwords: the store in the main process, with a fake cipher and an in-memory disk.
import { describe, expect, it } from 'vitest'
import { deriveKey, digitalIdKey } from '@main/passwords/keys'
import { SavedPasswordStore } from '@main/passwords/store'
import { fakeCipher, memoryFs } from './saved-passwords-fakes'

const FILE = '/userData/saved-passwords.json'
const k = (kind: 'lock' | 'id' | 'path', s: string) => deriveKey(kind, s)

function setup(o: { cipher?: ReturnType<typeof fakeCipher>; fs?: ReturnType<typeof memoryFs>; max?: number } = {}) {
  const cipher = o.cipher ?? fakeCipher()
  const fs = o.fs ?? memoryFs()
  let t = 1000
  let n = 0
  const store = new SavedPasswordStore({ file: FILE, cipher, fs, now: () => ++t, newId: () => `r${++n}`, maxRecords: o.max })
  return { store, cipher, fs }
}

describe('SavedPasswordStore', () => {
  it('round-trips a password through the cipher; the file holds no password, path or /ID', async () => {
    const { store, fs } = setup()
    const keys = [k('lock', 'L1'), k('id', 'feedface'), k('path', '/home/me/contract.pdf')]
    const ref = await store.remember({ kind: 'pdf', keys, label: 'contract.pdf', level: 'user', password: 'hunter2-pässword' })
    expect(ref).toBe('r1')
    const text = fs.files.get(FILE)!
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('feedface')
    expect(text).not.toContain('/home/me')
    expect(JSON.parse(text).records[0]).toMatchObject({ id: 'r1', kind: 'pdf', label: 'contract.pdf', level: 'user' })

    // A new store instance (app restart) reads the file back.
    const again = new SavedPasswordStore({ file: FILE, cipher: fakeCipher(), fs })
    expect(await again.find([k('path', '/home/me/contract.pdf')])).toEqual([
      { ref: 'r1', password: 'hunter2-pässword', level: 'user', via: 'path' }
    ])
  })

  it('orders candidates by key strength, then by last use', async () => {
    const { store } = setup()
    await store.remember({ kind: 'pdf', keys: [k('path', '/a.pdf')], label: 'a', password: 'by-path' })
    await store.remember({ kind: 'pdf', keys: [k('id', 'ID')], label: 'a', password: 'by-id' })
    await store.remember({ kind: 'pdf', keys: [k('lock', 'L')], label: 'a', password: 'by-lock' })
    const c = await store.find([k('path', '/a.pdf'), k('id', 'ID'), k('lock', 'L')])
    expect(c.map((x) => x.password)).toEqual(['by-lock', 'by-id', 'by-path'])
    expect(c.map((x) => x.via)).toEqual(['lock', 'id', 'path'])
  })

  it('used() links the file keys to the record that worked, moving them from others', async () => {
    const { store } = setup()
    const a = (await store.remember({ kind: 'pdf', keys: [k('lock', 'L1'), k('id', 'ID')], label: 'a', password: 'one' }))!
    const b = (await store.remember({ kind: 'pdf', keys: [k('lock', 'L2')], label: 'b', password: 'two' }))!
    // A file with lock L3 and the shared /ID opened with b's password.
    await store.used(b, [k('lock', 'L3'), k('id', 'ID')])
    expect((await store.find([k('id', 'ID')])).map((c) => c.ref)).toEqual([b])
    expect((await store.find([k('lock', 'L1')])).map((c) => c.ref)).toEqual([a]) // a keeps its exact lock
    expect((await store.find([k('lock', 'L3')])).map((c) => c.ref)).toEqual([b])
  })

  it('failed() forgets the record for that file; the record goes when no key is left', async () => {
    const { store, fs } = setup()
    const ref = (await store.remember({ kind: 'pdf', keys: [k('lock', 'L1'), k('id', 'ID'), k('path', '/a.pdf')], label: 'a', password: 'old' }))!
    // The file at /a.pdf was protected again with a new password: same /ID, same path, new lock.
    await store.failed(ref, [k('lock', 'L9'), k('id', 'ID'), k('path', '/a.pdf')])
    expect(await store.find([k('id', 'ID'), k('path', '/a.pdf')])).toEqual([])
    expect(await store.find([k('lock', 'L1')])).toHaveLength(1) // an old copy still opens with it
    await store.failed(ref, [k('lock', 'L1')])
    expect(await store.list()).toEqual([])
    expect(fs.files.has(FILE)).toBe(false) // empty store: no file left behind
  })

  it('returns nothing and stores nothing while unavailable (policy, no keyring)', async () => {
    const cipher = fakeCipher({ unavailable: 'no-keyring' })
    const { store, fs } = setup({ cipher })
    expect(await store.remember({ kind: 'pdf', keys: [k('id', 'ID')], label: 'a', password: 'x' })).toBeNull()
    expect(fs.writes).toBe(0)
    cipher.state.unavailable = null
    await store.remember({ kind: 'pdf', keys: [k('id', 'ID')], label: 'a', password: 'x' })
    cipher.state.unavailable = 'policy'
    expect(await store.find([k('id', 'ID')])).toEqual([])
    expect(cipher.state.decrypts).toBe(0)
  })

  it('keeps but skips records it cannot decrypt (keyring reset); a new record for the file replaces them', async () => {
    const fs = memoryFs()
    const first = setup({ fs, cipher: fakeCipher({ key: 'old-key' }) })
    await first.store.remember({ kind: 'pdf', keys: [k('id', 'ID'), k('path', '/a.pdf')], label: 'a', password: 'pw' })
    const { store } = setup({ fs, cipher: fakeCipher({ key: 'new-key' }) })
    expect(await store.find([k('id', 'ID')])).toEqual([])
    expect(await store.list()).toEqual([expect.objectContaining({ label: 'a', unreadable: true })])
    await store.remember({ kind: 'pdf', keys: [k('id', 'ID'), k('path', '/a.pdf')], label: 'a', password: 'pw' })
    const list = await store.list()
    expect(list).toHaveLength(1)
    expect(list[0].unreadable).toBeUndefined()
  })

  it('re-encrypts when the cipher asks (key rotation)', async () => {
    const cipher = fakeCipher({ reencrypt: true })
    const { store } = setup({ cipher })
    await store.remember({ kind: 'pdf', keys: [k('id', 'ID')], label: 'a', password: 'pw' })
    const before = cipher.state.encrypts
    await store.find([k('id', 'ID')])
    expect(cipher.state.encrypts).toBe(before + 1)
    // Re-encrypting is only an upgrade: when it fails, the password is still found.
    cipher.encrypt = async () => {
      throw new Error('keyring went away')
    }
    expect(await store.find([k('id', 'ID')])).toEqual([expect.objectContaining({ password: 'pw' })])
    expect((await store.list())[0].unreadable).toBeUndefined()
  })

  it('stores Digital ID passwords under the certificate hash', async () => {
    const { store } = setup()
    await store.remember({ kind: 'digital-id', keys: [digitalIdKey('ab'.repeat(32))], label: 'Jane Doe', password: 'p12-pass' })
    expect(await store.find([digitalIdKey('AB'.repeat(32))])).toEqual([
      expect.objectContaining({ password: 'p12-pass', via: 'digital-id' })
    ])
    expect((await store.list())[0]).toMatchObject({ kind: 'digital-id', label: 'Jane Doe' })
  })

  it('forget(refs), forget("all"), forgetKeys()', async () => {
    const { store, fs } = setup()
    const a = (await store.remember({ kind: 'pdf', keys: [k('id', 'A')], label: 'a', password: '1' }))!
    await store.remember({ kind: 'pdf', keys: [k('id', 'B')], label: 'b', password: '2' })
    await store.remember({ kind: 'pdf', keys: [k('id', 'C')], label: 'c', password: '3' })
    expect(await store.forget([a])).toBe(1)
    expect(await store.forgetKeys([k('id', 'B')])).toBe(1)
    expect((await store.list()).map((x) => x.label)).toEqual(['c'])
    expect(await store.forget('all')).toBe(1)
    expect(fs.files.has(FILE)).toBe(false)
  })

  it('does not replace a store file it cannot read now (EBUSY): the call fails and the next one reads it again', async () => {
    const fs = memoryFs()
    await setup({ fs }).store.remember({ kind: 'pdf', keys: [k('id', 'A')], label: 'a', password: '1' })
    const before = fs.files.get(FILE)
    const writes = fs.writes
    const read = fs.read
    let busy = 1
    const ebusy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    fs.read = async (path) => {
      if (busy-- > 0) throw ebusy()
      return read(path)
    }
    const { store } = setup({ fs })
    await expect(store.remember({ kind: 'pdf', keys: [k('id', 'B')], label: 'b', password: '2' })).rejects.toThrow('EBUSY')
    expect(fs.files.get(FILE)).toBe(before)
    expect(fs.writes).toBe(writes)
    // Nothing empty was cached: the next call reads the file and keeps what was saved.
    await store.remember({ kind: 'pdf', keys: [k('id', 'B')], label: 'b', password: '2' })
    expect((await store.list()).map((r) => r.label).sort()).toEqual(['a', 'b'])

    // forget('all') (Remove All, the machine policy) still removes a file it cannot read.
    fs.read = async () => {
      throw ebusy()
    }
    expect(await setup({ fs }).store.forget('all')).toBe(0)
    expect(fs.files.has(FILE)).toBe(false)
  })

  it('caps the number of records, dropping the least recently used', async () => {
    const { store } = setup({ max: 2 })
    await store.remember({ kind: 'pdf', keys: [k('id', 'A')], label: 'a', password: '1' })
    await store.remember({ kind: 'pdf', keys: [k('id', 'B')], label: 'b', password: '2' })
    await store.find([k('id', 'A')])
    await store.used('r1', [k('id', 'A')])
    await store.remember({ kind: 'pdf', keys: [k('id', 'C')], label: 'c', password: '3' })
    expect((await store.list()).map((x) => x.label).sort()).toEqual(['a', 'c'])
  })

  it('serialises concurrent calls (two windows opening files at once)', async () => {
    const { store } = setup()
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.remember({ kind: 'pdf', keys: [k('id', `F${i}`)], label: `f${i}`, password: `p${i}` }))
    )
    expect(await store.list()).toHaveLength(20)
    const found = await Promise.all(Array.from({ length: 20 }, (_, i) => store.find([k('id', `F${i}`)])))
    expect(found.map((c) => c[0].password)).toEqual(Array.from({ length: 20 }, (_, i) => `p${i}`))
  })

  it('starts empty on a corrupt or foreign file and ignores malformed records', async () => {
    const fs = memoryFs()
    fs.files.set(FILE, '{not json')
    expect(await setup({ fs }).store.list()).toEqual([])
    fs.files.set(
      FILE,
      JSON.stringify({ version: 1, records: [{ id: 1 }, { id: 'ok', kind: 'pdf', label: 'x', keys: [], secret: '', created: 1, used: 1 }] })
    )
    expect((await setup({ fs }).store.list()).map((r) => r.ref)).toEqual(['ok'])
  })

  it('only uses the keyring when a record matches; savedFor() and count() never decrypt', async () => {
    const { store, cipher } = setup()
    expect(await store.find([k('lock', 'nothing saved')])).toEqual([])
    expect(cipher.state.unavailableCalls).toBe(0)
    const ref = await store.remember({ kind: 'pdf', keys: [k('lock', 'L'), k('path', '/a.pdf')], label: 'a.pdf', level: 'owner', password: 'pw' })
    const decrypts = cipher.state.decrypts
    expect(await store.savedFor([k('path', '/a.pdf')])).toMatchObject({ ref, label: 'a.pdf', level: 'owner' })
    expect(await store.savedFor([k('path', '/b.pdf')])).toBeNull()
    expect(await store.count()).toBe(1)
    expect(cipher.state.decrypts).toBe(decrypts)
  })
})
