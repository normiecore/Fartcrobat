// Agent access: tool handlers that ask the person first (network locations, undoing their steps),
// copy-restricted documents and tabs of converted files. The handlers run as on Windows against
// real documents (the in-process engine behind a DocumentModel), with a stand-in main process.
import { isValidElement } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type redactOps from '@features/redact/engine'
import { DEFAULT_PROPS } from '@features/redact/shared'
import type { ChangeSet } from '@shared/types'
import type { AgentCallRequest } from '@shared/agent/bridge'
import type { DialogEntry } from '@renderer/app/store'
import { openFixture, type OpenedEngine } from './helpers'

let DocumentModel: typeof import('@renderer/document/DocumentModel').DocumentModel
let useApp: typeof import('@renderer/app/store').useApp
let common: typeof import('@features/agent-access/tools/common')
let handlers: typeof import('@features/agent-access/tools').TOOL_HANDLERS
let initialView: typeof import('@features/navigation/initialView')

/** What the stand-in main process was asked, in order. */
const invoked: { channel: string; args: unknown[] }[] = []
/** Files main reports as existing. */
const existing = new Set<string>()

beforeAll(async () => {
  vi.stubGlobal('window', {
    api: {
      platform: 'win32',
      invoke: async (channel: string, ...args: unknown[]) => {
        invoked.push({ channel, args })
        return channel === 'file:exists' ? existing.has(args[0] as string) : undefined
      },
      on: () => () => {}
    }
  })
  await import('@renderer/app/registry')
  ;({ DocumentModel } = await import('@renderer/document/DocumentModel'))
  ;({ useApp } = await import('@renderer/app/store'))
  common = await import('@features/agent-access/tools/common')
  ;({ TOOL_HANDLERS: handlers } = await import('@features/agent-access/tools'))
  initialView = await import('@features/navigation/initialView')
})

beforeEach(() => {
  for (const d of useApp.getState().docs) d.close()
  for (const d of useApp.getState().dialogs) d.resolve(undefined)
  useApp.setState({ docs: [], activeDocId: null, dialogs: [] })
  invoked.length = 0
  existing.clear()
})

/** A DocumentModel driven by the in-process engine; agent calls are labelled "Agent: ...". */
function modelFor(e: OpenedEngine, title: string, opts: { filePath?: string | null; sourcePath?: string | null } = {}) {
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
  const doc = new DocumentModel(client as any, e.info, { title, filePath: opts.filePath ?? null, sourcePath: opts.sourcePath })
  useApp.setState((s) => ({ docs: [...s.docs, doc], activeDocId: doc.id }))
  return doc
}

function ctxFor(audit: Record<string, unknown> = {}, connectionId = 1) {
  const request: AgentCallRequest = {
    id: `${connectionId}:1`,
    connectionId,
    client: { name: 'claude-ai', version: '1' },
    windowId: 'w1',
    currentWindow: true,
    tool: 'x',
    args: {}
  }
  return {
    request,
    signal: new AbortController().signal,
    progress: () => {},
    audit: (d: Record<string, unknown>) => void Object.assign(audit, d)
  }
}

function call(tool: string, args: Record<string, unknown> = {}, ctx = ctxFor()): Promise<any> {
  return handlers[tool as keyof typeof handlers]!(args, ctx as any)
}

async function errorOf(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e) => e
  )
  expect(err).toBeInstanceOf(common.ToolError)
  return err as InstanceType<typeof common.ToolError>
}

/** The dialog the person sees next. */
async function nextDialog(): Promise<DialogEntry> {
  await vi.waitFor(() => expect(useApp.getState().dialogs.length).toBeGreaterThan(0))
  return useApp.getState().dialogs.at(-1)!
}

/** Every string a dialog shows (its title, message and details), without rendering it. */
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

const dialogText = (d: DialogEntry) => textOf(d.render(() => {}))
const channels = () => invoked.map((c) => c.channel).filter((c) => c !== 'feature:agent-access:attention')

describe('network locations', () => {
  it('asks before the first use of a server, before main touches the path', async () => {
    const opening = call('open_document', { path: '\\\\fileserver\\docs\\report.pdf' })
    const d = await nextDialog()
    expect(dialogText(d)).toMatch(/Use a network location\?/)
    expect(dialogText(d)).toMatch(/Opening “report\.pdf” uses files on \\\\fileserver, another computer on your network/)
    expect(channels()).toEqual([])
    d.resolve(false)
    const err = await errorOf(opening)
    expect(err.code).toBe('declined')
    expect(channels()).toEqual([])

    // Allowed: the file is looked for; the server is not asked about again in this window.
    const again = call('open_document', { path: '\\\\FileServer\\docs\\report.pdf' })
    ;(await nextDialog()).resolve(true)
    expect((await errorOf(again)).code).toBe('file_error')
    expect(channels()).toEqual(['file:exists'])
    expect((await errorOf(call('open_document', { path: '//fileserver/other/x.pdf' }))).code).toBe('file_error')
    expect(useApp.getState().dialogs).toHaveLength(0)
    expect(invoked.at(-1)).toEqual({ channel: 'file:exists', args: ['\\\\fileserver\\other\\x.pdf'] })

    // The OK is for that AI app: another connection (or the same app connecting again) asks anew.
    invoked.length = 0
    const other = call('open_document', { path: '\\\\fileserver\\docs\\report.pdf' }, ctxFor({}, 2))
    const asked = await nextDialog()
    expect(dialogText(asked)).toMatch(/without asking again until it disconnects or you close this window/)
    asked.resolve(false)
    expect((await errorOf(other)).code).toBe('declined')
    expect(channels()).toEqual([])
  })

  it('asks once for calls made at the same time, and about each new server', async () => {
    const a = call('open_document', { path: '\\\\nas\\s\\a.pdf' })
    const b = call('combine_files', { paths: ['\\\\nas\\s\\b.pdf', 'C:\\docs\\c.pdf'] })
    const d = await nextDialog()
    await new Promise((r) => setTimeout(r, 20))
    expect(useApp.getState().dialogs).toHaveLength(1)
    d.resolve(true)
    expect((await errorOf(a)).code).toBe('file_error')
    expect((await errorOf(b)).code).toBe('file_error')
    expect(useApp.getState().dialogs).toHaveLength(0)

    const several = call('combine_files', { paths: ['\\\\nas\\s\\a.pdf', '\\\\one\\s\\b.pdf'], path: '\\\\two@SSL@443\\dav\\out.pdf' })
    const both = await nextDialog()
    expect(dialogText(both)).toMatch(/Use network locations\?/)
    expect(dialogText(both)).toMatch(/files on 2 other computers/)
    expect(dialogText(both)).toMatch(/\\\\one .*\\\\two/)
    both.resolve(false)
    expect((await errorOf(several)).code).toBe('declined')
  })

  it('does not ask about the server of a document that is open', async () => {
    modelFor(await openFixture('text.pdf'), 'a.pdf', { filePath: '\\\\shared\\team\\a.pdf' })
    const err = await errorOf(call('combine_files', { paths: ['\\\\shared\\team\\b.pdf', '\\\\shared\\team\\c.pdf'] }))
    expect(err.code).toBe('file_error')
    expect(useApp.getState().dialogs).toHaveLength(0)
  })

  it('asks before reading a file to insert from a network location', async () => {
    const doc = modelFor(await openFixture('text.pdf'), 'text.pdf', { filePath: 'C:\\docs\\text.pdf' })
    const inserting = call('organize_pages', { handle: `w1-${common.BOOT}-${doc.id}`, operation: 'insert_file', path: '\\\\scanner\\out\\scan.pdf' })
    const d = await nextDialog()
    expect(dialogText(d)).toMatch(/Inserting pages from “scan\.pdf”/)
    d.resolve(false)
    expect((await errorOf(inserting)).code).toBe('declined')
    expect(channels()).toEqual([])
  })

  it('refuses device and namespace paths without asking anything', async () => {
    for (const path of ['\\\\.\\pipe\\x', '\\\\?\\UNC\\h\\s\\a.pdf', 'C:\\docs\\con.pdf']) {
      const err = await errorOf(call('open_document', { path }))
      expect(err.code).toBe('invalid_args')
    }
    expect(invoked).toEqual([])
  })
})

describe('undo and redo of the person\'s steps', () => {
  async function setUp() {
    const e = await openFixture('text.pdf')
    const doc = modelFor(e, 'text.pdf', { filePath: 'C:\\docs\\text.pdf' })
    const annots = e.ops<typeof annotOps>('annots')
    return { e, doc, annots, handle: `w1-${common.BOOT}-${doc.id}` }
  }

  it('undoes the agent\'s own step straight away', async () => {
    const { doc, annots, handle } = await setUp()
    await common.runAsAgent(doc, () => doc.ops<typeof annotOps>('annots').create(0, { type: 'Square', rect: [10, 10, 40, 40] }))
    const { data } = await call('undo', { handle })
    expect(data).toMatchObject({ undone: 'Agent: Add Square' })
    expect(useApp.getState().dialogs).toHaveLength(0)
    expect(await annots.listAll()).toEqual([])
    expect((await call('redo', { handle })).data).toMatchObject({ redone: 'Agent: Add Square' })
  })

  it('asks before undoing the person\'s step; Decline keeps it', async () => {
    const { e, annots, handle } = await setUp()
    await annots.create(0, { type: 'Square', rect: [10, 10, 40, 40] })
    const audit: Record<string, unknown> = {}
    const undoing = call('undo', { handle }, ctxFor(audit))
    const d = await nextDialog()
    expect(dialogText(d)).toMatch(/Undo your change\?/)
    expect(dialogText(d)).toMatch(/Claude wants to undo “Add Square”, a change you made/)
    expect(dialogText(d)).toMatch(/yours can't be redone/)
    d.resolve(false)
    expect((await errorOf(undoing)).code).toBe('declined')
    expect(audit).toMatchObject({ outcome: 'declined', summary: 'undo Add Square' })
    expect((await e.doc.journal()).undoLabel).toBe('Add Square')

    const accepted = call('undo', { handle })
    ;(await nextDialog()).resolve(true)
    expect((await accepted).data).toMatchObject({ undone: 'Add Square', redoLabel: 'Add Square' })
    expect(await annots.listAll()).toEqual([])

    // Redoing the person's step asks too.
    const redoing = call('redo', { handle })
    const r = await nextDialog()
    expect(dialogText(r)).toMatch(/Redo your change\?/)
    r.resolve(true)
    expect((await redoing).data).toMatchObject({ redone: 'Add Square' })
  })

  it('does nothing when the history moved while the person decided', async () => {
    const { e, annots, handle } = await setUp()
    await annots.create(0, { type: 'Square', rect: [10, 10, 40, 40] })
    const undoing = call('undo', { handle })
    const d = await nextDialog()
    await annots.create(0, { type: 'Circle', rect: [50, 50, 90, 90] })
    d.resolve(true)
    const err = await errorOf(undoing)
    expect(err.code).toBe('failed')
    expect(err.message).toMatch(/changed while the person was deciding, so nothing was undone/)
    expect(await annots.listAll()).toHaveLength(2)
    expect((await e.doc.journal()).canRedo).toBe(false)
  })

  it('asks before undoing redactions, even ones the agent applied', async () => {
    const { e, doc, handle } = await setUp()
    const redact = doc.ops<typeof redactOps>('redact')
    await common.runAsAgent(doc, () => redact.mark([{ page: 0, kind: 'area', rect: [0, 0, 300, 300] }], DEFAULT_PROPS))
    await common.runAsAgent(doc, () => redact.apply(null))
    expect((await e.doc.journal()).undoLabel).toBe('Agent: Apply Redactions')
    const undoing = call('undo', { handle })
    const d = await nextDialog()
    expect(dialogText(d)).toMatch(/Undo the redactions\?/)
    expect(dialogText(d)).toMatch(/content the redactions removed comes back/)
    expect(dialogText(d)).not.toMatch(/a change you made/)
    d.resolve(false)
    expect((await errorOf(undoing)).code).toBe('declined')
    expect((await e.doc.journal()).undoLabel).toBe('Agent: Apply Redactions')
  })
})

describe('copy-restricted documents', () => {
  it('reads their text with a flag, and refuses to export them', async () => {
    const doc = modelFor(await openFixture('derived-protection/aes256-restricted.pdf'), 'restricted.pdf', { filePath: 'C:\\docs\\restricted.pdf' })
    expect(doc.state.info.permissions.copy).toBe(false)
    const handle = `w1-${common.BOOT}-${doc.id}`
    const text = (await call('get_page_text', { handle, pages: '1' })).data
    expect(text.copyRestricted).toBe(true)
    expect(text.pages[0].text).toMatch(/Confidential text on page 1/)
    expect((await call('find_text', { handle, query: 'Confidential' })).data).toMatchObject({ copyRestricted: true, count: 3 })
    expect((await call('get_document_info', { handle, include_outline: false })).data.copyRestricted).toBe(true)
    expect((await call('get_context', { handle })).data.copyRestricted).toBe(true)
    expect((await call('list_annotations', { handle })).data.copyRestricted).toBe(true)
    expect((await call('render_page', { handle, page: 1, dpi: 36 })).data.copyRestricted).toBe(true)

    const err = await errorOf(call('export_document', { handle, format: 'text', path: 'C:\\out\\restricted.txt' }))
    expect(err.code).toBe('failed')
    expect(err.message).toMatch(/don't allow copying or exporting its content, so Fartcrobat does not export it. You can still read it with get_page_text/)
    expect(invoked).toEqual([])

    const plain = modelFor(await openFixture('text.pdf'), 'text.pdf')
    expect((await call('get_page_text', { handle: `w1-${common.BOOT}-${plain.id}`, pages: '1' })).data.copyRestricted).toBeUndefined()
  })
})

describe('open_document', () => {
  it('returns the tab converted from a file until it is saved as a PDF', async () => {
    const doc = modelFor(await openFixture('text.pdf'), 'report.pdf', { sourcePath: 'C:\\Docs\\Report.docx' })
    const { data } = await call('open_document', { path: 'c:/docs/report.docx' })
    expect(data).toMatchObject({ handle: `w1-${common.BOOT}-${doc.id}`, path: null, convertedFrom: 'C:\\Docs\\Report.docx', alreadyOpen: true })
    expect(invoked).toEqual([])
    const { data: list } = await call('list_documents')
    expect(list.documents[0].convertedFrom).toBe('C:\\Docs\\Report.docx')

    // Saved as a PDF, the tab is that PDF: the Word file opens anew.
    doc.set({ filePath: 'C:\\Docs\\Report.pdf' })
    expect((await errorOf(call('open_document', { path: 'C:\\Docs\\Report.docx' }))).code).toBe('file_error')
    expect((await call('list_documents')).data.documents[0].convertedFrom).toBeUndefined()
  })
})

describe('initial view', () => {
  it('tells when the document\'s Initial View has been applied', async () => {
    let finish!: (v: unknown) => void
    const properties = new Promise((r) => (finish = r))
    const doc = { isClosed: false, ops: () => ({ properties: () => properties }) } as any
    let settled = false
    const applying = initialView.applyInitialView(doc)
    void initialView.initialViewSettled(doc).then(() => (settled = true))
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    finish({ initialView: { navigationTab: 'page', pageLayout: 'default', magnification: 'default', openToPage: 0 } })
    await applying
    await vi.waitFor(() => expect(settled).toBe(true))

    // A failure settles it too, and other documents have nothing to wait for.
    const failing = { isClosed: false, ops: () => ({ properties: () => Promise.reject(new Error('broken')) }) } as any
    await expect(initialView.applyInitialView(failing)).rejects.toThrow('broken')
    await initialView.initialViewSettled(failing)
    await initialView.initialViewSettled({} as any)
  })
})


describe('native text editing review', () => {
  async function nextReview() {
    const { useInlineReview } = await import('@features/agent-access/ui/reviewState')
    await vi.waitFor(() => expect(useInlineReview.getState().review).not.toBeNull())
    return useInlineReview.getState().review!
  }
  async function proposal() {
    const e = await openFixture('text.pdf')
    const doc = modelFor(e, 'CV.pdf')
    const snap = (await call('get_editable_text', { page: 1 })).data
    const b = snap.blocks.find((b: any) => b.text.includes('quick brown fox'))
    return { e, doc, args: { revision: snap.revision, edits: [{ page: 1, block_id: b.block_id, original_text: b.text, text: b.text.replace('quick', 'swift') }] } }
  }
  it('preview does not ask or change text; Decline leaves the PDF alone', async () => {
    const { e, args } = await proposal()
    const preview = await call('edit_text', { ...args, preview_only: true })
    expect(preview.data.applied).toBe(false)
    expect(preview.images).toHaveLength(1)
    expect(useApp.getState().dialogs).toHaveLength(0)
    const pending = call('edit_text', args)
    const review = await nextReview()
    expect(review.title).toBe('Review text changes')
    expect(useApp.getState().dialogs).toHaveLength(0)
    review.cancel()
    expect((await errorOf(pending)).code).toBe('declined')
    expect(await e.call('edit-text.text', 0)).toContain('quick brown fox')
  })
  it('Apply creates one Agent undo step and stale proposals never overwrite person changes', async () => {
    const { e, doc, args } = await proposal()
    const pending = call('edit_text', args)
    await (await nextReview()).decide([0], true)
    expect((await pending).data).toMatchObject({ applied: true, saved: false, undoLabel: 'Agent: Edit Text Batch' })
    expect(await e.call('edit-text.text', 0)).toContain('swift brown fox')
    await e.doc.undo()
    const snap = (await call('get_editable_text', { page: 1 })).data
    const stale = call('edit_text', { ...args, revision: snap.revision })
    await nextReview()
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [10,10,20,20], contents: 'Person note' })
    await (doc as any).applyChanges(e.lastChanges)
    expect((await errorOf(stale)).message).toContain('document changed')
    expect(await e.call('edit-text.text', 0)).toContain('quick brown fox')
  })
  it('saving during review keeps it open: a save is not a change to review against', async () => {
    const { e, doc, args } = await proposal()
    const pending = call('edit_text', args)
    const review = await nextReview()
    const { version } = await e.doc.saveWithVersion({})
    await (doc as any).applyChanges(e.lastChanges)
    await e.doc.markSaved('CV.pdf', version)
    await (doc as any).applyChanges(e.lastChanges)
    expect(e.lastChanges?.document).toBe(true)
    const { useInlineReview } = await import('@features/agent-access/ui/reviewState')
    expect(useInlineReview.getState().review).toBe(review)
    await review.decide([0], true)
    expect((await pending).data).toMatchObject({ applied: true })
    expect(await e.call('edit-text.text', 0)).toContain('swift brown fox')
  })
  it('issues name the edit as the call numbers it, also after the person rejected some', async () => {
    const e = await openFixture('text.pdf')
    modelFor(e, 'CV.pdf')
    const snap = (await call('get_editable_text', { page: 1 })).data
    const edit = (start: string, text: (t: string) => string) => {
      const b = snap.blocks.find((b: any) => b.text.startsWith(start))
      return { page: 1, block_id: b.block_id, original_text: b.text, text: text(b.text) }
    }
    const edits = [
      edit('Hello', (t) => t.replace('quick', 'swift')),
      edit('Visit', (t) => t + ' and read the full documentation of the product there')
    ]
    const grew = (issues: any[]) => issues.find((i) => i.code === 'text_grew')
    const preview = (await call('edit_text', { revision: snap.revision, edits, preview_only: true })).data
    expect(grew(preview.issues)).toMatchObject({ edit: 2 })
    expect(preview.issues.some((i: any) => 'change' in i)).toBe(false)
    const pending = call('edit_text', { revision: snap.revision, edits })
    const review = await nextReview()
    await review.decide([0], false)
    await review.decide([1], true)
    const result = (await pending).data
    expect(result).toMatchObject({ acceptedEdits: [2], rejectedEdits: [1] })
    // The engine ran on the accepted edit alone; the AI app still hears about its edit 2.
    expect(grew(result.issues)).toMatchObject({ edit: 2 })
  })
  it('a proposal from another AI app while a review is open is refused before it switches tabs', async () => {
    const { args } = await proposal()
    const pending = call('edit_text', args)
    const review = await nextReview()
    const active = useApp.getState().activeDocId
    expect((await errorOf(call('edit_text', args, ctxFor({}, 2)))).code).toBe('busy')
    expect((await errorOf(call('reflow_text', { revision: args.revision, regions: [], paragraphs: [] }))).code).toBe('busy')
    expect(useApp.getState().activeDocId).toBe(active)
    review.cancel()
    expect((await errorOf(pending)).code).toBe('declined')
  })
  it('the review shows a proposal held in the worker and releases it when it ends', async () => {
    const { e, args } = await proposal()
    const pending = call('edit_text', args)
    const review = await nextReview()
    const { id, version } = review.report.proposal!
    expect(review.report.previews).toEqual([])
    await expect(e.call('agent-text.renderProposal', id, version, 0, { scale: 1 })).resolves.toMatchObject({ width: 612 })
    await review.decide([0], true)
    expect((await pending).data).toMatchObject({ applied: true, acceptedEdits: [1], rejectedEdits: [] })
    await expect(e.call('agent-text.renderProposal', id, version, 0, { scale: 1 })).rejects.toMatchObject({ code: 'STALE_PROPOSAL' })
  })
  it('reflow: a rejected paragraph keeps its original wording and the result lists the items', async () => {
    const e = await openFixture('text.pdf')
    modelFor(e, 'CV.pdf')
    const snap = (await call('get_editable_text', { page: 1 })).data
    const hello = snap.blocks.find((b: any) => b.text.startsWith('Hello'))
    const lorem = snap.blocks.find((b: any) => b.text.startsWith('Lorem'))
    const pending = call('reflow_text', {
      revision: snap.revision,
      regions: [{ page: 1, rect: [72, 112, 280, 280] }, { page: 1, rect: [300, 112, 520, 280] }],
      paragraphs: [
        { page: 1, block_id: hello.block_id, original_text: hello.text, text: 'A rewritten opening.' },
        { page: 1, block_id: lorem.block_id, original_text: lorem.text, text: 'A short closing paragraph.' }
      ]
    })
    const review = await nextReview()
    expect(review.mode).toBe('flow')
    expect(review.original.changes.map((c) => c.label)).toEqual(['Paragraph 1', 'Paragraph 2'])
    await review.decide([0], false)
    await review.decide([1], true)
    const result = (await pending).data
    expect(result.acceptedItems).toEqual([{ item: 2, label: 'Paragraph 2' }])
    expect(result.rejectedItems).toEqual([{ item: 1, label: 'Paragraph 1' }])
    expect(result.undoLabel).toBe('Agent: Reflow Text')
    const text = (await e.call('edit-text.text', 0)) as string
    // Still flowed (so wrapped at the column width), in its original words.
    expect(text.replace(/\s+/g, ' ')).toContain(hello.text.replace(/\s+/g, ' '))
    expect(text).toContain('A short closing paragraph.')
    expect(text).not.toContain('A rewritten opening')
  })
  it('rebuild: rejecting every section declines the new design', async () => {
    const e = await openFixture('text.pdf')
    modelFor(e, 'CV.pdf')
    const snap = (await call('get_editable_text', { page: 1 })).data
    const pending = call('rebuild_document', {
      revision: snap.revision, title: 'Darren Wong',
      sections: [{ heading: 'Summary', paragraphs: ['Analyst.'] }, { heading: 'Skills', bullets: ['SQL'] }]
    })
    const review = await nextReview()
    expect(review.decisions).toEqual(['accepted', 'pending', 'pending', 'accepted'])
    await review.decide([1, 2], false)
    expect((await errorOf(pending)).code).toBe('declined')
    expect(await e.call('edit-text.text', 0)).toContain('quick brown fox')
  })
  it('cancellation during review closes the proposal without changing text', async () => {
    const { e, args } = await proposal()
    const abort = new AbortController()
    const ctx = { ...ctxFor(), signal: abort.signal }
    const pending = call('edit_text', args, ctx)
    await nextReview()
    abort.abort()
    expect((await errorOf(pending)).code).toBe('aborted')
    expect(useApp.getState().dialogs).toHaveLength(0)
    expect(await e.call('edit-text.text', 0)).toContain('quick brown fox')
  })
})
