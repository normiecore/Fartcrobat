// The local pipe the shim connects to: handshake, framing and connection bookkeeping.
import { createServer, type Server, type Socket } from 'node:net'
import {
  AGENT_PROTOCOL_VERSION,
  LineDecoder,
  MAX_LINE_BYTES,
  encodeMessage,
  type AgentClientInfo,
  type AppToShim,
  type AuthMessage,
  type CallMessage,
  type RejectMessage,
  type ShimToApp
} from '@shared/agent/protocol'
import { computeMac, isNonce, randomHex, verifyMac } from './auth'

/** An authenticated connection (one per AI app). */
export interface AgentConnection {
  readonly id: number
  readonly client: AgentClientInfo
  readonly shimVersion: string
  /** ms since epoch */
  readonly since: number
}

export interface IncomingCall {
  id: string
  tool: string
  args: Record<string, unknown>
}

export interface ServerHooks {
  connected(conn: AgentConnection): void
  call(conn: AgentConnection, call: IncomingCall): void
  cancel(conn: AgentConnection, id: string): void
  disconnected(conn: AgentConnection): void
}

export interface ServerOptions {
  token: string
  appVersion: string
  /** A connection that has not authenticated by then is closed. */
  authTimeoutMs?: number
  /** Longest line accepted after authentication (shorter limits make tests quick). */
  maxLine?: number
  /** Authenticated connections at once; more are rejected as busy. */
  maxConnections?: number
  /** Ids for new connections; the service keeps them unique across restarts. */
  nextConnectionId?: () => number
}

/** Bytes a peer may send before it has authenticated (the auth message is a few hundred). */
const MAX_HANDSHAKE_BYTES = 64 * 1024
/** Open sockets at once, authenticated or not. */
const MAX_SOCKETS = 64

let connectionCounter = 0

/** Self-reported names, cleaned for display: no control characters, not too long. */
function text(value: unknown, max = 100): string {
  if (typeof value !== 'string') return ''
  return [...value.slice(0, max * 2)]
    .filter((ch) => ch >= ' ' && ch !== '\u007f')
    .join('')
    .slice(0, max)
}

export class AgentServer {
  private server: Server | null = null
  private readonly sockets = new Set<Socket>()
  private readonly connections = new Map<number, { conn: AgentConnection; socket: Socket }>()
  private readonly authTimeoutMs: number
  private readonly maxLine: number
  private readonly maxConnections: number
  private readonly nextId: () => number

  constructor(
    private readonly opts: ServerOptions,
    private readonly hooks: ServerHooks
  ) {
    this.authTimeoutMs = opts.authTimeoutMs ?? 10_000
    this.maxLine = opts.maxLine ?? MAX_LINE_BYTES
    this.maxConnections = opts.maxConnections ?? 16
    this.nextId = opts.nextConnectionId ?? (() => ++connectionCounter)
  }

  listen(address: string): Promise<void> {
    const server = createServer((socket) => this.accept(socket))
    this.server = server
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, () => {
        server.off('error', reject)
        server.on('error', (err) => console.error('Agent access: pipe error', err))
        resolve()
      })
    })
  }

  list(): AgentConnection[] {
    return [...this.connections.values()].map((c) => c.conn)
  }

  /** Sends a message on a connection; false when it is gone. */
  send(connectionId: number, msg: AppToShim): boolean {
    const c = this.connections.get(connectionId)
    if (!c || c.socket.destroyed || !c.socket.writable) return false
    c.socket.write(encodeMessage(msg))
    return true
  }

  /** Closes one connection, or all of them. */
  disconnect(connectionId?: number) {
    for (const [id, c] of this.connections)
      if (connectionId === undefined || id === connectionId) c.socket.destroy()
  }

  /**
   * Tells connected apps why (shutdown or disabled), closes every connection and stops listening.
   * Resolves once the listener is closed.
   */
  close(notice?: 'shutdown' | 'disabled'): Promise<void> {
    const server = this.server
    this.server = null
    for (const { socket } of this.connections.values()) {
      if (notice && socket.writable) socket.write(encodeMessage({ t: 'notice', event: notice }))
      socket.end()
    }
    // Give the notices a moment to leave, then drop whatever is left.
    const sockets = [...this.sockets]
    const timer = setTimeout(() => sockets.forEach((s) => s.destroy()), 200)
    timer.unref?.()
    for (const s of sockets) if (!this.isAuthenticated(s)) s.destroy()
    if (!server) return Promise.resolve()
    return new Promise((resolve) => server.close(() => resolve()))
  }

  private isAuthenticated(socket: Socket): boolean {
    for (const c of this.connections.values()) if (c.socket === socket) return true
    return false
  }

  private accept(socket: Socket) {
    if (!this.server || this.sockets.size >= MAX_SOCKETS) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.setEncoding('utf8')
    const nonce = randomHex()
    let conn: AgentConnection | null = null
    let closed = false
    let handshakeBytes = 0

    const write = (msg: AppToShim) => {
      if (!socket.destroyed && socket.writable) socket.write(encodeMessage(msg))
    }
    const drop = () => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      socket.destroy()
    }
    const reject = (code: RejectMessage['code'], message: string) => {
      if (closed) return
      closed = true
      clearTimeout(timer)
      write({ t: 'reject', code, message })
      socket.end()
      setTimeout(() => socket.destroy(), 1000).unref?.()
    }
    const timer = setTimeout(() => reject('protocol', 'Authentication timed out.'), this.authTimeoutMs)

    const onMessage = (msg: ShimToApp) => {
      if (closed) return
      if (!conn) {
        if (msg.t !== 'auth') return reject('protocol', 'Expected auth.')
        conn = this.authenticate(msg, nonce, reject)
        if (!conn) return
        clearTimeout(timer)
        this.connections.set(conn.id, { conn, socket })
        write({ t: 'ready', mac: computeMac(this.opts.token, 'server', msg.nonce), connectionId: conn.id })
        this.hooks.connected(conn)
        return
      }
      switch (msg.t) {
        case 'call': {
          const { id, tool, args } = msg as Partial<CallMessage>
          if (
            typeof id !== 'string' ||
            !id ||
            id.length > 200 ||
            typeof tool !== 'string' ||
            !tool ||
            tool.length > 200
          )
            return drop()
          if (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args)))
            return drop()
          this.hooks.call(conn, { id, tool, args: args ?? {} })
          return
        }
        case 'cancel':
          if (typeof msg.id !== 'string') return drop()
          this.hooks.cancel(conn, msg.id)
          return
        case 'ping':
          write({ t: 'pong' })
          return
        case 'pong':
          return
        default:
          return drop()
      }
    }
    const decoder = new LineDecoder<ShimToApp>(onMessage, drop, this.maxLine)

    socket.on('data', (chunk: string) => {
      if (closed) return
      if (!conn) {
        handshakeBytes += chunk.length
        if (handshakeBytes > MAX_HANDSHAKE_BYTES) return drop()
      }
      decoder.push(chunk)
    })
    // Resets and broken pipes end in 'close' like any other disconnect.
    socket.on('error', () => {})
    socket.on('close', () => {
      closed = true
      clearTimeout(timer)
      this.sockets.delete(socket)
      if (conn && this.connections.get(conn.id)?.socket === socket) {
        this.connections.delete(conn.id)
        this.hooks.disconnected(conn)
      }
    })
    write({ t: 'hello', protocol: AGENT_PROTOCOL_VERSION, appVersion: this.opts.appVersion, nonce })
  }

  private authenticate(
    msg: AuthMessage,
    nonce: string,
    reject: (code: RejectMessage['code'], message: string) => void
  ): AgentConnection | null {
    if (msg.protocol !== AGENT_PROTOCOL_VERSION) {
      reject(
        'protocol',
        `This version of Fartcrobat (${this.opts.appVersion}) needs agent protocol ${AGENT_PROTOCOL_VERSION}. Update Fartcrobat or its Claude Desktop extension.`
      )
      return null
    }
    // The shim's nonce must be fresh: echoing ours back would make the app answer its own challenge.
    if (!isNonce(msg.nonce) || msg.nonce.toLowerCase() === nonce) {
      reject('protocol', 'Invalid nonce.')
      return null
    }
    if (!verifyMac(this.opts.token, 'client', nonce, msg.mac)) {
      reject(
        'bad_auth',
        'Authentication failed. Restart the AI app so it reads the current Fartcrobat connection details.'
      )
      return null
    }
    if (this.connections.size >= this.maxConnections) {
      reject('busy', 'Too many AI apps are connected to Fartcrobat.')
      return null
    }
    const client =
      msg.client && typeof msg.client === 'object' ? msg.client : ({} as Partial<AgentClientInfo>)
    return {
      id: this.nextId(),
      client: { name: text(client.name), version: text(client.version) },
      shimVersion: text(msg.shimVersion),
      since: Date.now()
    }
  }
}
