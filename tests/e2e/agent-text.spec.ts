import { test, expect } from '@playwright/test'
import { fixturePath, waitForRender, activeDocState } from './helpers'
import { startSession, dataOf, errorOf, appPageText, expectAudit, undoLabel, finalOf } from './agent-helpers'
import type { Locator, Page } from '@playwright/test'

/** A change's card in the Review edits panel. */
const card = (review: Locator, name: string) => review.getByRole('article', { name, exact: true })
/** A change's mark on the page; its name is the change and its state ("Change 2, pending"). */
const mark = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Proposed PDF changes' }).getByRole('button', { name: new RegExp('^' + name + ', ') })

/** Three edits on page 1 of text.pdf. */
async function threeEdits(agent: Awaited<ReturnType<typeof startSession>>['agent']) {
  const snap = dataOf(await agent.call('get_editable_text', { page: 1 }))
  const edit = (start: string, from: string, to: string) => {
    const b = snap.blocks.find((x: any) => x.text.startsWith(start))
    return { page: 1, block_id: b.block_id, original_text: b.text, text: b.text.replace(from, to) }
  }
  return {
    revision: snap.revision,
    edits: [edit('Hello', 'quick', 'swift'), edit('Lorem', 'Lorem', 'LOREM'), edit('Invoice', 'Invoice', 'INVOICE')]
  }
}

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
    await expect(page.getByRole('img', { name: 'Page 1 proposed edits' })).toBeVisible()
    await dialog.screenshot({ path: 'test-results/agent-text-review.png', animations: 'disabled' })
    await dialog.getByRole('button', { name: 'Discard batch', exact: true }).click()
    expect(errorOf(await finalOf(agent, declined))).toContain('[declined]')
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    const applying = agent.start('edit_text', args)
    await expect(dialog).toBeVisible()
    await dialog.getByRole('button', { name: 'Accept all', exact: true }).click()
    expect(dataOf(await finalOf(agent, applying)).applied).toBe(true)
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
    const result = dataOf(await finalOf(agent, applying))
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
    expect(errorOf(await finalOf(agent, pending))).toContain('document changed')
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
    expect(dataOf(await finalOf(agent, pending)).applied).toBe(true)
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
    await expect(page.getByRole('img', { name: 'Page 1 proposed edits' })).toBeVisible()
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    await card(review, 'Change 1').getByRole('button', { name: 'Accept edit', exact: true }).click()
    await expect(card(review, 'Change 2')).toBeVisible()
    await card(review, 'Change 2').getByRole('button', { name: 'Reject edit', exact: true }).click()
    const result = dataOf(await finalOf(agent, pending))
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

test('changes arrive one by one, then each is accepted or rejected on its own', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    const args = await threeEdits(agent)
    // Record how many changes the panel lists as they arrive.
    await page.evaluate(() => {
      const seen: number[] = []
      ;(window as any).__revealCounts = seen
      new MutationObserver(() => {
        const n = document.querySelectorAll('.fc-agent-access-review-card').length
        if (n && seen[seen.length - 1] !== n) seen.push(n)
      }).observe(document.body, { childList: true, subtree: true })
    })
    const pending = agent.start('edit_text', args)
    const review = page.getByRole('region', { name: 'Review text changes' })
    await expect(review).toBeVisible()
    await expect(review.getByRole('article')).toHaveCount(3)
    expect(await page.evaluate(() => (window as any).__revealCounts)).toEqual([1, 2, 3])
    await expect(review.getByRole('button', { name: 'Show all' })).toHaveCount(0)
    const layer = page.getByRole('group', { name: 'Proposed PDF changes' })
    await expect(layer.getByRole('button')).toHaveCount(3)
    await page.screenshot({ path: 'test-results/agent-live-review.png' })
    // The page keeps text selection and links: only the marks take clicks.
    expect(await layer.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
    await card(review, 'Change 2').getByRole('button', { name: 'Reject edit', exact: true }).click()
    await expect(mark(page, 'Change 2')).toHaveAccessibleName('Change 2, rejected')
    await expect(card(review, 'Change 2')).toContainText('Rejected')
    await card(review, 'Change 3').getByRole('button', { name: 'Accept edit', exact: true }).click()
    await expect(mark(page, 'Change 3')).toHaveAccessibleName('Change 3, accepted')
    // A decision can be changed while others are pending.
    await card(review, 'Change 3').getByRole('button', { name: 'Reject edit', exact: true }).click()
    await expect(mark(page, 'Change 3')).toHaveAccessibleName('Change 3, rejected')
    await card(review, 'Change 3').getByRole('button', { name: 'Accept edit', exact: true }).click()
    await expect(review.getByRole('status')).toContainText('1 pending · 1 accepted · 1 rejected')
    await card(review, 'Change 1').getByRole('button', { name: 'Accept edit', exact: true }).click()
    const result = dataOf(await finalOf(agent, pending))
    expect(result.acceptedEdits).toEqual([1, 3])
    expect(result.rejectedEdits).toEqual([2])
    const text = await appPageText(page, 0)
    expect(text).toContain('swift brown fox')
    expect(text).toContain('Lorem ipsum')
    expect(text).toContain('INVOICE')
    await expect(layer).toHaveCount(0)
  } finally { await s.close() }
})

test('hovering a change in the panel rings it on the page without moving the page', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    const pending = agent.start('edit_text', await threeEdits(agent))
    const review = page.getByRole('region', { name: 'Review text changes' })
    await expect(review.getByRole('article')).toHaveCount(3)
    await expect(mark(page, 'Change 2')).toBeVisible()
    const scroller = page.locator('.viewer-scroll')
    const before = await scroller.evaluate((el) => el.scrollTop)
    await card(review, 'Change 2').hover()
    await expect(mark(page, 'Change 2')).toHaveClass(/is-focus/)
    await expect(mark(page, 'Change 3')).not.toHaveClass(/is-focus/)
    await expect(card(review, 'Change 2')).toHaveClass(/is-hovered/)
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before)
    // And the other way: hovering the mark highlights its card; clicking it selects it.
    await mark(page, 'Change 3').hover()
    await expect(card(review, 'Change 3')).toHaveClass(/is-hovered/)
    await mark(page, 'Change 3').click()
    await expect(card(review, 'Change 3')).toHaveClass(/is-selected/)
    // Keys in the list: Up selects Change 2 and R rejects it.
    await review.getByRole('list', { name: 'Changes' }).focus()
    await page.keyboard.press('ArrowUp')
    await expect(card(review, 'Change 2')).toHaveClass(/is-selected/)
    await page.keyboard.press('r')
    await expect(card(review, 'Change 2')).toContainText('Rejected')
    await review.getByRole('button', { name: 'Accept all', exact: true }).click()
    const result = dataOf(await finalOf(agent, pending))
    expect(result.acceptedEdits).toEqual([1, 3])
    expect(result.rejectedEdits).toEqual([2])
  } finally { await s.close() }
})

test('a rejected section is left out of the new design and the result lists it', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    const snap = dataOf(await agent.call('get_editable_text', { page: 1 }))
    const pending = agent.start('rebuild_document', {
      revision: snap.revision, title: 'Darren Wong', subtitle: 'Data Analyst',
      sections: [
        { heading: 'Summary', paragraphs: ['Analyst with ten years of reporting experience.'] },
        { heading: 'Hobbies', bullets: ['Chess', 'Running'] },
        { heading: 'Skills', bullets: ['SQL', 'Python'] }
      ]
    })
    const review = page.getByRole('region', { name: 'Review new document design' })
    await expect(review).toBeVisible()
    await expect(review).toContainText('replaces the original layout')
    await expect(card(review, 'Page design')).toBeVisible()
    await expect(card(review, 'Title')).toContainText('Always kept')
    await expect(card(review, 'Title').getByRole('button', { name: 'Reject edit' })).toHaveCount(0)
    await card(review, 'Hobbies').getByRole('button', { name: 'Reject edit', exact: true }).click()
    await expect(card(review, 'Hobbies')).toContainText('Left out of the new design')
    await expect(review.getByRole('status')).not.toContainText('Updating preview')
    await review.getByRole('button', { name: 'Accept all', exact: true }).click()
    const result = dataOf(await finalOf(agent, pending))
    expect(result.applied).toBe(true)
    expect(result.acceptedItems).toEqual([{ item: 1, label: 'Summary' }, { item: 3, label: 'Skills' }])
    expect(result.rejectedItems).toEqual([{ item: 2, label: 'Hobbies' }])
    const text = await appPageText(page, 0)
    expect(text).toContain('Darren Wong')
    expect(text).toContain('Skills')
    expect(text).not.toContain('Hobbies')
    expect(text).not.toContain('Chess')
  } finally { await s.close() }
})

test('the proposal is rendered sharp at the zoom of the page, not stretched', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    const pending = agent.start('edit_text', await threeEdits(agent))
    const review = page.getByRole('region', { name: 'Review text changes' })
    await expect(page.getByRole('img', { name: 'Page 1 proposed edits' })).toBeVisible()
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(3))
    const sizes = () =>
      page.evaluate(() => {
        const pageEl = document.querySelector('.viewer-page[data-page-index="0"]')!
        const live = pageEl.querySelector(':scope > canvas.viewer-page-canvas') as HTMLCanvasElement
        const proposed = pageEl.querySelector('canvas[aria-label="Page 1 proposed edits"]') as HTMLCanvasElement
        return { live: [live.width, live.height], proposed: [proposed.width, proposed.height], dpr: devicePixelRatio, css: proposed.getBoundingClientRect().width }
      })
    // 612 x 792 pt at 300 %: 2448 x 3168 CSS px, times the device pixel ratio.
    await expect.poll(async () => (await sizes()).proposed[0], { timeout: 15_000 }).toBeGreaterThan(2000)
    await expect.poll(async () => (await sizes()).live[0], { timeout: 15_000 }).toBeGreaterThan(2000)
    const { live, proposed, dpr, css } = await sizes()
    expect(proposed).toEqual(live)
    expect(proposed[0]).toBe(Math.round(612 * 3 * (96 / 72) * dpr))
    expect(Math.round(css)).toBe(Math.round(612 * 3 * (96 / 72)))
    // Higher up the whole page is too big for one bitmap: a sharp detail tile covers the view.
    await page.evaluate(() => (window as any).__fartcrobat.getActiveDoc().view.setZoom(12))
    const tile = page.locator('.fc-agent-access-review-proposal canvas.viewer-page-detail').first()
    await expect(tile).toBeVisible({ timeout: 15_000 })
    const scale = await tile.evaluate((c: HTMLCanvasElement) => c.width / c.getBoundingClientRect().width)
    expect(scale).toBeCloseTo(await page.evaluate(() => devicePixelRatio), 2)
    await review.getByRole('button', { name: 'Discard batch', exact: true }).click()
    expect(errorOf(await finalOf(agent, pending))).toContain('[declined]')
  } finally { await s.close() }
})

test('edits sent in separate calls reach the page at once, join one review and are applied as one undo step', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    const { revision, edits } = await threeEdits(agent)
    const review = page.getByRole('region', { name: 'Review text changes' })
    // The first call answers as soon as its edit is on the page, before anyone decided anything.
    const first = dataOf(await agent.call('edit_text', { revision, edits: [edits[0]] }))
    expect(first).toMatchObject({ status: 'still_running', review: { edits: [{ edit: 1, page: 1, label: 'Change 1' }], pending: 1 } })
    expect(first.message).toContain('as its own edit_text call')
    await expect(card(review, 'Change 1')).toBeVisible()
    await expect(review).toContainText('Claude is still sending edits')
    // The person decides it while Claude sends the next one.
    await card(review, 'Change 1').getByRole('button', { name: 'Accept edit', exact: true }).click()
    await expect(card(review, 'Change 1')).toContainText('Accepted')
    const second = dataOf(await agent.call('edit_text', { revision, edits: [edits[1]] }))
    expect(second.review.edits[0].label).toBe('Change 2')
    await expect(card(review, 'Change 2')).toBeVisible()
    await expect(mark(page, 'Change 2')).toHaveAccessibleName('Change 2, pending')
    await card(review, 'Change 2').getByRole('button', { name: 'Reject edit', exact: true }).click()
    const third = dataOf(await agent.call('edit_text', { revision, edits: [edits[2]] }))
    expect(third.review).toMatchObject({ edits: [{ edit: 1, label: 'Change 3' }], pending: 1 })
    await expect(card(review, 'Change 3')).toBeVisible()
    await expect(card(review, 'Change 1')).toContainText('Accepted')
    await card(review, 'Change 3').getByRole('button', { name: 'Accept edit', exact: true }).click()
    // Nothing pending, but Claude may still send edits: nothing is applied until it waits or the
    // person applies.
    await expect(review.getByRole('status')).toContainText('0 pending · 2 accepted · 1 rejected')
    await expect(review.getByRole('button', { name: 'Apply accepted changes', exact: true })).toBeVisible()
    await review.screenshot({ path: 'test-results/agent-live-review-calls.png', animations: 'disabled' })
    expect(await appPageText(page, 0)).toContain('quick brown fox')
    // Claude has sent everything and collects the decisions: each ticket returns its own call's.
    const a = dataOf(await agent.call('wait_for_result', { ticket: first.ticket }))
    expect(a).toMatchObject({ applied: true, acceptedEdits: [1], rejectedEdits: [], undoLabel: 'Agent: Edit Text Batch' })
    expect(errorOf(await agent.call('wait_for_result', { ticket: second.ticket }))).toContain('[declined]')
    expect(dataOf(await agent.call('wait_for_result', { ticket: third.ticket }))).toMatchObject({ acceptedEdits: [1] })
    await expect(review).toHaveCount(0)
    const text = await appPageText(page, 0)
    expect(text).toContain('swift brown fox')
    expect(text).toContain('Lorem ipsum')
    expect(text).toContain('INVOICE')
    expect(await undoLabel(page)).toBe('Agent: Edit Text Batch')
    // One Undo restores everything.
    dataOf(await agent.call('undo'))
    const restored = await appPageText(page, 0)
    expect(restored).toContain('quick brown fox')
    expect(restored).not.toContain('INVOICE')
  } finally { await s.close() }
})
