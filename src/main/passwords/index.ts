// Passwords remembered on this device: Electron glue. safeStorage is used here and nowhere else
// (see docs/features/passwordless.md).
import { app, BrowserWindow, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { handle } from '../ipc'
import { readMachinePolicy } from '../policy'
import { APP_ORIGIN } from '../protocol'
import { store as settings } from '../store'
import { isAppWindow } from '../windows'
import { electronCipher } from './electronCipher'
import { nodeStoreFs } from './fileStore'
import { passwordHandlers, rememberPolicy, senderAllowed, type PasswordChannel } from './handlers'
import { SavedPasswordStore } from './store'
import { testCipher, testCipherEnabled } from './testCipher'

export const STORE_FILE = 'saved-passwords.json'

/** Whether an IPC event comes from the app's own page (the 'certkeys:*' channels use it too). */
export function trustedSender(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame
  const origins = [APP_ORIGIN]
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  if (devUrl) origins.push(devUrl)
  return senderAllowed(
    {
      appWindow: isAppWindow(BrowserWindow.fromWebContents(e.sender)),
      topFrame: !!frame && frame.parent === null,
      url: frame?.url ?? ''
    },
    origins
  )
}

// Read once by registerPasswordHandlers (rememberPolicy says what turns remembering off and what
// also wipes the store). Remembering stays off until the policy has been read.
let policyOff = true
let policyRead: Promise<void> | null = null
let instance: SavedPasswordStore | null = null
const disabled = () => (policyOff ? 'policy' : settings().prefs.rememberPasswords === false ? 'off' : null)

/** The saved-password store, built on first use (after the app is ready). */
export function savedPasswordStore(): SavedPasswordStore {
  return (instance ??= new SavedPasswordStore({
    file: join(app.getPath('userData'), STORE_FILE),
    cipher: testCipherEnabled(app.isPackaged, process.env)
      ? testCipher({ disabled })
      : electronCipher(safeStorage, { platform: process.platform, disabled, ready: () => app.isReady() }),
    fs: nodeStoreFs
  }))
}

/**
 * The machine policy for remembering passwords: `off` when it turned remembering off (and until it
 * has been read), and `ready`, which settles once it was read and any wipe it asked for is done.
 */
export function rememberPasswordsPolicy(): { off: boolean; ready: Promise<void> } {
  return { off: policyOff, ready: policyRead ?? Promise.resolve() }
}

/** Registers the 'passwords:*' channels. Call once the app is ready. */
export function registerPasswordHandlers() {
  // On Windows reading the policy takes a moment (reg.exe), so every handler waits for it, and any
  // wipe, first.
  const read = (policyRead ??= readMachinePolicy()
    .catch(() => ({ rememberPasswords: 'invalid' as const }))
    .then(async (machine) => {
      const policy = rememberPolicy(machine.rememberPasswords)
      policyOff = policy.off
      if (policy.wipe) await savedPasswordStore().forget('all').catch(() => {})
    }))
  const handlers = passwordHandlers({ store: savedPasswordStore, allowed: trustedSender, platform: process.platform, policyOff: () => policyOff })
  for (const channel of Object.keys(handlers) as PasswordChannel[]) {
    const run = handlers[channel] as (...args: unknown[]) => Promise<unknown>
    handle(channel, (async (...args: unknown[]) => {
      await read
      return run(...args)
    }) as never)
  }
}
