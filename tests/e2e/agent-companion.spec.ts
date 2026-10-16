import { test, expect } from '@playwright/test'
import { fixturePath, waitForRender } from './helpers'
import { startSession, startShim, dataOf, errorOf, expectAudit } from './agent-helpers'

test('companion chats with its owner, moves, minimizes and ends cleanly', async () => {
  const s = await startSession([fixturePath('text.pdf')])
  try {
    const { page, agent } = s
    await waitForRender(page)
    const companion = page.getByRole('region', { name: 'AI companion' })
    await expect(companion).toBeVisible()
    await companion.getByRole('button', { name: 'Chat with companion', exact: true }).click()
    await expect(companion.getByText('Start companion chat', { exact: true })).toBeVisible()
    const { session } = dataOf(await agent.call('companion_chat'))
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
    const { session } = dataOf(await s.agent.call('companion_chat'))
    expect(errorOf(await gpt.call('companion_chat', { session, wait_seconds: 0 }))).toContain(
      'another connection'
    )
    await s.agent.close()
    const companion = s.page.getByRole('region', { name: 'AI companion' })
    await expect(companion.getByRole('img', { name: 'OpenAI inspired companion' })).toBeVisible()
    const joined = dataOf(await gpt.call('companion_chat'))
    expect(joined.status).toBe('joined')
    await companion.getByRole('button', { name: 'Chat with companion', exact: true }).click()
    await expect(companion).toContainText('ChatGPT session joined')
    await gpt.close()
    await expect(companion).toContainText('Start companion chat')
  } finally {
    await gpt.close()
    await s.close()
  }
})
