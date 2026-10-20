import { test, expect } from '@playwright/test'
import { fixturePath, waitForRender, activeDocState } from './helpers'
import { startSession, dataOf, errorOf, appPageText, expectAudit, undoLabel } from './agent-helpers'

test('Claude edits native PDF text after review; Decline and Undo preserve the original', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { agent, page } = s
    await waitForRender(page)
    const snapshot = dataOf(await agent.call('get_editable_text', { page: 1 }))
    const b = snapshot.blocks.find((b: any) => b.text.includes('quick brown fox'))
    const args = {
      revision: snapshot.revision,
      edits: [
        {
          page: 1,
          block_id: b.block_id,
          original_text: b.text,
          text: b.text.replace('quick brown fox', 'swift brown fox')
        }
      ]
    }
    const preview = dataOf(await agent.call('edit_text', { ...args, preview_only: true }))
    expect(preview.applied).toBe(false)
    expect(preview.canApply).toBe(true)
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    const declined = agent.start('edit_text', args)
    const dialog = page.getByRole('region', { name: 'Review text changes' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByAltText('Page 1 proposed edits')).toBeVisible()
    await dialog.screenshot({ path: 'test-results/agent-text-review.png', animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Discard batch', exact: true }).click()
    expect(errorOf(await declined)).toContain('[declined]')
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    const applying = agent.start('edit_text', args)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Accept all', exact: true }).click()
    expect(dataOf(await applying).applied).toBe(true)
    expect(await appPageText(page, 0)).toContain('swift brown fox')
    expect(await undoLabel(page)).toBe('Agent: Edit Text Batch')
    expect((await activeDocState(page))?.dirty).toBe(true)
    expect(dataOf(await agent.call('list_annotations')).count).toBe(0)
    dataOf(await agent.call('undo'))
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    await expectAudit(s.userData, agent.calls, ['swift brown fox', 'quick brown fox'])
  } finally {
    await s.close()
  }
})

test('Claude inspects the layout and flows text through columns and new pages inside Fartcrobat', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { agent, page } = s
    await waitForRender(page)
    const snap = dataOf(await agent.call('get_document_layout', { pages: '1' }))
    expect(snap.pages[0].margins).toBeTruthy()
    const b = snap.pages[0].blocks.find((b: any) => b.text.includes('quick brown fox'))
    const args = {
      revision: snap.revision,
      regions: [
        { page: 1, rect: [72, 480, 270, 720] },
        { page: 1, rect: [310, 480, 510, 720] }
      ],
      paragraphs: [
        { page: 1, block_id: b.id, original_text: b.text, text: 'Data analysis and reporting. '.repeat(100) }
      ],
      continuation: {
        template_page: 1,
        rects: [
          [72, 480, 270, 720],
          [310, 480, 510, 720]
        ]
      }
    }
    const applying = agent.start('reflow_text', args)
    const dialog = page.getByRole('region', { name: 'Review text flow' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('Continuation pages repeat the template artwork')
    await dialog.screenshot({ path: 'test-results/agent-text-flow-review.png', animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Accept all', exact: true }).click()
    const result = dataOf(await applying)
    expect(result.applied).toBe(true)
    expect(result.result.addedPages).toBeGreaterThan(0)
    await expect.poll(() => undoLabel(page)).toBe('Agent: Reflow Text')
    expect(await appPageText(page, 0)).toContain('Data analysis')
    dataOf(await agent.call('undo'))
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    expect(dataOf(await agent.call('get_document_info')).pageCount).toBe(5)
  } finally {
    await s.close()
  }
})

test('a person edit during review makes the proposal stale instead of overwriting it', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { agent, page } = s
    await waitForRender(page)
    const snap = dataOf(await agent.call('get_editable_text', { page: 1 }))
    const b = snap.blocks.find((b: any) => b.text.includes('quick brown fox'))
    const pending = agent.start('edit_text', {
      revision: snap.revision,
      edits: [
        { page: 1, block_id: b.block_id, original_text: b.text, text: b.text.replace('quick', 'swift') }
      ]
    })
    const dialog = page.getByRole('region', { name: 'Review text changes' })
    await expect(dialog).toBeVisible()
    await page.evaluate(async () => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      await d.ops('annots').create(0, { type: 'Text', contents: 'Person edit', rect: [20, 20, 40, 40] })
    })
    expect(errorOf(await pending)).toContain('document changed')
    await expect(dialog).not.toBeVisible()
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    expect(dataOf(await agent.call('list_annotations')).count).toBe(1)
  } finally {
    await s.close()
  }
})


test('an approved new design paginates inside the same tab and Undo restores the source', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { agent, page } = s
    await waitForRender(page)
    const snap = dataOf(await agent.call('get_editable_text', { page: 1 }))
    const pending = agent.start('rebuild_document', { revision: snap.revision, title: 'Darren Wong', subtitle: 'Data Analyst', sections: [{ heading: 'Experience', paragraphs: Array.from({ length: 60 }, (_, i) => 'Experience ' + i + ': analysis and business reporting.') }] })
    const dialog = page.getByRole('region', { name: 'Review new document design' })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('replaces the original layout')
    await dialog.getByRole('button', { name: 'Accept all', exact: true }).click()
    expect(dataOf(await pending).applied).toBe(true)
    expect(await appPageText(page, 0)).toContain('Darren Wong')
    expect(await undoLabel(page)).toBe('Agent: Rebuild Document Layout')
    dataOf(await agent.call('undo'))
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    expect(dataOf(await agent.call('get_document_info')).pageCount).toBe(5)
  } finally { await s.close() }
})

test('inline review accepts one edit and rejects another without saving proposal artwork', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    const a = dataOf(await agent.call('get_editable_text', { page: 1 }))
    const b = dataOf(await agent.call('get_editable_text', { page: 2 }))
    const edits = [a, b].map((snap, i) => {
      const block = snap.blocks.find((x: any) => x.text.includes('quick brown fox'))
      return { page: i + 1, block_id: block.block_id, original_text: block.text, text: block.text.replace('quick', 'swift') }
    })
    const pending = agent.start('edit_text', { revision: a.revision, edits })
    const review = page.getByRole('region', { name: 'Review text changes' })
    await expect(review).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByAltText('Page 1 proposed edits')).toBeVisible()
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    await review.getByRole('button', { name: 'Accept edit', exact: true }).click()
    await expect(review).toContainText('Change 2')
    await review.getByRole('button', { name: 'Reject edit', exact: true }).click()
    const result = dataOf(await pending)
    expect(result.acceptedEdits).toEqual([1])
    expect(result.rejectedEdits).toEqual([2])
    expect(await appPageText(page, 0)).toContain('swift brown fox')
    expect(await appPageText(page, 1)).toContain('quick brown fox')
    await expect(page.getByLabel('Proposed PDF changes')).toHaveCount(0)
    expect(dataOf(await agent.call('list_annotations')).count).toBe(0)
    dataOf(await agent.call('undo'))
    expect(await appPageText(page, 0)).toContain('quick brown fox')
  } finally { await s.close() }
})
