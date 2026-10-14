// wait_for_result: collects the result of a call that answered still_running (see runner.ts).
// AI apps time a call out after about a minute and then cancel it, which would close a dialog the
// person is still working in. So a call that runs longer answers early with a ticket and keeps
// running; the agent collects its result here.
import type { AgentAuditDetail } from '@shared/agent/bridge'
import type { AgentToolResult } from '@shared/agent/protocol'
import type { AgentToolName } from '@shared/agent/tools'
import { BOOT, ToolError, throwIfAborted, type ToolContext, type ToolHandler } from './common'

/** How long a call runs before it answers still_running, and how long one wait_for_result waits. */
export const STILL_RUNNING_MS = 45_000

let stillRunningMs = STILL_RUNNING_MS

/** The wait the main process asked for (tests shorten it); the default otherwise. */
export function setStillRunningMs(ms: number | undefined) {
  stillRunningMs = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : STILL_RUNNING_MS
}

export function stillRunningAfterMs(): number {
  return stillRunningMs
}

export interface FinalResult {
  result: AgentToolResult
  audit: AgentAuditDetail
}

interface Ticket {
  connectionId: number
  tool: string
  document?: string
  /** Stops the call: its handler sees its signal aborted, so an open confirmation closes as if declined. */
  stop: () => void
  final: FinalResult | null
  done: Promise<void>
}

const tickets = new Map<string, Ticket>()
let ticketCount = 0

export interface OpenTicket {
  id: string
  /** The call ended: keep its result until wait_for_result collects it. */
  finish(final: FinalResult): void
}

/**
 * A ticket for a call of this window that keeps running after it answered still_running. Its result
 * is kept until a wait_for_result returns it; the main process collects it when the AI app goes
 * away, so the audit log always gets the real outcome.
 */
export function openTicket(opts: {
  windowId: string
  connectionId: number
  tool: string
  document?: string
  stop: () => void
}): OpenTicket {
  const id = `${opts.windowId}-t${++ticketCount}-${BOOT}`
  let resolve!: () => void
  const t: Ticket = {
    connectionId: opts.connectionId,
    tool: opts.tool,
    ...(opts.document ? { document: opts.document } : {}),
    stop: opts.stop,
    final: null,
    done: new Promise<void>((r) => (resolve = r))
  }
  tickets.set(id, t)
  return {
    id,
    finish(final) {
      if (t.final) return
      t.final = final
      resolve()
    }
  }
}

/** What a call answers while it keeps running. */
export function stillRunning(ticket: string) {
  return {
    status: 'still_running',
    ticket,
    message:
      'This is still running in Fartcrobat, probably waiting for the person to answer there. Call wait_for_result with this ticket to get the result.'
  }
}

/** Tickets not collected yet (for tests). */
export function openTickets(): string[] {
  return [...tickets.keys()]
}

/**
 * True once `done` settles, false after `ms` (null: no limit); rejects as aborted when this
 * wait_for_result is cancelled first.
 */
function settledWithin(done: Promise<void>, ms: number | null, ctx: ToolContext): Promise<boolean> {
  throwIfAborted(ctx)
  return new Promise((resolve, reject) => {
    let settled = false
    const end = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => end(() => reject(new ToolError('aborted', 'The call was cancelled.')))
    const timer = ms === null ? null : setTimeout(() => end(() => resolve(false)), ms)
    ctx.signal.addEventListener('abort', onAbort)
    void done.then(() => end(() => resolve(true)))
  })
}

const waitForResult: ToolHandler = async (args, ctx) => {
  const id = args.ticket
  if (typeof id !== 'string' || !id) throw new ToolError('invalid_args', 'ticket must be the ticket of a still_running answer')
  if (args.cancel !== undefined && typeof args.cancel !== 'boolean') throw new ToolError('invalid_args', 'cancel must be true or false')
  const unknown = () =>
    new ToolError(
      'invalid_args',
      `No call has the ticket "${id.slice(0, 100)}": it is not a ticket of this Fartcrobat window, or its result was already returned.`
    )
  const t = tickets.get(id)
  // Tickets belong to the connection that started the call.
  if (!t || t.connectionId !== ctx.request.connectionId) throw unknown()
  // A stopped call ends soon: the runner answers it as cancelled after its grace period at most.
  const cancel = args.cancel === true
  if (cancel && !t.final) t.stop()
  if (!t.final && !(await settledWithin(t.done, cancel ? null : stillRunningMs, ctx))) {
    ctx.audit({ ...(t.document ? { document: t.document } : {}), outcome: 'pending', summary: `${t.tool}: still running` })
    return { data: stillRunning(id) }
  }
  // Another wait for the same ticket may have taken the result first.
  if (tickets.get(id) !== t || !t.final) throw unknown()
  tickets.delete(id)
  const { result, audit } = t.final
  const document = audit.document ?? t.document
  ctx.audit({ ...(document ? { document } : {}), outcome: audit.outcome, summary: audit.summary ? `${t.tool}: ${audit.summary}` : t.tool })
  if (result.error) throw new ToolError(result.error.code, result.error.message)
  return { ...(result.data !== undefined ? { data: result.data } : {}), ...(result.images?.length ? { images: result.images } : {}) }
}

export const handlers: Partial<Record<AgentToolName, ToolHandler<any>>> = {
  wait_for_result: waitForResult
}
