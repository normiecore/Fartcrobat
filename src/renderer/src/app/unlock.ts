/**
 * Unlocking a protected file. Passwords: passwords saved on this device first, then the person.
 * Certificate encryption: the person's keys that need nothing first, then the person (a Digital ID
 * password, a smart card PIN in Windows' own dialog).
 * No DOM and no IPC here: everything goes through `UnlockPorts` and `CertUnlockPorts`, so the same
 * logic serves opening a tab, Revert, Insert, Combine, Create and Compare (see savedPasswords.ts
 * and certificates.ts), and runs in unit tests.
 */
import {
  certificateAuditSummary,
  PUBSEC_PERMISSION,
  type CertificateKey,
  type CertKeyActor,
  type CertKeyCandidate,
  type CertKeysDecryptRequest,
  type CertKeysDecryptResult,
  type CertKeysErrorCode,
  type CertKeysProbeResult,
  type CertKeyVia,
  type PubSecRecipient
} from '@shared/certkeys'
import type { LockInfo, PasswordAccess } from '@shared/types'

export type Access = PasswordAccess

export interface SavedCandidate {
  ref: string
  password: string
  level?: Access
  via: string
}

/** Whether the prompt shows "Remember password on this device", and how. */
export type RememberOffer =
  | { offer: true; checked: boolean }
  /** Not offered; `reason` is shown in its place (no keyring on Linux), or nothing when absent. */
  | { offer: false; reason?: string }

export interface AskState {
  /** The last password tried was wrong. */
  wrong: boolean
  /** A saved password was tried and no longer opens the file (it was forgotten for it). */
  savedStale: boolean
  remember: RememberOffer
}

export interface UnlockPorts {
  /** Saved passwords that may open this file, best first ([] when remembering is off). */
  find(): Promise<SavedCandidate[]>
  /** Tries a password on the locked file; the access it gives, or null when it is wrong. */
  attempt(password: string): Promise<Access | null>
  /** A saved password worked: link this file's keys to it. */
  used(ref: string, level: Access): Promise<void>
  /** A saved password failed: unlink this file's keys from it. */
  failed(ref: string): Promise<void>
  /** Saves a typed password for this file; its ref. */
  remember(password: string, level: Access): Promise<string>
  /** Asks the person for the password; null when they cancel. */
  ask(state: AskState): Promise<{ password: string; remember: boolean } | null>
}

export interface UnlockOptions {
  /** Try saved passwords (false when the person turned remembering off). */
  trySaved: boolean
  /** The checkbox in the prompt; a function is only called if the person is asked. */
  remember: RememberOffer | (() => Promise<RememberOffer>)
  /** Ask the person when no saved password works. False: give up (returns null). */
  prompt: boolean
  /** The first prompt says the password was wrong (one given by the caller was tried already). */
  wrong?: boolean
}

export type UnlockOutcome =
  | { method: 'saved-password'; level: Access; ref: string }
  | { method: 'typed'; level: Access; remembered: boolean; ref?: string }

export async function unlock(ports: UnlockPorts, opts: UnlockOptions): Promise<UnlockOutcome | null> {
  let stale = false
  if (opts.trySaved) {
    let candidates: SavedCandidate[] = []
    try {
      candidates = await ports.find()
    } catch {
      // The store failing must never stop a file from opening: fall through to the prompt.
    }
    const wrongPasswords = new Set<string>()
    for (const c of candidates) {
      const level = wrongPasswords.has(c.password) ? null : await ports.attempt(c.password)
      if (level) {
        await ports.used(c.ref, level).catch(() => {})
        return { method: 'saved-password', level, ref: c.ref }
      }
      wrongPasswords.add(c.password)
      stale = true
      await ports.failed(c.ref).catch(() => {})
    }
  }
  if (!opts.prompt) return null
  let offer: RememberOffer | null = null
  let wrong = !!opts.wrong
  for (;;) {
    if (!offer) {
      try {
        offer = typeof opts.remember === 'function' ? await opts.remember() : opts.remember
      } catch {
        offer = { offer: false }
      }
    }
    const answer = await ports.ask({ wrong, savedStale: stale && !wrong, remember: offer })
    if (answer === null) return null
    const level = await ports.attempt(answer.password)
    if (!level) {
      wrong = true
      // The next prompt keeps what the person chose in this one (unticked stays unticked).
      if (offer.offer) offer = { offer: true, checked: answer.remember }
      continue
    }
    if (answer.remember && offer.offer) {
      try {
        const ref = await ports.remember(answer.password, level)
        return { method: 'typed', level, remembered: true, ref }
      } catch {
        // Opening worked; only remembering failed (the store never reports the password).
      }
    }
    return { method: 'typed', level, remembered: false }
  }
}

/** How an open tab's password was supplied (DocState.unlock). */
export interface DocUnlock {
  /**
   * 'source': given by the tool that made the file (the password, or certificate key, of the file it
   * came from). 'certificate': one of the person's keys opened a certificate-encrypted file.
   */
  method: 'typed' | 'saved-password' | 'source' | 'certificate'
  /** 'owner' for full access (a permissions password, or a certificate allowed to change security). */
  access: Access
  /** The saved password that opens it: found, remembered when typed, or its source's. */
  savedRef?: string
  /** The lock that password opened (files with another lock are never linked to it). */
  lock?: LockInfo | null
  /** 'certificate': which key opened it (no secrets), for the audit log and the Protect panel. */
  via?: CertKeyVia
  /**
   * Certificate encryption: the key that opens this document, so files and tabs made from it open
   * without asking again. Secret: only ever passed to this window's engines, never logged or shown.
   */
  certificateKey?: CertificateKey
}

/** The line the agent audit log gets for an open (never the password). */
export function unlockAuditSummary(o: UnlockOutcome | DocUnlock | null | undefined): string | undefined {
  if (!o) return undefined
  if (o.method === 'saved-password') return 'unlocked with a password saved on this device'
  if (o.method === 'typed') return 'the person typed the password'
  if (o.method === 'certificate' && 'via' in o && o.via) return certificateAuditSummary(o.via)
  return undefined
}

/** Prompt text for the states above. `purpose` ends the first request ("to compare it"). */
export function promptMessage(name: string, s: Pick<AskState, 'wrong' | 'savedStale'>, purpose?: string): string {
  if (s.wrong) return `The password for “${name}” is incorrect. Try again.`
  if (s.savedStale) return `The password saved for “${name}” no longer opens it and won't be tried for it again. Enter the document open password.`
  return `“${name}” is protected. Enter the document open password${purpose ? ` ${purpose}` : ''}.`
}

// ---- certificate encryption -----------------------------------------------------------------

/** What a person's key unwrapped (certkeys:decrypt). Secret: never log or show it. */
export type CertDecrypted = Extract<CertKeysDecryptResult, { ok: true }>

/** The Digital ID password prompt. */
export interface CertAskState {
  /** The Digital ID asked for. */
  candidate: CertKeyCandidate
  /** The last password typed for it was wrong. */
  wrong: boolean
  /** Its saved password no longer works (the main process forgot it). */
  savedStale: boolean
  remember: RememberOffer
}

/** A key that could not be used, told to the person. */
export interface CertProblem {
  candidate: CertKeyCandidate
  code: CertKeysErrorCode
  /** Plain language, the main process's when it gave one. */
  message: string
  /** Try Again is offered (only where it can help: a wrong PIN, a card to insert, a timeout). */
  canRetry: boolean
}

export interface CertUnlockPorts {
  /** certkeys:probe for the file's recipients. Uses no key and never prompts. */
  probe(): Promise<CertKeysProbeResult>
  /** certkeys:decrypt with one candidate (the wiring adds the file's /Recipients). May wait for the person. */
  decrypt(request: Omit<CertKeysDecryptRequest, 'blobs'>): Promise<CertKeysDecryptResult>
  /** Gives the unwrapped key to the engine; false when it does not open the file after all. */
  attempt(result: CertDecrypted): Promise<boolean>
  /** Asks for a Digital ID's password; null when the person cancels. */
  askPassword(state: CertAskState): Promise<{ password: string; remember: boolean } | null>
  /** Tells the person why a key failed: 'retry' (only when offered) or 'cancel'. */
  problem(problem: CertProblem): Promise<'retry' | 'cancel'>
  /**
   * None of the person's keys opens the file. `canAdd` offers "Add Digital ID..."; `unsupportedKey`:
   * only keys Fartcrobat cannot use yet (elliptic-curve) match.
   */
  noKey(state: { message: string; canAdd: boolean; unsupportedKey: boolean }): Promise<'add' | 'cancel'>
  /** "Add Digital ID...": imports one. The file is probed again afterwards, whatever happened. */
  addDigitalId(): Promise<void>
}

export interface CertUnlockOptions {
  /** File name, for the messages. */
  name: string
  /** Who opens it, passed to certkeys:decrypt. */
  actor: CertKeyActor
  /** The checkbox in the Digital ID prompt; a function is only called if the person is asked. */
  remember: RememberOffer | (() => Promise<RememberOffer>)
  /** "Add Digital ID..." can be offered when no key matches. */
  canAddDigitalId: boolean
}

export interface CertUnlocked {
  /** What the key unwrapped, for the caller to build the CertificateKey from. Secret. */
  result: CertDecrypted
  via: CertKeyVia
  access: Access
}

/**
 * Access a certificate gives: full when its envelope allows changing the security (or has no
 * permission bytes), else what the permission bits allow (the engine reports them in DocInfo).
 */
export function certificateAccess(permissions: number | null): Access {
  return permissions === null || (permissions & PUBSEC_PERMISSION.changeSecurity) !== 0 ? 'owner' : 'user'
}

/** Errors where Try Again can help: a wrong PIN, a card or key to connect, a dialog left too long. */
const RETRYABLE: ReadonlySet<CertKeysErrorCode> = new Set(['WRONG_PIN', 'CARD_NOT_PRESENT', 'KEY_UNAVAILABLE', 'TIMEOUT'])

/** Said when the main process gave no message. */
const DEFAULT_PROBLEMS: Partial<Record<CertKeysErrorCode, string>> = {
  WRONG_PIN: 'The PIN is incorrect.',
  PIN_BLOCKED: 'The smart card is blocked because a wrong PIN was entered too many times. Contact your IT department.',
  CARD_NOT_PRESENT: 'Insert the smart card with this certificate, then try again.',
  KEY_UNAVAILABLE: 'The private key of this certificate cannot be used right now.',
  CONSTRAINED_LANGUAGE:
    'Windows only lets PowerShell run in Constrained Language Mode on this computer, so Fartcrobat cannot use the Windows certificate store. You can still use a Digital ID.',
  POWERSHELL_UNAVAILABLE: 'Windows PowerShell could not be started, so Fartcrobat cannot use the Windows certificate store. You can still use a Digital ID.',
  TIMEOUT: 'Windows did not answer in time.',
  ID_UNAVAILABLE: 'The Digital ID file could not be read. Remove the Digital ID in Preferences > Digital IDs and import it again.',
  UNSUPPORTED: 'This kind of certificate cannot open files in Fartcrobat yet.'
}

function problemMessage(code: CertKeysErrorCode, message: string): string {
  return message || DEFAULT_PROBLEMS[code] || 'The key could not be used.'
}

/** "Contoso CA" from "CN=Contoso CA, O=Contoso" (the organisation, or the whole name, without a CN). */
export function commonName(dn: string | undefined): string {
  if (!dn) return ''
  const attr = (key: string) => {
    const m = new RegExp(`(?:^|[,;+])\\s*${key}\\s*=\\s*((?:\\\\.|"[^"]*"|[^,;+])*)`, 'i').exec(dn)
    return m ? m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1') : ''
  }
  return attr('CN') || attr('O') || dn.trim()
}

/** "the certificate with serial number 1A2B (issued by Contoso CA)"; `short` leaves out "the certificate with". */
function recipientPhrase(r: PubSecRecipient, short: boolean): string {
  const issuer = commonName(r.issuer)
  const by = issuer ? ` (issued by ${issuer})` : ''
  const the = short ? '' : 'the certificate with '
  if (r.idType === 'issuerAndSerialNumber' && r.serial) return `${the}serial number ${r.serial}${by}`
  if (r.idType === 'subjectKeyIdentifier' && r.ski) return `${the}key identifier ${r.ski}${by}`
  if (r.idType === 'keyAgreement' || r.keyType === 'ec') return `an elliptic-curve certificate${by}`
  return `a certificate${by}`
}

/**
 * Why none of the person's keys opens a file: "This document is encrypted for the certificate with
 * serial number 1A2B (issued by Contoso CA). None of your certificates or Digital IDs can open it."
 * A file only names its recipients by issuer and serial number (or key identifier). Up to three
 * are listed, then "and N others".
 */
export function noCertificateMessage(recipients: PubSecRecipient[]): string {
  const end = 'None of your certificates or Digital IDs can open it.'
  const seen = new Set<string>()
  const unique = recipients.filter((r) => {
    const id = `${r.idType}|${r.issuer ?? ''}|${r.serial ?? ''}|${r.ski ?? ''}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  if (!unique.length) return `This document is encrypted with certificates. ${end}`
  if (unique.length === 1) return `This document is encrypted for ${recipientPhrase(unique[0], false)}. ${end}`
  const named = unique.slice(0, 3).map((r) => recipientPhrase(r, true))
  const others = unique.length - named.length
  const list = others
    ? `${named.join(', ')} and ${others} other${others === 1 ? '' : 's'}`
    : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`
  return `This document is encrypted for ${unique.length} certificates: ${list}. ${end}`
}

/** Only keys Fartcrobat cannot use yet match: "This document is encrypted for “EC Test”. It uses an elliptic-curve certificate, ..." */
export function unsupportedKeyMessage(candidates: CertKeyCandidate[]): string {
  const labels = [...new Set(candidates.map((c) => `“${c.label}”`))]
  const names = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
  const ec = candidates.every((c) => c.keyType === 'ec')
  const one = labels.length === 1
  const kind = ec
    ? one
      ? 'It uses an elliptic-curve certificate'
      : 'They use elliptic-curve certificates'
    : one
      ? 'It uses a kind of certificate'
      : 'They use kinds of certificates'
  return `This document is encrypted for ${names}. ${kind}, which Fartcrobat cannot open yet.`
}

/**
 * The Digital ID password prompt's text. `purpose` replaces "to open “file.pdf”" (for example
 * "to compare “file.pdf”").
 */
export function digitalIdPromptMessage(
  name: string,
  s: Pick<CertAskState, 'candidate' | 'wrong' | 'savedStale'>,
  purpose?: string
): string {
  if (s.wrong) return 'The password is incorrect. Try again.'
  const ask = `Enter the password of your Digital ID “${s.candidate.label}” ${purpose ?? `to open “${name}”`}.`
  if (s.savedStale) return `The password saved for your Digital ID “${s.candidate.label}” no longer works and was forgotten. ${ask}`
  return ask
}

/**
 * The order keys are tried in: `silent`, Windows store keys that need nothing and are not known to
 * be on a smart card, then Digital IDs whose password is saved (or that need none); `hardware`,
 * the other Windows store keys (Windows asks for the PIN in its own dialog); `prompt`, Digital IDs
 * whose password the person types. Each key once, RSA keys only.
 */
export function orderCandidates(candidates: CertKeyCandidate[]): {
  silent: CertKeyCandidate[]
  hardware: CertKeyCandidate[]
  prompt: CertKeyCandidate[]
} {
  const seen = new Set<string>()
  const usable = candidates.filter((c) => {
    if (c.keyType !== 'rsa' || seen.has(c.id)) return false
    seen.add(c.id)
    return true
  })
  const store = usable.filter((c) => c.source === 'windows-store')
  const ids = usable.filter((c) => c.source === 'digital-id')
  const storeSilent = store.filter((c) => c.needs === 'nothing' && c.hardware !== true)
  // A Digital ID opens silently when its password is saved (or it has none).
  const idSilent = ids.filter((c) => c.passwordSaved || c.needs === 'nothing')
  return {
    silent: [...storeSilent, ...idSilent],
    hardware: store.filter((c) => !storeSilent.includes(c)),
    prompt: ids.filter((c) => !idSilent.includes(c))
  }
}

/**
 * Opens a certificate-encrypted file with one of the person's keys, in the order above. Resolves
 * with what the key unwrapped, which key it was and the access it gives; null when the person
 * cancelled or no key opens it (they were told why).
 */
export async function unlockCertificate(ports: CertUnlockPorts, opts: CertUnlockOptions): Promise<CertUnlocked | null> {
  let offer: RememberOffer | null = null
  const rememberOffer = async (): Promise<RememberOffer> => {
    if (!offer) {
      try {
        offer = typeof opts.remember === 'function' ? await opts.remember() : opts.remember
      } catch {
        offer = { offer: false }
      }
    }
    return offer
  }

  for (;;) {
    const { candidates, recipients } = await ports.probe()
    const order = orderCandidates(candidates)
    /** Something was shown to the person this round (a prompt or a problem). */
    let told = false
    let cancelled = false

    /** Gives a decrypted key to the engine; true when the file opened. */
    const open = async (c: CertKeyCandidate, res: CertDecrypted): Promise<boolean> => {
      if (await ports.attempt(res)) return true
      told = true
      await ports.problem({
        candidate: c,
        code: 'ERROR',
        message: `The key of “${c.label}” did not open “${opts.name}”. The file may be damaged.`,
        canRetry: false
      })
      return false
    }
    const unlocked = (res: CertDecrypted): CertUnlocked => ({ result: res, via: res.via, access: certificateAccess(res.permissions) })

    /**
     * Tries a key without typing anything here (Windows may ask for a smart card PIN in its own
     * dialog). 'prompt' or 'stale': a Digital ID needs its password typed after all.
     */
    const tryKey = async (c: CertKeyCandidate): Promise<CertUnlocked | 'prompt' | 'stale' | null> => {
      for (;;) {
        const res = await ports.decrypt({ candidate: c.id, actor: opts.actor })
        if (res.ok) return (await open(c, res)) ? unlocked(res) : null
        if (res.code === 'CANCELLED') {
          cancelled = true
          return null
        }
        if (c.source === 'digital-id' && (res.code === 'PASSWORD_NEEDED' || res.code === 'WRONG_PASSWORD'))
          return res.savedStale ? 'stale' : 'prompt'
        // The key is gone since the probe: nothing to tell.
        if (res.code === 'NO_MATCHING_CERT') return null
        const canRetry = RETRYABLE.has(res.code)
        told = true
        const answer = await ports.problem({ candidate: c, code: res.code, message: problemMessage(res.code, res.message), canRetry })
        if (answer !== 'retry' || !canRetry) return null
      }
    }

    const prompts = order.prompt.map((candidate) => ({ candidate, stale: false }))
    for (const c of [...order.silent, ...order.hardware]) {
      const r = await tryKey(c)
      if (cancelled) return null
      if (r === 'prompt' || r === 'stale') prompts.push({ candidate: c, stale: r === 'stale' })
      else if (r) return r
    }

    for (const { candidate: c, stale } of prompts) {
      let wrong = false
      for (;;) {
        told = true
        const answer = await ports.askPassword({ candidate: c, wrong, savedStale: stale && !wrong, remember: await rememberOffer() })
        if (!answer) return null
        // The next prompt keeps what the person chose in this one (unticked stays unticked).
        if (offer?.offer) offer = { offer: true, checked: answer.remember }
        const remember = !!offer?.offer && answer.remember
        const res = await ports.decrypt({ candidate: c.id, password: answer.password, remember, actor: opts.actor })
        if (res.ok) {
          if (await open(c, res)) return unlocked(res)
          break
        }
        if (res.code === 'CANCELLED') return null
        if (res.code === 'WRONG_PASSWORD' || res.code === 'PASSWORD_NEEDED') {
          wrong = true
          continue
        }
        if (res.code !== 'NO_MATCHING_CERT')
          await ports.problem({ candidate: c, code: res.code, message: problemMessage(res.code, res.message), canRetry: false })
        break
      }
    }

    // Nothing opened it. When the person saw nothing yet (no key matches, or only keys that cannot
    // be used), say why, and offer to add the Digital ID it was encrypted for.
    if (told) return null
    const usable = order.silent.length + order.hardware.length + order.prompt.length
    const unusable = candidates.filter((c) => c.keyType !== 'rsa')
    const unsupportedKey = !usable && unusable.length > 0
    const canAdd = opts.canAddDigitalId && !unsupportedKey
    const answer = await ports.noKey({
      message: unsupportedKey ? unsupportedKeyMessage(unusable) : noCertificateMessage(recipients),
      canAdd,
      unsupportedKey
    })
    if (answer !== 'add' || !canAdd) return null
    await ports.addDigitalId()
  }
}
