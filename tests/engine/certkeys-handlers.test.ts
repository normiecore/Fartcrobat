// Certificate encryption: the 'certkeys:*' IPC handlers (sender check, argument checks, no
// logging, candidate order, re-probing on decrypt, failures returned as results).
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDigitalIdSource } from '@main/certkeys/digitalIdSource'
import {
  certKeyHandlers,
  CERTKEY_LIMITS,
  orderCandidates,
  type CertKeyHandlers
} from '@main/certkeys/handlers'
import { CertKeyError, type RecipientKeySource, type SourceDecryptOptions } from '@main/certkeys/source'
import { createWindowsStore, type WindowsStore } from '@main/certkeys/windowsStoreSource'
import { SavedPasswordStore } from '@main/passwords/store'
import type { CertKeyCandidate, EncryptionCertificate } from '@shared/certkeys'
import { expectedFile, idRecord, recipientsOf } from './certkeys-fixtures'
import { fakeCipher, memoryFs } from './saved-passwords-fakes'

const event = (allowed: boolean) => ({ allowed }) as unknown as IpcMainInvokeEvent
const ok = event(true)
const allowed = (e: IpcMainInvokeEvent) => (e as unknown as { allowed: boolean }).allowed

const sha1 = (n: number) => n.toString(16).padStart(40, '0').toUpperCase()
const sha256 = (n: number) => n.toString(16).padStart(64, '0').toUpperCase()

function candidate(o: Partial<CertKeyCandidate> & Pick<CertKeyCandidate, 'id' | 'source'>): CertKeyCandidate {
  return {
    label: o.id,
    subject: 'CN=Someone',
    issuer: 'CN=Some CA',
    fingerprint: o.id.split(':')[1],
    envelope: 0,
    index: 0,
    needs: o.source === 'digital-id' ? 'password' : 'nothing',
    hardware: false,
    keyType: 'rsa',
    ...o
  }
}

/** A Windows store that returns fixed candidates and counts every call. */
function fakeStore(candidates: CertKeyCandidate[] = [], decrypt?: WindowsStore['decrypt']) {
  const calls: string[] = []
  const store: WindowsStore & {
    calls: string[]
    decrypted: { candidate: CertKeyCandidate; opts: SourceDecryptOptions }[]
  } = {
    kind: 'windows-store',
    calls,
    decrypted: [],
    state: async () => {
      calls.push('state')
      return 'available'
    },
    running: () => {
      calls.push('running')
      return true
    },
    probe: async () => {
      calls.push('probe')
      return candidates.map((c) => ({ ...c }))
    },
    decrypt: async (blobs, c, opts) => {
      calls.push('decrypt')
      store.decrypted.push({ candidate: c, opts })
      if (decrypt) return decrypt(blobs, c, opts)
      throw new CertKeyError('CANCELLED', 'You cancelled.')
    },
    listEncryptionCertificates: async (opts) => {
      calls.push(`list:${opts.includeOthers}`)
      return [{ thumbprint: sha1(1) } as EncryptionCertificate]
    },
    stop: () => void calls.push('stop')
  }
  return store
}

function fakeIds(candidates: CertKeyCandidate[] = [], decrypt?: RecipientKeySource['decrypt']) {
  const calls: string[] = []
  return {
    kind: 'digital-id' as const,
    calls,
    count: () => candidates.length,
    probe: async () => {
      calls.push('probe')
      return candidates.map((c) => ({ ...c }))
    },
    decrypt: async (blobs: Uint8Array[], c: CertKeyCandidate, opts: SourceDecryptOptions) => {
      calls.push('decrypt')
      if (decrypt) return decrypt(blobs, c, opts)
      throw new Error('should not be called')
    }
  }
}

/** The real Digital ID source with the fixture IDs, behind the handlers. */
function realSetup() {
  const store = new SavedPasswordStore({
    file: '/u/saved-passwords.json',
    cipher: fakeCipher(),
    fs: memoryFs()
  })
  const digitalIds = createDigitalIdSource({
    records: () => ['alice', 'bob', 'stranger', 'ec'].map((n) => idRecord(n)),
    passwords: () => store,
    remembering: () => true
  })
  const windowsStore = createWindowsStore({ platform: 'linux', enabled: () => true })
  return { handlers: certKeyHandlers({ allowed, digitalIds, windowsStore }), store }
}

let consoleCalls: unknown[][]
beforeEach(() => {
  consoleCalls = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const)
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void consoleCalls.push(args))
})
afterEach(() => {
  vi.restoreAllMocks()
  expect(consoleCalls).toEqual([])
})

const blobs = [new Uint8Array([1, 2, 3])]
const aliceId = `digital-id:${idRecord('alice').id}`

describe('certkeys:* handlers', () => {
  it('refuse every other sender before touching a source', async () => {
    const windowsStore = fakeStore()
    const digitalIds = fakeIds()
    const handlers = certKeyHandlers({ allowed, digitalIds, windowsStore })
    const bad = event(false)
    const calls: [keyof CertKeyHandlers, unknown[]][] = [
      ['certkeys:status', []],
      ['certkeys:probe', [{ blobs }]],
      ['certkeys:decrypt', [{ blobs, candidate: aliceId, actor: 'person' }]],
      ['certkeys:listEncryptionCertificates', [{ includeOthers: true }]],
      ['certkeys:lockSmartCard', []],
      ['certkeys:cancel', ['request-1']]
    ]
    for (const [channel, args] of calls)
      await expect(
        (handlers[channel] as (...a: unknown[]) => Promise<unknown>)(bad, ...args)
      ).rejects.toThrow('This window may not use your certificates.')
    expect(windowsStore.calls).toEqual([])
    expect(digitalIds.calls).toEqual([])
  })

  it('refuse bad arguments with a generic message', async () => {
    const windowsStore = fakeStore()
    const digitalIds = fakeIds()
    const h = certKeyHandlers({ allowed, digitalIds, windowsStore })
    const decrypt = (r: unknown) => h['certkeys:decrypt'](ok, r as never)
    const probe = (r: unknown) => h['certkeys:probe'](ok, r as never)
    const good = { blobs, candidate: aliceId, actor: 'person' }
    const badRequests: unknown[] = [
      null,
      'blobs',
      [],
      { ...good, blobs: 'x' },
      { ...good, blobs: [[1, 2, 3]] },
      { ...good, blobs: [new Uint16Array(3)] },
      { ...good, blobs: new Array(CERTKEY_LIMITS.blobs + 1).fill(new Uint8Array(1)) },
      { ...good, blobs: [new Uint8Array(CERTKEY_LIMITS.blobBytes + 1)] },
      { ...good, candidate: 'digital-id:../../etc/passwd' },
      { ...good, candidate: `windows-store:${sha256(1)}` },
      { ...good, candidate: `digital-id:${sha1(1)}` },
      { ...good, candidate: 42 },
      { ...good, password: 1234 },
      { ...good, password: 'x'.repeat(CERTKEY_LIMITS.password + 1) },
      { ...good, remember: 'yes' },
      { ...good, actor: 'robot' },
      { blobs, candidate: aliceId }
    ]
    for (const r of badRequests) await expect(decrypt(r)).rejects.toThrow('Invalid request for certificates.')
    for (const r of badRequests.slice(0, 8))
      await expect(probe(r)).rejects.toThrow('Invalid request for certificates.')
    await expect(h['certkeys:listEncryptionCertificates'](ok, {} as never)).rejects.toThrow(
      'Invalid request for certificates.'
    )
    await expect(h['certkeys:listEncryptionCertificates'](ok, null as never)).rejects.toThrow(
      'Invalid request for certificates.'
    )
    expect(windowsStore.calls).toEqual([])
    expect(digitalIds.calls).toEqual([])
    // At the limits is fine.
    await expect(probe({ blobs: [new Uint8Array(CERTKEY_LIMITS.blobBytes)] })).resolves.toMatchObject({
      candidates: []
    })
    await expect(
      decrypt({ ...good, password: 'x'.repeat(CERTKEY_LIMITS.password), remember: true, actor: 'agent' })
    ).resolves.toMatchObject({ ok: false })
  })

  it('probe orders candidates: store keys needing nothing, saved Digital IDs, hardware keys, other IDs, then EC', async () => {
    const ws = (n: number, o: Partial<CertKeyCandidate> = {}) =>
      candidate({ id: `windows-store:${sha1(n)}`, source: 'windows-store', ...o })
    const di = (n: number, o: Partial<CertKeyCandidate> = {}) =>
      candidate({ id: `digital-id:${sha256(n)}`, source: 'digital-id', ...o })
    const windowsStore = fakeStore([
      ws(1, { hardware: true, needs: 'pin', label: 'card' }),
      ws(2, { hardware: null, label: 'store unknown' }),
      ws(3, { keyType: 'ec', label: 'store ec' }),
      ws(4, { label: 'store software' }),
      // Not a Windows store id: dropped.
      di(9, { source: 'windows-store', label: 'impostor' })
    ])
    const digitalIds = fakeIds([
      di(1, { label: 'id ec', keyType: 'ec', passwordSaved: true }),
      di(2, { label: 'id plain' }),
      di(3, { label: 'id saved', passwordSaved: true })
    ])
    const h = certKeyHandlers({ allowed, digitalIds, windowsStore })
    const r = await h['certkeys:probe'](ok, { blobs: recipientsOf('v5-two-recipients.pdf') })
    expect(r.candidates.map((c) => c.label)).toEqual([
      'store unknown',
      'store software',
      'id saved',
      'card',
      'id plain',
      'store ec',
      'id ec'
    ])
    expect(r.recipients).toHaveLength(2)
    expect(orderCandidates([])).toEqual([])
  })

  it('probe: a source that fails finds nothing, the other still answers', async () => {
    const windowsStore = fakeStore()
    windowsStore.probe = async () => {
      throw new Error('powershell said C:\\Users\\me\\secret')
    }
    const { handlers } = realSetup()
    const h = certKeyHandlers({
      allowed,
      digitalIds: createDigitalIdSource({
        records: () => [idRecord('alice')],
        passwords: () => ({}) as never,
        remembering: () => false
      }),
      windowsStore
    })
    const r = await h['certkeys:probe'](ok, { blobs: recipientsOf('v5-classic.pdf') })
    expect(r.candidates.map((c) => c.label)).toEqual(['Alice Test'])
    expect(
      (await handlers['certkeys:probe'](ok, { blobs: recipientsOf('stranger-only.pdf') })).candidates.map(
        (c) => c.label
      )
    ).toEqual(['Stranger Test'])
  })

  it('decrypt with real Digital IDs: seed and permissions split from the content, envelope index, via', async () => {
    const { handlers, store } = realSetup()
    const file = expectedFile('v5-two-envelopes.pdf')
    const blobs = recipientsOf(file.file)
    const probe = await handlers['certkeys:probe'](ok, { blobs })
    expect(probe.candidates.map((c) => [c.label, c.envelope])).toEqual([
      ['Alice Test', 1],
      ['Bob Tëst', 0]
    ])
    expect(probe.recipients.map((r) => r.envelope)).toEqual([0, 1])
    const needed = await handlers['certkeys:decrypt'](ok, { blobs, candidate: aliceId, actor: 'agent' })
    expect(needed).toEqual({
      ok: false,
      code: 'PASSWORD_NEEDED',
      message: 'Enter the password of the Digital ID “Alice Test”.'
    })
    const wrong = await handlers['certkeys:decrypt'](ok, {
      blobs,
      candidate: aliceId,
      password: 'guess',
      actor: 'person'
    })
    expect(wrong).toMatchObject({ ok: false, code: 'WRONG_PASSWORD' })
    const r = await handlers['certkeys:decrypt'](ok, {
      blobs,
      candidate: aliceId.toLowerCase(),
      password: 'alice-pass',
      remember: true,
      actor: 'person'
    })
    if (!r.ok) throw new Error(r.message)
    expect(r.envelope).toBe(1)
    expect(Buffer.from(r.seed).toString('hex')).toBe(file.seedHex.alice)
    expect(r.permissions).toBe(file.permissions.alice)
    expect(r.permissions).toBe(0xfffff8c5)
    expect(r.via).toMatchObject({
      source: 'digital-id',
      label: 'Alice Test',
      remembered: true,
      hardware: false
    })
    expect(await store.count()).toBe(1)
    const silent = await handlers['certkeys:decrypt'](ok, { blobs, candidate: aliceId, actor: 'agent' })
    expect(silent).toMatchObject({ ok: true, envelope: 1, via: { savedPassword: true } })
    // Not a recipient: the renderer's candidate id is checked against a fresh probe.
    const stranger = await handlers['certkeys:decrypt'](ok, {
      blobs,
      candidate: `digital-id:${idRecord('stranger').id}`,
      password: 'stranger-pass',
      actor: 'person'
    })
    expect(stranger).toMatchObject({ ok: false, code: 'NO_MATCHING_CERT' })
    // EC
    const ec = await handlers['certkeys:decrypt'](ok, {
      blobs: recipientsOf('v5-ec.pdf'),
      candidate: `digital-id:${idRecord('ec').id}`,
      password: 'ec-pass',
      actor: 'person'
    })
    expect(ec).toMatchObject({ ok: false, code: 'UNSUPPORTED' })
    // The real Windows store on 'linux' (no PowerShell) finds no keys, so the re-probe has no such candidate.
    const ws = await handlers['certkeys:decrypt'](ok, {
      blobs,
      candidate: `windows-store:${sha1(5)}`,
      actor: 'person'
    })
    expect(ws).toMatchObject({ ok: false, code: 'NO_MATCHING_CERT' })
  })

  it('decrypt re-probes and hands the source its own candidate, never the renderer’s fields', async () => {
    const id = `windows-store:${sha1(7)}`
    const windowsStore = fakeStore(
      [candidate({ id, source: 'windows-store', envelope: 0, label: 'mine', hardware: true })],
      async () => ({
        envelope: 0,
        content: new Uint8Array(24).fill(1),
        via: {
          source: 'windows-store',
          label: 'mine',
          subject: 'CN=Me',
          fingerprint: sha1(7),
          hardware: true,
          extra: 'dropped'
        } as never
      })
    )
    const h = certKeyHandlers({ allowed, digitalIds: fakeIds(), windowsStore })
    const r = await h['certkeys:decrypt'](ok, {
      blobs,
      candidate: id.toLowerCase(),
      actor: 'agent',
      label: 'forged',
      envelope: 9
    } as never)
    expect(r).toEqual({
      ok: true,
      envelope: 0,
      seed: new Uint8Array(20).fill(1),
      permissions: 0x01010101,
      via: { source: 'windows-store', label: 'mine', subject: 'CN=Me', fingerprint: sha1(7), hardware: true }
    })
    expect(windowsStore.calls).toEqual(['probe', 'decrypt'])
    expect(windowsStore.decrypted[0].candidate).toMatchObject({ id, label: 'mine', hardware: true })
    expect(windowsStore.decrypted[0].opts).toEqual({
      remember: false,
      actor: 'agent',
      signal: expect.any(AbortSignal)
    })
  })

  it('decrypt failures come back as results, with plain messages', async () => {
    const id = `windows-store:${sha1(7)}`
    const store = (decrypt: WindowsStore['decrypt']) =>
      certKeyHandlers({
        allowed,
        digitalIds: fakeIds(),
        windowsStore: fakeStore([candidate({ id, source: 'windows-store' })], decrypt)
      })
    const run = (decrypt: WindowsStore['decrypt']) =>
      store(decrypt)['certkeys:decrypt'](ok, { blobs, candidate: id, actor: 'person' })
    expect(
      await run(async () => Promise.reject(new CertKeyError('WRONG_PIN', 'The PIN is incorrect.')))
    ).toEqual({ ok: false, code: 'WRONG_PIN', message: 'The PIN is incorrect.' })
    expect(
      await run(async () =>
        Promise.reject(new CertKeyError('PASSWORD_NEEDED', 'Enter it.', { savedStale: true }))
      )
    ).toEqual({
      ok: false,
      code: 'PASSWORD_NEEDED',
      message: 'Enter it.',
      savedStale: true
    })
    const leak = await run(async () =>
      Promise.reject(new Error('seed 0011 at C:\\Users\\me\\key.pfx with password hunter2'))
    )
    expect(leak).toEqual({
      ok: false,
      code: 'ERROR',
      message: 'The document could not be opened with this certificate.'
    })
    const via = {
      source: 'windows-store' as const,
      label: 'x',
      subject: 'CN=x',
      fingerprint: sha1(7),
      hardware: false
    }
    expect(await run(async () => ({ envelope: 0, content: new Uint8Array(19), via }))).toMatchObject({
      ok: false,
      code: 'ERROR'
    })
    expect(await run(async () => ({ envelope: 3, content: new Uint8Array(24), via }))).toMatchObject({
      ok: false,
      code: 'ERROR'
    })
    expect(await run(async () => ({ envelope: 0, content: 'x' as never, via }))).toMatchObject({
      ok: false,
      code: 'ERROR'
    })
    // 22 bytes, shorter than a seed and 4 permission bytes: the first 20 are the seed, no permissions.
    const bare = await run(async () => ({ envelope: 0, content: new Uint8Array(22).fill(2), via }))
    expect(bare).toMatchObject({ ok: true, permissions: null, seed: new Uint8Array(20).fill(2) })
    // A probe that fails while decrypting.
    const broken = fakeStore()
    broken.probe = async () => {
      throw new Error('boom')
    }
    const h = certKeyHandlers({ allowed, digitalIds: fakeIds(), windowsStore: broken })
    expect(await h['certkeys:decrypt'](ok, { blobs, candidate: id, actor: 'person' })).toMatchObject({
      ok: false,
      code: 'NO_MATCHING_CERT'
    })
  })

  it('status, listEncryptionCertificates and lockSmartCard (which stops the helper)', async () => {
    const windowsStore = fakeStore()
    const h = certKeyHandlers({
      allowed,
      digitalIds: fakeIds([candidate({ id: aliceId, source: 'digital-id' })]),
      windowsStore
    })
    expect(await h['certkeys:status'](ok)).toEqual({
      windowsStore: 'available',
      digitalIds: 1,
      helperRunning: true
    })
    expect(await h['certkeys:listEncryptionCertificates'](ok, { includeOthers: true })).toEqual([
      { thumbprint: sha1(1) }
    ])
    await h['certkeys:lockSmartCard'](ok)
    expect(windowsStore.calls).toEqual(['state', 'running', 'list:true', 'stop'])
    windowsStore.listEncryptionCertificates = async () => {
      throw new Error('C:\\secret')
    }
    await expect(h['certkeys:listEncryptionCertificates'](ok, { includeOthers: false })).rejects.toThrow(
      'Your certificates and Digital IDs are not available right now.'
    )
    const stub = realSetup().handlers
    expect(await stub['certkeys:status'](ok)).toEqual({
      windowsStore: 'not-windows',
      digitalIds: 4,
      helperRunning: false
    })
  })
})
