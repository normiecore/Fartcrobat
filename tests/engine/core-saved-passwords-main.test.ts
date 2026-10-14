// Saved passwords in the main process: safeStorage behind the cipher (Linux 'v10' means no
// keyring), the test cipher's gate, and the IPC handlers (sender check, no logging, plain errors).
import type { IpcMainInvokeEvent, SafeStorage } from 'electron'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { electronCipher } from '@main/passwords/electronCipher'
import { passwordHandlers, rememberPolicy, senderAllowed } from '@main/passwords/handlers'
import { readPolicyFile } from '@main/policy'
import { SavedPasswordStore } from '@main/passwords/store'
import { testCipher, testCipherEnabled } from '@main/passwords/testCipher'
import type { LockInfo } from '@shared/types'
import { fakeCipher, memoryFs } from './saved-passwords-fakes'

/** safeStorage as Electron 44 behaves: `prefix` is what encryptStringAsync puts in front. */
function mockSafeStorage(o: { prefix: string; available?: boolean; backend?: string; reencrypt?: boolean }) {
  const calls = { encrypt: 0 }
  const storage = {
    isAsyncEncryptionAvailable: async () => o.available ?? true,
    getSelectedStorageBackend: () => o.backend ?? 'basic_text',
    encryptStringAsync: async (text: string) => {
      calls.encrypt++
      return Buffer.concat([Buffer.from(o.prefix, 'latin1'), Buffer.from(text, 'utf8').map((b) => b ^ 0x33)])
    },
    decryptStringAsync: async (data: Buffer) => {
      if (data.subarray(0, 3).toString('latin1') !== o.prefix) throw new Error('Error while decrypting the ciphertext')
      return { result: Buffer.from(data.subarray(3).map((b) => b ^ 0x33)).toString('utf8'), shouldReEncrypt: !!o.reencrypt }
    }
  }
  return { storage: storage as unknown as SafeStorage, calls }
}

const on = () => null

describe('electronCipher', () => {
  it('Linux: a v10 ciphertext means no keyring; nothing is ever encrypted with it', async () => {
    const { storage, calls } = mockSafeStorage({ prefix: 'v10', backend: 'gnome_libsecret' })
    const cipher = electronCipher(storage, { platform: 'linux', disabled: on })
    expect(await cipher.unavailable()).toEqual({ reason: 'no-keyring', backend: 'none' })
    expect(await cipher.unavailable()).toEqual({ reason: 'no-keyring', backend: 'none' })
    expect(calls.encrypt).toBe(1) // probed once per process
    await expect(cipher.encrypt('secret')).rejects.toThrow('No keyring')
    const store = new SavedPasswordStore({ file: '/u/saved-passwords.json', cipher, fs: memoryFs() })
    expect(await store.remember({ kind: 'pdf', keys: ['lock:x'], label: 'a.pdf', password: 'secret' })).toBeNull()
  })

  it('Linux: v11 is a keyring, whatever the sync backend name says', async () => {
    const libsecret = electronCipher(mockSafeStorage({ prefix: 'v11', backend: 'gnome_libsecret' }).storage, { platform: 'linux', disabled: on })
    expect(await libsecret.unavailable()).toBeNull()
    expect(libsecret.backend()).toBe('Secret Service (GNOME Keyring)')
    // i3 or sway: the sync API reports basic_text while the async one uses the keyring.
    const tiling = electronCipher(mockSafeStorage({ prefix: 'v11', backend: 'basic_text' }).storage, { platform: 'linux', disabled: on })
    expect(await tiling.unavailable()).toBeNull()
    expect(tiling.backend()).toBe('Secret Service')
    const text = await tiling.decrypt(await tiling.encrypt('pässwörd ✓'))
    expect(text).toEqual({ text: 'pässwörd ✓', reencrypt: false })
    const off = electronCipher(mockSafeStorage({ prefix: 'v11', available: false }).storage, { platform: 'linux', disabled: on })
    expect(await off.unavailable()).toMatchObject({ reason: 'no-keyring' })
  })

  it('Windows and macOS: v10 is the normal format; failures are errors, not "no keyring"', async () => {
    const win = electronCipher(mockSafeStorage({ prefix: 'v10', reencrypt: true }).storage, { platform: 'win32', disabled: on })
    expect(await win.unavailable()).toBeNull()
    expect(win.backend()).toBe('Windows (DPAPI)')
    expect(await win.decrypt(await win.encrypt('pw'))).toEqual({ text: 'pw', reencrypt: true })
    const mac = electronCipher(mockSafeStorage({ prefix: 'v10', available: false }).storage, { platform: 'darwin', disabled: on })
    expect(await mac.unavailable()).toEqual({ reason: 'error', backend: 'macOS Keychain' })
  })

  it('policy, the Preferences switch and an app that is not ready come first, without touching safeStorage', async () => {
    const { storage, calls } = mockSafeStorage({ prefix: 'v11' })
    let disabled: 'policy' | 'off' | null = 'policy'
    let ready = true
    const cipher = electronCipher(storage, { platform: 'linux', disabled: () => disabled, ready: () => ready })
    expect(await cipher.unavailable()).toMatchObject({ reason: 'policy' })
    disabled = 'off'
    expect(await cipher.unavailable()).toMatchObject({ reason: 'off' })
    disabled = null
    ready = false
    expect(await cipher.unavailable()).toMatchObject({ reason: 'not-ready' })
    expect(calls.encrypt).toBe(0)
  })
})

describe('test cipher', () => {
  it('is only used by unpackaged builds started with FARTCROBAT_TEST_SECRET_CIPHER=1', () => {
    expect(testCipherEnabled(false, { FARTCROBAT_TEST_SECRET_CIPHER: '1' })).toBe(true)
    expect(testCipherEnabled(true, { FARTCROBAT_TEST_SECRET_CIPHER: '1' })).toBe(false)
    expect(testCipherEnabled(false, { FARTCROBAT_TEST_SECRET_CIPHER: 'true' })).toBe(false)
    expect(testCipherEnabled(false, {})).toBe(false)
  })

  it('round-trips without plain text and honours the switches', async () => {
    let disabled: 'policy' | 'off' | null = null
    const cipher = testCipher({ disabled: () => disabled })
    const data = await cipher.encrypt('secret')
    expect(Buffer.from(data).toString('latin1')).not.toContain('secret')
    expect(await cipher.decrypt(data)).toEqual({ text: 'secret', reencrypt: false })
    await expect(cipher.decrypt(new TextEncoder().encode('v11garbage'))).rejects.toThrow()
    disabled = 'policy'
    expect(await cipher.unavailable()).toMatchObject({ reason: 'policy' })
  })
})

describe('machine policy at start-up', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fc-pw-policy-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const policyFile = (content: string) => {
    const file = join(dir, `policy-${Math.random().toString(36).slice(2)}.json`)
    writeFileSync(file, content)
    return file
  }
  const effect = (content: string) => rememberPolicy(readPolicyFile(policyFile(content)).rememberPasswords)

  it('only an explicit "enabled": false wipes saved passwords; a broken file only turns remembering off', () => {
    expect(effect('{"rememberPasswords":{"enabled":false}}')).toEqual({ off: true, wipe: true })
    expect(effect('{"rememberPasswords":{"enabled":true}}')).toEqual({ off: false, wipe: false })
    expect(effect('{"agentAccess":{"enabled":false}}')).toEqual({ off: false, wipe: false })
    // An administrator's typo in a file meant for agent access only.
    expect(effect('{"agentAccess":{"enabled":false},}')).toEqual({ off: true, wipe: false })
    // Trying to turn it on, but not with a boolean, or with a misspelt key.
    expect(effect('{"rememberPasswords":{"enabled":"true"}}')).toEqual({ off: true, wipe: false })
    expect(effect('{"rememberPasswords":{"enable":true}}')).toEqual({ off: true, wipe: false })
    // A file that exists but cannot be read (a folder here: EISDIR, like EACCES or EBUSY).
    expect(rememberPolicy(readPolicyFile(dir).rememberPasswords)).toEqual({ off: true, wipe: false })
    expect(rememberPolicy(readPolicyFile(join(dir, 'missing.json')).rememberPasswords)).toEqual({
      off: false,
      wipe: false
    })
  })
})

describe('passwords:* handlers', () => {
  const lock: LockInfo = { handler: 'Standard', id: 'abcdef', security: 'Filter=Standard;V=5;R=6;U=00' }
  const target = { kind: 'pdf' as const, lock, path: '/home/me/Contracts/secret.pdf' }
  const event = (allowed: boolean) => ({ allowed }) as unknown as IpcMainInvokeEvent
  let consoleCalls: unknown[][]
  beforeEach(() => {
    consoleCalls = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const)
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void consoleCalls.push(args))
  })
  afterEach(() => vi.restoreAllMocks())

  function setup(cipher = fakeCipher()) {
    const fs = memoryFs()
    const store = new SavedPasswordStore({ file: '/u/saved-passwords.json', cipher, fs })
    const used = { store: 0 }
    const handlers = passwordHandlers({
      store: () => {
        used.store++
        return store
      },
      allowed: (e) => (e as unknown as { allowed: boolean }).allowed,
      platform: 'linux',
      policyOff: () => false
    })
    return { handlers, store, fs, used, cipher }
  }

  it('remember, find, used, savedFor and forgetFor through the handlers; labels are never paths', async () => {
    const { handlers, fs } = setup()
    const ok = event(true)
    expect(await handlers['passwords:status'](ok)).toEqual({ available: true, reason: null, backend: 'fake', policy: false, count: 0 })
    const ref = await handlers['passwords:remember'](ok, { target, label: '/home/me/Contracts/secret.pdf', level: 'owner', password: 'hunter2' })
    expect(ref).toMatch(/^r[0-9a-f]{24}$/)
    expect(fs.files.get('/u/saved-passwords.json')).not.toMatch(/hunter2|Contracts|abcdef/)
    const moved = { ...target, path: '/home/me/Archive/secret copy.pdf' }
    expect(await handlers['passwords:find'](ok, moved)).toEqual([{ ref, password: 'hunter2', level: 'owner', via: 'lock' }])
    await handlers['passwords:used'](ok, ref!, moved, { label: 'secret copy.pdf' })
    expect(await handlers['passwords:savedFor'](ok, { kind: 'pdf', lock: null, path: moved.path })).toMatchObject({
      ref,
      label: 'secret copy.pdf',
      level: 'owner'
    })
    expect(await handlers['passwords:list'](ok)).toEqual([expect.objectContaining({ ref, label: 'secret copy.pdf', kind: 'pdf' })])
    expect(await handlers['passwords:forgetFor'](ok, target)).toBe(1)
    expect(await handlers['passwords:status'](ok)).toMatchObject({ count: 0 })
    // A Digital ID's name is not a path, so a slash in it stays.
    const id = { kind: 'digital-id' as const, certificateSha256: 'ab'.repeat(32) }
    await handlers['passwords:remember'](ok, { target: id, label: 'Jane Doe (Sales/EU)', password: 'p12' })
    expect(await handlers['passwords:list'](ok)).toEqual([expect.objectContaining({ kind: 'digital-id', label: 'Jane Doe (Sales/EU)' })])
    expect(consoleCalls).toEqual([])
  })

  it('refuse every other sender before touching the store', async () => {
    const { handlers, used } = setup()
    const bad = event(false)
    const calls: [keyof typeof handlers, unknown[]][] = [
      ['passwords:status', []],
      ['passwords:find', [target]],
      ['passwords:remember', [{ target, label: 'a.pdf', password: 'x' }]],
      ['passwords:used', ['r1', target]],
      ['passwords:failed', ['r1', target]],
      ['passwords:savedFor', [target]],
      ['passwords:list', []],
      ['passwords:forget', ['all']],
      ['passwords:forgetFor', [target]]
    ]
    for (const [channel, args] of calls)
      await expect((handlers[channel] as (...a: unknown[]) => Promise<unknown>)(bad, ...args)).rejects.toThrow(
        'This window may not use saved passwords.'
      )
    expect(used.store).toBe(0)
  })

  it('turn bad input and failures into plain messages, without logging anything', async () => {
    const cipher = fakeCipher()
    const { handlers } = setup(cipher)
    const ok = event(true)
    await expect(handlers['passwords:find'](ok, { kind: 'pdf', lock: { handler: 1 } } as never)).rejects.toThrow('Invalid request for saved passwords.')
    await expect(handlers['passwords:find'](ok, { kind: 'digital-id', certificateSha256: 'not hex' } as never)).rejects.toThrow('Invalid')
    await expect(handlers['passwords:used'](ok, '../../etc', target)).rejects.toThrow('Invalid')
    await expect(handlers['passwords:remember'](ok, { target, label: 'a.pdf', level: 'admin', password: 'x' } as never)).rejects.toThrow('Invalid')
    await expect(handlers['passwords:forget'](ok, 'everything' as never)).rejects.toThrow('Invalid')
    cipher.encrypt = async () => {
      throw new Error('keyring said no to hunter2 for /home/me/secret.pdf')
    }
    const failure = handlers['passwords:remember'](ok, { target, label: 'secret.pdf', password: 'hunter2' })
    await expect(failure).rejects.toThrow('Saved passwords are not available right now.')
    await failure.catch((err: Error) => expect(err.message).not.toMatch(/hunter2|home/))
    expect(consoleCalls).toEqual([])
  })

  it('senderAllowed: only the top frame of an app window showing the app', () => {
    const app = 'app://fartcrobat'
    const ok = { appWindow: true, topFrame: true, url: 'app://fartcrobat/index.html' }
    expect(senderAllowed(ok, [app])).toBe(true)
    expect(senderAllowed({ ...ok, appWindow: false }, [app])).toBe(false)
    expect(senderAllowed({ ...ok, topFrame: false }, [app])).toBe(false)
    expect(senderAllowed({ ...ok, url: 'https://example.com/' }, [app])).toBe(false)
    expect(senderAllowed({ ...ok, url: 'app://fartcrobat.evil/index.html' }, [app])).toBe(false)
    expect(senderAllowed({ ...ok, url: '' }, [app])).toBe(false)
    expect(senderAllowed({ ...ok, url: 'http://localhost:5173/' }, [app, 'http://localhost:5173'])).toBe(true)
  })
})
