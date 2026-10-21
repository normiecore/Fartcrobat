import { describe, expect, it } from 'vitest'
import type agentText from '@features/agent-access/engine'
import type textOps from '@features/edit-text/engine'
import type annotOps from '@engine/ops/annots'
import { REVIEW_LIMITS, validateTextChanges, type TextChange } from '@features/agent-access/textEdits'
import { openFixture, roundTrip } from './helpers'

async function setup() {
  const e = await openFixture('text.pdf')
  const ops = e.ops<typeof agentText>('agent-text')
  const snapshot = await ops.inspect(0)
  const block = snapshot.blocks.find((b) => !b.mark && !b.unreadable && b.text.includes('quick brown fox'))!
  expect(block).toBeTruthy()
  const change: TextChange = {
    page: 0,
    block_id: block.id,
    original_text: block.text,
    text: block.text.replace('quick brown fox', 'swift brown fox')
  }
  return { e, ops, snapshot, block, change }
}

describe('native MCP text editing', () => {
  it('previews real page text without dirtying the document or touching undo/redo', async () => {
    const { e, ops, snapshot, change } = await setup()
    const before = await e.doc.journal()
    const preview = await ops.preview(snapshot.revision, [change])
    expect(preview.canApply, JSON.stringify(preview.issues)).toBe(true)
    // preview_only gets PNGs of the proposed pages; the live page is the original.
    expect(preview.previews.map((p) => p.page)).toEqual([1])
    expect(preview.previews[0].after.slice(0, 4)).toEqual(new Uint8Array([137, 80, 78, 71]))
    expect(preview.proposal).toBeUndefined()
    expect(preview.changes[0].after).toContain('swift brown fox')
    expect(await e.doc.journal()).toEqual(before)
    expect((await ops.inspect(0)).revision).toBe(snapshot.revision)
    expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain('quick brown fox')
  })

  it('edits native text, persists it, and restores the entire batch with one undo', async () => {
    const { e, ops, snapshot, change } = await setup()
    const b2 = (await ops.inspect(1)).blocks.find((b) => b.text.includes('quick brown fox'))!
    e.actor = 'Agent'
    const result = await ops.apply(snapshot.revision, [
      change,
      {
        ...change,
        page: 1,
        block_id: b2.id,
        original_text: b2.text,
        text: b2.text.replace('quick brown fox', 'swift brown fox')
      }
    ])
    expect(result.changed).toBe(2)
    expect((await e.doc.journal()).undoLabel).toBe('Agent: Edit Text Batch')
    expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain('swift brown fox')
    expect(await e.ops<typeof textOps>('edit-text').text(0)).not.toContain('quick brown fox')
    expect(await e.ops<typeof annotOps>('annots').listAll()).toEqual([])
    const reopened = await roundTrip(e)
    expect(await reopened.ops<typeof textOps>('edit-text').text(0)).toContain('swift brown fox')
    reopened.session.closeDocument()
    await e.doc.undo()
    expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain('quick brown fox')
    expect(await e.ops<typeof textOps>('edit-text').text(1)).toContain('quick brown fox')
    await e.doc.redo()
    expect(await e.ops<typeof textOps>('edit-text').text(1)).toContain('swift brown fox')
  })

  it('refuses stale revisions, including a change undone back to the same text', async () => {
    const { e, ops, snapshot, change } = await setup()
    await e
      .ops<typeof annotOps>('annots')
      .create(0, { type: 'Text', contents: 'Person edit', rect: [10, 10, 20, 20] })
    await e.doc.undo()
    await expect(ops.apply(snapshot.revision, [change])).rejects.toThrow(/document changed/)
    expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain('quick brown fox')
  })

  it('checks original text, duplicate targets and layout before writing any live text', async () => {
    const { e, ops, snapshot, change } = await setup()
    await expect(ops.apply(snapshot.revision, [{ ...change, original_text: 'wrong' }])).rejects.toThrow(
      /block changed/
    )
    const revision = (await ops.inspect(0)).revision
    await expect(ops.preview(revision, [change, change])).rejects.toThrow(/only once/)
    const offPage: TextChange = { page: 1, text: 'Outside', rect: [-200, -200, -20, -100] }
    const report = await ops.preview(revision, [change, offPage])
    expect(report.canApply).toBe(false)
    expect(report.issues.some((i) => i.code === 'outside_page')).toBe(true)
    await expect(ops.apply(revision, [change, offPage])).rejects.toThrow(/outside/)
    expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain('quick brown fox')
  })

  it('adds real text and rejects overflowing text boxes without shrinking it', async () => {
    const { e, ops, snapshot } = await setup()
    const add: TextChange = {
      page: 0,
      text: 'New data analyst profile',
      rect: [72, 600, 480, 645],
      font_size: 12
    }
    expect((await ops.preview(snapshot.revision, [add])).canApply).toBe(true)
    await ops.apply(snapshot.revision, [add])
    expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain(add.text)
    const rev = (await ops.inspect(0)).revision
    const report = await ops.preview(rev, [
      { ...add, text: 'long text '.repeat(100), rect: [72, 600, 150, 610] }
    ])
    expect(report.canApply).toBe(false)
    expect(report.issues.some((i) => i.code === 'outside_text_area')).toBe(true)
  })

  it('blocks new text collisions with existing text and between proposed boxes', async () => {
    const { ops, snapshot, block } = await setup()
    const collision: TextChange = { page: 0, text: 'Overlap', rect: block.bbox, font_size: 10 }
    expect(
      (await ops.preview(snapshot.revision, [collision])).issues.some((i) => i.code === 'text_overlap')
    ).toBe(true)
    const add: TextChange = { page: 0, text: 'A new line', rect: [72, 600, 480, 645] }
    expect(
      (await ops.preview(snapshot.revision, [add, { ...add, text: 'Another line' }])).issues.some(
        (i) => i.code === 'text_overlap'
      )
    ).toBe(true)
  })

  it('validates finite geometry, types and batch limits', () => {
    expect(() => validateTextChanges([{ page: 0, text: 'A', rect: [0, 0, NaN, 20] }], 1)).toThrow(/rect/)
    expect(() =>
      validateTextChanges([{ page: 0, text: 'A', rect: [0, 0, 20, 20], bold: 'yes' as never }], 1)
    ).toThrow(/bold/)
    expect(() =>
      validateTextChanges(
        Array.from({ length: 6 }, (_, page) => ({
          page,
          text: 'A',
          rect: [0, 0, 20, 20] as [number, number, number, number]
        })),
        6
      )
    ).toThrow(/5 pages/)
    // A review holds the edits of several calls: up to 100 edits on 10 pages.
    const boxes = (n: number, pages: number) =>
      Array.from({ length: n }, (_, i) => ({ page: i % pages, text: 'A', rect: [0, i, 20, i + 1] as [number, number, number, number] }))
    expect(() => validateTextChanges(boxes(51, 1), 1)).toThrow(/1 to 50/)
    expect(() => validateTextChanges(boxes(100, 10), 10, REVIEW_LIMITS)).not.toThrow()
    expect(() => validateTextChanges(boxes(101, 10), 10, REVIEW_LIMITS)).toThrow(/1 to 100/)
    expect(() => validateTextChanges(boxes(11, 11), 11, REVIEW_LIMITS)).toThrow(/10 pages/)
  })
})

describe('exact text styles', () => {
  it('supports styled spans while preserving the unchanged page artwork', async () => {
    const { e, ops, snapshot, change } = await setup()
    const content: any = await e.call('export-create.content', 0)
    const { DEFAULT_STYLE } = await import('@features/edit-text/model')
    const styled = {
      ...change,
      text: 'Data Analyst',
      style_runs: [
        { ...DEFAULT_STYLE, text: 'Data ', bold: true },
        { ...DEFAULT_STYLE, text: 'Analyst', italic: true }
      ]
    }
    await ops.apply(snapshot.revision, [styled])
    const blocks = (await ops.inspect(0)).blocks
    const block = blocks.find((b) => b.text === 'Data Analyst')!
    expect(block.runs.some((r) => r.bold && r.text.includes('Data'))).toBe(true)
    expect(block.runs.some((r) => r.italic && r.text.includes('Analyst'))).toBe(true)
    const after: any = await e.call('export-create.content', 0)
    expect(after.fills).toEqual(content.fills)
    expect(after.rules).toEqual(content.rules)
    expect(after.images).toEqual(content.images)
  })
  it('refuses inconsistent styled spans', () => {
    expect(() =>
      validateTextChanges([{ page: 0, text: 'A', rect: [0, 0, 100, 30], style_runs: [] }], 1)
    ).toThrow(/style_runs/)
  })
})

it('native text editing keeps password protection when the file is saved', async () => {
  const e = await openFixture('text.pdf')
  const locked = await e.doc.save({ encrypt: { method: 'aes-256', userPassword: 'secret', ownerPassword: 'owner', permissions: {} } })
  expect((await e.doc.reload(locked, { password: 'secret' })).ok).toBe(true)
  const ops = e.ops<typeof agentText>('agent-text')
  const snap = await ops.inspect(0)
  const b = snap.blocks.find((b) => !b.mark && !b.unreadable)!
  await ops.apply(snap.revision, [{ page: 0, block_id: b.id, original_text: b.text, text: '' }])
  const bytes = await e.doc.save({})
  const m = await import('mupdf')
  const pdf = new m.PDFDocument(bytes)
  try {
    expect(pdf.needsPassword()).toBe(true)
    expect(pdf.authenticatePassword('secret')).toBeTruthy()
  } finally {
    pdf.destroy()
  }
})
