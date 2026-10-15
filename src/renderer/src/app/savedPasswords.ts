/**
 * Passwords remembered on this device, renderer side: the unlock flow wired to the main process
 * ('passwords:*') and to the password prompt, plus helpers for features. The passwords themselves
 * live in the main process; a saved one only comes here to open the file it belongs to.
 */
import type { SavedPasswordInfo, SavedPasswordTarget } from '@shared/passwords'
import type { LockInfo, PasswordAccess } from '@shared/types'
import type { DocumentModel } from '../document/DocumentModel'
import { invoke } from '../platform'
import { promptPassword } from '../ui/dialogs'
import { useApp } from './store'
import { toast } from './ui-services'
import { promptMessage, unlock, type DocUnlock, type RememberOffer } from './unlock'

export const NO_KEYRING_NOTE = 'To remember passwords on this computer, Fartcrobat needs GNOME Keyring or KWallet.'

/** The prompt's "Remember password on this device" checkbox, or why it is missing. */
export async function rememberOffer(): Promise<RememberOffer> {
  const prefs = useApp.getState().prefs
  if (!prefs.rememberPasswords) return { offer: false }
  const status = await invoke('passwords:status').catch(() => null)
  if (status?.available) return { offer: true, checked: prefs.rememberPasswordChecked !== false }
  if (status?.reason === 'no-keyring') return { offer: false, reason: NO_KEYRING_NOTE }
  return { offer: false }
}

/** The checkbox keeps the person's last choice. */
export function keepRememberChoice(checked: boolean) {
  useApp.setState((s) => ({ prefs: { ...s.prefs, rememberPasswordChecked: checked } }))
  void invoke('prefs:set', { rememberPasswordChecked: checked }).catch(() => {})
}

export interface UnlockFileRequest {
  /** File name, shown in the prompt and in Preferences. */
  name: string
  /** Where the file is; null for content only in memory. */
  filePath?: string | null
  /** The file's lock (from the engine's needsPassword result). */
  lock?: LockInfo | null
  /** Tries a password; the access it gives, or null when it is wrong. */
  attempt(password: string): Promise<PasswordAccess | null>
  /** A password given by the caller was already tried and was wrong. */
  wrong?: boolean
  /** Ends the prompt's request, e.g. "to compare it". */
  purpose?: string
  okLabel?: string
}

export interface Unlocked extends DocUnlock {
  method: 'typed' | 'saved-password'
  /** The password that opened it, for the caller to pass on to the engine. Never show or log it. */
  password: string
}

/**
 * Unlocks a password-protected file: a password saved on this device opens it silently, else the
 * person is asked, with "Remember password on this device". Null when they cancel.
 */
export async function unlockFile(req: UnlockFileRequest): Promise<Unlocked | null> {
  const target: SavedPasswordTarget = { kind: 'pdf', lock: req.lock ?? null, path: req.filePath ?? null }
  let password = ''
  let rememberAsked = false
  const outcome = await unlock(
    {
      find: () => invoke('passwords:find', target),
      attempt: async (pw) => {
        const access = await req.attempt(pw)
        if (access) password = pw
        return access
      },
      used: (ref, level) => invoke('passwords:used', ref, target, { label: req.name, level }),
      failed: (ref) => invoke('passwords:failed', ref, target),
      remember: async (pw, level) => {
        const ref = await invoke('passwords:remember', { target, label: req.name, level, password: pw })
        if (!ref) throw new Error('not remembered')
        return ref
      },
      ask: async (state) => {
        const answer = await promptPassword({
          message: promptMessage(req.name, state, req.purpose),
          okLabel: req.okLabel,
          remember: state.remember
        })
        if (answer && state.remember.offer) {
          rememberAsked = answer.remember
          if (answer.remember !== state.remember.checked) keepRememberChoice(answer.remember)
        }
        return answer
      }
    },
    { trySaved: useApp.getState().prefs.rememberPasswords !== false, remember: rememberOffer, prompt: true, wrong: req.wrong }
  )
  if (!outcome) return null
  if (outcome.method === 'typed' && rememberAsked && !outcome.remembered)
    toast(`The password for “${req.name}” could not be saved on this device.`, { kind: 'warning' })
  return { method: outcome.method, access: outcome.level, password, lock: req.lock ?? null, ...(outcome.ref ? { savedRef: outcome.ref } : {}) }
}

/**
 * Links files made from a document whose password is saved (Save As, Extract, Split, Combine) to
 * that saved password, so they open without asking. Only when `lock` (the files' lock) is the one
 * the saved password opened: anything else would be a wrong match.
 */
export async function linkSavedPassword(unlocked: DocUnlock | null | undefined, lock: LockInfo | null, paths: string[]) {
  if (!unlocked?.savedRef || !lock || !paths.length || unlocked.lock?.security !== lock.security) return
  for (const path of paths) await invoke('passwords:used', unlocked.savedRef, { kind: 'pdf', lock, path }).catch(() => {})
}

/** linkSavedPassword for files written from `doc` with its current protection. */
export async function linkDocumentFiles(doc: DocumentModel, paths: string[]) {
  if (!doc.state.unlock?.savedRef) return
  try {
    await linkSavedPassword(doc.state.unlock, await doc.core.doc.lockInfo(), paths)
  } catch {}
}

/**
 * What finds the password saved for this document, for showing or forgetting it: its exact lock
 * only. A record reached through the lock always opens it; /ID[0] and the path are guesses for
 * opening (Protect keeps /ID[0], so they can lead to another file's password), not for this.
 */
export async function documentTarget(doc: DocumentModel): Promise<Extract<SavedPasswordTarget, { kind: 'pdf' }> | null> {
  const lock = await doc.core.doc.lockInfo()
  return lock ? { kind: 'pdf', lock: { ...lock, id: null }, path: null } : null
}

/** The password saved on this device for a document (no secret), or null. */
export async function savedPasswordFor(doc: DocumentModel): Promise<SavedPasswordInfo | null> {
  const target = await documentTarget(doc)
  if (!target?.lock) return null
  return invoke('passwords:savedFor', target)
}

/** "Forget": the document's saved password stops opening it (and its copies). */
export async function forgetSavedPassword(doc: DocumentModel): Promise<number> {
  const target = await documentTarget(doc)
  if (!target?.lock) return 0
  const n = await invoke('passwords:forgetFor', target)
  const u = doc.state.unlock
  if (u?.savedRef) {
    const { savedRef: _forgotten, ...rest } = u
    doc.set({ unlock: rest })
  }
  return n
}

/** Saves the password the person set in Protect for the document, now at `path`. */
export async function rememberDocumentPassword(
  doc: DocumentModel,
  path: string,
  password: string,
  level: PasswordAccess
): Promise<{ ref: string; lock: LockInfo } | null> {
  const lock = await doc.core.doc.lockInfo()
  if (!lock) return null
  const label = path.split(/[\\/]/).pop() ?? path
  const ref = await invoke('passwords:remember', { target: { kind: 'pdf', lock, path }, label, level, password })
  return ref ? { ref, lock } : null
}

/** What finds a Digital ID's saved password. */
export function digitalIdTarget(certificateSha256: string): SavedPasswordTarget {
  return { kind: 'digital-id', certificateSha256 }
}
