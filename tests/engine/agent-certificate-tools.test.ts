// Agent access on certificate-encrypted documents: remove_security and export_document say what a
// certificate allows (there is no permissions password to ask for). The handlers run against real
// documents (the in-process engine behind a DocumentModel), opened with the fixtures' keys, with a
// stand-in main process.
import { isValidElement } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChangeSet } from '@shared/types'
import type { AgentCallRequest } from '@shared/agent/bridge'
import type { DialogEntry } from '@renderer/app/store'
import type { DocUnlock } from '@renderer/app/unlock'
import { keyFor, openFixtureAs, type Engine } from './passwordless-helpers'

let DocumentModel: typeof import('@renderer/document/DocumentModel').DocumentModel
let useApp: typeof import('@renderer/app/store').useApp
let common: typeof import('@features/agent-access/tools/common')
let handlers: typeof import('@features/agent-access/tools').TOOL_HANDLERS
let certificateAccess: typeof import('@renderer/app/unlock').certificateAccess

/** What the stand-in main process was asked, in order. */
const invoked: { channel: string; args: unknown[] }[] = []

beforeAll(async () => {
  vi.stubGlobal('window', {
    api: {
      platform: 'win32',
      invoke: async (channel: string, ...args: unknown[]) => {
        invoked.push({ channel, args })
        return undefined
      },
      on: () => () => {}
    }
  })
  await import('@renderer/app/registry')
  ;({ DocumentModel } = await import('@renderer/document/DocumentModel'))
  ;({ useApp } = await import('@renderer/app/store'))
  ;({ certificateAccess } = await import('@renderer/app/unlock'))
  common = await import('@features/agent-access/tools/common')
  ;({ TOOL_HANDLERS: handlers } = await import('@features/agent-access/tools'))
})

beforeEach(() => {
  for (const d of useApp.getState().docs) d.close()
  for (const d of useApp.getState().dialogs) d.resolve(undefined)
  useApp.setState({ docs: [], activeDocId: null, dialogs: [] })
  invoked.length = 0
})

const FILE = 'v5-two-envelopes.pdf'

/** The fixture opened by `person` as Fartcrobat opens it (DocState.unlock says which key, with what access). */
async function openedAs(person: 'alice' | 'bob') {
  const e: Engine = await openFixtureAs(FILE, person)
  const key = keyFor(FILE, person)
  const unlock: DocUnlock = {
    method: 'certificate',
    access: certificateAccess(key.permissions),
    via: { source: 'digital-id', label: person, subject: `CN=${person}`, fingerprint: 'AB', hardware: false },
    certificateKey: key
  }
  const client = {
    ops: (ns: string) => new Proxy({}, { get: (_t, name) => async (...args: unknown[]) => e.call(`${ns}.${String(name)}`, ...args) }),
    onChanges: (_l: (cs: ChangeSet) => void) => () => {},
    runAs: async <T,>(_actor: string, fn: () => Promise<T>) => fn(),
    terminate() {}
  }
  const doc = new DocumentModel(client as any, e.info, { title: FILE, filePath: `C:\\docs\\${FILE}`, unlock })
  useApp.setState((s) => ({ docs: [...s.docs, doc], activeDocId: doc.id }))
  return { doc, handle: `w1-${common.BOOT}-${doc.id}` }
}

function ctx() {
  const request: AgentCallRequest = {
    id: '1:1',
    connectionId: 1,
    client: { name: 'claude-ai', version: '1' },
    windowId: 'w1',
    currentWindow: true,
    tool: 'x',
    args: {}
  }
  const audit: Record<string, unknown> = {}
  return { request, signal: new AbortController().signal, progress: () => {}, audit: (d: Record<string, unknown>) => void Object.assign(audit, d) }
}

function call(tool: string, args: Record<string, unknown>): Promise<any> {
  return handlers[tool as keyof typeof handlers]!(args, ctx() as any)
}

async function errorOf(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e) => e
  )
  expect(err).toBeInstanceOf(common.ToolError)
  return err as InstanceType<typeof common.ToolError>
}

/** Every string a dialog shows, without rendering it. */
function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>
    return Object.entries(props)
      .filter(([k]) => k !== 'onClose' && k !== 'className')
      .map(([, v]) => textOf(v))
      .join(' ')
  }
  return ''
}

async function nextDialog(): Promise<DialogEntry> {
  await vi.waitFor(() => expect(useApp.getState().dialogs.length).toBeGreaterThan(0))
  return useApp.getState().dialogs.at(-1)!
}

describe('remove_security on a certificate-encrypted document', () => {
  it('refuses before asking when the person’s certificate may not change the security', async () => {
    const { doc, handle } = await openedAs('alice')
    expect(doc.state.info.security).toBe('certificate')
    expect(doc.state.unlock?.access).toBe('user')
    const err = await errorOf(call('remove_security', { handle }))
    expect(err.code).toBe('failed')
    expect(err.message).toBe(
      `The person’s certificate does not allow removing the security of “${FILE}”. Only someone whose certificate may change its security can remove it.`
    )
    expect(useApp.getState().dialogs).toEqual([])
    expect(invoked.filter((c) => c.channel !== 'feature:agent-access:attention')).toEqual([])
  })

  it('asks with certificate wording (no permissions password) when it may', async () => {
    const { doc, handle } = await openedAs('bob')
    expect(doc.state.unlock?.access).toBe('owner')
    const removing = call('remove_security', { handle })
    const d = await nextDialog()
    const text = textOf(d.render(() => {}))
    expect(text).toMatch(new RegExp(`Remove the certificate security from “${FILE.replace('.', '\\.')}”\\? Anyone with the file`))
    expect(text).not.toMatch(/password/)
    d.resolve(false)
    expect((await errorOf(removing)).code).toBe('declined')
  })
})

describe('export_document on a certificate-encrypted document', () => {
  it('a copy restriction comes from the certificate: no permissions password to suggest', async () => {
    const { doc, handle } = await openedAs('alice')
    expect(doc.state.info.permissions.copy).toBe(false)
    const err = await errorOf(call('export_document', { handle, format: 'text', path: 'C:\\out\\two.txt' }))
    expect(err.code).toBe('failed')
    expect(err.message).toMatch(/don't allow copying or exporting its content/)
    expect(err.message).toMatch(/The restriction comes from the certificate the person opened it with: only someone whose certificate may change its security can lift it\.$/)
    expect(err.message).not.toMatch(/permissions password/)
  })
})
