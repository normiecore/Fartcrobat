/**
 * Unlocking a password-protected file: saved passwords first, then the person. No DOM, no IPC:
 * everything goes through `UnlockPorts`, so the same logic serves opening a tab, Revert, Insert
 * pages, Combine and Compare, and runs in unit tests.
 *
 * Port target: src/renderer/src/app/unlock.ts (wired to IPC and the prompt in actions.ts).
 */

export type Access = 'user' | 'owner'

export interface SavedCandidate {
  ref: string
  password: string
  level?: Access
  via: string
}

/** Whether the prompt shows "Remember password on this device", and how. */
export type RememberOffer =
  | { offer: true; checked: boolean }
  /** Not offered; `reason` is shown in its place (e.g. no keyring on Linux), or nothing when absent. */
  | { offer: false; reason?: string }

export interface AskState {
  /** The last typed password was wrong. */
  wrong: boolean
  /** A saved password was tried and no longer opens the file (it has been forgotten for it). */
  savedStale: boolean
  remember: RememberOffer
}

export interface UnlockPorts {
  /** Saved passwords that may open this file, best first ([] when remembering is unavailable). */
  find(): Promise<SavedCandidate[]>
  /** Tries a password on the locked file; the access it gives, or null when wrong. */
  attempt(password: string): Promise<Access | null>
  /** A saved password worked: link this file's keys to it. */
  used(ref: string, level: Access): Promise<void>
  /** A saved password failed: unlink this file's keys from it. */
  failed(ref: string): Promise<void>
  /** Saves a typed password for this file. */
  remember(password: string, level: Access): Promise<void>
  /** Asks the person for the password; null when they cancel. */
  ask(state: AskState): Promise<{ password: string; remember: boolean } | null>
}

export interface UnlockOptions {
  /** Try saved passwords (false when the policy turned remembering off). */
  trySaved: boolean
  remember: RememberOffer
  /** Ask the person when no saved password works. False: give up (returns null). */
  prompt: boolean
}

export type UnlockOutcome =
  | { method: 'saved'; level: Access; ref: string }
  | { method: 'typed'; level: Access; remembered: boolean }

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
        return { method: 'saved', level, ref: c.ref }
      }
      wrongPasswords.add(c.password)
      stale = true
      await ports.failed(c.ref).catch(() => {})
    }
  }
  if (!opts.prompt) return null
  let wrong = false
  for (;;) {
    const answer = await ports.ask({ wrong, savedStale: stale && !wrong, remember: opts.remember })
    if (answer === null) return null
    const level = await ports.attempt(answer.password)
    if (!level) {
      wrong = true
      continue
    }
    let remembered = false
    if (answer.remember && opts.remember.offer) {
      try {
        await ports.remember(answer.password, level)
        remembered = true
      } catch {
        // Opening succeeded; only remembering failed (reported by the caller's store, never with the password).
      }
    }
    return { method: 'typed', level, remembered }
  }
}

/** The line the agent audit log gets for an open (never the password). */
export function unlockAuditSummary(o: UnlockOutcome | null): string | undefined {
  if (!o) return undefined
  return o.method === 'saved' ? 'unlocked with a password saved on this device' : 'unlocked with a password the person typed'
}

/** Prompt text for the states above (Fartcrobat's wording). */
export function promptMessage(name: string, s: Pick<AskState, 'wrong' | 'savedStale'>): string {
  if (s.wrong) return `The password for “${name}” is incorrect. Try again.`
  if (s.savedStale) return `The password saved for “${name}” no longer opens it, so it was removed. Enter the document open password.`
  return `“${name}” is protected. Enter the document open password.`
}
