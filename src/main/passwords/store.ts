/**
 * Passwords remembered on this device. Main process only.
 *
 * - Secrets are encrypted by a SecretCipher (Electron safeStorage in the app: DPAPI on Windows,
 *   the Keychain on macOS, libsecret or KWallet on Linux). The store file only holds ciphertext,
 *   hashed lookup keys (keys.ts) and a label for Preferences.
 * - A record is one secret (a PDF open password or a Digital ID password) reachable through
 *   several keys. A key belongs to one record at most: linking it to a record moves it.
 * - Nothing here logs secrets, labels or keys, and errors carry no secret material.
 */
import { randomBytes } from 'node:crypto'
import type {
  SavedPasswordCandidate,
  SavedPasswordInfo,
  SavedPasswordsUnavailable
} from '@shared/passwords'
import type { PasswordAccess } from '@shared/types'
import { kindOf, KEY_ORDER } from './keys'

export interface SecretCipher {
  /** Null when secrets can be stored and read safely now; otherwise why not. */
  unavailable(): Promise<{ reason: SavedPasswordsUnavailable; backend: string } | null>
  /** Name of the OS protection in use, for Preferences ("Windows (DPAPI)", "KWallet"...). */
  backend(): string
  encrypt(plain: string): Promise<Uint8Array>
  /** Throws when the data can't be decrypted (key lost, another user, corrupt). */
  decrypt(data: Uint8Array): Promise<{ text: string; reencrypt: boolean }>
}

/** File I/O, injected so tests run without Electron or a disk. */
export interface StoreFs {
  /** File text, or null when it does not exist. */
  read(path: string): Promise<string | null>
  /** Atomic write, readable by this user only (0600). */
  write(path: string, text: string): Promise<void>
  remove(path: string): Promise<void>
}

export type SecretKind = 'pdf' | 'digital-id'

interface StoredRecord {
  id: string
  kind: SecretKind
  /** File name or Digital ID name, for Preferences. Never a path. */
  label: string
  /** PDF only: which password this is ('owner' opens with full access). */
  level?: PasswordAccess
  keys: string[]
  /** base64 ciphertext from SecretCipher.encrypt */
  secret: string
  created: number
  used: number
  /** Decryption failed the last time it was tried (keyring reset, profile copied): kept, not used. */
  unreadable?: boolean
}

interface StoreFile {
  version: 1
  records: StoredRecord[]
}

export interface RememberInput {
  kind: SecretKind
  keys: string[]
  label: string
  level?: PasswordAccess
  password: string
}

export interface StoreOptions {
  file: string
  cipher: SecretCipher
  fs: StoreFs
  now?: () => number
  newId?: () => string
  /** Upper bound on stored records; the least recently used go first. */
  maxRecords?: number
}

const LABEL_MAX = 200

const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

function strength(key: string): number {
  const i = KEY_ORDER.indexOf(kindOf(key))
  return i < 0 ? KEY_ORDER.length : i
}

function info(r: StoredRecord): SavedPasswordInfo {
  return {
    ref: r.id,
    kind: r.kind,
    label: r.label,
    ...(r.level ? { level: r.level } : {}),
    created: r.created,
    used: r.used,
    ...(r.unreadable ? { unreadable: true } : {})
  }
}

export class SavedPasswordStore {
  private data: StoreFile | null = null
  /** Serialises every operation: reads and writes never interleave. */
  private queue: Promise<unknown> = Promise.resolve()
  private readonly now: () => number
  private readonly newId: () => string
  private readonly max: number
  private readonly o: StoreOptions

  constructor(o: StoreOptions) {
    this.o = o
    this.now = o.now ?? Date.now
    this.newId = o.newId ?? (() => 'r' + randomBytes(12).toString('hex'))
    this.max = o.maxRecords ?? 500
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  private async load(): Promise<StoreFile> {
    if (this.data) return this.data
    let parsed: StoreFile = { version: 1, records: [] }
    // Null when there is no file. Any other read error (EACCES, EBUSY) propagates and nothing is
    // cached: starting empty would let the next write replace every saved password.
    const text = await this.o.fs.read(this.o.file)
    if (text) {
      try {
        const raw = JSON.parse(text)
        if (raw && raw.version === 1 && Array.isArray(raw.records)) {
          parsed = { version: 1, records: raw.records.filter(isRecord) }
        }
      } catch {
        // Corrupt or foreign content starts empty; it is replaced on the next write.
      }
    }
    this.data = parsed
    return parsed
  }

  private async save(): Promise<void> {
    const d = this.data!
    if (!d.records.length) {
      await this.o.fs.remove(this.o.file).catch(() => {})
      return
    }
    await this.o.fs.write(this.o.file, JSON.stringify(d))
  }

  /** Null when remembering works now; otherwise the reason (shown in the prompt and Preferences). */
  unavailable() {
    return this.o.cipher.unavailable()
  }

  backend() {
    return this.o.cipher.backend()
  }

  count(): Promise<number> {
    return this.run(async () => (await this.load()).records.length)
  }

  /** Records found through any of `keys`, strongest key first, then the most recently used. */
  private hits(d: StoreFile, keys: string[]) {
    const wanted = new Set(keys)
    const hits: { rec: StoredRecord; rank: number; via: string }[] = []
    for (const rec of d.records) {
      const matched = rec.keys.filter((k) => wanted.has(k)).sort((a, b) => strength(a) - strength(b))
      if (matched.length) hits.push({ rec, rank: strength(matched[0]), via: kindOf(matched[0]) })
    }
    return hits.sort((a, b) => a.rank - b.rank || b.rec.used - a.rec.used)
  }

  /**
   * Saved secrets found through any of `keys`, best first. The cipher (and so the keyring) is only
   * used when something matches. A record that can't be decrypted is skipped and flagged, not
   * deleted: a locked or briefly missing keyring must not wipe saved passwords. It goes once its
   * keys move to a new record, or from Preferences.
   */
  find(keys: string[]): Promise<SavedPasswordCandidate[]> {
    return this.run(async () => {
      if (!keys.length) return []
      const d = await this.load()
      const hits = this.hits(d, keys)
      if (!hits.length || (await this.o.cipher.unavailable())) return []
      const out: SavedPasswordCandidate[] = []
      let changed = false
      for (const h of hits) {
        try {
          const { text, reencrypt } = await this.o.cipher.decrypt(fromB64(h.rec.secret))
          if (reencrypt) {
            // Only an upgrade (key rotation): when it fails, the old ciphertext still works.
            try {
              h.rec.secret = toB64(await this.o.cipher.encrypt(text))
              changed = true
            } catch {}
          }
          if (h.rec.unreadable) {
            delete h.rec.unreadable
            changed = true
          }
          out.push({ ref: h.rec.id, password: text, ...(h.rec.level ? { level: h.rec.level } : {}), via: h.via })
        } catch {
          // Encrypted under a key this user doesn't have now (keyring locked or reset, profile copied).
          if (!h.rec.unreadable) {
            h.rec.unreadable = true
            changed = true
          }
        }
      }
      if (changed) await this.save()
      return out
    })
  }

  /** The record `find` would try first, without decrypting anything; null when there is none. */
  savedFor(keys: string[]): Promise<SavedPasswordInfo | null> {
    return this.run(async () => {
      if (!keys.length) return null
      const [best] = this.hits(await this.load(), keys)
      return best ? info(best.rec) : null
    })
  }

  /**
   * Saves a secret under `keys` (moving those keys away from older records). Returns the record
   * ref, or null when remembering is unavailable.
   */
  remember(input: RememberInput): Promise<string | null> {
    return this.run(async () => {
      if (!input.keys.length || !input.password) return null
      if (await this.o.cipher.unavailable()) return null
      const secret = toB64(await this.o.cipher.encrypt(input.password))
      const d = await this.load()
      const t = this.now()
      const rec: StoredRecord = {
        id: this.newId(),
        kind: input.kind,
        label: input.label.slice(0, LABEL_MAX),
        ...(input.level ? { level: input.level } : {}),
        keys: [],
        secret,
        created: t,
        used: t
      }
      d.records.push(rec)
      this.link(d, rec, input.keys)
      this.trim(d)
      await this.save()
      return rec.id
    })
  }

  /** A saved secret opened what `keys` describe: link every key to it and note the use. */
  used(ref: string, keys: string[], update: { label?: string; level?: PasswordAccess } = {}): Promise<void> {
    return this.run(async () => {
      const d = await this.load()
      const rec = d.records.find((r) => r.id === ref)
      if (!rec) return
      this.link(d, rec, keys)
      rec.used = this.now()
      if (update.label) rec.label = update.label.slice(0, LABEL_MAX)
      if (update.level) rec.level = update.level
      await this.save()
    })
  }

  /**
   * A saved secret did not open what `keys` describe: those keys no longer lead to it. The record
   * goes when no key is left (it is wrong now: forget it, then ask).
   */
  failed(ref: string, keys: string[]): Promise<void> {
    return this.run(async () => {
      const d = await this.load()
      const rec = d.records.find((r) => r.id === ref)
      if (!rec) return
      const drop = new Set(keys)
      rec.keys = rec.keys.filter((k) => !drop.has(k))
      if (!rec.keys.length) d.records = d.records.filter((r) => r !== rec)
      await this.save()
    })
  }

  list(): Promise<SavedPasswordInfo[]> {
    return this.run(async () => (await this.load()).records.map(info).sort((a, b) => b.used - a.used))
  }

  /** Forgets the given records ('all': every record, and the file is removed, even unreadable). */
  forget(refs: string[] | 'all'): Promise<number> {
    return this.run(async () => {
      const d = refs === 'all' ? await this.load().catch(() => (this.data = { version: 1, records: [] })) : await this.load()
      const before = d.records.length
      if (refs === 'all') d.records = []
      else {
        const drop = new Set(refs)
        d.records = d.records.filter((r) => !drop.has(r.id))
      }
      await this.save()
      return before - d.records.length
    })
  }

  /** Forgets whatever `keys` lead to (e.g. "Forget" for the open document). */
  forgetKeys(keys: string[]): Promise<number> {
    return this.run(async () => {
      const d = await this.load()
      const wanted = new Set(keys)
      const before = d.records.length
      d.records = d.records.filter((r) => !r.keys.some((k) => wanted.has(k)))
      if (d.records.length !== before) await this.save()
      return before - d.records.length
    })
  }

  private link(d: StoreFile, rec: StoredRecord, keys: string[]) {
    const add = new Set(keys)
    for (const other of d.records) {
      if (other === rec) continue
      const kept = other.keys.filter((k) => !add.has(k))
      if (kept.length !== other.keys.length) other.keys = kept
    }
    d.records = d.records.filter((r) => r === rec || r.keys.length > 0)
    rec.keys = [...new Set([...rec.keys, ...keys])].sort((a, b) => strength(a) - strength(b))
  }

  private trim(d: StoreFile) {
    if (d.records.length <= this.max) return
    d.records.sort((a, b) => b.used - a.used)
    d.records.length = this.max
  }
}

function isRecord(r: unknown): r is StoredRecord {
  const x = r as StoredRecord
  return (
    !!x &&
    typeof x.id === 'string' &&
    (x.kind === 'pdf' || x.kind === 'digital-id') &&
    typeof x.label === 'string' &&
    Array.isArray(x.keys) &&
    x.keys.every((k) => typeof k === 'string') &&
    typeof x.secret === 'string' &&
    typeof x.created === 'number' &&
    typeof x.used === 'number' &&
    (x.level === undefined || x.level === 'user' || x.level === 'owner')
  )
}
