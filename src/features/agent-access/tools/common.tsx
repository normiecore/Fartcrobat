// Helpers shared by every agent tool handler (renderer side).
import type { ReactNode } from 'react'
import type { Rect } from '@shared/geometry'
import type { AgentAuditDetail, AgentCallRequest } from '@shared/agent/bridge'
import type { AgentErrorCode, AgentImage } from '@shared/agent/protocol'
import { Button, Dialog, getActiveDoc, invoke, openDialog, useApp, type DocumentModel } from '@renderer/sdk'
import '../ipc'

/** Prefix of undo labels for changes an agent made ("Agent: Add Comment"). */
export const AGENT_ACTOR = 'Agent'

export interface ToolContext {
  request: AgentCallRequest
  /** Aborted when the agent cancels the call or disconnects. */
  signal: AbortSignal
  /** Reports progress of a long call (0..total). */
  progress(progress: number, total?: number, message?: string): void
  /** What the audit log records about this call (merged; outcome defaults to 'done'). */
  audit(detail: Partial<AgentAuditDetail>): void
}

/** What a handler returns on success. Errors are thrown as ToolError. */
export interface ToolOutput {
  data?: unknown
  images?: AgentImage[]
}

export type ToolHandler<A = Record<string, unknown>> = (args: A, ctx: ToolContext) => Promise<ToolOutput>

/** A tool failure the agent should see as "[code] message". */
export class ToolError extends Error {
  constructor(
    readonly code: AgentErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ToolError'
  }
}

// ---- documents and handles -------------------------------------------------------------------

const HANDLE = /^(w\d+)-(doc-\d+)$/

/** The handle an agent uses for a document of this window: "w<window>-doc-<n>". */
export function handleOf(ctx: ToolContext, doc: DocumentModel): string {
  return `${ctx.request.windowId}-${doc.id}`
}

export function parseHandle(handle: string): { windowId: string; docId: string } | null {
  const m = HANDLE.exec(handle)
  return m ? { windowId: m[1], docId: m[2] } : null
}

/**
 * The document a call acts on: the one named by `handle`, or the one the person is looking at.
 * Throws no_document / stale_handle.
 */
export function resolveDoc(ctx: ToolContext, handle?: unknown): DocumentModel {
  if (handle === undefined || handle === null || handle === '') {
    const doc = getActiveDoc()
    if (!doc) throw new ToolError('no_document', 'No document is open in Fartcrobat. Use open_document, or ask the person to open one.')
    return doc
  }
  if (typeof handle !== 'string') throw new ToolError('invalid_args', 'handle must be a string')
  const parsed = parseHandle(handle)
  if (!parsed) throw new ToolError('stale_handle', `"${handle}" is not a document handle. Call list_documents for current handles.`)
  if (parsed.windowId !== ctx.request.windowId) throw new ToolError('stale_handle', `Document ${handle} is not open any more. Call list_documents.`)
  const doc = useApp.getState().docs.find((d) => d.id === parsed.docId && !d.isClosed)
  if (!doc) throw new ToolError('stale_handle', `Document ${handle} is not open any more. Call list_documents.`)
  return doc
}

/** What the audit log names a document by: its path, or its title when it is not saved yet. */
export function auditName(doc: DocumentModel): string {
  return doc.state.filePath ?? `untitled: ${doc.state.title}`
}

/** Short summary of a document, as list_documents and open_document return it. */
export function describeDoc(ctx: ToolContext, doc: DocumentModel) {
  const s = doc.state
  return {
    handle: handleOf(ctx, doc),
    title: s.title,
    path: s.filePath,
    pageCount: s.info.pageCount,
    currentPage: s.currentPage + 1,
    active: useApp.getState().activeDocId === doc.id,
    unsavedChanges: s.dirty,
    encrypted: !!s.info.encryption
  }
}

/** Runs fn with the document's engine calls labelled as the agent's ("Agent: <label>" in Undo). */
export function runAsAgent<T>(doc: DocumentModel, fn: () => Promise<T>): Promise<T> {
  return doc.engine.runAs(AGENT_ACTOR, fn)
}

// ---- arguments ----------------------------------------------------------------------------------

export function throwIfAborted(ctx: ToolContext) {
  if (ctx.signal.aborted) throw new ToolError('aborted', 'The call was cancelled.')
}

/**
 * Parses a 1-based page range ("all", "3", "2-5", "1,3,7-9", "last") into sorted unique 0-based
 * indices. `fallback` is used when spec is missing.
 */
export function parsePages(spec: unknown, pageCount: number, fallback: 'all' | 'current' = 'all', current = 0): number[] {
  if (spec === undefined || spec === null || spec === '') {
    return fallback === 'all' ? Array.from({ length: pageCount }, (_, i) => i) : [Math.min(current, pageCount - 1)]
  }
  if (typeof spec !== 'string') throw new ToolError('invalid_args', 'pages must be a string such as "1-3,5"')
  const text = spec.trim().toLowerCase()
  if (text === 'all') return Array.from({ length: pageCount }, (_, i) => i)
  const out = new Set<number>()
  for (const raw of text.split(',')) {
    const part = raw.trim()
    if (!part) continue
    const m = /^(\d+|last)(?:\s*-\s*(\d+|last))?$/.exec(part)
    if (!m) throw new ToolError('invalid_args', `Cannot read page range "${spec}". Use "all", "3", "2-5" or "1,3,7-9".`)
    const num = (v: string) => (v === 'last' ? pageCount : Number(v))
    const a = num(m[1])
    const b = m[2] ? num(m[2]) : a
    if (a < 1 || b < 1 || a > pageCount || b > pageCount)
      throw new ToolError('invalid_args', `Page ${Math.max(a, b) > pageCount ? Math.max(a, b) : Math.min(a, b)} does not exist: the document has ${pageCount} pages.`)
    for (let p = Math.min(a, b); p <= Math.max(a, b); p++) out.add(p - 1)
  }
  if (!out.size) throw new ToolError('invalid_args', `No pages in "${spec}".`)
  return [...out].sort((x, y) => x - y)
}

/** A 1-based page number argument as a 0-based index. */
export function pageIndex(page: unknown, pageCount: number, name = 'page'): number {
  if (typeof page !== 'number' || !Number.isInteger(page)) throw new ToolError('invalid_args', `${name} must be a whole number from 1`)
  if (page < 1 || page > pageCount) throw new ToolError('invalid_args', `${name} ${page} does not exist: the document has ${pageCount} pages.`)
  return page - 1
}

/** A rect argument, normalised so x0 <= x1 and y0 <= y1. */
export function rectArg(value: unknown, name = 'rect'): Rect {
  if (!Array.isArray(value) || value.length !== 4 || value.some((v) => typeof v !== 'number' || !Number.isFinite(v)))
    throw new ToolError('invalid_args', `${name} must be [x0, y0, x1, y1] in points`)
  const [a, b, c, d] = value as number[]
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)]
}

/** Points as numbers rounded to 0.01 for compact output. */
export function round(r: readonly number[]): number[] {
  return r.map((v) => Math.round(v * 100) / 100)
}

// ---- the person -------------------------------------------------------------------------------

/** How the confirmation names the agent: "Claude" for Claude's apps, else what the client reported. */
export function clientLabel(ctx: ToolContext): string {
  const name = ctx.request.client.name || 'An AI agent'
  return /claude/i.test(name) ? 'Claude' : name
}

/**
 * Asks the person in Fartcrobat whether the agent may go ahead. Decline is the default button and
 * Escape declines. Resolves false when the agent cancels the call meanwhile.
 */
export async function confirmAgentAction(
  ctx: ToolContext,
  opts: { title: string; message: ReactNode; confirmLabel: string; details?: string[] }
): Promise<boolean> {
  throwIfAborted(ctx)
  void invoke('feature:agent-access:attention').catch(() => {})
  let close: ((r?: boolean) => void) | null = null
  const onAbort = () => close?.(false)
  ctx.signal.addEventListener('abort', onAbort)
  try {
    const result = await openDialog<boolean>((c) => {
      close = c
      return (
        <Dialog
          title={opts.title}
          onClose={() => c(false)}
          width={460}
          className="fc-agent-access-confirm"
          footer={
            <>
              <Button variant="secondary" onClick={() => c(false)}>
                Decline
              </Button>
              <Button variant="danger" onClick={() => c(true)}>
                {opts.confirmLabel}
              </Button>
            </>
          }
        >
          <div className="ui-dialog-message">
            <p className="fc-agent-access-confirm-who">Requested by {clientLabel(ctx)} through agent access.</p>
            {opts.message}
            {opts.details?.length ? (
              <ul className="fc-agent-access-confirm-details">
                {opts.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </Dialog>
      )
    })
    return result === true && !ctx.signal.aborted
  } finally {
    ctx.signal.removeEventListener('abort', onAbort)
  }
}
