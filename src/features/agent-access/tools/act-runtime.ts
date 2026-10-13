// Window-side glue shared by the handlers that change things: argument errors, engine errors,
// confirmations and the undo label to report back.
import { createElement, Fragment, type ReactNode } from 'react'
import { invoke, useApp, type DocumentModel } from '@renderer/sdk'
import { EngineCallError } from '@renderer/engine/EngineClient'
import { commitActiveEditors, hasActiveEditors } from '@renderer/app/commands'
import { ToolError, auditName, clientLabel, confirmAgentAction, throwIfAborted, type ToolContext } from './common'
import { InvalidArgs } from './act-common'
import { agentAuthor } from './act-annots'

/** Confirmation text: one paragraph per line. */
export function paragraphs(...lines: string[]): ReactNode {
  return createElement(Fragment, null, ...lines.map((line, i) => createElement('p', { key: i }, line)))
}

/** Runs argument checks, reporting InvalidArgs as "[invalid_args] ...". */
export function checked<T>(fn: () => T): T {
  try {
    return fn()
  } catch (err) {
    if (err instanceof InvalidArgs) throw new ToolError('invalid_args', err.message)
    throw err
  }
}

/** Engine failures the agent can act on get their own code; anything else stays "failed". */
export function toolErrorFrom(err: unknown, what: string): Error {
  if (err instanceof ToolError) return err
  if (err instanceof InvalidArgs) return new ToolError('invalid_args', err.message)
  if (err instanceof EngineCallError) {
    if (err.code === 'CLOSED') return new ToolError('stale_handle', 'The document was closed. Call list_documents.')
    if (err.code === 'NO_ANNOTATION') return new ToolError('invalid_args', `${err.message}. Call list_annotations for current ids.`)
    return new ToolError('failed', `${what}: ${err.message}`)
  }
  return new ToolError('failed', `${what}: ${err instanceof Error ? err.message : String(err)}`)
}

/** Awaits an engine task, reporting its failure as a ToolError. */
export async function engineTask<T>(what: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    throw toolErrorFrom(err, what)
  }
}

/** The undo step the document now offers ("Agent: Add Highlight"), read from the engine. */
export async function undoLabel(doc: DocumentModel): Promise<string | null> {
  try {
    return (await doc.core.doc.journal()).undoLabel
  } catch {
    return doc.state.journal.undoLabel
  }
}

/** Author of comments and replies an agent adds: "Agent (Claude)". */
export function agentName(ctx: ToolContext): string {
  return agentAuthor(clientLabel(ctx))
}

/** Commits the person's pending typing (as Save and Close do) so it is not lost or overwritten. */
export async function commitTyping() {
  if (hasActiveEditors()) await commitActiveEditors()
}

/**
 * Asks the person to allow an irreversible step. Declining (or the agent cancelling) ends the call:
 * the audit records "declined" and the agent is told not to retry.
 */
export async function requireConfirmation(
  ctx: ToolContext,
  doc: DocumentModel | null,
  opts: { title: string; message: ReactNode; confirmLabel: string; details?: string[] },
  declined: string
): Promise<void> {
  const ok = await confirmAgentAction(ctx, opts)
  if (ok) return
  throwIfAborted(ctx)
  ctx.audit({ ...(doc ? { document: auditName(doc) } : {}), outcome: 'declined', summary: declined })
  throw new ToolError('declined', `The person declined in Fartcrobat: ${declined}. Do not retry unless they ask.`)
}

/** Ends a call whose dialog the person closed without finishing. */
export function cancelled(ctx: ToolContext, doc: DocumentModel | null, summary: string, message: string): ToolError {
  ctx.audit({ ...(doc ? { document: auditName(doc) } : {}), outcome: 'cancelled', summary })
  return new ToolError('cancelled', message)
}

/**
 * Runs fn while bringing the window to the front whenever it opens a dialog (a password prompt,
 * Sign, Protect...), so the person sees what the agent is waiting for.
 */
export async function withAttention<T>(fn: () => Promise<T>): Promise<T> {
  let count = useApp.getState().dialogs.length
  const unsubscribe = useApp.subscribe((s) => {
    if (s.dialogs.length > count) void invoke('feature:agent-access:attention').catch(() => {})
    count = s.dialogs.length
  })
  try {
    return await fn()
  } finally {
    unsubscribe()
  }
}

/**
 * Hands a step to the person (a password prompt, the Sign or Protect dialog): brings the window to
 * the front when the dialog opens, and if the agent cancels meanwhile, dismisses the dialogs
 * opened since, so the flow ends as if the person had cancelled.
 */
export async function handoff<T>(ctx: ToolContext, fn: () => Promise<T>): Promise<T> {
  throwIfAborted(ctx)
  const before = new Set(useApp.getState().dialogs.map((d) => d.id))
  const onAbort = () => {
    for (const d of [...useApp.getState().dialogs].reverse()) if (!before.has(d.id)) d.resolve(undefined)
  }
  ctx.signal.addEventListener('abort', onAbort)
  try {
    const result = await withAttention(fn)
    throwIfAborted(ctx)
    return result
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
  }
}
