// Agent access in the main process: turns the pipe on and off, and ties the pipe, the router,
// the audit log and the status together. No Electron here (../main.ts wires it in).
import { chmod } from 'node:fs/promises'
import type { AgentCallReply, AgentProgress, AgentStatus } from '@shared/agent/bridge'
import { AGENT_PROTOCOL_VERSION, type AgentAppInfo } from '@shared/agent/protocol'
import { AuditLog } from './audit'
import { randomHex } from './auth'
import {
  auditFile,
  newAddress,
  removeAddress,
  removeEndpointFile,
  removeStaleEndpointFile,
  writeAppFile,
  writeEndpointFile,
  type ListenAddress
} from './endpoint'
import { agentAccessState, currentPolicy, machinePolicy, type AgentAccessState } from './policy'
import { AgentRouter, type WindowHost } from './router'
import { AgentServer } from './server'

export interface AgentAccessOptions {
  userData: string
  appVersion: string
  /** How the shim starts the app (written to app.json, with whether agent access is on). */
  launch: Omit<AgentAppInfo, 'enabled'>
  host: WindowHost
  /** Sends the status to every window. */
  broadcast(status: AgentStatus): void
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** The machine policy file, instead of the system's policy (tests point it at a temporary file). */
  policyFile?: string
  /** Where the socket's private folder is made. */
  tmpDir?: string
  authTimeoutMs?: number
  maxLine?: number
  readyTimeoutMs?: number
  cancelWaitMs?: number
  auditMaxBytes?: number
}

interface Running {
  server: AgentServer
  address: ListenAddress
  token: string
}

export class AgentAccess {
  private preference = true
  private state: AgentAccessState = { enabled: false, policy: null }
  private running: Running | null = null
  private error: string | null = null
  private quitting = false
  private lifecycle: Promise<void> = Promise.resolve()
  private statusQueued = false
  private connectionIds = 0
  /** AI apps (by reported name) the person disconnected; refused until allowed again. */
  private readonly blocked = new Set<string>()
  readonly router: AgentRouter
  readonly audit: AuditLog
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv

  constructor(private readonly opts: AgentAccessOptions) {
    this.platform = opts.platform ?? process.platform
    this.env = opts.env ?? process.env
    this.audit = new AuditLog(auditFile(opts.userData), opts.auditMaxBytes)
    this.router = new AgentRouter(
      opts.host,
      {
        result: (connectionId, id, result) =>
          void this.running?.server.send(connectionId, { t: 'result', id, result }),
        progress: (connectionId, id, p) =>
          void this.running?.server.send(connectionId, { t: 'progress', id, ...p }),
        audit: (entry) => void this.audit.append(entry),
        changed: () => this.statusChanged()
      },
      { readyTimeoutMs: opts.readyTimeoutMs, cancelWaitMs: opts.cancelWaitMs }
    )
  }

  /**
   * Applies the person's preference, re-reading the machine policy: starts or stops listening.
   * Resolves once that is done.
   */
  setPreference(on: boolean | undefined): Promise<void> {
    this.preference = on !== false
    this.lifecycle = this.lifecycle
      .then(() => this.reconcile())
      .catch((err) => console.error('Agent access: could not change state', err))
    return this.lifecycle
  }

  status(): AgentStatus {
    const server = this.running?.server
    return {
      enabled: this.state.enabled,
      policy: this.state.policy,
      listening: !!server,
      blocked: [...this.blocked],
      connections: (server?.list() ?? []).map((c) => ({
        id: c.id,
        client: c.client,
        shimVersion: c.shimVersion,
        since: c.since,
        running: this.router.running(c.id)
      })),
      auditLog: this.audit.file,
      error: this.error
    }
  }

  /**
   * The person disconnected one AI app (by connection id), or all of them: they are told so, their
   * calls are cancelled, and they cannot connect again until the person allows it.
   */
  disconnect(connectionId?: number) {
    const server = this.running?.server
    if (!server) return
    for (const c of server.list())
      if (connectionId === undefined || c.id === connectionId) this.blocked.add(c.client.name)
    server.disconnect(connectionId)
    this.statusChanged()
  }

  /** Lets a disconnected AI app (by reported name) connect again, or all of them. */
  allow(clientName?: string) {
    if (clientName === undefined) this.blocked.clear()
    else this.blocked.delete(clientName)
    this.statusChanged()
  }

  reply(windowId: string, reply: AgentCallReply) {
    this.router.reply(windowId, reply)
  }

  progress(windowId: string, progress: AgentProgress) {
    this.router.progress(windowId, progress)
  }

  windowGone(windowId: string) {
    this.router.windowGone(windowId)
  }

  /** The app is quitting: tell connected apps, close the pipe and remove endpoint.json, synchronously. */
  shutdown() {
    this.quitting = true
    const running = this.running
    this.running = null
    if (!running) return
    removeEndpointFile(this.opts.userData, running.token)
    void running.server.close('shutdown')
    removeAddress(running.address)
  }

  /** Stops listening and waits for it (tests; the app uses shutdown()). */
  async close(): Promise<void> {
    this.quitting = true
    await this.lifecycle
    await this.stop('shutdown')
    await this.audit.flush()
  }

  private async reconcile() {
    if (this.quitting) return
    const machine = await machinePolicy(this.platform, this.env, this.opts.policyFile)
    if (this.quitting) return
    this.state = agentAccessState(this.preference, currentPolicy(machine, this.env))
    try {
      // The shim reads this before starting the app: with access off it answers at once.
      await writeAppFile(this.opts.userData, { ...this.opts.launch, enabled: this.state.enabled })
    } catch (err) {
      // The shim can still connect while the app runs; it just cannot start the app by itself.
      console.error('Agent access: could not write app.json', err)
    }
    if (this.state.enabled && !this.running) await this.start()
    else if (!this.state.enabled && this.running) await this.stop('disabled')
    if (!this.state.enabled) {
      this.error = null
      removeStaleEndpointFile(this.opts.userData)
    }
    this.statusChanged()
  }

  private async start() {
    this.error = null
    const token = randomHex()
    let address: ListenAddress | null = null
    const server = new AgentServer(
      {
        token,
        appVersion: this.opts.appVersion,
        authTimeoutMs: this.opts.authTimeoutMs,
        maxLine: this.opts.maxLine,
        nextConnectionId: () => ++this.connectionIds,
        isBlocked: (client) => this.blocked.has(client.name)
      },
      {
        connected: () => this.statusChanged(),
        call: (conn, call) =>
          this.router.call({
            connectionId: conn.id,
            client: conn.client,
            shimVersion: conn.shimVersion,
            id: call.id,
            tool: call.tool,
            args: call.args
          }),
        cancel: (conn, id) => this.router.cancel(conn.id, id),
        disconnected: (conn) => {
          this.router.connectionClosed(conn.id)
          this.statusChanged()
        }
      }
    )
    try {
      address = await newAddress(this.platform, this.opts.tmpDir)
      await server.listen(address.address)
      if (this.platform !== 'win32') await chmod(address.address, 0o600)
      // Published last, so the shim never finds an address that does not answer yet.
      await writeEndpointFile(this.opts.userData, {
        protocol: AGENT_PROTOCOL_VERSION,
        address: address.address,
        token,
        pid: process.pid,
        appVersion: this.opts.appVersion
      })
    } catch (err) {
      await server.close()
      if (address) removeAddress(address)
      removeEndpointFile(this.opts.userData, token)
      this.error = `Could not start agent access: ${(err as Error).message}`
      console.error('Agent access:', err)
      return
    }
    if (this.quitting) {
      removeEndpointFile(this.opts.userData, token)
      await server.close('shutdown')
      removeAddress(address)
      return
    }
    this.running = { server, address, token }
  }

  private async stop(notice: 'disabled' | 'shutdown') {
    const running = this.running
    this.running = null
    if (!running) return
    // First, so no shim tries to connect to a pipe that is going away.
    removeEndpointFile(this.opts.userData, running.token)
    await running.server.close(notice)
    removeAddress(running.address)
  }

  /** Coalesces status changes into one broadcast per turn of the event loop. */
  private statusChanged() {
    if (this.statusQueued) return
    this.statusQueued = true
    setImmediate(() => {
      this.statusQueued = false
      try {
        this.opts.broadcast(this.status())
      } catch (err) {
        console.error('Agent access: could not send the status', err)
      }
    })
  }
}
