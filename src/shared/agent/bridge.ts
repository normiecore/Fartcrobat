/**
 * Agent access: messages between the main process (which owns the local pipe) and the windows
 * (which own the documents). The main process authenticates connections, routes each call to one
 * window, and writes the audit log; a window runs the tool and replies.
 *
 * Routing rules (main process):
 * - A call whose args.handle is set goes to the window named in the handle ("w<windowId>-<docId>").
 *   An unknown window gives the error stale_handle without reaching any renderer.
 * - list_documents goes to every window; main concatenates their `data.documents` arrays
 *   (in window creation order) and returns { documents }.
 * - Anything else goes to the focused window, or the most recently focused one, creating a
 *   window if none exists.
 */
import type { AgentClientInfo, AgentToolResult } from './protocol'

/** Main -> window: run a tool (IPC event 'agent:request'). */
export interface AgentCallRequest {
  /** Unique across connections ("<connectionId>:<call id>"). */
  id: string
  connectionId: number
  client: AgentClientInfo
  /** This window's id, as handles spell it ("w<webContents id>"). Handles minted here use it. */
  windowId: string
  tool: string
  args: Record<string, unknown>
}

/** Window -> main: the tool finished (invoke 'feature:agent-access:reply'). */
export interface AgentCallReply {
  id: string
  result: AgentToolResult
  /** For the audit log: document path or title the call acted on, and what happened. */
  audit?: AgentAuditDetail
}

export interface AgentAuditDetail {
  /** File path, or "untitled: <title>" for documents that are not saved yet. */
  document?: string
  /** 'done' | 'declined' (the person said no) | 'cancelled' (a dialog was dismissed) | 'error'. */
  outcome: 'done' | 'declined' | 'cancelled' | 'error'
  /** Short description of what changed, never document content: "3 redaction marks", "saved to <path>". */
  summary?: string
}

/** Window -> main: progress of a running call (invoke 'feature:agent-access:progress'). */
export interface AgentProgress {
  id: string
  progress: number
  total?: number
  message?: string
}

export interface AgentConnectionInfo {
  id: number
  client: AgentClientInfo
  /** ms since epoch */
  since: number
  /** Calls running now. */
  running: number
}

/** Main -> window (IPC event 'agent:status', also returned by 'feature:agent-access:status'). */
export interface AgentStatus {
  /** Agent access is on (preference and machine policy). */
  enabled: boolean
  /** Set when a machine policy file decides it; the Preferences switch is then read-only. */
  policy: 'enabled' | 'disabled' | null
  /** The pipe is listening. */
  listening: boolean
  connections: AgentConnectionInfo[]
  /** Path of the audit log. */
  auditLog: string
  /** Last start-up problem (e.g. could not create the pipe), shown in Preferences. */
  error: string | null
}

/** One line of audit.jsonl. Never holds document content, passwords or tool argument values except paths and page ranges. */
export interface AgentAuditEntry {
  /** ISO time the call finished. */
  time: string
  connection: number
  client: string
  tool: string
  /** Argument names given (values left out), plus handle, path and pages values. */
  args: Record<string, unknown>
  document?: string
  outcome: AgentAuditDetail['outcome']
  summary?: string
  error?: string
  ms: number
}
