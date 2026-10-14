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
import { passwordHandlers, senderAllowed, type PasswordChannel } from './handlers'
import { SavedPasswordStore } from './store'
import { testCipher, testCipherEnabled } from './testCipher'

export const STORE_FILE = 'saved-passwords.json'

function trustedSender(e: IpcMainInvokeEvent): boolean {
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

/** Registers the 'passwords:*' channels. Call once the app is ready. */
export function registerPasswordHandlers() {
  // Read once: a policy that turns remembering off also wipes what was saved before.
  const policyOff = readMachinePolicy().rememberPasswords === 'disabled'
  const disabled = () => (policyOff ? 'policy' : settings().prefs.rememberPasswords === false ? 'off' : null)
  let instance: SavedPasswordStore | null = null
  const store = () =>
    (instance ??= new SavedPasswordStore({
      file: join(app.getPath('userData'), STORE_FILE),
      cipher: testCipherEnabled(app.isPackaged, process.env)
        ? testCipher({ disabled })
        : electronCipher(safeStorage, { platform: process.platform, disabled, ready: () => app.isReady() }),
      fs: nodeStoreFs
    }))
  if (policyOff) void store().forget('all').catch(() => {})
  const handlers = passwordHandlers({ store, allowed: trustedSender, platform: process.platform, policyOff: () => policyOff })
  for (const channel of Object.keys(handlers) as PasswordChannel[]) handle(channel, handlers[channel] as never)
}
