import { spawnSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCallRequest, AgentStatus } from '@shared/agent/bridge'
import {
  AGENT_PROTOCOL_VERSION,
  LineDecoder,
  encodeMessage,
  type AgentAppInfo,
  type AgentEndpoint,
  type AppToShim,
  type ShimToApp
} from '@shared/agent/protocol'
import type { WindowHost } from './router'
import { AgentAccess, type AgentAccessOptions } from './service'

const describeUnix = process.platform === 'win32' ? describe.skip : describe
const waitFor = <T>(fn: () => T) => vi.waitFor(fn, { timeout: 5000, interval: 5 })

/** One window that listens straight away; records what main sends it. */
class FakeHost implements WindowHost {
  list = ['w1']
  requests: { windowId: string; request: AgentCallRequest }[] = []
  cancels: { windowId: string; id: string }[] = []
  windows() {
    return [...this.list]
  }
  current() {
    return this.list[0] ?? null
  }
  create(): string {
    throw new Error('not expected')
  }
  ready(id: string) {
    return Promise.resolve(this.list.includes(id))
  }
  request(windowId: string, request: AgentCallRequest) {
    this.requests.push({ windowId, request })
  }
  cancel(windowId: string, id: string) {
    this.cancels.push({ windowId, id })
  }
}

/** A shim as far as the pipe is concerned. */
class TestClient {
  messages: AppToShim[] = []
  closed = false
  private wake: (() => void)[] = []

  constructor(readonly socket: Socket) {
    socket.setEncoding('utf8')
    const decoder = new LineDecoder<AppToShim>(
      (m) => {
        this.messages.push(m)
        this.notify()
      },
      () => {}
    )
    socket.on('data', (chunk: string) => decoder.push(chunk))
    socket.on('error', () => {})
    socket.on('close', () => {
      this.closed = true
      this.notify()
    })
  }

  static connect(address: string): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(address)
      socket.once('connect', () => resolve(new TestClient(socket)))
      socket.once('error', reject)
    })
  }

  private notify() {
    for (const w of this.wake.splice(0)) w()
  }

  /** The next message of type `t` (others stay queued). */
  async next<T extends AppToShim['t']>(t: T): Promise<Extract<AppToShim, { t: T }>> {
    for (;;) {
      const i = this.messages.findIndex((m) => m.t === t)
      if (i >= 0) return this.messages.splice(i, 1)[0] as Extract<AppToShim, { t: T }>
      if (this.closed) throw new Error(`Connection closed while waiting for ${t}`)
      await new Promise<void>((r) => this.wake.push(r))
    }
  }

  async whenClosed(): Promise<void> {
    while (!this.closed) await new Promise<void>((r) => this.wake.push(r))
  }

  send(msg: ShimToApp) {
    this.socket.write(encodeMessage(msg))
  }

  raw(text: string) {
    this.socket.write(text)
  }
}

const hmac = (token: string, text: string) => createHmac('sha256', token).update(text).digest('hex')

/** Runs the handshake as the shim does, checking the app's proof too. */
async function authenticate(client: TestClient, token: string, name = 'claude-ai') {
  const hello = await client.next('hello')
  const nonce = randomBytes(32).toString('hex')
  client.send({
    t: 'auth',
    protocol: AGENT_PROTOCOL_VERSION,
    mac: hmac(token, `client:${hello.nonce}`),
    nonce,
    client: { name, version: '1.0' },
    shimVersion: '0.1.0'
  })
  const ready = await client.next('ready')
  expect(ready.mac).toBe(hmac(token, `server:${nonce}`))
  return ready
}

describeUnix('agent access pipe', () => {
  let tmp: string
  let userData: string
  let host: FakeHost
  let statuses: AgentStatus[]
  let service: AgentAccess
  const clients: TestClient[] = []
  const launch: AgentAppInfo = { executable: '/opt/Fartcrobat/fartcrobat', args: [], appVersion: '9.8.7' }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'fc-agent-'))
    userData = join(tmp, 'userData')
    host = new FakeHost()
    statuses = []
  })
  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.destroy()
    await service?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function start(opts: Partial<AgentAccessOptions> = {}, preference = true) {
    service = new AgentAccess({
      userData,
      appVersion: '9.8.7',
      launch,
      host,
      broadcast: (s) => statuses.push(s),
      env: {},
      policyFile: join(tmp, 'machine-policy.json'),
      tmpDir: tmp,
      ...opts
    })
    return service.setPreference(preference)
  }

  const endpointPath = () => join(userData, 'agent-access', 'endpoint.json')
  const endpoint = (): AgentEndpoint => JSON.parse(readFileSync(endpointPath(), 'utf8'))

  async function connect(): Promise<TestClient> {
    const c = await TestClient.connect(endpoint().address)
    clients.push(c)
    return c
  }

  async function connected(name?: string) {
    const c = await connect()
    const ready = await authenticate(c, endpoint().token, name)
    return { client: c, connectionId: ready.connectionId }
  }

  it('publishes endpoint.json for this user only, listens in a private folder and cleans up on stop', async () => {
    await start()
    const ep = endpoint()
    expect(statSync(endpointPath()).mode & 0o777).toBe(0o600)
    expect(ep).toMatchObject({ protocol: AGENT_PROTOCOL_VERSION, pid: process.pid, appVersion: '9.8.7' })
    expect(ep.token).toMatch(/^[0-9a-f]{64}$/)
    expect(ep.address.endsWith('agent.sock')).toBe(true)
    expect(statSync(ep.address).isSocket()).toBe(true)
    expect(statSync(ep.address).mode & 0o777).toBe(0o600)
    expect(statSync(dirname(ep.address)).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(join(userData, 'agent-access', 'app.json'), 'utf8'))).toEqual({
      ...launch,
      enabled: true
    })
    expect(service.status()).toMatchObject({
      enabled: true,
      policy: null,
      listening: true,
      connections: [],
      error: null
    })
    expect(service.status().auditLog).toBe(join(userData, 'agent-access', 'audit.jsonl'))

    await service.close()
    expect(existsSync(endpointPath())).toBe(false)
    expect(existsSync(dirname(ep.address))).toBe(false)
    // app.json stays so the shim can start the app next time.
    expect(existsSync(join(userData, 'agent-access', 'app.json'))).toBe(true)
  })

  it('keeps a replaced endpoint.json private', async () => {
    mkdirSync(dirname(endpointPath()), { recursive: true })
    writeFileSync(endpointPath(), '{}', { mode: 0o644 })
    chmodSync(endpointPath(), 0o644)
    await start()
    expect(statSync(endpointPath()).mode & 0o777).toBe(0o600)
    expect(endpoint().token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('removes endpoint.json at once when the app quits', async () => {
    await start()
    const { client } = await connected()
    service.shutdown()
    expect(existsSync(endpointPath())).toBe(false)
    expect((await client.next('notice')).event).toBe('shutdown')
    await client.whenClosed()
  })

  it('accepts a shim that knows the token and proves itself to it', async () => {
    await start()
    const c = await connect()
    const hello = await c.next('hello')
    expect(hello).toMatchObject({ t: 'hello', protocol: AGENT_PROTOCOL_VERSION, appVersion: '9.8.7' })
    expect(hello.nonce).toMatch(/^[0-9a-f]{64}$/)
    c.messages.unshift(hello)
    const ready = await authenticate(c, endpoint().token)
    c.send({ t: 'ping' })
    expect(await c.next('pong')).toEqual({ t: 'pong' })
    expect(service.status().connections).toEqual([
      {
        id: ready.connectionId,
        client: { name: 'claude-ai', version: '1.0' },
        since: expect.any(Number),
        running: 0
      }
    ])
    await waitFor(() => expect(statuses.at(-1)?.connections).toHaveLength(1))
  })

  it('rejects a wrong token and closes the connection', async () => {
    await start()
    const c = await connect()
    const hello = await c.next('hello')
    c.send({
      t: 'auth',
      protocol: AGENT_PROTOCOL_VERSION,
      mac: hmac('0'.repeat(64), `client:${hello.nonce}`),
      nonce: randomBytes(32).toString('hex'),
      client: { name: 'intruder', version: '1' },
      shimVersion: '1'
    })
    expect((await c.next('reject')).code).toBe('bad_auth')
    await c.whenClosed()
    expect(c.messages.some((m) => m.t === 'ready')).toBe(false)
    expect(service.status().connections).toEqual([])
  })

  it('rejects another protocol version, and a nonce echoed back', async () => {
    await start()
    const token = endpoint().token
    const a = await connect()
    const helloA = await a.next('hello')
    a.send({
      t: 'auth',
      protocol: 99,
      mac: hmac(token, `client:${helloA.nonce}`),
      nonce: randomBytes(32).toString('hex'),
      client: { name: 'x', version: '1' },
      shimVersion: '1'
    })
    expect((await a.next('reject')).code).toBe('protocol')
    await a.whenClosed()

    const b = await connect()
    const helloB = await b.next('hello')
    b.send({
      t: 'auth',
      protocol: AGENT_PROTOCOL_VERSION,
      mac: hmac(token, `client:${helloB.nonce}`),
      nonce: helloB.nonce,
      client: { name: 'x', version: '1' },
      shimVersion: '1'
    })
    expect((await b.next('reject')).code).toBe('protocol')
    await b.whenClosed()
  })

  it('closes a connection that sends a malformed line, before or after authenticating', async () => {
    await start()
    const before = await connect()
    await before.next('hello')
    before.raw('this is not json\n')
    await before.whenClosed()

    const { client } = await connected()
    client.raw('{"t":42}\n')
    await client.whenClosed()

    const third = (await connected()).client
    third.send({ t: 'call', id: '', tool: 'get_context', args: {} } as ShimToApp)
    await third.whenClosed()
    expect(host.requests).toHaveLength(0)
  })

  it('closes a connection that sends an oversized line', async () => {
    await start({ maxLine: 4096 })
    const { client } = await connected()
    client.raw('{"t":"call","id":"1","tool":"get_context","args":{"x":"' + 'a'.repeat(10_000))
    await client.whenClosed()

    // Before authenticating, much less is accepted.
    const early = await connect()
    await early.next('hello')
    early.raw('x'.repeat(70_000))
    await early.whenClosed()
  })

  it('closes a connection that does not authenticate in time', async () => {
    await start({ authTimeoutMs: 50 })
    const c = await connect()
    await c.next('hello')
    expect((await c.next('reject')).code).toBe('protocol')
    await c.whenClosed()
  })

  it('serves several AI apps at once and disconnects one on request', async () => {
    await start()
    const a = await connected('claude-ai')
    const b = await connected('other-app')
    expect(a.connectionId).not.toBe(b.connectionId)
    expect(
      service
        .status()
        .connections.map((c) => c.client.name)
        .sort()
    ).toEqual(['claude-ai', 'other-app'])
    service.disconnect(a.connectionId)
    // The AI app is told why before the connection closes.
    expect((await a.client.next('notice')).event).toBe('disconnected')
    await a.client.whenClosed()
    await waitFor(() => expect(service.status().connections.map((c) => c.id)).toEqual([b.connectionId]))
    b.client.send({ t: 'ping' })
    await b.client.next('pong')
  })

  it('keeps a disconnected AI app out until the person allows it again', async () => {
    await start()
    const a = await connected('claude-ai')
    a.client.send({ t: 'call', id: 'slow', tool: 'recognize_text', args: {} })
    await waitFor(() => expect(host.requests).toHaveLength(1))
    service.disconnect(a.connectionId)
    await a.client.whenClosed()
    // Its running call is cancelled in the window.
    await waitFor(() => expect(host.cancels).toEqual([{ windowId: 'w1', id: `${a.connectionId}:slow` }]))
    expect(service.status().blocked).toEqual(['claude-ai'])
    await waitFor(() => expect(statuses.at(-1)?.blocked).toEqual(['claude-ai']))

    // Reconnecting is refused with a reason; another AI app still connects.
    const again = await connect()
    const hello = await again.next('hello')
    again.send({
      t: 'auth',
      protocol: AGENT_PROTOCOL_VERSION,
      mac: hmac(endpoint().token, `client:${hello.nonce}`),
      nonce: randomBytes(32).toString('hex'),
      client: { name: 'claude-ai', version: '1.0' },
      shimVersion: '0.1.0'
    })
    const refused = await again.next('reject')
    expect(refused.code).toBe('blocked')
    expect(refused.message).toMatch(/disconnected this AI app/)
    await again.whenClosed()
    await connected('other-app')

    service.allow('claude-ai')
    expect(service.status().blocked).toEqual([])
    await connected('claude-ai')
  })

  it('drops the oldest connection still in its handshake rather than refusing new ones', async () => {
    await start()
    const idle: TestClient[] = []
    for (let i = 0; i < 20; i++) {
      const c = await connect()
      await c.next('hello')
      idle.push(c)
    }
    // Sixteen may wait for their handshake at once: the four oldest were closed.
    await waitFor(() =>
      expect(idle.map((c) => c.closed)).toEqual([...Array(4).fill(true), ...Array(16).fill(false)])
    )
    // A real AI app still gets in.
    await connected('claude-ai')
  })

  it('routes a call to its window, relays progress and the result, and audits it without content', async () => {
    await start()
    const { client, connectionId } = await connected()
    client.send({
      t: 'call',
      id: 'c1',
      tool: 'find_text',
      args: { handle: 'w1-b1-doc-2', query: 'John Smith', pages: '1-3' }
    })
    await waitFor(() => expect(host.requests).toHaveLength(1))
    const { windowId, request } = host.requests[0]
    expect(windowId).toBe('w1')
    expect(request).toEqual({
      id: `${connectionId}:c1`,
      connectionId,
      client: { name: 'claude-ai', version: '1.0' },
      windowId: 'w1',
      currentWindow: expect.any(Boolean),
      tool: 'find_text',
      args: { handle: 'w1-b1-doc-2', query: 'John Smith', pages: '1-3' }
    })
    await waitFor(() => expect(service.status().connections[0].running).toBe(1))
    await waitFor(() => expect(statuses.at(-1)?.connections[0]?.running).toBe(1))

    service.progress('w1', { id: request.id, progress: 1, total: 3, message: 'Page 1' })
    expect(await client.next('progress')).toEqual({
      t: 'progress',
      id: 'c1',
      progress: 1,
      total: 3,
      message: 'Page 1'
    })
    service.reply('w1', {
      id: request.id,
      result: { data: { hits: [{ page: 1, text: 'John Smith' }] } },
      audit: { document: '/home/me/contract.pdf', outcome: 'done', summary: '1 match' }
    })
    expect(await client.next('result')).toEqual({
      t: 'result',
      id: 'c1',
      result: { data: { hits: [{ page: 1, text: 'John Smith' }] } }
    })
    await waitFor(() => expect(statuses.at(-1)?.connections[0]?.running).toBe(0))

    await service.audit.flush()
    const auditPath = join(userData, 'agent-access', 'audit.jsonl')
    expect(statSync(auditPath).mode & 0o777).toBe(0o600)
    const text = readFileSync(auditPath, 'utf8')
    expect(text).not.toContain('John Smith')
    expect(JSON.parse(text.trim())).toMatchObject({
      connection: connectionId,
      client: 'claude-ai',
      tool: 'find_text',
      args: { handle: 'w1-b1-doc-2', query: '[not recorded]', pages: '1-3' },
      document: '/home/me/contract.pdf',
      outcome: 'done',
      summary: '1 match'
    })
  })

  it('answers unknown tools and unknown windows without asking a window', async () => {
    await start()
    const { client } = await connected()
    client.send({ t: 'call', id: 'a', tool: 'delete_everything', args: {} })
    client.send({ t: 'call', id: 'b', tool: 'get_context', args: { handle: 'w99-b1-doc-1' } })
    expect((await client.next('result')).result.error?.code).toBe('unknown_tool')
    expect((await client.next('result')).result.error?.code).toBe('stale_handle')
    expect(host.requests).toHaveLength(0)
  })

  it('forwards cancel to the window, and cancels running calls when the shim goes away', async () => {
    await start()
    const { client, connectionId } = await connected()
    client.send({ t: 'call', id: 'slow', tool: 'recognize_text', args: {} })
    client.send({ t: 'call', id: 'confirm', tool: 'apply_redactions', args: {} })
    await waitFor(() => expect(host.requests).toHaveLength(2))
    client.send({ t: 'cancel', id: 'slow' })
    await waitFor(() => expect(host.cancels).toEqual([{ windowId: 'w1', id: `${connectionId}:slow` }]))
    service.reply('w1', {
      id: `${connectionId}:slow`,
      result: { error: { code: 'aborted', message: 'The call was cancelled.' } }
    })
    expect((await client.next('result')).result.error?.code).toBe('aborted')

    client.socket.destroy()
    await waitFor(() =>
      expect(host.cancels).toContainEqual({ windowId: 'w1', id: `${connectionId}:confirm` })
    )
    await waitFor(() => expect(service.status().connections).toEqual([]))
  })

  it('answers stale_handle when the window closes with a call running', async () => {
    await start()
    const { client } = await connected()
    client.send({ t: 'call', id: 'c1', tool: 'apply_redactions', args: { handle: 'w1-b1-doc-1' } })
    await waitFor(() => expect(host.requests).toHaveLength(1))
    host.list = []
    service.windowGone('w1')
    expect((await client.next('result')).result.error?.code).toBe('stale_handle')
  })

  it('stops when turned off, telling connected apps, and starts again with a new token', async () => {
    await start()
    const first = endpoint()
    const { client } = await connected()
    await service.setPreference(false)
    expect((await client.next('notice')).event).toBe('disabled')
    await client.whenClosed()
    expect(existsSync(endpointPath())).toBe(false)
    // The shim reads this before starting the app for a call.
    const appFile = () => JSON.parse(readFileSync(join(userData, 'agent-access', 'app.json'), 'utf8'))
    expect(appFile()).toEqual({ ...launch, enabled: false })
    expect(existsSync(dirname(first.address))).toBe(false)
    expect(service.status()).toMatchObject({ enabled: false, listening: false, connections: [] })
    await waitFor(() => expect(statuses.at(-1)).toMatchObject({ enabled: false, listening: false }))

    await service.setPreference(true)
    const second = endpoint()
    expect(second.token).not.toBe(first.token)
    expect(second.address).not.toBe(first.address)
    expect(appFile()).toEqual({ ...launch, enabled: true })
    await connected()
  })

  it('does not start when turned off in Preferences, and says so in app.json', async () => {
    await start({}, false)
    expect(existsSync(endpointPath())).toBe(false)
    expect(service.status()).toMatchObject({ enabled: false, policy: null, listening: false })
    expect(JSON.parse(readFileSync(join(userData, 'agent-access', 'app.json'), 'utf8'))).toEqual({
      ...launch,
      enabled: false
    })
  })

  it('removes an endpoint.json left by a run that crashed, but not one of a running app', async () => {
    const leftover = (pid: number) => {
      mkdirSync(dirname(endpointPath()), { recursive: true })
      writeFileSync(
        endpointPath(),
        JSON.stringify({
          protocol: 1,
          address: '/gone/agent.sock',
          token: 'f'.repeat(64),
          pid,
          appVersion: '1'
        })
      )
    }
    const exited = spawnSync(process.execPath, ['-e', '']).pid
    leftover(exited)
    await start({}, false)
    expect(existsSync(endpointPath())).toBe(false)

    leftover(process.ppid)
    await service.setPreference(false)
    expect(existsSync(endpointPath())).toBe(true)
  })

  it('lets a policy file decide over the preference', async () => {
    const policyFile = join(tmp, 'policy.json')
    writeFileSync(policyFile, JSON.stringify({ agentAccess: { enabled: false } }))
    await start({ env: { FARTCROBAT_POLICY_FILE: policyFile } }, true)
    expect(service.status()).toMatchObject({ enabled: false, policy: 'disabled', listening: false })
    expect(existsSync(endpointPath())).toBe(false)

    writeFileSync(policyFile, JSON.stringify({ agentAccess: { enabled: true } }))
    await service.setPreference(false)
    expect(service.status()).toMatchObject({ enabled: true, policy: 'enabled', listening: true })
    expect(existsSync(endpointPath())).toBe(true)
  })

  it('reports a start-up problem in the status', async () => {
    await start({ tmpDir: join(tmp, 'missing', 'folder') })
    expect(service.status()).toMatchObject({ enabled: true, listening: false })
    expect(service.status().error).toMatch(/Could not start agent access/)
    expect(existsSync(endpointPath())).toBe(false)
  })
})
