/**
 * Window-side state of agent access: the connection status the main process reports, the recent
 * calls shown in the Agent activity panel (kept in memory only), and the outline show_in_app draws.
 * No React or renderer imports, so the helpers here are unit tested in Node.
 */
import { create } from 'zustand'
import type { Rect } from '@shared/geometry'
import type { AgentAuditDetail, AgentConnectionInfo, AgentStatus } from '@shared/agent/bridge'

/** Recent calls kept for the activity panel. */
export const MAX_CALLS = 200

export interface CallRecord {
  /** Request id ("<connection>:<call>"). */
  id: string
  tool: string
  /** The tool's title from the catalogue ("Find text"). */
  title: string
  /** How the AI app is named ("Claude"). */
  client: string
  /** Document path, or "untitled: <title>", as the audit log names it. */
  document?: string
  outcome: 'running' | AgentAuditDetail['outcome']
  error?: string
  started: number
  ms?: number
}

interface AgentUiState {
  status: AgentStatus | null
  calls: CallRecord[]
  /** Calls running in this window. */
  running: number
}

export const useAgentUi = create<AgentUiState>(() => ({ status: null, calls: [], running: 0 }))

export function setAgentStatus(status: AgentStatus | null) {
  useAgentUi.setState({ status })
}

// Tracked apart from the list: a long call can drop off the end of it while it still runs.
const runningIds = new Set<string>()

export function callStarted(record: Omit<CallRecord, 'outcome'>) {
  runningIds.add(record.id)
  useAgentUi.setState((s) => ({
    calls: [{ ...record, outcome: 'running' as const }, ...s.calls].slice(0, MAX_CALLS),
    running: runningIds.size
  }))
}

export function callFinished(id: string, patch: Pick<CallRecord, 'outcome'> & Partial<Pick<CallRecord, 'document' | 'error' | 'ms'>>) {
  runningIds.delete(id)
  useAgentUi.setState((s) => ({
    calls: s.calls.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    running: runningIds.size
  }))
}

// ---- labels ------------------------------------------------------------------------------------

/** How Fartcrobat names an AI app: "Claude" for Claude's apps, else what the app reported. */
export function appLabel(name: string | undefined): string {
  const n = (name ?? '').trim()
  if (!n) return 'AI app'
  return /claude/i.test(n) ? 'Claude' : n
}

/** The indicator text: "Claude connected", or "2 AI apps connected" for different apps. */
export function connectedLabel(connections: AgentConnectionInfo[]): string {
  const names = [...new Set(connections.map((c) => appLabel(c.client.name)))]
  if (names.length === 1) return `${names[0]} connected`
  return `${names.length} AI apps connected`
}

/** File name of an audit document name ("C:\a\b.pdf" -> "b.pdf", "untitled: Combined.pdf" -> "Combined.pdf"). */
export function documentLabel(document: string | undefined): string {
  if (!document) return ''
  if (document.startsWith('untitled: ')) return document.slice('untitled: '.length)
  return document.split(/[\\/]/).pop() || document
}

/** "10:42:07", or "10:42" without seconds. */
export function timeLabel(ms: number, seconds = true): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })
}

/** "120 ms", "3.4 s", "2 min" */
export function durationLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`
  return `${Math.round(ms / 60000)} min`
}

// ---- show_in_app outline -----------------------------------------------------------------------

export interface Flash {
  docId: string
  page: number
  rect: Rect
  key: number
}

export const useFlash = create<{ flash: Flash | null }>(() => ({ flash: null }))

let flashKey = 0

/** Outlines a region of a page for a moment, so the person sees what the agent is pointing at. */
export function flashRect(docId: string, page: number, rect: Rect, ms = 2600) {
  const key = ++flashKey
  useFlash.setState({ flash: { docId, page, rect, key } })
  setTimeout(() => {
    if (useFlash.getState().flash?.key === key) useFlash.setState({ flash: null })
  }, ms)
}
