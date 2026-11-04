// Keys for certificate-encrypted PDFs: Electron glue for the 'certkeys:*' channels (handlers.ts).
// Private keys, Digital ID passwords and smart card PINs stay in the main process; see
// docs/features/passwordless.md.
import { app } from 'electron'
import { handle } from '../ipc'
import { rememberPasswordsPolicy, savedPasswordStore, trustedSender } from '../passwords'
import { store as settings } from '../store'
import { createDigitalIdSource, DIGITAL_ID_RECORDS_KEY } from './digitalIdSource'
import { certKeyHandlers, type CertKeyChannel } from './handlers'
import { createWindowsStore, testPowerShellOptions } from './windowsStoreSource'

/** Registers the 'certkeys:*' channels. Call once the app is ready, after registerPasswordHandlers. */
export function registerCertKeyHandlers() {
  const windowsStore = createWindowsStore({
    platform: process.platform,
    enabled: () => settings().prefs.useWindowsCertificateStore !== false,
    // Tests only (unpackaged builds): a PowerShell to run instead of Windows PowerShell 5.1, with
    // its own HOME so .NET on Linux keeps the test certificates out of the person's store.
    ...testPowerShellOptions(process.env, app.isPackaged)
  })
  // The helper may hold a smart card unlocked: it never outlives the app.
  app.on('will-quit', () => windowsStore.stop())
  const digitalIds = createDigitalIdSource({
    records: () => settings().get(DIGITAL_ID_RECORDS_KEY),
    passwords: savedPasswordStore,
    remembering: () => !rememberPasswordsPolicy().off && settings().prefs.rememberPasswords !== false
  })
  const handlers = certKeyHandlers({ allowed: trustedSender, digitalIds, windowsStore })
  for (const channel of Object.keys(handlers) as CertKeyChannel[]) {
    const run = handlers[channel] as (...args: unknown[]) => Promise<unknown>
    handle(channel, (async (...args: unknown[]) => {
      // Saved Digital ID passwords obey the machine policy, which may still be being read.
      await rememberPasswordsPolicy().ready
      return run(...args)
    }) as never)
  }
}
