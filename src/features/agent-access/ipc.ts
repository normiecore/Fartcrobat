import type { AgentCallReply, AgentProgress, AgentStatus } from '@shared/agent/bridge'

/** IPC channels of this feature (handled in main.ts). Events are declared in @shared/ipc. */
declare module '@shared/ipc' {
  interface IpcApi {
    /** A window finished a tool call. */
    'feature:agent-access:reply': (reply: AgentCallReply) => void
    /** A window reports progress of a long tool call. */
    'feature:agent-access:progress': (progress: AgentProgress) => void
    /** Current connections and settings. */
    'feature:agent-access:status': () => AgentStatus
    /** Closes one connection, or all of them. */
    'feature:agent-access:disconnect': (connectionId?: number) => void
    /** Brings the calling window to the front (a confirmation is waiting for the person). */
    'feature:agent-access:attention': () => void
    /** Shows the audit log in the file manager. */
    'feature:agent-access:revealAuditLog': () => void
    /**
     * Opens the bundled Claude Desktop extension (.mcpb) with the system, which offers to install
     * it in Claude Desktop. Returns '' on success, else the message to show.
     */
    'feature:agent-access:installExtension': () => string
  }
}

export {}
