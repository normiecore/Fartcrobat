/**
 * Passwords remembered on this device. Main process only.
 *
 * Port target: src/main/passwords/store.ts
 *
 * - Secrets are encrypted by a SecretCipher (Electron safeStorage in the app: DPAPI on Windows,
 *   the Keychain on macOS, libsecret/KWallet on Linux; a fake one in tests). The store file only
 *   holds ciphertext, hashed lookup keys (keys.ts) and a display label.
 * - A record is one secret (a PDF open password, or a Digital ID password) reachable through
 *   several keys. A key belongs to one record at most: linking it to a record moves it.
 * - Nothing here logs secrets, labels or keys. Errors carry no secret material.
 */
import { randomBytes } from 'node:crypto'
import { kindOf, KEY_ORDER } from './keys.ts'

// ---- cipher --------------------------------------------------------------------------------

export type Unavailable = 'policy' | 'no-keyring' | 'not-ready' | 'error'

export interface SecretCipher {
  /** Null when secrets can be stored safely now; otherwise why not. */
  unavailable(): Promise<{ reason: Unavailable; backend: string } | null>
  /** Name of the OS protection in use, for Preferences ('Windows (DPAPI)', 'GNOME Keyring'...). */
  backend(): string
  encrypt(plain: string): Promise<Uint8Array>
  /** Throws when the data can't be decrypted (key lost, other user, corrupt). */
  decrypt(data: Uint8Array): Promise<{ text: string; reencrypt: boolean }>
}

// ---- file I/O (injected so tests run without Electron or a disk) -----------------------------

export interface StoreFs {
  /** File text, or null when it does not exist. */
  read(path: string): Promise<string | null>
  /** Atomic write, file readable by this user only (0600). */
  write(path: string, text: string): Promise<void>
  remove(path: string): Promise<void>
}

// ---- data ------------------------------------------------------------------------------------

export type SecretKind = 'pdf' | 'digital-id'

interface StoredRecord {
  id: string
  kind: SecretKind
  /** File name or Digital ID name, for Preferences. Never a path. */
  label: string
  /** PDF only: which password this is ('owner' opens with full access). */
  level?: 'user' | 'owner'
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

export interface SavedSecretInfo {
  ref: string
  kind: SecretKind
  label: string
  level?: 'user' | 'owner'
  created: number
  used: number
  unreadable?: boolean
}

export interface Candidate {
  ref: string
  password: string
  level?: 'user' | 'owner'
  /** The strongest key kind that found it ('lock' hits are exact). */
  via: string
}

export interface RememberInput {
  kind: SecretKind
  keys: string[]
  label: string
  level?: 'user' | 'owner'
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

const toB64 = (b: Uint8Array) => Buffer.from(b).toString('base64')
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

function strength(key: string): number {
  const i = KEY_ORDER.indexOf(kindOf(key))
  return i < 0 ? KEY_ORDER.length : i
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
    try {
      const text = await this.o.fs.read(this.o.file)
      if (text) {
        const raw = JSON.parse(text)
        if (raw && raw.version === 1 && Array.isArray(raw.records)) {
          parsed = { version: 1, records: raw.records.filter(isRecord) }
        }
      }
    } catch {
      // Unreadable store: start empty (the old file is replaced on the next write).
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

  /**
   * Saved secrets found through any of `keys`, best first (the strongest key kind that matched,
   * then the most recently used). A record that can't be decrypted is skipped and flagged, not
   * deleted: a locked or briefly missing keyring must not wipe saved passwords. It goes once its
   * keys move to a new record, or from Preferences.
   */
  find(keys: string[]): Promise<Candidate[]> {
    return this.run(async () => {
      if (!keys.length || (await this.o.cipher.unavailable())) return []
      const d = await this.load()
      const wanted = new Set(keys)
      const hits: { rec: StoredRecord; rank: number; via: string }[] = []
      for (const rec of d.records) {
        const matched = rec.keys.filter((k) => wanted.has(k)).sort((a, b) => strength(a) - strength(b))
        if (matched.length) hits.push({ rec, rank: strength(matched[0]), via: kindOf(matched[0]) })
      }
      hits.sort((a, b) => a.rank - b.rank || b.rec.used - a.rec.used)
      const out: Candidate[] = []
      let changed = false
      for (const h of hits) {
        try {
          const { text, reencrypt } = await this.o.cipher.decrypt(fromB64(h.rec.secret))
          if (reencrypt) {
            h.rec.secret = toB64(await this.o.cipher.encrypt(text))
            changed = true
          }
          if (h.rec.unreadable) {
            delete h.rec.unreadable
            changed = true
          }
          out.push({ ref: h.rec.id, password: text, level: h.rec.level, via: h.via })
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

  /**
   * Saves a secret under `keys` (moving those keys away from older records). Returns the
   * record ref, or null when remembering is unavailable.
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
        label: input.label.slice(0, 200),
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

  /** A candidate opened the file found through `keys`: link every key to it and note the use. */
  used(ref: string, keys: string[], update: { label?: string; level?: 'user' | 'owner' } = {}): Promise<void> {
    return this.run(async () => {
      const d = await this.load()
      const rec = d.records.find((r) => r.id === ref)
      if (!rec) return
      this.link(d, rec, keys)
      rec.used = this.now()
      if (update.label) rec.label = update.label.slice(0, 200)
      if (update.level) rec.level = update.level
      await this.save()
    })
  }

  /**
   * A candidate did not open the file found through `keys`: those keys no longer lead to it.
   * The record goes when no key is left (it is wrong now: forget it, then ask).
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

  list(): Promise<SavedSecretInfo[]> {
    return this.run(async () => {
      const d = await this.load()
      return d.records
        .map((r) => ({
          ref: r.id,
          kind: r.kind,
          label: r.label,
          level: r.level,
          created: r.created,
          used: r.used,
          ...(r.unreadable ? { unreadable: true } : {})
        }))
        .sort((a, b) => b.used - a.used)
    })
  }

  /** Forgets the given records ('all': every record, and the file is removed). */
  forget(refs: string[] | 'all'): Promise<number> {
    return this.run(async () => {
      const d = await this.load()
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

  /** Forgets whatever `keys` lead to (e.g. "Forget saved password" for the open document). */
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
    typeof x.used === 'number'
  )
}
