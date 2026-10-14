import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AuditLog, NOT_RECORDED, auditArgs, auditEntry, auditOutcome } from './audit'

describe('agent audit log', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fc-agent-audit-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('records argument names, and values only for handle, path, paths and pages', () => {
    const args = {
      handle: 'w1-b1-doc-2',
      pages: '1-3',
      path: '/home/me/out.pdf',
      paths: ['/home/me/a.pdf', '/home/me/b.pdf'],
      query: 'John Smith',
      items: [{ type: 'note', page: 1, rect: [0, 0, 10, 10], text: 'Secret comment' }],
      values: [{ name: 'SSN', value: '123-45-6789' }],
      overlay_text: 'CONFIDENTIAL',
      title: 'Merger plan'
    }
    const recorded = auditArgs(args)
    expect(recorded).toEqual({
      handle: 'w1-b1-doc-2',
      pages: '1-3',
      path: '/home/me/out.pdf',
      paths: ['/home/me/a.pdf', '/home/me/b.pdf'],
      query: NOT_RECORDED,
      items: NOT_RECORDED,
      values: NOT_RECORDED,
      overlay_text: NOT_RECORDED,
      title: NOT_RECORDED
    })
    const line = JSON.stringify(
      auditEntry({
        connection: 3,
        client: 'claude-ai',
        tool: 'add_annotations',
        args,
        result: { error: { code: 'invalid_args', message: 'No match for "John Smith"' } },
        started: 1000,
        finished: 1250
      })
    )
    for (const secret of [
      'John Smith',
      'Secret comment',
      '123-45-6789',
      'SSN',
      'CONFIDENTIAL',
      'Merger plan'
    ])
      expect(line).not.toContain(secret)
    expect(line).toContain('w1-b1-doc-2')
    expect(line).toContain('/home/me/out.pdf')
    expect(JSON.parse(line)).toMatchObject({
      connection: 3,
      client: 'claude-ai',
      tool: 'add_annotations',
      outcome: 'error',
      error: 'invalid_args',
      ms: 250
    })
  })

  it('never records objects hidden in the recorded arguments', () => {
    expect(auditArgs({ path: { text: 'secret' }, paths: ['/a.pdf', { text: 'secret' }] })).toEqual({
      path: NOT_RECORDED,
      paths: ['/a.pdf', NOT_RECORDED]
    })
    expect(auditArgs(null)).toEqual({})
    expect(auditArgs(['x'])).toEqual({})
  })

  it('takes the outcome from the error, or from what the window reported', () => {
    expect(auditOutcome({ data: 1 })).toBe('done')
    expect(auditOutcome({ error: { code: 'declined', message: '' } })).toBe('declined')
    expect(auditOutcome({ error: { code: 'cancelled', message: '' } })).toBe('cancelled')
    expect(auditOutcome({ error: { code: 'failed', message: '' } })).toBe('error')
    expect(auditOutcome({ error: { code: 'failed', message: '' } }, { outcome: 'done' })).toBe('error')
    expect(auditOutcome({ data: 1 }, { outcome: 'declined' })).toBe('declined')
    // An agent's cancel, whether the window or the router ended the call.
    expect(auditOutcome({ error: { code: 'aborted', message: '' } })).toBe('cancelled')
    expect(auditOutcome({ error: { code: 'aborted', message: '' } }, { outcome: 'cancelled' })).toBe(
      'cancelled'
    )
    // A call that answered still_running; its outcome is logged when wait_for_result returns it.
    expect(auditOutcome({ data: { status: 'still_running' } }, { outcome: 'pending' })).toBe('pending')
  })

  it('records which running call a wait_for_result collects', () => {
    expect(auditArgs({ ticket: 'w2-t3-b1', cancel: true })).toEqual({
      ticket: 'w2-t3-b1',
      cancel: NOT_RECORDED
    })
  })

  it('appends lines readable by this user only and keeps one rotated backup', async () => {
    const file = join(dir, 'agent-access', 'audit.jsonl')
    const log = new AuditLog(file, 400)
    const entry = (n: number) =>
      auditEntry({
        connection: 1,
        client: 'claude-ai',
        tool: 'get_context',
        args: { handle: `w1-b1-doc-${n}` },
        result: { data: {} },
        started: 0,
        finished: 1
      })
    await log.append(entry(1))
    await log.append(entry(2))
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(
      readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).args.handle)
    ).toEqual(['w1-b1-doc-1', 'w1-b1-doc-2'])
    for (let n = 3; n <= 12; n++) void log.append(entry(n))
    await log.flush()
    expect(existsSync(file + '.1')).toBe(true)
    expect(statSync(file).size).toBeLessThan(800)
    const all = [
      ...readFileSync(file + '.1', 'utf8')
        .trim()
        .split('\n'),
      ...readFileSync(file, 'utf8').trim().split('\n')
    ].map((l) => JSON.parse(l).args.handle)
    // The newest lines survive in order; the oldest went with the earlier backup.
    expect(all[all.length - 1]).toBe('w1-b1-doc-12')
    expect(all).toEqual([...all].sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop())))
  })

  it('creates an empty log to show in the file manager', async () => {
    const log = new AuditLog(join(dir, 'agent-access', 'audit.jsonl'))
    await log.ensure()
    expect(readFileSync(log.file, 'utf8')).toBe('')
    expect(statSync(log.file).mode & 0o777).toBe(0o600)
    await log.ensure()
  })
})
