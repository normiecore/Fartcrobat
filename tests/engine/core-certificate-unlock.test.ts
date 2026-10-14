// Certificate encryption: the unlock logic shared by every place that opens a certificate-encrypted
// file (tabs, Revert, Insert, Combine, Create, Compare, agents), with fake ports for the main
// process (certkeys:probe/decrypt), the engine and the dialogs.
import { describe, expect, it } from 'vitest'
import type { CertKeyCandidate, CertKeysDecryptRequest, CertKeysDecryptResult, CertKeyVia, PubSecRecipient, WindowsStoreState } from '@shared/certkeys'
import { certificateFailure, openErrorCode } from '@features/agent-access/tools/act-files'
import { protectionDetails, protectionNote } from '@features/organize-pages/protection'
import {
  certificateAccess,
  commonName,
  digitalIdPromptMessage,
  noCertificateMessage,
  orderCandidates,
  unlockAuditSummary,
  unlockCertificate,
  unlockCertificateOutcome,
  unsupportedKeyMessage,
  type CertAskState,
  type CertProblem,
  type CertUnlockOptions,
  type CertUnlockPorts,
  type RememberOffer
} from '@renderer/app/unlock'

const SEED = new Uint8Array(20).fill(7)

function candidate(id: string, o: Partial<CertKeyCandidate> = {}): CertKeyCandidate {
  const source = id.startsWith('windows-store:') ? 'windows-store' : 'digital-id'
  return {
    id,
    source,
    label: o.label ?? id.split(':')[1],
    subject: `CN=${o.label ?? id.split(':')[1]}`,
    issuer: 'CN=Test CA, O=Fartcrobat Tests',
    fingerprint: id.split(':')[1].toUpperCase(),
    envelope: 0,
    index: 0,
    needs: source === 'windows-store' ? 'nothing' : 'password',
    hardware: false,
    keyType: 'rsa',
    ...o
  }
}

function via(c: CertKeyCandidate, extra: Partial<CertKeyVia> = {}): CertKeyVia {
  return { source: c.source, label: c.label, subject: c.subject, fingerprint: c.fingerprint, hardware: !!c.hardware, ...extra }
}

function ok(c: CertKeyCandidate, o: { permissions?: number | null; envelope?: number; via?: Partial<CertKeyVia> } = {}): CertKeysDecryptResult {
  return { ok: true, envelope: o.envelope ?? 0, seed: SEED, permissions: o.permissions === undefined ? null : o.permissions, via: via(c, o.via) }
}

function fail(code: Extract<CertKeysDecryptResult, { ok: false }>['code'], extra: { savedStale?: boolean; message?: string } = {}): CertKeysDecryptResult {
  return { ok: false, code, message: extra.message ?? '', ...(extra.savedStale ? { savedStale: true } : {}) }
}

interface Script {
  /** Probe results in order (the last one repeats). */
  probes: { candidates: CertKeyCandidate[]; recipients?: PubSecRecipient[]; windowsStore?: WindowsStoreState }[]
  /** Answers of certkeys:decrypt by candidate id, in order (the last one repeats). */
  decrypt: Record<string, CertKeysDecryptResult[] | ((req: Omit<CertKeysDecryptRequest, 'blobs'>) => CertKeysDecryptResult)>
  /** Answers of the Digital ID prompt, in order. Without `remember`, the box is left as shown. */
  answers?: ({ password: string; remember?: boolean } | null)[]
  /** Answers to problems, in order (default 'cancel'). */
  problems?: ('retry' | 'cancel')[]
  /** Answers to "no key" (default 'cancel'). */
  noKey?: ('add' | 'cancel')[]
  /** The engine refuses these envelopes. */
  refuse?: number[]
}

function ports(script: Script) {
  const log: string[] = []
  const requests: Omit<CertKeysDecryptRequest, 'blobs'>[] = []
  const asked: CertAskState[] = []
  const problems: CertProblem[] = []
  const noKeys: Parameters<CertUnlockPorts['noKey']>[0][] = []
  const answers = [...(script.answers ?? [])]
  const problemAnswers = [...(script.problems ?? [])]
  const noKeyAnswers = [...(script.noKey ?? [])]
  const counts: Record<string, number> = {}
  let probes = 0
  const p: CertUnlockPorts = {
    async probe() {
      log.push('probe')
      const r = script.probes[Math.min(probes++, script.probes.length - 1)]
      return { candidates: r.candidates, recipients: r.recipients ?? [], ...(r.windowsStore ? { windowsStore: r.windowsStore } : {}) }
    },
    async decrypt(req) {
      requests.push(req)
      log.push(`decrypt:${req.candidate}${req.password !== undefined ? `:${req.password}` : ''}`)
      const plan = script.decrypt[req.candidate]
      if (!plan) throw new Error(`unexpected decrypt ${req.candidate}`)
      if (typeof plan === 'function') return plan(req)
      const n = (counts[req.candidate] = (counts[req.candidate] ?? -1) + 1)
      return plan[Math.min(n, plan.length - 1)]
    },
    async attempt(res) {
      log.push(`attempt:${res.envelope}`)
      return !(script.refuse ?? []).includes(res.envelope)
    },
    async askPassword(state) {
      asked.push(state)
      log.push(`ask:${state.candidate.id}`)
      const a = answers.shift()
      if (!a) return null
      return { password: a.password, remember: a.remember ?? (state.remember.offer && state.remember.checked) }
    },
    async problem(problem) {
      problems.push(problem)
      log.push(`problem:${problem.code}`)
      return problemAnswers.shift() ?? 'cancel'
    },
    async noKey(state) {
      noKeys.push(state)
      log.push('noKey')
      return noKeyAnswers.shift() ?? 'cancel'
    },
    async addDigitalId() {
      log.push('add')
    }
  }
  return { p, log, requests, asked, problems, noKeys }
}

const OFFER: RememberOffer = { offer: true, checked: true }
const OPTS: CertUnlockOptions = { name: 'secret.pdf', actor: 'person', remember: OFFER, canAddDigitalId: true }

describe('orderCandidates', () => {
  it('store keys that need nothing, Digital IDs with a saved password, hardware keys, then prompts; RSA only, each once', () => {
    const soft = candidate('windows-store:aa', { hardware: false })
    const unknown = candidate('windows-store:bb', { hardware: null })
    const card = candidate('windows-store:cc', { hardware: true, needs: 'pin' })
    const pinOnly = candidate('windows-store:dd', { hardware: null, needs: 'pin' })
    const saved = candidate('digital-id:11', { passwordSaved: true })
    const typed = candidate('digital-id:22')
    const ec = candidate('digital-id:33', { keyType: 'ec' })
    const noPassword = candidate('digital-id:55', { needs: 'nothing' })
    const order = orderCandidates([typed, card, saved, ec, soft, pinOnly, unknown, { ...soft, envelope: 1 }, noPassword])
    expect(order.silent.map((c) => c.id)).toEqual(['windows-store:aa', 'windows-store:bb', 'digital-id:11', 'digital-id:55'])
    expect(order.hardware.map((c) => c.id)).toEqual(['windows-store:cc', 'windows-store:dd'])
    expect(order.prompt.map((c) => c.id)).toEqual(['digital-id:22'])
  })
})

describe('unlockCertificate', () => {
  it('opens silently with a Windows store key that needs nothing, before anything else', async () => {
    const store = candidate('windows-store:aa')
    const saved = candidate('digital-id:11', { passwordSaved: true })
    const { p, log, asked } = ports({ probes: [{ candidates: [saved, store] }], decrypt: { [store.id]: [ok(store, { permissions: 0xfffff0c4 })] } })
    const r = await unlockCertificate(p, OPTS)
    expect(r).toMatchObject({ via: { source: 'windows-store', label: 'aa' }, access: 'user' })
    expect(r!.result.seed).toBe(SEED)
    expect(log).toEqual(['probe', 'decrypt:windows-store:aa', 'attempt:0'])
    expect(asked).toEqual([])
  })

  it('opens silently with a Digital ID whose password is saved', async () => {
    const saved = candidate('digital-id:11', { passwordSaved: true })
    const { p, log, asked, requests } = ports({
      probes: [{ candidates: [saved] }],
      decrypt: { [saved.id]: [ok(saved, { via: { savedPassword: true } })] }
    })
    const r = await unlockCertificate(p, OPTS)
    expect(r).toMatchObject({ via: { source: 'digital-id', savedPassword: true }, access: 'owner' })
    expect(log).toEqual(['probe', 'decrypt:digital-id:11', 'attempt:0'])
    expect(requests[0]).toEqual({ candidate: saved.id, actor: 'person' })
    expect(asked).toEqual([])
    expect(unlockAuditSummary({ method: 'certificate', access: 'owner', via: r!.via })).toBe('opened with Digital ID 11 (password saved on this device)')
  })

  it('passes the actor to every decrypt (agents unlock like the person)', async () => {
    const store = candidate('windows-store:aa', { label: 'Alice Test', subject: 'CN=Alice Test' })
    const typed = candidate('digital-id:22')
    const { p, requests } = ports({
      probes: [{ candidates: [store, typed] }],
      decrypt: { [store.id]: [fail('NO_MATCHING_CERT')], [typed.id]: [ok(typed)] },
      answers: [{ password: 'pw' }]
    })
    expect(await unlockCertificate(p, { ...OPTS, actor: 'agent' })).not.toBeNull()
    expect(requests.map((r) => r.actor)).toEqual(['agent', 'agent'])
    expect(requests[1]).toEqual({ candidate: typed.id, password: 'pw', remember: true, actor: 'agent' })
  })

  it('asks for a Digital ID password, with Remember, and passes the choice on', async () => {
    const typed = candidate('digital-id:22', { label: 'Alice Test' })
    const { p, asked, requests } = ports({
      probes: [{ candidates: [typed] }],
      decrypt: { [typed.id]: [ok(typed, { via: { remembered: true } })] },
      answers: [{ password: 'alice-pass', remember: true }]
    })
    const r = await unlockCertificate(p, OPTS)
    expect(r).toMatchObject({ via: { remembered: true } })
    expect(asked).toEqual([{ candidate: typed, wrong: false, savedStale: false, remember: OFFER }])
    expect(requests).toEqual([{ candidate: typed.id, password: 'alice-pass', remember: true, actor: 'person' }])
    expect(digitalIdPromptMessage('secret.pdf', asked[0])).toBe('Enter the password of your Digital ID “Alice Test” to open “secret.pdf”.')
    expect(digitalIdPromptMessage('a.pdf', asked[0], 'to compare “a.pdf”')).toBe('Enter the password of your Digital ID “Alice Test” to compare “a.pdf”.')
  })

  it('never remembers when Remember is not offered, and asks for the offer only when prompting', async () => {
    const typed = candidate('digital-id:22')
    let offered = 0
    const { p, requests, asked } = ports({ probes: [{ candidates: [typed] }], decrypt: { [typed.id]: [ok(typed)] }, answers: [{ password: 'pw', remember: true }] })
    const remember = async (): Promise<RememberOffer> => {
      offered++
      return { offer: false, reason: 'No keyring' }
    }
    await unlockCertificate(p, { ...OPTS, remember })
    expect(offered).toBe(1)
    expect(asked[0].remember).toEqual({ offer: false, reason: 'No keyring' })
    expect(requests[0].remember).toBe(false)

    const silent = candidate('digital-id:11', { passwordSaved: true })
    const again = ports({ probes: [{ candidates: [silent] }], decrypt: { [silent.id]: [ok(silent)] } })
    await unlockCertificate(again.p, { ...OPTS, remember })
    expect(offered).toBe(1)
  })

  it('a wrong password asks again ("The password is incorrect. Try again."), keeping the Remember choice', async () => {
    const typed = candidate('digital-id:22')
    const { p, asked, requests } = ports({
      probes: [{ candidates: [typed] }],
      decrypt: { [typed.id]: [fail('WRONG_PASSWORD'), fail('WRONG_PASSWORD'), ok(typed)] },
      answers: [{ password: 'a', remember: false }, { password: 'b' }, { password: 'c' }]
    })
    expect(await unlockCertificate(p, OPTS)).not.toBeNull()
    expect(asked.map((a) => [a.wrong, a.remember])).toEqual([
      [false, OFFER],
      [true, { offer: true, checked: false }],
      [true, { offer: true, checked: false }]
    ])
    expect(digitalIdPromptMessage('secret.pdf', asked[1])).toBe('The password is incorrect. Try again.')
    expect(requests.map((r) => [r.password, r.remember])).toEqual([
      ['a', false],
      ['b', false],
      ['c', false]
    ])
  })

  it('cancelling the Digital ID prompt stops', async () => {
    const typed = candidate('digital-id:22')
    const other = candidate('digital-id:33')
    const { p, log } = ports({ probes: [{ candidates: [typed, other] }], decrypt: {}, answers: [null] })
    expect(await unlockCertificate(p, OPTS)).toBeNull()
    expect(log).toEqual(['probe', 'ask:digital-id:22'])
  })

  it('a saved password that no longer works: the person is asked, and told why', async () => {
    const saved = candidate('digital-id:11', { passwordSaved: true, label: 'Alice Test' })
    const { p, asked, log } = ports({
      probes: [{ candidates: [saved] }],
      decrypt: { [saved.id]: [fail('PASSWORD_NEEDED', { savedStale: true }), fail('WRONG_PASSWORD'), ok(saved)] },
      answers: [{ password: 'x' }, { password: 'alice-pass' }]
    })
    expect(await unlockCertificate(p, OPTS)).not.toBeNull()
    expect(log).toEqual(['probe', 'decrypt:digital-id:11', 'ask:digital-id:11', 'decrypt:digital-id:11:x', 'ask:digital-id:11', 'decrypt:digital-id:11:alice-pass', 'attempt:0'])
    expect(asked.map((a) => [a.savedStale, a.wrong])).toEqual([
      [true, false],
      [false, true]
    ])
    expect(digitalIdPromptMessage('secret.pdf', asked[0])).toBe(
      'The password saved for your Digital ID “Alice Test” no longer works and was forgotten. Enter the password of your Digital ID “Alice Test” to open “secret.pdf”.'
    )
  })

  it('a saved password that is not used (remembering turned off) prompts without saying it is stale', async () => {
    const saved = candidate('digital-id:11', { passwordSaved: true })
    const { p, asked } = ports({ probes: [{ candidates: [saved] }], decrypt: { [saved.id]: [fail('PASSWORD_NEEDED'), ok(saved)] }, answers: [{ password: 'pw' }] })
    expect(await unlockCertificate(p, OPTS)).not.toBeNull()
    expect(asked[0]).toMatchObject({ savedStale: false, wrong: false })
  })

  it('CANCELLED from the Windows helper (or from waiting) stops without trying other keys', async () => {
    const card = candidate('windows-store:cc', { hardware: true, needs: 'pin' })
    const typed = candidate('digital-id:22')
    const { p, log, problems, asked } = ports({ probes: [{ candidates: [card, typed] }], decrypt: { [card.id]: [fail('CANCELLED')] } })
    expect(await unlockCertificate(p, OPTS)).toBeNull()
    expect(log).toEqual(['probe', 'decrypt:windows-store:cc'])
    expect(problems).toEqual([])
    expect(asked).toEqual([])
  })

  it('a wrong PIN offers Try Again, which tries the card again', async () => {
    const card = candidate('windows-store:cc', { hardware: true, needs: 'pin', label: 'Alice Card' })
    const { p, log, problems } = ports({
      probes: [{ candidates: [card] }],
      decrypt: { [card.id]: [fail('WRONG_PIN', { message: 'The PIN is incorrect. 2 tries left.' }), ok(card, { via: { hardware: true } })] },
      problems: ['retry']
    })
    const r = await unlockCertificate(p, OPTS)
    expect(r).toMatchObject({ via: { source: 'windows-store', hardware: true } })
    expect(problems).toEqual([{ candidate: card, code: 'WRONG_PIN', message: 'The PIN is incorrect. 2 tries left.', canRetry: true }])
    expect(log).toEqual(['probe', 'decrypt:windows-store:cc', 'problem:WRONG_PIN', 'decrypt:windows-store:cc', 'attempt:0'])
  })

  it('a missing card or a timeout can be retried; a blocked PIN or a locked-down PowerShell cannot', async () => {
    for (const [code, canRetry] of [
      ['CARD_NOT_PRESENT', true],
      ['KEY_UNAVAILABLE', true],
      ['TIMEOUT', true],
      ['PIN_BLOCKED', false],
      ['CONSTRAINED_LANGUAGE', false],
      ['POWERSHELL_UNAVAILABLE', false]
    ] as const) {
      const card = candidate('windows-store:cc', { hardware: true, needs: 'pin' })
      const { p, problems } = ports({ probes: [{ candidates: [card] }], decrypt: { [card.id]: [fail(code)] } })
      expect(await unlockCertificate(p, OPTS)).toBeNull()
      expect(problems.map((x) => [x.code, x.canRetry])).toEqual([[code, canRetry]])
      // Main's message, or a plain default when it gave none.
      expect(problems[0].message.length).toBeGreaterThan(10)
    }
  })

  // A store found locked down only when a key is used (the probe goes through the same helper, so
  // usually the probe's windowsStore says so instead: see the no-match message below).
  it('after a key problem the next key is tried: a locked-down store falls through to a Digital ID', async () => {
    const store = candidate('windows-store:aa')
    const card = candidate('windows-store:cc', { hardware: true, needs: 'pin' })
    const typed = candidate('digital-id:22')
    const { p, log } = ports({
      probes: [{ candidates: [store, card, typed] }],
      decrypt: {
        [store.id]: [fail('CONSTRAINED_LANGUAGE', { message: 'PowerShell is locked down.' })],
        [card.id]: [fail('PIN_BLOCKED', { message: 'Blocked.' })],
        [typed.id]: [ok(typed)]
      },
      answers: [{ password: 'pw' }]
    })
    expect(await unlockCertificate(p, OPTS)).toMatchObject({ via: { source: 'digital-id' } })
    expect(log).toEqual([
      'probe',
      'decrypt:windows-store:aa',
      'problem:CONSTRAINED_LANGUAGE',
      'decrypt:windows-store:cc',
      'problem:PIN_BLOCKED',
      'ask:digital-id:22',
      'decrypt:digital-id:22:pw',
      'attempt:0'
    ])
  })

  it('a key the engine refuses is reported and the next key is tried', async () => {
    const a = candidate('digital-id:11', { passwordSaved: true })
    const b = candidate('windows-store:aa')
    const { p, problems, log } = ports({
      probes: [{ candidates: [a, b] }],
      decrypt: { [b.id]: [ok(b, { envelope: 1 })], [a.id]: [ok(a, { envelope: 1 })] },
      refuse: [1]
    })
    expect(await unlockCertificate(p, OPTS)).toBeNull()
    expect(log).toEqual(['probe', 'decrypt:windows-store:aa', 'attempt:1', 'problem:ERROR', 'decrypt:digital-id:11', 'attempt:1', 'problem:ERROR'])
    expect(problems[0].message).toBe('The key of “aa” did not open “secret.pdf”. The file may be damaged.')
  })

  it('no matching key: says who the file is encrypted for and offers Add Digital ID, then probes again', async () => {
    const alice = candidate('digital-id:22')
    const recipients: PubSecRecipient[] = [
      { envelope: 0, index: 0, idType: 'issuerAndSerialNumber', issuer: 'CN=Contoso CA, O=Contoso', serial: '1A2B', keyType: 'rsa' }
    ]
    const { p, log, noKeys } = ports({
      probes: [{ candidates: [], recipients }, { candidates: [alice], recipients }],
      decrypt: { [alice.id]: [ok(alice)] },
      noKey: ['add'],
      answers: [{ password: 'pw' }]
    })
    expect(await unlockCertificate(p, OPTS)).not.toBeNull()
    expect(log).toEqual(['probe', 'noKey', 'add', 'probe', 'ask:digital-id:22', 'decrypt:digital-id:22:pw', 'attempt:0'])
    expect(noKeys).toEqual([
      {
        message: 'This document is encrypted for the certificate with serial number 1A2B (issued by Contoso CA). None of your certificates or Digital IDs can open it.',
        canAdd: true,
        unsupportedKey: false
      }
    ])
  })

  it('no matching key without a way to add one: the message only; Cancel gives null', async () => {
    const { p, noKeys } = ports({ probes: [{ candidates: [] }], decrypt: {}, noKey: ['add'] })
    expect(await unlockCertificate(p, { ...OPTS, canAddDigitalId: false })).toBeNull()
    expect(noKeys[0].canAdd).toBe(false)
  })

  it('keys that vanished since the probe (NO_MATCHING_CERT) end in the no-match message', async () => {
    const store = candidate('windows-store:aa')
    const { p, log } = ports({ probes: [{ candidates: [store] }], decrypt: { [store.id]: [fail('NO_MATCHING_CERT')] } })
    expect(await unlockCertificate(p, OPTS)).toBeNull()
    expect(log).toEqual(['probe', 'decrypt:windows-store:aa', 'noKey'])
  })

  it('a Windows certificate store that could not be searched is named in the no-match message', async () => {
    const recipients: PubSecRecipient[] = [
      { envelope: 0, index: 0, idType: 'issuerAndSerialNumber', issuer: 'CN=Contoso CA, O=Contoso', serial: '1A2B', keyType: 'rsa' }
    ]
    // The store probe found nothing because PowerShell runs in Constrained Language Mode: not "none of your certificates".
    const constrained = ports({ probes: [{ candidates: [], recipients, windowsStore: 'constrained' }], decrypt: {} })
    expect(await unlockCertificate(constrained.p, OPTS)).toBeNull()
    expect(constrained.noKeys).toEqual([
      {
        message:
          'This document is encrypted for the certificate with serial number 1A2B (issued by Contoso CA). None of your Digital IDs can open it. Windows only lets PowerShell run in Constrained Language Mode on this computer, so Fartcrobat cannot use the Windows certificate store. You can still use a Digital ID.',
        canAdd: true,
        unsupportedKey: false,
        windowsStore: 'constrained'
      }
    ])
    const unavailable = ports({ probes: [{ candidates: [], recipients, windowsStore: 'unavailable' }], decrypt: {} })
    await unlockCertificate(unavailable.p, OPTS)
    expect(unavailable.noKeys[0]).toMatchObject({ windowsStore: 'unavailable', canAdd: true })
    expect(unavailable.noKeys[0].message).toMatch(/None of your Digital IDs can open it\. Windows PowerShell could not be started, so Fartcrobat cannot use the Windows certificate store\./)
    // The helper was too busy to answer in time (a smart card waiting for its PIN in another window).
    const busy = ports({ probes: [{ candidates: [], recipients, windowsStore: 'busy' }], decrypt: {} })
    await unlockCertificate(busy.p, OPTS)
    expect(busy.noKeys[0]).toMatchObject({ windowsStore: 'busy', canAdd: true })
    expect(busy.noKeys[0].message).toMatch(
      /None of your Digital IDs can open it\. The Windows certificate store did not answer in time\. It may be waiting for a smart card PIN; try again when that is done\.$/
    )
    // A store that works, is off or is not on this system changes nothing.
    for (const windowsStore of ['available', 'off', 'not-windows', undefined] as const) {
      const fine = ports({ probes: [{ candidates: [], recipients, windowsStore }], decrypt: {} })
      await unlockCertificate(fine.p, OPTS)
      expect(fine.noKeys[0]).toEqual({ message: noCertificateMessage(recipients), canAdd: true, unsupportedKey: false })
    }
    const ec = candidate('digital-id:44', { keyType: 'ec', label: 'EC Test' })
    const onlyEc = ports({ probes: [{ candidates: [ec], windowsStore: 'constrained' }], decrypt: {} })
    await unlockCertificate(onlyEc.p, OPTS)
    expect(onlyEc.noKeys[0].message).toMatch(/cannot open yet\. Windows only lets PowerShell run in Constrained Language Mode/)
  })

  it('says why it gave up: a problem the person could only acknowledge, else a cancel', async () => {
    const saved = candidate('digital-id:11', { passwordSaved: true, label: 'Alice' })
    const card = candidate('windows-store:cc', { hardware: true, needs: 'pin' })
    const store = candidate('windows-store:aa')
    const typed = candidate('digital-id:22')
    const outcome = async (script: Script) => unlockCertificateOutcome(ports(script).p, OPTS)

    // OK on "The Digital ID file could not be read": a failure, not the person cancelling.
    expect(await outcome({ probes: [{ candidates: [saved] }], decrypt: { [saved.id]: [fail('ID_UNAVAILABLE')] } })).toEqual({
      ok: false,
      problem: { candidate: saved, code: 'ID_UNAVAILABLE', message: expect.stringContaining('The Digital ID file could not be read'), canRetry: false }
    })
    // A key the engine refused; with several problems, the last one.
    expect(
      await outcome({
        probes: [{ candidates: [saved, store] }],
        decrypt: { [store.id]: [fail('UNSUPPORTED')], [saved.id]: [ok(saved)] },
        refuse: [0]
      })
    ).toMatchObject({ ok: false, problem: { code: 'ERROR', message: 'The key of “Alice” did not open “secret.pdf”. The file may be damaged.' } })
    // A problem after a typed password, too.
    expect(
      await outcome({ probes: [{ candidates: [typed] }], decrypt: { [typed.id]: [fail('ERROR', { message: 'Broken.' })] }, answers: [{ password: 'pw' }] })
    ).toMatchObject({ ok: false, problem: { code: 'ERROR', message: 'Broken.' } })

    // Cancel where Try Again was offered, Windows' dialog (or the wait) cancelled, a dismissed
    // password prompt and the no-match message are the person cancelling.
    expect(await outcome({ probes: [{ candidates: [card] }], decrypt: { [card.id]: [fail('CARD_NOT_PRESENT')] }, problems: ['cancel'] })).toEqual({ ok: false, problem: null })
    expect(
      await outcome({ probes: [{ candidates: [card, saved] }], decrypt: { [card.id]: [fail('TIMEOUT')], [saved.id]: [fail('ID_UNAVAILABLE')] }, problems: ['cancel'] })
    ).toEqual({ ok: false, problem: null })
    expect(await outcome({ probes: [{ candidates: [saved, card] }], decrypt: { [saved.id]: [fail('ID_UNAVAILABLE')], [card.id]: [fail('CANCELLED')] } })).toEqual({
      ok: false,
      problem: null
    })
    expect(await outcome({ probes: [{ candidates: [saved, typed] }], decrypt: { [saved.id]: [fail('ID_UNAVAILABLE')] }, answers: [null] })).toEqual({ ok: false, problem: null })
    expect(await outcome({ probes: [{ candidates: [] }], decrypt: {} })).toEqual({ ok: false, problem: null })

    // Opened: the key, as unlockCertificate gives it.
    const opened = await outcome({ probes: [{ candidates: [saved] }], decrypt: { [saved.id]: [ok(saved)] } })
    expect(opened).toMatchObject({ ok: true, unlocked: { via: { label: 'Alice' }, access: 'owner' } })
  })

  it('only elliptic-curve keys match: says Fartcrobat cannot open them yet (no Add Digital ID)', async () => {
    const ec = candidate('digital-id:44', { keyType: 'ec', label: 'EC Test' })
    const { p, noKeys, log } = ports({ probes: [{ candidates: [ec] }], decrypt: {} })
    expect(await unlockCertificate(p, OPTS)).toBeNull()
    expect(log).toEqual(['probe', 'noKey'])
    expect(noKeys).toEqual([
      {
        message: 'This document is encrypted for “EC Test”. It uses an elliptic-curve certificate, which Fartcrobat cannot open yet.',
        canAdd: false,
        unsupportedKey: true
      }
    ])
  })
})

describe('messages', () => {
  const rsa = (serial: string, issuer = 'CN=Test CA, O=Fartcrobat Tests'): PubSecRecipient => ({
    envelope: 0,
    index: 0,
    idType: 'issuerAndSerialNumber',
    issuer,
    serial,
    keyType: 'rsa'
  })

  it('names one recipient by serial number and issuer', () => {
    expect(noCertificateMessage([rsa('00FF')])).toBe(
      'This document is encrypted for the certificate with serial number 00FF (issued by Test CA). None of your certificates or Digital IDs can open it.'
    )
    expect(noCertificateMessage([{ envelope: 1, index: 0, idType: 'subjectKeyIdentifier', ski: 'AB12', keyType: 'rsa' }])).toBe(
      'This document is encrypted for the certificate with key identifier AB12. None of your certificates or Digital IDs can open it.'
    )
  })

  it('names up to three recipients, then "and N others" (duplicates once)', () => {
    const five = [rsa('01'), rsa('02', 'CN=Café Ünïcode CA'), rsa('03'), rsa('04'), rsa('05'), rsa('01')]
    expect(noCertificateMessage(five)).toBe(
      'This document is encrypted for 5 certificates: serial number 01 (issued by Test CA), serial number 02 (issued by Café Ünïcode CA), serial number 03 (issued by Test CA) and 2 others. None of your certificates or Digital IDs can open it.'
    )
    expect(noCertificateMessage([rsa('01'), rsa('02'), rsa('03'), rsa('04')])).toContain('and 1 other.')
    expect(noCertificateMessage([rsa('01'), rsa('02')])).toBe(
      'This document is encrypted for 2 certificates: serial number 01 (issued by Test CA) and serial number 02 (issued by Test CA). None of your certificates or Digital IDs can open it.'
    )
    expect(noCertificateMessage([])).toBe('This document is encrypted with certificates. None of your certificates or Digital IDs can open it.')
  })

  it('elliptic-curve messages for one or several keys', () => {
    const a = candidate('digital-id:1', { keyType: 'ec', label: 'A' })
    const b = candidate('windows-store:2', { keyType: 'ec', label: 'B' })
    expect(unsupportedKeyMessage([a, b])).toBe('This document is encrypted for “A” and “B”. They use elliptic-curve certificates, which Fartcrobat cannot open yet.')
  })

  it('reads the common name of an issuer', () => {
    expect(commonName('CN=Contoso CA, O=Contoso')).toBe('Contoso CA')
    expect(commonName('O=Contoso, CN=Contoso Issuing CA 01')).toBe('Contoso Issuing CA 01')
    expect(commonName('CN=Smith\\, Ana, O=X')).toBe('Smith, Ana')
    // RFC 4514 (the fixtures' expected.json) and .NET's reversed order.
    expect(commonName('CN=Fartcrobat Tëst CA Ünïcode ✓,OU=TEST KEYS ONLY - never use for anything real,O=Fartcrobat Test Keys')).toBe('Fartcrobat Tëst CA Ünïcode ✓')
    expect(commonName('OU=TEST KEYS ONLY - never use for anything real, O=Fartcrobat Store Test, CN=Store Test Me éè 🔑')).toBe('Store Test Me éè 🔑')
    expect(commonName('O=Only Org')).toBe('Only Org')
    expect(commonName('OU=Unit')).toBe('OU=Unit')
    expect(commonName(undefined)).toBe('')
  })

  it('access: full when the envelope allows changing the security or has no permission bytes', () => {
    expect(certificateAccess(null)).toBe('owner')
    expect(certificateAccess(0xffffffff)).toBe('owner')
    expect(certificateAccess(0xfffff0c4 | 2)).toBe('owner')
    expect(certificateAccess(0xfffff0c4)).toBe('user')
    expect(certificateAccess(1 << 2)).toBe('user')
  })

  it('outputs that keep certificate security say so', () => {
    expect(protectionDetails({ method: '256-bit AES', needsPassword: false, restricted: false, certificate: true })).toBe(
      '256-bit AES encryption and the same certificate security'
    )
    expect(protectionNote({ method: '256-bit AES', needsPassword: false, restricted: true, certificate: true }, 'a.pdf')).toBe(
      'It keeps the protection of “a.pdf”: 256-bit AES encryption, the same certificate security and the same restrictions.'
    )
    expect(protectionDetails({ method: '128-bit AES', needsPassword: true, restricted: false })).toBe('128-bit AES encryption and the same open password')
  })

  it('agents are told why when no key opens a file', () => {
    expect(certificateFailure('a.pdf', new Error('other'))).toBeNull()
    expect(certificateFailure('a.pdf', null)).toBeNull()
    const noKey = Object.assign(new Error('This document is encrypted for ...'), { code: 'NO_CERTIFICATE', unsupportedKey: false })
    expect(certificateFailure('a.pdf', noKey)).toMatchObject({ code: 'failed', message: expect.stringContaining('none of the person\'s certificates or Digital IDs opens it') })
    expect(certificateFailure('a.pdf', noKey)!.message).not.toMatch(/Windows certificate store/)
    const ec = Object.assign(new Error('...'), { code: 'NO_CERTIFICATE', unsupportedKey: true })
    expect(certificateFailure('a.pdf', ec)).toMatchObject({ code: 'unsupported', message: expect.stringContaining('elliptic-curve') })
    // The store could not be searched: the agent is not told that none of the person's certificates opens it.
    const blocked = Object.assign(new Error('...'), { code: 'NO_CERTIFICATE', unsupportedKey: false, windowsStore: 'constrained' })
    const told = certificateFailure('a.pdf', blocked)!
    expect(told.code).toBe('failed')
    expect(told.message).toMatch(/none of the person's Digital IDs opens it\. Fartcrobat could not search the Windows certificate store on this computer \(Windows only lets PowerShell run in Constrained Language Mode there\)/)
    const noPowerShell = Object.assign(new Error('...'), { code: 'NO_CERTIFICATE', unsupportedKey: false, windowsStore: 'unavailable' })
    expect(certificateFailure('a.pdf', noPowerShell)!.message).toMatch(/Windows PowerShell could not be started/)
    // Busy for too long (a smart card PIN in another window): worth trying again later.
    const busy = Object.assign(new Error('...'), { code: 'NO_CERTIFICATE', unsupportedKey: false, windowsStore: 'busy' })
    expect(certificateFailure('a.pdf', busy)!.message).toMatch(
      /none of the person's Digital IDs opens it\. The Windows certificate store did not answer in time .*try again later\./
    )
  })

  it('agents are told when a key failed (not that the person cancelled), and when a file a key opened is damaged', () => {
    const failed = Object.assign(new Error('The Digital ID file could not be read. Remove the Digital ID in Preferences > Digital IDs and import it again.'), {
      code: 'CERTIFICATE_FAILED',
      label: 'Alice',
      problem: 'ID_UNAVAILABLE'
    })
    expect(certificateFailure('a.pdf', failed)).toEqual({
      code: 'failed',
      message:
        'a.pdf was not opened: the person\'s key “Alice” could not be used. Fartcrobat told them: The Digital ID file could not be read. Remove the Digital ID in Preferences > Digital IDs and import it again. Never ask for keys, PINs or passwords in chat.'
    })

    // The engine's CERTIFICATE_OPEN_FAILED, directly (open_document) and as organize-pages words it (combine_files, insert_file).
    for (const message of [
      'This certificate-encrypted document could not be opened: it is damaged',
      'b.pdf could not be opened: This certificate-encrypted document could not be opened: it is damaged'
    ]) {
      const damaged = Object.assign(new Error(message), { code: 'CERTIFICATE_OPEN_FAILED' })
      expect(certificateFailure('b.pdf', damaged)).toEqual({
        code: 'file_error',
        message: 'b.pdf is certificate-encrypted and one of the person\'s keys unlocked it, but the file could not be opened: it is damaged. Ask the sender for a new copy.'
      })
      // Not "certificate encryption that Fartcrobat cannot open".
      expect(openErrorCode(message)).toBe('file_error')
    }
    expect(openErrorCode("This file could not be opened: unknown encryption handler: 'Adobe.PubSec'")).toBe('unsupported')
  })

  it('audit summaries never include secrets', () => {
    const v: CertKeyVia = { source: 'windows-store', label: 'Alice', subject: 'CN=Alice', fingerprint: 'AB', hardware: true }
    expect(unlockAuditSummary({ method: 'certificate', access: 'user', via: v, certificateKey: { envelope: new Uint8Array(3), seed: SEED, permissions: 4 } })).toBe(
      'opened with certificate CN=Alice (AB) from a smart card'
    )
    expect(unlockAuditSummary({ method: 'source', access: 'user', via: v })).toBeUndefined()
  })
})
