import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activitySentence,
  allowNewConversation,
  armCompanion,
  autoJoinCompanion,
  disarmCompanion,
  endCompanion,
  exchangeCompanion,
  followConnections,
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
// As the app starts, then the person opens the chat.
const fresh = () =>
  useCompanion.setState({ owner: null, listening: false, messages: [], autoJoin: false, ended: false, revealed: false })
beforeEach(() => {
  fresh()
  armCompanion()
})
afterEach(() => {
  endCompanion()
  vi.useRealTimers()
})

describe('companion conversations', () => {
  it('closing the chat before a conversation joins takes the opening back; opening it again lets one in', () => {
    disarmCompanion()
    expect(autoJoinCompanion(1, 'Claude', 'w1-chat-a')).toBeUndefined()
    armCompanion()
    expect(autoJoinCompanion(1, 'Claude', 'w1-chat-a')?.status).toBe('joined')
    // A joined chat stays joined when it is hidden.
    disarmCompanion()
    expect(useCompanion.getState().owner?.session).toBe('w1-chat-a')
    // An ended chat stays ended: hiding and reopening it does not allow a new conversation.
    endCompanion()
    disarmCompanion()
    armCompanion()
    expect(autoJoinCompanion(1, 'Claude', 'w1-chat-b')).toBeUndefined()
  })
  it('takes the opening back when every AI app goes away before a conversation joins', () => {
    // The chat was opened while an app was connected.
    expect(followConnections([1])).toBeUndefined()
    expect(useCompanion.getState().autoJoin).toBe(true)
    // The last app disconnects: the companion leaves the screen, and the open chat with it.
    expect(followConnections([])).toBe('hidden')
    // Later another app connects: its first call does not join a chat nobody can see.
    expect(followConnections([2])).toBeUndefined()
    expect(autoJoinCompanion(2, 'ChatGPT', 'w1-chat-later')).toBeUndefined()
    armCompanion()
    expect(autoJoinCompanion(2, 'ChatGPT', 'w1-chat-later')?.status).toBe('joined')
  })
  it('keeps the opening while the companion is shown, and ends the chat when its conversation goes away', () => {
    // Shown from Preferences or Agent activity, the companion stays on screen with no app connected.
    useCompanion.setState({ revealed: true })
    expect(followConnections([])).toBeUndefined()
    expect(autoJoinCompanion(1, 'Claude', 'w1-chat-a')?.status).toBe('joined')
    expect(followConnections([1, 2])).toBeUndefined()
    expect(useCompanion.getState().owner?.session).toBe('w1-chat-a')
    expect(followConnections([2])).toBe('ended')
    expect(useCompanion.getState()).toMatchObject({ owner: null, autoJoin: false, ended: true })
    expect(followConnections([])).toBeUndefined()
    expect(autoJoinCompanion(2, 'ChatGPT', 'w1-chat-b')).toBeUndefined()
  })
  it('does not accept prompts without an active session', () => {
    expect(() => sendCompanionMessage('Read this')).toThrow(/use a Fartcrobat tool/)
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
      /Another conversation/
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
  it('never leaks an existing token to another chat on the same connection', async () => {
    expect(autoJoinCompanion(1, 'Claude', 'first')).toMatchObject({ session: 'first' })
    sendCompanionMessage('Private question')
    expect(autoJoinCompanion(1, 'Claude', 'second')).toBeUndefined()
    expect(autoJoinCompanion(2, 'ChatGPT', 'third')).toBeUndefined()
    await expect(join()).rejects.toThrow(/Another conversation/)
    expect(useCompanion.getState().messages[0].delivered).toBeUndefined()
  })
  it('lets no conversation join until the person opens the chat', async () => {
    fresh()
    expect(autoJoinCompanion(1, 'Claude', 'first')).toBeUndefined()
    await expect(join()).rejects.toThrow(/Chat here/)
    armCompanion()
    expect(autoJoinCompanion(1, 'Claude', 'first')).toMatchObject({ session: 'first' })
  })
  it('respects End & clear until the user allows a new conversation', async () => {
    autoJoinCompanion(1, 'Claude', 'first')
    endCompanion()
    expect(autoJoinCompanion(1, 'Claude', 'second')).toBeUndefined()
    await expect(join()).rejects.toThrow(/Chat ended/)
    // Opening the chat again does not undo the end; only allowing a new conversation does.
    armCompanion()
    expect(autoJoinCompanion(1, 'Claude', 'second')).toBeUndefined()
    allowNewConversation()
    expect(autoJoinCompanion(1, 'Claude', 'second')).toMatchObject({ session: 'second' })
  })
  it('lets one conversation join per opening of the chat', () => {
    expect(autoJoinCompanion(1, 'Claude', 'first')).toMatchObject({ session: 'first' })
    expect(useCompanion.getState().autoJoin).toBe(false)
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
