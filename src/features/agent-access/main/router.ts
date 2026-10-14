// Sends each agent call to the window that owns its document, and its answer back (see @shared/agent/bridge).
import type {
  AgentAuditDetail,
  AgentAuditEntry,
  AgentCallReply,
  AgentCallRequest,
  AgentProgress
} from '@shared/agent/bridge'
import type { AgentClientInfo, AgentErrorCode, AgentToolResult } from '@shared/agent/protocol'
import { agentTool } from '@shared/agent/tools'
import { auditEntry } from './audit'

/**
 * The app's windows as the router sees them, by id ("w<webContents id>"). ../main.ts implements it
 * with Electron; tests use a fake.
 */
export interface WindowHost {
  /** Open windows, in creation order. */
  windows(): string[]
  /** The focused window, else the most recently focused one; null when there is none. */
  current(): string | null
  /** Opens a new window and returns its id. */
  create(): string
  /** True once the window's renderer listens for agent requests; false if it closes first. */
  ready(windowId: string): Promise<boolean>
  request(windowId: string, request: AgentCallRequest): void
  cancel(windowId: string, id: string): void
}

export interface RouterCall {
  connectionId: number
  client: AgentClientInfo
  /** The shim's id (unique per connection). */
  id: string
  tool: string
  args: Record<string, unknown>
}

/** Where the router's output goes. */
export interface RouterSink {
  result(connectionId: number, id: string, result: AgentToolResult): void
  progress(connectionId: number, id: string, progress: Omit<AgentProgress, 'id'>): void
  audit(entry: AgentAuditEntry): void
  /** A call started or finished. */
  changed(): void
}

interface Target {
  windowId: string
  state: 'waiting' | 'sent' | 'done'
  reply?: AgentCallReply
}

interface Pending {
  /** "<connectionId>:<call id>", the id windows see. */
  key: string
  call: RouterCall
  started: number
  /** list_documents: asked of every window, answers merged. */
  fanOut: boolean
  targets: Target[]
  cancelled: boolean
}

const HANDLE = /^(w\d+)-doc-\d+$/

const fail = (code: AgentErrorCode, message: string): AgentToolResult => ({ error: { code, message } })

function clip(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

export class AgentRouter {
  private readonly pending = new Map<string, Pending>()
  /** A window the router opened that may not be focusable yet. */
  private opened: string | null = null
  private readonly readyTimeoutMs: number

  constructor(
    private readonly host: WindowHost,
    private readonly sink: RouterSink,
    opts: { readyTimeoutMs?: number } = {}
  ) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000
  }

  /** Calls running for a connection. */
  running(connectionId: number): number {
    let n = 0
    for (const p of this.pending.values()) if (p.call.connectionId === connectionId) n++
    return n
  }

  call(call: RouterCall) {
    const key = `${call.connectionId}:${call.id}`
    if (this.pending.has(key)) {
      this.sink.result(
        call.connectionId,
        call.id,
        fail('invalid_args', `A call with id ${clip(call.id)} is already running.`)
      )
      return
    }
    const p: Pending = { key, call, started: Date.now(), fanOut: false, targets: [], cancelled: false }
    this.pending.set(key, p)
    this.sink.changed()

    if (!agentTool(call.tool)) {
      this.finish(
        p,
        fail(
          'unknown_tool',
          `Fartcrobat has no tool named "${clip(call.tool)}". Update Fartcrobat or its Claude Desktop extension.`
        )
      )
      return
    }
    if (call.tool === 'list_documents') {
      p.fanOut = true
      p.targets = this.host.windows().map((windowId) => ({ windowId, state: 'waiting' }))
      if (!p.targets.length) this.finish(p, { data: { documents: [] } })
      for (const t of p.targets) void this.deliver(p, t)
      return
    }
    const route = this.route(call.args)
    if (!('windowId' in route)) {
      this.finish(p, route)
      return
    }
    const target: Target = { windowId: route.windowId, state: 'waiting' }
    p.targets.push(target)
    void this.deliver(p, target)
  }

  /** The agent cancelled a call: the window stops it and answers (usually "aborted"). */
  cancel(connectionId: number, id: string) {
    const p = this.pending.get(`${connectionId}:${id}`)
    if (!p) return
    p.cancelled = true
    for (const t of p.targets) if (t.state === 'sent') this.host.cancel(t.windowId, p.key)
    // Nothing reached a window yet, or the answers would be merged: no need to wait.
    if (p.fanOut || !p.targets.some((t) => t.state === 'sent'))
      this.finish(p, fail('aborted', 'The call was cancelled.'))
  }

  /** The connection is gone: its calls are cancelled in the windows. */
  connectionClosed(connectionId: number) {
    for (const p of [...this.pending.values()])
      if (p.call.connectionId === connectionId) this.cancel(connectionId, p.call.id)
  }

  /** A window answered. Ignored unless the call was sent to that window. */
  reply(windowId: string, reply: AgentCallReply) {
    if (!reply || typeof reply !== 'object' || typeof reply.id !== 'string') return
    const p = this.pending.get(reply.id)
    const t = p?.targets.find((t) => t.windowId === windowId && t.state === 'sent')
    if (!p || !t) return
    t.state = 'done'
    t.reply = reply
    const result: AgentToolResult =
      reply.result && typeof reply.result === 'object'
        ? reply.result
        : fail('failed', 'The window sent no result.')
    if (p.fanOut) this.settle(p)
    else this.finish(p, result, reply.audit)
  }

  progress(windowId: string, progress: AgentProgress) {
    if (
      !progress ||
      typeof progress.id !== 'string' ||
      typeof progress.progress !== 'number' ||
      !Number.isFinite(progress.progress)
    )
      return
    const p = this.pending.get(progress.id)
    if (!p || p.fanOut || !p.targets.some((t) => t.windowId === windowId && t.state === 'sent')) return
    this.sink.progress(p.call.connectionId, p.call.id, {
      progress: progress.progress,
      ...(typeof progress.total === 'number' && Number.isFinite(progress.total)
        ? { total: progress.total }
        : {}),
      ...(typeof progress.message === 'string' ? { message: clip(progress.message, 500) } : {})
    })
  }

  /** The window closed, crashed or reloaded: calls it was running cannot finish. */
  windowGone(windowId: string) {
    for (const p of [...this.pending.values()]) {
      const t = p.targets.find((t) => t.windowId === windowId && t.state === 'sent')
      if (!t) continue
      t.state = 'done'
      if (p.fanOut) this.settle(p)
      else
        this.finish(
          p,
          fail('stale_handle', 'The Fartcrobat window closed before the call finished. Call list_documents.')
        )
    }
  }

  private route(args: Record<string, unknown>): { windowId: string } | AgentToolResult {
    const handle = args.handle
    if (handle !== undefined && handle !== null && handle !== '') {
      if (typeof handle !== 'string') return fail('invalid_args', 'handle must be a string')
      const m = HANDLE.exec(handle)
      if (!m)
        return fail(
          'stale_handle',
          `"${clip(handle)}" is not a document handle. Call list_documents for current handles.`
        )
      if (!this.host.windows().includes(m[1]))
        return fail('stale_handle', `Document ${handle} is not open any more. Call list_documents.`)
      return { windowId: m[1] }
    }
    const windows = this.host.windows()
    const current = this.host.current() ?? (this.opened && windows.includes(this.opened) ? this.opened : null)
    if (current) return { windowId: current }
    this.opened = this.host.create()
    return { windowId: this.opened }
  }

  private async deliver(p: Pending, t: Target) {
    const ready = await this.whenReady(t.windowId)
    if (this.pending.get(p.key) !== p || t.state !== 'waiting') return
    if (ready !== true || p.cancelled) {
      t.state = 'done'
      if (p.fanOut) this.settle(p)
      else if (ready === 'timeout')
        this.finish(p, fail('failed', 'The Fartcrobat window is not responding. Try again in a moment.'))
      else
        this.finish(
          p,
          fail(
            'stale_handle',
            'The Fartcrobat window closed before the call could start. Call list_documents.'
          )
        )
      return
    }
    t.state = 'sent'
    const { connectionId, client, tool, args } = p.call
    try {
      const currentWindow = this.host.current() === t.windowId
      this.host.request(t.windowId, { id: p.key, connectionId, client, windowId: t.windowId, currentWindow, tool, args })
    } catch (err) {
      t.state = 'done'
      if (p.fanOut) this.settle(p)
      else this.finish(p, fail('failed', `Could not reach the Fartcrobat window: ${(err as Error).message}`))
    }
  }

  private whenReady(windowId: string): Promise<boolean | 'timeout'> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this.readyTimeoutMs)
      this.host.ready(windowId).then(
        (ok) => {
          clearTimeout(timer)
          resolve(ok)
        },
        () => {
          clearTimeout(timer)
          resolve(false)
        }
      )
    })
  }

  /** list_documents: once every window answered (or dropped out), merge in creation order. */
  private settle(p: Pending) {
    if (p.targets.some((t) => t.state !== 'done')) return
    const documents: unknown[] = []
    let answered = false
    let firstError: AgentToolResult['error']
    for (const t of p.targets) {
      const result = t.reply?.result
      if (!result) continue
      if (result.error) {
        firstError ??= result.error
        continue
      }
      answered = true
      const docs = (result.data as { documents?: unknown } | undefined)?.documents
      if (Array.isArray(docs)) documents.push(...docs)
    }
    this.finish(p, !answered && firstError ? { error: firstError } : { data: { documents } })
  }

  private finish(p: Pending, result: AgentToolResult, detail?: AgentAuditDetail) {
    if (this.pending.get(p.key) !== p) return
    this.pending.delete(p.key)
    const { connectionId, client, id, tool, args } = p.call
    this.sink.result(connectionId, id, result)
    this.sink.audit(
      auditEntry({
        connection: connectionId,
        client: client.name,
        tool,
        args,
        result,
        detail,
        started: p.started,
        finished: Date.now()
      })
    )
    this.sink.changed()
  }
}
