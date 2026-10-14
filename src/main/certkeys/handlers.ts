/**
 * The 'certkeys:*' IPC handlers, without Electron (index.ts wires them in). Every handler:
 *  - answers only the top frame of an app window loaded from the app itself (senderAllowed, as for
 *    saved passwords);
 *  - checks the shape and size of what it was sent;
 *  - logs nothing, and turns every unexpected failure into a generic message, so no secret, path
 *    or key can leak through a log or an error.
 *
 * certkeys:decrypt never trusts a candidate from the renderer: it probes the source again with the
 * same envelopes and uses the source's own candidate with that id. Its failures come back as
 * { ok: false, code, message }, not as errors. certkeys:cancel stops one by its requestId (only
 * for the window that sent it): it answers CANCELLED at once. A Windows store request in the
 * helper then stops the helper (Windows closes its PIN dialog and forgets a PIN entered in it); a
 * Digital ID stops at its next step and keeps nothing it would have saved.
 */
import type { IpcMainInvokeEvent } from 'electron'
import {
  PUBSEC_RECIPIENT_LIMITS,
  type CertKeyActor,
  type CertKeyCandidate,
  type CertKeysDecryptResult,
  type CertKeyVia,
  type WindowsStoreState
} from '@shared/certkeys'
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import { describeRecipients } from '@features/digital-signatures/lib/envelope'
import { requestEnvelopes } from './envelopes'
import { CertKeyError, type RecipientKeySource } from './source'
import type { WindowsStore } from './windowsStoreSource'

export type CertKeyChannel = Extract<IpcChannel, `certkeys:${string}`>

export type CertKeyHandlers = {
  [K in CertKeyChannel]: (event: IpcMainInvokeEvent, ...args: IpcArgs<K>) => Promise<IpcResult<K>>
}

export interface CertKeyHandlerDeps {
  /** Whether an IPC event may use the person's keys (see senderAllowed in ../passwords/handlers). */
  allowed: (event: IpcMainInvokeEvent) => boolean
  /** Digital IDs from Preferences > Digital IDs. */
  digitalIds: RecipientKeySource & { count(): number }
  /** The Windows certificate store and smart cards (a stub that finds nothing elsewhere). */
  windowsStore: WindowsStore
}

/**
 * Limits on what the renderer may send, and on the recipients sent back. The /Recipients come from
 * the file, so they are bounded before anything is parsed (and envelopes.ts bounds the parsing).
 */
export const CERTKEY_LIMITS = {
  /** Envelopes (/Recipients entries) per request: what the engine opens (PUBSEC_RECIPIENT_LIMITS). */
  blobs: PUBSEC_RECIPIENT_LIMITS.envelopes,
  /** Bytes per envelope, and in all. */
  blobBytes: PUBSEC_RECIPIENT_LIMITS.envelopeBytes,
  totalBytes: PUBSEC_RECIPIENT_LIMITS.totalBytes,
  /** Recipients described in a probe result (the renderer names a few). */
  recipients: 1000,
  password: 4096
} as const

const SEED_BYTES = 20
const CANDIDATE_ID = /^(?:digital-id:[0-9a-fA-F]{64}|windows-store:[0-9a-fA-F]{40})$/
/** CertKeysDecryptRequest.requestId. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/

const REFUSED = 'This window may not use your certificates.'
const INVALID = 'Invalid request for certificates.'
const UNAVAILABLE = 'Your certificates and Digital IDs are not available right now.'
const FAILED = 'The document could not be opened with this certificate.'
const CANCELLED = 'Cancelled.'

class RequestError extends Error {}

function parseBlobs(v: unknown): Uint8Array[] {
  if (!Array.isArray(v) || v.length > CERTKEY_LIMITS.blobs) throw new RequestError()
  let total = 0
  for (const b of v) {
    if (!(b instanceof Uint8Array) || b.length > CERTKEY_LIMITS.blobBytes) throw new RequestError()
    total += b.length
  }
  if (total > CERTKEY_LIMITS.totalBytes) throw new RequestError()
  return v as Uint8Array[]
}

function parseRequest(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new RequestError()
  return v as Record<string, unknown>
}

interface DecryptRequest {
  blobs: Uint8Array[]
  candidate: string
  password?: string
  remember: boolean
  actor: CertKeyActor
  requestId?: string
}

function parseRequestId(v: unknown): string {
  if (typeof v !== 'string' || !REQUEST_ID.test(v)) throw new RequestError()
  return v
}

function parseDecrypt(v: unknown): DecryptRequest {
  const r = parseRequest(v)
  const blobs = parseBlobs(r.blobs)
  if (typeof r.candidate !== 'string' || !CANDIDATE_ID.test(r.candidate)) throw new RequestError()
  const password = r.password ?? undefined
  if (password !== undefined && (typeof password !== 'string' || password.length > CERTKEY_LIMITS.password))
    throw new RequestError()
  const remember = r.remember ?? false
  if (typeof remember !== 'boolean') throw new RequestError()
  if (r.actor !== 'person' && r.actor !== 'agent') throw new RequestError()
  const requestId = r.requestId === undefined ? undefined : parseRequestId(r.requestId)
  return {
    blobs,
    candidate: r.candidate,
    ...(password !== undefined ? { password } : {}),
    remember,
    actor: r.actor,
    ...(requestId !== undefined ? { requestId } : {})
  }
}

/** Which source a candidate id belongs to. */
function sourceKind(id: string): CertKeyCandidate['source'] {
  return id.startsWith('windows-store:') ? 'windows-store' : 'digital-id'
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/**
 * Best first, as the renderer tries them: Windows store keys that need nothing, Digital IDs whose
 * password is saved, hardware keys (smart cards: Windows asks for the PIN), the other Digital IDs
 * (a password prompt), and last the keys that cannot open anything (EC), so the person is told why.
 */
export function orderCandidates(list: CertKeyCandidate[]): CertKeyCandidate[] {
  const rank = (c: CertKeyCandidate) => {
    if (c.keyType !== 'rsa') return 4
    if (c.source === 'windows-store') return c.hardware === true ? 2 : 0
    return c.passwordSaved ? 1 : 3
  }
  return list
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c)
}

/** A source's candidates; a source that fails finds nothing (the other one may still work). */
async function probeSource(source: RecipientKeySource, blobs: Uint8Array[]): Promise<CertKeyCandidate[]> {
  try {
    const found = await source.probe(blobs)
    return Array.isArray(found)
      ? found.filter(
          (c) => c && typeof c.id === 'string' && CANDIDATE_ID.test(c.id) && sourceKind(c.id) === source.kind
        )
      : []
  } catch {
    return []
  }
}

const ABORTED = Symbol('aborted')

/**
 * What `work` gives, or ABORTED as soon as `signal` aborts. The work itself goes on (a Digital ID
 * cannot stop in the middle of a step); `late` gets what it gives after that, to wipe it.
 */
function untilAborted<T>(
  work: Promise<T>,
  signal: AbortSignal,
  late: (value: T) => void = () => undefined
): Promise<T | typeof ABORTED> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      resolve(ABORTED)
      work.then(late, () => undefined)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

/** Which window sent an IPC event (requestIds are only unique per window). */
function senderOf(event: IpcMainInvokeEvent): string {
  const id = (event as { sender?: { id?: unknown } }).sender?.id
  return typeof id === 'number' ? String(id) : ''
}

/** Only the fields CertKeyVia has (a source's object might carry more). */
function cleanVia(v: CertKeyVia): CertKeyVia {
  return {
    source: v.source,
    label: String(v.label ?? ''),
    subject: String(v.subject ?? ''),
    fingerprint: String(v.fingerprint ?? ''),
    hardware: !!v.hardware,
    ...(v.savedPassword ? { savedPassword: true } : {}),
    ...(v.remembered ? { remembered: true } : {})
  }
}

export function certKeyHandlers(deps: CertKeyHandlerDeps): CertKeyHandlers {
  /** Checks the sender, runs `fn` and hides what went wrong. */
  const guarded =
    <A extends unknown[], R>(fn: (event: IpcMainInvokeEvent, ...args: A) => Promise<R>) =>
    async (event: IpcMainInvokeEvent, ...args: A): Promise<R> => {
      if (!deps.allowed(event)) throw new Error(REFUSED)
      try {
        return await fn(event, ...args)
      } catch (err) {
        throw new Error(err instanceof RequestError ? INVALID : UNAVAILABLE)
      }
    }

  // Decrypts still running, by sender and requestId (a window may reuse an id: all of them stop).
  const running = new Map<string, Set<AbortController>>()
  const runningKey = (event: IpcMainInvokeEvent, requestId: string) => `${senderOf(event)}:${requestId}`

  const sourceFor = (id: string): RecipientKeySource =>
    sourceKind(id) === 'windows-store' ? deps.windowsStore : deps.digitalIds

  /**
   * The request's blobs as a source gets them: the Windows helper never gets an envelope over the
   * limits (it gets an empty one in its place). Each request is parsed once (requestEnvelopes).
   */
  const blobsFor = (source: RecipientKeySource, blobs: Uint8Array[]): Uint8Array[] =>
    source.kind === 'windows-store' ? requestEnvelopes(blobs).forStore : blobs

  async function decrypt(r: DecryptRequest, signal: AbortSignal): Promise<CertKeysDecryptResult> {
    const fail = (
      code: Extract<CertKeysDecryptResult, { ok: false }>['code'],
      message: string,
      savedStale?: boolean
    ): CertKeysDecryptResult => ({
      ok: false,
      code,
      message,
      ...(savedStale ? { savedStale: true } : {})
    })
    try {
      if (signal.aborted) return fail('CANCELLED', CANCELLED)
      const source = sourceFor(r.candidate)
      const blobs = blobsFor(source, r.blobs)
      // The probe is not stopped (it never prompts, and stopping the helper would lock a smart card).
      const found = await untilAborted(probeSource(source, blobs), signal)
      if (found === ABORTED) return fail('CANCELLED', CANCELLED)
      const candidate = found.find((c) => sameId(c.id, r.candidate))
      if (!candidate) return fail('NO_MATCHING_CERT', 'This certificate cannot open the document.')
      const out = await untilAborted(
        source.decrypt(blobs, candidate, {
          ...(r.password !== undefined ? { password: r.password } : {}),
          remember: r.remember,
          actor: r.actor,
          signal
        }),
        signal,
        (late) => {
          if (late?.content instanceof Uint8Array) late.content.fill(0)
        }
      )
      if (out === ABORTED) return fail('CANCELLED', CANCELLED)
      const content = out?.content
      if (
        !(content instanceof Uint8Array) ||
        content.length < SEED_BYTES ||
        !Number.isInteger(out.envelope) ||
        out.envelope < 0 ||
        out.envelope >= r.blobs.length
      )
        return fail('ERROR', FAILED)
      const seed = content.slice(0, SEED_BYTES)
      const permissions =
        content.length >= SEED_BYTES + 4
          ? new DataView(content.buffer, content.byteOffset + SEED_BYTES, 4).getUint32(0, false)
          : null
      content.fill(0)
      return { ok: true, envelope: out.envelope, seed, permissions, via: cleanVia(out.via) }
    } catch (err) {
      if (err instanceof CertKeyError) return fail(err.code, err.message || FAILED, err.extra?.savedStale)
      return fail('ERROR', FAILED)
    }
  }

  const handlers: {
    [K in CertKeyChannel]: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<IpcResult<K>>
  } = {
    'certkeys:status': guarded(async () => {
      const windowsStore = await deps.windowsStore.state().catch(() => 'unavailable' as const)
      let digitalIds = 0
      try {
        digitalIds = deps.digitalIds.count()
      } catch {}
      return { windowsStore, digitalIds, helperRunning: deps.windowsStore.running() }
    }),
    'certkeys:probe': guarded(async (_event, request: unknown) => {
      const blobs = parseBlobs(parseRequest(request).blobs)
      const envelopes = requestEnvelopes(blobs)
      const [store, ids] = await Promise.all([
        probeSource(deps.windowsStore, envelopes.forStore),
        probeSource(deps.digitalIds, blobs)
      ])
      // After probing: whether the store could be searched (a probe may have found it constrained).
      const windowsStore: WindowsStoreState = await deps.windowsStore
        .state()
        .catch(() => 'unavailable' as const)
      return {
        candidates: orderCandidates([...store, ...ids]),
        recipients: describeRecipients(envelopes.parsed, CERTKEY_LIMITS.recipients),
        windowsStore
      }
    }),
    'certkeys:decrypt': guarded(async (event, request: unknown) => {
      // Registered before the first await, so a certkeys:cancel sent after it always finds it.
      const r = parseDecrypt(request)
      const controller = new AbortController()
      const key = r.requestId === undefined ? null : runningKey(event, r.requestId)
      if (key !== null) {
        let set = running.get(key)
        if (!set) running.set(key, (set = new Set()))
        set.add(controller)
      }
      try {
        return await decrypt(r, controller.signal)
      } finally {
        if (key !== null) {
          const set = running.get(key)
          set?.delete(controller)
          if (!set?.size) running.delete(key)
        }
      }
    }),
    'certkeys:listEncryptionCertificates': guarded(async (_event, opts: unknown) => {
      const o = parseRequest(opts)
      if (typeof o.includeOthers !== 'boolean') throw new RequestError()
      return deps.windowsStore.listEncryptionCertificates({ includeOthers: o.includeOthers })
    }),
    'certkeys:lockSmartCard': guarded(async () => {
      deps.windowsStore.stop()
    }),
    'certkeys:cancel': guarded(async (event, requestId: unknown) => {
      for (const controller of running.get(runningKey(event, parseRequestId(requestId))) ?? [])
        controller.abort()
    })
  }
  return handlers as CertKeyHandlers
}
