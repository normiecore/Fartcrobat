// How the shim presents Fartcrobat's tools and their results to an AI app over MCP.
import type { CallToolResult, Tool } from '@modelcontextprotocol/server'
import type { AgentClientInfo, AgentErrorCode, AgentToolResult } from '@shared/agent/protocol'
import { AGENT_TOOLS } from '@shared/agent/tools'

/** The tool catalogue as MCP lists it: the shared definitions, minus the app's gate and category. */
export function mcpTools(): Tool[] {
  return AGENT_TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
    name,
    title,
    description,
    inputSchema: inputSchema as Tool['inputSchema'],
    annotations
  }))
}

/**
 * The AI app as it introduced itself over MCP. A missing name stays empty, so Fartcrobat shows its
 * own wording for an AI app that did not say who it is.
 */
export function clientInfo(info: unknown): AgentClientInfo {
  const { name, version } = (info && typeof info === 'object' ? info : {}) as {
    name?: unknown
    version?: unknown
  }
  return {
    name: typeof name === 'string' ? name.trim() : '',
    version: typeof version === 'string' ? version : ''
  }
}

export function errorResult(code: AgentErrorCode, message: string): AgentToolResult {
  return { error: { code, message } }
}

/**
 * An AgentToolResult as MCP content: `data` as one JSON text block, `images` as image blocks, and an
 * error as isError with "[code] message" (the code tells the agent whether a retry makes sense).
 */
export function toCallToolResult(result: AgentToolResult): CallToolResult {
  if (result.error) {
    const { code, message } = result.error
    return { content: [{ type: 'text', text: `[${String(code)}] ${String(message)}` }], isError: true }
  }
  const content: CallToolResult['content'] = []
  if (result.data !== undefined) content.push({ type: 'text', text: JSON.stringify(result.data, null, 1) })
  for (const image of result.images ?? [])
    if (image && typeof image.data === 'string' && typeof image.mimeType === 'string')
      content.push({ type: 'image', data: image.data, mimeType: image.mimeType })
  // An empty content list reads as "nothing happened" to a model; say the tool finished.
  if (!content.length) content.push({ type: 'text', text: 'Done.' })
  return { content }
}
