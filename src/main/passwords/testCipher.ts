/**
 * A reversible stand-in for safeStorage, for end-to-end tests on machines without a keyring (CI).
 * It protects nothing, so index.ts only uses it in unpackaged builds started with
 * FARTCROBAT_TEST_SECRET_CIPHER=1. The output is not plain text, so tests can still check that the
 * store file never holds a password.
 */
import type { SecretCipher } from './store'

const HEAD = 'FCTEST1:'

const mask = (b: Uint8Array) => b.map((x, i) => x ^ (0x5a + i) % 256)

export function testCipherEnabled(isPackaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !isPackaged && env.FARTCROBAT_TEST_SECRET_CIPHER === '1'
}

export function testCipher(o: { disabled: () => 'policy' | 'off' | null }): SecretCipher {
  return {
    backend: () => 'Test cipher (not protected)',
    async unavailable() {
      const off = o.disabled()
      return off ? { reason: off, backend: 'Test cipher (not protected)' } : null
    },
    async encrypt(plain) {
      const body = Buffer.from(mask(new TextEncoder().encode(plain))).toString('base64')
      return new TextEncoder().encode(HEAD + body)
    },
    async decrypt(data) {
      const text = new TextDecoder().decode(data)
      if (!text.startsWith(HEAD)) throw new Error('Error while decrypting')
      const body = mask(new Uint8Array(Buffer.from(text.slice(HEAD.length), 'base64')))
      return { text: new TextDecoder().decode(body), reencrypt: false }
    }
  }
}
