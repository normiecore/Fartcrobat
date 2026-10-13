// Agent access: shaping of the read-only tools' output (tools/contextShape.ts) and the window's
// activity store (ui/store.ts). Pure functions, no app state.
import { describe, expect, it } from 'vitest'
import type annotOps from '@engine/ops/annots'
import type { AnnotInfo } from '@engine/ops/annots'
import type formOps from '@engine/ops/forms'
import type textOps from '@engine/ops/text'
import type { PageText } from '@engine/ops/text'
import type { AgentConnectionInfo } from '@shared/agent/bridge'
import type { PageInfo } from '@shared/types'
import { searchPage } from '@renderer/document/textModel'
import {
  annotationsOut,
  fieldsOut,
  hitOut,
  isEmptyPage,
  outlineOut,
  pageSizes,
  pagesOut,
  pageTextOut,
  rangeText,
  renderPlan,
  signaturesOut,
  TextBudget,
  toBase64
} from '@features/agent-access/tools/contextShape'
import {
  appLabel,
  callFinished,
  callStarted,
  connectedLabel,
  documentLabel,
  durationLabel,
  MAX_CALLS,
  useAgentUi
} from '@features/agent-access/ui/store'
import type { SignatureReport, ValidationReport } from '@features/digital-signatures/types'
import { openFixture } from './helpers'

function textPage(pageIndex: number, lines: string[]): PageText {
  const text = lines.map((l) => l + '\n').join('')
  let start = 0
  const out: PageText['lines'] = lines.map((l, i) => {
    const line = { start, end: start + l.length, bbox: [72, 100 + i * 20, 72 + l.length * 6, 112 + i * 20] as [number, number, number, number], wmode: 0, dir: [1, 0] as [number, number], block: 0 }
    start += l.length + 1
    return line
  })
  return { pageIndex, text, quads: new Float32Array(text.length * 8), lines: out, spans: [], blocks: [], images: [] }
}

describe('get_page_text output', () => {
  it('gives the text of a page, or its lines with rects', () => {
    const t = textPage(2, ['Hello there', '', 'Second line'])
    expect(pageTextOut(t, false)).toEqual({ page: 3, text: 'Hello there\n\nSecond line' })
    expect(pageTextOut(t, true)).toEqual({
      page: 3,
      lines: [
        { text: 'Hello there', rect: [72, 100, 138, 112] },
        { text: 'Second line', rect: [72, 140, 138, 152] }
      ]
    })
    expect(isEmptyPage(pageTextOut(textPage(0, []), false))).toBe(true)
    expect(isEmptyPage(pageTextOut(textPage(0, ['  ']), true))).toBe(true)
    expect(isEmptyPage(pageTextOut(t, true))).toBe(false)
  })

  it('stops at max_chars, cutting the page that does not fit at a line break', () => {
    const page = (n: number, text: string) => ({ page: n, text })
    const b = new TextBudget(25)
    expect(b.add(page(1, 'a'.repeat(10)))).toBe(true)
    expect(b.add(page(2, ''))).toBe(true)
    expect(b.add(page(3, 'b'.repeat(8) + '\n' + 'c'.repeat(20)))).toBe(false)
    expect(b.full).toBe(true)
    expect(b.nextPage).toBe(3)
    expect(b.pages).toEqual([page(1, 'a'.repeat(10)), page(2, ''), { page: 3, text: 'b'.repeat(8), truncated: true }])
    // nothing more once full
    expect(b.add(page(4, 'd'))).toBe(false)
    expect(b.pages).toHaveLength(3)
  })

  it('cuts a page without line breaks at the limit, never inside a character outside the BMP', () => {
    const b = new TextBudget(5)
    b.add({ page: 1, text: 'abcd😀efg' })
    expect(b.pages).toEqual([{ page: 1, text: 'abcd', truncated: true }])
    expect(b.nextPage).toBe(1)
  })

  it('counts and cuts lines when lines are asked for', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `line ${i}`, rect: [0, i, 10, i + 1] }))
    const b = new TextBudget(20)
    expect(b.add({ page: 1, lines: lines(1) })).toBe(true)
    expect(b.add({ page: 2, lines: lines(4) })).toBe(false)
    expect(b.pages[1]).toEqual({ page: 2, lines: lines(2), truncated: true })
    expect(b.nextPage).toBe(2)
  })

  it('stops exactly at a page boundary without an empty cut page', () => {
    const b = new TextBudget(10)
    expect(b.add({ page: 1, text: 'x'.repeat(10) })).toBe(true)
    expect(b.add({ page: 2, text: 'y' })).toBe(false)
    expect(b.pages).toEqual([{ page: 1, text: 'x'.repeat(10) }])
    expect(b.nextPage).toBe(2)
  })

  it('names the pages left as a range', () => {
    expect(rangeText([4, 5, 6, 9, 11, 12])).toBe('5-7,10,12-13')
    expect(rangeText([0])).toBe('1')
    expect(rangeText([])).toBe('')
  })
})

describe('find_text hits', () => {
  it('gives page, text, about 40 characters of context and rects', async () => {
    const e = await openFixture('text.pdf')
    const t = await e.ops<typeof textOps>('text').page(1)
    const [hit] = searchPage(t, 'quick brown fox')
    const out = hitOut(t, hit)
    expect(out.page).toBe(2)
    expect(out.text).toBe('quick brown fox')
    expect(out.context).toContain('Hello Fartcrobat page 2. The quick brown fox jumps over the lazy dog.')
    expect(out.context.length).toBeLessThanOrEqual(out.text.length + 80)
    expect(out.rects).toHaveLength(1)
    const [x0, y0, x1, y1] = out.rects[0]
    expect(x0).toBeGreaterThan(72)
    expect(x1).toBeGreaterThan(x0)
    expect(y1).toBeGreaterThan(y0)
    // US Letter, y down: the baseline of the line is 132 pt from the top
    expect(y0).toBeGreaterThan(115)
    expect(y0).toBeLessThan(132)
    expect(y1).toBeGreaterThan(132)
    expect(y1).toBeLessThan(140)
    for (const v of out.rects[0]) expect(Math.round(v * 100) / 100).toBe(v)
  })
})

describe('render_page plan', () => {
  it('renders the whole page at the asked resolution', () => {
    const p = renderPlan([612, 792], 72, null)!
    expect(p).toMatchObject({ scale: 1, dpi: 72, clip: null, width: 612, height: 792, scaledDown: false, region: [0, 0, 612, 792] })
    const q = renderPlan([612, 792], 144, null)!
    expect(q).toMatchObject({ scale: 2, dpi: 144, width: 1224, height: 1584, scaledDown: false })
  })

  it('lowers the resolution to keep each side at most 2000 pixels', () => {
    const p = renderPlan([612, 792], 200, null)!
    expect(p.scaledDown).toBe(true)
    expect(p.height).toBe(2000)
    expect(p.width).toBeLessThanOrEqual(2000)
    expect(p.dpi).toBeCloseTo((2000 / 792) * 72, 1)
    // a long, thin page is limited by its long side
    const strip = renderPlan([200, 5000], 96, null)!
    expect(strip.height).toBe(2000)
    expect(strip.width).toBe(80)
  })

  it('crops to a region, clamped to the page, in device pixels', () => {
    const p = renderPlan([612, 792], 144, [-10, 100, 300, 200])!
    expect(p.region).toEqual([0, 100, 300, 200])
    expect(p.clip).toEqual([0, 200, 600, 400])
    expect(p.width).toBe(600)
    expect(p.height).toBe(200)
    // a small region at a high resolution is not limited
    expect(renderPlan([612, 792], 200, [0, 0, 50, 50])!.scaledDown).toBe(false)
  })

  it('refuses a region outside the page', () => {
    expect(renderPlan([612, 792], 96, [700, 0, 800, 100])).toBeNull()
    expect(renderPlan([612, 792], 96, [0, 800, 100, 900])).toBeNull()
    expect(renderPlan([612, 792], 96, [10, 10, 10.2, 50])).toBeNull()
  })

  it('encodes bytes as base64, also large ones', () => {
    expect(toBase64(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('iVBORw==')
    const big = new Uint8Array(100_000).map((_, i) => i % 251)
    expect(Buffer.from(toBase64(big), 'base64').equals(Buffer.from(big))).toBe(true)
  })
})

describe('get_document_info output', () => {
  const page = (i: number, width: number, height: number, extra: Partial<PageInfo> = {}): PageInfo => ({
    index: i,
    id: i + 10,
    width,
    height,
    rotation: 0,
    label: String(i + 1),
    mediaBox: [0, 0, width, height],
    cropBox: [0, 0, width, height],
    ...extra
  })

  it('lists pages with labels and rotation only when they say something', () => {
    const pages = [page(0, 612, 792, { label: 'i' }), page(1, 612.004, 792), page(2, 792, 612, { rotation: 90 })]
    expect(pagesOut(pages)).toEqual([
      { page: 1, width: 612, height: 792, label: 'i' },
      { page: 2, width: 612, height: 792 },
      { page: 3, width: 792, height: 612, rotation: 90 }
    ])
    expect(pageSizes(pages)).toEqual([
      { width: 612, height: 792, count: 2, firstPage: 1 },
      { width: 792, height: 612, count: 1, firstPage: 3 }
    ])
  })

  it('gives bookmarks with 1-based pages and stops at the limit', () => {
    const dest = (page: number) => ({ page, x: null, y: null, zoom: null, type: 'Fit' })
    const nodes = [
      { title: 'One', uri: '#page=1', open: true, dest: dest(0), children: [{ title: 'One.a', uri: null, open: false, dest: dest(1), children: [] }] },
      { title: 'Site', uri: 'https://example.com', open: false, dest: null, children: [] },
      { title: 'Three', uri: null, open: false, dest: dest(4), children: [] }
    ]
    expect(outlineOut(nodes)).toEqual({
      outline: [{ title: 'One', page: 1, children: [{ title: 'One.a', page: 2 }] }, { title: 'Site', uri: 'https://example.com' }, { title: 'Three', page: 5 }],
      truncated: false
    })
    expect(outlineOut(nodes, 2)).toEqual({ outline: [{ title: 'One', page: 1, children: [{ title: 'One.a', page: 2 }] }], truncated: true })
  })
})

describe('list_annotations output', () => {
  const annot = (id: number, patch: Partial<AnnotInfo>): AnnotInfo =>
    ({
      id,
      page: 0,
      type: 'Text',
      rect: [10.123, 20, 30, 40],
      color: '#ffd400',
      interiorColor: null,
      contents: '',
      author: '',
      subject: '',
      created: '',
      modified: '',
      quads: [],
      inReplyTo: null,
      state: null,
      stateModel: null,
      intent: null,
      cloudy: false,
      lineEndings: null,
      textColor: null,
      hidden: false,
      locked: false,
      extra: {},
      ...patch
    }) as AnnotInfo

  it('folds replies and status changes into their comment and leaves out links, widgets and pop-ups', () => {
    const list = [
      annot(1, { contents: 'Check this', author: 'Ann', created: '2024-03-01T10:00:00.000Z' }),
      annot(2, { inReplyTo: 1, contents: 'Done', author: 'Bob', created: '2024-03-02T10:00:00.000Z' }),
      annot(3, { inReplyTo: 1, state: 'Accepted', stateModel: 'Review', author: 'Bob', created: '2024-03-03T10:00:00.000Z' }),
      annot(4, { type: 'Highlight', page: 1, color: '#00ff00', created: '1970-01-01T00:00:00.000Z' }),
      annot(5, { type: 'Popup', inReplyTo: 1 }),
      annot(6, { type: 'Link' }),
      annot(7, { type: 'Widget' })
    ]
    const out = annotationsOut(list, { marked: new Map([[4, 'the marked words']]) })
    expect(out).toEqual([
      {
        id: 1,
        page: 1,
        type: 'Text',
        label: 'Sticky Note',
        rect: [10.12, 20, 30, 40],
        text: 'Check this',
        author: 'Ann',
        color: '#ffd400',
        created: '2024-03-01T10:00:00.000Z',
        status: 'Accepted',
        statusBy: 'Bob',
        replies: [{ id: 2, text: 'Done', author: 'Bob', created: '2024-03-02T10:00:00.000Z' }]
      },
      { id: 4, page: 2, type: 'Highlight', label: 'Highlight', rect: [10.12, 20, 30, 40], markedText: 'the marked words', color: '#00ff00' }
    ])
  })

  it('filters by PDF type or Acrobat label, case-insensitively', () => {
    const list = [annot(1, {}), annot(2, { type: 'Square' }), annot(3, { type: 'Redact', hidden: true, locked: true })]
    expect(annotationsOut(list, { types: ['square'] }).map((a) => a.id)).toEqual([2])
    expect(annotationsOut(list, { types: ['Sticky Note', 'Redact'] }).map((a) => a.id)).toEqual([1, 3])
    expect(annotationsOut(list, { types: ['Redact'] })[0]).toMatchObject({ hidden: true, locked: true, label: 'Redaction' })
    expect(annotationsOut(list, { types: [] })).toHaveLength(3)
  })

  it('reads comments made through the engine', async () => {
    const e = await openFixture('text.pdf')
    const ops = e.ops<typeof annotOps>('annots')
    const note = await ops.create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'Is this right?', author: 'Ann' })
    await ops.create(0, { type: 'Text', rect: [100, 100, 120, 120], contents: 'Yes', author: 'Bob', inReplyTo: note.id })
    await ops.create(1, { type: 'Square', rect: [50, 50, 150, 100], color: '#ff0000' })
    const all = [...(await ops.list(0)), ...(await ops.list(1))]
    const out = annotationsOut(all)
    expect(out.map((a) => [a.page, a.type, a.text ?? null])).toEqual([
      [1, 'Text', 'Is this right?'],
      [2, 'Square', null]
    ])
    expect(out[0].replies).toEqual([expect.objectContaining({ text: 'Yes', author: 'Bob' })])
    expect(out[1]).toMatchObject({ label: 'Rectangle', color: '#ff0000', rect: [50, 50, 150, 100] })
  })
})

describe('list_form_fields output', () => {
  it('gives one entry per field with values, options and radio buttons', async () => {
    const e = await openFixture('form.pdf')
    const fields = fieldsOut(await e.ops<typeof formOps>('forms').listAll())
    const byName = Object.fromEntries(fields.map((f) => [f.name, f]))
    expect(Object.keys(byName).sort()).toEqual(['country', 'email', 'fullName', 'notes', 'plan', 'price', 'qty', 'subscribe'])
    expect(byName.fullName).toMatchObject({ type: 'text', value: '', page: 1, tooltip: 'Full name' })
    expect(byName.qty).toMatchObject({ type: 'text', value: '2' })
    expect(byName.notes).toMatchObject({ type: 'text', multiline: true })
    expect(byName.subscribe).toMatchObject({ type: 'checkbox', checked: false })
    expect(byName.subscribe.onValue).toBeTruthy()
    expect(byName.plan).toMatchObject({ type: 'radio', value: 'basic', options: [{ value: 'basic' }, { value: 'pro' }] })
    expect(byName.plan.widgets?.map((w) => w.onValue)).toEqual(['basic', 'pro'])
    expect(byName.country.type).toBe('combo')
    expect(byName.country.value).toBe('Canada')
    expect(byName.country.options?.map((o) => o.value)).toEqual(['Australia', 'Canada', 'Germany', 'Japan', 'United States'])
    // page space: y down, the name field is near the top of the page
    const [, y0, , y1] = byName.fullName.rect
    expect(y0).toBeGreaterThan(90)
    expect(y1).toBeLessThan(130)
  })

  it('keeps fields with a widget on the pages asked for, and hides password values', () => {
    const base = {
      id: 1,
      page: 0,
      name: 'a',
      type: 'text',
      rect: [0, 0, 10, 10],
      value: 'secret',
      checked: false,
      onState: null,
      options: [],
      tooltip: '',
      readOnly: false,
      required: true,
      password: true,
      multiline: false,
      maxLen: 4,
      multiSelect: false,
      editable: false,
      hidden: false,
      signed: false
    } as unknown as Parameters<typeof fieldsOut>[0][number]
    const fields = [base, { ...base, id: 2, name: 'b', page: 2, password: false, value: 'x' }]
    expect(fieldsOut(fields, new Set([2]))).toEqual([{ name: 'b', type: 'text', value: 'x', page: 3, rect: [0, 0, 10, 10], required: true, maxLength: 4 }])
    const [a] = fieldsOut(fields, new Set([0]))
    expect(a.value).toBeUndefined()
    expect(a.password).toBe(true)
  })
})

describe('list_signatures output', () => {
  it('describes signatures the way the Signatures panel does', () => {
    const r = {
      fieldName: 'Sig1',
      widgetId: 9,
      page: 0,
      rect: [10, 20, 110, 70],
      invisible: false,
      kind: 'approval',
      signerName: 'Jane Signer',
      reason: 'Approved',
      location: '',
      contactInfo: '',
      signingTime: '2024-05-01T12:00:00.000Z',
      timestamp: null,
      subFilter: 'ETSI.CAdES.detached',
      digestAlgorithm: 'SHA-256',
      signatureAlgorithm: 'RSA',
      revision: 1,
      revisionCount: 1,
      signedVersion: 1,
      byteRange: [],
      revisionEnd: 100,
      coversWholeFile: true,
      integrity: true,
      signatureValid: true,
      certificates: [
        {
          subject: 'CN=Jane Signer',
          subjectName: 'Jane Signer',
          issuer: 'CN=Jane Signer',
          email: '',
          organization: 'Acme',
          serial: '01',
          notBefore: '2024-01-01T00:00:00.000Z',
          notAfter: '2030-01-01T00:00:00.000Z',
          selfSigned: true,
          sha256: 'AB'
        }
      ],
      chainVerified: [true],
      chainComplete: true,
      certValidAtSigning: true,
      certExpiredNow: false,
      permission: null,
      lock: null,
      changes: [],
      changesUnknown: false,
      problems: [],
      warnings: [],
      unknownReason: null
    } as unknown as SignatureReport
    const report = {
      signatures: [r],
      unsigned: [{ name: 'Approver', widgetId: 3, page: 1, rect: [0, 0, 50, 20], invisible: false, signed: false, signerName: '', locked: false }],
      checkedFile: true,
      revisionCount: 1,
      certified: null,
      certifiedBy: null,
      locked: false,
      validatedAt: 1
    } as ValidationReport
    const unknown = signaturesOut(report, new Set())
    expect(unknown.signatures[0]).toMatchObject({
      field: 'Sig1',
      page: 1,
      rect: [10, 20, 110, 70],
      signer: 'Jane Signer',
      reason: 'Approved',
      status: 'unknown-identity',
      changedAfterSigning: false,
      identityTrusted: false,
      certificate: { subject: 'CN=Jane Signer', organization: 'Acme', selfSigned: true, sha256: 'AB' }
    })
    expect(unknown.signatures[0].summary).toMatch(/identity is unknown/)
    expect(unknown.unsignedFields).toEqual([{ name: 'Approver', page: 2, rect: [0, 0, 50, 20] }])
    expect(unknown.checkedSavedFile).toBe(true)
    const trusted = signaturesOut(report, new Set(['AB']))
    expect(trusted.signatures[0]).toMatchObject({ status: 'valid', identityTrusted: true })
  })
})

describe('activity panel state', () => {
  it('names AI apps and their connection', () => {
    const conn = (id: number, name: string): AgentConnectionInfo => ({ id, client: { name, version: '1.0' }, since: 0, running: 0 })
    expect(appLabel('claude-ai')).toBe('Claude')
    expect(appLabel('Claude Code')).toBe('Claude')
    expect(appLabel('cursor')).toBe('cursor')
    expect(appLabel('')).toBe('AI app')
    expect(appLabel(undefined)).toBe('AI app')
    expect(connectedLabel([conn(1, 'claude-ai')])).toBe('Claude connected')
    expect(connectedLabel([conn(1, 'claude-ai'), conn(2, 'Claude Desktop')])).toBe('Claude connected')
    expect(connectedLabel([conn(1, 'claude-ai'), conn(2, 'other')])).toBe('2 AI apps connected')
  })

  it('names documents and durations briefly', () => {
    expect(documentLabel('C:\\Users\\me\\Report.pdf')).toBe('Report.pdf')
    expect(documentLabel('/home/me/a b.pdf')).toBe('a b.pdf')
    expect(documentLabel('untitled: Combined.pdf')).toBe('Combined.pdf')
    expect(documentLabel(undefined)).toBe('')
    expect(durationLabel(42.4)).toBe('42 ms')
    expect(durationLabel(3400)).toBe('3.4 s')
    expect(durationLabel(125000)).toBe('2 min')
  })

  it('keeps the newest calls first, at most 200, and counts the running ones', () => {
    useAgentUi.setState({ calls: [], running: 0 })
    for (let i = 0; i < MAX_CALLS + 5; i++) callStarted({ id: `1:${i}`, tool: 'find_text', title: 'Find text', client: 'Claude', started: i })
    const s = useAgentUi.getState()
    expect(s.calls).toHaveLength(MAX_CALLS)
    expect(s.calls[0].id).toBe(`1:${MAX_CALLS + 4}`)
    expect(s.running).toBe(MAX_CALLS + 5)
    callFinished(`1:${MAX_CALLS + 4}`, { outcome: 'declined', ms: 12 })
    // a call that dropped off the list still stops counting as running
    callFinished('1:0', { outcome: 'done' })
    callFinished('1:0', { outcome: 'done' })
    const after = useAgentUi.getState()
    expect(after.calls[0]).toMatchObject({ outcome: 'declined', ms: 12 })
    expect(after.running).toBe(MAX_CALLS + 3)
  })
})
