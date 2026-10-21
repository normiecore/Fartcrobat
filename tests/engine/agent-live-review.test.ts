// Agent access: edit_text across calls (0.3.1, docs/features/agent-live-review.md). Each call answers
// still_running as soon as its edits are on the page, later calls of the same conversation join the
// open review, and wait_for_result returns each call's decisions once the review is applied. Runs
// the real runner and handlers against real documents (the in-process engine behind a
// DocumentModel), with a stand-in main process.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeSet } from '@shared/types'
import type { AgentCallReply, AgentCallRequest } from '@shared/agent/bridge'
import { agentTool } from '@shared/agent/tools'
import { openFixture, type OpenedEngine } from './helpers'

let DocumentModel: typeof import('@renderer/document/DocumentModel').DocumentModel
let useApp: typeof import('@renderer/app/store').useApp
let handlers: typeof import('@features/agent-access/tools').TOOL_HANDLERS
let runner: typeof import('@features/agent-access/runner')
let wait: typeof import('@features/agent-access/tools/wait')
let editReview: typeof import('@features/agent-access/tools/editReview')
let reviewState: typeof import('@features/agent-access/ui/reviewState')

beforeAll(async () => {
  vi.stubGlobal('window', { api: { platform: 'linux', invoke: async () => undefined, on: () => () => {} } })
  await import('@renderer/app/registry')
  ;({ DocumentModel } = await import('@renderer/document/DocumentModel'))
  ;({ useApp } = await import('@renderer/app/store'))
  ;({ TOOL_HANDLERS: handlers } = await import('@features/agent-access/tools'))
  runner = await import('@features/agent-access/runner')
  wait = await import('@features/agent-access/tools/wait')
  editReview = await import('@features/agent-access/tools/editReview')
  reviewState = await import('@features/agent-access/ui/reviewState')
})

beforeEach(() => {
  reviewState.useInlineReview.getState().review?.cancel()
  for (const d of useApp.getState().docs) d.close()
  useApp.setState({ docs: [], activeDocId: null, dialogs: [] })
  // wait_for_result waits this long before it answers still_running again.
  wait.setStillRunningMs(20_000)
})

function modelFor(e: OpenedEngine) {
  const client = {
    ops: (ns: string) =>
      new Proxy({}, { get: (_t, name) => async (...args: unknown[]) => e.call(`${ns}.${String(name)}`, ...args) }),
    onChanges: (_l: (cs: ChangeSet) => void) => () => {},
    runAs: async <T,>(actor: string, fn: () => Promise<T>) => {
      e.actor = actor
      try {
        return await fn()
      } finally {
        e.actor = null
      }
    },
    terminate() {}
  }
  const doc = new DocumentModel(client as any, e.info, { title: 'CV.pdf', filePath: null })
  useApp.setState((s) => ({ docs: [...s.docs, doc], activeDocId: doc.id }))
  return doc
}

const replies: AgentCallReply[] = []
let nextId = 1
const deps = () => ({
  ...runner.defaultDeps,
  handlers,
  tool: agentTool,
  commitEditors: async () => {},
  reply: async (r: AgentCallReply) => void replies.push(r),
  progress: () => {},
  // Calls answer still_running only by themselves (detach) in these tests.
  stillRunningMs: () => 600_000,
  graceMs: 1000
})

interface Sent {
  request: AgentCallRequest
  /** The handler finished (its result went to the reply or the ticket). */
  done: Promise<void>
}
/** Sends a call as the main process does; `answer()` is its first reply. */
function send(tool: string, args: Record<string, unknown>, connectionId = 1): Sent {
  const request: AgentCallRequest = {
    id: `${connectionId}:${nextId++}`,
    connectionId,
    client: { name: 'claude-ai', version: '1' },
    windowId: 'w1',
    currentWindow: true,
    tool,
    args
  }
  return { request, done: runner.handleRequest(request, deps()) }
}
async function answer(sent: Sent) {
  return vi.waitFor(() => {
    const r = replies.find((x) => x.id === sent.request.id)
    expect(r).toBeTruthy()
    return r!.result
  })
}
/** Sends a call and returns its first answer. */
async function call(tool: string, args: Record<string, unknown> = {}, connectionId = 1) {
  return answer(send(tool, args, connectionId))
}
/** Sends edit_text and returns its ticket (it answers still_running once its edits are shown). */
async function edit(args: Record<string, unknown>, connectionId = 1) {
  const result = await call('edit_text', args, connectionId)
  expect(result.error).toBeUndefined()
  const data = result.data as { status: string; ticket: string; message: string; review: any }
  expect(data.status).toBe('still_running')
  return data
}
/** wait_for_result for a ticket, sent without awaiting it. */
const collect = (ticket: string, more: Record<string, unknown> = {}, connectionId = 1) =>
  answer(send('wait_for_result', { ticket, ...more }, connectionId))

const review = () => reviewState.useInlineReview.getState().review!

async function setup() {
  const e = await openFixture('text.pdf')
  modelFor(e)
  const snap = (await call('get_editable_text', { page: 1 })).data as any
  /** One edit of the block that starts with `start`. */
  const change = (start: string, from: string, to: string) => {
    const b = snap.blocks.find((x: any) => x.text.startsWith(start))
    return { page: 1, block_id: b.block_id, original_text: b.text, text: b.text.replace(from, to) }
  }
  const text = () => e.call('edit-text.text', 0) as Promise<string>
  return { e, revision: snap.revision as number, change, text, block: (start: string) => snap.blocks.find((x: any) => x.text.startsWith(start)) }
}

describe('edit_text across calls', () => {
  it('answers at once once its edits are on the page; wait_for_result returns the decisions', async () => {
    const { e, revision, change, text } = await setup()
    const first = await edit({ revision, edits: [change('Hello', 'quick', 'swift')] })
    expect(first.message).toBe(editReview.DETACHED_MESSAGE)
    expect(first.review).toEqual({ edits: [{ edit: 1, page: 1, label: 'Change 1' }], pending: 1 })
    expect(review().live).toBe(true)
    expect(review().agent).toBe('Claude')
    await review().decide([0], true)
    // Decided, but the AI app is not waiting yet: the review stays open with Apply.
    expect(reviewState.useInlineReview.getState().review).not.toBeNull()
    expect(review().aiWaiting).toBe(false)
    const result = await collect(first.ticket)
    expect(result.data).toMatchObject({ applied: true, saved: false, acceptedEdits: [1], rejectedEdits: [], replacedEdits: [], undoLabel: 'Agent: Edit Text Batch' })
    expect(await text()).toContain('swift brown fox')
    expect(reviewState.useInlineReview.getState().review).toBeNull()
    expect(editReview.openEditReview()).toBeNull()
    await e.doc.undo()
    expect(await text()).toContain('quick brown fox')
  })

  it('later calls join the review, numbered across it; each ticket returns its own call; one undo step', async () => {
    const { e, revision, change, text } = await setup()
    const a = await edit({ revision, edits: [change('Hello', 'quick', 'swift')] })
    // Decided while the AI app is still sending.
    await review().decide([0], true)
    const b = await edit({ revision, edits: [change('Lorem', 'Lorem', 'LOREM')] })
    expect(b.review).toEqual({ edits: [{ edit: 1, page: 1, label: 'Change 2' }], pending: 1 })
    const c = await edit({ revision, edits: [change('Invoice', 'Invoice', 'INVOICE')] })
    expect(c.review.edits[0].label).toBe('Change 3')
    expect(editReview.openEditReview()).toEqual({ calls: 3, cards: 3 })
    expect(review().original.changes.map((x) => x.label)).toEqual(['Change 1', 'Change 2', 'Change 3'])
    expect(review().decisions).toEqual(['accepted', 'pending', 'pending'])
    // One proposal shows them all.
    const { id, version } = review().report.proposal!
    expect(version).toBe(3)
    await expect(e.call('agent-text.renderProposal', id, version, 0, { scale: 1 })).resolves.toMatchObject({ width: 612 })
    await review().decide([1], false)
    await review().decide([2], true)
    expect(reviewState.useInlineReview.getState().review).not.toBeNull()
    // The AI app waits for one ticket: that applies the review; every ticket has its result.
    const ra = await collect(a.ticket)
    expect(ra.data).toMatchObject({ acceptedEdits: [1], rejectedEdits: [], applied: true, changed: 1, pages: [1] })
    const rb = await collect(b.ticket)
    expect(rb.error).toMatchObject({ code: 'declined', message: expect.stringContaining('rejected edits 1') })
    expect(rb.error!.message).toContain('Other edits of the review were applied')
    const rc = await collect(c.ticket)
    expect(rc.data).toMatchObject({ acceptedEdits: [1], undoLabel: 'Agent: Edit Text Batch' })
    const after = await text()
    expect(after).toContain('swift brown fox')
    expect(after).toContain('Lorem ipsum')
    expect(after).toContain('INVOICE')
    // One undo step restores everything.
    await e.doc.undo()
    const before = await text()
    expect(before).toContain('quick brown fox')
    expect(before).toContain('Invoice')
    expect(before).not.toContain('INVOICE')
  })

  it('an edit of a block with a pending edit replaces it in place; the earlier call reports it', async () => {
    const { revision, change, text } = await setup()
    const a = await edit({ revision, edits: [change('Hello', 'quick', 'swift'), change('Lorem', 'Lorem', 'LOREM')] })
    const b = await edit({ revision, edits: [change('Hello', 'quick', 'rapid')] })
    expect(b.review.edits).toEqual([{ edit: 1, page: 1, label: 'Change 1' }])
    expect(review().original.changes).toHaveLength(2)
    expect(review().original.changes[0].after).toContain('rapid')
    expect(review().decisions).toEqual(['pending', 'pending'])
    await review().decide([0, 1], true)
    const rb = collect(b.ticket)
    const ra = await collect(a.ticket)
    expect(ra.data).toMatchObject({ acceptedEdits: [2], rejectedEdits: [], replacedEdits: [1] })
    expect((await rb).data).toMatchObject({ acceptedEdits: [1], replacedEdits: [] })
    const after = await text()
    expect(after).toContain('rapid brown fox')
    expect(after).toContain('LOREM')
  })

  it('an edit of a block the person already decided is refused, and the review goes on', async () => {
    const { revision, change } = await setup()
    const a = await edit({ revision, edits: [change('Hello', 'quick', 'swift')] })
    await review().decide([0], false)
    const refused = await call('edit_text', { revision, edits: [change('Lorem', 'Lorem', 'LOREM'), change('Hello', 'quick', 'rapid')] })
    expect(refused.error).toMatchObject({ code: 'invalid_args', message: expect.stringContaining('Edit 2 changes text the person has already rejected') })
    expect(review().original.changes).toHaveLength(1)
    expect(editReview.openEditReview()).toEqual({ calls: 1, cards: 1 })
    const r = await collect(a.ticket)
    expect(r.error).toMatchObject({ code: 'declined', message: expect.stringContaining('Nothing changed') })
  })

  it('a combined proposal with a blocking issue refuses only the new call and keeps the shown proposal', async () => {
    const { e, revision, change, text, block } = await setup()
    const a = await edit({ revision, edits: [change('Hello', 'quick', 'swift')] })
    const shown = review().report.proposal!
    const box = block('Hello').rect
    const refused = await call('edit_text', { revision, edits: [{ page: 1, text: 'On top of the first edit', rect: box }] })
    expect(refused.error).toMatchObject({ code: 'failed', message: expect.stringContaining('not added to the review') })
    expect(refused.error!.message).toContain('Edit 1: ')
    expect(review().report.proposal).toEqual(shown)
    await expect(e.call('agent-text.renderProposal', shown.id, shown.version, 0, { scale: 1 })).resolves.toMatchObject({ width: 612 })
    await review().decide([0], true)
    expect((await collect(a.ticket)).data).toMatchObject({ acceptedEdits: [1] })
    expect(await text()).toContain('swift brown fox')
  })

  it('another AI app, another document, an old revision, reflow and rebuild do not join', async () => {
    const { revision, change } = await setup()
    const a = await edit({ revision, edits: [change('Hello', 'quick', 'swift')] })
    const busy = await call('edit_text', { revision, edits: [change('Lorem', 'Lorem', 'LOREM')] }, 2)
    expect(busy.error?.code).toBe('busy')
    const old = await call('edit_text', { revision: revision + 7, edits: [change('Lorem', 'Lorem', 'LOREM')] })
    expect(old.error).toMatchObject({ code: 'failed', message: expect.stringContaining('get_editable_text again') })
    const rebuild = await call('rebuild_document', { revision, title: 'X', sections: [{ heading: 'A', paragraphs: ['B'] }] })
    expect(rebuild.error?.code).toBe('busy')
    // preview_only still works and leaves the review alone.
    const preview = await call('edit_text', { revision, edits: [change('Lorem', 'Lorem', 'LOREM')], preview_only: true })
    expect(preview.data).toMatchObject({ applied: false })
    expect(review().original.changes).toHaveLength(1)
    review().cancel()
    expect((await collect(a.ticket)).error?.code).toBe('declined')
  })

  it('a call takes at most 50 edits on 5 pages; a review at most 100 edits', async () => {
    const { revision } = await setup()
    // Small new text boxes, 20 a page, that do not touch.
    const box = (n: number) => {
      const page = Math.floor(n / 20) + 1
      const i = n % 20
      return { page, text: 'x', font_size: 6, rect: [20 + (i % 4) * 140, 660 + Math.floor(i / 4) * 20, 60 + (i % 4) * 140, 672 + Math.floor(i / 4) * 20] }
    }
    const tooMany = await call('edit_text', { revision, edits: Array.from({ length: 51 }, (_, n) => box(n)) })
    expect(tooMany.error?.code).toBe('invalid_args')
    const a = await edit({ revision, edits: Array.from({ length: 50 }, (_, n) => box(n)) })
    const b = await edit({ revision, edits: Array.from({ length: 50 }, (_, n) => box(n + 50)) })
    expect(review().original.changes).toHaveLength(100)
    const over = await call('edit_text', { revision, edits: [box(0)].map((x) => ({ ...x, rect: [500, 640, 540, 652] })) })
    expect(over.error).toMatchObject({ code: 'invalid_args', message: expect.stringContaining('at most 100 edits') })
    review().cancel()
    expect((await collect(a.ticket)).error?.code).toBe('declined')
    expect((await collect(b.ticket)).error?.code).toBe('declined')
  }, 60_000)

  it('cancelling a call withdraws its pending edits; decided ones stay for the person to apply', async () => {
    const { revision, change, text } = await setup()
    const a = await edit({ revision, edits: [change('Hello', 'quick', 'swift')] })
    const b = await edit({ revision, edits: [change('Lorem', 'Lorem', 'LOREM')] })
    const c = await edit({ revision, edits: [change('Invoice', 'Invoice', 'INVOICE')] })
    await review().decide([2], true)
    expect((await collect(b.ticket, { cancel: true })).error?.code).toBe('aborted')
    expect((await collect(c.ticket, { cancel: true })).error?.code).toBe('aborted')
    expect(review().decisions).toEqual(['pending', 'withdrawn', 'accepted'])
    // The withdrawn block can be edited again: it joins as a pending card in its old place.
    const d = await edit({ revision, edits: [change('Lorem', 'Lorem', 'Lorem!')] })
    expect(d.review.edits[0].label).toBe('Change 2')
    expect(review().decisions).toEqual(['pending', 'pending', 'accepted'])
    await review().decide([0], true)
    await review().decide([1], false)
    const rd = collect(d.ticket)
    expect((await collect(a.ticket)).data).toMatchObject({ acceptedEdits: [1] })
    expect((await rd).error?.code).toBe('declined')
    const after = await text()
    expect(after).toContain('swift brown fox')
    expect(after).toContain('INVOICE')
    expect(after).not.toContain('Lorem!')
  })

  it('the review closes when its only call is cancelled before anything was decided', async () => {
    const { e, revision, change, text } = await setup()
    const a = await edit({ revision, edits: [change('Hello', 'quick', 'swift')] })
    const { id, version } = review().report.proposal!
    expect((await collect(a.ticket, { cancel: true })).error?.code).toBe('aborted')
    expect(reviewState.useInlineReview.getState().review).toBeNull()
    await vi.waitFor(() => expect(e.call('agent-text.renderProposal', id, version, 0, { scale: 1 })).rejects.toMatchObject({ code: 'STALE_PROPOSAL' }))
    expect(await text()).toContain('quick brown fox')
  })

  it('the person can apply while the AI app is still sending; its next call starts a new review', async () => {
    const { revision, change, text } = await setup()
    const a = await edit({ revision, edits: [change('Hello', 'quick', 'swift')] })
    await review().decide([0], true)
    review().apply()
    await vi.waitFor(() => expect(reviewState.useInlineReview.getState().review).toBeNull())
    expect((await collect(a.ticket)).data).toMatchObject({ acceptedEdits: [1] })
    expect(await text()).toContain('swift brown fox')
    // Its revision is out of date now.
    const stale = await call('edit_text', { revision, edits: [change('Lorem', 'Lorem', 'LOREM')] })
    expect(stale.error?.message).toMatch(/document changed/i)
  })

  it('Discard batch ends every call as declined', async () => {
    const { revision, change, text } = await setup()
    const a = await edit({ revision, edits: [change('Hello', 'quick', 'swift')] })
    const b = await edit({ revision, edits: [change('Lorem', 'Lorem', 'LOREM')] })
    await review().decide([0, 1], true)
    review().cancel()
    expect((await collect(a.ticket)).error?.code).toBe('declined')
    expect((await collect(b.ticket)).error?.code).toBe('declined')
    expect(await text()).toContain('quick brown fox')
  })
})
