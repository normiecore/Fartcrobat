/**
 * The 'passwords:*' IPC handlers, without Electron (index.ts wires them in). Every handler:
 *  - answers only the top frame of an app window loaded from the app itself;
 *  - checks the shape of what it was sent;
 *  - logs nothing, and turns every failure into a generic message, so no secret, path or key can
 *    leak through a log or an error.
 */
import type { IpcMainInvokeEvent } from 'electron'
import type { IpcArgs, IpcChannel, IpcResult } from '@shared/ipc'
import type { SavedPasswordTarget } from '@shared/passwords'
import type { LockInfo, PasswordAccess } from '@shared/types'
import type { PolicyReading } from '../policy'
import { targetKeys } from './keys'
import type { SavedPasswordStore } from './store'

export type PasswordChannel = Extract<IpcChannel, `passwords:${string}`>

export type PasswordHandlers = {
  [K in PasswordChannel]: (event: IpcMainInvokeEvent, ...args: IpcArgs<K>) => Promise<IpcResult<K>>
}

/** Where an IPC message came from. */
export interface SenderInfo {
  /** The window is one of the app's document windows. */
  appWindow: boolean
  /** The message came from the window's top frame (not an embedded frame). */
  topFrame: boolean
  /** URL of the frame that sent it. */
  url: string
}

/** Scheme and host of a URL. Not URL.origin: that is "null" for custom schemes such as app://. */
function siteOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.host ? `${u.protocol}//${u.host}` : null
  } catch {
    return null
  }
}

/**
 * What the machine policy's `rememberPasswords` reading does at start-up. Anything but an explicit
 * `"enabled": true` (or no say) turns remembering off; only an explicit `"enabled": false` also
 * wipes what was saved, because a typo or an unreadable policy file must not destroy passwords.
 */
export function rememberPolicy(reading: PolicyReading | null): { off: boolean; wipe: boolean } {
  return { off: reading === 'disabled' || reading === 'invalid', wipe: reading === 'disabled' }
}

/** True when the sender is the app's own page in one of its windows. */
export function senderAllowed(sender: SenderInfo, origins: readonly string[]): boolean {
  if (!sender.appWindow || !sender.topFrame) return false
  const site = siteOf(sender.url)
  return !!site && origins.some((o) => siteOf(o) === site)
}

export interface PasswordHandlerDeps {
  /** The store, built on first use (after the app is ready). */
  store: () => SavedPasswordStore
  /** Whether an IPC event may use saved passwords (see senderAllowed). */
  allowed: (event: IpcMainInvokeEvent) => boolean
  platform: string
  /** The machine policy turned remembering off. */
  policyOff: () => boolean
}

const UNAVAILABLE = 'Saved passwords are not available right now.'

class RequestError extends Error {}

const isText = (v: unknown, max = 100_000): v is string => typeof v === 'string' && v.length <= max

function parseLock(v: unknown): LockInfo | null {
  if (v === null || v === undefined) return null
  const l = v as LockInfo
  if (typeof v !== 'object' || !isText(l.handler, 200) || !isText(l.security) || !(l.id === null || isText(l.id, 1000)))
    throw new RequestError()
  return { handler: l.handler, id: l.id, security: l.security }
}

export function parseTarget(v: unknown): SavedPasswordTarget {
  const t = v as Record<string, unknown> | null
  if (!t || typeof t !== 'object') throw new RequestError()
  if (t.kind === 'pdf') {
    const path = t.path === undefined || t.path === null ? null : t.path
    if (path !== null && !isText(path, 32_768)) throw new RequestError()
    return { kind: 'pdf', lock: parseLock(t.lock), path }
  }
  if (t.kind === 'digital-id' && typeof t.certificateSha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(t.certificateSha256))
    return { kind: 'digital-id', certificateSha256: t.certificateSha256 }
  throw new RequestError()
}

function parseLevel(v: unknown): PasswordAccess | undefined {
  if (v === undefined || v === null) return undefined
  if (v === 'user' || v === 'owner') return v
  throw new RequestError()
}

function parseRef(v: unknown): string {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) throw new RequestError()
  return v
}

/** A file name (never a path: the store file must not say where documents are) or a Digital ID name. */
function parseLabel(v: unknown, kind: SavedPasswordTarget['kind']): string | undefined {
  if (v === undefined || v === null) return undefined
  if (!isText(v, 4096)) throw new RequestError()
  return (kind === 'pdf' ? v.split(/[\\/]/).pop()! : v).slice(0, 200)
}

export function passwordHandlers(deps: PasswordHandlerDeps): PasswordHandlers {
  const keysOf = (target: unknown) => targetKeys(parseTarget(target), deps.platform)
  /** Checks the sender, runs `fn` and hides what went wrong. */
  const guarded =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (event: IpcMainInvokeEvent, ...args: A): Promise<R> => {
      if (!deps.allowed(event)) throw new Error('This window may not use saved passwords.')
      try {
        return await fn(...args)
      } catch (err) {
        throw new Error(err instanceof RequestError ? 'Invalid request for saved passwords.' : UNAVAILABLE)
      }
    }

  const handlers: { [K in PasswordChannel]: (event: IpcMainInvokeEvent, ...args: any[]) => Promise<IpcResult<K>> } = {
    'passwords:status': guarded(async () => {
      const store = deps.store()
      const off = await store.unavailable()
      return {
        available: !off,
        reason: off?.reason ?? null,
        backend: off?.backend ?? store.backend(),
        policy: deps.policyOff(),
        count: await store.count()
      }
    }),
    'passwords:find': guarded(async (target: unknown) => deps.store().find(keysOf(target))),
    'passwords:remember': guarded(async (request: unknown) => {
      const r = request as Record<string, unknown> | null
      if (!r || typeof r !== 'object' || !isText(r.password, 4096)) throw new RequestError()
      const target = parseTarget(r.target)
      return deps.store().remember({
        kind: target.kind,
        keys: targetKeys(target, deps.platform),
        label: parseLabel(r.label, target.kind) ?? '',
        level: target.kind === 'pdf' ? parseLevel(r.level) : undefined,
        password: r.password
      })
    }),
    'passwords:used': guarded(async (ref: unknown, target: unknown, meta?: unknown) => {
      const m = (meta ?? {}) as Record<string, unknown>
      if (typeof m !== 'object') throw new RequestError()
      const t = parseTarget(target)
      await deps.store().used(parseRef(ref), targetKeys(t, deps.platform), {
        label: parseLabel(m.label, t.kind),
        level: t.kind === 'pdf' ? parseLevel(m.level) : undefined
      })
    }),
    'passwords:failed': guarded(async (ref: unknown, target: unknown) => {
      await deps.store().failed(parseRef(ref), keysOf(target))
    }),
    'passwords:savedFor': guarded(async (target: unknown) => deps.store().savedFor(keysOf(target))),
    'passwords:list': guarded(async () => deps.store().list()),
    'passwords:forget': guarded(async (refs: unknown) => {
      if (refs === 'all') return deps.store().forget('all')
      if (!Array.isArray(refs) || refs.length > 10_000) throw new RequestError()
      return deps.store().forget(refs.map(parseRef))
    }),
    'passwords:forgetFor': guarded(async (target: unknown) => deps.store().forgetKeys(keysOf(target)))
  }
  return handlers as PasswordHandlers
}
