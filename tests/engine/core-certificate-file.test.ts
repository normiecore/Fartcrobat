// Certificate encryption, renderer wiring (src/renderer/src/app/certificates.ts): what goes to the
// main process (certkeys:*), the window shown while Windows waits for a smart card PIN, and what an
// agent learns, with a stand-in main process and the app's dialogs resolved by hand.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CertificateLock, CertKeyCandidate, CertKeysDecryptRequest, CertKeysDecryptResult, CertKeysProbeResult, PubSecRecipient } from '@shared/certkeys'
import type { DialogEntry, ProgressEntry } from '@renderer/app/store'
import { certificateFailure } from '@features/agent-access/tools/act-files'

let certificates: typeof import('@renderer/app/certificates')
let useApp: typeof import('@renderer/app/store').useApp

/** What the stand-in main process was asked, in order. */
const invoked: { channel: string; args: unknown[] }[] = []
/** How it answers, by channel. */
let main: Record<string, (...args: any[]) => unknown> = {}

beforeAll(async () => {
  vi.stubGlobal('window', {
    api: {
      platform: 'win32',
      invoke: async (channel: string, ...args: unknown[]) => {
        invoked.push({ channel, args })
        return main[channel]?.(...args)
      },
      on: () => () => {}
    }
  })
  await import('@renderer/app/registry')
  ;({ useApp } = await import('@renderer/app/store'))
  certificates = await import('@renderer/app/certificates')
})

beforeEach(() => {
  // The waiting window shows after a second; the tests move the clock on.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  for (const d of useApp.getState().dialogs) d.resolve(undefined)
  useApp.setState({ dialogs: [], progress: null })
  invoked.length = 0
  main = {}
})

afterEach(() => {
  vi.useRealTimers()
})

const SEED = new Uint8Array(20).fill(7)
const LOCK: CertificateLock = { recipients: [new Uint8Array([1, 2, 3])], version: 4, cipher: 'AESV2', keyBits: 128 }
const RECIPIENTS: PubSecRecipient[] = [{ envelope: 0, index: 0, idType: 'issuerAndSerialNumber', issuer: 'CN=Contoso CA', serial: '1A2B', keyType: 'rsa' }]

function candidate(id: string, o: Partial<CertKeyCandidate> = {}): CertKeyCandidate {
  const source = id.startsWith('windows-store:') ? 'windows-store' : 'digital-id'
  const label = o.label ?? id.split(':')[1]
  return {
    id,
    source,
    label,
    subject: `CN=${label}`,
    issuer: 'CN=Contoso CA',
    fingerprint: id.split(':')[1].toUpperCase(),
    envelope: 0,
    index: 0,
    needs: source === 'windows-store' ? 'pin' : 'password',
    hardware: source === 'windows-store' ? true : false,
    keyType: 'rsa',
    ...o
  }
}

const CARD = candidate('windows-store:cc', { label: 'Alice Card' })

function opened(c: CertKeyCandidate): CertKeysDecryptResult {
  return { ok: true, envelope: 0, seed: SEED, permissions: null, via: { source: c.source, label: c.label, subject: c.subject, fingerprint: c.fingerprint, hardware: !!c.hardware } }
}

function probeWith(result: Partial<CertKeysProbeResult>) {
  main['certkeys:probe'] = () => ({ candidates: [], recipients: RECIPIENTS, ...result })
}

/**
 * certkeys:decrypt answers when the test says so, or CANCELLED when certkeys:cancel names it (as
 * the main process does).
 */
function pendingDecrypts() {
  /** In the order they were asked; `done` once answered. */
  const pending: { request: CertKeysDecryptRequest; answer: (r: CertKeysDecryptResult) => void; done: boolean }[] = []
  main['certkeys:decrypt'] = (request: CertKeysDecryptRequest) =>
    new Promise<CertKeysDecryptResult>((resolve) => {
      const entry = {
        request,
        done: false,
        answer: (r: CertKeysDecryptResult) => {
          entry.done = true
          resolve(r)
        }
      }
      pending.push(entry)
    })
  main['certkeys:cancel'] = (requestId: string) => {
    for (const p of pending) if (!p.done && p.request.requestId === requestId) p.answer({ ok: false, code: 'CANCELLED', message: 'Cancelled.' })
  }
  return pending
}

function open(name: string, opts: { failWithoutKey?: boolean } = {}) {
  return certificates.unlockCertificateFile({ name, certificate: LOCK, attempt: async () => true, actor: 'agent', ...opts })
}

const progress = (): ProgressEntry | null => useApp.getState().progress
const requests = (channel: string) => invoked.filter((c) => c.channel === channel).map((c) => c.args[0])

/** The waiting window, a second after the `count`th decrypt started (the clock is moved on). */
async function waitingWindow(count: number): Promise<ProgressEntry> {
  // Without moving the clock (vi.waitFor would).
  for (let i = 0; i < 1000 && requests('certkeys:decrypt').length < count; i++) await new Promise<void>((r) => queueMicrotask(r))
  expect(requests('certkeys:decrypt')).toHaveLength(count)
  const before = progress()
  await vi.advanceTimersByTimeAsync(999)
  expect(progress()).toBe(before)
  await vi.advanceTimersByTimeAsync(1)
  expect(progress()?.title).toBe('Waiting for your smart card…')
  expect(progress()).not.toBe(before)
  return progress()!
}

async function nextDialog(): Promise<DialogEntry> {
  await vi.waitFor(() => expect(useApp.getState().dialogs.length).toBeGreaterThan(0))
  return useApp.getState().dialogs.at(-1)!
}

describe('certkeys:decrypt and cancelling the wait', () => {
  it('names each decrypt, and Cancel in the waiting window stops it in the main process', async () => {
    probeWith({ candidates: [CARD] })
    const pending = pendingDecrypts()
    const opening = open('card.pdf')
    const shown = await waitingWindow(1)
    const [request] = requests('certkeys:decrypt') as CertKeysDecryptRequest[]
    expect(request).toMatchObject({ candidate: CARD.id, actor: 'agent', blobs: LOCK.recipients })
    expect(request.requestId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)

    shown.cancel!()
    expect(await opening).toBeNull()
    expect(requests('certkeys:cancel')).toEqual([request.requestId])
    expect(pending.every((p) => p.done)).toBe(true)
    expect(progress()).toBeNull()
    expect(useApp.getState().dialogs).toEqual([])
  })

  it('every decrypt gets its own request id', async () => {
    const id = candidate('digital-id:11', { passwordSaved: true })
    probeWith({ candidates: [id] })
    main['certkeys:decrypt'] = () => opened(id)
    expect(await open('a.pdf')).toMatchObject({ via: { label: '11' } })
    expect(await open('b.pdf')).not.toBeNull()
    const ids = (requests('certkeys:decrypt') as CertKeysDecryptRequest[]).map((r) => r.requestId)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(requests('certkeys:cancel')).toEqual([])
  })

  it('a wait that ends never brings back a finished one: two files waiting on smart cards', async () => {
    const covered: ProgressEntry = { title: 'Combining…', fraction: 0.5 }
    useApp.setState({ progress: covered })
    probeWith({ candidates: [CARD] })
    const pending = pendingDecrypts()
    const a = open('a.pdf')
    await waitingWindow(1)
    const b = open('b.pdf')
    await waitingWindow(2)

    // The helper answers in order: the first file opens, the second still waits.
    pending[0].answer(opened(CARD))
    expect(await a).not.toBeNull()
    expect(progress()?.title).toBe('Waiting for your smart card…')
    pending[1].answer(opened(CARD))
    expect(await b).not.toBeNull()
    // What showed before the first wait, not a finished waiting window.
    expect(progress()).toBe(covered)
  })

  it('Cancel stops every file waiting', async () => {
    probeWith({ candidates: [CARD] })
    const pending = pendingDecrypts()
    const a = open('a.pdf')
    await waitingWindow(1)
    const b = open('b.pdf')
    // Cancel in the window b's wait shows stops both.
    ;(await waitingWindow(2)).cancel!()
    expect(await a).toBeNull()
    expect(await b).toBeNull()
    expect(requests('certkeys:cancel')).toHaveLength(2)
    expect(pending.every((p) => p.done)).toBe(true)
    expect(progress()).toBeNull()
  })

  it('another progress shown meanwhile stays', async () => {
    probeWith({ candidates: [CARD] })
    const pending = pendingDecrypts()
    const a = open('a.pdf')
    await waitingWindow(1)
    const other: ProgressEntry = { title: 'Saving…', fraction: null }
    useApp.setState({ progress: other })
    pending[0].answer(opened(CARD))
    expect(await a).not.toBeNull()
    expect(progress()).toBe(other)
  })
})

describe('what the person and agents are told', () => {
  it('no key matches and the Windows store could not be searched: the message says so', async () => {
    probeWith({ candidates: [], windowsStore: 'constrained' })
    const opening = open('locked.pdf', { failWithoutKey: true })
    const d = await nextDialog()
    d.resolve('cancel')
    const err = await opening.then(
      () => null,
      (e) => e
    )
    expect(err).toBeInstanceOf(certificates.CertificateUnavailableError)
    expect(err).toMatchObject({ code: 'NO_CERTIFICATE', unsupportedKey: false, windowsStore: 'constrained' })
    expect(err.message).toMatch(/None of your Digital IDs can open it\. Windows only lets PowerShell run in Constrained Language Mode on this computer, so Fartcrobat cannot use the Windows certificate store\. You can still use a Digital ID\.$/)
    expect(certificateFailure('locked.pdf', err)!.message).toMatch(/could not search the Windows certificate store/)
  })

  it('a key failure the person only acknowledged reaches an agent as a failure, not a cancel', async () => {
    const id = candidate('digital-id:11', { passwordSaved: true, label: 'Alice' })
    probeWith({ candidates: [id] })
    main['certkeys:decrypt'] = (): CertKeysDecryptResult => ({ ok: false, code: 'ID_UNAVAILABLE', message: '' })
    const opening = open('moved.pdf', { failWithoutKey: true })
    const d = await nextDialog()
    d.resolve('cancel') // the only button: OK
    const err = await opening.then(
      () => null,
      (e) => e
    )
    expect(err).toBeInstanceOf(certificates.CertificateKeyFailedError)
    expect(err).toMatchObject({ code: 'CERTIFICATE_FAILED', label: 'Alice', problem: 'ID_UNAVAILABLE' })
    expect(err.message).toMatch(/^The Digital ID file could not be read/)
    expect(certificateFailure('moved.pdf', err)).toMatchObject({ code: 'failed', message: expect.stringContaining('“Alice” could not be used') })

    // The person opening it themselves: told in the dialog, nothing thrown.
    const person = certificates.unlockCertificateFile({ name: 'moved.pdf', certificate: LOCK, attempt: async () => true })
    ;(await nextDialog()).resolve('cancel')
    expect(await person).toBeNull()
  })

  it('Cancel where Try Again was offered is the person cancelling', async () => {
    probeWith({ candidates: [CARD] })
    main['certkeys:decrypt'] = (): CertKeysDecryptResult => ({ ok: false, code: 'CARD_NOT_PRESENT', message: '' })
    const opening = open('card.pdf', { failWithoutKey: true })
    ;(await nextDialog()).resolve('cancel')
    expect(await opening).toBeNull()
  })
})
