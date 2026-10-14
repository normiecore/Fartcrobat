/** Test doubles for the saved-password store: a fake cipher and an in-memory file system. */
import type { SecretCipher, StoreFs } from '@main/passwords/store'
import type { SavedPasswordsUnavailable } from '@shared/passwords'

/**
 * Not plain text (so tests can check the store file never holds a password) and bound to `key`
 * (so a "keyring reset" is a cipher with another key, whose decrypt throws).
 */
export function fakeCipher(o: { key?: string; unavailable?: SavedPasswordsUnavailable | null; reencrypt?: boolean } = {}) {
  const key = o.key ?? 'k1'
  const state = { encrypts: 0, decrypts: 0, unavailableCalls: 0, unavailable: o.unavailable ?? null, reencrypt: !!o.reencrypt }
  const mask = (b: Uint8Array) => b.map((x, i) => x ^ (0x5a + i) % 256)
  const cipher: SecretCipher & { state: typeof state } = {
    state,
    backend: () => 'fake',
    async unavailable() {
      state.unavailableCalls++
      return state.unavailable ? { reason: state.unavailable, backend: 'fake' } : null
    },
    async encrypt(plain) {
      state.encrypts++
      const body = mask(new TextEncoder().encode(plain))
      const head = new TextEncoder().encode(`F1:${key}:`)
      const out = new Uint8Array(head.length + body.length)
      out.set(head)
      out.set(body, head.length)
      return out
    },
    async decrypt(data) {
      state.decrypts++
      const head = new TextEncoder().encode(`F1:${key}:`)
      if (data.length < head.length || !head.every((b, i) => data[i] === b)) throw new Error('Error while decrypting')
      return { text: new TextDecoder().decode(mask(data.subarray(head.length))), reencrypt: state.reencrypt }
    }
  }
  return cipher
}

export function memoryFs(): StoreFs & { files: Map<string, string>; writes: number } {
  const files = new Map<string, string>()
  const fs = {
    files,
    writes: 0,
    async read(path: string) {
      return files.get(path) ?? null
    },
    async write(path: string, text: string) {
      fs.writes++
      files.set(path, text)
    },
    async remove(path: string) {
      files.delete(path)
    }
  }
  return fs
}
