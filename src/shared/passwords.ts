// Passwords remembered on this device: what the renderer and the main process exchange over the
// 'passwords:*' channels. Secrets only travel from main to the renderer that asked (to open a
// file); the store, the keyring and the lookup keys stay in the main process.
import type { LockInfo, PasswordAccess } from './types'

/** What a saved password opens. */
export type SavedPasswordTarget =
  /** A PDF: its lock (from the engine) and where it is (null for documents only in memory). */
  | { kind: 'pdf'; lock: LockInfo | null; path?: string | null }
  /** A Digital ID (.p12/.pfx), by the SHA-256 fingerprint of its certificate. */
  | { kind: 'digital-id'; certificateSha256: string }

/**
 * Why passwords can't be remembered right now: the machine policy or the person turned it off,
 * Linux has no keyring (GNOME Keyring, KWallet), the app is still starting, or the keyring failed.
 */
export type SavedPasswordsUnavailable = 'policy' | 'off' | 'no-keyring' | 'not-ready' | 'error'

export interface SavedPasswordsStatus {
  available: boolean
  reason: SavedPasswordsUnavailable | null
  /** How the passwords are protected ("Windows (DPAPI)", "macOS Keychain", "KWallet"...). */
  backend: string
  /** The machine policy turned remembering off (the Preferences switch is then read-only). */
  policy: boolean
  count: number
}

export interface SavedPasswordCandidate {
  ref: string
  password: string
  level?: PasswordAccess
  /** The strongest key that found it: 'lock' (exact), 'id', 'path' or 'digital-id'. */
  via: string
}

/** A saved password as Preferences lists it (never the password). */
export interface SavedPasswordInfo {
  ref: string
  kind: 'pdf' | 'digital-id'
  /** File name or Digital ID name. */
  label: string
  level?: PasswordAccess
  created: number
  used: number
  /** It can't be decrypted on this device now (keyring reset, settings copied from another account). */
  unreadable?: boolean
}

export interface RememberPasswordRequest {
  target: SavedPasswordTarget
  label: string
  level?: PasswordAccess
  password: string
}
