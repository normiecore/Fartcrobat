// Certificate encryption: the unlock logic shared by every place that opens a certificate-encrypted
// file (tabs, Revert, Insert, Combine, Create, Compare, agents), with fake ports for the main
// process (certkeys:probe/decrypt), the engine and the dialogs.
import { describe, expect, it } from 'vitest'
import type { CertKeyCandidate, CertKeysDecryptRequest, CertKeysDecryptResult, CertKeyVia, PubSecRecipient } from '@shared/certkeys'
import { noCertificateFailure } from '@features/agent-access/tools/act-files'
import { protectionDetails, protectionNote } from '@features/organize-pages/protection'
import {
  certificateAccess,
  commonName,
  digitalIdPromptMessage,
  noCertificateMessage,
  orderCandidates,
  unlockAuditSummary,
  unlockCertificate,
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
  probes: { candidates: CertKeyCandidate[]; recipients?: PubSecRecipient[] }[]
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
  const noKeys: { message: string; canAdd: boolean; unsupportedKey: boolean }[] = []
  const answers = [...(script.answers ?? [])]
  const problemAnswers = [...(script.problems ?? [])]
  const noKeyAnswers = [...(script.noKey ?? [])]
  const counts: Record<string, number> = {}
  let probes = 0
  const p: CertUnlockPorts = {
    async probe() {
      log.push('probe')
      const r = script.probes[Math.min(probes++, script.probes.length - 1)]
      return { candidates: r.candidates, recipients: r.recipients ?? [] }
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
    const order = orderCandidates([typed, card, saved, ec, soft, pinOnly, unknown, { ...soft, envelope: 1 }])
    expect(order.silent.map((c) => c.id)).toEqual(['windows-store:aa', 'windows-store:bb', 'digital-id:11'])
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
    expect(noCertificateFailure('a.pdf', new Error('other'))).toBeNull()
    expect(noCertificateFailure('a.pdf', null)).toBeNull()
    const noKey = Object.assign(new Error('This document is encrypted for ...'), { code: 'NO_CERTIFICATE', unsupportedKey: false })
    expect(noCertificateFailure('a.pdf', noKey)).toMatchObject({ code: 'failed', message: expect.stringContaining('none of the person\'s certificates or Digital IDs opens it') })
    const ec = Object.assign(new Error('...'), { code: 'NO_CERTIFICATE', unsupportedKey: true })
    expect(noCertificateFailure('a.pdf', ec)).toMatchObject({ code: 'unsupported', message: expect.stringContaining('elliptic-curve') })
  })

  it('audit summaries never include secrets', () => {
    const v: CertKeyVia = { source: 'windows-store', label: 'Alice', subject: 'CN=Alice', fingerprint: 'AB', hardware: true }
    expect(unlockAuditSummary({ method: 'certificate', access: 'user', via: v, certificateKey: { envelope: new Uint8Array(3), seed: SEED, permissions: 4 } })).toBe(
      'opened with certificate CN=Alice (AB) from a smart card'
    )
    expect(unlockAuditSummary({ method: 'source', access: 'user', via: v })).toBeUndefined()
  })
})
