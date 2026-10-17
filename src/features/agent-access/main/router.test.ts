import { describe, expect, it, vi } from 'vitest'
import type { AgentAuditEntry, AgentCallRequest } from '@shared/agent/bridge'
import type { AgentToolResult } from '@shared/agent/protocol'
import { AgentRouter, type RouterCall, type WindowHost } from './router'

/** Windows by id; ready ones listen for requests straight away. */
class FakeHost implements WindowHost {
  list: string[] = []
  focused: string | null = null
  listening = new Set<string>()
  waiters = new Map<string, ((ok: boolean) => void)[]>()
  requests: { windowId: string; request: AgentCallRequest }[] = []
  cancels: { windowId: string; id: string }[] = []
  created: string[] = []

  constructor(...ids: string[]) {
    for (const id of ids) this.open(id)
  }

  open(id: string, ready = true) {
    this.list.push(id)
    this.focused = id
    if (ready) this.listening.add(id)
  }
  windows() {
    return [...this.list]
  }
  current() {
    return this.focused && this.list.includes(this.focused) ? this.focused : null
  }
  create() {
    const id = `w${90 + this.created.length}`
    this.created.push(id)
    this.open(id, false)
    return id
  }
  ready(id: string) {
    if (!this.list.includes(id)) return Promise.resolve(false)
    if (this.listening.has(id)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]))
  }
  setReady(id: string) {
    this.listening.add(id)
    this.waiters.get(id)?.forEach((r) => r(true))
    this.waiters.delete(id)
  }
  close(id: string) {
    this.list = this.list.filter((w) => w !== id)
    if (this.focused === id) this.focused = null
    this.waiters.get(id)?.forEach((r) => r(false))
    this.waiters.delete(id)
  }
  request(windowId: string, request: AgentCallRequest) {
    this.requests.push({ windowId, request })
  }
  cancel(windowId: string, id: string) {
    this.cancels.push({ windowId, id })
  }
}

class FakeSink {
  results: { connectionId: number; id: string; result: AgentToolResult }[] = []
  progress: { connectionId: number; id: string; progress: number; total?: number; message?: string }[] = []
  audits: AgentAuditEntry[] = []
  changes = 0
  result(connectionId: number, id: string, result: AgentToolResult) {
    this.results.push({ connectionId, id, result })
  }
  progressOf = (
    connectionId: number,
    id: string,
    p: { progress: number; total?: number; message?: string }
  ) => this.progress.push({ connectionId, id, ...p })
  audit(entry: AgentAuditEntry) {
    this.audits.push(entry)
  }
  changed() {
    this.changes++
  }
}

function setup(host: FakeHost, opts: { readyTimeoutMs?: number; cancelWaitMs?: number } = {}) {
  const sink = new FakeSink()
  const router = new AgentRouter(
    host,
    {
      result: (c, i, r) => sink.result(c, i, r),
      progress: sink.progressOf,
      audit: (e) => sink.audit(e),
      changed: () => sink.changed()
    },
    opts
  )
  return { router, sink }
}

let nextId = 0
function call(tool: string, args: Record<string, unknown> = {}, connectionId = 1): RouterCall {
  return { connectionId, client: { name: 'claude-ai', version: '1.0' }, id: `c${++nextId}`, tool, args }
}

const waitFor = (fn: () => void) => vi.waitFor(fn, { timeout: 5000, interval: 5 })
describe('agent router', () => {
  it('sends a call with a handle to the window named in it', async () => {
    const host = new FakeHost('w1', 'w2')
    const { router, sink } = setup(host)
    const c = call('get_page_text', { handle: 'w1-b1-doc-3', pages: '2' })
    router.call(c)
    await waitFor(() => expect(host.requests).toHaveLength(1))
    const { windowId, request } = host.requests[0]
    expect(windowId).toBe('w1')
    expect(request).toEqual({
      id: `1:${c.id}`,
      connectionId: 1,
      client: c.client,
      windowId: 'w1',
      currentWindow: expect.any(Boolean),
      allowCompanionJoin: true,
      tool: 'get_page_text',
      args: c.args
    })
    expect(router.running(1)).toBe(1)

    router.reply('w1', {
      id: request.id,
      result: { data: { text: 'Hello' } },
      audit: { document: '/docs/a.pdf', outcome: 'done' }
    })
    expect(sink.results).toEqual([{ connectionId: 1, id: c.id, result: { data: { text: 'Hello' } } }])
    expect(sink.audits[0]).toMatchObject({
      connection: 1,
      client: 'claude-ai',
      tool: 'get_page_text',
      document: '/docs/a.pdf',
      outcome: 'done'
    })
    expect(router.running(1)).toBe(0)
  })

  it('answers stale_handle for an unknown window or a malformed handle without reaching a window', () => {
    const host = new FakeHost('w1')
    const { router, sink } = setup(host)
    router.call(call('get_context', { handle: 'w7-b1-doc-1' }))
    router.call(call('get_context', { handle: 'doc-1' }))
    router.call(call('get_context', { handle: 12 }))
    // The old form, without the window's load token.
    router.call(call('get_context', { handle: 'w1-doc-1' }))
    expect(host.requests).toHaveLength(0)
    expect(sink.results.map((r) => r.result.error?.code)).toEqual([
      'stale_handle',
      'stale_handle',
      'invalid_args',
      'stale_handle'
    ])
    expect(sink.audits.map((a) => a.error)).toEqual([
      'stale_handle',
      'stale_handle',
      'invalid_args',
      'stale_handle'
    ])
  })

  it('answers unknown_tool without reaching a window', () => {
    const host = new FakeHost('w1')
    const { router, sink } = setup(host)
    router.call(call('format_hard_drive'))
    expect(host.requests).toHaveLength(0)
    expect(sink.results[0].result.error?.code).toBe('unknown_tool')
    expect(sink.audits[0]).toMatchObject({
      tool: 'format_hard_drive',
      outcome: 'error',
      error: 'unknown_tool'
    })
  })

  it('joins only the originally focused window during a delayed list_documents fan-out', async () => {
    const host = new FakeHost('w1', 'w2')
    host.listening.delete('w1')
    const { router, sink } = setup(host)
    router.call(call('list_documents'))
    await waitFor(() => expect(host.requests).toHaveLength(1))
    host.focused = 'w1'
    host.setReady('w1')
    await waitFor(() => expect(host.requests).toHaveLength(2))
    expect(host.requests.map(r => r.request.allowCompanionJoin)).toEqual([true, false])
    const companion = { session: 'w2-chat-private', status: 'joined' as const, instructions: 'Listen' }
    for (const { windowId, request } of host.requests) router.reply(windowId, {
      id: request.id, result: { data: { documents: [] }, ...(windowId === 'w2' ? { companion } : {}) }
    })
    expect(sink.results[0].result.companion).toEqual(companion)
    expect(JSON.stringify(sink.audits)).not.toContain('w2-chat-private')
  })

  it('asks every window for list_documents and merges in window creation order', async () => {
    const host = new FakeHost('w1', 'w2', 'w3')
    host.focused = 'w2'
    const { router, sink } = setup(host)
    const c = call('list_documents')
    router.call(c)
    await waitFor(() => expect(host.requests).toHaveLength(3))
    expect(host.requests.map((r) => r.windowId)).toEqual(['w1', 'w2', 'w3'])
    expect(host.requests.map((r) => r.request.windowId)).toEqual(['w1', 'w2', 'w3'])
    // Only the window the person uses reports its active tab as active.
    expect(host.requests.map((r) => r.request.currentWindow)).toEqual([false, true, false])
    const id = host.requests[0].request.id
    // Answers arrive in any order; one window fails and is left out.
    router.reply('w3', {
      id,
      result: { data: { documents: [{ handle: 'w3-b1-doc-1' }, { handle: 'w3-b1-doc-2' }] } }
    })
    router.reply('w2', { id, result: { error: { code: 'failed', message: 'boom' } } })
    expect(sink.results).toHaveLength(0)
    router.reply('w1', { id, result: { data: { documents: [{ handle: 'w1-b1-doc-1' }] } } })
    expect(sink.results).toHaveLength(1)
    expect(sink.results[0].result).toEqual({
      data: { documents: [{ handle: 'w1-b1-doc-1' }, { handle: 'w3-b1-doc-1' }, { handle: 'w3-b1-doc-2' }] }
    })
  })

  it('lists no documents without opening a window when there is none', () => {
    const host = new FakeHost()
    const { router, sink } = setup(host)
    router.call(call('list_documents'))
    expect(host.created).toHaveLength(0)
    expect(sink.results[0].result).toEqual({ data: { documents: [] } })
  })

  it('leaves a window that closes during list_documents out', async () => {
    const host = new FakeHost('w1', 'w2')
    const { router, sink } = setup(host)
    router.call(call('list_documents'))
    await waitFor(() => expect(host.requests).toHaveLength(2))
    const id = host.requests[0].request.id
    router.reply('w1', { id, result: { data: { documents: [{ handle: 'w1-b1-doc-1' }] } } })
    host.close('w2')
    router.windowGone('w2')
    expect(sink.results[0].result).toEqual({ data: { documents: [{ handle: 'w1-b1-doc-1' }] } })
  })

  it('sends other calls to the focused window', async () => {
    const host = new FakeHost('w1', 'w2')
    host.focused = 'w1'
    const { router } = setup(host)
    router.call(call('get_context'))
    await waitFor(() => expect(host.requests).toHaveLength(1))
    expect(host.requests[0].windowId).toBe('w1')
  })

  it('opens a window when there is none and waits until it listens', async () => {
    const host = new FakeHost()
    const { router, sink } = setup(host)
    router.call(call('open_document', { path: '/docs/a.pdf' }))
    router.call(call('get_context'))
    expect(host.created).toEqual(['w90'])
    await new Promise((r) => setImmediate(r))
    expect(host.requests).toHaveLength(0)
    host.setReady('w90')
    await waitFor(() => expect(host.requests).toHaveLength(2))
    expect(host.requests.every((r) => r.windowId === 'w90')).toBe(true)
    expect(sink.results).toHaveLength(0)
  })

  it('reuses the window it opened while that window cannot be focused yet', async () => {
    const host = new FakeHost()
    host.current = () => null
    const { router } = setup(host)
    router.call(call('get_context'))
    router.call(call('get_context'))
    expect(host.created).toEqual(['w90'])
  })

  it('gives up on a window that never starts listening', async () => {
    const host = new FakeHost()
    host.open('w1', false)
    const { router, sink } = setup(host, { readyTimeoutMs: 30 })
    router.call(call('get_context'))
    await waitFor(() => expect(sink.results).toHaveLength(1))
    expect(sink.results[0].result.error?.code).toBe('failed')
    expect(host.requests).toHaveLength(0)
  })

  it('forwards a cancel to the window and waits for its answer', async () => {
    const host = new FakeHost('w1')
    const { router, sink } = setup(host)
    const c = call('recognize_text', { handle: 'w1-b1-doc-1' })
    router.call(c)
    await waitFor(() => expect(host.requests).toHaveLength(1))
    router.cancel(1, c.id)
    expect(host.cancels).toEqual([{ windowId: 'w1', id: `1:${c.id}` }])
    expect(sink.results).toHaveLength(0)
    router.reply('w1', {
      id: `1:${c.id}`,
      result: { error: { code: 'aborted', message: 'The call was cancelled.' } }
    })
    expect(sink.results[0].result.error?.code).toBe('aborted')
    expect(sink.audits[0]).toMatchObject({ outcome: 'cancelled', error: 'aborted' })
  })

  it('ends a cancelled call whose window never answers', async () => {
    vi.useFakeTimers()
    try {
      const host = new FakeHost('w1')
      const { router, sink } = setup(host, { cancelWaitMs: 1000 })
      const c = call('recognize_text', { handle: 'w1-b1-doc-1' })
      router.call(c)
      await vi.waitFor(() => expect(host.requests).toHaveLength(1))
      router.cancel(1, c.id)
      router.connectionClosed(1)
      await vi.advanceTimersByTimeAsync(999)
      expect(sink.results).toHaveLength(0)
      expect(router.running(1)).toBe(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(sink.results.map((r) => r.result.error?.code)).toEqual(['aborted'])
      expect(sink.audits.map((a) => a.outcome)).toEqual(['cancelled'])
      expect(router.running(1)).toBe(0)
      // A late answer changes nothing.
      router.reply('w1', { id: `1:${c.id}`, result: { data: 'late' } })
      expect(sink.results).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a call that has not reached a window yet at once', async () => {
    const host = new FakeHost()
    host.open('w1', false)
    const { router, sink } = setup(host)
    const c = call('get_context')
    router.call(c)
    router.cancel(1, c.id)
    expect(sink.results[0].result.error?.code).toBe('aborted')
    // Recorded as cancelled, as when the window ends a cancelled call.
    expect(sink.audits[0]).toMatchObject({ outcome: 'cancelled', error: 'aborted' })
    host.setReady('w1')
    await new Promise((r) => setImmediate(r))
    expect(host.requests).toHaveLength(0)
    expect(host.cancels).toHaveLength(0)
  })

  it('cancels the calls of a connection that went away', async () => {
    const host = new FakeHost('w1', 'w2')
    const { router } = setup(host)
    const a = call('recognize_text', { handle: 'w1-b1-doc-1' }, 4)
    const b = call('get_context', { handle: 'w2-b1-doc-1' }, 4)
    const other = call('get_context', { handle: 'w2-b1-doc-1' }, 5)
    router.call(a)
    router.call(b)
    router.call(other)
    await waitFor(() => expect(host.requests).toHaveLength(3))
    router.connectionClosed(4)
    expect(host.cancels).toEqual([
      { windowId: 'w1', id: `4:${a.id}` },
      { windowId: 'w2', id: `4:${b.id}` }
    ])
  })

  it('answers stale_handle for calls running in a window that closes', async () => {
    const host = new FakeHost('w1', 'w2')
    const { router, sink } = setup(host)
    const a = call('apply_redactions', { handle: 'w1-b1-doc-1' })
    const b = call('get_context', { handle: 'w2-b1-doc-1' })
    router.call(a)
    router.call(b)
    await waitFor(() => expect(host.requests).toHaveLength(2))
    host.close('w1')
    router.windowGone('w1')
    expect(sink.results).toEqual([
      {
        connectionId: 1,
        id: a.id,
        result: expect.objectContaining({ error: expect.objectContaining({ code: 'stale_handle' }) })
      }
    ])
    expect(router.running(1)).toBe(1)
  })

  it('answers stale_handle when the window closes before the call reaches it', async () => {
    const host = new FakeHost()
    host.open('w1', false)
    const { router, sink } = setup(host)
    router.call(call('get_context'))
    host.close('w1')
    await waitFor(() => expect(sink.results).toHaveLength(1))
    expect(sink.results[0].result.error?.code).toBe('stale_handle')
  })

  it('ignores answers and progress from a window the call was not sent to', async () => {
    const host = new FakeHost('w1', 'w2')
    const { router, sink } = setup(host)
    const c = call('recognize_text', { handle: 'w1-b1-doc-1' })
    router.call(c)
    await waitFor(() => expect(host.requests).toHaveLength(1))
    const id = host.requests[0].request.id
    router.progress('w2', { id, progress: 1, total: 3 })
    router.reply('w2', { id, result: { data: 'forged' } })
    expect(sink.progress).toHaveLength(0)
    expect(sink.results).toHaveLength(0)
    router.progress('w1', { id, progress: 2, total: 3, message: 'Page 2' })
    expect(sink.progress).toEqual([{ connectionId: 1, id: c.id, progress: 2, total: 3, message: 'Page 2' }])
    router.reply('w1', { id, result: { data: 'ok' } })
    router.reply('w1', { id, result: { data: 'twice' } })
    expect(sink.results.map((r) => r.result)).toEqual([{ data: 'ok' }])
  })

  describe('calls that answer still_running', () => {
    const TICKET = 'w2-t1-b1'
    const stillRunning = (ticket = TICKET) => ({
      data: { status: 'still_running', ticket, message: 'Still running.' }
    })

    /** A call answered still_running by w2; returns the call. */
    async function ticketed(host: FakeHost, router: AgentRouter, connectionId = 1) {
      const c = call('apply_redactions', { handle: 'w2-b1-doc-1' }, connectionId)
      router.call(c)
      await waitFor(() =>
        expect(host.requests.some((r) => r.request.id === `${connectionId}:${c.id}`)).toBe(true)
      )
      router.reply('w2', {
        id: `${connectionId}:${c.id}`,
        result: stillRunning(),
        audit: { outcome: 'pending', summary: `still running, ticket ${TICKET}` }
      })
      return c
    }

    it('sends wait_for_result to the window named in the ticket, whichever window is focused', async () => {
      const host = new FakeHost('w1', 'w2')
      host.focused = 'w1'
      const { router, sink } = setup(host)
      const c = await ticketed(host, router)
      expect(sink.results).toEqual([{ connectionId: 1, id: c.id, result: stillRunning() }])
      expect(sink.audits[0]).toMatchObject({ tool: 'apply_redactions', outcome: 'pending' })
      expect(router.running(1)).toBe(0)
      const w = call('wait_for_result', { ticket: TICKET })
      router.call(w)
      await waitFor(() => expect(host.requests).toHaveLength(2))
      expect(host.requests[1]).toMatchObject({
        windowId: 'w2',
        request: { tool: 'wait_for_result', args: { ticket: TICKET } }
      })
      router.reply('w2', {
        id: `1:${w.id}`,
        result: { data: { applied: 2 } },
        audit: { outcome: 'done', summary: 'apply_redactions: applied 2 redactions on pages 1, 2' }
      })
      expect(sink.results[1]).toEqual({ connectionId: 1, id: w.id, result: { data: { applied: 2 } } })
      expect(sink.audits[1]).toMatchObject({
        tool: 'wait_for_result',
        args: { ticket: TICKET },
        outcome: 'done',
        summary: 'apply_redactions: applied 2 redactions on pages 1, 2'
      })
      // Collected: closing the connection now stops nothing.
      router.connectionClosed(1)
      await new Promise((r) => setImmediate(r))
      expect(host.requests).toHaveLength(2)
    })

    it('refuses tickets it cannot route without reaching a window', () => {
      const host = new FakeHost('w1')
      const { router, sink } = setup(host)
      router.call(call('wait_for_result', {}))
      router.call(call('wait_for_result', { ticket: 7 }))
      router.call(call('wait_for_result', { ticket: 'w1-doc-1' }))
      router.call(call('wait_for_result', { ticket: 'w9-t1-b1' }))
      expect(host.requests).toHaveLength(0)
      expect(sink.results.map((r) => r.result.error?.code)).toEqual([
        'invalid_args',
        'invalid_args',
        'invalid_args',
        'invalid_args'
      ])
    })

    it('stops the calls a connection had tickets for when it closes', async () => {
      const host = new FakeHost('w1', 'w2')
      const { router, sink } = setup(host)
      await ticketed(host, router, 3)
      router.connectionClosed(3)
      await waitFor(() => expect(host.requests).toHaveLength(2))
      const stop = host.requests[1]
      expect(stop).toMatchObject({
        windowId: 'w2',
        request: { connectionId: 3, tool: 'wait_for_result', args: { ticket: TICKET, cancel: true } }
      })
      router.reply('w2', {
        id: stop.request.id,
        result: { error: { code: 'aborted', message: 'The call was cancelled.' } },
        audit: { outcome: 'cancelled', summary: 'apply_redactions' }
      })
      expect(sink.audits.at(-1)).toMatchObject({
        connection: 3,
        tool: 'wait_for_result',
        outcome: 'cancelled',
        summary: 'apply_redactions'
      })
      expect(router.running(3)).toBe(0)
    })

    it('stops a call the agent cancelled while its still_running answer was on the way', async () => {
      // The cancel reaches main before the answer.
      const host = new FakeHost('w1', 'w2')
      const { router } = setup(host)
      const a = call('apply_redactions', { handle: 'w2-b1-doc-1' })
      router.call(a)
      await waitFor(() => expect(host.requests).toHaveLength(1))
      router.cancel(1, a.id)
      router.reply('w2', { id: `1:${a.id}`, result: stillRunning('w2-t1-b1') })
      await waitFor(() => expect(host.requests).toHaveLength(2))
      expect(host.requests[1].request).toMatchObject({
        tool: 'wait_for_result',
        args: { ticket: 'w2-t1-b1', cancel: true }
      })

      // The answer reaches main before the cancel.
      const b = call('sign_document', { handle: 'w2-b1-doc-1' })
      router.call(b)
      await waitFor(() => expect(host.requests).toHaveLength(3))
      router.reply('w2', { id: `1:${b.id}`, result: stillRunning('w2-t2-b1') })
      router.cancel(1, b.id)
      await waitFor(() => expect(host.requests).toHaveLength(4))
      expect(host.requests[3].request).toMatchObject({
        tool: 'wait_for_result',
        args: { ticket: 'w2-t2-b1', cancel: true }
      })
    })

    it('keeps the ticket when only a wait for it was cancelled', async () => {
      const host = new FakeHost('w1', 'w2')
      const { router } = setup(host)
      await ticketed(host, router)
      const w = call('wait_for_result', { ticket: TICKET })
      router.call(w)
      await waitFor(() => expect(host.requests).toHaveLength(2))
      router.cancel(1, w.id)
      router.reply('w2', {
        id: `1:${w.id}`,
        result: { error: { code: 'aborted', message: 'The call was cancelled.' } }
      })
      // Not stopped by that cancel, but still stopped when the connection closes.
      expect(host.requests).toHaveLength(2)
      router.connectionClosed(1)
      await waitFor(() => expect(host.requests).toHaveLength(3))
      expect(host.requests[2].request).toMatchObject({
        tool: 'wait_for_result',
        args: { ticket: TICKET, cancel: true }
      })
    })

    it('forgets the tickets of a window that closes', async () => {
      const host = new FakeHost('w1', 'w2')
      const { router, sink } = setup(host)
      await ticketed(host, router)
      host.close('w2')
      router.windowGone('w2')
      router.connectionClosed(1)
      router.call(call('wait_for_result', { ticket: TICKET }))
      await new Promise((r) => setImmediate(r))
      expect(host.requests).toHaveLength(1)
      expect(sink.results.at(-1)?.result.error?.code).toBe('invalid_args')
    })

    it('takes still_running answers only from the window that runs the call', async () => {
      const host = new FakeHost('w1', 'w2')
      const { router } = setup(host)
      const c = call('apply_redactions', { handle: 'w2-b1-doc-1' })
      router.call(c)
      await waitFor(() => expect(host.requests).toHaveLength(1))
      // w2 cannot hand out w1's ticket.
      router.reply('w2', { id: `1:${c.id}`, result: stillRunning('w1-t1-b1') })
      router.connectionClosed(1)
      await new Promise((r) => setImmediate(r))
      expect(host.requests).toHaveLength(1)
    })
  })
})

it('routes companion sessions to their original window after focus changes', async () => {
  const host = new FakeHost('w1', 'w2')
  const { router, sink } = setup(host)
  router.call(call('companion_chat', { session: 'w1-chat-abc-1234-abcd' }))
  await vi.waitFor(() => expect(host.requests).toHaveLength(1))
  expect(host.requests[0].windowId).toBe('w1')
  router.call(call('companion_chat', { session: 'w9-chat-abc-1234-abcd' }))
  expect(sink.results.at(-1)?.result.error?.code).toBe('invalid_args')
  router.call(call('companion_chat', { session: 42 }))
  expect(sink.results.at(-1)?.result.error?.code).toBe('invalid_args')
  router.connectionClosed(1)
})
