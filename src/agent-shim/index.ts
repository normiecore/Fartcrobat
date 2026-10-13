// The MCP server AI apps (Claude Desktop, through the Fartcrobat extension) start over stdio. It
// advertises the agent tools and passes each call to the running Fartcrobat, starting it if needed.
// stdout carries MCP only: everything else is logged to stderr.
import { CLIENT_INFO_META_KEY, Server, type ServerContext } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { SERVER_INSTRUCTIONS, type AgentClientInfo } from '@shared/agent/protocol'
import { agentTool } from '@shared/agent/tools'
import { AppLink, logToStderr } from './app'
import { errorResult, mcpTools, toCallToolResult } from './result'

/** package.json's version, filled in by scripts/build-agent-shim.mjs. */
declare const __FARTCROBAT_VERSION__: string | undefined
const VERSION = typeof __FARTCROBAT_VERSION__ === 'string' ? __FARTCROBAT_VERSION__ : '0.0.0-dev'

const TOOLS = mcpTools()

/** The AI app as it introduced itself: per request on the 2026 protocol, at initialize before that. */
function clientOf(server: Server, ctx: ServerContext): AgentClientInfo {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined
  const info = (envelope?.[CLIENT_INFO_META_KEY] ?? server.getClientVersion()) as
    { name?: unknown; version?: unknown } | undefined
  return {
    name: typeof info?.name === 'string' && info.name ? info.name : 'unknown',
    version: typeof info?.version === 'string' ? info.version : ''
  }
}

function createServer(link: AppLink): Server {
  const server = new Server(
    { name: 'fartcrobat', title: 'Fartcrobat', version: VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  )
  server.setRequestHandler('tools/list', () => ({ tools: TOOLS }))
  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name, arguments: args } = request.params
    if (!agentTool(name))
      return toCallToolResult(errorResult('unknown_tool', `Fartcrobat has no tool named "${name}".`))
    const progressToken = request.params._meta?.progressToken
    const result = await link.call(name, args ?? {}, {
      client: clientOf(server, ctx),
      signal: ctx.mcpReq.signal,
      onProgress:
        progressToken === undefined
          ? undefined
          : ({ progress, total, message }) =>
              void ctx.mcpReq
                .notify({
                  method: 'notifications/progress',
                  params: {
                    progressToken,
                    progress,
                    ...(typeof total === 'number' ? { total } : {}),
                    ...(typeof message === 'string' ? { message } : {})
                  }
                })
                .catch(() => {})
    })
    return server.projectCallToolResult(toCallToolResult(result), undefined)
  })
  return server
}

const link = new AppLink({ shimVersion: VERSION })
const handle = serveStdio(() => createServer(link), {
  onerror: (err) => logToStderr(`MCP: ${err.message}`)
})

// The AI app closed this helper: cancel what is running in Fartcrobat, disconnect and exit.
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  link.close()
  void handle.close().catch(() => {})
  setTimeout(() => process.exit(0), 2000).unref()
}
process.stdin.once('end', shutdown)
process.stdin.once('close', shutdown)
