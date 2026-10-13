// The audit log: one line per finished agent call, never with document content or passwords.
import { appendFile, mkdir, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentAuditDetail, AgentAuditEntry } from '@shared/agent/bridge'
import type { AgentToolResult } from '@shared/agent/protocol'

/** Arguments whose values are recorded: they say which document and pages, not what is in them. */
const RECORDED = new Set(['handle', 'path', 'paths', 'pages'])
/** Stands in for every other argument's value (comment text, form values, search queries...). */
export const NOT_RECORDED = '[not recorded]'
/** The log is rotated (one .1 backup kept) once it grows past this. */
export const AUDIT_MAX_BYTES = 10 * 1024 * 1024

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text
}

function recordedValue(value: unknown): unknown {
  if (typeof value === 'string') return clip(value, 2000)
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value))
    return value
      .slice(0, 200)
      .map((v) => (typeof v === 'string' ? clip(v, 2000) : typeof v === 'number' ? v : NOT_RECORDED))
  return NOT_RECORDED
}

/** The argument names an agent gave, with values only for handle, path, paths and pages. */
export function auditArgs(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {}
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(args).slice(0, 50))
    out[clip(name, 100)] = RECORDED.has(name) ? recordedValue(value) : NOT_RECORDED
  return out
}

const OUTCOMES = new Set<string>(['done', 'declined', 'cancelled', 'error'])

export function auditOutcome(result: AgentToolResult, detail?: AgentAuditDetail): AgentAuditEntry['outcome'] {
  const said = detail && OUTCOMES.has(detail.outcome) ? detail.outcome : undefined
  const code = result.error?.code
  if (!code) return said ?? 'done'
  if (said && said !== 'done') return said
  return code === 'declined' ? 'declined' : code === 'cancelled' ? 'cancelled' : 'error'
}

export interface FinishedCall {
  connection: number
  client: string
  tool: string
  args: unknown
  result: AgentToolResult
  detail?: AgentAuditDetail
  started: number
  finished: number
}

export function auditEntry(call: FinishedCall): AgentAuditEntry {
  const { detail, result } = call
  // Keys in the order of AgentAuditEntry, for people reading the file.
  return {
    time: new Date(call.finished).toISOString(),
    connection: call.connection,
    client: clip(call.client, 100),
    tool: clip(call.tool, 100),
    args: auditArgs(call.args),
    ...(detail?.document ? { document: clip(String(detail.document), 2000) } : {}),
    outcome: auditOutcome(result, detail),
    ...(detail?.summary ? { summary: clip(String(detail.summary), 500) } : {}),
    // The code only: messages can quote what the agent searched for or typed.
    ...(result.error ? { error: String(result.error.code) } : {}),
    ms: Math.max(0, Math.round(call.finished - call.started))
  }
}

/** Appends entries in order; the file is created readable by this user only. */
export class AuditLog {
  private chain: Promise<void> = Promise.resolve()

  constructor(
    readonly file: string,
    private readonly maxBytes = AUDIT_MAX_BYTES
  ) {}

  append(entry: AgentAuditEntry): Promise<void> {
    const line = JSON.stringify(entry) + '\n'
    return this.enqueue(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      let size = 0
      try {
        size = (await stat(this.file)).size
      } catch {}
      if (size > this.maxBytes) {
        // A backup held open elsewhere (Windows) must not cost the entry: keep appending.
        await rename(this.file, this.file + '.1').catch((err) =>
          console.error('Could not rotate the agent audit log', err)
        )
      }
      await appendFile(this.file, line, { mode: 0o600 })
    })
  }

  /** Creates the (empty) file when there is none yet, so it can be shown in the file manager. */
  ensure(): Promise<void> {
    return this.enqueue(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      try {
        await writeFile(this.file, '', { flag: 'wx', mode: 0o600 })
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      }
    })
  }

  /** Resolves once everything appended so far is written. */
  flush(): Promise<void> {
    return this.chain
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    this.chain = this.chain
      .then(write)
      .catch((err) => console.error('Could not write the agent audit log', err))
    return this.chain
  }
}
