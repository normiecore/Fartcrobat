// Agent access: what the person is asked (tools/common.tsx confirmAgentAction, tools/act-runtime.ts
// handoff) when several calls run at once, and apply_redactions removing only what they approved.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeSet } from '@shared/types'
import type { AgentCallRequest } from '@shared/agent/bridge'
import type { ToolContext } from '@features/agent-access/tools/common'
import { DEFAULT_PROPS } from '@features/redact/shared'
import { openFixture, type OpenedEngine } from './helpers'

let common: typeof import('@features/agent-access/tools/common')
let runtime: typeof import('@features/agent-access/tools/act-runtime')
let irreversible: typeof import('@features/agent-access/tools/irreversible')
let ui: typeof import('@renderer/app/ui-services')
let useApp: typeof import('@renderer/app/store').useApp
let DocumentModel: typeof import('@renderer/document/DocumentModel').DocumentModel

beforeAll(async () => {
  vi.stubGlobal('window', {})
  await import('@renderer/app/registry')
  common = await import('@features/agent-access/tools/common')
  runtime = await import('@features/agent-access/tools/act-runtime')
  irreversible = await import('@features/agent-access/tools/irreversible')
  ui = await import('@renderer/app/ui-services')
  ;({ useApp } = await import('@renderer/app/store'))
  ;({ DocumentModel } = await import('@renderer/document/DocumentModel'))
  // The main process, after the modules read the (missing) preload bridge at load time.
  ;(window as any).api = { invoke: async () => {}, on: () => () => {} }
})

beforeEach(() => {
  for (const d of useApp.getState().dialogs) d.resolve(undefined)
  for (const d of useApp.getState().docs) d.close()
  useApp.setState({ docs: [], activeDocId: null, dialogs: [] })
})

function ctxFor(audit: Record<string, unknown> = {}) {
  const controller = new AbortController()
  const request: AgentCallRequest = { id: '1:1', connectionId: 1, client: { name: 'claude-ai', version: '1' }, windowId: 'w1', currentWindow: true, tool: 'x', args: {} }
  const ctx: ToolContext = {
    request,
    signal: controller.signal,
    progress: () => {},
    audit: (d) => void Object.assign(audit, d)
  }
  return { ctx, controller, audit }
}

const confirmOpts = { title: 'Save over the file?', message: 'Save it?', confirmLabel: 'Save' }
const dialogs = () => useApp.getState().dialogs
const settle = () => new Promise((r) => setTimeout(r, 0))

/** A promise with its resolve function. */
function gate<T = void>() {
  let open!: (v: T) => void
  const promise = new Promise<T>((r) => (open = r))
  return { promise, open }
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p
    return null
  } catch (err) {
    return (err as { code?: string }).code ?? String(err)
  }
}

describe('confirmations', () => {
  it('ask one at a time: another call is told busy, without a second look-alike dialog', async () => {
    const a = ctxFor()
    const b = ctxFor()
    const first = common.confirmAgentAction(a.ctx, confirmOpts)
    expect(dialogs()).toHaveLength(1)
    expect(await codeOf(common.confirmAgentAction(b.ctx, confirmOpts))).toBe('busy')
    expect(dialogs()).toHaveLength(1)
    dialogs()[0].resolve(true)
    expect(await first).toBe(true)
    // Free again.
    const again = common.confirmAgentAction(b.ctx, confirmOpts)
    dialogs()[0].resolve(false)
    expect(await again).toBe(false)
  })

  it('are busy while the person has a dialog of their own open', async () => {
    const own = ui.openDialog(() => null)
    expect(await codeOf(common.confirmAgentAction(ctxFor().ctx, confirmOpts))).toBe('busy')
    dialogs()[0].resolve(undefined)
    await own
  })

  it('close as declined when the call is cancelled, also before the dialog was drawn', async () => {
    const { ctx, controller } = ctxFor()
    const asking = common.confirmAgentAction(ctx, confirmOpts)
    expect(dialogs()).toHaveLength(1)
    controller.abort()
    expect(await asking).toBe(false)
    expect(dialogs()).toHaveLength(0)
  })
})

describe('hand-offs', () => {
  it('take turns, so cancelling one never closes the dialog of another', async () => {
    const a = ctxFor()
    const b = ctxFor()
    const log: string[] = []
    const first = runtime.handoff(a.ctx, async () => {
      log.push('a')
      return ui.openDialog<string>(() => null)
    })
    const second = runtime.handoff(b.ctx, async () => {
      log.push('b')
      return ui.openDialog<string>(() => null)
    })
    await settle()
    expect(log).toEqual(['a'])
    expect(dialogs()).toHaveLength(1)
    // b waits for its turn; cancelling a closes a's dialog only.
    a.controller.abort()
    expect(await codeOf(first)).toBe('aborted')
    await vi.waitFor(() => expect(log).toEqual(['a', 'b']))
    expect(dialogs()).toHaveLength(1)
    dialogs()[0].resolve('typed')
    expect(await second).toBe('typed')
  })

  it('give up waiting for their turn when cancelled, and the next still waits for the earlier ones', async () => {
    const a = ctxFor()
    const b = ctxFor()
    const c = ctxFor()
    const holdA = gate<string>()
    const log: string[] = []
    const first = runtime.handoff(a.ctx, async () => {
      log.push('a')
      return holdA.promise
    })
    const second = runtime.handoff(b.ctx, async () => {
      log.push('b')
      return 'b'
    })
    const third = runtime.handoff(c.ctx, async () => {
      log.push('c')
      return 'c'
    })
    await settle()
    b.controller.abort()
    expect(await codeOf(second)).toBe('aborted')
    await settle()
    expect(log).toEqual(['a'])
    holdA.open('a')
    expect(await first).toBe('a')
    expect(await third).toBe('c')
    expect(log).toEqual(['a', 'c'])
  })

  it("leave another call's confirmation open when cancelled", async () => {
    const a = ctxFor()
    const b = ctxFor()
    const opened = gate()
    // a's step opens its dialog only after b's confirmation is up.
    const handing = runtime.handoff(a.ctx, async () => {
      await opened.promise
      return ui.openDialog<string>(() => null)
    })
    await settle()
    const confirming = common.confirmAgentAction(b.ctx, confirmOpts)
    opened.open()
    await vi.waitFor(() => expect(dialogs()).toHaveLength(2))
    a.controller.abort()
    expect(await codeOf(handing)).toBe('aborted')
    expect(dialogs()).toHaveLength(1)
    expect(common.isAgentConfirmation(dialogs()[0])).toBe(true)
    dialogs()[0].resolve(true)
    expect(await confirming).toBe(true)
  })

  it('report a step the person finished even if the agent cancelled meanwhile, only when asked to', async () => {
    const a = ctxFor()
    const finished = runtime.handoff(
      a.ctx,
      async () => {
        a.controller.abort()
        return true
      },
      { keepDone: true }
    )
    expect(await finished).toBe(true)
    const b = ctxFor()
    const plain = runtime.handoff(b.ctx, async () => {
      b.controller.abort()
      return true
    })
    expect(await codeOf(plain)).toBe('aborted')
  })
})

/** A DocumentModel driven by the in-process engine. */
function modelFor(e: OpenedEngine, title: string) {
  const listeners = new Set<(cs: ChangeSet) => void>()
  const client = {
    ops: (ns: string) => new Proxy({}, { get: (_t, name) => async (...args: unknown[]) => e.call(`${ns}.${String(name)}`, ...args) }),
    onChanges: (l: (cs: ChangeSet) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    runAs: <T>(_actor: string, fn: () => Promise<T>) => fn(),
    terminate() {}
  }
  return new DocumentModel(client as any, e.info, { title, filePath: null })
}

describe('apply_redactions', () => {
  async function setup() {
    const e = await openFixture('text.pdf')
    const doc = modelFor(e, 'text.pdf')
    useApp.setState({ docs: [doc], activeDocId: doc.id })
    const redact = (...args: unknown[]) => e.call('redact.mark', ...args) as Promise<{ id: number }[]>
    const [first] = await redact([{ page: 0, kind: 'area', rect: [72, 72, 300, 120] }], DEFAULT_PROPS)
    const handle = common.handleOf(ctxFor().ctx, doc)
    return { e, doc, redact, first, handle }
  }

  it('removes only the marks the person approved, not ones another call added meanwhile', async () => {
    const { e, redact, handle } = await setup()
    const { ctx, audit } = ctxFor()
    const applying = irreversible.handlers.apply_redactions!({ handle }, ctx)
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
    const [added] = await redact([{ page: 3, kind: 'area', rect: [72, 72, 300, 120] }], DEFAULT_PROPS)
    dialogs()[0].resolve(true)
    const { data } = (await applying) as { data: any }
    expect(data).toMatchObject({ applied: 1, pages: [1] })
    expect(audit).toMatchObject({ summary: 'applied 1 redaction on page 1' })
    expect(((await e.call('redact.list')) as { id: number }[]).map((m) => m.id)).toEqual([added.id])
  })

  it('applies nothing when an approved mark was moved meanwhile', async () => {
    const { e, first, handle } = await setup()
    const { ctx } = ctxFor()
    const applying = irreversible.handlers.apply_redactions!({ handle }, ctx)
    await vi.waitFor(() => expect(dialogs()).toHaveLength(1))
    await e.call('annots.transform', [{ id: first.id, rect: [0, 0, 612, 792] }], 0)
    dialogs()[0].resolve(true)
    await expect(applying).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('changed while the person was deciding') })
    expect(((await e.call('redact.list')) as { id: number }[]).map((m) => m.id)).toEqual([first.id])
  })
})
