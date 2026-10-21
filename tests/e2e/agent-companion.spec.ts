import { test, expect, type Locator, type Page } from '@playwright/test'
import { fixturePath, runCommand, waitForRender } from './helpers'
import { startSession, startShim, dataOf, errorOf, expectAudit, finalOf } from './agent-helpers'

/** The companion block a tool result carries when its conversation joined the chat. */
function companionOf(result: { content: { type: string; text?: string }[] }): { session: string; status: string } | undefined {
  for (const c of result.content) {
    try {
      const data = JSON.parse(c.type === 'text' ? c.text! : '{}')
      if (data?.companion) return data.companion
    } catch {}
  }
  return undefined
}

test('companion chats with its owner, moves, minimizes and ends cleanly', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    // MCP initialization advertises tools without connecting to Fartcrobat. The first tool
    // call authenticates the local pipe and makes the connected-client companion appear, but
    // joins nothing: the person has not opened the chat.
    expect(companionOf(await agent.call('get_context'))).toBeUndefined()
    const companion = page.getByRole('region', { name: 'AI companion' })
    await expect(companion).toBeVisible()
    expect(errorOf(await agent.call('companion_chat'))).toContain('Chat here')
    // Opened and closed again before anything joined: still nobody joins.
    await companion.getByRole('button', { name: 'Chat here', exact: true }).click()
    await companion.getByRole('button', { name: 'Hide chat', exact: true }).click()
    expect(companionOf(await agent.call('get_context'))).toBeUndefined()
    await companion.getByRole('button', { name: 'Chat here', exact: true }).click()
    await expect(companion.getByText('Waiting for a conversation', { exact: true })).toBeVisible()
    // Read Mode hides the open chat, and Escape there leaves Read Mode, not the hidden chat.
    await runCommand(page, 'view.readMode')
    await expect(companion).toBeHidden()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.evaluate(() => (window as any).__fartcrobat.useApp.getState().readMode)).toBe(false)
    await expect(companion.getByText('Waiting for a conversation', { exact: true })).toBeVisible()
    // Opened: the next call of the conversation joins, without an invitation.
    const session = companionOf(await agent.call('get_context'))!.session
    expect(session).toBeTruthy()
    await expect(companion.getByText('Connected to Claude', { exact: true })).toBeVisible()
    expect(errorOf(await agent.call('companion_chat'))).toContain('Another conversation')
    expect(JSON.stringify(await agent.call('get_context'))).not.toContain(session)
    const listening = agent.start('companion_chat', { session, wait_seconds: 30 })
    await expect(companion.getByText('Claude is listening', { exact: true })).toBeVisible()
    await companion.getByRole('textbox', { name: 'Message companion' }).fill('Please inspect my layout')
    await companion.getByRole('button', { name: 'Send message', exact: true }).click()
    const result = dataOf(await listening)
    expect(result.message.text).toBe('Please inspect my layout')
    dataOf(
      await agent.call('companion_chat', {
        session,
        reply_to: result.message.id,
        message: 'I’ll check the columns and spacing.',
        wait_seconds: 0
      })
    )
    await expect(companion).toContainText('I’ll check the columns and spacing.')
    const move = companion.getByRole('button', { name: 'Move companion', exact: true })
    const before = await companion.boundingBox()
    await move.focus()
    await page.keyboard.press('ArrowLeft')
    expect((await companion.boundingBox())!.x).toBeLessThan(before!.x)
    await page.screenshot({ path: 'test-results/agent-companion.png', animations: 'disabled' })
    await companion.getByRole('button', { name: 'Minimize companion to Agent activity' }).click()
    await expect(companion).not.toBeVisible()
    await page.getByRole('button', { name: /Claude connected.*Show agent activity/ }).click()
    await expect(companion).toBeVisible()
    await companion.getByRole('button', { name: 'Chat with companion', exact: true }).click()
    await companion.getByRole('button', { name: 'End & clear', exact: true }).click()
    expect(errorOf(await agent.call('companion_chat', { session, wait_seconds: 0 }))).toContain('ended')
    // Ended: the conversation does not rejoin on its next call, nor by asking.
    expect(companionOf(await agent.call('get_context'))).toBeUndefined()
    expect(errorOf(await agent.call('companion_chat'))).toContain('Chat ended')
    await companion.getByRole('button', { name: 'Allow a new conversation', exact: true }).click()
    expect(companionOf(await agent.call('get_context'))?.status).toBe('joined')
    await expectAudit(s.userData, agent.calls, [
      'Please inspect my layout',
      'I’ll check the columns and spacing.'
    ])
  } finally {
    await s.close()
  }
})

test('ChatGPT has its own avatar and cannot consume another connection’s chat', async () => {
  const s = await startSession()
  const gpt = await startShim(s.userData, { name: 'codex', version: '1.0' })
  try {
    // The first call connects (no document is open here, so one that needs none).
    dataOf(await s.agent.call('list_documents'))
    const companion = s.page.getByRole('region', { name: 'AI companion' })
    await companion.getByRole('button', { name: 'Chat here', exact: true }).click()
    const { session } = dataOf(await s.agent.call('companion_chat'))
    expect(errorOf(await gpt.call('companion_chat', { session, wait_seconds: 0 }))).toContain(
      'another connection'
    )
    // Its conversation went away: the chat ends, and no other conversation joins until allowed.
    await s.agent.close()
    await expect(companion.getByRole('img', { name: 'OpenAI inspired companion' })).toBeVisible()
    await expect(companion).toContainText('Chat ended')
    expect(errorOf(await gpt.call('companion_chat'))).toContain('Chat ended')
    await companion.getByRole('button', { name: 'Allow a new conversation', exact: true }).click()
    const joined = dataOf(await gpt.call('companion_chat'))
    expect(joined.status).toBe('joined')
    await expect(companion).toContainText('Connected to ChatGPT')
    await gpt.close()
    await expect(companion).toContainText('Chat ended')
  } finally {
    await gpt.close()
    await s.close()
  }
})

test('an open chat stays on screen when every AI app disconnects, and closing it there lets nobody in', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  let gpt: Awaited<ReturnType<typeof startShim>> | undefined
  try {
    await waitForRender(s.page)
    dataOf(await s.agent.call('get_context'))
    const companion = s.page.getByRole('region', { name: 'AI companion' })
    await companion.getByRole('button', { name: 'Chat here', exact: true }).click()
    // The AI app quits before any conversation joins: the open chat stays where it can be closed.
    await s.agent.close()
    await expect(companion).toContainText('Connect your AI app to get started.')
    await expect(companion.getByText('Waiting for a conversation', { exact: true })).toBeVisible()
    await companion.getByRole('button', { name: 'Hide chat', exact: true }).click()
    gpt = await startShim(s.userData, { name: 'codex', version: '1.0' })
    expect(companionOf(await gpt.call('get_context'))).toBeUndefined()
    await expect(companion.getByRole('button', { name: 'Chat here', exact: true })).toBeVisible()
  } finally {
    await gpt?.close()
    await s.close()
  }
})

test('working poses advance gently and respect reduced motion', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    dataOf(await agent.call('get_context'))
    await page.evaluate(() => {
      const d = (window as any).__fartcrobat.getActiveDoc()
      const original = d.engine.call.bind(d.engine)
      d.engine.call = async (...args: any[]) => {
        if (args[0] === 'agent-text.layout') await new Promise<void>(resolve => { (window as any).__releaseLayout = resolve })
        return original(...args)
      }
    })
    const pending = agent.start('get_document_layout', { pages: '1' })
    const avatar = page.getByRole('img', { name: 'Claude pixel companion' })
    await expect(avatar).toHaveClass(/is-busy/)
    await expect.poll(() => avatar.getAttribute('data-pose')).not.toBe('0')
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await expect(avatar).toHaveAttribute('data-pose', '0')
    await page.evaluate(() => (window as any).__releaseLayout())
    dataOf(await pending)
    await expect(avatar).not.toHaveClass(/is-busy/)
  } finally { await s.close() }
})

/** The companion's saved place, as the settings store holds it. */
function savedPosition(page: Page) {
  return page.evaluate(() => (window as any).api.invoke('store:get', 'agent-companion-position')) as Promise<{
    x?: number
    y?: number
    minimized?: boolean
  } | null>
}

/** Presses at the middle of `target`, moves by (dx, dy) and lets go. */
async function dragBy(page: Page, target: Locator, dx: number, dy: number, steps = 8) {
  const b = (await target.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps })
  await page.mouse.up()
}

const boxOf = async (l: Locator) => (await l.boundingBox())!

test('the companion is dragged by any part that is not text, a click still opens its chat, and the place is kept', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    dataOf(await agent.call('get_context'))
    const companion = page.getByRole('region', { name: 'AI companion' })
    await expect(companion).toBeVisible()
    const avatar = companion.getByRole('button', { name: 'Chat with companion', exact: true })
    const start = await boxOf(companion)

    // Dragging the avatar moves the card and does not open the chat.
    await dragBy(page, avatar, -150, -100)
    await expect.poll(async () => (await boxOf(companion)).x).toBe(start.x - 150)
    expect((await boxOf(companion)).y).toBe(start.y - 100)
    await expect(companion.getByRole('button', { name: 'Chat here', exact: true })).toBeVisible()
    await expect(companion.getByRole('button', { name: 'Hide companion chat', exact: true })).toHaveCount(0)
    const moved = await boxOf(companion)
    await expect.poll(() => savedPosition(page)).toEqual({ x: moved.x, y: moved.y, minimized: false })

    // A press that moves less than the threshold is a click: the chat opens, the card stays.
    await dragBy(page, avatar, 2, 1, 2)
    await expect(companion.getByRole('button', { name: 'Hide companion chat', exact: true })).toBeVisible()
    expect((await boxOf(companion)).x).toBe(moved.x)
    // Text to read in the chat does not start a drag.
    await dragBy(page, companion.getByText(/Ask Claude or ChatGPT to use Fartcrobat/), -80, 0)
    expect((await boxOf(companion)).x).toBe(moved.x)
    // The chat head does, and dragging it leaves the chat open.
    await dragBy(page, companion.getByText('Waiting for a conversation', { exact: true }), 40, 0)
    await expect.poll(async () => (await boxOf(companion)).x).toBe(moved.x + 40)
    const head = companion.getByText('Waiting for a conversation', { exact: true })
    await expect(head).toBeVisible()
    // Escape during that drag puts the card back and leaves the chat open.
    const opened = await boxOf(companion)
    const h = await boxOf(head)
    await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2)
    await page.mouse.down()
    await page.mouse.move(h.x + h.width / 2 - 50, h.y + h.height / 2, { steps: 5 })
    await expect.poll(async () => (await boxOf(companion)).x).toBeLessThan(opened.x - 20)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await boxOf(companion)).x).toBe(opened.x)
    await page.mouse.up()
    await expect(head).toBeVisible()
    await companion.getByRole('button', { name: 'Hide chat', exact: true }).click()
    const here = await boxOf(companion)

    // Escape during a drag puts the card back, and the press does not click what it started on.
    const toggle = companion.getByRole('button', { name: 'Chat here', exact: true })
    const t = await boxOf(toggle)
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
    await page.mouse.down()
    await page.mouse.move(t.x + t.width / 2 - 60, t.y + t.height / 2 - 30, { steps: 5 })
    await expect.poll(async () => (await boxOf(companion)).x).toBeLessThan(here.x - 30)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await boxOf(companion)).x).toBe(here.x)
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2, { steps: 3 })
    await page.mouse.up()
    expect((await boxOf(companion)).x).toBe(here.x)
    await expect(toggle).toBeVisible()

    // The empty part of the card lets clicks through to what is underneath.
    const through = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y)
      return !!el && !el.closest('.fc-agent-access-companion')
    }, { x: here.x + 6, y: here.y + here.height - 6 })
    expect(through).toBe(true)

    // Keyboard: 16 px a press, 64 px with Shift, saved once the presses stop.
    const grip = companion.getByRole('button', { name: 'Move companion', exact: true })
    await grip.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowUp')
    await expect.poll(async () => (await boxOf(companion)).x).toBe(here.x + 16)
    expect((await boxOf(companion)).y).toBe(here.y - 64)
    await expect.poll(() => savedPosition(page)).toEqual({ x: here.x + 16, y: here.y - 64, minimized: false })

    // The place survives a reload of the window.
    await page.reload()
    await page.waitForSelector('.shell')
    await expect(companion).toBeVisible()
    await expect.poll(async () => (await boxOf(companion)).x).toBe(here.x + 16)
    expect((await boxOf(companion)).y).toBe(here.y - 64)
  } finally {
    await s.close()
  }
})

test('during a review the companion moves off the panel without saving that, and a drag there is honoured', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    const snapshot = dataOf(await agent.call('get_editable_text', { page: 1 }))
    const companion = page.getByRole('region', { name: 'AI companion' })
    await expect(companion).toBeVisible()
    const before = await boxOf(companion)
    const b = snapshot.blocks.find((b: any) => b.text.includes('quick brown fox'))
    const args = {
      revision: snapshot.revision,
      edits: [{ page: 1, block_id: b.block_id, original_text: b.text, text: b.text.replace('quick brown fox', 'swift brown fox') }]
    }
    const panel = page.locator('.fc-agent-access-inline-panel')
    const covers = async () => {
      const c = await boxOf(companion)
      const p = await boxOf(panel)
      return c.x < p.x + p.width && p.x < c.x + c.width && c.y < p.y + p.height && p.y < c.y + c.height
    }
    const declined = agent.start('edit_text', args)
    await expect(panel).toBeVisible()
    // The card started over the right panel: it shows to the panel's left.
    await expect.poll(covers).toBe(false)
    await expect(companion).toContainText('Your edits are ready to review on the page.')
    await panel.getByRole('button', { name: 'Discard batch', exact: true }).click()
    expect(errorOf(await finalOf(agent, declined))).toContain('[declined]')
    // The review is over: back where it was, and that move was never saved.
    await expect.poll(async () => (await boxOf(companion)).x).toBe(before.x)
    expect((await savedPosition(page))?.x).toBeUndefined()

    // A drag during a review puts the card where the person wants it, even over the panel.
    const again = agent.start('edit_text', args)
    await expect(panel).toBeVisible()
    await expect.poll(covers).toBe(false)
    const aside = await boxOf(companion)
    await dragBy(page, companion.getByRole('button', { name: 'Chat with companion', exact: true }), 120, 0)
    await expect.poll(async () => (await savedPosition(page))?.x).toBe(aside.x + 120)
    expect((await boxOf(companion)).x).toBe(aside.x + 120)
    expect(await covers()).toBe(true)
    await panel.getByRole('button', { name: 'Discard batch', exact: true }).click()
    expect(errorOf(await finalOf(agent, again))).toContain('[declined]')
    await expect(companion).not.toContainText('Your edits are ready to review on the page.')
    expect((await boxOf(companion)).x).toBe(aside.x + 120)
  } finally {
    await s.close()
  }
})
