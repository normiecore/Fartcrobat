/**
 * Runs the tool calls the main process routes to this window ('agent:request'): finds the handler
 * (tools/index.ts), gives it a ToolContext, turns failures into tool errors and replies exactly once
 * per call ('feature:agent-access:reply'). Calls run concurrently; nothing here waits on another
 * call or blocks the UI.
 */
import type { AgentAuditDetail, AgentCallReply, AgentCallRequest, AgentProgress } from '@shared/agent/bridge'
import type { AgentToolResult } from '@shared/agent/protocol'
import { agentTool, type AgentToolDef } from '@shared/agent/tools'
import { invoke, onMainEvent, useApp } from '@renderer/sdk'
import { commitActiveEditors, hasActiveEditors } from '@renderer/app/commands'
import { isDocumentClosedError } from '@renderer/engine/EngineClient'
import { TOOL_HANDLERS } from './tools'
import { auditName, parseHandle, ToolError, type ToolContext, type ToolHandler } from './tools/common'
import { appLabel, callFinished, callStarted } from './ui/store'
import './ipc'

export interface RunnerDeps {
  handlers: Partial<Record<string, ToolHandler<any>>>
  tool: (name: string) => AgentToolDef | undefined
  /** Puts what the person is typing into the document (before a tool that changes it). */
  commitEditors: () => Promise<void>
  reply: (reply: AgentCallReply) => Promise<unknown>
  progress: (progress: AgentProgress) => void
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
  if (!parsed || parsed.windowId !== request.windowId) return undefined
  const doc = useApp.getState().docs.find((d) => d.id === parsed.docId && !d.isClosed)
  return doc ? auditName(doc) : undefined
}

/** Runs one call to completion. Never throws: failures come back as result.error. */
export async function executeCall(
  request: AgentCallRequest,
  signal: AbortSignal,
  deps: RunnerDeps
): Promise<{ result: AgentToolResult; audit: AgentAuditDetail }> {
  const def = deps.tool(request.tool)
  const handler = def ? deps.handlers[def.name] : undefined
  if (!def || !handler) {
    const message = def
      ? `${request.tool} is not available in this version of Fartcrobat.`
      : `Fartcrobat has no tool named "${request.tool}".`
    return { result: { error: { code: 'unknown_tool', message } }, audit: { outcome: 'error' } }
  }
  const audit: Partial<AgentAuditDetail> = {}
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
  finish: (result: AgentToolResult, audit: AgentAuditDetail) => void
  graceTimer: ReturnType<typeof setTimeout> | null
}

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
  progress: sendProgress
}

/** Runs a call from the main process and replies once, also when the agent cancelled it. */
export async function handleRequest(request: AgentCallRequest, deps: RunnerDeps = defaultDeps): Promise<void> {
  if (running.has(request.id)) return
  const controller = new AbortController()
  const started = Date.now()
  const def = deps.tool(request.tool)
  let replied = false
  const entry: Running = {
    controller,
    graceTimer: null,
    finish: (result, audit) => {
      if (replied) return
      replied = true
      if (entry.graceTimer) clearTimeout(entry.graceTimer)
      running.delete(request.id)
      lastProgress.delete(request.id)
      callFinished(request.id, {
        outcome: audit.outcome,
        ms: Date.now() - started,
        ...(audit.document ? { document: audit.document } : {}),
        ...(result.error ? { error: result.error.message } : {})
      })
      void Promise.resolve()
        .then(() => deps.reply({ id: request.id, result, audit }))
        .catch((err) => console.warn('Could not send the result of an agent call', err))
    }
  }
  running.set(request.id, entry)
  callStarted({
    id: request.id,
    tool: request.tool,
    title: def?.title ?? request.tool,
    client: appLabel(request.client?.name),
    document: documentOfHandle(request),
    started
  })
  const { result, audit } = await executeCall(request, controller.signal, deps)
  entry.finish(result, audit)
}

/** The agent cancelled a call: the handler sees its signal aborted and stops at its next check. */
export function cancelRequest(id: string, graceMs = CANCEL_GRACE_MS) {
  const entry = running.get(id)
  if (!entry || entry.controller.signal.aborted) return
  entry.controller.abort()
  // A handler that does not notice still gets its call answered, so nothing waits forever.
  entry.graceTimer = setTimeout(() => {
    entry.finish({ error: { code: 'aborted', message: 'The call was cancelled.' } }, { outcome: 'cancelled' })
  }, graceMs)
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
  stop = () => {
    offRequest()
    offCancel()
    stop = null
  }
  return stop
}
