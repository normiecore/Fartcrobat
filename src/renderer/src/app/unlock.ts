/**
 * Unlocking a password-protected file: passwords saved on this device first, then the person.
 * No DOM and no IPC here: everything goes through `UnlockPorts`, so the same logic serves opening a
 * tab, Revert, Insert, Combine, Create and Compare (see savedPasswords.ts), and runs in unit tests.
 */
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
  /** 'source': given by the tool that made the file (the password of the file it came from). */
  method: 'typed' | 'saved-password' | 'source'
  access: Access
  /** The saved password that opens it: found, remembered when typed, or its source's. */
  savedRef?: string
  /** The lock that password opened (files with another lock are never linked to it). */
  lock?: LockInfo | null
}

/** The line the agent audit log gets for an open (never the password). */
export function unlockAuditSummary(o: UnlockOutcome | DocUnlock | null | undefined): string | undefined {
  if (!o) return undefined
  if (o.method === 'saved-password') return 'unlocked with a password saved on this device'
  if (o.method === 'typed') return 'the person typed the password'
  return undefined
}

/** Prompt text for the states above. `purpose` ends the first request ("to compare it"). */
export function promptMessage(name: string, s: Pick<AskState, 'wrong' | 'savedStale'>, purpose?: string): string {
  if (s.wrong) return `The password for “${name}” is incorrect. Try again.`
  if (s.savedStale) return `The password saved for “${name}” no longer opens it, so it was removed. Enter the document open password.`
  return `“${name}” is protected. Enter the document open password${purpose ? ` ${purpose}` : ''}.`
}
