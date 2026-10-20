/**
 * Runs the tool calls the main process routes to this window ('agent:request'): finds the handler
 * (tools/index.ts), gives it a ToolContext, turns failures into tool errors and replies exactly once
 * per call ('feature:agent-access:reply'). Calls run concurrently; nothing here waits on another
 * call or blocks the UI. A call still running after about 45 s (usually waiting for the person)
 * answers still_running with a ticket and keeps going; wait_for_result (tools/wait.ts) collects it.
 */
import type { AgentAuditDetail, AgentCallReply, AgentCallRequest, AgentProgress } from '@shared/agent/bridge'
import type { AgentToolResult } from '@shared/agent/protocol'
import { agentTool, type AgentToolDef } from '@shared/agent/tools'
import { invoke, onMainEvent, useApp } from '@renderer/sdk'
import { commitActiveEditors, hasActiveEditors } from '@renderer/app/commands'
import { isDocumentClosedError } from '@renderer/engine/EngineClient'
import { TOOL_HANDLERS } from './tools'
import { auditName, parseHandle, ToolError, type ToolContext, type ToolHandler } from './tools/common'
import { openTicket, setStillRunningMs, stillRunning, stillRunningAfterMs, type OpenTicket } from './tools/wait'
import { appLabel, callFinished, callStarted } from './ui/store'
import { autoJoinCompanion } from './ui/companionStore'
import { BOOT } from './tools/common'
import './ipc'

export interface RunnerDeps {
  handlers: Partial<Record<string, ToolHandler<any>>>
  tool: (name: string) => AgentToolDef | undefined
  /** Puts what the person is typing into the document (before a tool that changes it). */
  commitEditors: () => Promise<void>
  reply: (reply: AgentCallReply) => Promise<unknown>
  progress: (progress: AgentProgress) => void
  /** How long a call runs before it answers still_running. */
  stillRunningMs?: () => number
  /** How long a call stopped through its ticket may take before it is ended as cancelled. */
  graceMs?: number
}

/** How long a cancelled call may take to stop before it is answered as cancelled anyway. */
export const CANCEL_GRACE_MS = 15000

type ToolErrorShape = NonNullable<AgentToolResult['error']>

/** What the agent sees when a handler throws. */
export function toToolError(err: unknown, aborted = false): ToolErrorShape {
  if (err instanceof ToolError) return { code: err.code, message: err.message }
  if (isDocumentClosedError(err)) return { code: 'stale_handle', message: 'The document was closed while the call ran. Call list_documents.' }
  if (aborted) return { code: 'aborted', message: 'The call was cancelled.' }
  const message = err instanceof Error ? err.message : String(err)
  return { code: 'failed', message: message || 'The call failed.' }
}

/** The audit outcome of a result: declined and cancelled are the person's (or agent's) choice, not errors. */
export function outcomeOf(error: ToolErrorShape | undefined, chosen?: AgentAuditDetail['outcome']): AgentAuditDetail['outcome'] {
  if (!error) return chosen ?? 'done'
  if (error.code === 'declined') return 'declined'
  if (error.code === 'cancelled' || error.code === 'aborted') return 'cancelled'
  return 'error'
}

/** The audit name of the document a call's handle names, if it is open in this window. */
function documentOfHandle(request: AgentCallRequest): string | undefined {
  const handle = request.args?.handle
  if (typeof handle !== 'string') return undefined
  const parsed = parseHandle(handle)
  if (!parsed || parsed.windowId !== request.windowId || !parsed.current) return undefined
  const doc = useApp.getState().docs.find((d) => d.id === parsed.docId && !d.isClosed)
  return doc ? auditName(doc) : undefined
}

/**
 * Runs one call to completion. Never throws: failures come back as result.error. `audit` collects
 * what the handler reports as it goes.
 */
export async function executeCall(
  request: AgentCallRequest,
  signal: AbortSignal,
  deps: RunnerDeps,
  audit: Partial<AgentAuditDetail> = {}
): Promise<{ result: AgentToolResult; audit: AgentAuditDetail }> {
  const def = deps.tool(request.tool)
  const handler = def ? deps.handlers[def.name] : undefined
  if (!def || !handler) {
    const message = def
      ? `${request.tool} is not available in this version of Fartcrobat.`
      : `Fartcrobat has no tool named "${request.tool}".`
    return { result: { error: { code: 'unknown_tool', message } }, audit: { outcome: 'error' } }
  }
  const ctx: ToolContext = {
    request,
    signal,
    progress: (progress, total, message) => deps.progress({ id: request.id, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) }),
    audit: (detail) => void Object.assign(audit, detail)
  }
  const args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? request.args : {}
  const finish = (result: AgentToolResult) => {
    const document = audit.document ?? documentOfHandle({ ...request, args })
    return {
      result,
      audit: { ...audit, ...(document ? { document } : {}), outcome: outcomeOf(result.error, audit.outcome) }
    }
  }
  try {
    // Like a menu command: what the person typed goes in first, so the change does not land
    // underneath an open editor.
    if (def.category !== 'context' && def.category !== 'view') await deps.commitEditors()
    if (signal.aborted) throw new ToolError('aborted', 'The call was cancelled.')
    const out = await handler(args, ctx)
    const result: AgentToolResult = {}
    if (out?.data !== undefined) result.data = out.data
    if (out?.images?.length) result.images = out.images
    return finish(result)
  } catch (err) {
    if (!(err instanceof ToolError) && !isDocumentClosedError(err)) console.warn(`Agent tool ${request.tool} failed`, err)
    return finish({ error: toToolError(err, signal.aborted) })
  }
}

// ---- requests from the main process -------------------------------------------------------------

interface Running {
  controller: AbortController
  /** Ends the call, once: replies, or keeps the result for its ticket. */
  settle: (result: AgentToolResult, audit: AgentAuditDetail) => void
  graceTimer: ReturnType<typeof setTimeout> | null
}

/** Calls whose request is not answered yet, by request id. */
const running = new Map<string, Running>()

/** Progress updates are sent at most this often per call (the last one always). */
const PROGRESS_INTERVAL_MS = 150
const lastProgress = new Map<string, number>()

function sendProgress(p: AgentProgress) {
  const now = Date.now()
  const last = lastProgress.get(p.id) ?? 0
  if (now - last < PROGRESS_INTERVAL_MS && !(p.total !== undefined && p.progress >= p.total)) return
  lastProgress.set(p.id, now)
  void invoke('feature:agent-access:progress', p).catch(() => {})
}

export const defaultDeps: RunnerDeps = {
  handlers: TOOL_HANDLERS,
  tool: agentTool,
  commitEditors: async () => {
    if (hasActiveEditors()) await commitActiveEditors()
  },
  reply: (reply) => invoke('feature:agent-access:reply', reply),
  progress: sendProgress,
  stillRunningMs: stillRunningAfterMs
}

const ABORTED: AgentToolResult = { error: { code: 'aborted', message: 'The call was cancelled.' } }

/** Aborts a call's handler; one that does not notice is ended as cancelled after graceMs anyway. */
function stopCall(entry: Running, graceMs: number) {
  if (entry.controller.signal.aborted) return
  entry.controller.abort()
  entry.graceTimer = setTimeout(() => entry.settle(ABORTED, { outcome: 'cancelled' }), graceMs)
}

/**
 * Tools that never answer still_running: wait_for_result waits by itself, and list_documents is
 * merged from every window by the main process.
 */
const ANSWER_AT_ONCE = new Set(['wait_for_result', 'list_documents'])

/** Runs a call from the main process and replies once, also when the agent cancelled it. */
export async function handleRequest(request: AgentCallRequest, deps: RunnerDeps = defaultDeps): Promise<void> {
  if (running.has(request.id)) return
  const controller = new AbortController()
  const started = Date.now()
  const def = deps.tool(request.tool)
  // wait_for_result is bookkeeping for another call, which keeps its own row in the activity panel.
  const listed = request.tool !== 'wait_for_result'
  const audit: Partial<AgentAuditDetail> = {}
  let ticket: OpenTicket | null = null
  let ended = false
  let waitTimer: ReturnType<typeof setTimeout> | null = null
  const send = (result: AgentToolResult, detail: AgentAuditDetail) =>
    void Promise.resolve()
      .then(() => deps.reply({ id: request.id, result, audit: detail }))
      .catch((err) => console.warn('Could not send the result of an agent call', err))
  const entry: Running = {
    controller,
    graceTimer: null,
    settle: (result, detail) => {
      if (ended) return
      ended = true
      if (entry.graceTimer) clearTimeout(entry.graceTimer)
      if (waitTimer) clearTimeout(waitTimer)
      if (running.get(request.id) === entry) running.delete(request.id)
      lastProgress.delete(request.id)
      if (listed)
        callFinished(request.id, {
          outcome: detail.outcome,
          ms: Date.now() - started,
          ...(detail.document ? { document: detail.document } : {}),
          ...(result.error ? { error: result.error.message } : {})
        })
      // Joins only on a reply that goes straight back to a live call: the token in a ticket's
      // result (wait_for_result) or a cancelled call's reply would reach nobody, and leave the chat
      // owned by no one who can use it.
      if (!ticket && !controller.signal.aborted && !result.error && request.tool !== 'companion_chat' &&
          request.tool !== 'wait_for_result' &&
          (request.allowCompanionJoin ?? (request.tool !== 'list_documents' || request.currentWindow))) {
        const companion = autoJoinCompanion(request.connectionId, appLabel(request.client.name),
          `${request.windowId}-chat-${BOOT}-${crypto.randomUUID()}`)
        if (companion) result = { ...result, companion }
      }
      if (ticket) ticket.finish({ result, audit: detail })
      else send(result, detail)
    }
  }
  running.set(request.id, entry)
  if (listed)
    callStarted({
      id: request.id,
      tool: request.tool,
      title: def?.title ?? request.tool,
      client: appLabel(request.client?.name),
      document: documentOfHandle(request),
      started
    })
  if (!ANSWER_AT_ONCE.has(request.tool)) {
    // Answer before the AI app gives up on the call (and cancels it, closing the person's dialog).
    waitTimer = setTimeout(() => {
      waitTimer = null
      if (ended || controller.signal.aborted) return
      // From here on the call belongs to its ticket: a cancel of the request no longer reaches it.
      running.delete(request.id)
      const document = audit.document ?? documentOfHandle(request)
      const opened = openTicket({
        windowId: request.windowId,
        connectionId: request.connectionId,
        tool: request.tool,
        ...(document ? { document } : {}),
        stop: () => stopCall(entry, deps.graceMs ?? CANCEL_GRACE_MS)
      })
      ticket = opened
      send(
        { data: stillRunning(opened.id) },
        { ...(document ? { document } : {}), outcome: 'pending', summary: `still running, ticket ${opened.id}` }
      )
    }, deps.stillRunningMs?.() ?? stillRunningAfterMs())
  }
  // Progress of a call that answered still_running has nobody to go to.
  const progress = (p: AgentProgress) => {
    if (!ticket) deps.progress(p)
  }
  const out = await executeCall(request, controller.signal, { ...deps, progress }, audit)
  entry.settle(out.result, out.audit)
}

/** The agent cancelled a call: the handler sees its signal aborted and stops at its next check. */
export function cancelRequest(id: string, graceMs = CANCEL_GRACE_MS) {
  const entry = running.get(id)
  if (entry) stopCall(entry, graceMs)
}

/** Calls running in this window (for tests and the activity panel). */
export function runningCalls(): string[] {
  return [...running.keys()]
}

let stop: (() => void) | null = null

/**
 * Starts listening for calls from the main process. Called as soon as the feature loads (before
 * the first render), so a call sent while the window is still starting is not lost. Idempotent.
 */
export function startAgentRunner(): () => void {
  if (stop) return stop
  const offRequest = onMainEvent('agent:request', (request) => void handleRequest(request))
  const offCancel = onMainEvent('agent:cancel', (id) => cancelRequest(id))
  // Tells the main process this window takes calls now, and learns how long a call may run
  // before it answers still_running (tests shorten it).
  void invoke('feature:agent-access:ready')
    .then((config) => setStillRunningMs(config?.waitMs))
    .catch(() => {})
  stop = () => {
    offRequest()
    offCancel()
    stop = null
  }
  return stop
}
