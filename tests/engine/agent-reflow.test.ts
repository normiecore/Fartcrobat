import { describe, expect, it } from 'vitest'
import type agentText from '@features/agent-access/engine'
import type textOps from '@features/edit-text/engine'
import type { FlowSpec } from '@features/agent-access/flow'
import { reflowHtml } from '@features/agent-access/reflow'
import { openFixture, roundTrip } from './helpers'

describe('design-preserving text flow', () => {
  it('continues through columns and appended template pages with one undo', async () => {
    const e = await openFixture('text.pdf')
    const ops = e.ops<typeof agentText>('agent-text')
    const snap = await ops.inspect(0)
    const b = snap.blocks.find((b) => b.text.includes('quick brown fox'))!
    const text = Array.from({ length: 140 }, (_, i) => 'Unique' + i + ' analysis skills.').join(' ')
    const spec: FlowSpec = {
      regions: [
        { page: 0, rect: [72, 480, 270, 720] },
        { page: 0, rect: [310, 480, 510, 720] }
      ],
      paragraphs: [{ page: 0, block_id: b.id, original_text: b.text, text }],
      continuation: {
        template_page: 0,
        rects: [
          [72, 480, 270, 720],
          [310, 480, 510, 720]
        ]
      }
    }
    const journal = await e.doc.journal()
    const preview = await ops.previewFlow(snap.revision, spec)
    expect(preview.flow!.addedPages).toBeGreaterThan(0)
    expect(await e.doc.journal()).toEqual(journal)
    e.actor = 'Agent'
    const result = await ops.flow(snap.revision, spec)
    expect(result.placements.some((p) => p.page === 1 && p.rect[0] >= 310)).toBe(true)
    expect((await e.doc.journal()).undoLabel).toBe('Agent: Reflow Text')
    const all = []
    for (let p = 0; p < (await e.doc.info()).pageCount; p++)
      all.push(await e.ops<typeof textOps>('edit-text').text(p))
    for (let i = 0; i < 140; i++) expect(all.join(' ')).toContain('Unique' + i)
    const rt = await roundTrip(e)
    expect(rt.info.pageCount).toBe(5 + result.addedPages)
    rt.session.closeDocument()
    await e.doc.undo()
    expect((await e.doc.info()).pageCount).toBe(5)
    expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain('quick brown fox')
  })

  it('refuses ambiguous regions and leaves the live document untouched', async () => {
    const e = await openFixture('text.pdf')
    const ops = e.ops<typeof agentText>('agent-text')
    const snap = await ops.inspect(0)
    const b = snap.blocks.find((b) => b.text.includes('quick brown fox'))!
    const spec: FlowSpec = {
      regions: [{ page: 0, rect: [0, 0, 595, 700] }],
      paragraphs: [{ page: 0, block_id: b.id, original_text: b.text, text: 'Changed' }]
    }
    await expect(ops.previewFlow(snap.revision, spec)).rejects.toThrow(/outside the flow/)
    expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain('quick brown fox')
  })
})

describe('automatic document pagination with an approved new design', () => {
  it('creates readable native pages, replaces the open document, and restores it with Undo', async () => {
    const e = await openFixture('text.pdf')
    const ops = e.ops<typeof agentText>('agent-text')
    const { revision } = await ops.inspect(0)
    const spec = {
      title: 'Darren Wong',
      subtitle: 'Data Analyst',
      sections: [
        {
          heading: 'Experience',
          paragraphs: Array.from(
            { length: 90 },
            (_, i) => 'Unique experience ' + i + ': analysis and reporting for business decisions.'
          )
        }
      ]
    }
    const preview = await ops.previewReflow(revision, spec)
    expect(preview.rebuilt).toBe(true)
    expect(preview.previews.length).toBeGreaterThan(1)
    expect((await e.doc.info()).pageCount).toBe(5)
    e.actor = 'Agent'
    const result = await ops.reflow(revision, spec)
    expect((await e.doc.journal()).undoLabel).toBe('Agent: Rebuild Document Layout')
    const text = []
    for (let p = 0; p < result.pageCount; p++) text.push(await e.ops<typeof textOps>('edit-text').text(p))
    expect(text.join(' ')).toContain('Unique experience 89')
    expect(text[0]).toContain('Darren Wong')
    await e.doc.undo()
    expect((await e.doc.info()).pageCount).toBe(5)
    expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain('quick brown fox')
  })
  it('escapes markup and validates content limits', () => {
    const html = reflowHtml({
      title: '<script>evil</script>',
      sections: [{ heading: 'Summary', paragraphs: ['<img src="https://example.com/tracker">'] }]
    })
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img ')
    expect(html).toContain('&lt;img')
    expect(() => reflowHtml({ title: 'CV', sections: [], font_size: 2 })).toThrow()
  })
})

it('keeps embedded-font style sources usable when their text is moved', async () => {
  const e = await openFixture('edit-text/subset-font.pdf')
  const ops = e.ops<typeof agentText>('agent-text')
  const snap = await ops.inspect(0)
  const b = snap.blocks.find((b) => !b.mark && !b.unreadable)!
  const page = e.info.pages[0]
  const spec: FlowSpec = {
    regions: [{ page: 0, rect: [20, 20, page.width - 20, page.height - 20] }],
    paragraphs: snap.blocks.map((b) => ({ page: 0, block_id: b.id, original_text: b.text, text: b.text }))
  }
  const preview = await ops.previewFlow(snap.revision, spec)
  expect(preview.canApply).toBe(true)
  await ops.flow(snap.revision, spec)
  expect(await e.ops<typeof textOps>('edit-text').text(0)).toContain(b.text)
})
