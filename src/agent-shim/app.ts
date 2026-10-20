// The shim's side of the local pipe (see @shared/agent/protocol): finds the running Fartcrobat,
// starting it when needed, authenticates both ways and carries calls, cancellations and progress.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  AGENT_DIR,
  AGENT_PROTOCOL_VERSION,
  ENDPOINT_FILE,
  LineDecoder,
  encodeMessage,
  macInput,
  type AgentClientInfo,
  type AgentEndpoint,
  type AgentErrorCode,
  type AgentToolResult,
  type AppToShim,
  type NoticeMessage,
  type ProgressMessage,
  type RejectMessage,
  type ShimToApp
} from '@shared/agent/protocol'
import { defaultUserDataDir, findApp, startApp, type LaunchedApp } from './launch'
import { errorResult } from './result'

/** How long the app may take to appear after the shim starts it. */
export const START_TIMEOUT_MS = 30_000
/** How long a connected app may take to finish the handshake (the app allows 10 s). */
const HANDSHAKE_TIMEOUT_MS = 15_000
/**
 * After a second instance handed over to a running app, how long the endpoint may still take to
 * appear (the running app may have been started moments before).
 */
const HANDOVER_GRACE_MS = 10_000

export const MESSAGES = {
  disabled: 'Agent access is turned off in Fartcrobat (Preferences > AI apps).',
  notRunning: 'Fartcrobat is not running and could not be started. Open Fartcrobat, then try again.',
  startTimeout: `Fartcrobat did not answer within ${START_TIMEOUT_MS / 1000} seconds. Check that it is open and that Preferences > AI apps allows AI apps to work with your documents, then try again.`,
  handedOver:
    'Fartcrobat is open but did not accept the connection. Check that Preferences > AI apps allows AI apps to work with your documents, then try again.',
  closed:
    'Fartcrobat closed before the call finished, so it may or may not have taken effect. Check the document in Fartcrobat before trying again.',
  identity:
    'Could not verify that the program answering is Fartcrobat, so nothing was sent to it. Restart Fartcrobat, then try again.',
  handshake: 'Fartcrobat did not finish connecting. Try again in a moment.',
  notSent: 'The connection to Fartcrobat closed before the call was sent. Try again.',
  aborted: 'The call was cancelled.',
  disconnected:
    'The person disconnected this AI app in Fartcrobat, so the call was stopped and may or may not have taken effect. Do not use Fartcrobat again unless they ask.',
  blocked:
    'The person disconnected this AI app in Fartcrobat. Do not use Fartcrobat again unless they ask; they can allow it again in Fartcrobat (Preferences > AI apps).'
}

/** A failure the agent sees as "[code] message". */
export class ShimError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ShimError'
  }
}

/** Nothing answers at the address (the app is not running, or it crashed and left endpoint.json behind). */
class Unreachable extends Error {}

export type Log = (message: string) => void

export const logToStderr: Log = (message) => {
  process.stderr.write(`[fartcrobat] ${message}\n`)
}

/** Electron's userData folder for Fartcrobat (the app may be pointed elsewhere with FARTCROBAT_USER_DATA). */
export function userDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  return env.FARTCROBAT_USER_DATA || defaultUserDataDir(env, platform, home)
}

export function endpointPath(userData: string, platform: NodeJS.Platform = process.platform): string {
  return (platform === 'win32' ? win32 : posix).join(userData, AGENT_DIR, ENDPOINT_FILE)
}

const HEX_32_BYTES = /^[0-9a-f]{64}$/i

/** The contents of endpoint.json, or null when they are not a usable endpoint. */
export function parseEndpoint(value: unknown): AgentEndpoint | null {
  if (!value || typeof value !== 'object') return null
  const { protocol, address, token, pid, appVersion } = value as Record<string, unknown>
  if (typeof protocol !== 'number' || typeof address !== 'string' || !address) return null
  if (typeof token !== 'string' || !HEX_32_BYTES.test(token)) return null
  if (typeof pid !== 'number' || !Number.isInteger(pid)) return null
  return { protocol, address, token, pid, appVersion: typeof appVersion === 'string' ? appVersion : '' }
}

/** endpoint.json, or null while the app is not listening (missing, or caught half-written). */
export async function readEndpoint(
  userData: string,
  platform: NodeJS.Platform = process.platform
): Promise<AgentEndpoint | null> {
  try {
    return parseEndpoint(JSON.parse(await readFile(endpointPath(userData, platform), 'utf8')))
  } catch {
    return null
  }
}

export interface WaitOptions {
  /** Token of an endpoint.json left by a run that no longer answers; it does not count. */
  previousToken?: string
  /** The process the shim started. */
  app?: LaunchedApp
  timeoutMs?: number
  graceMs?: number
  intervalMs?: number
  signal?: AbortSignal
  platform?: NodeJS.Platform
}

/**
 * Waits for a started app to publish a fresh endpoint.json. A started process that exits with 0
 * was a second instance handing over to a Fartcrobat that is already open; if that one still
 * publishes no endpoint, it is not accepting AI apps (agent access is off there, or it is still
 * starting or on its way out). An app.json that says agent access is off is answered before
 * anything is started, so this is only the fallback for apps that do not record it.
 */
export async function waitForEndpoint(userData: string, opts: WaitOptions = {}): Promise<AgentEndpoint> {
  const started: { exit: Awaited<LaunchedApp['exited']> | null } = { exit: null }
  void opts.app?.exited.then((exit) => (started.exit = exit))
  let handedOver = false
  let deadline = Date.now() + (opts.timeoutMs ?? START_TIMEOUT_MS)
  for (;;) {
    const endpoint = await readEndpoint(userData, opts.platform)
    if (endpoint && endpoint.token !== opts.previousToken) return endpoint
    if (started.exit && !handedOver) {
      const { code, signal } = started.exit
      if (code !== 0)
        throw new ShimError(
          'failed',
          `Fartcrobat could not be started (it stopped with ${signal ?? `exit code ${code}`}).`
        )
      handedOver = true
      deadline = Math.min(deadline, Date.now() + (opts.graceMs ?? HANDOVER_GRACE_MS))
    }
    if (Date.now() >= deadline)
      throw new ShimError('failed', handedOver ? MESSAGES.handedOver : MESSAGES.startTimeout)
    try {
      await sleep(opts.intervalMs ?? 200, undefined, { signal: opts.signal })
    } catch {
      throw new ShimError('aborted', MESSAGES.aborted)
    }
  }
}

function mac(token: string, role: 'client' | 'server', nonce: string): Buffer {
  return createHmac('sha256', token).update(macInput(role, nonce), 'utf8').digest()
}

/** Text the app sent before it proved who it is: shown to the agent, so kept short and plain. */
function appText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = [...value.slice(0, 600)]
    .filter((ch) => ch >= ' ' && ch !== '\u007f')
    .join('')
    .slice(0, 300)
    .trim()
  return text || fallback
}

function rejection(msg: RejectMessage): ShimError {
  switch (msg.code) {
    case 'disabled':
      return new ShimError('disabled', MESSAGES.disabled)
    // The person disconnected this AI app: it stays out (nothing is started) until they allow it.
    case 'blocked':
      return new ShimError('disabled', MESSAGES.blocked)
    case 'busy':
      return new ShimError('busy', appText(msg.message, 'Too many AI apps are connected to Fartcrobat.'))
    default:
      return new ShimError('failed', appText(msg.message, 'Fartcrobat refused the connection.'))
  }
}

interface PendingCall {
  finish(result: AgentToolResult): void
  onProgress?: (progress: ProgressMessage) => void
}

export interface CallOptions {
  signal?: AbortSignal
  onProgress?: (progress: ProgressMessage) => void
}

/** One authenticated connection to the app. */
export class AppSession {
  connectionId = 0
  appVersion = ''
  private phase: 'hello' | 'auth' | 'ready' | 'closed' = 'hello'
  private readonly nonce = randomBytes(32).toString('hex')
  private readonly pending = new Map<string, PendingCall>()
  private seq = 0
  private notice: NoticeMessage['event'] | null = null
  private socketError: Error | null = null
  private settle: { resolve(): void; reject(err: Error): void } | null = null
  private readonly timer: NodeJS.Timeout

  private constructor(
    private readonly socket: Socket,
    private readonly endpoint: AgentEndpoint,
    private readonly client: AgentClientInfo,
    private readonly shimVersion: string,
    private readonly onClosed: (session: AppSession) => void
  ) {
    const decoder = new LineDecoder<AppToShim>(
      (msg) => this.receive(msg),
      () => this.fail(new ShimError('failed', 'Fartcrobat sent a message the extension does not understand.'))
    )
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => decoder.push(chunk))
    socket.on('error', (err) => (this.socketError = err))
    socket.on('close', () => this.closed())
    this.timer = setTimeout(
      () => this.fail(new ShimError('failed', MESSAGES.handshake)),
      HANDSHAKE_TIMEOUT_MS
    )
  }

  /** Connects and authenticates. Rejects with Unreachable when nothing answers, else ShimError. */
  static open(
    endpoint: AgentEndpoint,
    client: AgentClientInfo,
    shimVersion: string,
    onClosed: (session: AppSession) => void = () => {}
  ): Promise<AppSession> {
    const session = new AppSession(connect(endpoint.address), endpoint, client, shimVersion, onClosed)
    return new Promise((resolve, reject) => {
      session.settle = { resolve: () => resolve(session), reject }
    })
  }

  get alive(): boolean {
    return this.phase === 'ready' && !this.socket.destroyed
  }

  /** Why the app closed the connection, when it said. */
  get closedBy(): NoticeMessage['event'] | null {
    return this.notice
  }

  /**
   * Sends a call and waits for its result, with no time limit of its own: a call that waits for the
   * person or runs long is answered by the app with still_running (and a ticket for
   * wait_for_result) before the AI app's request timeout, and the AI app cancels through `signal`.
   */
  call(tool: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<AgentToolResult> {
    if (!this.alive) return Promise.resolve(errorResult('failed', MESSAGES.notSent))
    const { signal, onProgress } = opts
    if (signal?.aborted) return Promise.resolve(errorResult('aborted', MESSAGES.aborted))
    const id = String(++this.seq)
    return new Promise((resolve) => {
      const onAbort = () => {
        this.send({ t: 'cancel', id })
        finish(errorResult('aborted', MESSAGES.aborted))
      }
      const finish = (result: AgentToolResult) => {
        if (!this.pending.delete(id)) return
        signal?.removeEventListener('abort', onAbort)
        resolve(result)
      }
      this.pending.set(id, { finish, onProgress })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.send({ t: 'call', id, tool, args })
    })
  }

  /** Cancels running calls (the AI app went away) and closes the connection once they are sent. */
  close() {
    for (const [id, call] of [...this.pending]) {
      this.send({ t: 'cancel', id })
      call.finish(errorResult('aborted', MESSAGES.aborted))
    }
    this.fail(new ShimError('aborted', MESSAGES.aborted), false)
  }

  private send(msg: ShimToApp) {
    if (!this.socket.destroyed && this.socket.writable) this.socket.write(encodeMessage(msg))
  }

  private receive(msg: AppToShim) {
    switch (this.phase) {
      case 'hello':
        if (msg.t === 'reject') return this.fail(rejection(msg))
        if (msg.t === 'ping' || msg.t === 'pong' || msg.t === 'notice') return
        if (msg.t !== 'hello' || typeof msg.nonce !== 'string' || !msg.nonce)
          return this.fail(new ShimError('failed', 'Fartcrobat did not greet the extension as expected.'))
        if (msg.protocol !== AGENT_PROTOCOL_VERSION)
          return this.fail(
            new ShimError(
              'failed',
              `This Fartcrobat extension (version ${this.shimVersion}) does not work with Fartcrobat ${appText(msg.appVersion, '(unknown version)')}. Update Fartcrobat, then add the extension again from Preferences > AI apps.`
            )
          )
        this.appVersion = appText(msg.appVersion, '')
        this.phase = 'auth'
        this.send({
          t: 'auth',
          protocol: AGENT_PROTOCOL_VERSION,
          mac: mac(this.endpoint.token, 'client', msg.nonce).toString('hex'),
          nonce: this.nonce,
          client: this.client,
          shimVersion: this.shimVersion
        })
        return
      case 'auth':
        if (msg.t === 'reject') return this.fail(rejection(msg))
        if (msg.t === 'ping' || msg.t === 'pong' || msg.t === 'notice') return
        if (msg.t !== 'ready') return this.fail(new ShimError('failed', MESSAGES.identity))
        // The app must prove it holds the token too; until then nothing is sent but the handshake.
        if (typeof msg.mac !== 'string' || !HEX_32_BYTES.test(msg.mac))
          return this.fail(new ShimError('failed', MESSAGES.identity))
        if (!timingSafeEqual(mac(this.endpoint.token, 'server', this.nonce), Buffer.from(msg.mac, 'hex')))
          return this.fail(new ShimError('failed', MESSAGES.identity))
        clearTimeout(this.timer)
        this.connectionId = typeof msg.connectionId === 'number' ? msg.connectionId : 0
        this.phase = 'ready'
        this.settle?.resolve()
        this.settle = null
        return
      case 'ready':
        switch (msg.t) {
          case 'progress':
            this.pending.get(msg.id)?.onProgress?.(msg)
            return
          case 'result': {
            const result =
              msg.result && typeof msg.result === 'object'
                ? msg.result
                : errorResult('failed', 'Fartcrobat sent an empty result.')
            this.pending.get(msg.id)?.finish(result)
            return
          }
          case 'notice':
            this.notice = msg.event
            return
          case 'ping':
            this.send({ t: 'pong' })
            return
          default:
            return
        }
    }
  }

  /** Ends the handshake with an error (or, once ready, just closes). */
  private fail(err: Error, destroy = true) {
    clearTimeout(this.timer)
    if (this.settle) {
      this.settle.reject(err)
      this.settle = null
    }
    if (this.phase !== 'ready') this.phase = 'closed'
    if (destroy) this.socket.destroy()
    else this.socket.end()
  }

  private closed() {
    clearTimeout(this.timer)
    const phase = this.phase
    this.phase = 'closed'
    if (this.settle) {
      // Closed before the app said hello: refused, no such socket or pipe, or an app on its way out.
      // Closed after it did: the app is there but dropped the handshake.
      const err = this.socketError as NodeJS.ErrnoException | null
      this.settle.reject(
        phase === 'hello'
          ? new Unreachable(err ? (err.code ?? err.message) : 'closed')
          : new ShimError('failed', MESSAGES.handshake)
      )
      this.settle = null
    }
    if (phase !== 'ready') return
    const result =
      this.notice === 'disabled'
        ? errorResult('disabled', MESSAGES.disabled)
        : this.notice === 'disconnected'
          ? errorResult('disabled', MESSAGES.disconnected)
          : errorResult('failed', MESSAGES.closed)
    for (const call of [...this.pending.values()]) call.finish(result)
    this.onClosed(this)
  }
}

const CLOSED_BY: Record<NoticeMessage['event'], string> = {
  shutdown: 'it is quitting',
  disabled: 'agent access was turned off',
  disconnected: 'the person disconnected this AI app'
}

export interface AppLinkOptions {
  shimVersion: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  startTimeoutMs?: number
  log?: Log
}

export interface LinkCallOptions extends CallOptions {
  /** The AI app as it introduced itself over MCP (shown in Fartcrobat). */
  client: AgentClientInfo
}

/**
 * The shim's one connection to the app, opened on the first tool call and reopened on the next
 * call after it drops (endpoint.json is read again each time: the token changes on every start).
 * It never reconnects by itself. After the person disconnects this AI app, the app refuses it
 * ('blocked') on every later call until they allow it again, and nothing is started for that.
 */
export class AppLink {
  private session: AppSession | null = null
  private opening: Promise<AppSession> | null = null
  private stopped = false
  private readonly stop = new AbortController()
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly log: Log

  constructor(private readonly opts: AppLinkOptions) {
    this.env = opts.env ?? process.env
    this.platform = opts.platform ?? process.platform
    this.log = opts.log ?? logToStderr
  }

  async call(tool: string, args: Record<string, unknown>, opts: LinkCallOptions): Promise<AgentToolResult> {
    const { signal } = opts
    if (signal?.aborted) return errorResult('aborted', MESSAGES.aborted)
    let session: AppSession
    try {
      session = await untilAborted(this.connected(opts.client), signal)
    } catch (err) {
      if (err instanceof ShimError) return errorResult(err.code, err.message)
      this.log(`Could not reach Fartcrobat: ${err instanceof Error ? err.message : String(err)}`)
      return errorResult('failed', MESSAGES.notRunning)
    }
    return session.call(tool, args, opts)
  }

  /** Cancels running calls and disconnects (the AI app closed this helper). */
  close() {
    this.stopped = true
    this.stop.abort()
    this.session?.close()
    this.session = null
  }

  private connected(client: AgentClientInfo): Promise<AppSession> {
    if (this.session?.alive) return Promise.resolve(this.session)
    if (!this.opening) {
      this.opening = this.open(client).then(
        (session) => {
          this.opening = null
          if (this.stopped) {
            session.close()
            throw new ShimError('aborted', MESSAGES.aborted)
          }
          this.session = session
          return session
        },
        (err) => {
          this.opening = null
          throw err
        }
      )
      // Callers that gave up waiting (cancelled calls) no longer listen for the outcome.
      this.opening.catch(() => {})
    }
    return this.opening
  }

  private async open(client: AgentClientInfo): Promise<AppSession> {
    const userData = userDataDir(this.env, this.platform)
    const known = await readEndpoint(userData, this.platform)
    if (known) {
      try {
        return await this.authenticate(known, client)
      } catch (err) {
        if (!(err instanceof Unreachable)) throw err
        this.log(`Nothing answers at the address in endpoint.json (${err.message}).`)
      }
    }
    const target = await findApp(userData, this.env, this.platform)
    if (!target) throw new ShimError('failed', MESSAGES.notRunning)
    // The app would only refuse (and a second instance would bring its window to the front).
    if (target.enabled === false) throw new ShimError('disabled', MESSAGES.disabled)
    this.log(`Starting Fartcrobat: ${target.executable}`)
    let app: LaunchedApp
    try {
      app = await startApp(target, { env: this.env, platform: this.platform, log: this.log })
    } catch (err) {
      this.log(`Could not start Fartcrobat: ${err instanceof Error ? err.message : String(err)}`)
      throw new ShimError('failed', MESSAGES.notRunning)
    }
    const endpoint = await waitForEndpoint(userData, {
      previousToken: known?.token,
      app,
      timeoutMs: this.opts.startTimeoutMs,
      signal: this.stop.signal,
      platform: this.platform
    })
    try {
      return await this.authenticate(endpoint, client)
    } catch (err) {
      if (err instanceof Unreachable) throw new ShimError('failed', MESSAGES.notRunning)
      throw err
    }
  }

  private async authenticate(endpoint: AgentEndpoint, client: AgentClientInfo): Promise<AppSession> {
    const session = await AppSession.open(endpoint, client, this.opts.shimVersion, (closed) => {
      if (this.session === closed) this.session = null
      const reason = closed.closedBy && CLOSED_BY[closed.closedBy]
      const why = reason ? `: ${reason}` : ''
      this.log(`Disconnected from Fartcrobat (connection ${closed.connectionId})${why}.`)
    })
    this.log(`Connected to Fartcrobat ${session.appVersion} (connection ${session.connectionId}).`)
    return session
  }
}

/** The promise's outcome, or an "aborted" ShimError as soon as the signal fires. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ShimError('aborted', MESSAGES.aborted))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
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
