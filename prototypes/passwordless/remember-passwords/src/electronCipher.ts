/**
 * SecretCipher on Electron safeStorage. Main process only, after app 'ready'.
 *
 * Port target: src/main/passwords/electronCipher.ts
 *
 * Uses the asynchronous API (encryptStringAsync / decryptStringAsync): it does not block the main
 * process (the first call may wait for the keyring) and reports key rotation (shouldReEncrypt).
 *
 * Linux needs care (verified with Electron 44.7 on Linux):
 *  - Without a usable keyring, the async API still "works": it encrypts with a key built into
 *    Chromium (ciphertext prefix 'v10'), which protects nothing. The sync API refuses instead.
 *  - getSelectedStorageBackend() describes the sync backend, not the async one: with a keyring
 *    running under a desktop Chromium doesn't recognise (i3, sway) it says 'basic_text' while the
 *    async API uses the keyring ('v11'); with --password-store=gnome-libsecret and no keyring it
 *    says 'gnome_libsecret' while the async API falls back to 'v10'.
 * So on Linux the only reliable test is the ciphertext itself: 'v10' means no keyring.
 * (On Windows and macOS 'v10' is the normal, protected format.)
 */
import type { SafeStorage } from 'electron'
import type { SecretCipher, Unavailable } from './store.ts'

export interface ElectronCipherOptions {
  platform: NodeJS.Platform
  /** The machine policy turned remembering off. */
  disabledByPolicy: () => boolean
}

const LINUX_BACKENDS: Record<string, string> = {
  gnome_libsecret: 'Secret Service (GNOME Keyring)',
  kwallet: 'KWallet',
  kwallet5: 'KWallet 5',
  kwallet6: 'KWallet 6'
}

/** Chromium's Linux format for data encrypted with its built-in key (no keyring). */
const LINUX_UNPROTECTED = 'v10'

const prefixOf = (b: Uint8Array) => String.fromCharCode(...b.subarray(0, 3))

export function electronCipher(safeStorage: SafeStorage, o: ElectronCipherOptions): SecretCipher {
  const linux = o.platform === 'linux'
  /** Linux: whether the async encryptor has a real key ('v10' = Chromium's built-in key). Probed once per process. */
  let linuxProtected: Promise<boolean> | null = null
  const probeLinux = () =>
    (linuxProtected ??= safeStorage
      .encryptStringAsync('fartcrobat-keyring-probe')
      .then((b) => prefixOf(new Uint8Array(b)) !== LINUX_UNPROTECTED)
      .catch(() => false))
  let lastLinuxResult: boolean | null = null

  const backend = () => {
    if (o.platform === 'win32') return 'Windows (DPAPI)'
    if (o.platform === 'darwin') return 'macOS Keychain'
    let selected = 'unknown'
    try {
      selected = safeStorage.getSelectedStorageBackend()
    } catch {}
    if (lastLinuxResult === false) return 'none'
    return LINUX_BACKENDS[selected] ?? (lastLinuxResult ? 'Secret Service' : 'unknown')
  }

  return {
    backend,
    async unavailable() {
      const fail = (reason: Unavailable) => ({ reason, backend: backend() })
      if (o.disabledByPolicy()) return fail('policy')
      try {
        if (!(await safeStorage.isAsyncEncryptionAvailable())) return fail(linux ? 'no-keyring' : 'error')
      } catch {
        return fail('error')
      }
      if (linux) {
        lastLinuxResult = await probeLinux()
        if (!lastLinuxResult) return fail('no-keyring')
      }
      return null
    },
    async encrypt(plain) {
      const out = new Uint8Array(await safeStorage.encryptStringAsync(plain))
      // Never store a secret under Chromium's built-in key, whatever unavailable() said earlier.
      if (linux && prefixOf(out) === LINUX_UNPROTECTED) throw new Error('No keyring is available to protect the password')
      return out
    },
    async decrypt(data) {
      const r = await safeStorage.decryptStringAsync(Buffer.from(data))
      return { text: r.result, reencrypt: r.shouldReEncrypt }
    }
  }
}
