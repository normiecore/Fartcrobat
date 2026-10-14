// Saved passwords: the unlock logic shared by every place that opens a protected file.
import { describe, expect, it } from 'vitest'
import { promptMessage, unlock, unlockAuditSummary, type AskState, type SavedCandidate, type UnlockPorts } from '@renderer/app/unlock'

function ports(o: {
  saved?: SavedCandidate[]
  correct: Record<string, 'user' | 'owner'>
  answers?: ({ password: string; remember: boolean } | null)[]
}) {
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
      return 'new-ref'
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
    expect(await unlock(p, { trySaved: true, remember: OFFER, prompt: true })).toEqual({ method: 'saved-password', level: 'user', ref: 'r1' })
    expect(log).toEqual(['find', 'attempt:pw', 'used:r1:user'])
    expect(asked).toEqual([])
  })

  it('a saved password that stopped working is forgotten, then the person is asked (and told why)', async () => {
    const { p, log, asked } = ports({
      saved: [{ ref: 'r1', password: 'old', via: 'id' }],
      correct: { new: 'user' },
      answers: [{ password: 'new', remember: true }]
    })
    expect(await unlock(p, { trySaved: true, remember: OFFER, prompt: true })).toEqual({
      method: 'typed',
      level: 'user',
      remembered: true,
      ref: 'new-ref'
    })
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
    expect(await unlock(p, { trySaved: true, remember: OFFER, prompt: true })).toMatchObject({ method: 'saved-password', ref: 'r3', level: 'owner' })
    expect(log).toEqual(['find', 'attempt:x', 'failed:r1', 'failed:r2', 'attempt:y', 'used:r3:owner'])
  })

  it('asks again after a wrong typed password; remembers only when ticked and offered', async () => {
    const a = ports({ correct: { right: 'user' }, answers: [{ password: 'nope', remember: true }, { password: 'right', remember: false }] })
    expect(await unlock(a.p, { trySaved: true, remember: OFFER, prompt: true })).toEqual({ method: 'typed', level: 'user', remembered: false })
    expect(a.asked.map((s) => s.wrong)).toEqual([false, true])
    expect(a.log).not.toContain('remember:right:user')

    const b = ports({ correct: { right: 'user' }, answers: [{ password: 'right', remember: true }] })
    const off = { offer: false as const, reason: 'To remember passwords on this computer, Fartcrobat needs GNOME Keyring or KWallet.' }
    expect(await unlock(b.p, { trySaved: true, remember: async () => off, prompt: true })).toMatchObject({ remembered: false })
    expect(b.asked[0].remember).toEqual(off)
  })

  it('remembering off: never looks up saved passwords; the offer is only fetched when asking', async () => {
    const { p, log } = ports({ saved: [{ ref: 'r1', password: 'pw', via: 'lock' }], correct: { pw: 'user' }, answers: [null] })
    let offers = 0
    const remember = async () => {
      offers++
      return { offer: false as const }
    }
    expect(await unlock(p, { trySaved: false, remember, prompt: true })).toBeNull()
    expect(log).not.toContain('find')
    expect(offers).toBe(1)
    const silent = ports({ saved: [{ ref: 'r1', password: 'pw', via: 'lock' }], correct: { pw: 'user' } })
    await unlock(silent.p, { trySaved: true, remember, prompt: true })
    expect(offers).toBe(1) // opened with the saved password: no prompt, no keyring question
  })

  it('without a prompt (prompt: false) gives up after saved passwords; cancel returns null; a given wrong password shows first', async () => {
    const { p } = ports({ saved: [], correct: {} })
    expect(await unlock(p, { trySaved: true, remember: OFFER, prompt: false })).toBeNull()
    const c = ports({ correct: {}, answers: [null] })
    expect(await unlock(c.p, { trySaved: true, remember: OFFER, prompt: true, wrong: true })).toBeNull()
    expect(c.asked[0]).toMatchObject({ wrong: true, savedStale: false })
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
    expect(unlockAuditSummary({ method: 'saved-password', level: 'user', ref: 'r1' })).toBe('unlocked with a password saved on this device')
    expect(unlockAuditSummary({ method: 'typed', level: 'owner', remembered: true })).toBe('the person typed the password')
    expect(unlockAuditSummary({ method: 'source', access: 'user' })).toBeUndefined()
    expect(unlockAuditSummary({ method: 'saved-password', access: 'owner', savedRef: 'r1' })).toBe('unlocked with a password saved on this device')
    expect(unlockAuditSummary(null)).toBeUndefined()
  })
})
