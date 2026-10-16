import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activitySentence,
  endCompanion,
  exchangeCompanion,
  sendCompanionMessage,
  useCompanion
} from '@features/agent-access/ui/companionStore'

const base = {
  connectionId: 1,
  name: 'Claude',
  session: 'w1-chat-boot-test',
  signal: new AbortController().signal,
  waitMs: 0
}
const join = () => exchangeCompanion({ ...base, joining: true })
const listen = (patch: Partial<Parameters<typeof exchangeCompanion>[0]> = {}) =>
  exchangeCompanion({ ...base, joining: false, ...patch })
beforeEach(() => endCompanion())
afterEach(() => {
  endCompanion()
  vi.useRealTimers()
})

describe('companion conversations', () => {
  it('does not accept prompts without an active session', () => {
    expect(() => sendCompanionMessage('Read this')).toThrow(/Start companion/)
  })
  it('delivers only once and displays the reply associated with the user message', async () => {
    await join()
    sendCompanionMessage('Reflow my CV', 'CV.pdf')
    const result = await listen()
    expect(result).toMatchObject({ status: 'message', message: { text: 'Reflow my CV', document: 'CV.pdf' } })
    const id = useCompanion.getState().messages[0].id
    expect(await listen({ message: 'I will inspect the columns.', replyTo: id })).toMatchObject({
      status: 'idle'
    })
    expect(useCompanion.getState().messages[1].text).toBe('I will inspect the columns.')
    await expect(listen({ message: 'Replay', replyTo: id })).rejects.toThrow(/already has a reply/)
    await expect(listen({ message: 'Wrong message', replyTo: 9999 })).rejects.toThrow(/reply_to/)
  })
  it('isolates connections and old sessions, including reconnects', async () => {
    await join()
    sendCompanionMessage('Private question')
    await expect(listen({ connectionId: 2 })).rejects.toThrow(/another connection/)
    await expect(exchangeCompanion({ ...base, joining: true, connectionId: 2 })).rejects.toThrow(
      /Another AI app/
    )
    await expect(listen({ session: 'old' })).rejects.toThrow(/ended/)
    expect(useCompanion.getState().messages[0].delivered).toBeUndefined()
  })
  it('wakes on submission and rejects concurrent listeners', async () => {
    await join()
    const pending = listen({ waitMs: 30000 })
    expect(useCompanion.getState().listening).toBe(true)
    await expect(listen()).rejects.toThrow(/already running/)
    sendCompanionMessage('Hello')
    expect(await pending).toMatchObject({ status: 'message', message: { text: 'Hello' } })
    expect(useCompanion.getState().listening).toBe(false)
  })
  it('ends cleanly and clears messages when the person ends chat', async () => {
    await join()
    const pending = listen({ waitMs: 30000 })
    endCompanion()
    expect(await pending).toMatchObject({ status: 'ended' })
    expect(useCompanion.getState().messages).toEqual([])
    await expect(listen()).rejects.toThrow(/ended/)
  })
  it('cancels a wait without consuming a later message', async () => {
    await join()
    const controller = new AbortController()
    const pending = listen({ signal: controller.signal, waitMs: 30000 })
    controller.abort()
    await expect(pending).rejects.toThrow(/cancelled/)
    sendCompanionMessage('Still here')
    expect(await listen()).toMatchObject({ status: 'message' })
  })
  it('bounds pending prompts and text size', async () => {
    await join()
    expect(() => sendCompanionMessage('x'.repeat(8001))).toThrow(/8,000/)
    sendCompanionMessage('First')
    expect(() => sendCompanionMessage('Second')).toThrow(/still waiting/)
  })
  it('describes only observable tool activity', () => {
    expect(activitySentence()).toBe('Ready when you are.')
    expect(
      activitySentence({
        id: '1',
        client: 'Claude',
        tool: 'reflow_text',
        title: 'Reflow text',
        outcome: 'running',
        started: 0
      })
    ).toMatch(/columns and pages/)
    expect(
      activitySentence({
        id: '1',
        client: 'Claude',
        tool: 'edit_text',
        title: 'Edit text',
        outcome: 'declined',
        started: 0
      })
    ).toBe('You declined that change.')
  })
})
