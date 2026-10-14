// CONTRACT STUB: the Windows certificate store and smart cards (phase 4) replace this file. The
// long-lived PowerShell helper lives in winCertStore.ts / winStoreScripts.ts.
import type { EncryptionCertificate, WindowsStoreState } from '@shared/certkeys'
import type { RecipientKeySource } from './source'

export interface WindowsStoreOptions {
  platform: NodeJS.Platform
  /** Preferences > Digital IDs: "Use certificates from the Windows certificate store". */
  enabled: () => boolean
  /** Tests only: a PowerShell to run instead of the stock Windows PowerShell 5.1. */
  powershellPath?: string
  env?: NodeJS.ProcessEnv
}

export interface WindowsStore extends RecipientKeySource {
  readonly kind: 'windows-store'
  state(): Promise<WindowsStoreState>
  /** The helper process is running (a smart card PIN entered in it stays valid until stop()). */
  running(): boolean
  listEncryptionCertificates(opts: { includeOthers: boolean }): Promise<EncryptionCertificate[]>
  /** Stops the helper ("Lock smart card", quitting). The next call starts a new one. */
  stop(): void
}

export function createWindowsStore(opts: WindowsStoreOptions): WindowsStore {
  return {
    kind: 'windows-store',
    state: async () => (opts.platform !== 'win32' ? 'not-windows' : opts.enabled() ? 'unavailable' : 'off'),
    running: () => false,
    probe: async () => [],
    decrypt: async () => {
      throw new Error('The Windows certificate store is not available')
    },
    listEncryptionCertificates: async () => [],
    stop: () => {}
  }
}
