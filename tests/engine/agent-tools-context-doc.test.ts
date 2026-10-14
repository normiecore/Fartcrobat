// Agent access: the read-only tools and show_in_app, run against real documents (the in-process
// engine behind a DocumentModel, as in the app but without a DOM).
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type { ChangeSet } from '@shared/types'
import type { AgentCallRequest } from '@shared/agent/bridge'
import type { DocumentModel as DocumentModelType, ViewController } from '@renderer/document/DocumentModel'
import { openFixture, type OpenedEngine } from './helpers'

let DocumentModel: typeof import('@renderer/document/DocumentModel').DocumentModel
let useApp: typeof import('@renderer/app/store').useApp
let context: typeof import('@features/agent-access/tools/context')
let view: typeof import('@features/agent-access/tools/view')
let common: typeof import('@features/agent-access/tools/common')
let ui: typeof import('@features/agent-access/ui/store')

beforeAll(async () => {
  vi.stubGlobal('window', {})
  await import('@renderer/app/registry')
  ;({ DocumentModel } = await import('@renderer/document/DocumentModel'))
  ;({ useApp } = await import('@renderer/app/store'))
  context = await import('@features/agent-access/tools/context')
  view = await import('@features/agent-access/tools/view')
  common = await import('@features/agent-access/tools/common')
  ui = await import('@features/agent-access/ui/store')
  // The main process, after the modules read the (missing) preload bridge at load time.
  ;(window as any).api = { invoke: async (channel: string) => void invoked.push(channel), on: () => () => {} }
})

const invoked: string[] = []

beforeEach(() => {
  for (const d of useApp.getState().docs) d.close()
  useApp.setState({ docs: [], activeDocId: null, toolGroupId: null, toolId: 'select' })
})

/** A DocumentModel driven by the in-process engine, with a view that records what it was asked. */
function modelFor(e: OpenedEngine, title: string, filePath: string | null = null) {
  const listeners = new Set<(cs: ChangeSet) => void>()
  const client = {
    ops: (ns: string) =>
      new Proxy({}, { get: (_t, name) => async (...args: unknown[]) => e.call(`${ns}.${String(name)}`, ...args) }),
    onChanges: (l: (cs: ChangeSet) => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    runAs: <T>(_actor: string, fn: () => Promise<T>) => fn(),
    terminate() {}
  }
  const doc = new DocumentModel(client as any, e.info, { title, filePath })
  const seen: { scrolled: { page: number; rect: number[] }[]; pages: number[] } = { scrolled: [], pages: [] }
  doc.view = {
    scrollToRect: (page: number, rect: number[]) => void seen.scrolled.push({ page, rect }),
    goToPage: (page: number) => void seen.pages.push(page),
    visiblePages: () => [doc.state.currentPage, doc.state.currentPage + 1]
  } as unknown as ViewController
  return { doc, seen }
}

function open(...docs: DocumentModelType[]) {
  useApp.setState({ docs, activeDocId: docs[0]?.id ?? null })
}

function ctxFor(audit: Record<string, unknown> = {}, progress: number[][] = []) {
  const request: AgentCallRequest = { id: '1:1', connectionId: 1, client: { name: 'claude-ai', version: '1' }, windowId: 'w1', currentWindow: true, tool: 'x', args: {} }
  return {
    request,
    signal: new AbortController().signal,
    progress: (p: number, total?: number) => void progress.push([p, total ?? -1]),
    audit: (d: Record<string, unknown>) => void Object.assign(audit, d)
  }
}

async function call(tool: string, args: Record<string, unknown> = {}, ctx = ctxFor()) {
  const handler = context.handlers[tool as keyof typeof context.handlers] ?? view.handlers[tool as keyof typeof view.handlers]
  return handler!(args, ctx as any)
}

async function expectToolError(p: Promise<unknown>, code: string) {
  const err = await p.then(
    () => null,
    (e) => e
  )
  expect(err).toBeInstanceOf(common.ToolError)
  expect(err.code).toBe(code)
}

describe('list_documents and get_context', () => {
  it('lists this window\'s documents with handles and the one being looked at', async () => {
    const a = modelFor(await openFixture('text.pdf'), 'text.pdf', '/docs/text.pdf')
    const b = modelFor(await openFixture('form.pdf'), 'form.pdf')
    open(a.doc, b.doc)
    useApp.setState({ activeDocId: b.doc.id })
    const { data } = (await call('list_documents')) as { data: { documents: any[] } }
    expect(data.documents).toEqual([
      { handle: `w1-${a.doc.id}`, title: 'text.pdf', path: '/docs/text.pdf', pageCount: 5, currentPage: 1, active: false, unsavedChanges: false, encrypted: false },
      { handle: `w1-${b.doc.id}`, title: 'form.pdf', path: null, pageCount: 1, currentPage: 1, active: true, unsavedChanges: false, encrypted: false }
    ])
  })

  it('reports no document on Home and stale handles', async () => {
    await expectToolError(call('get_context'), 'no_document')
    const a = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(a.doc)
    await expectToolError(call('get_context', { handle: 'w2-' + a.doc.id }), 'stale_handle')
    await expectToolError(call('get_context', { handle: 'w1-doc-99999' }), 'stale_handle')
    await expectToolError(call('get_context', { handle: 'nonsense' }), 'stale_handle')
  })

  it('describes the page, the selected text with its rects and the search', async () => {
    const { doc } = modelFor(await openFixture('text.pdf'), 'text.pdf', '/docs/text.pdf')
    open(doc)
    doc.set({ currentPage: 1, zoom: 1.25 })
    const t = await doc.pageText(1)
    const start = t.text.indexOf('quick brown fox')
    doc.setSelection({ kind: 'text', ranges: [{ page: 1, start, end: start + 'quick brown fox'.length }] })
    await doc.search('lazy dog')
    const audit: Record<string, unknown> = {}
    const { data } = (await call('get_context', {}, ctxFor(audit))) as { data: any }
    expect(audit.document).toBe('/docs/text.pdf')
    expect(data).toMatchObject({
      lookingAtThisDocument: true,
      currentPage: 2,
      visiblePages: [2, 3],
      zoomPercent: 125,
      unsavedChanges: false,
      lastChange: null,
      typing: false,
      search: { query: 'lazy dog', hits: 5 }
    })
    expect(data.selection.kind).toBe('text')
    expect(data.selection.text).toBe('quick brown fox')
    expect(data.selection.pages).toHaveLength(1)
    expect(data.selection.pages[0].page).toBe(2)
    expect(data.selection.pages[0].rects).toHaveLength(1)
  })

  it('describes selected comments', async () => {
    const e = await openFixture('text.pdf')
    const { doc } = modelFor(e, 'text.pdf')
    open(doc)
    const note = await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', rect: [10, 10, 30, 30], contents: 'A note' })
    doc.setSelection({ kind: 'annotations', page: 0, ids: [note.id] })
    const { data } = (await call('get_context')) as { data: any }
    expect(data.selection).toEqual({ kind: 'comments', page: 1, comments: [{ id: note.id, type: 'Text', text: 'A note' }] })
  })
})

describe('get_document_info', () => {
  it('gives metadata, pages and bookmarks', async () => {
    const { doc } = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(doc)
    const { data } = (await call('get_document_info')) as { data: any }
    expect(data.metadata).toMatchObject({ title: 'Fixture Text Document', author: 'Fartcrobat Tests', subject: 'Plain text pages' })
    expect(data.pageCount).toBe(5)
    expect(data.pages).toHaveLength(5)
    expect(data.pages[0]).toEqual({ page: 1, width: 612, height: 792 })
    expect(data.outline.map((o: any) => [o.title, o.page])).toEqual([
      ['Chapter 1', 1],
      ['Chapter 2', 2],
      ['Chapter 3', 3],
      ['Chapter 4', 4],
      ['Chapter 5', 5]
    ])
    expect(data.security).toEqual({ encryption: null })
    expect(data.form).toEqual({ hasForm: false })
    const brief = (await call('get_document_info', { include_outline: false, include_pages: false })) as { data: any }
    expect(brief.data.outline).toBeUndefined()
    expect(brief.data.pages).toBeUndefined()
    expect(brief.data.pageSizes).toEqual([{ width: 612, height: 792, count: 5, firstPage: 1 }])
    await expectToolError(call('get_document_info', { include_pages: 'yes' }), 'invalid_args')
  })

  it('counts form fields and reports encryption with permissions', async () => {
    const form = modelFor(await openFixture('form.pdf'), 'form.pdf')
    const enc = modelFor(await openFixture('encrypted.pdf', 'secret'), 'encrypted.pdf')
    open(form.doc, enc.doc)
    const f = (await call('get_document_info', { handle: `w1-${form.doc.id}` })) as { data: any }
    expect(f.data.form).toEqual({ hasForm: true, fieldCount: 8 })
    const e = (await call('get_document_info', { handle: `w1-${enc.doc.id}` })) as { data: any }
    expect(e.data.encrypted).toBe(true)
    expect(e.data.security.encryption).toBeTruthy()
    expect(e.data.security.permissions.print).toBe(true)
  })
})

describe('get_page_text', () => {
  it('gives the text of the pages asked for', async () => {
    const { doc } = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(doc)
    const { data } = (await call('get_page_text', { pages: '2,4' })) as { data: any }
    expect(data.pages.map((p: any) => p.page)).toEqual([2, 4])
    expect(data.pages[0].text).toContain('Hello Fartcrobat page 2.')
    expect(data.pages[1].text).toContain('Invoice #1003')
    expect(data.truncated).toBeUndefined()
  })

  it('stops at max_chars and says where to continue', async () => {
    const { doc } = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(doc)
    const { data } = (await call('get_page_text', { max_chars: 1000 })) as { data: any }
    expect(data.truncated).toBe(true)
    const total = data.pages.reduce((n: number, p: any) => n + p.text.length, 0)
    expect(total).toBeLessThanOrEqual(1000)
    const last = data.pages.at(-1)
    expect(last.truncated).toBe(true)
    expect(data.nextPage).toBe(last.page)
    expect(data.note).toContain(`"${data.nextPage}-5"`)
    await expectToolError(call('get_page_text', { max_chars: 10 }), 'invalid_args')
    await expectToolError(call('get_page_text', { pages: '9' }), 'invalid_args')
  })

  it('gives lines with rects, and points out pages without text', async () => {
    const text = modelFor(await openFixture('text.pdf'), 'text.pdf')
    const scan = modelFor(await openFixture('scanned.pdf'), 'scanned.pdf')
    open(text.doc, scan.doc)
    const { data } = (await call('get_page_text', { pages: '1', include_lines: true })) as { data: any }
    const lines = data.pages[0].lines
    expect(lines[0]).toEqual({ text: 'Chapter 1', rect: expect.any(Array) })
    expect(lines.find((l: any) => l.text.startsWith('Hello Fartcrobat page 1')).rect[0]).toBeCloseTo(72, 0)
    const s = (await call('get_page_text', { handle: `w1-${scan.doc.id}` })) as { data: any }
    expect(s.data.pagesWithoutText).toEqual([1])
    expect(s.data.hint).toMatch(/recognize_text/)
  })
})

describe('render_page', () => {
  it('returns a PNG of the page at the asked resolution', async () => {
    const { doc } = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(doc)
    const out = (await call('render_page', { page: 1, dpi: 36 })) as { data: any; images: { data: string; mimeType: string }[] }
    expect(out.images).toHaveLength(1)
    expect(out.images[0].mimeType).toBe('image/png')
    const png = Buffer.from(out.images[0].data, 'base64')
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    // IHDR: width and height
    expect(png.readUInt32BE(16)).toBe(306)
    expect(png.readUInt32BE(20)).toBe(396)
    expect(out.data).toMatchObject({ page: 1, width: 306, height: 396, dpi: 36, region: [0, 0, 612, 792], pageSize: [612, 792] })
  })

  it('checks its arguments', async () => {
    const { doc } = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(doc)
    await expectToolError(call('render_page', {}), 'invalid_args')
    await expectToolError(call('render_page', { page: 6 }), 'invalid_args')
    await expectToolError(call('render_page', { page: 1, dpi: 1000 }), 'invalid_args')
    await expectToolError(call('render_page', { page: 1, region: [700, 0, 800, 50] }), 'invalid_args')
    await expectToolError(call('render_page', { page: 1, region: [0, 0, 10] }), 'invalid_args')
  })
})

describe('find_text', () => {
  it('finds words with context and rects on every page', async () => {
    const { doc } = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(doc)
    const { data } = (await call('find_text', { query: 'LAZY DOG' })) as { data: any }
    expect(data.count).toBe(5)
    expect(data.hits.map((h: any) => h.page)).toEqual([1, 2, 3, 4, 5])
    expect(data.hits[0].text).toBe('lazy dog')
    expect(data.hits[0].context).toContain('jumps over the lazy dog.')
    expect(data.hits[0].rects).toHaveLength(1)
    const cased = (await call('find_text', { query: 'LAZY DOG', match_case: true })) as { data: any }
    expect(cased.data.count).toBe(0)
    const whole = (await call('find_text', { query: 'laz', whole_words: true })) as { data: any }
    expect(whole.data.count).toBe(0)
  })

  it('finds built-in patterns and stops at max_results', async () => {
    const { doc } = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(doc)
    const ssn = (await call('find_text', { pattern: 'ssn', pages: '2-3' })) as { data: any }
    expect(ssn.data.hits.map((h: any) => [h.page, h.text])).toEqual([
      [2, '123-45-6781'],
      [3, '123-45-6782']
    ])
    const limited = (await call('find_text', { pattern: 'email', max_results: 3 })) as { data: any }
    expect(limited.data.count).toBe(3)
    expect(limited.data.truncated).toBe(true)
    expect(limited.data.nextPage).toBe(4)
  })

  it('needs exactly one of query and pattern', async () => {
    const { doc } = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(doc)
    await expectToolError(call('find_text', {}), 'invalid_args')
    await expectToolError(call('find_text', { query: 'a', pattern: 'ssn' }), 'invalid_args')
    await expectToolError(call('find_text', { pattern: 'iban' }), 'invalid_args')
    await expectToolError(call('find_text', { query: '  ' }), 'invalid_args')
  })
})

describe('list_annotations, list_form_fields, list_signatures', () => {
  it('lists comments with the text they mark and their replies', async () => {
    const e = await openFixture('text.pdf')
    const { doc } = modelFor(e, 'text.pdf')
    open(doc)
    const t = await doc.pageText(0)
    const start = t.text.indexOf('quick brown fox')
    const { rangeQuads } = await import('@renderer/document/textModel')
    const ops = e.ops<typeof annotOps>('annots')
    const hl = await ops.create(0, { type: 'Highlight', quads: rangeQuads(t, start, start + 15), color: '#ffff00' })
    await ops.create(0, { type: 'Text', rect: [0, 0, 20, 20], contents: 'Agreed', inReplyTo: hl.id, author: 'Bob' })
    await ops.create(2, { type: 'Square', rect: [10, 10, 50, 50] })
    const all = (await call('list_annotations')) as { data: any }
    expect(all.data.count).toBe(2)
    expect(all.data.annotations[0]).toMatchObject({ id: hl.id, page: 1, type: 'Highlight', markedText: 'quick brown fox', replies: [{ text: 'Agreed', author: 'Bob' }] })
    const squares = (await call('list_annotations', { types: ['Square'] })) as { data: any }
    expect(squares.data.annotations.map((a: any) => a.page)).toEqual([3])
    const page2 = (await call('list_annotations', { pages: '2' })) as { data: any }
    expect(page2.data.count).toBe(0)
    await expectToolError(call('list_annotations', { types: 'Square' }), 'invalid_args')
  })

  it('lists form fields, also by page', async () => {
    const form = modelFor(await openFixture('form.pdf'), 'form.pdf')
    const text = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(form.doc, text.doc)
    const { data } = (await call('list_form_fields')) as { data: any }
    expect(data.count).toBe(8)
    expect(data.fields.find((f: any) => f.name === 'country').value).toBe('Canada')
    const none = (await call('list_form_fields', { handle: `w1-${text.doc.id}` })) as { data: any }
    expect(none.data).toMatchObject({ count: 0, fields: [] })
  })

  it('validates signatures like the Signatures panel', async () => {
    const signed = modelFor(await openFixture('forms-fill/signed.pdf'), 'signed.pdf')
    const text = modelFor(await openFixture('text.pdf'), 'text.pdf')
    open(signed.doc, text.doc)
    const { data } = (await call('list_signatures')) as { data: any }
    expect(data.signatures.length).toBeGreaterThan(0)
    const s = data.signatures[0]
    expect(typeof s.field).toBe('string')
    expect(typeof s.signer).toBe('string')
    expect(['valid', 'unknown-identity', 'warning', 'unknown', 'invalid']).toContain(s.status)
    expect(s.summary).toBeTruthy()
    const none = (await call('list_signatures', { handle: `w1-${text.doc.id}` })) as { data: any }
    expect(none.data).toEqual({ signatures: [], unsignedFields: [] })
  })
})

describe('show_in_app', () => {
  it('brings the document to the front, scrolls to the region and outlines it', async () => {
    const a = modelFor(await openFixture('text.pdf'), 'text.pdf')
    const b = modelFor(await openFixture('text.pdf'), 'other.pdf')
    open(a.doc, b.doc)
    const { data } = (await call('show_in_app', { handle: `w1-${b.doc.id}`, page: 3, rect: [100, 200, 50, 150] })) as { data: any }
    expect(useApp.getState().activeDocId).toBe(b.doc.id)
    expect(invoked).toContain('feature:agent-access:attention')
    expect(b.seen.scrolled).toEqual([{ page: 2, rect: [50, 150, 100, 200] }])
    expect(ui.useFlash.getState().flash).toMatchObject({ docId: b.doc.id, page: 2, rect: [50, 150, 100, 200] })
    expect(data).toEqual({ page: 3, rect: [50, 150, 100, 200] })
    await call('show_in_app', { handle: `w1-${a.doc.id}`, page: 5 })
    expect(a.seen.pages).toEqual([4])
  })

  it('selects comments by id and scrolls to them', async () => {
    const e = await openFixture('text.pdf')
    const { doc, seen } = modelFor(e, 'text.pdf')
    open(doc)
    const ops = e.ops<typeof annotOps>('annots')
    const one = await ops.create(1, { type: 'Square', rect: [10, 10, 50, 50] })
    const two = await ops.create(3, { type: 'Square', rect: [10, 10, 50, 50] })
    const single = (await call('show_in_app', { annotation_ids: [one.id] })) as { data: any }
    expect(doc.state.selection).toEqual({ kind: 'annotations', page: 1, ids: [one.id] })
    expect(seen.scrolled.at(-1)?.page).toBe(1)
    expect(single.data).toMatchObject({ page: 2, selected: [one.id] })
    const both = (await call('show_in_app', { annotation_ids: [one.id, two.id] })) as { data: any }
    expect(both.data).toMatchObject({ selected: [one.id], notSelected: [two.id] })
    await expectToolError(call('show_in_app', { annotation_ids: [987654] }), 'invalid_args')
    await expectToolError(call('show_in_app', { rect: [0, 0, 10, 10] }), 'invalid_args')
    await expectToolError(call('show_in_app', { annotation_ids: ['1'] }), 'invalid_args')
  })
})
