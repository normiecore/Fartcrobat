// The proposal held in the worker during a live edit review: rendered at any scale, checked in
// parts, revised after rejections and released at the end.
import { describe, expect, it } from 'vitest'
import type agentText from '@features/agent-access/engine'
import type annotOps from '@engine/ops/annots'
import type renderOps from '@engine/ops/render'
import type { FlowSpec } from '@features/agent-access/flow'
import type { TextChange } from '@features/agent-access/textEdits'
import { openFixture } from './helpers'

async function setup() {
  const e = await openFixture('text.pdf')
  const ops = e.ops<typeof agentText>('agent-text')
  const snap = await ops.inspect(0)
  const block = (start: string) => snap.blocks.find((b) => b.text.startsWith(start))!
  const edit = (start: string, text: (t: string) => string, extra: Partial<TextChange> = {}): TextChange => {
    const b = block(start)
    return { page: 0, block_id: b.id, original_text: b.text, text: text(b.text), ...extra }
  }
  return { e, ops, snap, block, edit }
}
const codeOf = async (p: Promise<unknown>) => ((await p.then(() => ({ code: 'ok' }), (err) => err)) as { code?: string }).code

describe('edit_text proposals', () => {
  it('describe each change for markup: old lines, new box, styles and notes', async () => {
    const { e, ops, snap, block, edit } = await setup()
    const journal = await e.doc.journal()
    const report = await ops.propose(snap.revision, [
      edit('Hello', (t) => t.replace('quick', 'swift'), { font: 'Times' }),
      { page: 0, text: 'A new line', rect: [72, 20, 480, 50], font_size: 12 }
    ])
    expect(report.canApply, JSON.stringify(report.issues)).toBe(true)
    expect(report.proposal).toEqual({ id: expect.any(String), version: 1 })
    expect(report.previews).toEqual([])
    expect(report.pages).toEqual([{ page: 1, width: 612, height: 792, live: true }])
    const [a, b] = report.changes
    expect(a).toMatchObject({ index: 0, kind: 'edit', label: 'Change 1', page: 1, beforePage: 1, rejectable: true })
    expect(a.beforeBox).toEqual(block('Hello').bbox)
    expect(a.beforeLines.length).toBe(block('Hello').quads.length)
    expect(a.beforeLines[0][1]).toBeGreaterThanOrEqual(a.beforeBox![1] - 1)
    expect(a.fragments).toEqual([{ page: 1, rect: a.bbox }])
    expect(a.styleBefore).toMatchObject({ font: 'Helvetica', size: 12 })
    expect(a.styleAfter).toMatchObject({ font: 'Times New Roman', size: 12 })
    expect(a.notes).toContain('Aa Helvetica 12 → Times New Roman 12 pt')
    expect(b).toMatchObject({ index: 1, label: 'Change 2', before: '', beforeBox: null, beforeLines: [] })
    expect(b.notes).toEqual(['New text', expect.stringMatching(/^Text area top [\d.]+ → 20 pt$/)])
    // The new line extends the page's text area upwards.
    const margins = report.margins.find((m) => m.page === 1)!
    expect(margins.after![1]).toBeLessThan(margins.before![1])
    expect(b.notes.join() + a.notes.join()).toContain('Text area top')
    // Nothing happened to the live document.
    expect(await e.doc.journal()).toEqual(journal)
    expect((await ops.inspect(0)).revision).toBe(snap.revision)
  })

  it('renders the held proposal at any scale and clip, like render.page', async () => {
    const { e, ops, snap, edit } = await setup()
    const report = await ops.propose(snap.revision, [edit('Hello', (t) => t.replace('quick brown fox', 'QUICK BROWN FOX TEXT'))])
    const { id, version } = report.proposal!
    const live = await e.ops<typeof renderOps>('render').page(0, { scale: 2 })
    const proposed = await ops.renderProposal(id, version, 0, { scale: 2 })
    expect([proposed.width, proposed.height]).toEqual([live.width, live.height])
    expect(proposed.pixels).not.toEqual(live.pixels)
    // A detail tile: only the clipped region, placed where it belongs.
    const tile = await ops.renderProposal(id, version, 0, { scale: 4, clip: [200, 400, 600, 700] })
    expect(tile).toMatchObject({ x: 200, y: 400, width: 400, height: 300 })
    // Other pages are the live ones.
    const other = await ops.renderProposal(id, version, 2, { scale: 1 })
    expect(other.pixels).toEqual((await e.ops<typeof renderOps>('render').page(2, { scale: 1 })).pixels)
  })

  it('a proposal goes stale when closed, replaced or the document changes', async () => {
    const { e, ops, snap, edit } = await setup()
    const change = edit('Hello', (t) => t.replace('quick', 'swift'))
    const first = (await ops.propose(snap.revision, [change])).proposal!
    expect(await codeOf(ops.renderProposal(first.id, first.version + 1, 0, { scale: 1 }))).toBe('STALE_PROPOSAL')
    const second = (await ops.propose(snap.revision, [change])).proposal!
    expect(second.id).not.toBe(first.id)
    expect(await codeOf(ops.renderProposal(first.id, first.version, 0, { scale: 1 }))).toBe('STALE_PROPOSAL')
    expect(await codeOf(ops.renderProposal(second.id, second.version, 0, { scale: 1 }))).toBe('ok')
    // Closing another id leaves it; closing its own id releases it.
    await ops.closeProposal(first.id)
    expect(await codeOf(ops.renderProposal(second.id, second.version, 0, { scale: 1 }))).toBe('ok')
    await ops.closeProposal(second.id)
    expect(await codeOf(ops.renderProposal(second.id, second.version, 0, { scale: 1 }))).toBe('STALE_PROPOSAL')
    const third = (await ops.propose(snap.revision, [change])).proposal!
    await e.ops<typeof annotOps>('annots').create(0, { type: 'Text', contents: 'Person edit', rect: [10, 10, 20, 20] })
    expect(await codeOf(ops.renderProposal(third.id, third.version, 0, { scale: 1 }))).toBe('STALE_PROPOSAL')
    expect(await codeOf(ops.checkProposal(third.id, [0]))).toBe('STALE_PROPOSAL')
  })

  it('holds nothing for a blocked proposal', async () => {
    const { ops, snap, block } = await setup()
    const report = await ops.propose(snap.revision, [{ page: 0, text: 'Overlap', rect: block('Hello').bbox }])
    expect(report.canApply).toBe(false)
    expect(report.proposal).toBeUndefined()
    expect(report.issues.find((i) => i.code === 'text_overlap')).toMatchObject({ change: 0, blocking: true })
  })

  it('checks the kept edits: a subset can collide where the whole batch did not', async () => {
    const { ops, snap, block, edit } = await setup()
    // Move "Visit..." onto the invoice line, and delete the invoice line.
    const move = edit('Visit', (t) => t, { rect: block('Invoice').bbox })
    const remove = edit('Invoice', () => '')
    const report = await ops.propose(snap.revision, [remove, move])
    expect(report.canApply, JSON.stringify(report.issues)).toBe(true)
    const { id } = report.proposal!
    expect(await ops.checkProposal(id, [0, 1])).toEqual({ canApply: true, issues: report.issues })
    expect((await ops.checkProposal(id, [])).canApply).toBe(true)
    const kept = await ops.checkProposal(id, [1])
    expect(kept.canApply).toBe(false)
    // Issues are numbered like the proposal's edits, not like the subset.
    expect(kept.issues.find((i) => i.blocking)).toMatchObject({ code: 'text_overlap', change: 1 })
    expect((await ops.checkProposal(id, [0])).canApply).toBe(true)
    // Checking does not replace what is shown.
    expect(await codeOf(ops.renderProposal(id, 1, 0, { scale: 1 }))).toBe('ok')
  })
})

describe('reflow_text and rebuild_document proposals', () => {
  it('flow: one item per paragraph with every placement; a rejection keeps the original wording', async () => {
    const { ops, snap, block } = await setup()
    const hello = block('Hello')
    const lorem = block('Lorem')
    const spec: FlowSpec = {
      regions: [
        { page: 0, rect: [72, 112, 280, 280] },
        { page: 0, rect: [300, 112, 520, 280] }
      ],
      paragraphs: [
        { page: 0, block_id: hello.id, original_text: hello.text, text: 'A rewritten opening paragraph.', font_size: 14 },
        { page: 0, block_id: lorem.id, original_text: lorem.text, text: lorem.text }
      ]
    }
    const report = await ops.proposeFlow(snap.revision, spec)
    const { id } = report.proposal!
    expect(report.flow).toBeTruthy()
    const [a, b] = report.changes
    expect(a).toMatchObject({ index: 0, kind: 'paragraph', label: 'Paragraph 1', beforePage: 1, before: hello.text, rejectable: true })
    expect(a.beforeBox).toEqual(hello.bbox)
    expect(a.beforeLines.length).toBe(hello.quads.length)
    expect(a.notes).toContain('Aa Helvetica 12 → Helvetica 14 pt')
    // The long paragraph continues in the second column.
    expect(b.fragments.length).toBeGreaterThan(1)
    expect(b.fragments.some((f) => f.rect[0] >= 300)).toBe(true)
    expect(b.notes).toContain('Continues in ' + b.fragments.length + ' places')
    const revised = await ops.reviseProposal(id, [0])
    expect(revised.proposal).toEqual({ id, version: 2 })
    expect(revised.changes).toHaveLength(2)
    expect(revised.changes[0]).toMatchObject({ after: hello.text, styleAfter: { size: 12 } })
    expect(revised.changes[0].fragments.length).toBeGreaterThan(0)
    expect(revised.changes[1].after).toBe(spec.paragraphs[1].text)
    expect(await codeOf(ops.renderProposal(id, 1, 0, { scale: 1 }))).toBe('STALE_PROPOSAL')
    expect(await codeOf(ops.renderProposal(id, 2, 0, { scale: 1 }))).toBe('ok')
    // Accepting it again goes back to the agent's text.
    expect((await ops.reviseProposal(id, [])).changes[0].after).toBe('A rewritten opening paragraph.')
  })

  it('flow: a revision that does not fit keeps the last good proposal', async () => {
    const { ops, snap, block } = await setup()
    const lorem = block('Lorem')
    const report = await ops.proposeFlow(snap.revision, {
      regions: [{ page: 0, rect: [72, 150, 494, 200] }],
      paragraphs: [{ page: 0, block_id: lorem.id, original_text: lorem.text, text: 'Short.' }]
    })
    const { id } = report.proposal!
    await expect(ops.reviseProposal(id, [0])).rejects.toThrow(/does not fit/)
    expect(await codeOf(ops.renderProposal(id, 1, 0, { scale: 1 }))).toBe('STALE_PROPOSAL')
    expect(await codeOf(ops.renderProposal(id, 2, 0, { scale: 1 }))).toBe('ok')
  })

  it('rebuild: title, one item per section located on the new pages, and a design card', async () => {
    const { ops, snap } = await setup()
    const para = (name: string, n: number) => Array.from({ length: n }, (_, i) => name + ' item ' + i + ': analysis and reporting for decisions.')
    const spec = {
      title: 'Darren Wong',
      subtitle: 'Data Analyst',
      sections: [
        { heading: 'Summary', paragraphs: para('Summary', 2) },
        { heading: 'Experience', paragraphs: para('Experience', 70) },
        { heading: 'Education', bullets: ['BSc Statistics'] }
      ]
    }
    const report = await ops.proposeReflow(snap.revision, spec)
    const { id } = report.proposal!
    expect(report.rebuilt).toBe(true)
    expect(report.changes.map((c) => [c.index, c.kind, c.label, c.rejectable])).toEqual([
      [0, 'title', 'Title', false],
      [1, 'section', 'Summary', true],
      [2, 'section', 'Experience', true],
      [3, 'section', 'Education', true],
      [4, 'design', 'Page design', false]
    ])
    const [title, summary, experience, education, design] = report.changes
    expect(title.after).toBe('Darren Wong\nData Analyst')
    expect(title.fragments.map((f) => f.page)).toEqual([1])
    expect(summary.fragments.map((f) => f.page)).toEqual([1])
    // In reading order, without overlapping one another.
    expect(summary.fragments[0].rect[1]).toBeGreaterThan(title.fragments[0].rect[3] - 1)
    expect(experience.fragments.length).toBeGreaterThan(1)
    expect(experience.fragments[0].rect[1]).toBeGreaterThan(summary.fragments[0].rect[3] - 1)
    const last = experience.fragments[experience.fragments.length - 1]
    expect(education.fragments[0].page).toBeGreaterThanOrEqual(last.page)
    expect(education.after).toBe('Education\n• BSc Statistics')
    expect(design.notes[0]).toBe('A4 pages, sans serif text 11 pt')
    expect(report.pages.length).toBeGreaterThan(1)
    expect(report.pages[0]).toMatchObject({ page: 1, live: false })
    // Leaving the long section out shortens the design; every item stays listed.
    const revised = await ops.reviseProposal(id, [2])
    expect(revised.proposal!.version).toBe(2)
    expect(revised.changes).toHaveLength(5)
    expect(revised.changes[2]).toMatchObject({ fragments: [], notes: ['Left out of the new design'] })
    expect(revised.changes[3].fragments[0].page).toBe(1)
    expect(revised.pages.length).toBeLessThan(report.pages.length)
    await expect(ops.reviseProposal(id, [1, 2, 3])).rejects.toThrow(/at least one section/)
  })
})
