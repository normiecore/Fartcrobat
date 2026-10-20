// Sends each agent call to the window that owns its document, and its answer back (see @shared/agent/bridge).
import type {
  AgentAuditDetail,
  AgentAuditEntry,
  AgentCallReply,
  AgentCallRequest,
  AgentProgress
} from '@shared/agent/bridge'
import { shimForwardsCompanion, type AgentClientInfo, type AgentErrorCode, type AgentToolResult } from '@shared/agent/protocol'
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
  /** The shim's version; unknown is taken as current. */
  shimVersion?: string
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
  companionWindow?: string
  targets: Target[]
  cancelled: boolean
  /** Ends a cancelled call whose window does not answer. */
  cancelTimer?: ReturnType<typeof setTimeout>
}

/** A call that answered still_running and keeps running in its window. */
interface Ticket {
  connectionId: number
  client: AgentClientInfo
  windowId: string
  /** The key of the call that answered with this ticket. */
  callKey: string
}

/** "w<window>-<boot>-doc-<n>": the boot part is checked by the window. */
const HANDLE = /^(w\d+)-[a-z0-9]+-doc-\d+$/
/** "w<window>-t<n>-<boot>", from a still_running answer. */
const TICKET = /^(w\d+)-t\d+-[a-z0-9]+$/

const fail = (code: AgentErrorCode, message: string): AgentToolResult => ({ error: { code, message } })

function clip(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

export class AgentRouter {
  private readonly pending = new Map<string, Pending>()
  /** Calls that answered still_running, by ticket, until a wait_for_result returns their result. */
  private readonly tickets = new Map<string, Ticket>()
  /** A window the router opened that may not be focusable yet. */
  private opened: string | null = null
  private readonly readyTimeoutMs: number
  private readonly cancelWaitMs: number

  constructor(
    private readonly host: WindowHost,
    private readonly sink: RouterSink,
    opts: { readyTimeoutMs?: number; cancelWaitMs?: number } = {}
  ) {
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000
    // Longer than the window's own grace period (runner.ts CANCEL_GRACE_MS, 15 s).
    this.cancelWaitMs = opts.cancelWaitMs ?? 20_000
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
      p.companionWindow = this.currentWindow() ?? p.targets[0]?.windowId
      if (!p.targets.length) this.finish(p, { data: { documents: [] } })
      for (const t of p.targets) void this.deliver(p, t)
      return
    }
    const route = this.route(call)
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
    const key = `${connectionId}:${id}`
    const p = this.pending.get(key)
    if (!p) {
      // It answered still_running, but the agent cancelled before that answer reached it, so
      // nobody will collect the ticket: stop the call rather than leave the person's dialog open.
      for (const [ticket, t] of this.tickets) if (t.callKey === key) return this.stopTicket(ticket, t)
      return
    }
    p.cancelled = true
    for (const t of p.targets) if (t.state === 'sent') this.host.cancel(t.windowId, p.key)
    // Nothing reached a window yet, or the answers would be merged: no need to wait.
    if (p.fanOut || !p.targets.some((t) => t.state === 'sent'))
      this.finish(p, fail('aborted', 'The call was cancelled.'))
    else if (!p.cancelTimer) {
      // A window that never answers (hung, or its reply was lost) must not keep the call running.
      p.cancelTimer = setTimeout(
        () => this.finish(p, fail('aborted', 'The call was cancelled.')),
        this.cancelWaitMs
      )
      p.cancelTimer.unref?.()
    }
  }

  /** The connection is gone: its calls are cancelled in the windows, also those it had tickets for. */
  connectionClosed(connectionId: number) {
    for (const p of [...this.pending.values()])
      if (p.call.connectionId === connectionId) this.cancel(connectionId, p.call.id)
    for (const [ticket, t] of [...this.tickets])
      if (t.connectionId === connectionId) this.stopTicket(ticket, t)
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
    if (p.fanOut) {
      this.settle(p)
      return
    }
    const ticket = this.trackTicket(p, windowId, result)
    this.finish(p, result, reply.audit)
    // The agent cancelled while the window was answering still_running: it never gets the ticket.
    if (ticket && p.cancelled) this.stopTicket(ticket, this.tickets.get(ticket)!)
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
    for (const [ticket, t] of [...this.tickets]) if (t.windowId === windowId) this.tickets.delete(ticket)
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

  /**
   * Keeps track of the calls that answered still_running, until a wait_for_result returns their
   * result. Returns the ticket a call (not a wait_for_result) answered with.
   */
  private trackTicket(p: Pending, windowId: string, result: AgentToolResult): string | null {
    const waiting = p.call.tool === 'wait_for_result'
    const data = result.data as { status?: unknown; ticket?: unknown } | undefined
    if (!result.error && data?.status === 'still_running' && typeof data.ticket === 'string') {
      // Only the window that runs the call hands out its ticket. A wait_for_result that answers
      // still_running again leaves its ticket as it is.
      if (waiting || TICKET.exec(data.ticket)?.[1] !== windowId) return null
      const { connectionId, client } = p.call
      this.tickets.set(data.ticket, { connectionId, client, windowId, callKey: p.key })
      return data.ticket
    }
    // Any other answer to a wait_for_result ends its ticket, unless the wait itself was cancelled.
    const stopped = p.cancelled && result.error?.code === 'aborted'
    const ticket = waiting && !stopped ? p.call.args.ticket : undefined
    if (typeof ticket === 'string' && this.tickets.get(ticket)?.connectionId === p.call.connectionId)
      this.tickets.delete(ticket)
    return null
  }

  /**
   * Stops a call nobody will collect, through a wait_for_result of Fartcrobat's own: the window
   * then answers it, and the audit log records how the call really ended.
   */
  private stopTicket(ticket: string, t: Ticket) {
    this.tickets.delete(ticket)
    const call = { connectionId: t.connectionId, client: t.client, tool: 'wait_for_result' }
    this.call({ ...call, id: `stop-${ticket}`, args: { ticket, cancel: true } })
  }

  /** The focused window, else the most recently focused one, else one the router opened. */
  private currentWindow(): string | null {
    const windows = this.host.windows()
    return this.host.current() ?? (this.opened && windows.includes(this.opened) ? this.opened : null)
  }

  private route(call: RouterCall): { windowId: string } | AgentToolResult {
    if (call.tool === 'companion_chat' && call.args.session !== undefined) {
      const session = call.args.session
      const match = typeof session === 'string' && /^(w\d+)-chat-[a-z0-9]+-[a-f0-9-]+$/.exec(session)
      if (!match || !this.host.windows().includes(match[1])) return fail('invalid_args', 'The companion window closed or its session is invalid.')
      return { windowId: match[1] }
    }
    if (call.tool === 'wait_for_result') {
      const ticket = call.args.ticket
      if (typeof ticket !== 'string' || !ticket)
        return fail('invalid_args', 'ticket must be the ticket of a still_running answer')
      const m = TICKET.exec(ticket)
      if (!m || !this.host.windows().includes(m[1]))
        return fail(
          'invalid_args',
          `No call has the ticket "${clip(ticket)}": it is not a current ticket, or its Fartcrobat window closed.`
        )
      return { windowId: m[1] }
    }
    const handle = call.args.handle
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
    const current = this.currentWindow()
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
      const currentWindow = this.currentWindow() === t.windowId
      this.host.request(t.windowId, {
        id: p.key,
        connectionId,
        client,
        windowId: t.windowId,
        currentWindow,
        allowCompanionJoin:
          (p.call.shimVersion === undefined || shimForwardsCompanion(p.call.shimVersion)) &&
          (!p.fanOut || p.companionWindow === t.windowId),
        tool,
        args
      })
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
    let companion: AgentToolResult['companion']
    for (const t of p.targets) {
      const result = t.reply?.result
      if (!result) continue
      if (result.error) {
        firstError ??= result.error
        continue
      }
      answered = true
      companion ??= result.companion
      const docs = (result.data as { documents?: unknown } | undefined)?.documents
      if (Array.isArray(docs)) documents.push(...docs)
    }
    this.finish(p, !answered && firstError ? { error: firstError } : { data: { documents }, ...(companion ? { companion } : {}) })
  }

  private finish(p: Pending, result: AgentToolResult, detail?: AgentAuditDetail) {
    if (this.pending.get(p.key) !== p) return
    this.pending.delete(p.key)
    clearTimeout(p.cancelTimer)
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
