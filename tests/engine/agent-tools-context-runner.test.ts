// Agent access: the window's request runner (runner.ts): handler lookup, error mapping, audit
// outcomes, committing pending typing, cancellation and replying exactly once.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCallReply, AgentCallRequest, AgentProgress } from '@shared/agent/bridge'
import { agentTool } from '@shared/agent/tools'

let runner: typeof import('@features/agent-access/runner')
let common: typeof import('@features/agent-access/tools/common')
let ui: typeof import('@features/agent-access/ui/store')
let EngineCallError: typeof import('@renderer/engine/EngineClient').EngineCallError
let useApp: typeof import('@renderer/app/store').useApp

beforeAll(async () => {
  vi.stubGlobal('window', {})
  await import('@renderer/app/registry')
  runner = await import('@features/agent-access/runner')
  common = await import('@features/agent-access/tools/common')
  ui = await import('@features/agent-access/ui/store')
  ;({ EngineCallError } = await import('@renderer/engine/EngineClient'))
  ;({ useApp } = await import('@renderer/app/store'))
})

beforeEach(() => {
  ui.useAgentUi.setState({ calls: [], running: 0 })
  useApp.setState({ docs: [], activeDocId: null })
})

let nextId = 1
function request(tool: string, args: Record<string, unknown> = {}): AgentCallRequest {
  return { id: `1:${nextId++}`, connectionId: 1, client: { name: 'claude-ai', version: '1.0' }, windowId: 'w1', currentWindow: true, tool, args }
}

type Handler = (args: Record<string, unknown>, ctx: import('@features/agent-access/tools/common').ToolContext) => Promise<any>

function deps(handlers: Record<string, Handler>, log: string[] = []) {
  const replies: AgentCallReply[] = []
  const progress: AgentProgress[] = []
  const d = {
    handlers,
    tool: agentTool,
    commitEditors: async () => void log.push('commit'),
    reply: async (r: AgentCallReply) => void replies.push(r),
    progress: (p: AgentProgress) => void progress.push(p)
  }
  return { d, replies, progress, log }
}

/** A promise with its resolve function (to hold a handler until the test lets it go). */
function gate<T = void>() {
  let open!: (v: T) => void
  const promise = new Promise<T>((r) => (open = r))
  return { promise, open }
}

describe('executeCall', () => {
  it('answers unknown tools without running anything', async () => {
    const { d } = deps({})
    const unknown = await runner.executeCall(request('format_disk'), new AbortController().signal, d)
    expect(unknown.result.error).toEqual({ code: 'unknown_tool', message: 'Fartcrobat has no tool named "format_disk".' })
    expect(unknown.audit.outcome).toBe('error')
    // a catalogue tool this build has no handler for
    const missing = await runner.executeCall(request('get_context'), new AbortController().signal, d)
    expect(missing.result.error?.code).toBe('unknown_tool')
    expect(missing.result.error?.message).toMatch(/not available/)
  })

  it('returns data and images and what the handler told the audit log', async () => {
    const { d } = deps({
      render_page: async (_args, ctx) => {
        ctx.audit({ document: '/a.pdf', summary: 'page 1' })
        return { data: { page: 1 }, images: [{ data: 'AAAA', mimeType: 'image/png' }] }
      }
    })
    const out = await runner.executeCall(request('render_page', { page: 1 }), new AbortController().signal, d)
    expect(out.result).toEqual({ data: { page: 1 }, images: [{ data: 'AAAA', mimeType: 'image/png' }] })
    expect(out.audit).toEqual({ document: '/a.pdf', summary: 'page 1', outcome: 'done' })
  })

  it('turns failures into tool errors and audit outcomes', async () => {
    const throwing = (err: unknown) => async () => {
      throw err
    }
    const cases: [unknown, string, string][] = [
      [new common.ToolError('declined', 'The person declined.'), 'declined', 'declined'],
      [new common.ToolError('cancelled', 'Dialog closed.'), 'cancelled', 'cancelled'],
      [new common.ToolError('aborted', 'The call was cancelled.'), 'aborted', 'cancelled'],
      [new common.ToolError('invalid_args', 'Bad page.'), 'invalid_args', 'error'],
      [new EngineCallError('Document is closed', 'CLOSED'), 'stale_handle', 'error'],
      [new EngineCallError('Annotation 5 not found', 'NOT_FOUND'), 'failed', 'error'],
      [new Error('MuPDF exploded'), 'failed', 'error'],
      ['a string', 'failed', 'error']
    ]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const [err, code, outcome] of cases) {
      const { d } = deps({ find_text: throwing(err) })
      const out = await runner.executeCall(request('find_text', { query: 'x' }), new AbortController().signal, d)
      expect(out.result.error?.code).toBe(code)
      expect(out.result.data).toBeUndefined()
      expect(out.audit.outcome).toBe(outcome)
    }
    warn.mockRestore()
  })

  it('reports a failure after the agent cancelled as cancelled', async () => {
    const controller = new AbortController()
    const { d } = deps({
      find_text: async () => {
        controller.abort()
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
    })
    const out = await runner.executeCall(request('find_text', { query: 'x' }), controller.signal, d)
    expect(out.result.error?.code).toBe('aborted')
    expect(out.audit.outcome).toBe('cancelled')
  })

  it('commits pending typing before tools that change documents, not before reading', async () => {
    const log: string[] = []
    const handler: Handler = async () => {
      log.push('run')
      return { data: {} }
    }
    const { d } = deps({ get_context: handler, show_in_app: handler, add_annotations: handler, save_document: handler, apply_redactions: handler }, log)
    for (const tool of ['get_context', 'show_in_app']) await runner.executeCall(request(tool), new AbortController().signal, d)
    expect(log).toEqual(['run', 'run'])
    log.length = 0
    for (const tool of ['add_annotations', 'save_document', 'apply_redactions']) await runner.executeCall(request(tool), new AbortController().signal, d)
    expect(log).toEqual(['commit', 'run', 'commit', 'run', 'commit', 'run'])
  })

  it('names the document of the handle when the handler did not, and passes {} for bad args', async () => {
    let seen: unknown = null
    const { d } = deps({
      undo: async (args) => {
        seen = args
        return {}
      }
    })
    const doc = { id: 'doc-77', isClosed: false, state: { filePath: '/x/report.pdf', title: 'report.pdf' } }
    useApp.setState({ docs: [doc as any] })
    const named = await runner.executeCall(request('undo', { handle: `w1-${common.BOOT}-doc-77` }), new AbortController().signal, d)
    expect(named.audit).toEqual({ document: '/x/report.pdf', outcome: 'done' })
    // the same document id in another window, or from before a reload, is another document
    const elsewhere = await runner.executeCall(request('undo', { handle: `w2-${common.BOOT}-doc-77` }), new AbortController().signal, d)
    expect(elsewhere.audit).toEqual({ outcome: 'done' })
    const earlier = await runner.executeCall(request('undo', { handle: `w1-x${common.BOOT}-doc-77` }), new AbortController().signal, d)
    expect(earlier.audit).toEqual({ outcome: 'done' })
    const bad = { ...request('undo'), args: ['nope'] as unknown as Record<string, unknown> }
    await runner.executeCall(bad, new AbortController().signal, d)
    expect(seen).toEqual({})
  })

  it('keeps an outcome the handler chose for a call that returned normally', async () => {
    const { d } = deps({
      sign_document: async (_args, ctx) => {
        ctx.audit({ outcome: 'cancelled' })
        return { data: { cancelled: true } }
      }
    })
    const out = await runner.executeCall(request('sign_document'), new AbortController().signal, d)
    expect(out.audit.outcome).toBe('cancelled')
    expect(out.result).toEqual({ data: { cancelled: true } })
  })
})

describe('handleRequest', () => {
  it('replies once per call, forwards progress and records the call for the activity panel', async () => {
    const { d, replies, progress } = deps({
      find_text: async (_args, ctx) => {
        ctx.progress(1, 2, 'Searching')
        ctx.audit({ document: 'C:\\docs\\a.pdf' })
        return { data: { count: 0 } }
      }
    })
    const req = request('find_text', { query: 'x' })
    await runner.handleRequest(req, d)
    expect(replies).toEqual([{ id: req.id, result: { data: { count: 0 }, companion: expect.objectContaining({ status: 'joined', session: expect.stringMatching(/^w1-chat-/) }) }, audit: { document: 'C:\\docs\\a.pdf', outcome: 'done' } }])
    expect(progress).toEqual([{ id: req.id, progress: 1, total: 2, message: 'Searching' }])
    const [rec] = ui.useAgentUi.getState().calls
    expect(rec).toMatchObject({ id: req.id, tool: 'find_text', title: 'Find text', client: 'Claude', outcome: 'done', document: 'C:\\docs\\a.pdf' })
    expect(rec.ms).toBeGreaterThanOrEqual(0)
    expect(ui.useAgentUi.getState().running).toBe(0)
  })

  it('runs calls side by side: a quick call is not held up by a slow one', async () => {
    const slow = gate()
    const { d, replies } = deps({
      recognize_text: async () => {
        await slow.promise
        return { data: 'slow' }
      },
      get_context: async () => ({ data: 'quick' })
    })
    const a = request('recognize_text')
    const b = request('get_context')
    const first = runner.handleRequest(a, d)
    expect(ui.useAgentUi.getState().running).toBe(1)
    await runner.handleRequest(b, d)
    expect(replies.map((r) => r.id)).toEqual([b.id])
    expect(runner.runningCalls()).toEqual([a.id])
    slow.open()
    await first
    expect(replies.map((r) => r.id)).toEqual([b.id, a.id])
  })

  it('ignores a request whose id is already running', async () => {
    const hold = gate()
    let runs = 0
    const { d, replies } = deps({
      undo: async () => {
        runs++
        await hold.promise
        return {}
      }
    })
    const req = request('undo')
    const first = runner.handleRequest(req, d)
    await runner.handleRequest(req, d)
    hold.open()
    await first
    expect(runs).toBe(1)
    expect(replies).toHaveLength(1)
  })

  it('cancels: the handler sees its signal aborted and the call is answered as cancelled', async () => {
    const started = gate()
    const { d, replies } = deps({
      recognize_text: async (_args, ctx) => {
        started.open()
        await new Promise((_r, reject) => ctx.signal.addEventListener('abort', () => reject(new common.ToolError('aborted', 'The call was cancelled.'))))
        return {}
      }
    })
    const req = request('recognize_text')
    const done = runner.handleRequest(req, d)
    await started.promise
    runner.cancelRequest(req.id)
    await done
    expect(replies).toEqual([{ id: req.id, result: { error: { code: 'aborted', message: 'The call was cancelled.' } }, audit: { outcome: 'cancelled' } }])
    expect(ui.useAgentUi.getState().calls[0].outcome).toBe('cancelled')
  })

  it('answers a cancelled call whose handler never stops, and only once', async () => {
    const started = gate()
    const never = gate<{ data: string }>()
    const { d, replies } = deps({
      recognize_text: async () => {
        started.open()
        return never.promise
      }
    })
    const req = request('recognize_text')
    const done = runner.handleRequest(req, d)
    await started.promise
    runner.cancelRequest(req.id, 5)
    await vi.waitFor(() => expect(replies).toHaveLength(1))
    expect(replies[0].result.error?.code).toBe('aborted')
    expect(runner.runningCalls()).not.toContain(req.id)
    // the handler finishing later changes nothing
    never.open({ data: 'late' })
    await done
    expect(replies).toHaveLength(1)
    expect(ui.useAgentUi.getState().running).toBe(0)
  })

  it('does not throw when the result cannot be sent', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { d } = deps({ undo: async () => ({}) })
    const failing = { ...d, reply: async () => Promise.reject(new Error('main went away')) }
    await expect(runner.handleRequest(request('undo'), failing)).resolves.toBeUndefined()
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })
})
