// What the companion and the activity list select from the agent-access window store.
import { beforeEach, describe, expect, it } from 'vitest'
import { callFinished, callStarted, latestCall, timeLabel, useAgentUi } from '@features/agent-access/ui/store'

const start = (id: string, tool = 'get_page_text') =>
  callStarted({ id, tool, title: tool, client: 'Claude', started: Date.UTC(2026, 9, 20, 10, 42, 7) })

beforeEach(() => useAgentUi.setState({ status: null, calls: [], running: 0 }))

describe('latestCall', () => {
  it('skips the chat calls and, once a conversation joined, other connections', () => {
    start('1:1', 'get_context')
    start('2:1', 'find_text')
    start('1:2', 'companion_chat')
    start('1:3', 'wait_for_result')
    const calls = useAgentUi.getState().calls
    expect(latestCall(calls)?.id).toBe('2:1')
    expect(latestCall(calls, 1)?.id).toBe('1:1')
    expect(latestCall(calls, 3)).toBeUndefined()
  })

  it('keeps returning the same record until that call changes, so a selector does not re-render', () => {
    start('1:1')
    const first = latestCall(useAgentUi.getState().calls, 1)
    // another connection's call starts and finishes: the owner's latest call is the same object
    start('2:1')
    callFinished('2:1', { outcome: 'done', ms: 5 })
    expect(latestCall(useAgentUi.getState().calls, 1)).toBe(first)
    callFinished('1:1', { outcome: 'done', ms: 9 })
    const done = latestCall(useAgentUi.getState().calls, 1)
    expect(done).not.toBe(first)
    expect(done?.outcome).toBe('done')
  })
})

describe('timeLabel', () => {
  it('formats with and without seconds, as toLocaleTimeString does', () => {
    const ms = Date.UTC(2026, 9, 20, 10, 42, 7)
    expect(timeLabel(ms)).toBe(new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }))
    expect(timeLabel(ms, false)).toBe(new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))
    expect(timeLabel(ms, false)).not.toBe(timeLabel(ms))
  })
})
