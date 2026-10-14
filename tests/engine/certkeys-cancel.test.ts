// Certificate encryption: certkeys:cancel stops a running certkeys:decrypt (the renderer's Cancel in
// "Waiting for your smart card…"). The decrypt answers CANCELLED at once; a Windows store request
// gets the abort signal (the helper stops, which closes Windows' PIN dialog); a Digital ID stops at
// its next step and saves nothing; a result that still comes is wiped. Also: probe results say
// whether the Windows store could be searched.
import { readFileSync } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import { describe, expect, it } from 'vitest'
import { createDigitalIdSource } from '@main/certkeys/digitalIdSource'
import { certKeyHandlers } from '@main/certkeys/handlers'
import { CertKeyError, type SourceDecryptOptions, type SourceDecryptResult } from '@main/certkeys/source'
import { createWindowsStore, type WindowsStore } from '@main/certkeys/windowsStoreSource'
import { SavedPasswordStore } from '@main/passwords/store'
import type { CertKeyCandidate, WindowsStoreState } from '@shared/certkeys'
import { idRecord, recipientsOf } from './certkeys-fixtures'
import { fakeCipher, memoryFs } from './saved-passwords-fakes'

/** An IPC event from window `id`. */
const from = (id: number) => ({ allowed: true, sender: { id } }) as unknown as IpcMainInvokeEvent
const allowed = (e: IpcMainInvokeEvent) => (e as unknown as { allowed: boolean }).allowed

const THUMB = 'AB'.repeat(20)
const storeId = `windows-store:${THUMB}`
const blobs = [new Uint8Array([1, 2, 3])]

function candidate(): CertKeyCandidate {
  return {
    id: storeId,
    source: 'windows-store',
    label: 'Smart Card',
    subject: 'CN=Smart Card',
    issuer: 'CN=CA',
    fingerprint: THUMB,
    envelope: 0,
    index: 0,
    needs: 'pin',
    hardware: true,
    keyType: 'rsa'
  }
}

/**
 * A Windows store whose decrypt waits for the person (the PIN dialog) until it is aborted, as the
 * helper does: abort means CANCELLED. `finish` answers it instead.
 */
function waitingStore(state: WindowsStoreState = 'available') {
  const signals: (AbortSignal | undefined)[] = []
  let finish: (r: SourceDecryptResult) => void = () => undefined
  const store: WindowsStore = {
    kind: 'windows-store',
    state: async () => state,
    running: () => true,
    probe: async () => [candidate()],
    decrypt: (_blobs, _c, opts: SourceDecryptOptions) => {
      signals.push(opts.signal)
      return new Promise((resolve, reject) => {
        finish = resolve
        opts.signal?.addEventListener('abort', () => reject(new CertKeyError('CANCELLED', 'Cancelled.')))
      })
    },
    listEncryptionCertificates: async () => [],
    stop: () => undefined
  }
  return { store, signals, finish: (r: SourceDecryptResult) => finish(r) }
}

const noIds = () =>
  createDigitalIdSource({ records: () => [], passwords: () => ({}) as never, remembering: () => false })

/** Resolves once `p` has settled or `ms` passed, with what it gave (or 'pending'). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  return Promise.race([p, new Promise<'pending'>((r) => setTimeout(() => r('pending'), ms))])
}

describe('certkeys:cancel', () => {
  it('stops a Windows store decrypt waiting for the PIN: CANCELLED at once, the helper gets the abort', async () => {
    const { store, signals } = waitingStore()
    const h = certKeyHandlers({ allowed, digitalIds: noIds(), windowsStore: store })
    const pending = h['certkeys:decrypt'](from(1), {
      blobs,
      candidate: storeId,
      actor: 'person',
      requestId: 'open-1'
    })
    expect(await within(pending, 50)).toBe('pending')
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(false)
    await h['certkeys:cancel'](from(1), 'open-1')
    expect(await within(pending, 1000)).toEqual({ ok: false, code: 'CANCELLED', message: 'Cancelled.' })
    expect(signals[0]?.aborted).toBe(true)
    // cancelling again, or an id nobody uses, does nothing
    await h['certkeys:cancel'](from(1), 'open-1')
    await h['certkeys:cancel'](from(1), 'unknown')
  })

  it('only stops the request of the window that sent it, and every request with that id', async () => {
    const { store, signals } = waitingStore()
    const h = certKeyHandlers({ allowed, digitalIds: noIds(), windowsStore: store })
    const run = (win: number, id: string) =>
      h['certkeys:decrypt'](from(win), { blobs, candidate: storeId, actor: 'person', requestId: id })
    const a = run(1, 'same')
    const b = run(2, 'same')
    const c = run(1, 'same')
    const d = run(1, 'other')
    expect(await within(a, 50)).toBe('pending')
    await h['certkeys:cancel'](from(1), 'same')
    expect(await within(a, 1000)).toMatchObject({ code: 'CANCELLED' })
    expect(await within(c, 1000)).toMatchObject({ code: 'CANCELLED' })
    expect(await within(b, 50)).toBe('pending')
    expect(await within(d, 50)).toBe('pending')
    expect(signals.map((s) => s?.aborted)).toEqual([true, false, true, false])
    await h['certkeys:cancel'](from(2), 'same')
    await h['certkeys:cancel'](from(1), 'other')
    expect(await b).toMatchObject({ code: 'CANCELLED' })
    expect(await d).toMatchObject({ code: 'CANCELLED' })
  })

  it('answers at once even when the source does not stop, and wipes what it gives later', async () => {
    let finish: (r: SourceDecryptResult) => void = () => undefined
    const store: WindowsStore = {
      ...waitingStore().store,
      // ignores the signal
      decrypt: () => new Promise((resolve) => (finish = resolve))
    }
    const h = certKeyHandlers({ allowed, digitalIds: noIds(), windowsStore: store })
    const pending = h['certkeys:decrypt'](from(1), {
      blobs,
      candidate: storeId,
      actor: 'agent',
      requestId: 'x'
    })
    await within(pending, 20)
    await h['certkeys:cancel'](from(1), 'x')
    expect(await within(pending, 1000)).toMatchObject({ ok: false, code: 'CANCELLED' })
    const content = new Uint8Array(24).fill(7)
    finish({
      envelope: 0,
      content,
      via: { source: 'windows-store', label: 'x', subject: 'CN=x', fingerprint: THUMB, hardware: true }
    })
    await new Promise((r) => setTimeout(r, 10))
    expect([...content]).toEqual(new Array(24).fill(0))
  })

  it('a decrypt without a requestId still works, and cannot be cancelled by guessing', async () => {
    const { store, finish } = waitingStore()
    const h = certKeyHandlers({ allowed, digitalIds: noIds(), windowsStore: store })
    const pending = h['certkeys:decrypt'](from(1), { blobs, candidate: storeId, actor: 'person' })
    await within(pending, 20)
    await h['certkeys:cancel'](from(1), 'undefined')
    expect(await within(pending, 50)).toBe('pending')
    finish({
      envelope: 0,
      content: new Uint8Array(24).fill(1),
      via: { source: 'windows-store', label: 'x', subject: 'CN=x', fingerprint: THUMB, hardware: true }
    })
    expect(await pending).toMatchObject({ ok: true, seed: new Uint8Array(20).fill(1) })
  })

  it('refuses bad request ids', async () => {
    const { store, signals } = waitingStore()
    const h = certKeyHandlers({ allowed, digitalIds: noIds(), windowsStore: store })
    for (const requestId of ['', 'a b', 'x'.repeat(65), '../x', 'é', 42, null, {}]) {
      await expect(h['certkeys:cancel'](from(1), requestId as never)).rejects.toThrow(
        'Invalid request for certificates.'
      )
      await expect(
        h['certkeys:decrypt'](from(1), {
          blobs,
          candidate: storeId,
          actor: 'person',
          requestId: requestId as never
        })
      ).rejects.toThrow('Invalid request for certificates.')
    }
    expect(signals).toEqual([])
    // the longest id is fine
    const id = 'A-z_0'.repeat(12) + 'abcd'
    expect(id).toHaveLength(64)
    const pending = h['certkeys:decrypt'](from(1), {
      blobs,
      candidate: storeId,
      actor: 'person',
      requestId: id
    })
    await within(pending, 20)
    await h['certkeys:cancel'](from(1), id)
    expect(await pending).toMatchObject({ code: 'CANCELLED' })
  })

  it('stops a Digital ID before it opens the .p12, and saves no password for a cancelled open', async () => {
    const passwords = new SavedPasswordStore({
      file: '/u/saved-passwords.json',
      cipher: fakeCipher(),
      fs: memoryFs()
    })
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    let reads = 0
    const digitalIds = createDigitalIdSource({
      records: () => [idRecord('alice')],
      passwords: () => passwords,
      remembering: () => true,
      // a slow disk
      readFile: async (path) => {
        reads++
        await gate
        return new Uint8Array(readFileSync(path))
      }
    })
    const h = certKeyHandlers({ allowed, digitalIds, windowsStore: waitingStore().store })
    const pending = h['certkeys:decrypt'](from(3), {
      blobs: recipientsOf('v5-classic.pdf'),
      candidate: `digital-id:${idRecord('alice').id}`,
      password: 'alice-pass',
      remember: true,
      actor: 'person',
      requestId: 'id-open'
    })
    await within(pending, 50)
    expect(reads).toBe(1)
    await h['certkeys:cancel'](from(3), 'id-open')
    expect(await within(pending, 1000)).toMatchObject({ ok: false, code: 'CANCELLED' })
    release()
    await new Promise((r) => setTimeout(r, 200))
    expect(await passwords.count()).toBe(0)
  })

  it('the Windows store source answers CANCELLED for an aborted request without starting PowerShell', async () => {
    const store = createWindowsStore({
      platform: 'win32',
      enabled: () => true,
      powershellPath: '/nonexistent/powershell.exe'
    })
    const ac = new AbortController()
    ac.abort()
    const err = await store
      .decrypt(blobs, candidate(), { actor: 'person', signal: ac.signal })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CertKeyError)
    expect((err as CertKeyError).code).toBe('CANCELLED')
    // it was never started, so it is not marked as unavailable
    expect(await store.state()).toBe('available')
  })
})

describe('certkeys:probe', () => {
  it('says whether the Windows store could be searched', async () => {
    for (const state of ['available', 'constrained', 'unavailable', 'off', 'not-windows'] as const) {
      const h = certKeyHandlers({ allowed, digitalIds: noIds(), windowsStore: waitingStore(state).store })
      expect((await h['certkeys:probe'](from(1), { blobs })).windowsStore).toBe(state)
    }
    const broken = waitingStore().store
    broken.state = async () => {
      throw new Error('C:\\secret')
    }
    const h = certKeyHandlers({ allowed, digitalIds: noIds(), windowsStore: broken })
    expect((await h['certkeys:probe'](from(1), { blobs })).windowsStore).toBe('unavailable')
    const stub = certKeyHandlers({
      allowed,
      digitalIds: noIds(),
      windowsStore: createWindowsStore({ platform: 'linux', enabled: () => true })
    })
    expect((await stub['certkeys:probe'](from(1), { blobs })).windowsStore).toBe('not-windows')
  })

  it("a store that did not answer in time is 'busy', and a decrypt that probes again says TIMEOUT", async () => {
    // The helper was busy with another request (a smart card waiting for its PIN) for too long:
    // the person must not be told that none of their certificates opens the file.
    const { store } = waitingStore()
    store.probe = async () => {
      throw new CertKeyError('TIMEOUT', 'busy')
    }
    const h = certKeyHandlers({ allowed, digitalIds: noIds(), windowsStore: store })
    expect(await h['certkeys:probe'](from(1), { blobs })).toMatchObject({ candidates: [], windowsStore: 'busy' })
    expect(await h['certkeys:decrypt'](from(1), { blobs, candidate: storeId, actor: 'person' })).toMatchObject({
      ok: false,
      code: 'TIMEOUT',
      message: expect.stringMatching(/did not answer in time/)
    })
    // Any other probe failure is still "no match" (state() says when the store cannot be used).
    store.probe = async () => {
      throw new CertKeyError('ERROR', 'failed')
    }
    expect(await h['certkeys:probe'](from(1), { blobs })).toMatchObject({ windowsStore: 'available' })
    expect(await h['certkeys:decrypt'](from(1), { blobs, candidate: storeId, actor: 'person' })).toMatchObject({
      code: 'NO_MATCHING_CERT'
    })
  })
})
