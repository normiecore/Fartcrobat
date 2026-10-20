// Agent access end to end: the built app plus the built MCP shim (out/agent/shim.mjs), driven by an
// MCP client over stdio exactly as Claude Desktop drives the Fartcrobat extension.
import { expect, type Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, launch, type App } from './helpers'

export const SHIM = join(ROOT, 'out/agent/shim.mjs')

export const agentDir = (userData: string) => join(userData, 'agent-access')
export const endpointFile = (userData: string) => join(agentDir(userData), 'endpoint.json')
export const auditFile = (userData: string) => join(agentDir(userData), 'audit.jsonl')

export interface ToolResult {
  content: { type: string; text?: string; data?: string; mimeType?: string }[]
  isError?: boolean
}

export interface Agent {
  client: Client
  /** What the shim wrote to stderr (its log). */
  stderr(): string
  /** Tools called so far, in order. */
  calls: string[]
  /** Calls a tool and returns the MCP result (errors are results with isError, not exceptions). */
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  /**
   * Starts a call that waits for the person (a confirmation, a password prompt). If the test fails
   * before awaiting it, closing the shim rejects it: that must not hide the test's own failure.
   */
  start(name: string, args?: Record<string, unknown>): Promise<ToolResult>
  close(): Promise<void>
}

/**
 * Starts the built shim with an MCP client, as an AI app does. `client` is how the AI app introduces
 * itself ("claude-ai" is Claude Desktop). The shim finds the app through FARTCROBAT_USER_DATA; it
 * gets the display and ELECTRON_DISABLE_SANDBOX so a copy of the app it starts (to hand over to the
 * running one) can come up on this machine, like the app the tests launch with --no-sandbox.
 */
export async function startShim(userData: string, client = { name: 'claude-ai', version: '0.14.0' }, shim = SHIM): Promise<Agent> {
  const env: Record<string, string> = { ...getDefaultEnvironment(), FARTCROBAT_USER_DATA: userData, ELECTRON_DISABLE_SANDBOX: '1' }
  for (const key of ['DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key]) env[key] = process.env[key]!
  const transport = new StdioClientTransport({ command: process.execPath, args: [shim], env, stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
    if (process.env.AGENT_DEBUG) process.stderr.write(`[shim] ${chunk}`)
  })
  const mcp = new Client(client)
  await mcp.connect(transport)
  const calls: string[] = []
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    calls.push(name)
    if (process.env.AGENT_DEBUG) process.stderr.write(`[call] ${name}\n`)
    return (await mcp.callTool({ name, arguments: args }, { timeout: 120_000 })) as ToolResult
  }
  return {
    client: mcp,
    stderr: () => stderr,
    calls,
    call,
    start(name, args) {
      const pending = call(name, args)
      pending.catch(() => {})
      return pending
    },
    close: () => mcp.close().catch(() => {})
  }
}

export interface Session extends App {
  agent: Agent
  close(): Promise<void>
}

/**
 * Launches the app with its own profile, holding the single-instance lock like an installed copy
 * (so a copy the shim starts hands over to it), waits for it to publish its endpoint, and connects
 * the shim.
 */
export async function startSession(files: string[] = [], env: Record<string, string> = {}): Promise<Session> {
  const a = await launch(files, { FARTCROBAT_MULTI_INSTANCE: '', ...env })
  try {
    await expect.poll(() => existsSync(endpointFile(a.userData)), { timeout: 30_000 }).toBe(true)
    const agent = await startShim(a.userData)
    return {
      ...a,
      agent,
      close: async () => {
        await agent.close()
        await a.app.close()
      }
    }
  } catch (err) {
    await a.app.close()
    throw err
  }
}

/** The text of a result's text blocks. */
export function textOf(result: ToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? (c.text ?? '') : `<${c.type}>`)).join('\n')
}

/** The JSON data of a successful result (fails the test with the error text otherwise). */
export function dataOf<T = any>(result: ToolResult): T {
  expect(result.isError, textOf(result)).toBeFalsy()
  const block = result.content.find((c) => c.type === 'text')
  expect(block, 'a text block with the data').toBeTruthy()
  return JSON.parse(block!.text!) as T
}

/** The error text of a failed result ("[code] message"). */
export function errorOf(result: ToolResult): string {
  expect(result.isError, `expected an error, got ${textOf(result)}`).toBe(true)
  return textOf(result)
}

export interface AuditLine {
  time: string
  connection: number
  client: string
  tool: string
  args: Record<string, unknown>
  document?: string
  outcome: 'done' | 'declined' | 'cancelled' | 'error' | 'pending'
  summary?: string
  error?: string
  ms: number
}

export function auditText(userData: string): string {
  const file = auditFile(userData)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export function auditLines(userData: string): AuditLine[] {
  return auditText(userData)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditLine)
}

/**
 * The audit log has exactly one line per call that reached the app (`tools`, in order) and none of
 * the `secrets` (comment text, search text, form values, passwords) anywhere.
 */
export async function expectAudit(userData: string, tools: string[], secrets: string[] = []) {
  await expect.poll(() => auditLines(userData).map((l) => l.tool), { timeout: 15_000 }).toEqual(tools)
  const text = auditText(userData)
  for (const s of secrets) expect(text, `the audit log must not contain "${s}"`).not.toContain(s)
  return auditLines(userData)
}

/** The undo label the active document offers (Edit > Undo). */
export async function undoLabel(page: Page): Promise<string | null> {
  return page.evaluate(() => (window as any).__fartcrobat.getActiveDoc()?.state.journal.undoLabel ?? null)
}

/** Text of a page of the active document, from the app itself. */
export async function appPageText(page: Page, index: number): Promise<string> {
  return page.evaluate(async (i) => (await (window as any).__fartcrobat.getActiveDoc().pageText(i)).text as string, index)
}
