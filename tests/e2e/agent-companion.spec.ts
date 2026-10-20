import { test, expect } from '@playwright/test'
import { fixturePath, waitForRender } from './helpers'
import { startSession, startShim, dataOf, errorOf, expectAudit } from './agent-helpers'

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
