// Agent access: calls that run longer than an AI app waits (runner.ts) answer still_running with a
// ticket and keep going; wait_for_result (tools/wait.ts) collects their result or stops them.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentCallReply, AgentCallRequest, AgentProgress } from '@shared/agent/bridge'
import { agentTool } from '@shared/agent/tools'

let runner: typeof import('@features/agent-access/runner')
let common: typeof import('@features/agent-access/tools/common')
let runtime: typeof import('@features/agent-access/tools/act-runtime')
let wait: typeof import('@features/agent-access/tools/wait')
let ui: typeof import('@features/agent-access/ui/store')
let companion: typeof import('@features/agent-access/ui/companionStore')
let useApp: typeof import('@renderer/app/store').useApp

beforeAll(async () => {
  vi.stubGlobal('window', {})
  await import('@renderer/app/registry')
  runner = await import('@features/agent-access/runner')
  common = await import('@features/agent-access/tools/common')
  runtime = await import('@features/agent-access/tools/act-runtime')
  wait = await import('@features/agent-access/tools/wait')
  ui = await import('@features/agent-access/ui/store')
  companion = await import('@features/agent-access/ui/companionStore')
  ;({ useApp } = await import('@renderer/app/store'))
  // The main process, after the modules read the (missing) preload bridge at load time.
  ;(window as any).api = { invoke: async () => {}, on: () => () => {} }
})

/** How long a call runs before it answers still_running, and how long one wait_for_result waits. */
const WAIT_MS = 40

beforeEach(() => {
  ui.useAgentUi.setState({ calls: [], running: 0 })
  // As the app starts: nobody has opened the companion chat.
  companion.useCompanion.setState({ owner: null, messages: [], listening: false, autoJoin: false, ended: false })
  for (const d of useApp.getState().dialogs) d.resolve(undefined)
  useApp.setState({ docs: [], activeDocId: null, dialogs: [] })
  wait.setStillRunningMs(WAIT_MS)
})

let nextId = 1
function request(tool: string, args: Record<string, unknown> = {}, connectionId = 1): AgentCallRequest {
  const client = { name: 'claude-ai', version: '1.0' }
  return { id: `${connectionId}:${nextId++}`, connectionId, client, windowId: 'w1', currentWindow: true, tool, args }
}

type Handler = (args: Record<string, unknown>, ctx: import('@features/agent-access/tools/common').ToolContext) => Promise<any>

function deps(handlers: Record<string, Handler>) {
  const replies: AgentCallReply[] = []
  const progress: AgentProgress[] = []
  const d = {
    handlers: { ...wait.handlers, ...handlers },
    tool: agentTool,
    commitEditors: async () => {},
    reply: async (r: AgentCallReply) => void replies.push(r),
    progress: (p: AgentProgress) => void progress.push(p),
    stillRunningMs: () => WAIT_MS,
    graceMs: 50
  }
  /** The reply to a request, once it came. */
  const replyTo = (req: AgentCallRequest) => vi.waitFor(() => {
    const r = replies.find((x) => x.id === req.id)
    expect(r).toBeTruthy()
    return r!
  })
  return { d, replies, progress, replyTo }
}

/** A promise with its resolve function (to hold a handler until the test lets it go). */
function gate<T = void>() {
  let open!: (v: T) => void
  const promise = new Promise<T>((r) => (open = r))
  return { promise, open }
}

/** Runs wait_for_result and returns its reply. */
async function waitFor(d: ReturnType<typeof deps>, ticket: string, more: Record<string, unknown> = {}, connectionId = 1) {
  const req = request('wait_for_result', { ticket, ...more }, connectionId)
  await runner.handleRequest(req, d.d)
  return d.replies.find((r) => r.id === req.id)!
}

describe('the companion chat and calls that cannot carry its token', () => {
  // The person opened the chat: the next conversation that uses Fartcrobat may join.
  const armed = () =>
    companion.useCompanion.setState({ owner: null, messages: [], listening: false, autoJoin: true, ended: false })

  it('a call that answered still_running does not take the chat: its token would go nowhere', async () => {
    armed()
    const hold = gate()
    const d = deps({ get_page_text: async () => (await hold.promise, { data: { text: 'page' } }) })
    const req = request('get_page_text', { handle: 'w1-x-doc-1' })
    const running = runner.handleRequest(req, d.d)
    const ticket = ((await d.replyTo(req)).result.data as { ticket: string }).ticket
    const req2 = request('wait_for_result', { ticket })
    const waiting = runner.handleRequest(req2, d.d)
    hold.open()
    await running
    await waiting
    expect(d.replies.find((r) => r.id === req2.id)!.result).toEqual({ data: { text: 'page' } })
    expect(companion.useCompanion.getState().owner).toBeNull()
    // The conversation's next direct reply carries the token.
    const next = request('get_context')
    await runner.handleRequest(next, deps({ get_context: async () => ({ data: {} }) }).d)
    expect(companion.useCompanion.getState().owner).toMatchObject({ id: 1 })
  })

  it('a call the AI app cancelled does not take the chat, even if it finishes anyway', async () => {
    armed()
    const hold = gate()
    // A handler that ignores the abort and returns within the grace period.
    const d = deps({ get_page_text: async () => (await hold.promise, { data: { text: 'late' } }) })
    const req = request('get_page_text', { handle: 'w1-x-doc-1' })
    const running = runner.handleRequest(req, { ...d.d, stillRunningMs: () => 60_000 })
    await vi.waitFor(() => expect(runner.runningCalls()).toContain(req.id))
    runner.cancelRequest(req.id, 1000)
    hold.open()
    await running
    expect(companion.useCompanion.getState().owner).toBeNull()
    expect(d.replies.find((r) => r.id === req.id)?.result.companion).toBeUndefined()
  })
})

describe('calls that run long', () => {
  it('answer still_running with a ticket and hand their result to wait_for_result, once', async () => {
    const hold = gate()
    const d = deps({
      apply_redactions: async (_args, ctx) => {
        ctx.audit({ document: '/docs/a.pdf' })
        await hold.promise
        ctx.audit({ summary: 'applied 2 redactions on pages 1, 2' })
        return { data: { applied: 2 } }
      }
    })
    const req = request('apply_redactions', { handle: 'w1-x-doc-1' })
    const running = runner.handleRequest(req, d.d)
    const first = await d.replyTo(req)
    const ticket = (first.result.data as { ticket: string }).ticket
    expect(ticket).toMatch(new RegExp(`^w1-t\\d+-${common.BOOT}$`))
    expect(first.result).toEqual({ data: { status: 'still_running', ticket, message: expect.stringContaining('wait_for_result') } })
    expect(first.audit).toEqual({ document: '/docs/a.pdf', outcome: 'pending', summary: `still running, ticket ${ticket}` })
    // The activity panel still shows it running, and the window still counts it.
    expect(ui.useAgentUi.getState().calls[0]).toMatchObject({ id: req.id, outcome: 'running' })
    expect(ui.useAgentUi.getState().running).toBe(1)
    expect(wait.openTickets()).toContain(ticket)

    // Not finished yet: the wait answers still_running again, after waiting.
    const started = Date.now()
    const again = await waitFor(d, ticket)
    expect(Date.now() - started).toBeGreaterThanOrEqual(WAIT_MS - 5)
    expect(again.result.data).toMatchObject({ status: 'still_running', ticket })
    expect(again.audit).toEqual({ document: '/docs/a.pdf', outcome: 'pending', summary: 'apply_redactions: still running' })

    // It finishes while a wait is running: that wait returns the result.
    const req2 = request('wait_for_result', { ticket })
    const waiting = runner.handleRequest(req2, d.d)
    hold.open()
    await running
    await waiting
    const done = d.replies.find((r) => r.id === req2.id)!
    expect(done.result).toEqual({ data: { applied: 2 } })
    expect(done.audit).toEqual({ document: '/docs/a.pdf', outcome: 'done', summary: 'apply_redactions: applied 2 redactions on pages 1, 2' })
    // The call itself replied once (still_running); its row is done; wait_for_result has no rows.
    expect(d.replies.filter((r) => r.id === req.id)).toHaveLength(1)
    expect(ui.useAgentUi.getState().calls.map((c) => [c.id, c.outcome])).toEqual([[req.id, 'done']])
    expect(ui.useAgentUi.getState().running).toBe(0)

    // Collected: the ticket is gone.
    const gone = await waitFor(d, ticket)
    expect(gone.result.error).toMatchObject({ code: 'invalid_args', message: expect.stringContaining('already returned') })
    expect(wait.openTickets()).not.toContain(ticket)
  })

  it('keeps a result that comes before anyone waits, and returns errors as the call would have', async () => {
    const hold = gate()
    const d = deps({
      save_document: async (_args, ctx) => {
        await hold.promise
        ctx.audit({ document: '/docs/a.pdf', outcome: 'declined', summary: 'save over /docs/a.pdf' })
        throw new common.ToolError('declined', 'The person declined in Fartcrobat: save over /docs/a.pdf. Do not retry unless they ask.')
      }
    })
    const req = request('save_document')
    const running = runner.handleRequest(req, d.d)
    const ticket = ((await d.replyTo(req)).result.data as { ticket: string }).ticket
    hold.open()
    await running
    expect(ui.useAgentUi.getState().calls[0].outcome).toBe('declined')
    const done = await waitFor(d, ticket)
    expect(done.result.error).toEqual({ code: 'declined', message: expect.stringContaining('Do not retry') })
    expect(done.audit).toEqual({ document: '/docs/a.pdf', outcome: 'declined', summary: 'save_document: save over /docs/a.pdf' })
  })

  it('stop at a cancel through the ticket: an open confirmation closes without going ahead', async () => {
    let applied = false
    const d = deps({
      apply_redactions: async (_args, ctx) => {
        await runtime.requireConfirmation(ctx, null, { title: 'Apply redactions?', message: 'Remove it?', confirmLabel: 'Apply redactions' }, 'apply 1 redaction mark')
        applied = true
        return { data: { applied: 1 } }
      }
    })
    const req = request('apply_redactions')
    const running = runner.handleRequest(req, d.d)
    const ticket = ((await d.replyTo(req)).result.data as { ticket: string }).ticket
    // The dialog is still waiting for the person after the call answered.
    expect(useApp.getState().dialogs).toHaveLength(1)
    const stopped = await waitFor(d, ticket, { cancel: true })
    await running
    expect(applied).toBe(false)
    expect(useApp.getState().dialogs).toHaveLength(0)
    expect(stopped.result.error?.code).toBe('aborted')
    expect(stopped.audit).toMatchObject({ outcome: 'cancelled', summary: 'apply_redactions' })
    expect(ui.useAgentUi.getState().calls[0].outcome).toBe('cancelled')
  })

  it('end as cancelled after the grace period when a stopped handler does not notice', async () => {
    const never = gate<{ data: string }>()
    const d = deps({ recognize_text: () => never.promise })
    const req = request('recognize_text')
    void runner.handleRequest(req, d.d)
    const ticket = ((await d.replyTo(req)).result.data as { ticket: string }).ticket
    const stopped = await waitFor(d, ticket, { cancel: true })
    expect(stopped.result.error?.code).toBe('aborted')
    never.open({ data: 'late' })
  })

  it('are not cancelled by a cancel of the request that already answered', async () => {
    const hold = gate()
    let aborted = false
    const d = deps({
      recognize_text: async (_args, ctx) => {
        ctx.signal.addEventListener('abort', () => (aborted = true))
        await hold.promise
        return { data: 'text' }
      }
    })
    const req = request('recognize_text')
    const running = runner.handleRequest(req, d.d)
    const ticket = ((await d.replyTo(req)).result.data as { ticket: string }).ticket
    runner.cancelRequest(req.id, 5)
    await new Promise((r) => setTimeout(r, 20))
    expect(aborted).toBe(false)
    expect(runner.runningCalls()).not.toContain(req.id)
    hold.open()
    await running
    expect((await waitFor(d, ticket)).result).toEqual({ data: 'text' })
  })

  it('send no progress once they answered', async () => {
    const hold = gate()
    const d = deps({
      recognize_text: async (_args, ctx) => {
        ctx.progress(1, 3)
        await hold.promise
        ctx.progress(2, 3)
        return { data: 'text' }
      }
    })
    const req = request('recognize_text')
    const running = runner.handleRequest(req, d.d)
    await d.replyTo(req)
    hold.open()
    await running
    expect(d.progress.map((p) => p.progress)).toEqual([1])
  })

  it('answer at once when they are quick, and list_documents never answers still_running', async () => {
    const hold = gate()
    const d = deps({
      get_context: async () => ({ data: 'quick' }),
      list_documents: async () => {
        await hold.promise
        return { data: { documents: [] } }
      }
    })
    const quick = request('get_context')
    await runner.handleRequest(quick, d.d)
    expect(d.replies.find((r) => r.id === quick.id)?.result).toEqual({ data: 'quick' })
    const list = request('list_documents')
    const listing = runner.handleRequest(list, d.d)
    await new Promise((r) => setTimeout(r, WAIT_MS * 2))
    expect(d.replies.find((r) => r.id === list.id)).toBeUndefined()
    hold.open()
    await listing
    expect(d.replies.find((r) => r.id === list.id)?.result).toEqual({ data: { documents: [] } })
  })
})

describe('wait_for_result', () => {
  it('refuses tickets it does not know, and tickets of another AI app', async () => {
    const hold = gate()
    const d = deps({
      recognize_text: async () => {
        await hold.promise
        return { data: 'text' }
      }
    })
    const req = request('recognize_text', {}, 1)
    const running = runner.handleRequest(req, d.d)
    const ticket = ((await d.replyTo(req)).result.data as { ticket: string }).ticket
    for (const args of [{ ticket: 'w1-t999-zz' }, { ticket: '' }, { ticket: 5 }, { ticket, cancel: 'yes' }]) {
      const r = request('wait_for_result', args as Record<string, unknown>)
      await runner.handleRequest(r, d.d)
      expect(d.replies.find((x) => x.id === r.id)?.result.error?.code).toBe('invalid_args')
    }
    const other = await waitFor(d, ticket, {}, 2)
    expect(other.result.error?.code).toBe('invalid_args')
    hold.open()
    await running
    expect((await waitFor(d, ticket)).result).toEqual({ data: 'text' })
  })

  it('stops waiting, not the call, when the wait itself is cancelled', async () => {
    const hold = gate()
    const d = deps({
      recognize_text: async () => {
        await hold.promise
        return { data: 'text' }
      }
    })
    const req = request('recognize_text')
    const running = runner.handleRequest(req, d.d)
    const ticket = ((await d.replyTo(req)).result.data as { ticket: string }).ticket
    const w = request('wait_for_result', { ticket })
    const waiting = runner.handleRequest(w, d.d)
    await new Promise((r) => setTimeout(r, 5))
    runner.cancelRequest(w.id)
    await waiting
    expect(d.replies.find((r) => r.id === w.id)?.result.error?.code).toBe('aborted')
    hold.open()
    await running
    expect((await waitFor(d, ticket)).result).toEqual({ data: 'text' })
  })
})

describe('calls that hand themselves to a ticket (ctx.detach)', () => {
  it('answer still_running at once with what the handler adds; the result goes to the ticket', async () => {
    const hold = gate()
    const tickets: (string | null)[] = []
    const d = deps({
      edit_text: async (_args, ctx) => {
        ctx.audit({ document: '/docs/a.pdf' })
        tickets.push(ctx.detach!({ message: 'On the page now.', review: { edits: [{ edit: 1 }], pending: 1 } }))
        // A second detach keeps the ticket and sends nothing.
        tickets.push(ctx.detach!({ message: 'ignored' }))
        await hold.promise
        return { data: { applied: true } }
      }
    })
    const req = request('edit_text', { handle: 'w1-x-doc-1' })
    const running = runner.handleRequest(req, { ...d.d, stillRunningMs: () => 60_000 })
    const first = await d.replyTo(req)
    const ticket = (first.result.data as { ticket: string }).ticket
    expect(tickets).toEqual([ticket, ticket])
    expect(first.result).toEqual({
      data: { status: 'still_running', ticket, message: 'On the page now.', review: { edits: [{ edit: 1 }], pending: 1 } }
    })
    expect(first.audit).toMatchObject({ outcome: 'pending', document: '/docs/a.pdf' })
    // The request is the ticket's now: a cancel of it does not reach the handler.
    expect(runner.runningCalls()).not.toContain(req.id)
    expect(ui.useAgentUi.getState().calls[0]).toMatchObject({ id: req.id, outcome: 'running' })
    hold.open()
    await running
    expect(d.replies.filter((r) => r.id === req.id)).toHaveLength(1)
    expect((await waitFor(d, ticket)).result).toEqual({ data: { applied: true } })
  })

  it('after the timer answered still_running, detach returns that ticket without a second answer', async () => {
    const hold = gate()
    const seen = gate<string | null>()
    const d = deps({
      edit_text: async (_args, ctx) => {
        await hold.promise
        seen.open(ctx.detach!({ message: 'late' }))
        return { data: 'done' }
      }
    })
    const req = request('edit_text')
    const running = runner.handleRequest(req, d.d)
    const ticket = ((await d.replyTo(req)).result.data as { ticket: string }).ticket
    hold.open()
    expect(await seen.promise).toBe(ticket)
    await running
    expect(d.replies.filter((r) => r.id === req.id)).toHaveLength(1)
    expect((await waitFor(d, ticket)).result).toEqual({ data: 'done' })
  })

  it('a cancelled call cannot detach, and wait_for_result and list_documents have no detach', async () => {
    const seen: unknown[] = []
    const d = deps({
      edit_text: async (_args, ctx) => {
        await new Promise((r) => setTimeout(r, 20))
        seen.push(ctx.detach!())
        return { data: 'x' }
      },
      list_documents: async (_args, ctx) => (seen.push(ctx.detach), { data: { documents: [] } })
    })
    const req = request('edit_text')
    const running = runner.handleRequest(req, { ...d.d, stillRunningMs: () => 60_000 })
    await vi.waitFor(() => expect(runner.runningCalls()).toContain(req.id))
    runner.cancelRequest(req.id, 1000)
    await running
    await runner.handleRequest(request('list_documents'), d.d)
    expect(seen).toEqual([null, undefined])
  })
})

describe('waiting for a ticket', () => {
  it('tells listeners when wait_for_result starts and stops waiting, without changing its answer', async () => {
    const hold = gate()
    const d = deps({ recognize_text: async () => (await hold.promise, { data: 'text' }) })
    const req = request('recognize_text')
    const running = runner.handleRequest(req, d.d)
    const ticket = ((await d.replyTo(req)).result.data as { ticket: string }).ticket
    const events: boolean[] = []
    const off = wait.onTicketWait(ticket, (w) => events.push(w))
    expect(wait.ticketWaited(ticket)).toBe(false)
    // Times out: waiting, then not.
    expect((await waitFor(d, ticket)).result.data).toMatchObject({ status: 'still_running' })
    expect(events).toEqual([true, false])
    // A cancel is not waiting for the person.
    const other = gate()
    const d2 = deps({ recognize_text: async () => (await other.promise, { data: 'x' }) })
    const req2 = request('recognize_text')
    const running2 = runner.handleRequest(req2, d2.d)
    const ticket2 = ((await d2.replyTo(req2)).result.data as { ticket: string }).ticket
    const events2: boolean[] = []
    wait.onTicketWait(ticket2, (w) => events2.push(w))
    other.open()
    await running2
    await waitFor(d2, ticket2, { cancel: true })
    expect(events2).toEqual([])
    // Finished while waited for.
    const w = request('wait_for_result', { ticket })
    const waiting = runner.handleRequest(w, d.d)
    await vi.waitFor(() => expect(wait.ticketWaited(ticket)).toBe(true))
    hold.open()
    await running
    await waiting
    expect(d.replies.find((r) => r.id === w.id)!.result).toEqual({ data: 'text' })
    expect(events).toEqual([true, false, true, false])
    off()
  })
})
