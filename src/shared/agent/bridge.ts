/**
 * Agent access: messages between the main process (which owns the local pipe) and the windows
 * (which own the documents). The main process authenticates connections, routes each call to one
 * window, and writes the audit log; a window runs the tool and replies.
 *
 * Routing rules (main process):
 * - A call whose args.handle is set goes to the window named at the start of the handle
 *   ("<windowId>-<boot>-doc-<n>", where windowId is "w<webContents id>"; <boot> changes on every
 *   renderer load, so handles from before a reload are stale). An unknown window gives the error
 *   stale_handle without reaching any renderer.
 * - wait_for_result goes to the window named at the start of args.ticket ("<windowId>-...").
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
  /**
   * True when this window is the focused one, or the most recently focused: calls without a
   * handle go there, and only its active document is reported as `active`.
   */
  currentWindow: boolean
  /**
   * Fixed at routing time so a list_documents fan-out cannot join multiple windows, and false for a
   * shim that would drop the companion token (shimForwardsCompanion).
   */
  allowCompanionJoin?: boolean
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
  /**
   * 'done' | 'declined' (the person said no) | 'cancelled' (a dialog was dismissed or the agent
   * cancelled) | 'error' | 'pending' (answered still_running; the outcome is logged later with the
   * wait_for_result call that returns it).
   */
  outcome: 'done' | 'declined' | 'cancelled' | 'error' | 'pending'
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
  /** The MCP helper's version: a Claude Desktop extension keeps the one it was added with. */
  shimVersion: string
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
  /** AI apps (by reported name) the person disconnected this session; they cannot reconnect until allowed again. */
  blocked: string[]
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
