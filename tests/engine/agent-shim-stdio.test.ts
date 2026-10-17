// The built MCP shim end to end: an MCP client starts it over stdio, and a fake Fartcrobat (the app
// side of @shared/agent/protocol, with the real token and HMACs) answers on a local socket.
import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AGENT_DIR,
  AGENT_PROTOCOL_VERSION,
  APP_FILE,
  ENDPOINT_FILE,
  LineDecoder,
  SERVER_INSTRUCTIONS,
  encodeMessage,
  macInput,
  type AgentEndpoint,
  type AppToShim,
  type AuthMessage,
  type CallMessage,
  type RejectMessage,
  type ShimToApp
} from '@shared/agent/protocol'
import { AGENT_TOOLS } from '@shared/agent/tools'

const ROOT = resolve(__dirname, '../..')
const VERSION: string = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
const DISABLED = '[disabled] Agent access is turned off in Fartcrobat (Preferences > AI apps).'
const DISCONNECTED =
  '[disabled] The person disconnected this AI app in Fartcrobat, so the call was stopped and may or may not have taken effect. Do not use Fartcrobat again unless they ask.'
const BLOCKED =
  '[disabled] The person disconnected this AI app in Fartcrobat. Do not use Fartcrobat again unless they ask; they can allow it again in Fartcrobat (Preferences > AI apps).'
const SLOW = { timeout: 20_000 }

const hmac = (token: string, role: 'client' | 'server', nonce: string) =>
  createHmac('sha256', token).update(macInput(role, nonce), 'utf8').digest('hex')

type Behaviour = (call: CallMessage, reply: (msg: AppToShim) => void, socket: Socket) => void

/** The app side of the pipe protocol, as Fartcrobat's main process speaks it. */
class FakeApp {
  readonly token = randomBytes(32).toString('hex')
  readonly auths: AuthMessage[] = []
  readonly calls: CallMessage[] = []
  readonly cancels: string[] = []
  /** Everything the shim sent after the handshake. */
  readonly received: ShimToApp[] = []
  connections = 0
  serverMac: 'right' | 'wrong' = 'right'
  rejectWith: RejectMessage | null = null
  behaviour: Behaviour = (call, reply) =>
    reply({ t: 'result', id: call.id, result: { data: { tool: call.tool, args: call.args } } })
  readonly address: string
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private readonly authenticated = new Set<Socket>()

  constructor(
    private readonly userData: string,
    dir: string
  ) {
    this.address =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\fartcrobat-shim-test-${randomBytes(8).toString('hex')}`
        : join(mkdtempSync(join(dir, 'sock-')), 'agent.sock')
    this.server = createServer((socket) => this.accept(socket))
  }

  async start(): Promise<this> {
    await new Promise<void>((done) => this.server.listen(this.address, done))
    const endpoint: AgentEndpoint = {
      protocol: AGENT_PROTOCOL_VERSION,
      address: this.address,
      token: this.token,
      pid: process.pid,
      appVersion: '9.9.9'
    }
    mkdirSync(join(this.userData, AGENT_DIR), { recursive: true })
    writeFileSync(join(this.userData, AGENT_DIR, ENDPOINT_FILE), JSON.stringify(endpoint))
    return this
  }

  async stop() {
    rmSync(join(this.userData, AGENT_DIR, ENDPOINT_FILE), { force: true })
    for (const s of this.sockets) s.destroy()
    await new Promise<void>((done) => this.server.close(() => done()))
  }

  /** What the app does when the person clicks Disconnect: it says so, then closes the connection. */
  disconnectAll() {
    for (const socket of this.authenticated) {
      socket.write(encodeMessage({ t: 'notice', event: 'disconnected' }))
      socket.end()
    }
  }

  private accept(socket: Socket) {
    this.sockets.add(socket)
    socket.on('close', () => {
      this.sockets.delete(socket)
      this.authenticated.delete(socket)
    })
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    const nonce = randomBytes(32).toString('hex')
    const write = (msg: AppToShim) => {
      if (!socket.destroyed) socket.write(encodeMessage(msg))
    }
    let ready = false
    const decoder = new LineDecoder<ShimToApp>(
      (msg) => {
        if (ready) {
          this.received.push(msg)
          if (msg.t === 'call') {
            this.calls.push(msg)
            this.behaviour(msg, write, socket)
          } else if (msg.t === 'cancel') this.cancels.push(msg.id)
          else if (msg.t === 'ping') write({ t: 'pong' })
          return
        }
        if (msg.t !== 'auth') return socket.destroy()
        this.auths.push(msg)
        const expected = Buffer.from(hmac(this.token, 'client', nonce), 'hex')
        const given = Buffer.from(String(msg.mac), 'hex')
        if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
          write({ t: 'reject', code: 'bad_auth', message: 'Authentication failed.' })
          return socket.end()
        }
        if (this.rejectWith) {
          write(this.rejectWith)
          return socket.end()
        }
        ready = true
        this.authenticated.add(socket)
        this.connections++
        const mac = hmac(
          this.token,
          'server',
          this.serverMac === 'right' ? msg.nonce : randomBytes(32).toString('hex')
        )
        write({ t: 'ready', mac, connectionId: this.connections })
      },
      () => socket.destroy()
    )
    socket.on('data', (chunk: string) => decoder.push(chunk))
    write({ t: 'hello', protocol: AGENT_PROTOCOL_VERSION, appVersion: '9.9.9', nonce })
  }
}

let work: string
let shimPath: string

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), 'fc-shim-'))
  // The real build, into a folder with no node_modules near it: the bundle must stand alone.
  execFileSync(process.execPath, [join(ROOT, 'scripts/build-agent-shim.mjs'), join(work, 'build')], {
    cwd: ROOT,
    stdio: 'pipe'
  })
  shimPath = join(work, 'build', 'shim.mjs')
}, 120_000)

afterAll(() => rmSync(work, { recursive: true, force: true }))

describe('agent shim over stdio', () => {
  let userData: string
  const cleanup: (() => unknown)[] = []

  beforeEach(() => {
    userData = mkdtempSync(join(work, 'user-'))
  })
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn()
  })

  async function startApp(): Promise<FakeApp> {
    const app = await new FakeApp(userData, work).start()
    cleanup.push(() => app.stop())
    return app
  }

  async function startShim(
    mode: 'legacy' | 'auto' = 'legacy',
    info = { name: 'test-client', version: '1.2.3' }
  ) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [shimPath],
      env: { ...getDefaultEnvironment(), FARTCROBAT_USER_DATA: userData },
      stderr: 'pipe'
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk) => (stderr += String(chunk)))
    const client = new Client(info, mode === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {})
    await client.connect(transport)
    cleanup.push(() => client.close())
    return { client, stderr: () => stderr }
  }

  const text = (result: { content?: unknown }) =>
    (result.content as { type: string; text?: string }[]).map((c) => c.text ?? `<${c.type}>`).join('\n')

  it('advertises every tool with their schemas, its name and the instructions', async () => {
    const { client } = await startShim()
    expect(client.getServerVersion()).toMatchObject({ name: 'fartcrobat', version: VERSION })
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(AGENT_TOOLS.length)
    expect(tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name))
    for (const [i, tool] of tools.entries()) {
      expect(tool.title).toBe(AGENT_TOOLS[i].title)
      expect(tool.inputSchema).toEqual(AGENT_TOOLS[i].inputSchema)
      expect(tool.annotations).toEqual(AGENT_TOOLS[i].annotations)
    }
  })

  it('authenticates with the token and returns data as one JSON text block', async () => {
    const app = await startApp()
    const { client } = await startShim()
    const result = await client.callTool({ name: 'get_page_text', arguments: { pages: '1-2' } })
    expect(result.isError).toBeFalsy()
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ tool: 'get_page_text', args: { pages: '1-2' } }, null, 1) }
    ])
    expect(app.auths).toHaveLength(1)
    expect(app.auths[0]).toMatchObject({
      protocol: AGENT_PROTOCOL_VERSION,
      client: { name: 'test-client', version: '1.2.3' },
      shimVersion: VERSION
    })
    expect(app.auths[0].nonce).toMatch(/^[0-9a-f]{64}$/)

    // Later calls use the same connection.
    await client.callTool({ name: 'list_documents', arguments: {} })
    expect(app.connections).toBe(1)
    expect(app.calls.map((c) => c.tool)).toEqual(['get_page_text', 'list_documents'])
    expect(new Set(app.calls.map((c) => c.id)).size).toBe(2)
  })

  it('returns images as image blocks and errors as "[code] message"', async () => {
    const app = await startApp()
    app.behaviour = (call, reply) =>
      reply(
        call.tool === 'render_page'
          ? {
              t: 'result',
              id: call.id,
              result: { data: { page: 1 }, images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }] }
            }
          : {
              t: 'result',
              id: call.id,
              result: { error: { code: 'declined', message: 'The person declined in Fartcrobat.' } }
            }
      )
    const { client } = await startShim()
    const rendered = await client.callTool({ name: 'render_page', arguments: { page: 1 } })
    expect(rendered.content).toEqual([
      { type: 'text', text: JSON.stringify({ page: 1 }, null, 1) },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    ])
    const declined = await client.callTool({ name: 'apply_redactions', arguments: {} })
    expect(declined.isError).toBe(true)
    expect(text(declined)).toBe('[declined] The person declined in Fartcrobat.')
  })

  it('answers unknown tools itself', async () => {
    const app = await startApp()
    const { client } = await startShim()
    const result = await client.callTool({ name: 'format_disk', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('[unknown_tool] Fartcrobat has no tool named "format_disk".')
    expect(app.connections).toBe(0)
  })

  it('forwards progress as MCP progress notifications', async () => {
    const app = await startApp()
    let finish = () => {}
    app.behaviour = (call, reply) => {
      reply({ t: 'progress', id: call.id, progress: 1, total: 2, message: 'Page 1 of 2' })
      reply({ t: 'progress', id: call.id, progress: 2, total: 2 })
      finish = () => reply({ t: 'result', id: call.id, result: { data: { recognized: 2 } } })
    }
    const { client } = await startShim()
    const seen: unknown[] = []
    const call = client.callTool(
      { name: 'recognize_text', arguments: {} },
      { onprogress: (p) => seen.push({ ...p }) }
    )
    // The SDK client handles notifications a tick after responses, so the result waits for them.
    await expect.poll(() => seen.length, SLOW).toBe(2)
    finish()
    expect(text(await call)).toBe(JSON.stringify({ recognized: 2 }, null, 1))
    expect(seen).toEqual([
      { progress: 1, total: 2, message: 'Page 1 of 2' },
      { progress: 2, total: 2 }
    ])
  })

  it('forwards cancellation to the app', async () => {
    const app = await startApp()
    app.behaviour = () => {}
    const { client } = await startShim()
    const stop = new AbortController()
    const call = client.callTool(
      { name: 'recognize_text', arguments: { pages: 'all' } },
      { signal: stop.signal }
    )
    call.catch(() => {})
    await expect.poll(() => app.calls.length, SLOW).toBe(1)
    stop.abort()
    await expect(call).rejects.toThrow()
    await expect.poll(() => app.cancels, SLOW).toEqual([app.calls[0].id])
  })

  it('cancels running calls and disconnects when the AI app goes away', async () => {
    const app = await startApp()
    app.behaviour = () => {}
    const { client, stderr } = await startShim()
    client.callTool({ name: 'recognize_text', arguments: {} }).catch(() => {})
    await expect.poll(() => app.calls.length, SLOW).toBe(1)
    await client.close()
    await expect.poll(() => app.cancels, SLOW).toEqual([app.calls[0].id])
    await expect.poll(() => stderr(), SLOW).toContain('Disconnected from Fartcrobat')
  })

  it('sends nothing to an app that cannot prove it holds the token', async () => {
    const app = await startApp()
    app.serverMac = 'wrong'
    const { client } = await startShim()
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      '[failed] Could not verify that the program answering is Fartcrobat, so nothing was sent to it. Restart Fartcrobat, then try again.'
    )
    expect(app.auths).toHaveLength(1)
    expect(app.received).toEqual([])
    expect(app.calls).toEqual([])
  })

  it('says when agent access is turned off', async () => {
    const app = await startApp()
    app.rejectWith = { t: 'reject', code: 'disabled', message: 'Agent access is off.' }
    const { client } = await startShim()
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(DISABLED)
  })

  it('stops the calls of an AI app the person disconnects, and stays out until they allow it again', async () => {
    const app = await startApp()
    app.behaviour = () => {}
    // Something the shim could start: it must not, as the app is running and refusing.
    const marker = join(userData, 'started.json')
    const script = join(userData, 'fake-fartcrobat.cjs')
    writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], '{}')\n")
    writeFileSync(
      join(userData, AGENT_DIR, APP_FILE),
      JSON.stringify({
        executable: process.execPath,
        args: [script, marker],
        appVersion: '9.9.9',
        enabled: true
      })
    )
    const { client, stderr } = await startShim()
    const running = client.callTool({ name: 'recognize_text', arguments: {} })
    await expect.poll(() => app.calls.length, SLOW).toBe(1)
    app.disconnectAll()
    expect(text(await running)).toBe(DISCONNECTED)
    await expect
      .poll(() => stderr(), SLOW)
      .toContain('Disconnected from Fartcrobat (connection 1): the person disconnected this AI app.')

    // The app now refuses this AI app; each call asks once and gives up, starting nothing.
    app.rejectWith = { t: 'reject', code: 'blocked', message: 'Text from the app is not shown.' }
    for (let i = 0; i < 2; i++) {
      const refused = await client.callTool({ name: 'list_documents', arguments: {} })
      expect(refused.isError).toBe(true)
      expect(text(refused)).toBe(BLOCKED)
    }
    expect(app.auths).toHaveLength(3)
    expect(app.connections).toBe(1)
    expect(existsSync(marker)).toBe(false)

    // The person allowed it again.
    app.rejectWith = null
    app.behaviour = (call, reply) => reply({ t: 'result', id: call.id, result: { data: 'ok' } })
    expect(text(await client.callTool({ name: 'list_documents', arguments: {} }))).toBe('"ok"')
    expect(app.connections).toBe(2)
    expect(existsSync(marker)).toBe(false)
  })

  it('says Fartcrobat closed when the connection drops mid-call, then reconnects', async () => {
    const app = await startApp()
    app.behaviour = (_call, _reply, socket) => socket.destroy()
    const { client } = await startShim()
    const dropped = await client.callTool({ name: 'save_document', arguments: {} })
    expect(dropped.isError).toBe(true)
    expect(text(dropped)).toBe(
      '[failed] Fartcrobat closed before the call finished, so it may or may not have taken effect. Check the document in Fartcrobat before trying again.'
    )

    // Turned off while a call ran: the app says so before it closes the connection.
    app.behaviour = (_call, reply, socket) => {
      reply({ t: 'notice', event: 'disabled' })
      socket.end()
    }
    const off = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(text(off)).toBe(DISABLED)

    app.behaviour = (call, reply) => reply({ t: 'result', id: call.id, result: { data: 'ok' } })
    const again = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(text(again)).toBe('"ok"')
    expect(app.connections).toBe(3)
  })

  it('reconnects to a restarted app with its new token', async () => {
    const first = await startApp()
    const { client, stderr } = await startShim()
    await client.callTool({ name: 'list_documents', arguments: {} })
    expect(first.calls).toHaveLength(1)
    await first.stop()
    await expect.poll(() => stderr(), SLOW).toContain('Disconnected from Fartcrobat')

    const second = await startApp()
    expect(second.token).not.toBe(first.token)
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(second.calls).toHaveLength(1)
    expect(first.calls).toHaveLength(1)
  })

  it('starts the app from app.json on the first call, not before', async () => {
    const marker = join(userData, 'started.json')
    const script = join(userData, 'fake-fartcrobat.cjs')
    writeFileSync(
      script,
      [
        "const fs = require('node:fs')",
        'fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, userData: process.env.FARTCROBAT_USER_DATA }))',
        // Stays open like the real app (the test stops it); gives up on its own if the test does not.
        'setTimeout(() => {}, 60000)'
      ].join('\n')
    )
    mkdirSync(join(userData, AGENT_DIR), { recursive: true })
    writeFileSync(
      join(userData, AGENT_DIR, APP_FILE),
      JSON.stringify({ executable: process.execPath, args: [script, marker], appVersion: '9.9.9' })
    )
    cleanup.push(() => {
      if (!existsSync(marker)) return
      try {
        process.kill(JSON.parse(readFileSync(marker, 'utf8')).pid)
      } catch {}
    })

    const { client } = await startShim()
    await client.listTools()
    expect(existsSync(marker)).toBe(false)

    const call = client.callTool({ name: 'list_documents', arguments: {} })
    await expect.poll(() => existsSync(marker), SLOW).toBe(true)
    expect(JSON.parse(readFileSync(marker, 'utf8')).userData).toBe(userData)
    // The started "app" comes up and publishes its endpoint; the waiting call goes through.
    const app = await startApp()
    const result = await call
    expect(result.isError).toBeFalsy()
    expect(app.calls.map((c) => c.tool)).toEqual(['list_documents'])
  })

  it('says agent access is off, starting nothing, when app.json says so', async () => {
    // A copy that would stay open without ever publishing an endpoint: starting it would make the
    // call wait for the start timeout instead of answering.
    const marker = join(userData, 'started.json')
    const script = join(userData, 'fake-fartcrobat.cjs')
    writeFileSync(
      script,
      [
        "require('node:fs').writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }))",
        'setTimeout(() => {}, 60000)'
      ].join('\n')
    )
    mkdirSync(join(userData, AGENT_DIR), { recursive: true })
    writeFileSync(
      join(userData, AGENT_DIR, APP_FILE),
      JSON.stringify({
        executable: process.execPath,
        args: [script, marker],
        appVersion: '9.9.9',
        enabled: false
      })
    )
    cleanup.push(() => {
      if (!existsSync(marker)) return
      try {
        process.kill(JSON.parse(readFileSync(marker, 'utf8')).pid)
      } catch {}
    })
    const { client } = await startShim()
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(DISABLED)
    expect(existsSync(marker)).toBe(false)
  })

  it('says an open Fartcrobat did not accept the connection when a started copy hands over to it', async () => {
    // An app.json from an app that does not record whether agent access is on.
    const script = join(userData, 'second-instance.cjs')
    writeFileSync(script, 'process.exit(0)\n')
    mkdirSync(join(userData, AGENT_DIR), { recursive: true })
    writeFileSync(
      join(userData, AGENT_DIR, APP_FILE),
      JSON.stringify({ executable: process.execPath, args: [script], appVersion: '9.9.9' })
    )
    const { client } = await startShim()
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      '[failed] Fartcrobat is open but did not accept the connection. Check that Preferences > AI apps allows AI apps to work with your documents, then try again.'
    )
  })

  it('says Fartcrobat is not running when there is nothing to start', async () => {
    const { client } = await startShim()
    const result = await client.callTool({ name: 'list_documents', arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      '[failed] Fartcrobat is not running and could not be started. Open Fartcrobat, then try again.'
    )
  })

  it('leaves the name empty for an AI app that does not give one, so Fartcrobat words it', async () => {
    const app = await startApp()
    const { client } = await startShim('legacy', { name: '', version: '' })
    expect(text(await client.callTool({ name: 'list_documents', arguments: {} }))).toBe(
      JSON.stringify({ tool: 'list_documents', args: {} }, null, 1)
    )
    expect(app.auths[0].client).toEqual({ name: '', version: '' })
  })

  it('serves the 2026-07-28 protocol as well', async () => {
    const app = await startApp()
    const { client } = await startShim('auto')
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28')
    expect((await client.listTools()).tools).toHaveLength(AGENT_TOOLS.length)
    const result = await client.callTool({ name: 'get_context', arguments: {} })
    expect(text(result)).toBe(JSON.stringify({ tool: 'get_context', args: {} }, null, 1))
    expect(app.auths[0].client).toEqual({ name: 'test-client', version: '1.2.3' })
  })
})
