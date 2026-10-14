// Port target: tests/engine/core-unlock.test.ts
import { describe, expect, it } from 'vitest'
import { promptMessage, unlock, unlockAuditSummary, type AskState, type SavedCandidate, type UnlockPorts } from '../src/unlock.ts'

function ports(o: { saved?: SavedCandidate[]; correct: Record<string, 'user' | 'owner'>; answers?: ({ password: string; remember: boolean } | null)[] }) {
  const log: string[] = []
  const asked: AskState[] = []
  const answers = [...(o.answers ?? [])]
  const p: UnlockPorts = {
    async find() {
      log.push('find')
      return o.saved ?? []
    },
    async attempt(pw) {
      log.push(`attempt:${pw}`)
      return o.correct[pw] ?? null
    },
    async used(ref, level) {
      log.push(`used:${ref}:${level}`)
    },
    async failed(ref) {
      log.push(`failed:${ref}`)
    },
    async remember(pw, level) {
      log.push(`remember:${pw}:${level}`)
    },
    async ask(state) {
      asked.push(state)
      return answers.shift() ?? null
    }
  }
  return { p, log, asked }
}

const OFFER = { offer: true as const, checked: true }

describe('unlock', () => {
  it('opens silently with a saved password', async () => {
    const { p, log, asked } = ports({ saved: [{ ref: 'r1', password: 'pw', via: 'lock' }], correct: { pw: 'user' } })
    expect(await unlock(p, { trySaved: true, remember: OFFER, prompt: true })).toEqual({ method: 'saved', level: 'user', ref: 'r1' })
    expect(log).toEqual(['find', 'attempt:pw', 'used:r1:user'])
    expect(asked).toEqual([])
  })

  it('a saved password that stopped working is forgotten, then the person is asked (and told why)', async () => {
    const { p, log, asked } = ports({
      saved: [{ ref: 'r1', password: 'old', via: 'id' }],
      correct: { new: 'user' },
      answers: [{ password: 'new', remember: true }]
    })
    expect(await unlock(p, { trySaved: true, remember: OFFER, prompt: true })).toEqual({ method: 'typed', level: 'user', remembered: true })
    expect(log).toEqual(['find', 'attempt:old', 'failed:r1', 'attempt:new', 'remember:new:user'])
    expect(asked).toEqual([{ wrong: false, savedStale: true, remember: OFFER }])
    expect(promptMessage('a.pdf', asked[0])).toContain('no longer opens it')
  })

  it('tries each distinct saved password once; duplicates of a wrong one are only unlinked', async () => {
    const { p, log } = ports({
      saved: [
        { ref: 'r1', password: 'x', via: 'lock' },
        { ref: 'r2', password: 'x', via: 'id' },
        { ref: 'r3', password: 'y', via: 'path' }
      ],
      correct: { y: 'owner' }
    })
    expect(await unlock(p, { trySaved: true, remember: OFFER, prompt: true })).toMatchObject({ method: 'saved', ref: 'r3', level: 'owner' })
    expect(log).toEqual(['find', 'attempt:x', 'failed:r1', 'failed:r2', 'attempt:y', 'used:r3:owner'])
  })

  it('asks again after a wrong typed password; remembers only when ticked and offered', async () => {
    const a = ports({ correct: { right: 'user' }, answers: [{ password: 'nope', remember: true }, { password: 'right', remember: false }] })
    expect(await unlock(a.p, { trySaved: true, remember: OFFER, prompt: true })).toEqual({ method: 'typed', level: 'user', remembered: false })
    expect(a.asked.map((s) => s.wrong)).toEqual([false, true])
    expect(a.log).not.toContain('remember:right:user')

    const b = ports({ correct: { right: 'user' }, answers: [{ password: 'right', remember: true }] })
    const off = { offer: false as const, reason: 'Remembering passwords needs a keyring (GNOME Keyring or KWallet).' }
    expect(await unlock(b.p, { trySaved: true, remember: off, prompt: true })).toMatchObject({ remembered: false })
    expect(b.asked[0].remember).toEqual(off)
  })

  it('policy off: never looks up saved passwords', async () => {
    const { p, log } = ports({ saved: [{ ref: 'r1', password: 'pw', via: 'lock' }], correct: { pw: 'user' }, answers: [null] })
    expect(await unlock(p, { trySaved: false, remember: { offer: false }, prompt: true })).toBeNull()
    expect(log).not.toContain('find')
  })

  it('without a prompt (prompt: false) gives up after saved passwords; cancel returns null', async () => {
    const { p } = ports({ saved: [], correct: {} })
    expect(await unlock(p, { trySaved: true, remember: OFFER, prompt: false })).toBeNull()
    const c = ports({ correct: {}, answers: [null] })
    expect(await unlock(c.p, { trySaved: true, remember: OFFER, prompt: true })).toBeNull()
  })

  it('a failing store never blocks opening', async () => {
    const { p } = ports({ correct: { pw: 'user' }, answers: [{ password: 'pw', remember: true }] })
    p.find = async () => {
      throw new Error('store broken')
    }
    p.remember = async () => {
      throw new Error('disk full')
    }
    expect(await unlock(p, { trySaved: true, remember: OFFER, prompt: true })).toEqual({ method: 'typed', level: 'user', remembered: false })
  })

  it('audit summaries never contain the password', () => {
    expect(unlockAuditSummary({ method: 'saved', level: 'user', ref: 'r1' })).toBe('unlocked with a password saved on this device')
    expect(unlockAuditSummary({ method: 'typed', level: 'owner', remembered: true })).toBe('unlocked with a password the person typed')
    expect(unlockAuditSummary(null)).toBeUndefined()
  })
})
